//! the authorities, run at the workshop (offline). Two Ed25519 keys, kept apart from the devices:
//!
//! ```text
//! authority init | public | certify DEVICE_PUBLIC_KEY_HEX | issue NAME
//!     short forms for an evaluation: the authority lives in $IOT_AUTHORITY, else ~/iot-authority; sensors are
//!     certified for customer DEMO and codes are valid one day
//! authority init DIR
//!     creates the device authority and the technician authority (private keys 0600) and prints their public keys
//! authority public DIR
//!     prints both public keys: the device authority's goes into the app, the technician authority's onto sensors
//! authority certify DIR DEVICE_PUBLIC_KEY_HEX CUSTOMER
//!     prints the certificate for a sensor's key (from `stage init`), for one customer
//! authority issue DIR NAME CUSTOMER[,CUSTOMER...] [DAYS]
//!     prints a technician code as text and a QR code, valid DAYS days (default and at most 30) for those
//!     customers
//! ```
//!
//! The code is `<token hex>.<holder private key hex>`: the token names a holder key generated for this code, and
//! the phone proves its private half, so a sensor that records the token cannot reuse it. The code is a credential:
//! send it to the technician only, over a channel you trust; the technician imports it inside the app (scan or
//! paste), never through a link another app could claim.

use ed25519_dalek::SigningKey;
use qrcode::QrCode;
use qrcode::render::unicode;
use snow::Builder;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};
use iot_provisioning::authority::{DeviceCertificate, TechnicianToken, code_text, device_id};
use iot_provisioning::provision::{KeyPair, NOISE_PARAMS, hex, unhex};

const DEVICE_KEY: &str = "device-authority.key";
const TECHNICIAN_KEY: &str = "technician-authority.key";
/// Codes are valid 30 days at most, which also keeps the expiry far from overflowing.
const MAX_DAYS: u64 = 30;
const USAGE: &str = "usage: authority init | public | certify DEVICE_PUBLIC_KEY_HEX | issue NAME   (in $IOT_AUTHORITY, \
                     else ~/iot-authority; customer DEMO; 1 day)\n       \
                     authority init DIR | public DIR | certify DIR DEVICE_PUBLIC_KEY_HEX CUSTOMER | issue DIR NAME CUSTOMERS [DAYS]";
/// Short forms: one evaluation authority in a known place, the DEMO customer, codes valid one day.
const DEMO: &str = "DEMO";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let dir = std::env::var_os("IOT_AUTHORITY")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join("iot-authority")))
        .unwrap_or_else(|| PathBuf::from("iot-authority"));
    match run(&args, &dir) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("authority: {message}");
            ExitCode::FAILURE
        }
    }
}

/// One command; the short forms use `default` as the authority directory.
fn run(args: &[&str], default: &Path) -> Result<(), String> {
    match args {
        ["init"] => init(default),
        ["public"] => public(default),
        ["certify", key] => certify(default, key, DEMO),
        ["issue", name] => issue(default, name, DEMO, 1),
        ["init", dir] => init(Path::new(dir)),
        ["public", dir] => public(Path::new(dir)),
        ["certify", dir, key, customer] => certify(Path::new(dir), key, customer),
        ["issue", dir, name, customers] => issue(Path::new(dir), name, customers, MAX_DAYS),
        ["issue", dir, name, customers, days] => days
            .parse()
            .map_err(|_| "DAYS must be a number".to_string())
            .and_then(|days| issue(Path::new(dir), name, customers, days)),
        _ => Err(USAGE.to_string()),
    }
}

fn init(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for name in [DEVICE_KEY, TECHNICIAN_KEY] {
        // 32 random bytes from the OS RNG, through snow's key generator; they are the Ed25519 seed.
        let seed = Builder::new(NOISE_PARAMS.parse().expect("valid pattern"))
            .generate_keypair()
            .map_err(|_| "no randomness")?
            .private;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(dir.join(name))
            .map_err(|e| {
                format!(
                    "{}: {e} (an authority is never regenerated)",
                    dir.join(name).display()
                )
            })?;
        file.write_all(&seed)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
    }
    public(dir)
}

