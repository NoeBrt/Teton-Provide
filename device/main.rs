//! BLE peripheral for the Teton demo device, through BlueZ.
//!
//! - Hello characteristic: the harmless probe (write `hello`, read `world`); it never carries credentials.
//! - Provisioning characteristic (once staged with `stage`, until provisioned): Noise NKpsk2 channel that
//!   receives Wi-Fi credentials and reports the NetworkManager outcome (src/provision.rs, docs/SECURITY.md).
//!
//! State directory: `$STATE_DIRECTORY` (systemd `StateDirectory=`), else `./state`.
//! `TETON_WIFI_INTERFACE` pins the Wi-Fi device to provision (default: the first Wi-Fi device).

mod wifi;

use bluer::adv::Advertisement;
use bluer::gatt::local::{
    Application, ApplicationHandle, Characteristic, CharacteristicRead, CharacteristicWrite,
    CharacteristicWriteMethod, ReqError, Service,
};
use bluer::{Adapter, Address, Uuid};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use teton_provisioning::protocol::{self, CHARACTERISTIC_UUID, DEVICE_ID, SERVICE_UUID};
use teton_provisioning::provision::{
    Activation, FRAME_HANDSHAKE, FRAME_TRANSPORT, Identity, Outcome, PROVISION_CHARACTERISTIC_UUID,
    PROVISIONED_FILE, Provisioner, Session, hex,
};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::Notify;

/// One pending response for the client that wrote last ("one request at a time").
type Pending = Mutex<Option<(Address, &'static [u8])>>;

/// A phone that is not heard from for this long loses its session (and its claim on the device).
const IDLE: Duration = Duration::from_secs(60);
/// Time left to the phone to read a success before the provisioning characteristic goes away.
const GRACE: Duration = Duration::from_secs(20);

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

struct Peer {
    session: Session,
    reply: Option<Vec<u8>>,
    last: Instant,
}

/// Provisioning state shared by the GATT callbacks and the activation task.
struct Provisioning {
    identity: Identity,
    provisioner: Provisioner,
    peers: HashMap<Address, Peer>,
}

impl Provisioning {
    /// One Noise message from `client`. Only one phone at a time; a second one is refused, not queued.
    fn write(
        &mut self,
        client: Address,
        offset: u16,
        value: &[u8],
        now: Instant,
    ) -> Result<Option<Activation>, ReqError> {
        if offset != 0 {
            return Err(ReqError::InvalidOffset);
        }
        self.peers
            .retain(|_, peer| now.duration_since(peer.last) < IDLE);
        if self.peers.keys().any(|address| *address != client) {
            return Err(ReqError::InProgress);
        }
        let (&kind, message) = value.split_first().ok_or(ReqError::InvalidValueLength)?;
        if kind == FRAME_HANDSHAKE {
            let session = Session::new(&self.identity, DEVICE_ID).map_err(|_| ReqError::Failed)?;
            self.peers.insert(
                client,
                Peer {
                    session,
                    reply: None,
                    last: now,
                },
            );
        } else if kind != FRAME_TRANSPORT {
            return Err(ReqError::NotSupported);
        }
        let peer = self.peers.get_mut(&client).ok_or(ReqError::NotPermitted)?;
        peer.last = now;
        peer.reply = None;
        match peer.session.on_write(message, &mut self.provisioner) {
            Ok(reply) => {
                peer.reply = Some(reply);
                Ok(self.provisioner.take_activation())
            }
            Err(error) => {
                self.peers.remove(&client);
                println!("provisioning session closed: {error}");
                Err(ReqError::NotAuthorized)
            }
        }
    }

    /// The reply to the last write, once, and only to the phone that wrote it.
    fn read(&mut self, client: Address, offset: u16) -> Result<Vec<u8>, ReqError> {
        if offset != 0 {
            return Err(ReqError::InvalidOffset);
        }
        Ok(self
            .peers
            .get_mut(&client)
            .and_then(|peer| peer.reply.take())
            .unwrap_or_default())
    }
}

type Shared = Arc<Mutex<Provisioning>>;

fn describe(outcome: Outcome) -> String {
    match outcome {
        Outcome::Connected { .. } => "connected".into(),
        Outcome::Failed(failure) => format!("failed {failure:?}"),
        other => format!("{other:?}").to_lowercase(),
    }
}

struct Context {
    shared: Shared,
    state_dir: PathBuf,
    interface: Option<String>,
    provisioned: Arc<Notify>,
}

/// Runs NetworkManager off the async runtime, then records the outcome (logs: attempt ID and outcome only).
fn start(context: &Arc<Context>, activation: Activation) {
    println!("attempt {} pending", hex(&activation.attempt));
    let context = context.clone();
    tokio::task::spawn_blocking(move || {
        let outcome = wifi::activate(
            &activation.ssid,
            &activation.password,
            context.interface.as_deref(),
        );
        let attempt = activation.attempt;
        drop(activation);
        println!("attempt {} {}", hex(&attempt), describe(outcome));
        context
            .shared
            .lock()
            .unwrap()
            .provisioner
            .complete(attempt, outcome);
        if matches!(outcome, Outcome::Connected { .. }) {
            if let Err(error) = std::fs::write(context.state_dir.join(PROVISIONED_FILE), b"") {
                println!("cannot record the provisioned state: {}", error.kind());
            }
            context.provisioned.notify_one();
        }
    });
}

fn application(hello: Arc<Pending>, provisioning: Option<Arc<Context>>) -> Application {
    let on_write = hello.clone();
    let mut characteristics = vec![Characteristic {
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
                let result = read(&hello, req.device_address, req.offset);
                if matches!(&result, Ok(response) if !response.is_empty()) {
                    println!("hello exchanged");
                }
                Box::pin(async move { result })
            }),
            ..Default::default()
        }),
        ..Default::default()
    }];
    if let Some(context) = provisioning {
        let on_write = context.clone();
        characteristics.push(Characteristic {
            uuid: Uuid::from_u128(PROVISION_CHARACTERISTIC_UUID),
            write: Some(CharacteristicWrite {
                write: true,
                method: CharacteristicWriteMethod::Fun(Box::new(move |value, req| {
                    let result = on_write.shared.lock().unwrap().write(
                        req.device_address,
                        req.offset,
                        &value,
                        Instant::now(),
                    );
                    let result = result.map(|activation| {
                        if let Some(activation) = activation {
                            start(&on_write, activation);
                        }
                    });
                    Box::pin(async move { result })
                })),
                ..Default::default()
            }),
            read: Some(CharacteristicRead {
                read: true,
                fun: Box::new(move |req| {
                    let result = context
                        .shared
                        .lock()
                        .unwrap()
                        .read(req.device_address, req.offset);
                    Box::pin(async move { result })
                }),
                ..Default::default()
            }),
            ..Default::default()
        });
    }
    Application {
        services: vec![Service {
            uuid: Uuid::from_u128(SERVICE_UUID),
            primary: true,
            characteristics,
            ..Default::default()
        }],
        ..Default::default()
    }
}

