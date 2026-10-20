//! Wi-Fi activation through NetworkManager's D-Bus API (never `nmcli`: the password must not reach argv).
//! Success means the profile created for *this* attempt is active and holds an IPv4 address; an older or
//! fallback connection never counts. A failed profile is deleted so it cannot autoconnect later.

use dbus::Path;
use dbus::arg::{PropMap, Variant};
use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
use dbus::blocking::{Connection, Proxy};
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::time::{Duration, Instant};
use teton_provisioning::provision::{Failure, Outcome};

const NM: &str = "org.freedesktop.NetworkManager";
const NM_PATH: &str = "/org/freedesktop/NetworkManager";
const ACTIVE: &str = "org.freedesktop.NetworkManager.Connection.Active";
const DEVICE: &str = "org.freedesktop.NetworkManager.Device";
const CALL: Duration = Duration::from_secs(5);
const ACTIVATION: Duration = Duration::from_secs(45);
const POLL: Duration = Duration::from_millis(100);
const DEVICE_TYPE_WIFI: u32 = 2;
const ACTIVE_ACTIVATED: u32 = 2;
const ACTIVE_DEACTIVATED: u32 = 4;
const DEVICE_STATE_FAILED: u32 = 120;

/// Joins the network and reports the outcome; `interface` pins the Wi-Fi device (`TETON_WIFI_INTERFACE`).
pub fn activate(ssid: &[u8], password: &[u8], interface: Option<&str>) -> Outcome {
    let Ok(password) = std::str::from_utf8(password) else {
        return Outcome::Failed(Failure::WrongPsk); // a WPA2 passphrase is printable ASCII
    };
    run(ssid, password, interface).unwrap_or(Outcome::Failed(Failure::NmcliError))
}

/// NMDeviceStateReason values seen when joining fails (NetworkManager's nm-dbus-interface.h).
pub fn failure_for(reason: u32) -> Failure {
    match reason {
        7 | 8 | 11 => Failure::WrongPsk, // NO_SECRETS, SUPPLICANT_DISCONNECT, SUPPLICANT_TIMEOUT
        53 => Failure::NotInRange,       // SSID_NOT_FOUND
        _ => Failure::NmcliError,
    }
}

fn run(ssid: &[u8], password: &str, interface: Option<&str>) -> Result<Outcome, dbus::Error> {
    let bus = Connection::new_system()?;
    let nm = bus.with_proxy(NM, NM_PATH, CALL);
    let device = wifi_device(&bus, &nm, interface)?;
    let (profile, active): (Path<'static>, Path<'static>) = nm.method_call(
        NM,
        "AddAndActivateConnection",
        (settings(ssid, password), device.clone(), Path::from("/")),
    )?;
    let outcome = wait(&bus, &active, &device);
    if !matches!(outcome, Outcome::Connected { .. }) {
        let removed: Result<(), dbus::Error> = bus.with_proxy(NM, &profile, CALL).method_call(
            "org.freedesktop.NetworkManager.Settings.Connection",
            "Delete",
            (),
        );
        if removed.is_err() {
            println!("failed profile could not be deleted");
        }
    }
    Ok(outcome)
}

fn settings(ssid: &[u8], password: &str) -> HashMap<&'static str, PropMap> {
    let text = |value: &str| Variant(Box::new(value.to_string()) as Box<dyn dbus::arg::RefArg>);
    let section = |entries: Vec<(&str, Variant<Box<dyn dbus::arg::RefArg>>)>| -> PropMap {
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect()
    };
    HashMap::from([
        (
            "connection",
            section(vec![
                ("type", text("802-11-wireless")),
                ("id", text("teton-provisioned")),
            ]),
        ),
        (
            "802-11-wireless",
            section(vec![
                ("ssid", Variant(Box::new(ssid.to_vec()))),
                ("mode", text("infrastructure")),
            ]),
        ),
        (
            "802-11-wireless-security",
            section(vec![("key-mgmt", text("wpa-psk")), ("psk", text(password))]),
        ),
        ("ipv4", section(vec![("method", text("auto"))])),
    ])
}

fn wifi_device(
    bus: &Connection,
    nm: &Proxy<'_, &Connection>,
    interface: Option<&str>,
) -> Result<Path<'static>, dbus::Error> {
    if let Some(name) = interface {
        let (device,): (Path<'static>,) = nm.method_call(NM, "GetDeviceByIpIface", (name,))?;
        return Ok(device);
    }
    let (devices,): (Vec<Path<'static>>,) = nm.method_call(NM, "GetDevices", ())?;
    for device in devices {
        let kind: u32 = bus
            .with_proxy(NM, &device, CALL)
            .get(DEVICE, "DeviceType")?;
        if kind == DEVICE_TYPE_WIFI {
            return Ok(device);
        }
    }
    Err(dbus::Error::new_failed("no Wi-Fi device"))
}

fn wait(bus: &Connection, active: &Path<'static>, device: &Path<'static>) -> Outcome {
    let active = bus.with_proxy(NM, active, CALL);
    let device = bus.with_proxy(NM, device, CALL);
    let deadline = Instant::now() + ACTIVATION;
    let mut reason = None;
    while Instant::now() < deadline {
        if let Ok((state, why)) = device.get::<(u32, u32)>(DEVICE, "StateReason") {
            if state == DEVICE_STATE_FAILED {
                reason = Some(why);
            }
        }
        match active.get::<u32>(ACTIVE, "State") {
            Ok(ACTIVE_ACTIVATED) => {
                if let Some(ip) = ipv4(bus, &active) {
                    return Outcome::Connected { ipv4: ip.octets() };
                }
            }
            // NetworkManager removes the active-connection object once the attempt is over.
            Ok(ACTIVE_DEACTIVATED) | Err(_) => {
                return Outcome::Failed(reason.map_or(Failure::NmcliError, failure_for));
            }
            Ok(_) => {}
        }
        std::thread::sleep(POLL);
    }
    Outcome::Failed(Failure::Timeout)
}

fn ipv4(bus: &Connection, active: &Proxy<'_, &Connection>) -> Option<Ipv4Addr> {
    let config: Path<'static> = active.get(ACTIVE, "Ip4Config").ok()?;
    if &*config == "/" {
        return None;
    }
    let addresses: Vec<PropMap> = bus
        .with_proxy(NM, &config, CALL)
        .get("org.freedesktop.NetworkManager.IP4Config", "AddressData")
        .ok()?;
    addresses.first()?.get("address")?.0.as_str()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_failures_map_to_technician_messages() {
        assert_eq!(failure_for(7), Failure::WrongPsk);
        assert_eq!(failure_for(8), Failure::WrongPsk);
        assert_eq!(failure_for(53), Failure::NotInRange);
        assert_eq!(failure_for(0), Failure::NmcliError);
    }

    #[test]
    fn a_non_utf8_password_fails_without_touching_networkmanager() {
        assert_eq!(
            activate(b"Ward-3", &[0xff; 8], Some("none")),
            Outcome::Failed(Failure::WrongPsk)
        );
    }

    #[test]
    fn settings_ask_for_wpa_psk_with_dhcp() {
        let settings = settings(b"Ward-3", "correct horse");
        let key = |section: &str, key: &str| settings[section][key].0.as_str().map(str::to_string);
        assert_eq!(
            key("802-11-wireless-security", "key-mgmt").as_deref(),
            Some("wpa-psk")
        );
        assert_eq!(key("ipv4", "method").as_deref(), Some("auto"));
        assert_eq!(
            key("connection", "type").as_deref(),
            Some("802-11-wireless")
        );
    }
}
