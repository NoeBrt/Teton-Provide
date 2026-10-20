//! BLE peripheral for a Teton sensor, through BlueZ.
//!
//! - Hello characteristic: the harmless probe (write `hello`, read `world`); it never carries credentials.
//! - Provisioning characteristic (once staged and certified): Noise XX channel in which the sensor proves it is
//!   genuine with its certificate, the phone proves it belongs to an authorized technician with its token, and
//!   the sensor then receives Wi-Fi credentials and reports the NetworkManager outcome (src/provision.rs,
//!   docs/SECURITY.md). It stays open: a technician may reconfigure a provisioned sensor.
//!
//! The advertised name is the sensor's ID, derived from its key; one byte of manufacturer data tells its state.
//! State directory: `$STATE_DIRECTORY` (systemd `StateDirectory=`), else `./state`.
//! `TETON_WIFI_INTERFACE` pins the Wi-Fi device to provision (default: the first Wi-Fi device).

mod wifi;

use bluer::adv::{Advertisement, AdvertisementHandle};
use bluer::gatt::local::{
    Application, ApplicationHandle, Characteristic, CharacteristicRead, CharacteristicWrite,
    CharacteristicWriteMethod, ReqError, Service,
};
use bluer::{Adapter, Address, Uuid};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use teton_provisioning::authority::{checked_now, device_id};
use teton_provisioning::protocol::{
    self, CHARACTERISTIC_UUID, SERVICE_UUID, STATE_COMPANY_ID, STATE_NOT_STAGED, STATE_OFFLINE,
    STATE_ONLINE, STATE_READY,
};
use teton_provisioning::provision::{
    Activation, FRAME_HANDSHAKE, FRAME_TRANSPORT, Failure, Identity, KeyPair, Outcome,
    PROVISION_CHARACTERISTIC_UUID, PROVISIONED_FILE, Provisioner, Session, hex,
};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::Notify;

/// One pending response for the client that wrote last ("one request at a time").
type Pending = Mutex<Option<(Address, &'static [u8])>>;

/// A phone that is not heard from for this long loses its session (and its claim on the device).
const IDLE: Duration = Duration::from_secs(60);
/// How often a provisioned sensor checks its Wi-Fi profile, to keep its advertised state current.
const STATE_REFRESH: Duration = Duration::from_secs(30);
/// The firmware's build date (Unix seconds): technician tokens are never checked against an earlier clock.
/// ponytail: set by hand at release; derive it from SOURCE_DATE_EPOCH in a release pipeline.
const FIRMWARE_BUILT: u64 = 1_792_454_400; // 2026-10-20

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
    /// Its technician token was accepted.
    proven: bool,
}

/// Provisioning state shared by the GATT callbacks and the activation task.
struct Provisioning {
    identity: Identity,
    provisioner: Provisioner,
    peers: HashMap<Address, Peer>,
}