async fn serve(
    adapter: &Adapter,
    hello: &Arc<Pending>,
    provisioning: Option<Arc<Context>>,
) -> bluer::Result<ApplicationHandle> {
    adapter
        .serve_gatt_application(application(hello.clone(), provisioning))
        .await
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state_dir =
        PathBuf::from(std::env::var_os("STATE_DIRECTORY").unwrap_or_else(|| "state".into()));
    let identity = Identity::load(&state_dir)
        .map_err(|error| format!("cannot read {}: {error}", state_dir.display()))?;
    let already = state_dir.join(PROVISIONED_FILE).exists();
    let provisioned = Arc::new(Notify::new());
    let context = match identity {
        Some(identity) if !already => Some(Arc::new(Context {
            shared: Arc::new(Mutex::new(Provisioning {
                identity,
                provisioner: Provisioner::new(false),
                peers: HashMap::new(),
            })),
            state_dir: state_dir.clone(),
            interface: std::env::var("TETON_WIFI_INTERFACE").ok(),
            provisioned: provisioned.clone(),
        })),
        _ => None,
    };

    let session = bluer::Session::new().await?;
    let adapter = session.default_adapter().await?;
    // BlueZ 5.64 reports an rfkill soft block as a generic Busy error.
    adapter.set_powered(true).await.map_err(|error| {
        format!(
            "cannot power {} ({error}); check `rfkill list bluetooth`",
            adapter.name()
        )
    })?;

    let hello = Arc::new(Pending::new(None));
    let mode = match (&context, already) {
        (Some(_), _) => "accepts hello and encrypted provisioning",
        (None, true) => "provisioned; accepts only hello",
        (None, false) => "not staged; accepts only hello",
    };
    // BlueZ drops both registrations when this process leaves the bus.
    // shortcut: an hci0 removal (USB reset) leaves the process running unregistered;
    // exit on bluer adapter-removed events if systemd must recover that case.
    let mut app = serve(&adapter, &hello, context).await?;
    let _adv = adapter
        .advertise(Advertisement {
            service_uuids: [Uuid::from_u128(SERVICE_UUID)].into(),
            discoverable: Some(true),
            local_name: Some(DEVICE_ID.to_string()),
            ..Default::default()
        })
        .await?;
    println!("{DEVICE_ID} advertising on {}; {mode}", adapter.name());

    let mut terminate = signal(SignalKind::terminate())?;
    let shutdown = async {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    };
    tokio::pin!(shutdown);
    tokio::select! {
        _ = &mut shutdown => {}
        _ = provisioned.notified() => {
            // Single use: once the phone had time to read the result, provisioning disappears for good.
            tokio::select! {
                _ = &mut shutdown => {}
                _ = tokio::time::sleep(GRACE) => {
                    drop(app);
                    app = serve(&adapter, &hello, None).await?;
                    println!("provisioning closed; accepts only hello");
                    shutdown.await;
                }
            }
        }
    }
    drop(app);
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

    fn provisioning() -> Provisioning {
        Provisioning {
            identity: Identity::generate().unwrap(),
            provisioner: Provisioner::new(false),
            peers: HashMap::new(),
        }
    }

    /// A first handshake message as a real phone would send it.
    fn handshake(identity: &Identity) -> Vec<u8> {
        let prologue = teton_provisioning::provision::prologue(DEVICE_ID);
        let mut phone =
            snow::Builder::new(teton_provisioning::provision::NOISE_PARAMS.parse().unwrap())
                .remote_public_key(&identity.public_key)
                .and_then(|b| b.psk(2, &identity.secret))
                .and_then(|b| b.prologue(&prologue))
                .and_then(|b| b.build_initiator())
                .unwrap();
        let mut out = [0u8; 128];
        let len = phone.write_message(&[], &mut out).unwrap();
        [&[FRAME_HANDSHAKE][..], &out[..len]].concat()
    }

    #[test]
    fn handshake_reply_goes_once_to_the_phone_that_wrote() {
        let mut p = provisioning();
        let now = Instant::now();
        let first = handshake(&p.identity);
        assert!(matches!(p.write(PHONE, 0, &first, now), Ok(None)));
        assert_eq!(p.read(OTHER, 0), Ok(Vec::new()));
        assert_eq!(
            p.read(PHONE, 0).unwrap().len(),
            48,
            "e + empty encrypted payload"
        );
        assert_eq!(p.read(PHONE, 0), Ok(Vec::new()), "read once");
    }

    #[test]
    fn a_second_phone_is_refused_until_the_first_goes_idle() {
        let mut p = provisioning();
        let now = Instant::now();
        let first = handshake(&p.identity);
        p.write(PHONE, 0, &first, now).unwrap();
        assert!(matches!(
            p.write(OTHER, 0, &first, now),
            Err(ReqError::InProgress)
        ));
        assert!(
            matches!(p.write(OTHER, 0, &first, now + IDLE), Ok(None)),
            "idle session dropped"
        );
    }

    #[test]
    fn bad_frames_close_the_session() {
        let mut p = provisioning();
        let now = Instant::now();
        assert!(
            matches!(
                p.write(PHONE, 0, &[FRAME_TRANSPORT, 1, 2, 3], now),
                Err(ReqError::NotPermitted)
            ),
            "no session yet"
        );
        assert!(matches!(
            p.write(PHONE, 0, &[], now),
            Err(ReqError::InvalidValueLength)
        ));
        assert!(matches!(
            p.write(PHONE, 0, &[9, 1], now),
            Err(ReqError::NotSupported)
        ));
        assert!(matches!(
            p.write(PHONE, 0, &[FRAME_HANDSHAKE, 1, 2, 3], now),
            Err(ReqError::NotAuthorized)
        ));
        assert!(
            p.peers.is_empty(),
            "a failed handshake leaves no claim on the device"
        );
        assert!(matches!(
            p.write(PHONE, 3, &[FRAME_HANDSHAKE], now),
            Err(ReqError::InvalidOffset)
        ));
    }
}
