//! Wi-Fi activation through NetworkManager's D-Bus API (never `nmcli`: the password must not reach argv).
//! Success means the profile created for *this* attempt is active and holds an IPv4 address; an older or
//! fallback connection never counts.
//!
//! The service owns two profiles with fixed UUIDs and uses them in turn. A new attempt (first setup or a
//! reconfiguration) joins with the one not in use, created without autoconnect; only after success does it get
//! autoconnect and replace the previous one. A failure deletes the new profile and brings the previous one back,
//! so a typo in a new password never leaves a sensor offline.

use dbus::Path;
use dbus::arg::{PropMap, Variant};
use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
use dbus::blocking::{Connection, Proxy};
use dbus::message::MatchRule;
use iot_provisioning::provision::{Enterprise, Failure, Outcome};
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

const NM: &str = "org.freedesktop.NetworkManager";
const NM_PATH: &str = "/org/freedesktop/NetworkManager";
const ACTIVE: &str = "org.freedesktop.NetworkManager.Connection.Active";
const DEVICE: &str = "org.freedesktop.NetworkManager.Device";
const SETTINGS_PATH: &str = "/org/freedesktop/NetworkManager/Settings";
const SETTINGS: &str = "org.freedesktop.NetworkManager.Settings";
const PROFILE: &str = "org.freedesktop.NetworkManager.Settings.Connection";
const NOT_FOUND: &str = "org.freedesktop.NetworkManager.Settings.InvalidConnection";
/// The only two profiles this service creates; the first one is also the profile of earlier versions.
pub const PROFILE_UUIDS: [&str; 2] = [
    "4a7db77c-6fda-47aa-95ca-d186c5096b32",
    "b5b2bc3f-8221-4a28-8c40-5e078953fcf2",
];
const CALL: Duration = Duration::from_secs(5);
const ACTIVATION: Duration = Duration::from_secs(45);
const POLL: Duration = Duration::from_millis(100);
const DEVICE_TYPE_WIFI: u32 = 2;
const ACTIVE_ACTIVATED: u32 = 2;
const ACTIVE_DEACTIVATED: u32 = 4;
const DEVICE_STATE_FAILED: u32 = 120;

/// The profile a new attempt uses: the one not holding the current working network.
pub fn next_profile(current: Option<&str>) -> &'static str {
    if current == Some(PROFILE_UUIDS[0]) {
        PROFILE_UUIDS[1]
    } else {
        PROFILE_UUIDS[0]
    }
}

/// WPA2-Enterprise sign-in as NetworkManager takes it: PEAP with MSCHAPv2 inside, the server certificate checked
/// against the system CAs and the site's RADIUS domain.
struct Eap<'a> {
    username: &'a str,
    domain: &'a str,
}

/// Joins the network with the profile not in use and reports the outcome and that profile;
/// `interface` pins the Wi-Fi device (`IOT_WIFI_INTERFACE`), `current` is the working profile, if any.
pub fn activate(
    ssid: &[u8],
    password: &[u8],
    enterprise: Option<&Enterprise>,
    interface: Option<&str>,
    current: Option<&str>,
) -> (Outcome, &'static str) {
    let profile = next_profile(current);
    let text = std::str::from_utf8;
    let eap = match enterprise.map(|e| (text(&e.username), text(&e.domain))) {
        None => Ok(None),
        Some((Ok(username), Ok(domain))) => Ok(Some(Eap { username, domain })),
        Some(_) => Err(()),
    };
    let (Ok(password), Ok(eap)) = (text(password), eap) else {
        return (Outcome::Failed(Failure::WrongPsk), profile); // NetworkManager takes text only
    };
    let outcome = run(ssid, password, eap.as_ref(), interface, profile)
        .unwrap_or(Outcome::Failed(Failure::NmcliError));
    if !matches!(outcome, Outcome::Connected { .. }) {
        roll_back(profile, current, interface);
    }
    (outcome, profile)
}

