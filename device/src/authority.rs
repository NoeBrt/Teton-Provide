//! The two offline authorities (docs/SECURITY.md):
//! - a **device certificate**, signed at staging by the device authority, proves a sensor is genuine; the app
//!   checks it during the handshake, before anything secret leaves the phone;
//! - a **technician token**, signed by the technician authority, proves the phone holds an authorized technician's
//!   code for some customers, until a date; the sensor checks it before accepting a network.
//!
//! Two Ed25519 keys, so a leaked key forges only one of the two. Compact formats below; X.509 is the production
//! path (Matter's device attestation works the same way with a certificate chain).

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

pub const DEVICE_CERT_DOMAIN: &[u8] = b"iot-device-cert/1";
pub const TECHNICIAN_TOKEN_DOMAIN: &[u8] = b"iot-technician-token/2";
const CERTIFICATE_VERSION: u8 = 1;
/// Version 2 added the holder key; version 1 tokens are refused as malformed.
const TOKEN_VERSION: u8 = 2;
pub const KEY_LEN: usize = 32;
pub const SIGNATURE_LEN: usize = 64;
pub const MAX_CUSTOMER: usize = 32;
pub const MAX_NAME: usize = 64;
pub const MAX_CUSTOMERS: usize = 8;
pub const CODE_ID_LEN: usize = 8;
/// A code's ID: the first bytes of its holder key, unique per code (the authority makes a fresh key for each).
pub type CodeId = [u8; CODE_ID_LEN];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityError {
    Malformed,
    BadSignature,
    OtherCustomer,
    Expired,
    /// The phone did not prove the token's holder key in the handshake.
    WrongHolder,
}

impl std::fmt::Display for AuthorityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            AuthorityError::Malformed => "malformed",
            AuthorityError::BadSignature => "signature does not verify",
            AuthorityError::OtherCustomer => "not valid for this customer",
            AuthorityError::Expired => "expired",
            AuthorityError::WrongHolder => "presented without its holder key",
        })
    }
}

impl std::error::Error for AuthorityError {}

/// `IOT-` and 10 upper-case hex digits of SHA-256(static public key): unique without a registry (40 bits keep
/// collisions unlikely across millions of sensors), and only the holder of that key can prove it.
pub fn device_id(public_key: &[u8; KEY_LEN]) -> String {
    let hex: String = device_id_bytes(public_key)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect();
    format!("IOT-{hex}")
}

/// The identity in primary BLE manufacturer data, without its constant text prefix.
pub fn device_id_bytes(public_key: &[u8; KEY_LEN]) -> [u8; 5] {
    Sha256::digest(public_key)[..5].try_into().unwrap()
}

/// A technician code as the authority prints it (text and QR) and the app imports it, by in-app scan or paste only:
/// `<token hex>.<holder private key hex>`, no URL scheme another app could claim.
pub fn code_text(token: &[u8], holder_private: &[u8; KEY_LEN]) -> String {
    format!(
        "{}.{}",
        crate::provision::hex(token),
        crate::provision::hex(holder_private)
    )
}

/// A sensor's clock may be unset (new, never online): never trust it before the firmware's build date.
pub fn checked_now(clock: u64, firmware_built: u64) -> u64 {
    clock.max(firmware_built)
}

fn valid_customer(customer: &str) -> bool {
    (1..=MAX_CUSTOMER).contains(&customer.len())
        && customer
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn signed(domain: &[u8], body: &[u8]) -> Vec<u8> {
    [domain, body].concat()
}

fn verify(
    authority: &[u8; KEY_LEN],
    domain: &[u8],
    body: &[u8],
    signature: &[u8; SIGNATURE_LEN],
) -> Result<(), AuthorityError> {
    let key = VerifyingKey::from_bytes(authority).map_err(|_| AuthorityError::BadSignature)?;
    key.verify_strict(&signed(domain, body), &Signature::from_bytes(signature))
        .map_err(|_| AuthorityError::BadSignature)
}

/// Reads `[len][bytes]`; returns the field and the rest.
fn field(bytes: &[u8]) -> Result<(&[u8], &[u8]), AuthorityError> {
    let (&len, rest) = bytes.split_first().ok_or(AuthorityError::Malformed)?;
    let len = usize::from(len);
    (rest.len() >= len)
        .then(|| rest.split_at(len))
        .ok_or(AuthorityError::Malformed)
}

/// Splits `body ‖ signature` and checks the version byte.
fn split_signed(bytes: &[u8], version: u8) -> Result<(&[u8], [u8; SIGNATURE_LEN]), AuthorityError> {
    let at = bytes
        .len()
        .checked_sub(SIGNATURE_LEN)
        .ok_or(AuthorityError::Malformed)?;
    let (body, signature) = bytes.split_at(at);
    if body.first() != Some(&version) {
        return Err(AuthorityError::Malformed);
    }
    Ok((body, signature.try_into().expect("64 bytes")))
}

/// `[1][device static public key 32][customer len][customer]` then an Ed25519 signature over
/// `"iot-device-cert/1" ‖ body`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCertificate {
    pub public_key: [u8; KEY_LEN],
    pub customer: String,
    pub signature: [u8; SIGNATURE_LEN],
}

