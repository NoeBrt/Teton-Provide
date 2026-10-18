//! BLE peripheral exposing the shared hello handler through BlueZ.
//! Harmless probe only: it accepts no credentials and changes no network state.

use bluer::adv::Advertisement;
use bluer::gatt::local::{
    Application, Characteristic, CharacteristicRead, CharacteristicWrite,
    CharacteristicWriteMethod, ReqError, Service,
};
use bluer::{Address, Uuid};
use std::sync::{Arc, Mutex};
use teton_provisioning::protocol::{self, CHARACTERISTIC_UUID, DEVICE_ID, SERVICE_UUID};
use tokio::signal::unix::{SignalKind, signal};

/// One pending response for the client that wrote last ("one request at a time").
type Pending = Mutex<Option<(Address, &'static [u8])>>;

fn write(pending: &Pending, client: Address, offset: u16, value: &[u8]) -> Result<(), ReqError> {
    let mut slot = pending.lock().unwrap();
    *slot = None;
    if offset != 0 {
        return Err(ReqError::InvalidOffset);
    }
    let response = protocol::respond(value).map_err(|_| ReqError::NotSupported)?;
    *slot = Some((client, response));
    Ok(())
}

/// Returns the pending response once, and only to the client that requested it.
fn read(pending: &Pending, client: Address, offset: u16) -> Result<Vec<u8>, ReqError> {
    if offset != 0 {
        return Err(ReqError::InvalidOffset);
    }
    let mut slot = pending.lock().unwrap();
    match *slot {
        Some((owner, response)) if owner == client => {
            *slot = None;
            Ok(response.to_vec())
        }
        _ => Ok(Vec::new()),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let session = bluer::Session::new().await?;
    let adapter = session.default_adapter().await?;
    // BlueZ 5.64 reports an rfkill soft block as a generic Busy error.
    adapter.set_powered(true).await.map_err(|error| {
        format!(
            "cannot power {} ({error}); check `rfkill list bluetooth`",
            adapter.name()
        )
    })?;

    let pending = Arc::new(Pending::new(None));
    let on_write = pending.clone();
    let app = Application {
        services: vec![Service {
            uuid: Uuid::from_u128(SERVICE_UUID),
            primary: true,
            characteristics: vec![Characteristic {
                uuid: Uuid::from_u128(CHARACTERISTIC_UUID),
                write: Some(CharacteristicWrite {
                    write: true,
                    method: CharacteristicWriteMethod::Fun(Box::new(move |value, req| {
                        let result = write(&on_write, req.device_address, req.offset, &value);
                        // Outcome only: never log the payload or the client address.
                        if result.is_err() {
                            println!("rejected request");
                        }
                        Box::pin(async move { result })
                    })),
                    ..Default::default()
                }),
                read: Some(CharacteristicRead {
                    read: true,
                    fun: Box::new(move |req| {
                        let result = read(&pending, req.device_address, req.offset);
                        if matches!(&result, Ok(response) if !response.is_empty()) {
                            println!("hello exchanged");
                        }
                        Box::pin(async move { result })
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    };
    // BlueZ drops both registrations when this process leaves the bus.
    // shortcut: an hci0 removal (USB reset) leaves the process running unregistered;
    // exit on bluer adapter-removed events if systemd must recover that case.
    let _app = adapter.serve_gatt_application(app).await?;
    let _adv = adapter
        .advertise(Advertisement {
            service_uuids: [Uuid::from_u128(SERVICE_UUID)].into(),
            discoverable: Some(true),
            local_name: Some(DEVICE_ID.to_string()),
            ..Default::default()
        })
        .await?;
    println!(
        "{DEVICE_ID} advertising on {}; accepts only hello",
        adapter.name()
    );

    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
    println!("stopping");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHONE: Address = Address::new([1, 2, 3, 4, 5, 6]);
    const OTHER: Address = Address::new([6, 5, 4, 3, 2, 1]);

    #[test]
    fn hello_then_read_returns_world_once() {
        let pending = Pending::new(None);
        assert_eq!(write(&pending, PHONE, 0, b"hello"), Ok(()));
        assert_eq!(read(&pending, PHONE, 0), Ok(b"world".to_vec()));
        assert_eq!(read(&pending, PHONE, 0), Ok(Vec::new()));
    }

    #[test]
    fn response_is_not_readable_by_another_client() {
        let pending = Pending::new(None);
        write(&pending, PHONE, 0, b"hello").unwrap();
        assert_eq!(read(&pending, OTHER, 0), Ok(Vec::new()));
        assert_eq!(read(&pending, PHONE, 0), Ok(b"world".to_vec()));
    }

    #[test]
    fn invalid_write_is_rejected_and_clears_pending_response() {
        let pending = Pending::new(None);
        write(&pending, PHONE, 0, b"hello").unwrap();
        assert_eq!(
            write(&pending, PHONE, 0, b"password=example-never-send"),
            Err(ReqError::NotSupported)
        );
        assert_eq!(read(&pending, PHONE, 0), Ok(Vec::new()));
    }

    #[test]
    fn any_write_from_another_client_clears_pending_response() {
        let pending = Pending::new(None);
        write(&pending, PHONE, 0, b"hello").unwrap();
        assert_eq!(write(&pending, OTHER, 0, b"x"), Err(ReqError::NotSupported));
        assert_eq!(read(&pending, PHONE, 0), Ok(Vec::new()));
    }

    #[test]
    fn offset_write_is_rejected_and_clears_pending_response() {
        let pending = Pending::new(None);
        write(&pending, PHONE, 0, b"hello").unwrap();
        assert_eq!(
            write(&pending, PHONE, 1, b"hello"),
            Err(ReqError::InvalidOffset)
        );
        assert_eq!(read(&pending, PHONE, 0), Ok(Vec::new()));
    }

    #[test]
    fn offset_read_is_rejected_without_consuming_response() {
        let pending = Pending::new(None);
        write(&pending, PHONE, 0, b"hello").unwrap();
        assert_eq!(read(&pending, PHONE, 1), Err(ReqError::InvalidOffset));
        assert_eq!(read(&pending, PHONE, 0), Ok(b"world".to_vec()));
    }
}
