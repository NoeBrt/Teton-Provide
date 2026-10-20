//! Wi-Fi activation through NetworkManager's D-Bus API (never `nmcli`: the password must not reach argv).
//! Success means the profile created for *this* attempt is active and holds an IPv4 address; an older or
//! fallback connection never counts. The profile has one fixed UUID and is created without autoconnect;
//! autoconnect is turned on only after success, and [`forget`] removes a failed or orphaned profile.

use dbus::Path;
use dbus::arg::{PropMap, Variant};
use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
use dbus::blocking::{Connection, Proxy};
use dbus::message::MatchRule;
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};
use teton_provisioning::provision::{Failure, Outcome};

const NM: &str = "org.freedesktop.NetworkManager";
const NM_PATH: &str = "/org/freedesktop/NetworkManager";
const ACTIVE: &str = "org.freedesktop.NetworkManager.Connection.Active";
const DEVICE: &str = "org.freedesktop.NetworkManager.Device";
const SETTINGS_PATH: &str = "/org/freedesktop/NetworkManager/Settings";
const SETTINGS: &str = "org.freedesktop.NetworkManager.Settings";
const PROFILE: &str = "org.freedesktop.NetworkManager.Settings.Connection";
const NOT_FOUND: &str = "org.freedesktop.NetworkManager.Settings.InvalidConnection";
/// The only profile this service creates, so a retry or a restart finds and replaces it.
const PROFILE_UUID: &str = "4a7db77c-6fda-47aa-95ca-d186c5096b32";
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

/// Whether the provisioning profile is the one up on a device right now (read-only; no polkit needed).
pub fn profile_active() -> bool {
    let check = || -> Result<bool, dbus::Error> {
        let bus = Connection::new_system()?;
        let active: Vec<Path<'static>> = bus
            .with_proxy(NM, NM_PATH, CALL)
            .get(NM, "ActiveConnections")?;
        for path in active {
            let connection = bus.with_proxy(NM, &path, CALL);
            if connection.get::<String>(ACTIVE, "Uuid")? == PROFILE_UUID {
                return Ok(connection.get::<u32>(ACTIVE, "State")? == ACTIVE_ACTIVATED);
            }
        }
        Ok(false)
    };
    check().unwrap_or(false)
}

/// Deletes the provisioning profile if there is one: a failed attempt, or one left by a crash before
/// success was recorded. Never touches other profiles.
pub fn forget() -> Result<(), dbus::Error> {
    forget_on(&Connection::new_system()?)
}

fn forget_on(bus: &Connection) -> Result<(), dbus::Error> {
    let found: Result<(Path<'static>,), dbus::Error> = bus
        .with_proxy(NM, SETTINGS_PATH, CALL)
        .method_call(SETTINGS, "GetConnectionByUuid", (PROFILE_UUID,));
    match found {
        Ok((profile,)) => bus
            .with_proxy(NM, &profile, CALL)
            .method_call(PROFILE, "Delete", ()),
        Err(error) if error.name() == Some(NOT_FOUND) => Ok(()),
        Err(error) => Err(error),
    }
}

fn run(ssid: &[u8], password: &str, interface: Option<&str>) -> Result<Outcome, dbus::Error> {
    let bus = Connection::new_system()?;
    let nm = bus.with_proxy(NM, NM_PATH, CALL);
    let device = wifi_device(&bus, &nm, interface)?;
    forget_on(&bus)?; // a previous attempt's profile would clash on the fixed UUID
    // Every device state change is caught: a short FAILED state between two polls is not lost.
    let failed_reason = Arc::new(AtomicU32::new(0));
    let seen = failed_reason.clone();
    let token = bus.add_match(
        MatchRule::new_signal(DEVICE, "StateChanged").with_path(device.clone()),
        move |(new, _old, why): (u32, u32, u32), _, _| {
            if new == DEVICE_STATE_FAILED {
                seen.store(why, Ordering::Relaxed);
            }
            true
        },
    )?;
    let (profile, active): (Path<'static>, Path<'static>) = nm.method_call(
        NM,
        "AddAndActivateConnection",
        (settings(ssid, password, false), device, Path::from("/")),
    )?;
    let mut outcome = wait(&bus, &active, &failed_reason);
    let _ = bus.remove_match(token);
    if matches!(outcome, Outcome::Connected { .. }) {
        // Only a profile that just worked may rejoin by itself after a reboot.
        let enabled: Result<(), dbus::Error> = bus.with_proxy(NM, &profile, CALL).method_call(
            PROFILE,
            "Update",
            (settings(ssid, password, true),),
        );
        if enabled.is_err() {
            outcome = Outcome::Failed(Failure::NmcliError);
        }
    }
    if !matches!(outcome, Outcome::Connected { .. }) && forget_on(&bus).is_err() {
        println!("failed profile could not be deleted");
    }
    Ok(outcome)
}

fn settings(ssid: &[u8], password: &str, autoconnect: bool) -> HashMap<&'static str, PropMap> {
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
                ("uuid", text(PROFILE_UUID)),
                ("autoconnect", Variant(Box::new(autoconnect))),
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

fn wait(bus: &Connection, active: &Path<'static>, failed_reason: &AtomicU32) -> Outcome {
    let active = bus.with_proxy(NM, active, CALL);
    let deadline = Instant::now() + ACTIVATION;
    while Instant::now() < deadline {
        dispatch(bus, POLL);
        match active.get::<u32>(ACTIVE, "State") {
            Ok(ACTIVE_ACTIVATED) => {
                if let Some(ip) = ipv4(bus, &active) {
                    return Outcome::Connected { ipv4: ip.octets() };
                }
            }
            // NetworkManager removes the active-connection object once the attempt is over.
            Ok(ACTIVE_DEACTIVATED) | Err(_) => {
                dispatch(bus, Duration::ZERO); // signals queued behind the last reply
                return Outcome::Failed(match failed_reason.load(Ordering::Relaxed) {
                    0 => Failure::NmcliError,
                    why => failure_for(why),
                });
            }
            Ok(_) => {}
        }
    }
    Outcome::Failed(Failure::Timeout)
}

/// Runs the signal handlers for every queued message, waiting up to `first` for the first one.
fn dispatch(bus: &Connection, first: Duration) {
    let mut wait = first;
    while bus.process(wait).unwrap_or(false) {
        wait = Duration::ZERO;
    }
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
        let settings = settings(b"Ward-3", "correct horse", false);
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
        assert_eq!(key("connection", "uuid").as_deref(), Some(PROFILE_UUID));
        assert_eq!(
            settings["connection"]["autoconnect"].0.as_u64(),
            Some(0),
            "no autoconnect before the profile has worked"
        );
    }
}