impl Provisioning {
    /// One Noise message from `client`. Only one phone at a time; a second one is refused, not queued.
    /// The claim starts when the sensor accepts a phone's technician token, not at the first message, which
    /// anyone can send or replay. `clock` is the current time for token expiry (Unix seconds, floored).
    fn write(
        &mut self,
        client: Address,
        offset: u16,
        value: &[u8],
        now: Instant,
        clock: u64,
    ) -> Result<Option<Activation>, ReqError> {
        if offset != 0 {
            return Err(ReqError::InvalidOffset);
        }
        // ponytail: unproven sessions are bounded only by BLE links and IDLE; cap them if a controller allows many links.
        self.peers
            .retain(|_, peer| now.duration_since(peer.last) < IDLE);
        if self
            .peers
            .iter()
            .any(|(address, peer)| *address != client && peer.proven)
        {
            return Err(ReqError::InProgress);
        }
        let (&kind, message) = value.split_first().ok_or(ReqError::InvalidValueLength)?;
        if kind == FRAME_HANDSHAKE {
            let session = Session::new(&self.identity, clock).map_err(|_| ReqError::Failed)?;
            self.peers.insert(
                client,
                Peer {
                    session,
                    reply: None,
                    last: now,
                    proven: false,
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
                if !peer.proven && peer.session.technician().is_some() {
                    peer.proven = true;
                    self.peers.retain(|address, _| *address == client);
                }
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

/// The current time for token expiry, never before the firmware date (a new sensor's clock may be unset).
fn clock() -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    checked_now(now, FIRMWARE_BUILT)
}

/// The working profile from the provisioned marker; an empty marker (earlier versions) means the first profile.
fn current_profile(state_dir: &Path) -> Option<&'static str> {
    let content = std::fs::read_to_string(state_dir.join(PROVISIONED_FILE)).ok()?;
    let content = content.trim();
    Some(
        wifi::PROFILE_UUIDS
            .into_iter()
            .find(|uuid| *uuid == content)
            .unwrap_or(wifi::PROFILE_UUIDS[0]),
    )
}

/// Records the working profile durably: written to a temporary file, synced, renamed, and the directory synced,
/// so a power cut leaves either the old marker or the new one.
fn persist(state_dir: &Path, profile: &str) -> std::io::Result<()> {
    let temporary = state_dir.join(format!("{PROVISIONED_FILE}.new"));
    std::fs::write(&temporary, profile)?;
    std::fs::File::open(&temporary)?.sync_all()?;
    std::fs::rename(&temporary, state_dir.join(PROVISIONED_FILE))?;
    std::fs::File::open(state_dir)?.sync_all()
}

struct Context {
    shared: Shared,
    state_dir: PathBuf,
    interface: Option<String>,
    /// The profile of the working network, if any.
    current: Mutex<Option<&'static str>>,
    /// Woken after each attempt, so the advertised state follows at once.
    changed: Arc<Notify>,
}

/// Runs NetworkManager off the async runtime, then records the outcome (logs: attempt ID and outcome only).
fn start(context: &Arc<Context>, activation: Activation) {
    println!("attempt {} pending", hex(&activation.attempt));
    let context = context.clone();
    tokio::task::spawn_blocking(move || {
        let current = *context.current.lock().unwrap();
        let interface = context.interface.as_deref();
        let (mut outcome, profile) =
            wifi::activate(&activation.ssid, &activation.password, interface, current);
        let attempt = activation.attempt;
        drop(activation);
        // Success counts only once it survives a restart; otherwise undo it and keep the previous network.
        if matches!(outcome, Outcome::Connected { .. }) {
            match persist(&context.state_dir, profile) {
                Ok(()) => {
                    *context.current.lock().unwrap() = Some(profile);
                    if current.is_some() && wifi::forget_except(Some(profile)).is_err() {
                        println!("previous profile could not be deleted");
                    }
                }
                Err(error) => {
                    println!("cannot record the provisioned state: {}", error.kind());
                    wifi::roll_back(profile, current, interface);
                    outcome = Outcome::Failed(Failure::NmcliError);
                }
            }
        }
        println!("attempt {} {}", hex(&attempt), describe(outcome));
        context
            .shared
            .lock()
            .unwrap()
            .provisioner
            .complete(attempt, outcome);
        context.changed.notify_one();
    });
}

/// The advertised state byte (`protocol::STATE_*`).
fn sensor_state(staged: bool, provisioned: bool, online: bool) -> u8 {
    match (staged, provisioned, online) {
        (false, _, _) => STATE_NOT_STAGED,
        (true, false, _) => STATE_READY,
        (true, true, true) => STATE_ONLINE,
        (true, true, false) => STATE_OFFLINE,
    }
}

fn advertisement(state: u8, name: &str) -> Advertisement {
    Advertisement {
        service_uuids: [Uuid::from_u128(SERVICE_UUID)].into(),
        manufacturer_data: [(STATE_COMPANY_ID, vec![state])].into(),
        discoverable: Some(true),
        local_name: Some(name.to_string()),
        ..Default::default()
    }
}

/// Whether `profile` is up, checked off the async runtime.
async fn online(profile: Option<&'static str>) -> bool {
    match profile {
        Some(profile) => tokio::task::spawn_blocking(move || wifi::profile_active(profile))
            .await
            .unwrap_or(false),
        None => false,
    }
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
                        clock(),
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
    let unreadable =
        |error: std::io::Error| format!("cannot read {}: {error}", state_dir.display());
    let identity = Identity::load(&state_dir).map_err(unreadable)?;
    let name = match (&identity, KeyPair::load(&state_dir).map_err(unreadable)?) {
        (Some(identity), _) => identity.device_id(),
        (None, Some(keys)) => device_id(&keys.public_key), // keyed, waiting for its certificate
        (None, None) => "TETON-UNSTAGED".to_string(),
    };
    let current = current_profile(&state_dir);
    let staged = identity.is_some();
    let changed = Arc::new(Notify::new());
    let context = identity.map(|identity| {
        Arc::new(Context {
            shared: Arc::new(Mutex::new(Provisioning {
                identity,
                provisioner: Provisioner::new(current.is_some()),
                peers: HashMap::new(),
            })),
            state_dir: state_dir.clone(),
            interface: std::env::var("TETON_WIFI_INTERFACE").ok(),
            current: Mutex::new(current),
            changed: changed.clone(),
        })
    });
    // Only the working profile may autoconnect; one left by an attempt that never recorded success goes.
    if context.is_some() && wifi::forget_except(current).is_err() {
        println!("cannot check NetworkManager for a leftover profile");
    }

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
    let mode = if staged {
        "accepts hello and encrypted provisioning"
    } else {
        "not staged; accepts only hello"
    };
    // BlueZ drops both registrations when this process leaves the bus.
    // shortcut: an hci0 removal (USB reset) leaves the process running unregistered;
    // exit on bluer adapter-removed events if systemd must recover that case.
    let app = serve(&adapter, &hello, context.clone()).await?;
    let working = || {
        context
            .as_ref()
            .and_then(|context| *context.current.lock().unwrap())
    };
    let mut state = sensor_state(staged, current.is_some(), online(current).await);
    let mut adv: AdvertisementHandle = adapter.advertise(advertisement(state, &name)).await?;
    println!("{name} advertising on {}; {mode}", adapter.name());

    let mut terminate = signal(SignalKind::terminate())?;
    let shutdown = async {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    };
    tokio::pin!(shutdown);
    // The advertised state follows the Wi-Fi profile, so a technician sees it on the sensor's card: at once after
    // an attempt, and every STATE_REFRESH in case the network drops.
    let mut refresh = tokio::time::interval(STATE_REFRESH);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            _ = refresh.tick() => {}
            _ = changed.notified() => {}
        }
        let profile = working();
        let next = sensor_state(staged, profile.is_some(), online(profile).await);
        if next != state {
            drop(adv);
            adv = adapter.advertise(advertisement(next, &name)).await?;
            state = next;
            println!(
                "advertised state: {}",
                match next {
                    STATE_ONLINE => "online",
                    STATE_OFFLINE => "Wi-Fi not connected",
                    _ => "ready",
                }
            );
        }
    }
    drop((app, adv));
    println!("stopping");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use teton_provisioning::authority::{DeviceCertificate, TechnicianToken};
    use teton_provisioning::provision::{NOISE_PARAMS, PROLOGUE, TOKEN_ACCEPTED, TOKEN_REFUSED};

    const PHONE: Address = Address::new([1, 2, 3, 4, 5, 6]);
    const OTHER: Address = Address::new([6, 5, 4, 3, 2, 1]);
    const CLOCK: u64 = 1_800_000_000;

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

    fn technicians() -> SigningKey {
        SigningKey::from_bytes(&[2; 32])
    }

    fn provisioning() -> Provisioning {
        let keys = KeyPair::generate().unwrap();
        let certificate =
            DeviceCertificate::sign(&SigningKey::from_bytes(&[1; 32]), keys.public_key, "DEMO")
                .unwrap();
        let identity = Identity {
            keys,
            certificate,
            technician_authority: technicians().verifying_key().to_bytes(),
        };
        Provisioning {
            identity,
            provisioner: Provisioner::new(false),
            peers: HashMap::new(),
        }
    }

    fn token(customer: &str) -> Vec<u8> {
        TechnicianToken::issue(&technicians(), "Noé", &[customer.to_string()], CLOCK + 3600)
            .unwrap()
            .encode()
    }

    /// A first handshake message as a real phone would send it, and the phone's handshake state.
    fn first_message() -> (snow::HandshakeState, Vec<u8>) {
        let keys = KeyPair::generate().unwrap();
        let mut phone = snow::Builder::new(NOISE_PARAMS.parse().unwrap())
            .local_private_key(&keys.private_key)
            .and_then(|b| b.prologue(PROLOGUE))
            .and_then(|b| b.build_initiator())
            .unwrap();
        let mut out = [0u8; 128];
        let len = phone.write_message(&[], &mut out).unwrap();
        (phone, [&[FRAME_HANDSHAKE][..], &out[..len]].concat())
    }

    /// Full handshake with a token for `customer`; returns the device's answer to the token.
    fn present_token(
        p: &mut Provisioning,
        client: Address,
        now: Instant,
        customer: &str,
    ) -> Vec<u8> {
        let (mut phone, first) = first_message();
        p.write(client, 0, &first, now, CLOCK).unwrap();
        let mut buffer = [0u8; 512];
        phone
            .read_message(&p.read(client, 0).unwrap(), &mut buffer)
            .unwrap();
        let len = phone.write_message(&token(customer), &mut buffer).unwrap();
        let third = [&[FRAME_TRANSPORT][..], &buffer[..len]].concat();
        assert!(matches!(p.write(client, 0, &third, now, CLOCK), Ok(None)));
        let mut phone = phone.into_transport_mode().unwrap();
        let len = phone
            .read_message(&p.read(client, 0).unwrap(), &mut buffer)
            .unwrap();
        buffer[..len].to_vec()
    }

    #[test]
    fn handshake_reply_goes_once_to_the_phone_that_wrote() {
        let mut p = provisioning();
        let now = Instant::now();
        let (_, first) = first_message();
        assert!(matches!(p.write(PHONE, 0, &first, now, CLOCK), Ok(None)));
        assert_eq!(p.read(OTHER, 0), Ok(Vec::new()));
        let certificate_len = p.identity.certificate.encode().len();
        assert_eq!(
            p.read(PHONE, 0).unwrap().len(),
            32 + 48 + certificate_len + 16,
            "e, s, encrypted certificate"
        );
        assert_eq!(p.read(PHONE, 0), Ok(Vec::new()), "read once");
    }

    #[test]
    fn a_second_phone_is_refused_once_the_first_presented_a_valid_token() {
        let mut p = provisioning();
        let now = Instant::now();
        assert_eq!(present_token(&mut p, PHONE, now, "DEMO"), [TOKEN_ACCEPTED]);
        let (_, first) = first_message();
        assert!(matches!(
            p.write(OTHER, 0, &first, now, CLOCK),
            Err(ReqError::InProgress)
        ));
        assert!(
            matches!(p.write(OTHER, 0, &first, now + IDLE, CLOCK), Ok(None)),
            "idle session dropped"
        );
    }

    #[test]
    fn a_replayed_first_message_or_a_refused_token_does_not_lock_out_the_real_phone() {
        let mut p = provisioning();
        let now = Instant::now();
        // The first message needs no credential: anyone can send (or replay) one.
        let (_, replayed) = first_message();
        assert!(matches!(p.write(OTHER, 0, &replayed, now, CLOCK), Ok(None)));
        let refused = present_token(&mut p, OTHER, now, "ANOTHER-CUSTOMER");
        assert_eq!(refused[0], TOKEN_REFUSED);
        assert_eq!(present_token(&mut p, PHONE, now, "DEMO"), [TOKEN_ACCEPTED]);
        assert!(
            !p.peers.contains_key(&OTHER),
            "unproven sessions are dropped once a phone is accepted"
        );
    }

    #[test]
    fn the_advertised_state_tells_a_technician_what_to_expect() {
        assert_eq!(sensor_state(false, false, false), STATE_NOT_STAGED);
        assert_eq!(
            sensor_state(false, true, true),
            STATE_NOT_STAGED,
            "no certificate: nothing to set up"
        );
        assert_eq!(sensor_state(true, false, false), STATE_READY);
        assert_eq!(sensor_state(true, true, true), STATE_ONLINE);
        assert_eq!(sensor_state(true, true, false), STATE_OFFLINE);
    }

    #[test]
    fn the_state_rides_in_manufacturer_data_beside_the_service_and_the_sensor_id() {
        let adv = advertisement(STATE_ONLINE, "TETON-3F9A2C81D4");
        assert_eq!(
            adv.manufacturer_data.get(&STATE_COMPANY_ID),
            Some(&vec![STATE_ONLINE])
        );
        assert!(adv.service_uuids.contains(&Uuid::from_u128(SERVICE_UUID)));
        assert_eq!(adv.local_name.as_deref(), Some("TETON-3F9A2C81D4"));
    }

    #[test]
    fn the_working_profile_is_recorded_durably_and_read_back() {
        let dir = std::env::temp_dir().join(format!("teton-persist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(current_profile(&dir), None, "never provisioned");
        persist(&dir, wifi::PROFILE_UUIDS[1]).unwrap();
        assert_eq!(current_profile(&dir), Some(wifi::PROFILE_UUIDS[1]));
        std::fs::write(dir.join(PROVISIONED_FILE), b"").unwrap();
        assert_eq!(
            current_profile(&dir),
            Some(wifi::PROFILE_UUIDS[0]),
            "earlier versions wrote an empty marker"
        );
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            persist(&dir, wifi::PROFILE_UUIDS[0]).is_err(),
            "a missing state directory fails instead of passing silently"
        );
    }

    #[test]
    fn bad_frames_close_the_session() {
        let mut p = provisioning();
        let now = Instant::now();
        assert!(
            matches!(
                p.write(PHONE, 0, &[FRAME_TRANSPORT, 1, 2, 3], now, CLOCK),
                Err(ReqError::NotPermitted)
            ),
            "no session yet"
        );
        assert!(matches!(
            p.write(PHONE, 0, &[], now, CLOCK),
            Err(ReqError::InvalidValueLength)
        ));
        assert!(matches!(
            p.write(PHONE, 0, &[9, 1], now, CLOCK),
            Err(ReqError::NotSupported)
        ));
        assert!(matches!(
            p.write(PHONE, 0, &[FRAME_HANDSHAKE, 1, 2, 3], now, CLOCK),
            Err(ReqError::NotAuthorized)
        ));
        assert!(
            p.peers.is_empty(),
            "a failed handshake leaves no claim on the device"
        );
        assert!(matches!(
            p.write(PHONE, 3, &[FRAME_HANDSHAKE], now, CLOCK),
            Err(ReqError::InvalidOffset)
        ));
    }
}
