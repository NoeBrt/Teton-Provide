//! Interop vectors for the phone's TypeScript side (configurator/src/noise.test.ts, setup.test.ts): a full
//! Noise XX conversation with the device certificate and the technician token, then one provisioning exchange.
//! Fixed keys and ephemerals make every byte deterministic. The test fails if the committed file no longer
//! matches snow; `UPDATE_VECTORS=1 cargo test --features provision --test noise_vectors` rewrites it.

use curve25519_dalek::MontgomeryPoint;
use ed25519_dalek::SigningKey;
use snow::Builder;
use iot_provisioning::authority::{DeviceCertificate, TechnicianToken, device_id};
use iot_provisioning::provision::{
    NOISE_PARAMS, Outcome, PROLOGUE, REFUSED_EXPIRED, Request, Response, TOKEN_ACCEPTED,
    TOKEN_REFUSED, hex,
};

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/configurator/src/noise-vectors.json"
);
const CUSTOMER: &str = "DEMO";
/// 2100-01-01: the token in the vectors stays valid.
const EXPIRES: u64 = 4_102_444_800;

fn key(fill: u8) -> [u8; 32] {
    std::array::from_fn(|i| fill.wrapping_add(i as u8))
}

/// Runs the three handshake messages with fixed keys; returns both transport states and the messages.
fn handshake(
    phone_private: &[u8; 32],
    phone_ephemeral: &[u8; 32],
    device_private: &[u8; 32],
    device_ephemeral: &[u8; 32],
    certificate: &[u8],
    token: &[u8],
) -> (snow::TransportState, snow::TransportState, Vec<Vec<u8>>) {
    let mut phone = Builder::new(NOISE_PARAMS.parse().unwrap())
        .local_private_key(phone_private)
        .and_then(|b| b.prologue(PROLOGUE))
        .map(|b| b.fixed_ephemeral_key_for_testing_only(phone_ephemeral))
        .and_then(|b| b.build_initiator())
        .unwrap();
    let mut device = Builder::new(NOISE_PARAMS.parse().unwrap())
        .local_private_key(device_private)
        .and_then(|b| b.prologue(PROLOGUE))
        .map(|b| b.fixed_ephemeral_key_for_testing_only(device_ephemeral))
        .and_then(|b| b.build_responder())
        .unwrap();
    let mut buf = [0u8; 512];
    let mut scratch = [0u8; 512];
    let mut messages = Vec::new();
    let len = phone.write_message(&[], &mut buf).unwrap();
    device.read_message(&buf[..len], &mut scratch).unwrap();
    messages.push(buf[..len].to_vec());
    let len = device.write_message(certificate, &mut buf).unwrap();
    phone.read_message(&buf[..len], &mut scratch).unwrap();
    messages.push(buf[..len].to_vec());
    let len = phone.write_message(token, &mut buf).unwrap();
    device.read_message(&buf[..len], &mut scratch).unwrap();
    messages.push(buf[..len].to_vec());
    (
        phone.into_transport_mode().unwrap(),
        device.into_transport_mode().unwrap(),
        messages,
    )
}

fn vectors() -> String {
    let device_private = key(0x10);
    let device_public = MontgomeryPoint::mul_base_clamped(device_private).to_bytes();
    let phone_private = key(0x20);
    let phone_ephemeral = key(0x30);
    let device_ephemeral = key(0x70);
    let device_authority = SigningKey::from_bytes(&[0x41; 32]);
    let technician_authority = SigningKey::from_bytes(&[0x42; 32]);
    let certificate = DeviceCertificate::sign(&device_authority, device_public, CUSTOMER)
        .unwrap()
        .encode();
    let token = TechnicianToken::issue(
        &technician_authority,
        "Noé",
        &[CUSTOMER.to_string()],
        EXPIRES,
    )
    .unwrap()
    .encode();

    let mut buf = [0u8; 512];
    let mut scratch = [0u8; 512];
    let mut lines = Vec::new();
    let mut line = |from: &str, plain: &[u8], message: &[u8]| {
        lines.push(format!(
            r#"    {{ "from": "{from}", "plaintext": "{}", "message": "{}" }}"#,
            hex(plain),
            hex(message)
        ));
    };

    // The same deterministic handshake twice: once accepted (the main conversation), once refused (expired).
    let refused = {
        let (_, mut device, _) = handshake(
            &phone_private,
            &phone_ephemeral,
            &device_private,
            &device_ephemeral,
            &certificate,
            &token,
        );
        let len = device
            .write_message(&[TOKEN_REFUSED, REFUSED_EXPIRED], &mut buf)
            .unwrap();
        buf[..len].to_vec()
    };
    let (mut phone, mut device, messages) = handshake(
        &phone_private,
        &phone_ephemeral,
        &device_private,
        &device_ephemeral,
        &certificate,
        &token,
    );
    line("phone", &[], &messages[0]);
    line("device", &certificate, &messages[1]);
    line("phone", &token, &messages[2]);
    let len = device.write_message(&[TOKEN_ACCEPTED], &mut buf).unwrap();
    phone.read_message(&buf[..len], &mut scratch).unwrap();
    line("device", &[TOKEN_ACCEPTED], &buf[..len]);

    let attempt = [0xa5; 16];
    let exchanges = [
        (
            Request::Provision {
                attempt,
                ssid: b"Ward-3".to_vec(),
                password: b"correct horse".to_vec(),
            },
            Response {
                attempt,
                outcome: Outcome::Pending,
            },
        ),
        (
            Request::Status { attempt },
            Response {
                attempt,
                outcome: Outcome::Connected {
                    ipv4: [192, 168, 1, 40],
                },
            },
        ),
    ];
    for (request, response) in exchanges {
        let plain = request.encode();
        let len = phone.write_message(&plain, &mut buf).unwrap();
        device.read_message(&buf[..len], &mut scratch).unwrap();
        line("phone", &plain, &buf[..len]);
        let plain = response.encode();
        let len = device.write_message(&plain, &mut buf).unwrap();
        phone.read_message(&buf[..len], &mut scratch).unwrap();
        line("device", &plain, &buf[..len]);
    }

    format!(
        "{{\n  \"params\": \"{NOISE_PARAMS}\",\n  \"prologue\": \"{}\",\n  \"customer\": \"{CUSTOMER}\",\n  \"deviceId\": \"{}\",\n  \"devicePublic\": \"{}\",\n  \"deviceAuthority\": \"{}\",\n  \"technicianAuthority\": \"{}\",\n  \"certificate\": \"{}\",\n  \"token\": \"{}\",\n  \"refusedExpired\": \"{}\",\n  \"phonePrivate\": \"{}\",\n  \"phoneEphemeral\": \"{}\",\n  \"deviceEphemeral\": \"{}\",\n  \"messages\": [\n{}\n  ]\n}}\n",
        hex(PROLOGUE),
        device_id(&device_public),
        hex(&device_public),
        hex(&device_authority.verifying_key().to_bytes()),
        hex(&technician_authority.verifying_key().to_bytes()),
        hex(&certificate),
        hex(&token),
        hex(&refused),
        hex(&phone_private),
        hex(&phone_ephemeral),
        hex(&device_ephemeral),
        lines.join(",\n")
    )
}

#[test]
fn committed_vectors_match_snow() {
    let fresh = vectors();
    if std::env::var_os("UPDATE_VECTORS").is_some() {
        std::fs::write(PATH, &fresh).unwrap();
    }
    let committed = std::fs::read_to_string(PATH).expect("run once with UPDATE_VECTORS=1");
    assert_eq!(
        committed, fresh,
        "configurator/src/noise-vectors.json is stale"
    );
}
