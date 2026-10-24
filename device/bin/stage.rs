//! Staging, run on the device before deployment (never over BLE).
//!
//! ```text
//! stage init STATE_DIRECTORY
//!     creates the device's static key; prints its public key, to be certified at the workshop
//! stage install STATE_DIRECTORY CERTIFICATE_HEX TECHNICIAN_AUTHORITY_HEX
//!     stores the certificate the device authority signed for this key, and the technician authority's public
//!     key; the device then advertises its ID and accepts encrypted provisioning
//! ```
//!
//! Nothing here is secret on the command line: the private key never leaves the state directory (0600).

use std::path::PathBuf;
use std::process::ExitCode;
use iot_provisioning::authority::{DeviceCertificate, device_id};
use iot_provisioning::provision::{Identity, KeyPair, hex, unhex};

const USAGE: &str = "usage: stage init STATE_DIRECTORY | stage install STATE_DIRECTORY CERTIFICATE_HEX TECHNICIAN_AUTHORITY_HEX";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["init", dir] => init(&PathBuf::from(dir)),
        ["install", dir, certificate, authority] => {
            install(&PathBuf::from(dir), certificate, authority)
        }
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("stage: {message}");
            ExitCode::FAILURE
        }
    }
}

fn init(dir: &std::path::Path) -> Result<(), String> {
    if KeyPair::load(dir).map_err(|e| e.to_string())?.is_some() {
        return Err(format!(
            "{} already has a key; a key is never regenerated",
            dir.display()
        ));
    }
    let keys = KeyPair::generate().map_err(|_| "cannot generate a key")?;
    keys.save_new(dir)
        .map_err(|e| format!("cannot write the key: {e}"))?;
    println!("{} keyed in {}", device_id(&keys.public_key), dir.display());
    println!(
        "public key (certify it with `iot-workshop certify`): {}",
        hex(&keys.public_key)
    );
    Ok(())
}

fn install(dir: &std::path::Path, certificate: &str, authority: &str) -> Result<(), String> {
    let certificate = unhex(certificate).ok_or("the certificate is not hex")?;
    let authority: [u8; 32] = unhex(authority)
        .and_then(|a| a.try_into().ok())
        .ok_or("the technician authority is not 32 hex bytes")?;
    let customer = DeviceCertificate::decode(&certificate)
        .map_err(|e| format!("certificate {e}"))?
        .customer;
    // Earlier versions appended a label secret to the key pair, now unused: it leaves the disk.
    if KeyPair::drop_label_secret(dir).map_err(|e| format!("cannot rewrite the key: {e}"))? {
        println!("unused label secret removed from {}", dir.display());
    }
    Identity::install(dir, &certificate, &authority).map_err(|e| e.to_string())?;
    let identity = Identity::load(dir)
        .map_err(|e| e.to_string())?
        .ok_or("installed files missing")?;
    println!(
        "{} certified for customer {customer}; restart the service to advertise it",
        identity.device_id()
    );
    Ok(())
}