impl DeviceCertificate {
    fn body(public_key: &[u8; KEY_LEN], customer: &str) -> Vec<u8> {
        [
            &[CERTIFICATE_VERSION][..],
            public_key,
            &[customer.len() as u8],
            customer.as_bytes(),
        ]
        .concat()
    }

    pub fn sign(
        authority: &SigningKey,
        public_key: [u8; KEY_LEN],
        customer: &str,
    ) -> Result<Self, AuthorityError> {
        if !valid_customer(customer) {
            return Err(AuthorityError::Malformed);
        }
        let signature = authority.sign(&signed(
            DEVICE_CERT_DOMAIN,
            &Self::body(&public_key, customer),
        ));
        Ok(DeviceCertificate {
            public_key,
            customer: customer.to_string(),
            signature: signature.to_bytes(),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        [
            Self::body(&self.public_key, &self.customer).as_slice(),
            &self.signature,
        ]
        .concat()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, AuthorityError> {
        let (body, signature) = split_signed(bytes, CERTIFICATE_VERSION)?;
        let public_key: [u8; KEY_LEN] = body
            .get(1..1 + KEY_LEN)
            .and_then(|k| k.try_into().ok())
            .ok_or(AuthorityError::Malformed)?;
        let (customer, rest) = field(&body[1 + KEY_LEN..])?;
        let customer = std::str::from_utf8(customer).map_err(|_| AuthorityError::Malformed)?;
        if !rest.is_empty() || !valid_customer(customer) {
            return Err(AuthorityError::Malformed);
        }
        Ok(DeviceCertificate {
            public_key,
            customer: customer.to_string(),
            signature,
        })
    }

    pub fn verify(&self, authority: &[u8; KEY_LEN]) -> Result<(), AuthorityError> {
        verify(
            authority,
            DEVICE_CERT_DOMAIN,
            &Self::body(&self.public_key, &self.customer),
            &self.signature,
        )
    }
}

/// `[2][expires, Unix seconds, u64 BE][holder X25519 public key 32][name len][name][count][customer len][customer]…`
/// then an Ed25519 signature over `"iot-technician-token/2" ‖ body`. The authority generates the holder key pair
/// with each code; the code carries the private half and the phone uses it as its Noise static key, so a sensor
/// that records the token cannot present it anywhere. Still not bound to one phone: any phone with the code works.
#[derive(Clone, PartialEq, Eq)]
pub struct TechnicianToken {
    pub name: String,
    pub customers: Vec<String>,
    pub expires: u64,
    pub holder: [u8; KEY_LEN],
    pub signature: [u8; SIGNATURE_LEN],
}

// A token is a credential: debug output names its holder and scope, never its bytes.
impl std::fmt::Debug for TechnicianToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "TechnicianToken({}, {:?}, expires {})",
            self.name, self.customers, self.expires
        )
    }
}

impl TechnicianToken {
    /// What the workshop prints at issue and logs in issued.tsv.
    pub fn id(&self) -> CodeId {
        self.holder[..CODE_ID_LEN].try_into().expect("8 bytes")
    }

    fn body(name: &str, customers: &[String], expires: u64, holder: &[u8; KEY_LEN]) -> Vec<u8> {
        let mut body = vec![TOKEN_VERSION];
        body.extend_from_slice(&expires.to_be_bytes());
        body.extend_from_slice(holder);
        body.push(name.len() as u8);
        body.extend_from_slice(name.as_bytes());
        body.push(customers.len() as u8);
        for customer in customers {
            body.push(customer.len() as u8);
            body.extend_from_slice(customer.as_bytes());
        }
        body
    }

