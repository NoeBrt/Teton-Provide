//! Encrypted Wi-Fi provisioning, device side (see docs/SECURITY.md).
//!
//! The phone and the device run `Noise_NKpsk2_25519_ChaChaPoly_SHA256` over one GATT characteristic:
//! each acknowledged write carries one Noise message and the following read returns the device's reply.
//! NK authenticates the device (its static key is on the label); the `psk2` label secret authenticates
//! the phone. Credentials only ever travel as Noise transport messages, after the handshake.
//!
//! This module is pure logic: no BLE, no NetworkManager. The binary feeds it GATT writes and runs the
//! Wi-Fi activation it asks for, then reports the outcome back with [`Provisioner::complete`].

use sha2::{Digest, Sha256};
use snow::{Builder, HandshakeState, TransportState};
use std::collections::HashMap;
use std::fmt;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub const NOISE_PARAMS: &str = "Noise_NKpsk2_25519_ChaChaPoly_SHA256";
pub const PROVISION_CHARACTERISTIC_UUID: u128 = 0x3c2c02fa_847e_480c_9f22_b239dfa524c9;
/// One Noise message per GATT value; the ATT attribute limit is 512 bytes.
/// ponytail: no chunk layer, every message here is under 200 bytes; add one if payloads grow (EAP-TLS).
pub const MAX_MESSAGE: usize = 512;
/// First byte of every GATT write: a new handshake (resets this phone's session) or an encrypted message.
/// It sits outside the encryption; altering it only makes the handshake or decryption fail.
pub const FRAME_HANDSHAKE: u8 = 0;
pub const FRAME_TRANSPORT: u8 = 1;
pub const KEY_LEN: usize = 32;
pub const ATTEMPT_ID_LEN: usize = 16;
pub const MAX_SSID: usize = 32;
/// WPA2-Personal passphrase bounds (IEEE 802.11i).
pub const PASSWORD_LEN: std::ops::RangeInclusive<usize> = 8..=63;

pub type AttemptId = [u8; ATTEMPT_ID_LEN];

/// Binds the protocol version and the device identity into the handshake transcript.
pub fn prologue(device_id: &str) -> Vec<u8> {
    [b"iot-provision/1:".as_slice(), device_id.as_bytes()].concat()
}

/// Requests the phone sends inside the encrypted channel.
#[derive(PartialEq, Eq)]
pub enum Request {
    Provision {
        attempt: AttemptId,
        ssid: Vec<u8>,
        password: Vec<u8>,
    },
    Status {
        attempt: AttemptId,
    },
}

// Never print the network name or the password, even in debug output.
impl fmt::Debug for Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Request::Provision { .. } => f.write_str("Provision { .. }"),
            Request::Status { .. } => f.write_str("Status { .. }"),
        }
    }
}

const PROVISION: u8 = 1;
const STATUS: u8 = 2;

impl Request {
    /// `[1][attempt 16][ssid len][ssid][password len][password]` or `[2][attempt 16]`, nothing trailing.
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Request::Provision {
                attempt,
                ssid,
                password,
            } => {
                let mut out = vec![PROVISION];
                out.extend_from_slice(attempt);
                out.push(ssid.len() as u8);
                out.extend_from_slice(ssid);
                out.push(password.len() as u8);
                out.extend_from_slice(password);
                out
            }
            Request::Status { attempt } => [&[STATUS][..], attempt].concat(),
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let (&tag, rest) = bytes.split_first().ok_or(ProtocolError::Malformed)?;
        let attempt: AttemptId = rest
            .get(..ATTEMPT_ID_LEN)
            .and_then(|id| id.try_into().ok())
            .ok_or(ProtocolError::Malformed)?;
        let rest = &rest[ATTEMPT_ID_LEN..];
        match tag {
            STATUS if rest.is_empty() => Ok(Request::Status { attempt }),
            PROVISION => {
                let (ssid, rest) = take_field(rest)?;
                let (password, rest) = take_field(rest)?;
                let valid = rest.is_empty()
                    && (1..=MAX_SSID).contains(&ssid.len())
                    && PASSWORD_LEN.contains(&password.len());
                if !valid {
                    return Err(ProtocolError::Malformed);
                }
                Ok(Request::Provision {
                    attempt,
                    ssid: ssid.to_vec(),
                    password: password.to_vec(),
                })
            }
            _ => Err(ProtocolError::Malformed),
        }
    }
}