fn load(dir: &Path, name: &str) -> Result<SigningKey, String> {
    let path: PathBuf = dir.join(name);
    let mode = std::fs::metadata(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        return Err(format!(
            "{} is open to group or others; chmod 600 it",
            path.display()
        ));
    }
    let seed: [u8; 32] = std::fs::read(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .try_into()
        .map_err(|_| format!("{} is not a 32-byte key", path.display()))?;
    Ok(SigningKey::from_bytes(&seed))
}

fn public(dir: &Path) -> Result<(), String> {
    println!(
        "device authority (configurator/src/authority.ts): {}",
        hex(&load(dir, DEVICE_KEY)?.verifying_key().to_bytes())
    );
    println!(
        "technician authority (stage install, on each sensor): {}",
        hex(&load(dir, TECHNICIAN_KEY)?.verifying_key().to_bytes())
    );
    Ok(())
}

fn certify(dir: &Path, key: &str, customer: &str) -> Result<(), String> {
    let key: [u8; 32] = unhex(key)
        .and_then(|k| k.try_into().ok())
        .ok_or("the device public key must be 32 hex bytes")?;
    let certificate = DeviceCertificate::sign(&load(dir, DEVICE_KEY)?, key, customer)
        .map_err(|_| "CUSTOMER: 1-32 letters, digits, - or _")?;
    println!("{} for customer {customer}:", device_id(&key));
    println!("{}", hex(&certificate.encode()));
    Ok(())
}

fn issue(dir: &Path, name: &str, customers: &str, days: u64) -> Result<(), String> {
    if days > MAX_DAYS {
        return Err(format!("DAYS: at most {MAX_DAYS}"));
    }
    let customers: Vec<String> = customers.split(',').map(str::to_string).collect();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let holder = KeyPair::generate().map_err(|_| "no randomness")?;
    let token = TechnicianToken::issue(
        &load(dir, TECHNICIAN_KEY)?,
        name,
        &customers,
        now + days * 86_400,
        holder.public_key,
    )
    .map_err(|_| "NAME: 1-64 bytes; CUSTOMERS: 1-8, each 1-32 letters, digits, - or _")?;
    // The holder's private key is printed only inside the code.
    let code = code_text(&token.encode(), &holder.private_key);
    let qr = QrCode::new(code.as_bytes()).map_err(|_| "token too long for a QR code")?;
    println!(
        "{}",
        qr.render::<unicode::Dense1x2>().quiet_zone(true).build()
    );
    println!(
        "Technician code for {name}, customers {}, valid {days} day{}:",
        customers.join(", "),
        if days == 1 { "" } else { "s" }
    );
    println!("{code}");
    println!(
        "Send it to the technician only, over a channel you trust; the technician scans it inside provide. \
         (Technician code > Add)."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh authority directory for one test.
    fn initialized(test: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("iot-authority-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        init(&dir).unwrap();
        dir
    }

    #[test]
    fn the_short_forms_use_the_default_directory_and_the_demo_customer() {
        let dir =
            std::env::temp_dir().join(format!("iot-authority-short-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(run(&["init"], &dir), Ok(()));
        assert_eq!(run(&["public"], &dir), Ok(()));
        assert_eq!(run(&["certify", &"11".repeat(32)], &dir), Ok(()));
        assert_eq!(run(&["issue", "Evaluator"], &dir), Ok(()));
        assert!(
            run(&["issue", "Evaluator", "DEMO"], &dir).is_err(),
            "no 2-word form"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn issue_refuses_more_than_30_days() {
        let dir = initialized("days");
        assert!(issue(&dir, "Noé", "DEMO", 31).is_err());
        assert!(issue(&dir, "Noé", "DEMO", 30).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_key_open_to_group_is_refused() {
        let dir = initialized("mode");
        assert!(load(&dir, TECHNICIAN_KEY).is_ok());
        let key = dir.join(TECHNICIAN_KEY);
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(&dir, TECHNICIAN_KEY).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