/// Undoes an attempt: deletes its profile and brings the working one back, if there was one.
pub fn roll_back(attempt: &str, current: Option<&str>, interface: Option<&str>) {
    let undone = || -> Result<(), dbus::Error> {
        let bus = Connection::new_system()?;
        delete(&bus, attempt)?;
        if let Some(current) = current {
            let nm = bus.with_proxy(NM, NM_PATH, CALL);
            let device = wifi_device(&bus, &nm, interface)?;
            let profile = find(&bus, current)?
                .ok_or_else(|| dbus::Error::new_failed("working profile missing"))?;
            let _: (Path<'static>,) =
                nm.method_call(NM, "ActivateConnection", (profile, device, Path::from("/")))?;
        }
        Ok(())
    };
    if undone().is_err() {
        println!("could not restore the previous Wi-Fi profile; its autoconnect will retry");
    }
}

/// NMDeviceStateReason values seen when joining fails (NetworkManager's nm-dbus-interface.h).
pub fn failure_for(reason: u32) -> Failure {
    match reason {
        7 | 8 | 11 => Failure::WrongPsk, // NO_SECRETS, SUPPLICANT_DISCONNECT, SUPPLICANT_TIMEOUT
        53 => Failure::NotInRange,       // SSID_NOT_FOUND
        _ => Failure::NmcliError,
    }
}

/// Whether `profile` is the one up on a device right now (read-only; no polkit needed).
pub fn profile_active(profile: &str) -> bool {
    let check = || -> Result<bool, dbus::Error> {
        let bus = Connection::new_system()?;
        let active: Vec<Path<'static>> = bus
            .with_proxy(NM, NM_PATH, CALL)
            .get(NM, "ActiveConnections")?;
        for path in active {
            let connection = bus.with_proxy(NM, &path, CALL);
            if connection.get::<String>(ACTIVE, "Uuid")? == profile {
                return Ok(connection.get::<u32>(ACTIVE, "State")? == ACTIVE_ACTIVATED);
            }
        }
        Ok(false)
    };
    check().unwrap_or(false)
}

/// Deletes this service's profiles except `keep`: a failed attempt, or one left by a crash before its success
/// was recorded. Never touches other profiles.
pub fn forget_except(keep: Option<&str>) -> Result<(), dbus::Error> {
    let bus = Connection::new_system()?;
    for profile in PROFILE_UUIDS.into_iter().filter(|p| Some(*p) != keep) {
        delete(&bus, profile)?;
    }
    Ok(())
}

fn find(bus: &Connection, uuid: &str) -> Result<Option<Path<'static>>, dbus::Error> {
    let found: Result<(Path<'static>,), dbus::Error> = bus
        .with_proxy(NM, SETTINGS_PATH, CALL)
        .method_call(SETTINGS, "GetConnectionByUuid", (uuid,));
    match found {
        Ok((profile,)) => Ok(Some(profile)),
        Err(error) if error.name() == Some(NOT_FOUND) => Ok(None),
        Err(error) => Err(error),
    }
}

fn delete(bus: &Connection, uuid: &str) -> Result<(), dbus::Error> {
    match find(bus, uuid)? {
        Some(profile) => bus
            .with_proxy(NM, &profile, CALL)
            .method_call(PROFILE, "Delete", ()),
        None => Ok(()),
    }
}

fn run(
    ssid: &[u8],
    password: &str,
    eap: Option<&Eap>,
    interface: Option<&str>,
    uuid: &str,
) -> Result<Outcome, dbus::Error> {
    let bus = Connection::new_system()?;
    let nm = bus.with_proxy(NM, NM_PATH, CALL);
    let device = wifi_device(&bus, &nm, interface)?;
    delete(&bus, uuid)?; // an earlier attempt's leftover would clash on the fixed UUID
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
        (
            settings(ssid, password, eap, false, uuid),
            device,
            Path::from("/"),
        ),
    )?;
    let mut outcome = wait(&bus, &active, &failed_reason);
    let _ = bus.remove_match(token);
    if matches!(outcome, Outcome::Connected { .. }) {
        // Only a profile that just worked may rejoin by itself after a reboot.
        let enabled: Result<(), dbus::Error> = bus.with_proxy(NM, &profile, CALL).method_call(
            PROFILE,
            "Update",
            (settings(ssid, password, eap, true, uuid),),
        );
        if enabled.is_err() {
            outcome = Outcome::Failed(Failure::NmcliError);
        }
    }
    Ok(outcome)
}