fn take_field(bytes: &[u8]) -> Result<(&[u8], &[u8]), ProtocolError> {
    let (&len, rest) = bytes.split_first().ok_or(ProtocolError::Malformed)?;
    let len = usize::from(len);
    if rest.len() < len {
        return Err(ProtocolError::Malformed);
    }
    Ok(rest.split_at(len))
}

/// Why an activation did not connect. Names follow Smith's connectivity guard where they overlap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Failure {
    WrongPsk = 1,
    NotInRange = 2,
    Timeout = 3,
    NmcliError = 4,
    AlreadyProvisioned = 5,
    Busy = 6,
    /// Same attempt ID with a different payload: a corrected password needs a new attempt.
    Conflict = 7,
}

impl Failure {
    fn from_u8(value: u8) -> Option<Self> {
        Some(match value {
            1 => Failure::WrongPsk,
            2 => Failure::NotInRange,
            3 => Failure::Timeout,
            4 => Failure::NmcliError,
            5 => Failure::AlreadyProvisioned,
            6 => Failure::Busy,
            7 => Failure::Conflict,
            _ => return None,
        })
    }
}

/// State of one attempt, as reported to the phone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Pending,
    /// The requested profile is active and holds this IPv4 address.
    Connected {
        ipv4: [u8; 4],
    },
    Failed(Failure),
    /// No record of this attempt (for example after a device reboot).
    Unknown,
}

/// `[attempt 16][0]` pending, `[1][ipv4 4]` connected, `[2][failure]` failed, `[3]` unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Response {
    pub attempt: AttemptId,
    pub outcome: Outcome,
}

impl Response {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = self.attempt.to_vec();
        match self.outcome {
            Outcome::Pending => out.push(0),
            Outcome::Connected { ipv4 } => {
                out.push(1);
                out.extend_from_slice(&ipv4);
            }
            Outcome::Failed(failure) => out.extend_from_slice(&[2, failure as u8]),
            Outcome::Unknown => out.push(3),
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let attempt: AttemptId = bytes
            .get(..ATTEMPT_ID_LEN)
            .and_then(|id| id.try_into().ok())
            .ok_or(ProtocolError::Malformed)?;
        let outcome = match &bytes[ATTEMPT_ID_LEN..] {
            [0] => Outcome::Pending,
            [1, a, b, c, d] => Outcome::Connected {
                ipv4: [*a, *b, *c, *d],
            },
            [2, failure] => {
                Outcome::Failed(Failure::from_u8(*failure).ok_or(ProtocolError::Malformed)?)
            }
            [3] => Outcome::Unknown,
            _ => return Err(ProtocolError::Malformed),
        };
        Ok(Response { attempt, outcome })
    }
}

/// Errors close the session; they carry no payload bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    Oversized,
    Malformed,
    /// Handshake or decryption failed: wrong key, wrong label secret, tampering, replay, reordering.
    Crypto,
    Closed,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ProtocolError::Oversized => "message too large",
            ProtocolError::Malformed => "malformed message",
            ProtocolError::Crypto => "handshake or decryption failed",
            ProtocolError::Closed => "session closed",
        })
    }
}

impl std::error::Error for ProtocolError {}

/// The device's label material: static X25519 key and the label secret (the Noise PSK).
pub struct Identity {
    pub private_key: [u8; KEY_LEN],
    pub public_key: [u8; KEY_LEN],
    pub secret: [u8; KEY_LEN],
}

impl Identity {
    /// Fresh key pair and label secret from the operating system's RNG (used by staging only).
    pub fn generate() -> Result<Self, snow::Error> {
        let keypair = Builder::new(params()).generate_keypair()?;
        let mut secret = [0; KEY_LEN];
        // A throwaway key pair is 32 uniformly random bytes from the same RNG; its private half is the secret.
        secret.copy_from_slice(&Builder::new(params()).generate_keypair()?.private);
        Ok(Identity {
            private_key: keypair
                .private
                .try_into()
                .expect("X25519 private key is 32 bytes"),
            public_key: keypair
                .public
                .try_into()
                .expect("X25519 public key is 32 bytes"),
            secret,
        })
    }