    pub fn issue(
        authority: &SigningKey,
        name: &str,
        customers: &[String],
        expires: u64,
        holder: [u8; KEY_LEN],
    ) -> Result<Self, AuthorityError> {
        let valid = (1..=MAX_NAME).contains(&name.len())
            && (1..=MAX_CUSTOMERS).contains(&customers.len())
            && customers.iter().all(|c| valid_customer(c));
        if !valid {
            return Err(AuthorityError::Malformed);
        }
        let signature = authority.sign(&signed(
            TECHNICIAN_TOKEN_DOMAIN,
            &Self::body(name, customers, expires, &holder),
        ));
        Ok(TechnicianToken {
            name: name.to_string(),
            customers: customers.to_vec(),
            expires,
            holder,
            signature: signature.to_bytes(),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        [
            Self::body(&self.name, &self.customers, self.expires, &self.holder).as_slice(),
            &self.signature,
        ]
        .concat()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, AuthorityError> {
        let (body, signature) = split_signed(bytes, TOKEN_VERSION)?;
        let expires = u64::from_be_bytes(
            body.get(1..9)
                .and_then(|b| b.try_into().ok())
                .ok_or(AuthorityError::Malformed)?,
        );
        let holder: [u8; KEY_LEN] = body
            .get(9..9 + KEY_LEN)
            .and_then(|k| k.try_into().ok())
            .ok_or(AuthorityError::Malformed)?;
        let (name, rest) = field(&body[9 + KEY_LEN..])?;
        let name = std::str::from_utf8(name)
            .map_err(|_| AuthorityError::Malformed)?
            .to_string();
        let (&count, mut rest) = rest.split_first().ok_or(AuthorityError::Malformed)?;
        let mut customers = Vec::new();
        for _ in 0..count {
            let (customer, next) = field(rest)?;
            customers.push(
                std::str::from_utf8(customer)
                    .map_err(|_| AuthorityError::Malformed)?
                    .to_string(),
            );
            rest = next;
        }
        let valid = rest.is_empty()
            && (1..=MAX_NAME).contains(&name.len())
            && (1..=MAX_CUSTOMERS).contains(&customers.len())
            && customers.iter().all(|c| valid_customer(c));
        if !valid {
            return Err(AuthorityError::Malformed);
        }
        Ok(TechnicianToken {
            name,
            customers,
            expires,
            holder,
            signature,
        })
    }

    /// Signature first, then scope, then date: a forged token learns nothing about the rest.
    pub fn verify(
        &self,
        authority: &[u8; KEY_LEN],
        customer: &str,
        now: u64,
    ) -> Result<(), AuthorityError> {
        verify(
            authority,
            TECHNICIAN_TOKEN_DOMAIN,
            &Self::body(&self.name, &self.customers, self.expires, &self.holder),
            &self.signature,
        )?;
        if !self.customers.iter().any(|c| c == customer) {
            return Err(AuthorityError::OtherCustomer);
        }
        if now >= self.expires {
            return Err(AuthorityError::Expired);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    const HOLDER: [u8; KEY_LEN] = [9; KEY_LEN];

    fn public(key: &SigningKey) -> [u8; KEY_LEN] {
        key.verifying_key().to_bytes()
    }

    #[test]
    fn a_device_certificate_verifies_only_with_its_authority() {
        let devices = authority(1);
        let cert = DeviceCertificate::sign(&devices, [7; 32], "DEMO").unwrap();
        let decoded = DeviceCertificate::decode(&cert.encode()).unwrap();
        assert_eq!(decoded, cert);
        assert_eq!(decoded.verify(&public(&devices)), Ok(()));
        assert_eq!(
            decoded.verify(&public(&authority(2))),
            Err(AuthorityError::BadSignature),
            "another authority"
        );
        assert_eq!(
            decoded.verify(&public(&authority(3))),
            Err(AuthorityError::BadSignature)
        );
    }

    #[test]
    fn any_changed_byte_breaks_a_certificate() {
        let devices = authority(1);
        let bytes = DeviceCertificate::sign(&devices, [7; 32], "DEMO")
            .unwrap()
            .encode();
        for i in 0..bytes.len() {
            let mut tampered = bytes.clone();
            tampered[i] ^= 1;
            let ok = DeviceCertificate::decode(&tampered)
                .is_ok_and(|c| c.verify(&public(&devices)).is_ok());
            assert!(!ok, "byte {i} changed and the certificate still verifies");
        }
        assert!(
            DeviceCertificate::decode(&bytes[..bytes.len() - 1]).is_err(),
            "truncated"
        );
        assert!(
            DeviceCertificate::decode(&[bytes.as_slice(), &[0]].concat())
                .map_or(true, |c| c.verify(&public(&devices)).is_err())
        );
    }

    #[test]
    fn a_token_is_scoped_to_its_customers_and_its_date() {
        let technicians = authority(4);
        let token = TechnicianToken::issue(
            &technicians,
            "Noé",
            &["DEMO".into(), "CHU-B".into()],
            1_000,
            HOLDER,
        )
        .unwrap();
        let token = TechnicianToken::decode(&token.encode()).unwrap();
        assert_eq!(token.holder, HOLDER);
        assert_eq!(token.verify(&public(&technicians), "CHU-B", 999), Ok(()));
        assert_eq!(
            token.verify(&public(&technicians), "OTHER", 999),
            Err(AuthorityError::OtherCustomer)
        );
        assert_eq!(
            token.verify(&public(&technicians), "DEMO", 1_000),
            Err(AuthorityError::Expired)
        );
        assert_eq!(
            token.verify(&public(&authority(1)), "DEMO", 0),
            Err(AuthorityError::BadSignature),
            "the device authority cannot sign tokens"
        );
    }

    #[test]
    fn a_tampered_token_fails_on_its_signature_before_anything_else() {
        let technicians = authority(4);
        let mut bytes =
            TechnicianToken::issue(&technicians, "Noé", &["DEMO".into()], 1_000, HOLDER)
                .unwrap()
                .encode();
        bytes[8] ^= 0xff; // the expiry, pushed far into the future
        bytes[9] ^= 1; // and another holder key
        let token = TechnicianToken::decode(&bytes).unwrap();
        assert_eq!(
            token.verify(&public(&technicians), "DEMO", 2_000),
            Err(AuthorityError::BadSignature)
        );
        bytes[0] = 1;
        assert_eq!(
            TechnicianToken::decode(&bytes),
            Err(AuthorityError::Malformed),
            "version 1 tokens carried no holder key"
        );
    }

    #[test]
    fn malformed_inputs_are_refused() {
        let technicians = authority(4);
        assert_eq!(
            TechnicianToken::issue(&technicians, "", &["DEMO".into()], 1, HOLDER),
            Err(AuthorityError::Malformed)
        );
        assert_eq!(
            TechnicianToken::issue(&technicians, "Noé", &[], 1, HOLDER),
            Err(AuthorityError::Malformed)
        );
        assert_eq!(
            TechnicianToken::issue(&technicians, "Noé", &["bad customer".into()], 1, HOLDER),
            Err(AuthorityError::Malformed)
        );
        assert_eq!(
            DeviceCertificate::sign(&authority(1), [7; 32], &"x".repeat(33)),
            Err(AuthorityError::Malformed)
        );
        for bytes in [&[][..], &[1][..], &[2; 120][..], &[1; 64][..]] {
            assert!(TechnicianToken::decode(bytes).is_err());
            assert!(DeviceCertificate::decode(bytes).is_err());
        }
    }

    #[test]
    fn device_ids_are_stable_and_distinct() {
        let id = device_id(&[7; 32]);
        assert_eq!(id, device_id(&[7; 32]));
        assert_ne!(id, device_id(&[8; 32]));
        assert_eq!(id.len(), "IOT-".len() + 10);
        assert_eq!(
            id,
            format!(
                "IOT-{}",
                device_id_bytes(&[7; 32])
                    .iter()
                    .map(|b| format!("{b:02X}"))
                    .collect::<String>()
            )
        );
        assert!(
            id.starts_with("IOT-")
                && id[4..]
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_lowercase())
        );
    }

    #[test]
    fn an_unset_clock_never_goes_before_the_firmware_date() {
        assert_eq!(checked_now(0, 1_800_000_000), 1_800_000_000);
        assert_eq!(checked_now(1_900_000_000, 1_800_000_000), 1_900_000_000);
    }

    #[test]
    fn debug_output_never_contains_the_token_bytes() {
        let token =
            TechnicianToken::issue(&authority(4), "Noé", &["DEMO".into()], 1, HOLDER).unwrap();
        let shown = format!("{token:?}");
        assert!(shown.contains("Noé") && !shown.contains(&format!("{:?}", &token.signature[..8])));
    }
}
