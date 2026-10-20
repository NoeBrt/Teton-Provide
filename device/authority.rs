//! the authorities, run at the workshop (offline). Two Ed25519 keys, kept apart from the devices:
//!
//! ```text
//! authority init DIR
//!     creates the device authority and the technician authority (private keys 0600) and prints their public keys
//! authority public DIR
//!     prints both public keys: the device authority's goes into the app, the technician authority's onto sensors
//! authority certify DIR DEVICE_PUBLIC_KEY_HEX CUSTOMER
//!     prints the certificate for a sensor's key (from `stage init`), for one customer
//! authority issue DIR NAME CUSTOMER[,CUSTOMER...] [DAYS]
//!     prints a technician token as a link and a QR code, valid DAYS days (default 30) for those customers
//! ```
//!
//! The token is a credential: send its link to the technician only, over a channel you trust.

use ed25519_dalek::SigningKey;
use qrcode::QrCode;
use qrcode::render::unicode;
use snow::Builder;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};
use iot_provisioning::authority::{DeviceCertificate, TechnicianToken, device_id};
use iot_provisioning::provision::{NOISE_PARAMS, hex};

const DEVICE_KEY: &str = "device-authority.key";
const TECHNICIAN_KEY: &str = "technician-authority.key";
/// The link the app opens to import a token.
const LINK_PREFIX: &str = "provide://technician/";
const USAGE: &str = "usage: authority init DIR | public DIR | certify DIR DEVICE_PUBLIC_KEY_HEX CUSTOMER | issue DIR NAME CUSTOMERS [DAYS]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["init", dir] => init(Path::new(dir)),
        ["public", dir] => public(Path::new(dir)),
        ["certify", dir, key, customer] => certify(Path::new(dir), key, customer),
        ["issue", dir, name, customers] => issue(Path::new(dir), name, customers, 30),
        ["issue", dir, name, customers, days] => days
            .parse()
            .map_err(|_| "DAYS must be a number".to_string())
            .and_then(|days| issue(Path::new(dir), name, customers, days)),
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("authority: {message}");
            ExitCode::FAILURE
        }
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
    let key: [u8; 32] = (0..key.len())
        .step_by(2)
        .map(|i| {
            key.get(i..i + 2)
                .and_then(|b| u8::from_str_radix(b, 16).ok())
        })
        .collect::<Option<Vec<u8>>>()
        .and_then(|k| k.try_into().ok())
        .ok_or("the device public key must be 32 hex bytes")?;
    let certificate = DeviceCertificate::sign(&load(dir, DEVICE_KEY)?, key, customer)
        .map_err(|_| "CUSTOMER: 1-32 letters, digits, - or _")?;
    println!("{} for customer {customer}:", device_id(&key));
    println!("{}", hex(&certificate.encode()));
    Ok(())
}

fn issue(dir: &Path, name: &str, customers: &str, days: u64) -> Result<(), String> {
    let customers: Vec<String> = customers.split(',').map(str::to_string).collect();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let token = TechnicianToken::issue(
        &load(dir, TECHNICIAN_KEY)?,
        name,
        &customers,
        now + days * 86_400,
    )
    .map_err(|_| "NAME: 1-64 bytes; CUSTOMERS: 1-8, each 1-32 letters, digits, - or _")?;
    let link = format!("{LINK_PREFIX}{}", hex(&token.encode()));
    let code = QrCode::new(link.as_bytes()).map_err(|_| "token too long for a QR code")?;
    println!(
        "{}",
        code.render::<unicode::Dense1x2>().quiet_zone(true).build()
    );
    println!(
        "Technician token for {name}, customers {}, valid {days} days:",
        customers.join(", ")
    );
    println!("{link}");
    Ok(())
}