    /// What the device's QR label carries: `T1:<device id>:<public key hex>:<label secret hex>`.
    pub fn label(&self, device_id: &str) -> String {
        format!(
            "T1:{device_id}:{}:{}",
            hex(&self.public_key),
            hex(&self.secret)
        )
    }

    /// Writes a new identity; refuses to overwrite one, so a staged key is never replaced by accident.
    pub fn save_new(&self, dir: &Path) -> io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(dir.join(IDENTITY_FILE))?;
        file.write_all(&[self.private_key, self.public_key, self.secret].concat())?;
        file.sync_all()
    }

    /// `Ok(None)` when the device was never staged: it then offers the hello probe only.
    pub fn load(dir: &Path) -> io::Result<Option<Self>> {
        let bytes = match std::fs::read(dir.join(IDENTITY_FILE)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let part = |i: usize| -> Option<[u8; KEY_LEN]> {
            bytes.get(i * KEY_LEN..(i + 1) * KEY_LEN)?.try_into().ok()
        };
        match (bytes.len() == 3 * KEY_LEN, part(0), part(1), part(2)) {
            (true, Some(private_key), Some(public_key), Some(secret)) => Ok(Some(Identity {
                private_key,
                public_key,
                secret,
            })),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "corrupt identity file",
            )),
        }
    }
}

pub const IDENTITY_FILE: &str = "identity";
/// Present once a provisioning succeeded: the device never reopens provisioning (single use).
pub const PROVISIONED_FILE: &str = "provisioned";

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn params() -> snow::params::NoiseParams {
    NOISE_PARAMS.parse().expect("valid Noise pattern")
}

enum Phase {
    Handshake(Box<HandshakeState>),
    Transport(Box<TransportState>),
    Closed,
}

/// Noise state for one connected phone. Any error closes it for good; the phone reconnects.
pub struct Session {
    phase: Phase,
}

impl Session {
    pub fn new(identity: &Identity, device_id: &str) -> Result<Self, ProtocolError> {
        let prologue = prologue(device_id);
        let handshake = Builder::new(params())
            .local_private_key(&identity.private_key)
            .and_then(|b| b.psk(2, &identity.secret))
            .and_then(|b| b.prologue(&prologue))
            .and_then(|b| b.build_responder())
            .map_err(|_| ProtocolError::Crypto)?;
        Ok(Session {
            phase: Phase::Handshake(Box::new(handshake)),
        })
    }

    /// Handles one GATT write and returns the bytes the phone reads next.
    pub fn on_write(
        &mut self,
        message: &[u8],
        provisioner: &mut Provisioner,
    ) -> Result<Vec<u8>, ProtocolError> {
        let result = self.step(message, provisioner);
        if result.is_err() {
            self.phase = Phase::Closed;
        }
        result
    }

    fn step(
        &mut self,
        message: &[u8],
        provisioner: &mut Provisioner,
    ) -> Result<Vec<u8>, ProtocolError> {
        if message.len() > MAX_MESSAGE {
            return Err(ProtocolError::Oversized);
        }
        let mut buffer = [0u8; MAX_MESSAGE];
        match std::mem::replace(&mut self.phase, Phase::Closed) {
            Phase::Handshake(mut handshake) => {
                let payload = handshake
                    .read_message(message, &mut buffer)
                    .map_err(|_| ProtocolError::Crypto)?;
                if payload != 0 {
                    return Err(ProtocolError::Malformed); // nothing may ride on the first message
                }
                let len = handshake
                    .write_message(&[], &mut buffer)
                    .map_err(|_| ProtocolError::Crypto)?;
                self.phase = Phase::Transport(Box::new(
                    handshake
                        .into_transport_mode()
                        .map_err(|_| ProtocolError::Crypto)?,
                ));
                Ok(buffer[..len].to_vec())
            }
            Phase::Transport(mut transport) => {
                let len = transport
                    .read_message(message, &mut buffer)
                    .map_err(|_| ProtocolError::Crypto)?;
                let request = Request::decode(&buffer[..len]);
                buffer.fill(0); // the plaintext may hold the password
                let response = provisioner.handle(request?).encode();
                let len = transport
                    .write_message(&response, &mut buffer)
                    .map_err(|_| ProtocolError::Crypto)?;
                self.phase = Phase::Transport(transport);
                Ok(buffer[..len].to_vec())
            }
            Phase::Closed => Err(ProtocolError::Closed),
        }
    }
}

