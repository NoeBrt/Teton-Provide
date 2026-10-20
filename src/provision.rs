//! Encrypted Wi-Fi provisioning, device side (see docs/SECURITY.md).
//!
//! The phone and the device run `Noise_XX_25519_ChaChaPoly_SHA256` over one GATT characteristic: each
//! acknowledged write carries one Noise message and the following read returns the device's reply.
//! - message 1, phone: `-> e`, empty;
//! - message 2, device: `<- e, ee, s, es`, carrying its device certificate: the phone checks it was signed by
//!   Teton's device authority for the static key it just proved, before anything secret leaves the phone;
//! - message 3, phone: `-> s, se`, carrying the technician token: the device checks it was signed by Teton's
//!   technician authority, names this device's customer, has not expired and names the static key the phone just
//!   proved as its holder, and answers accepted or refused.
//!
//! Credentials only ever travel as Noise transport messages, after an accepted token.
//! This module is pure logic: no BLE, no NetworkManager. The binary feeds it GATT writes and runs the
//! Wi-Fi activation it asks for, then reports the outcome back with [`Provisioner::complete`].

use crate::authority::{AuthorityError, DeviceCertificate, TechnicianToken};
use ed25519_dalek::VerifyingKey;
use sha2::{Digest, Sha256};
use snow::{Builder, HandshakeState, TransportState};
use std::collections::HashMap;
use std::fmt;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub const NOISE_PARAMS: &str = "Noise_XX_25519_ChaChaPoly_SHA256";
/// Binds the protocol version into the handshake transcript.
pub const PROLOGUE: &[u8] = b"teton-provision/2";
pub const PROVISION_CHARACTERISTIC_UUID: u128 = 0x3c2c02fa_847e_480c_9f22_b239dfa524c9;
/// One Noise message per GATT value; with its frame byte it stays within the 512-byte ATT attribute limit.
/// ponytail: no chunk layer, the largest message (message 3 with the largest token) is 499 bytes, 500 with its frame
/// byte.
pub const MAX_MESSAGE: usize = 511;
/// First byte of every GATT write: start a new handshake (resets this phone's session) or continue it.
/// It sits outside the encryption; altering it only makes the handshake or decryption fail.
pub const FRAME_HANDSHAKE: u8 = 0;
pub const FRAME_TRANSPORT: u8 = 1;
pub const KEY_LEN: usize = 32;
pub const ATTEMPT_ID_LEN: usize = 16;
pub const MAX_SSID: usize = 32;
/// WPA2-Personal passphrase bounds (IEEE 802.11i).
pub const PASSWORD_LEN: std::ops::RangeInclusive<usize> = 8..=63;

/// The device's answer to message 3, inside the channel: `[0]` accepted, or `[1][reason]` refused.
pub const TOKEN_ACCEPTED: u8 = 0;
pub const TOKEN_REFUSED: u8 = 1;
/// Refusal reasons the app turns into a sentence for the technician.
pub const REFUSED_INVALID: u8 = 1;
pub const REFUSED_OTHER_CUSTOMER: u8 = 2;
pub const REFUSED_EXPIRED: u8 = 3;

pub type AttemptId = [u8; ATTEMPT_ID_LEN];

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
    /// No longer sent: a technician token authorizes reconfiguration. Kept so codes stay stable.
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
    /// Handshake or decryption failed: tampering, replay, reordering, a broken key exchange.
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

/// The device's static X25519 key pair, created once at staging.
pub struct KeyPair {
    pub private_key: [u8; KEY_LEN],
    pub public_key: [u8; KEY_LEN],
}

impl KeyPair {
    /// A fresh key pair from the operating system's RNG (staging, and the holder key of each technician code).
    pub fn generate() -> Result<Self, snow::Error> {
        let keypair = Builder::new(params()).generate_keypair()?;
        Ok(KeyPair {
            private_key: keypair
                .private
                .try_into()
                .expect("X25519 private key is 32 bytes"),
            public_key: keypair
                .public
                .try_into()
                .expect("X25519 public key is 32 bytes"),
        })
    }