fn settings(
    ssid: &[u8],
    password: &str,
    eap: Option<&Eap>,
    autoconnect: bool,
    uuid: &str,
) -> HashMap<&'static str, PropMap> {
    let text = |value: &str| Variant(Box::new(value.to_string()) as Box<dyn dbus::arg::RefArg>);
    let section = |entries: Vec<(&str, Variant<Box<dyn dbus::arg::RefArg>>)>| -> PropMap {
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect()
    };
    let security = match eap {
        None => vec![("key-mgmt", text("wpa-psk")), ("psk", text(password))],
        Some(_) => vec![("key-mgmt", text("wpa-eap"))],
    };
    let mut settings = HashMap::from([
        (
            "connection",
            section(vec![
                ("type", text("802-11-wireless")),
                ("id", text("iot-provisioned")),
                ("uuid", text(uuid)),
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
        ("802-11-wireless-security", section(security)),
        ("ipv4", section(vec![("method", text("auto"))])),
    ]);
    if let Some(eap) = eap {
        settings.insert(
            "802-1x",
            section(vec![
                ("eap", Variant(Box::new(vec!["peap".to_string()]))),
                ("phase2-auth", text("mschapv2")),
                ("identity", text(eap.username)),
                ("password", text(password)),
                ("system-ca-certs", Variant(Box::new(true))),
                ("domain-suffix-match", text(eap.domain)),
            ]),
        );
    }
    settings
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
    fn attempts_alternate_between_the_two_profiles() {
        assert_eq!(next_profile(None), PROFILE_UUIDS[0]);
        assert_eq!(next_profile(Some(PROFILE_UUIDS[0])), PROFILE_UUIDS[1]);
        assert_eq!(next_profile(Some(PROFILE_UUIDS[1])), PROFILE_UUIDS[0]);
        assert_ne!(PROFILE_UUIDS[0], PROFILE_UUIDS[1]);
    }

    #[test]
    fn join_failures_map_to_technician_messages() {
        assert_eq!(failure_for(7), Failure::WrongPsk);
        assert_eq!(failure_for(8), Failure::WrongPsk);
        assert_eq!(failure_for(53), Failure::NotInRange);
        assert_eq!(failure_for(0), Failure::NmcliError);
    }

    #[test]
    fn a_non_utf8_password_fails_without_touching_networkmanager() {
        let (outcome, _) = activate(b"Ward-3", &[0xff; 8], None, Some("none"), None);
        assert_eq!(outcome, Outcome::Failed(Failure::WrongPsk));
        let username = Enterprise {
            username: vec![0xff],
            domain: b"radius.example.org".to_vec(),
        };
        let (outcome, _) = activate(b"Ward-3", b"secret", Some(&username), Some("none"), None);
        assert_eq!(outcome, Outcome::Failed(Failure::WrongPsk));
    }

    #[test]
    fn enterprise_settings_check_the_radius_server() {
        let eap = Eap {
            username: "noe",
            domain: "radius.example.org",
        };
        let settings = settings(b"Ward-3", "secret", Some(&eap), false, PROFILE_UUIDS[0]);
        let key = |section: &str, key: &str| settings[section][key].0.as_str().map(str::to_string);
        assert_eq!(
            key("802-11-wireless-security", "key-mgmt").as_deref(),
            Some("wpa-eap")
        );
        assert!(!settings["802-11-wireless-security"].contains_key("psk"));
        assert_eq!(key("802-1x", "identity").as_deref(), Some("noe"));
        assert_eq!(key("802-1x", "password").as_deref(), Some("secret"));
        assert_eq!(key("802-1x", "phase2-auth").as_deref(), Some("mschapv2"));
        assert_eq!(
            key("802-1x", "domain-suffix-match").as_deref(),
            Some("radius.example.org")
        );
        assert_eq!(settings["802-1x"]["system-ca-certs"].0.as_u64(), Some(1));
    }

    #[test]
    fn settings_ask_for_wpa_psk_with_dhcp() {
        let settings = settings(b"Ward-3", "correct horse", None, false, PROFILE_UUIDS[1]);
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
        assert_eq!(key("connection", "uuid").as_deref(), Some(PROFILE_UUIDS[1]));
        assert_eq!(
            settings["connection"]["autoconnect"].0.as_u64(),
            Some(0),
            "no autoconnect before the profile has worked"
        );
    }
}