/// A Wi-Fi activation the binary must run, then report with [`Provisioner::complete`].
pub struct Activation {
    pub attempt: AttemptId,
    pub ssid: Vec<u8>,
    pub password: Vec<u8>,
}

impl fmt::Debug for Activation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Activation { .. }")
    }
}

struct Record {
    payload_hash: [u8; 32],
    outcome: Outcome,
}

/// Attempt registry shared by all sessions: one attempt in flight, results kept for recovery,
/// and success is terminal (single-use provisioning).
pub struct Provisioner {
    provisioned: bool,
    records: HashMap<AttemptId, Record>,
    activation: Option<Activation>,
}

impl Provisioner {
    /// `provisioned` comes from the device's persisted state: a provisioned device never reopens.
    pub fn new(provisioned: bool) -> Self {
        Provisioner {
            provisioned,
            records: HashMap::new(),
            activation: None,
        }
    }

    pub fn is_provisioned(&self) -> bool {
        self.provisioned
    }

    /// The activation requested by the last accepted `Provision`, handed over once.
    pub fn take_activation(&mut self) -> Option<Activation> {
        self.activation.take()
    }

    pub fn handle(&mut self, request: Request) -> Response {
        let (attempt, outcome) = match request {
            Request::Status { attempt } => (
                attempt,
                self.records
                    .get(&attempt)
                    .map_or(Outcome::Unknown, |r| r.outcome),
            ),
            Request::Provision {
                attempt,
                ssid,
                password,
            } => {
                let payload_hash = hash(&ssid, &password);
                let outcome = match self.records.get(&attempt) {
                    Some(record) if record.payload_hash == payload_hash => record.outcome,
                    Some(_) => Outcome::Failed(Failure::Conflict),
                    None if self.provisioned => Outcome::Failed(Failure::AlreadyProvisioned),
                    None if self.in_flight() => Outcome::Failed(Failure::Busy),
                    None => {
                        self.records.insert(
                            attempt,
                            Record {
                                payload_hash,
                                outcome: Outcome::Pending,
                            },
                        );
                        self.activation = Some(Activation {
                            attempt,
                            ssid,
                            password,
                        });
                        Outcome::Pending
                    }
                };
                (attempt, outcome)
            }
        };
        Response { attempt, outcome }
    }

    /// Records the activation result. `Connected` makes the device provisioned for good.
    pub fn complete(&mut self, attempt: AttemptId, outcome: Outcome) {
        if let Some(record) = self.records.get_mut(&attempt) {
            record.outcome = outcome;
            if matches!(outcome, Outcome::Connected { .. }) {
                self.provisioned = true;
            }
        }
    }

    fn in_flight(&self) -> bool {
        self.activation.is_some() || self.records.values().any(|r| r.outcome == Outcome::Pending)
    }
}