    /// Writes the key pair; refuses to overwrite one, so a staged key is never replaced by accident.
    pub fn save_new(&self, dir: &Path) -> io::Result<()> {
        std::fs::create_dir_all(dir)?;
        write_new(
            dir,
            IDENTITY_FILE,
            &[self.private_key, self.public_key].concat(),
        )
    }

    /// `Ok(None)` when the device has no key yet. Earlier versions appended a label secret, now unused: the key
    /// pair still comes first, so those sensors keep their key.
    pub fn load(dir: &Path) -> io::Result<Option<Self>> {
        let Some(bytes) = read_optional(dir, IDENTITY_FILE)? else {
            return Ok(None);
        };
        let part = |i: usize| -> Option<[u8; KEY_LEN]> {
            bytes.get(i * KEY_LEN..(i + 1) * KEY_LEN)?.try_into().ok()
        };
        let length = bytes.len() == 2 * KEY_LEN || bytes.len() == 3 * KEY_LEN;
        match (length, part(0), part(1)) {
            (true, Some(private_key), Some(public_key)) => Ok(Some(KeyPair {
                private_key,
                public_key,
            })),
            _ => Err(invalid("corrupt identity file")),
        }
    }

    /// Rewrites an identity file of the earlier form as the key pair alone, so the unused label secret leaves the
    /// disk: to a 0600 temporary file, synced, renamed over it, then the directory synced (a power cut leaves one
    /// form or the other, both readable). `Ok(false)` when there is nothing to rewrite.
    pub fn drop_label_secret(dir: &Path) -> io::Result<bool> {
        let Some(bytes) = read_optional(dir, IDENTITY_FILE)? else {
            return Ok(false);
        };
        if bytes.len() != 3 * KEY_LEN {
            return Ok(false);
        }
        let temporary = format!("{IDENTITY_FILE}.new");
        let _ = std::fs::remove_file(dir.join(&temporary)); // left by a power cut; write_new creates it afresh
        write_new(dir, &temporary, &bytes[..2 * KEY_LEN])?;
        std::fs::rename(dir.join(&temporary), dir.join(IDENTITY_FILE))?;
        std::fs::File::open(dir)?.sync_all()?;
        Ok(true)
    }
}

/// Everything the device needs to provision: its key pair, its certificate from Teton's device authority, and
/// the public key of Teton's technician authority, which signs the tokens it accepts.
pub struct Identity {
    pub keys: KeyPair,
    pub certificate: DeviceCertificate,
    pub technician_authority: [u8; KEY_LEN],
}

impl Identity {
    /// Stores the certificate and the technician authority next to the key pair. Refuses a certificate made for
    /// another key, a technician authority that is not an Ed25519 key or that signed the certificate (the device
    /// authority, pasted by mistake), and never replaces an installed one.
    pub fn install(
        dir: &Path,
        certificate: &[u8],
        technician_authority: &[u8; KEY_LEN],
    ) -> io::Result<()> {
        let keys =
            KeyPair::load(dir)?.ok_or_else(|| invalid("no key pair: stage the device first"))?;
        let parsed =
            DeviceCertificate::decode(certificate).map_err(|_| invalid("malformed certificate"))?;
        if parsed.public_key != keys.public_key {
            return Err(invalid("this certificate was made for another device"));
        }
        if VerifyingKey::from_bytes(technician_authority).is_err()
            || parsed.verify(technician_authority).is_ok()
        {
            return Err(invalid("not the technician authority's public key"));
        }
        write_new(dir, TECHNICIAN_AUTHORITY_FILE, technician_authority)?;
        write_new(dir, CERTIFICATE_FILE, certificate).inspect_err(|_| {
            let _ = std::fs::remove_file(dir.join(TECHNICIAN_AUTHORITY_FILE)); // so a re-run can install
        })
    }

