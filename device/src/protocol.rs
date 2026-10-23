use std::fmt;

pub const DEVICE_ID: &str = "IOT-DEMO-001";
pub const REQUEST: &[u8] = b"hello";
pub const RESPONSE: &[u8] = b"world";
/// BLE GATT identifiers of the hello probe, generated once for this project.
pub const SERVICE_UUID: u128 = 0x3b0a90ce_9564_40d1_b96b_14cf8858aba3;
pub const CHARACTERISTIC_UUID: u128 = 0x29b3765c_de49_4114_889e_89b05852c968;

/// Manufacturer data starts with state, followed by the five identity bytes when the sensor has a key.
/// 0xFFFF is the company ID reserved for tests; a production sensor would use the own.
pub const STATE_COMPANY_ID: u16 = 0xFFFF;
pub const STATE_NOT_STAGED: u8 = 0;
pub const STATE_READY: u8 = 1;
pub const STATE_ONLINE: u8 = 2;
pub const STATE_OFFLINE: u8 = 3;

/// Fits exactly 31 legacy advertising bytes with flags and the 128-bit service UUID; no room for extra fields.
pub fn manufacturer_data(state: u8, id: Option<[u8; 5]>) -> Vec<u8> {
    let mut data = vec![state];
    if let Some(id) = id {
        data.extend_from_slice(&id);
    }
    data
}

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
    fn identity_and_state_fit_the_primary_legacy_advertisement() {
        let id = [0x7b, 0x09, 0xf2, 0x03, 0x39];
        for state in [STATE_NOT_STAGED, STATE_READY, STATE_ONLINE, STATE_OFFLINE] {
            let data = manufacturer_data(state, Some(id));
            assert_eq!(data, [vec![state], id.to_vec()].concat());
            assert_eq!(
                3 + 18 + 4 + data.len(),
                31,
                "flags + UUID + manufacturer AD"
            );
        }
        assert_eq!(
            manufacturer_data(STATE_NOT_STAGED, None),
            [STATE_NOT_STAGED]
        );
    }

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
