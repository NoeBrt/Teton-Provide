use std::fmt;

pub const DEVICE_ID: &str = "IOT-DEMO-001";
pub const REQUEST: &[u8] = b"hello";
pub const RESPONSE: &[u8] = b"world";
/// BLE GATT identifiers of the hello probe, generated once for this project.
pub const SERVICE_UUID: u128 = 0x3b0a90ce_9564_40d1_b96b_14cf8858aba3;
pub const CHARACTERISTIC_UUID: u128 = 0x29b3765c_de49_4114_889e_89b05852c968;

/// The sensor's state, one byte of advertised manufacturer data, so the app shows it before connecting.
/// 0xFFFF is the company ID reserved for tests; a production sensor would use the own.
pub const STATE_COMPANY_ID: u16 = 0xFFFF;
pub const STATE_NOT_STAGED: u8 = 0;
pub const STATE_READY: u8 = 1;
pub const STATE_ONLINE: u8 = 2;
pub const STATE_OFFLINE: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidRequest;

impl fmt::Display for InvalidRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Unsupported request; this endpoint accepts only hello.")
    }
}

impl std::error::Error for InvalidRequest {}

pub fn respond(payload: &[u8]) -> Result<&'static [u8], InvalidRequest> {
    if payload == REQUEST {
        Ok(RESPONSE)
    } else {
        Err(InvalidRequest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_returns_world() {
        assert_eq!(respond(b"hello"), Ok(b"world".as_slice()));
    }

    #[test]
    fn rejects_other_inputs() {
        let oversized = vec![b'a'; 65_536];
        for payload in [
            b"".as_slice(),
            b"HELLO",
            b"hello\n",
            b"hello\0",
            b"\xff\xfe",
            b"password=example-never-send",
            oversized.as_slice(),
        ] {
            assert_eq!(respond(payload), Err(InvalidRequest));
        }
    }

    #[test]
    fn rejects_every_single_byte_mutation() {
        for index in 0..REQUEST.len() {
            for value in u8::MIN..=u8::MAX {
                let mut payload = REQUEST.to_vec();
                payload[index] = value;
                assert_eq!(respond(&payload).is_ok(), payload == REQUEST);
            }
        }
    }

    #[test]
    fn errors_contain_no_request_data() {
        let error = respond(b"password=example-never-send").unwrap_err();
        assert_eq!(
            error.to_string(),
            "Unsupported request; this endpoint accepts only hello."
        );
        assert_eq!(format!("{error:?}"), "InvalidRequest");
    }
}