    /// `Ok(None)` until the device is staged and certified: it then offers the hello probe only.
    pub fn load(dir: &Path) -> io::Result<Option<Self>> {
        let Some(keys) = KeyPair::load(dir)? else {
            return Ok(None);
        };
        let (Some(certificate), Some(authority)) = (
            read_optional(dir, CERTIFICATE_FILE)?,
            read_optional(dir, TECHNICIAN_AUTHORITY_FILE)?,
        ) else {
            return Ok(None);
        };
        let certificate =
            DeviceCertificate::decode(&certificate).map_err(|_| invalid("corrupt certificate"))?;
        let technician_authority = authority
            .try_into()
            .map_err(|_| invalid("corrupt technician authority"))?;
        if certificate.public_key != keys.public_key {
            return Err(invalid("certificate and key pair disagree"));
        }
        Ok(Some(Identity {
            keys,
            certificate,
            technician_authority,
        }))
    }

    /// What the device advertises and the app shows: derived from the key, so only this device can prove it.
    pub fn device_id(&self) -> String {
        crate::authority::device_id(&self.keys.public_key)
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

fn read_optional(dir: &Path, name: &str) -> io::Result<Option<Vec<u8>>> {
    match std::fs::read(dir.join(name)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Creates a 0600 file that must not exist yet, synced to disk.
fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(dir.join(name))?;
    // A partial file would make every re-run fail with AlreadyExists; this call created it, so it goes.
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .inspect_err(|_| {
            let _ = std::fs::remove_file(dir.join(name));
        })
}

pub const IDENTITY_FILE: &str = "identity";
pub const CERTIFICATE_FILE: &str = "certificate";
pub const TECHNICIAN_AUTHORITY_FILE: &str = "technician-authority";
/// Holds the UUID of the Wi-Fi profile that last succeeded; absent until a first success.
pub const PROVISIONED_FILE: &str = "provisioned";

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hex digits (either case, surrounding blanks ignored) to bytes; `None` for anything else.
pub fn unhex(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if text.len() % 2 != 0 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

fn params() -> snow::params::NoiseParams {
    NOISE_PARAMS.parse().expect("valid Noise pattern")
}

fn refusal(error: &AuthorityError) -> u8 {
    match error {
        AuthorityError::OtherCustomer => REFUSED_OTHER_CUSTOMER,
        AuthorityError::Expired => REFUSED_EXPIRED,
        AuthorityError::Malformed | AuthorityError::BadSignature | AuthorityError::WrongHolder => {
            REFUSED_INVALID
        }
    }
}

enum Phase {
    /// Waits for message 1.
    Start(Box<HandshakeState>),
    /// Sent message 2 with the certificate; waits for message 3 with the technician token.
    Token(Box<HandshakeState>),
    Transport(Box<TransportState>),
    Closed,
}

/// Noise state for one connected phone. Any error closes it for good; the phone reconnects.
pub struct Session {
    phase: Phase,
    certificate: Vec<u8>,
    customer: String,
    technician_authority: [u8; KEY_LEN],
    /// Unix seconds, already floored by the caller (`authority::checked_now`: firmware date, recorded clock floor).
    now: u64,
    technician: Option<String>,
    refused: Option<AuthorityError>,
}

impl Session {
    pub fn new(identity: &Identity, now: u64) -> Result<Self, ProtocolError> {
        let handshake = Builder::new(params())
            .local_private_key(&identity.keys.private_key)
            .and_then(|b| b.prologue(PROLOGUE))
            .and_then(|b| b.build_responder())
            .map_err(|_| ProtocolError::Crypto)?;
        Ok(Session {
            phase: Phase::Start(Box::new(handshake)),
            certificate: identity.certificate.encode(),
            customer: identity.certificate.customer.clone(),
            technician_authority: identity.technician_authority,
            now,
            technician: None,
            refused: None,
        })
    }

    /// The technician whose token this session accepted; `None` before, and after a refusal.
    pub fn technician(&self) -> Option<&str> {
        self.technician.as_deref()
    }

    /// Why this session refused its token, for the device log (the phone only reads `REFUSED_*`); `None` before,
    /// and after an acceptance.
    pub fn refused(&self) -> Option<AuthorityError> {
        self.refused
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
            Phase::Start(mut handshake) => {
                let payload = handshake
                    .read_message(message, &mut buffer)
                    .map_err(|_| ProtocolError::Crypto)?;
                if payload != 0 {
                    return Err(ProtocolError::Malformed); // nothing may ride on the first message
                }
                let len = handshake
                    .write_message(&self.certificate, &mut buffer)
                    .map_err(|_| ProtocolError::Crypto)?;
                self.phase = Phase::Token(handshake);
                Ok(buffer[..len].to_vec())
            }
            Phase::Token(mut handshake) => {
                let len = handshake
                    .read_message(message, &mut buffer)
                    .map_err(|_| ProtocolError::Crypto)?;
                let token = TechnicianToken::decode(&buffer[..len]).and_then(|token| {
                    token.verify(&self.technician_authority, &self.customer, self.now)?;
                    // The phone proved the holder's private key: a sensor that recorded this token cannot replay it.
                    if handshake.get_remote_static() != Some(&token.holder[..]) {
                        return Err(AuthorityError::WrongHolder);
                    }
                    Ok(token)
                });
                buffer.fill(0);
                let mut transport = handshake
                    .into_transport_mode()
                    .map_err(|_| ProtocolError::Crypto)?;
                let answer = match &token {
                    Ok(_) => vec![TOKEN_ACCEPTED],
                    Err(error) => vec![TOKEN_REFUSED, refusal(error)],
                };
                let len = transport
                    .write_message(&answer, &mut buffer)
                    .map_err(|_| ProtocolError::Crypto)?;
                match token {
                    Ok(token) => {
                        self.technician = Some(token.name);
                        self.phase = Phase::Transport(Box::new(transport));
                    }
                    // Refused: the phone reads why, then the session stays closed.
                    Err(error) => self.refused = Some(error),
                }
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

/// Finished results kept for recovery; one phone at a time only asks about its latest attempts.
const MAX_RECORDS: usize = 64;

/// Attempt registry shared by all sessions: one attempt in flight, results kept for recovery. A technician
/// token also authorizes reconfiguring a provisioned device (new password, new network).
#[derive(Default)]
pub struct Provisioner {
    records: HashMap<AttemptId, Record>,
    activation: Option<Activation>,
}

impl Provisioner {
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
                    None if self.in_flight() => Outcome::Failed(Failure::Busy),
                    None => {
                        // ponytail: forgets every finished result when full; an LRU if old attempts matter.
                        if self.records.len() >= MAX_RECORDS {
                            self.records.clear(); // nothing is pending here (not in flight)
                        }
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

    /// Records the activation result.
    pub fn complete(&mut self, attempt: AttemptId, outcome: Outcome) {
        if let Some(record) = self.records.get_mut(&attempt) {
            record.outcome = outcome;
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
    use crate::authority::{MAX_CUSTOMER, MAX_CUSTOMERS, MAX_NAME};
    use ed25519_dalek::SigningKey;

    const ATTEMPT: AttemptId = [7; ATTEMPT_ID_LEN];
    const NOW: u64 = 1_800_000_000;
    const CUSTOMER: &str = "DEMO";

    fn devices() -> SigningKey {
        SigningKey::from_bytes(&[1; 32])
    }

    fn technicians() -> SigningKey {
        SigningKey::from_bytes(&[2; 32])
    }

    fn identity() -> Identity {
        let keys = KeyPair::generate().unwrap();
        let certificate = DeviceCertificate::sign(&devices(), keys.public_key, CUSTOMER).unwrap();
        Identity {
            keys,
            certificate,
            technician_authority: technicians().verifying_key().to_bytes(),
        }
    }

    /// The holder private key of the test phone's technician code, as the code carries it.
    const HOLDER: [u8; KEY_LEN] = [3; KEY_LEN];

    fn holder() -> [u8; KEY_LEN] {
        curve25519_dalek::MontgomeryPoint::mul_base_clamped(HOLDER).to_bytes()
    }

    fn token_signed_by(authority: &SigningKey, customers: &[&str], expires: u64) -> Vec<u8> {
        let customers: Vec<String> = customers.iter().map(|c| c.to_string()).collect();
        TechnicianToken::issue(authority, "Noé", &customers, expires, holder())
            .unwrap()
            .encode()
    }

    fn token(customers: &[&str], expires: u64) -> Vec<u8> {
        token_signed_by(&technicians(), customers, expires)
    }

    fn provision(attempt: AttemptId, password: &[u8]) -> Request {
        Request::Provision {
            attempt,
            ssid: b"Ward-3".to_vec(),
            password: password.to_vec(),
        }
    }

    /// The phone side, built from snow so the device is tested against a real XX initiator; it checks the
    /// certificate the way the app does, and uses its code's holder key as its static key.
    struct Phone {
        handshake: Option<HandshakeState>,
        transport: Option<TransportState>,
    }

    impl Phone {
        fn new() -> Self {
            let handshake = Builder::new(params())
                .local_private_key(&HOLDER)
                .and_then(|b| b.prologue(PROLOGUE))
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

        /// Reads message 2 and checks the certificate: Teton's signature, and the key the device just proved.
        fn certificate(&mut self, reply: &[u8]) -> Result<DeviceCertificate, String> {
            let mut out = [0u8; MAX_MESSAGE];
            let handshake = self.handshake.as_mut().unwrap();
            let len = handshake
                .read_message(reply, &mut out)
                .map_err(|e| e.to_string())?;
            let certificate = DeviceCertificate::decode(&out[..len]).map_err(|e| e.to_string())?;
            certificate
                .verify(&devices().verifying_key().to_bytes())
                .map_err(|e| e.to_string())?;
            if handshake.get_remote_static() != Some(&certificate.public_key[..]) {
                return Err("certificate made for another key".into());
            }
            Ok(certificate)
        }

        /// Message 3: the technician token. The phone is then in transport mode.
        fn present(&mut self, token: &[u8]) -> Vec<u8> {
            let mut out = [0u8; MAX_MESSAGE];
            let mut handshake = self.handshake.take().unwrap();
            let len = handshake.write_message(token, &mut out).unwrap();
            self.transport = Some(handshake.into_transport_mode().unwrap());
            out[..len].to_vec()
        }

        fn plaintext(&mut self, reply: &[u8]) -> Vec<u8> {
            let mut out = [0u8; MAX_MESSAGE];
            let len = self
                .transport
                .as_mut()
                .unwrap()
                .read_message(reply, &mut out)
                .unwrap();
            out[..len].to_vec()
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
            Response::decode(&self.plaintext(reply)).unwrap()
        }
    }

    /// Runs the handshake with `token`; returns the phone, the session and the device's answer to the token.
    fn handshake(identity: &Identity, token: &[u8], now: u64) -> (Phone, Session, Vec<u8>) {
        let mut phone = Phone::new();
        let mut session = Session::new(identity, now).unwrap();
        let mut provisioner = Provisioner::default();
        let reply = session.on_write(&phone.hello(), &mut provisioner).unwrap();
        phone.certificate(&reply).unwrap();
        let reply = session
            .on_write(&phone.present(token), &mut provisioner)
            .unwrap();
        let answer = phone.plaintext(&reply);
        (phone, session, answer)
    }

    fn connected(identity: &Identity) -> (Phone, Session) {
        let (phone, session, answer) = handshake(identity, &token(&[CUSTOMER], NOW + 3600), NOW);
        assert_eq!(answer, [TOKEN_ACCEPTED]);
        (phone, session)
    }

    #[test]
    fn provision_then_status_reports_the_connection() {
        let identity = identity();
        let (mut phone, mut session) = connected(&identity);
        assert_eq!(session.technician(), Some("Noé"));
        assert_eq!(session.refused(), None);
        let mut provisioner = Provisioner::default();

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
    }

    #[test]
    fn an_impostor_is_caught_by_its_certificate_before_the_token_leaves() {
        let genuine = identity();
        // A copied certificate: the impostor cannot prove the genuine key during the handshake.
        let copycat = Identity {
            keys: KeyPair::generate().unwrap(),
            certificate: genuine.certificate.clone(),
            technician_authority: genuine.technician_authority,
        };
        // Its own key, certified by an authority that is not Teton's device authority.
        let keys = KeyPair::generate().unwrap();
        let rogue_certificate =
            DeviceCertificate::sign(&SigningKey::from_bytes(&[9; 32]), keys.public_key, CUSTOMER)
                .unwrap();
        let self_signed = Identity {
            keys,
            certificate: rogue_certificate,
            technician_authority: genuine.technician_authority,
        };

        for device in [&copycat, &self_signed] {
            let mut phone = Phone::new();
            let mut session = Session::new(device, NOW).unwrap();
            let reply = session
                .on_write(&phone.hello(), &mut Provisioner::default())
                .unwrap();
            assert!(
                phone.certificate(&reply).is_err(),
                "the phone stops here and never presents its token"
            );
        }
        let mut phone = Phone::new();
        let reply = Session::new(&genuine, NOW)
            .unwrap()
            .on_write(&phone.hello(), &mut Provisioner::default())
            .unwrap();
        assert_eq!(
            phone.certificate(&reply).map(|c| c.customer),
            Ok(CUSTOMER.to_string())
        );
    }

    #[test]
    fn tokens_for_another_customer_expired_or_forged_are_refused_and_close_the_session() {
        let identity = identity();
        for (token, now, reason) in [
            (token(&["OTHER"], NOW + 3600), NOW, REFUSED_OTHER_CUSTOMER),
            (token(&[CUSTOMER], NOW), NOW, REFUSED_EXPIRED),
            (
                token_signed_by(&devices(), &[CUSTOMER], NOW + 3600),
                NOW,
                REFUSED_INVALID,
            ),
            (b"not a token".to_vec(), NOW, REFUSED_INVALID),
        ] {
            let (mut phone, mut session, answer) = handshake(&identity, &token, now);
            assert_eq!(answer, [TOKEN_REFUSED, reason]);
            assert_eq!(session.technician(), None);
            assert_eq!(session.refused().map(|e| refusal(&e)), Some(reason));
            let mut provisioner = Provisioner::default();
            assert_eq!(
                session.on_write(
                    &phone.seal(&provision(ATTEMPT, b"correct horse")),
                    &mut provisioner
                ),
                Err(ProtocolError::Closed)
            );
            assert!(
                provisioner.take_activation().is_none(),
                "no network accepted without a valid token"
            );
        }
    }

    #[test]
    fn a_token_presented_without_its_holder_key_is_refused() {
        let identity = identity();
        // Genuine and in scope, but this phone lacks its holder key: what a sensor that recorded it would replay.
        let recorded = TechnicianToken::issue(
            &technicians(),
            "Noé",
            &[CUSTOMER.to_string()],
            NOW + 3600,
            KeyPair::generate().unwrap().public_key,
        )
        .unwrap()
        .encode();
        let (_, session, answer) = handshake(&identity, &recorded, NOW);
        assert_eq!(answer, [TOKEN_REFUSED, REFUSED_INVALID]);
        assert_eq!(
            (session.technician(), session.refused()),
            (None, Some(AuthorityError::WrongHolder))
        );
    }

    #[test]
    fn the_largest_token_fits_one_message() {
        let customers: Vec<String> = (0..MAX_CUSTOMERS)
            .map(|i| format!("{i:0>MAX_CUSTOMER$}"))
            .collect();
        let name = "N".repeat(MAX_NAME);
        let token = TechnicianToken::issue(&technicians(), &name, &customers, NOW + 1, holder())
            .unwrap()
            .encode();
        let mut identity = identity();
        identity.certificate =
            DeviceCertificate::sign(&devices(), identity.keys.public_key, &customers[0]).unwrap();
        let mut phone = Phone::new();
        let mut session = Session::new(&identity, NOW).unwrap();
        let mut provisioner = Provisioner::default();
        let reply = session.on_write(&phone.hello(), &mut provisioner).unwrap();
        phone.certificate(&reply).unwrap();
        let message = phone.present(&token);
        assert_eq!(
            message.len(),
            499,
            "MAX_MESSAGE's comment; 500 with the frame byte"
        );
        let reply = session.on_write(&message, &mut provisioner).unwrap();
        assert_eq!(phone.plaintext(&reply), [TOKEN_ACCEPTED]);
    }

    #[test]
    fn tampered_truncated_and_replayed_messages_close_the_session() {
        let identity = identity();
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
            let mut provisioner = Provisioner::default();
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
        let mut provisioner = Provisioner::default();
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
        let identity = identity();
        let (mut phone, mut session) = connected(&identity);
        let _first = phone.seal(&Request::Status { attempt: ATTEMPT });
        let second = phone.seal(&Request::Status { attempt: ATTEMPT });
        assert_eq!(
            session.on_write(&second, &mut Provisioner::default()),
            Err(ProtocolError::Crypto)
        );
    }

    #[test]
    fn oversized_and_payload_carrying_first_messages_are_rejected() {
        let identity = identity();
        let mut session = Session::new(&identity, NOW).unwrap();
        assert_eq!(
            session.on_write(&[0; MAX_MESSAGE + 1], &mut Provisioner::default()),
            Err(ProtocolError::Oversized)
        );

        let mut phone = Phone::new();
        let mut out = [0u8; MAX_MESSAGE];
        let len = phone
            .handshake
            .as_mut()
            .unwrap()
            .write_message(b"early secret", &mut out)
            .unwrap();
        let mut session = Session::new(&identity, NOW).unwrap();
        assert_eq!(
            session.on_write(&out[..len], &mut Provisioner::default()),
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
        let mut provisioner = Provisioner::default();
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
    fn a_provisioned_device_can_be_reconfigured() {
        let mut provisioner = Provisioner::default();
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
                .handle(provision(second, b"new password"))
                .outcome,
            Outcome::Pending
        );
    }

    #[test]
    fn the_registry_keeps_at_most_64_finished_results() {
        let mut provisioner = Provisioner::default();
        let last = MAX_RECORDS as u8;
        for i in 0..=last {
            provisioner.handle(provision([i; ATTEMPT_ID_LEN], b"correct horse"));
            provisioner.take_activation();
            provisioner.complete([i; ATTEMPT_ID_LEN], Outcome::Failed(Failure::WrongPsk));
            assert!(provisioner.records.len() <= MAX_RECORDS);
        }
        assert_eq!(
            provisioner
                .handle(Request::Status {
                    attempt: [last; ATTEMPT_ID_LEN]
                })
                .outcome,
            Outcome::Failed(Failure::WrongPsk),
            "the latest result is kept"
        );
    }

    #[test]
    fn hex_round_trips_and_rejects_anything_else() {
        assert_eq!(
            unhex(&format!(" {}\n", hex(&[0, 0xab, 0xff]))),
            Some(vec![0, 0xab, 0xff])
        );
        assert_eq!(unhex("ABcd"), Some(vec![0xab, 0xcd]));
        for bad in ["a", "zz", "+a", "é"] {
            assert_eq!(unhex(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_device_is_ready_only_once_keyed_and_certified_for_its_own_key() {
        let dir = std::env::temp_dir().join(format!("teton-identity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(Identity::load(&dir).unwrap().is_none(), "nothing staged");
        let keys = KeyPair::generate().unwrap();
        keys.save_new(&dir).unwrap();
        assert!(
            KeyPair::generate().unwrap().save_new(&dir).is_err(),
            "a key is never overwritten"
        );
        assert!(
            Identity::load(&dir).unwrap().is_none(),
            "keyed but not certified: hello only"
        );

        let authority = technicians().verifying_key().to_bytes();
        let foreign = DeviceCertificate::sign(&devices(), [5; 32], CUSTOMER)
            .unwrap()
            .encode();
        assert!(
            Identity::install(&dir, &foreign, &authority).is_err(),
            "certificate for another key"
        );
        let own = DeviceCertificate::sign(&devices(), keys.public_key, CUSTOMER)
            .unwrap()
            .encode();
        // Not an Ed25519 key, or the device authority's key pasted in its place: every code would be refused.
        for wrong in [[2; KEY_LEN], devices().verifying_key().to_bytes()] {
            assert!(Identity::install(&dir, &own, &wrong).is_err());
        }
        // A certificate that cannot be written leaves nothing behind, so a re-run installs.
        std::fs::create_dir(dir.join(CERTIFICATE_FILE)).unwrap();
        assert!(Identity::install(&dir, &own, &authority).is_err());
        std::fs::remove_dir(dir.join(CERTIFICATE_FILE)).unwrap();
        Identity::install(&dir, &own, &authority).unwrap();
        let loaded = Identity::load(&dir).unwrap().unwrap();
        assert_eq!(
            (loaded.keys.public_key, loaded.certificate.customer.as_str()),
            (keys.public_key, CUSTOMER)
        );
        assert_eq!(
            loaded.device_id(),
            crate::authority::device_id(&keys.public_key)
        );

        use std::os::unix::fs::PermissionsExt;
        for file in [IDENTITY_FILE, CERTIFICATE_FILE, TECHNICIAN_AUTHORITY_FILE] {
            assert_eq!(
                std::fs::metadata(dir.join(file))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
                "{file}"
            );
        }
        // Earlier versions appended a label secret: the key pair is still read.
        std::fs::write(
            dir.join(IDENTITY_FILE),
            [keys.private_key, keys.public_key, [0; KEY_LEN]].concat(),
        )
        .unwrap();
        assert_eq!(
            KeyPair::load(&dir).unwrap().map(|k| k.public_key),
            Some(keys.public_key)
        );
        // `stage install` rewrites it without the secret, still 0600, and only once.
        assert!(KeyPair::drop_label_secret(&dir).unwrap());
        assert_eq!(
            std::fs::read(dir.join(IDENTITY_FILE)).unwrap(),
            [keys.private_key, keys.public_key].concat()
        );
        let mode = std::fs::metadata(dir.join(IDENTITY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        assert!(!KeyPair::drop_label_secret(&dir).unwrap(), "nothing left");
        assert!(!dir.join(format!("{IDENTITY_FILE}.new")).exists());
        std::fs::write(dir.join(IDENTITY_FILE), [0u8; 10]).unwrap();
        assert!(
            Identity::load(&dir).is_err(),
            "corrupt file is an error, not a fresh device"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn random_input_never_panics() {
        let identity = identity();
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
            let _ = TechnicianToken::decode(&bytes);
            let _ = DeviceCertificate::decode(&bytes);
            if round % 100 == 0 {
                let mut session = Session::new(&identity, NOW).unwrap();
                let _ = session.on_write(&bytes, &mut Provisioner::default());
                let (_, mut transport) = connected(&identity);
                let _ = transport.on_write(&bytes, &mut Provisioner::default());
            }
        }
    }
}