fn hash(ssid: &[u8], password: &[u8]) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update([ssid.len() as u8]);
    digest.update(ssid);
    digest.update(password);
    digest.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "IOT-DEMO-001";
    const ATTEMPT: AttemptId = [7; ATTEMPT_ID_LEN];

    fn provision(attempt: AttemptId, password: &[u8]) -> Request {
        Request::Provision {
            attempt,
            ssid: b"Ward-3".to_vec(),
            password: password.to_vec(),
        }
    }

    /// The phone side, built from snow so the device is tested against a real initiator.
    struct Phone {
        handshake: Option<HandshakeState>,
        transport: Option<TransportState>,
    }

    impl Phone {
        fn new(device_public: &[u8], secret: &[u8; KEY_LEN], device_id: &str) -> Self {
            let prologue = prologue(device_id);
            let handshake = Builder::new(params())
                .remote_public_key(device_public)
                .and_then(|b| b.psk(2, secret))
                .and_then(|b| b.prologue(&prologue))
                .and_then(|b| b.build_initiator())
                .unwrap();
            Phone {
                handshake: Some(handshake),
                transport: None,
            }
        }

        fn hello(&mut self) -> Vec<u8> {
            let mut out = [0u8; MAX_MESSAGE];
            let len = self
                .handshake
                .as_mut()
                .unwrap()
                .write_message(&[], &mut out)
                .unwrap();
            out[..len].to_vec()
        }

        fn finish(&mut self, reply: &[u8]) -> Result<(), snow::Error> {
            let mut out = [0u8; MAX_MESSAGE];
            let mut handshake = self.handshake.take().unwrap();
            handshake.read_message(reply, &mut out)?;
            self.transport = Some(handshake.into_transport_mode()?);
            Ok(())
        }

        fn seal(&mut self, request: &Request) -> Vec<u8> {
            let mut out = [0u8; MAX_MESSAGE];
            let len = self
                .transport
                .as_mut()
                .unwrap()
                .write_message(&request.encode(), &mut out)
                .unwrap();
            out[..len].to_vec()
        }

        fn open(&mut self, reply: &[u8]) -> Response {
            let mut out = [0u8; MAX_MESSAGE];
            let len = self
                .transport
                .as_mut()
                .unwrap()
                .read_message(reply, &mut out)
                .unwrap();
            Response::decode(&out[..len]).unwrap()
        }
    }

    fn connected(identity: &Identity) -> (Phone, Session) {
        let mut phone = Phone::new(&identity.public_key, &identity.secret, ID);
        let mut session = Session::new(identity, ID).unwrap();
        let reply = session
            .on_write(&phone.hello(), &mut Provisioner::new(false))
            .unwrap();
        phone.finish(&reply).unwrap();
        (phone, session)
    }

    #[test]
    fn provision_then_status_reports_the_connection() {
        let identity = Identity::generate().unwrap();
        let (mut phone, mut session) = connected(&identity);
        let mut provisioner = Provisioner::new(false);

        let reply = session
            .on_write(
                &phone.seal(&provision(ATTEMPT, b"correct horse")),
                &mut provisioner,
            )
            .unwrap();
        assert_eq!(
            phone.open(&reply),
            Response {
                attempt: ATTEMPT,
                outcome: Outcome::Pending
            }
        );
        let activation = provisioner.take_activation().unwrap();
        assert_eq!(
            (activation.ssid.as_slice(), activation.password.as_slice()),
            (b"Ward-3".as_slice(), b"correct horse".as_slice())
        );
        assert!(provisioner.take_activation().is_none(), "handed over once");

        provisioner.complete(
            ATTEMPT,
            Outcome::Connected {
                ipv4: [192, 168, 1, 40],
            },
        );
        let reply = session
            .on_write(
                &phone.seal(&Request::Status { attempt: ATTEMPT }),
                &mut provisioner,
            )
            .unwrap();
        assert_eq!(
            phone.open(&reply).outcome,
            Outcome::Connected {
                ipv4: [192, 168, 1, 40]
            }
        );
        assert!(provisioner.is_provisioned());
    }

    #[test]
    fn wrong_device_key_fails_before_any_credential_is_sent() {
        let device = Identity::generate().unwrap();
        let impostor = Identity::generate().unwrap();
        let mut phone = Phone::new(&impostor.public_key, &device.secret, ID);
        let mut session = Session::new(&device, ID).unwrap();
        assert_eq!(
            session.on_write(&phone.hello(), &mut Provisioner::new(false)),
            Err(ProtocolError::Crypto)
        );
    }

    #[test]
    fn wrong_label_secret_fails_the_handshake_on_the_phone() {
        let device = Identity::generate().unwrap();
        let mut phone = Phone::new(&device.public_key, &[9; KEY_LEN], ID);
        let mut session = Session::new(&device, ID).unwrap();
        let reply = session
            .on_write(&phone.hello(), &mut Provisioner::new(false))
            .unwrap();
        assert!(
            phone.finish(&reply).is_err(),
            "the phone must not reach transport mode, so it never sends"
        );
    }

    #[test]
    fn a_device_id_mismatch_fails_the_handshake() {
        let device = Identity::generate().unwrap();
        let mut phone = Phone::new(&device.public_key, &device.secret, "IOT-DEMO-002");
        let mut session = Session::new(&device, ID).unwrap();
        assert_eq!(
            session.on_write(&phone.hello(), &mut Provisioner::new(false)),
            Err(ProtocolError::Crypto)
        );
    }

    #[test]
    fn tampered_truncated_and_replayed_messages_close_the_session() {
        let identity = Identity::generate().unwrap();
        for corrupt in [
            |m: &mut Vec<u8>| m[3] ^= 1,
            |m: &mut Vec<u8>| {
                m.pop();
            },
            |m: &mut Vec<u8>| m.truncate(10),
        ] {
            let (mut phone, mut session) = connected(&identity);
            let mut message = phone.seal(&provision(ATTEMPT, b"correct horse"));
            corrupt(&mut message);
            let mut provisioner = Provisioner::new(false);
            assert_eq!(
                session.on_write(&message, &mut provisioner),
                Err(ProtocolError::Crypto)
            );
            assert!(provisioner.take_activation().is_none());
            assert_eq!(
                session.on_write(&message, &mut provisioner),
                Err(ProtocolError::Closed)
            );
        }

        let (mut phone, mut session) = connected(&identity);
        let mut provisioner = Provisioner::new(false);
        let message = phone.seal(&Request::Status { attempt: ATTEMPT });
        session.on_write(&message, &mut provisioner).unwrap();
        assert_eq!(
            session.on_write(&message, &mut provisioner),
            Err(ProtocolError::Crypto),
            "replay"
        );
    }

    #[test]
    fn reordered_messages_are_rejected() {
        let identity = Identity::generate().unwrap();
        let (mut phone, mut session) = connected(&identity);
        let first = phone.seal(&Request::Status { attempt: ATTEMPT });
        let second = phone.seal(&Request::Status { attempt: ATTEMPT });
        assert_eq!(
            session.on_write(&second, &mut Provisioner::new(false)),
            Err(ProtocolError::Crypto)
        );
        drop(first);
    }

    #[test]
    fn oversized_and_payload_carrying_handshakes_are_rejected() {
        let identity = Identity::generate().unwrap();
        let mut session = Session::new(&identity, ID).unwrap();
        assert_eq!(
            session.on_write(&[0; MAX_MESSAGE + 1], &mut Provisioner::new(false)),
            Err(ProtocolError::Oversized)
        );

        let mut phone = Phone::new(&identity.public_key, &identity.secret, ID);
        let mut out = [0u8; MAX_MESSAGE];
        let len = phone
            .handshake
            .as_mut()
            .unwrap()
            .write_message(b"early secret", &mut out)
            .unwrap();
        let mut session = Session::new(&identity, ID).unwrap();
        assert_eq!(
            session.on_write(&out[..len], &mut Provisioner::new(false)),
            Err(ProtocolError::Malformed)
        );
    }

    #[test]
    fn requests_round_trip_and_reject_bad_lengths() {
        for request in [
            provision(ATTEMPT, b"12345678"),
            provision(ATTEMPT, &[b'p'; 63]),
            Request::Status { attempt: ATTEMPT },
        ] {
            assert_eq!(Request::decode(&request.encode()), Ok(request));
        }
        let too_short = provision(ATTEMPT, b"1234567").encode();
        let too_long = provision(ATTEMPT, &[b'p'; 64]).encode();
        let empty_ssid = Request::Provision {
            attempt: ATTEMPT,
            ssid: vec![],
            password: b"12345678".to_vec(),
        }
        .encode();
        let mut trailing = Request::Status { attempt: ATTEMPT }.encode();
        trailing.push(0);
        for bad in [
            too_short,
            too_long,
            empty_ssid,
            trailing,
            vec![],
            vec![9; 17],
            vec![PROVISION; 18],
        ] {
            assert_eq!(Request::decode(&bad), Err(ProtocolError::Malformed));
        }
    }

    #[test]
    fn debug_output_never_contains_credentials() {
        let request = provision(ATTEMPT, b"correct horse");
        assert_eq!(format!("{request:?}"), "Provision { .. }");
        let activation = Activation {
            attempt: ATTEMPT,
            ssid: b"Ward-3".to_vec(),
            password: b"correct horse".to_vec(),
        };
        assert_eq!(format!("{activation:?}"), "Activation { .. }");
    }

    #[test]
    fn responses_round_trip() {
        for outcome in [
            Outcome::Pending,
            Outcome::Connected {
                ipv4: [10, 0, 0, 2],
            },
            Outcome::Failed(Failure::WrongPsk),
            Outcome::Failed(Failure::Conflict),
            Outcome::Unknown,
        ] {
            let response = Response {
                attempt: ATTEMPT,
                outcome,
            };
            assert_eq!(Response::decode(&response.encode()), Ok(response));
        }
        assert_eq!(Response::decode(&[0; 16]), Err(ProtocolError::Malformed));
        assert_eq!(
            Response::decode(&[[0; 16].as_slice(), &[2, 99]].concat()),
            Err(ProtocolError::Malformed)
        );
    }

    #[test]
    fn attempts_recover_conflict_and_serialize() {
        let mut provisioner = Provisioner::new(false);
        let other: AttemptId = [8; ATTEMPT_ID_LEN];
        assert_eq!(
            provisioner
                .handle(provision(ATTEMPT, b"correct horse"))
                .outcome,
            Outcome::Pending
        );
        assert_eq!(
            provisioner
                .handle(provision(other, b"correct horse"))
                .outcome,
            Outcome::Failed(Failure::Busy)
        );
        assert_eq!(
            provisioner
                .handle(provision(ATTEMPT, b"other password"))
                .outcome,
            Outcome::Failed(Failure::Conflict)
        );

        provisioner.take_activation();
        provisioner.complete(ATTEMPT, Outcome::Failed(Failure::WrongPsk));
        assert_eq!(
            provisioner
                .handle(provision(ATTEMPT, b"correct horse"))
                .outcome,
            Outcome::Failed(Failure::WrongPsk),
            "stored result, no rerun"
        );
        assert!(provisioner.take_activation().is_none());
        assert_eq!(
            provisioner
                .handle(provision(other, b"right this time"))
                .outcome,
            Outcome::Pending,
            "a new attempt ID retries"
        );
        assert_eq!(
            provisioner
                .handle(Request::Status { attempt: [1; 16] })
                .outcome,
            Outcome::Unknown
        );
    }

    #[test]
    fn success_is_terminal() {
        let mut provisioner = Provisioner::new(false);
        provisioner.handle(provision(ATTEMPT, b"correct horse"));
        provisioner.take_activation();
        provisioner.complete(
            ATTEMPT,
            Outcome::Connected {
                ipv4: [10, 0, 0, 2],
            },
        );
        let second: AttemptId = [8; ATTEMPT_ID_LEN];
        assert_eq!(
            provisioner
                .handle(provision(second, b"another one"))
                .outcome,
            Outcome::Failed(Failure::AlreadyProvisioned)
        );
        assert_eq!(
            Provisioner::new(true)
                .handle(provision(second, b"another one"))
                .outcome,
            Outcome::Failed(Failure::AlreadyProvisioned)
        );
    }

    #[test]
    fn identity_round_trips_once_and_reports_absence() {
        let dir = std::env::temp_dir().join(format!("iot-identity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(Identity::load(&dir).unwrap().is_none());
        let identity = Identity::generate().unwrap();
        identity.save_new(&dir).unwrap();
        let loaded = Identity::load(&dir).unwrap().unwrap();
        assert_eq!(
            (loaded.private_key, loaded.public_key, loaded.secret),
            (identity.private_key, identity.public_key, identity.secret)
        );
        assert!(
            Identity::generate().unwrap().save_new(&dir).is_err(),
            "never overwritten"
        );
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join(IDENTITY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::write(dir.join(IDENTITY_FILE), [0u8; 10]).unwrap();
        assert!(
            Identity::load(&dir).is_err(),
            "corrupt file is an error, not a fresh device"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn label_carries_id_key_and_secret() {
        let identity = Identity {
            private_key: [1; 32],
            public_key: [0xab; 32],
            secret: [0x0f; 32],
        };
        assert_eq!(
            identity.label(ID),
            format!("T1:{ID}:{}:{}", "ab".repeat(32), "0f".repeat(32))
        );
    }

    #[test]
    fn random_input_never_panics() {
        let identity = Identity::generate().unwrap();
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        // Parsers are cheap: many inputs. Sessions cost a handshake each: fewer.
        for round in 0..20_000 {
            let len = (next() % 600) as usize;
            let bytes: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            let _ = Request::decode(&bytes);
            let _ = Response::decode(&bytes);
            if round % 100 == 0 {
                let mut session = Session::new(&identity, ID).unwrap();
                let _ = session.on_write(&bytes, &mut Provisioner::new(false));
                let (_, mut transport) = connected(&identity);
                let _ = transport.on_write(&bytes, &mut Provisioner::new(false));
            }
        }
    }
}
