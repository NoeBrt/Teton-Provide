//! Interop vectors for the phone's TypeScript Noise initiator (configurator/src/noise.test.ts).
//! Fixed keys and ephemerals make every byte deterministic. The test fails if the committed file no longer
//! matches snow; `UPDATE_VECTORS=1 cargo test --features provision --test noise_vectors` rewrites it.

use curve25519_dalek::MontgomeryPoint;
use snow::Builder;
use teton_provisioning::protocol::DEVICE_ID;
use teton_provisioning::provision::{NOISE_PARAMS, Outcome, Request, Response, hex, prologue};

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/configurator/src/noise-vectors.json"
);

fn key(fill: u8) -> [u8; 32] {
    std::array::from_fn(|i| fill.wrapping_add(i as u8))
}

fn vectors() -> String {
    let device_private = key(0x10);
    let device_public = MontgomeryPoint::mul_base_clamped(device_private).to_bytes();
    let secret = key(0x50);
    let phone_ephemeral = key(0x30);
    let device_ephemeral = key(0x70);
    let prologue = prologue(DEVICE_ID);
    let params = NOISE_PARAMS.parse().unwrap();

    let mut phone = Builder::new(NOISE_PARAMS.parse().unwrap())
        .remote_public_key(&device_public)
        .and_then(|b| b.psk(2, &secret))
        .and_then(|b| b.prologue(&prologue))
        .map(|b| b.fixed_ephemeral_key_for_testing_only(&phone_ephemeral))
        .and_then(|b| b.build_initiator())
        .unwrap();
    let mut device = Builder::new(params)
        .local_private_key(&device_private)
        .and_then(|b| b.psk(2, &secret))
        .and_then(|b| b.prologue(&prologue))
        .map(|b| b.fixed_ephemeral_key_for_testing_only(&device_ephemeral))
        .and_then(|b| b.build_responder())
        .unwrap();

    let mut buf = [0u8; 512];
    let mut scratch = [0u8; 512];
    let mut lines = Vec::new();
    let len = phone.write_message(&[], &mut buf).unwrap();
    device.read_message(&buf[..len], &mut scratch).unwrap();
    lines.push(format!(
        r#"    {{ "from": "phone", "plaintext": "", "message": "{}" }}"#,
        hex(&buf[..len])
    ));
    let len = device.write_message(&[], &mut buf).unwrap();
    phone.read_message(&buf[..len], &mut scratch).unwrap();
    lines.push(format!(
        r#"    {{ "from": "device", "plaintext": "", "message": "{}" }}"#,
        hex(&buf[..len])
    ));

    let mut phone = phone.into_transport_mode().unwrap();
    let mut device = device.into_transport_mode().unwrap();
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
        lines.push(format!(
            r#"    {{ "from": "phone", "plaintext": "{}", "message": "{}" }}"#,
            hex(&plain),
            hex(&buf[..len])
        ));
        let plain = response.encode();
        let len = device.write_message(&plain, &mut buf).unwrap();
        phone.read_message(&buf[..len], &mut scratch).unwrap();
        lines.push(format!(
            r#"    {{ "from": "device", "plaintext": "{}", "message": "{}" }}"#,
            hex(&plain),
            hex(&buf[..len])
        ));
    }

    format!(
        "{{\n  \"params\": \"{NOISE_PARAMS}\",\n  \"deviceId\": \"{DEVICE_ID}\",\n  \"prologue\": \"{}\",\n  \"devicePrivate\": \"{}\",\n  \"devicePublic\": \"{}\",\n  \"secret\": \"{}\",\n  \"phoneEphemeral\": \"{}\",\n  \"deviceEphemeral\": \"{}\",\n  \"messages\": [\n{}\n  ]\n}}\n",
        hex(&prologue),
        hex(&device_private),
        hex(&device_public),
        hex(&secret),
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
