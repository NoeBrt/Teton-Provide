//! Staging, run once per device before deployment (never over BLE): creates the device key and label
//! secret in the state directory, checks them with a real handshake, and prints the QR label.
//!
//! Usage: `stage [STATE_DIRECTORY]` (default `./state`; the systemd unit uses /var/lib/teton-device).
//! The label holds the label secret: print it, stick it on the device, and do not share the image.

use qrcode::QrCode;
use qrcode::render::{svg, unicode};
use snow::Builder;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::process::ExitCode;
use teton_provisioning::protocol::DEVICE_ID;
use teton_provisioning::provision::{
    IDENTITY_FILE, Identity, MAX_MESSAGE, NOISE_PARAMS, Provisioner, Session, prologue,
};

fn main() -> ExitCode {
    let dir = PathBuf::from(std::env::args_os().nth(1).unwrap_or_else(|| "state".into()));
    match stage(&dir) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("stage: {message}");
            ExitCode::FAILURE
        }
    }
}

fn stage(dir: &std::path::Path) -> Result<(), String> {
    if dir.join(IDENTITY_FILE).exists() {
        return Err(format!(
            "{} is already staged; a key is never regenerated",
            dir.display()
        ));
    }
    let identity = Identity::generate().map_err(|_| "cannot generate keys")?;
    identity
        .save_new(dir)
        .map_err(|error| format!("cannot write identity: {error}"))?;
    let saved = Identity::load(dir)
        .map_err(|error| format!("cannot read identity back: {error}"))?
        .ok_or("identity missing after write")?;
    handshake_check(&saved)?;

    let label = saved.label(DEVICE_ID);
    let code = QrCode::new(label.as_bytes()).map_err(|_| "label too long for a QR code")?;
    let svg_path = dir.join("label.svg");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600) // the label carries the secret
        .open(&svg_path)
        .map_err(|error| format!("cannot write {}: {error}", svg_path.display()))?;
    file.write_all(
        code.render::<svg::Color>()
            .min_dimensions(400, 400)
            .build()
            .as_bytes(),
    )
    .map_err(|error| format!("cannot write {}: {error}", svg_path.display()))?;

    println!(
        "{}",
        code.render::<unicode::Dense1x2>().quiet_zone(true).build()
    );
    println!(
        "{DEVICE_ID} staged in {}; label image {}",
        dir.display(),
        svg_path.display()
    );
    println!("Handshake with the label: OK");
    Ok(())
}

/// Plays the phone's side from the label alone, against the device session built from the saved file.
fn handshake_check(identity: &Identity) -> Result<(), String> {
    let prologue = prologue(DEVICE_ID);
    let mut phone = Builder::new(NOISE_PARAMS.parse().expect("valid Noise pattern"))
        .remote_public_key(&identity.public_key)
        .and_then(|b| b.psk(2, &identity.secret))
        .and_then(|b| b.prologue(&prologue))
        .and_then(|b| b.build_initiator())
        .map_err(|_| "cannot build the check handshake")?;
    let mut device =
        Session::new(identity, DEVICE_ID).map_err(|_| "cannot build the device session")?;
    let mut buffer = [0u8; MAX_MESSAGE];
    let len = phone
        .write_message(&[], &mut buffer)
        .map_err(|_| "handshake check failed")?;
    let reply = device
        .on_write(&buffer[..len], &mut Provisioner::new(false))
        .map_err(|_| "handshake check failed")?;
    phone
        .read_message(&reply, &mut buffer)
        .map_err(|_| "handshake check failed: label and key disagree")?;
    Ok(())
}
