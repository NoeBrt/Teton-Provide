//! BLE peripheral for a Teton sensor, through BlueZ.
//!
//! - Hello characteristic: the harmless probe (write `hello`, read `world`); it never carries credentials.
//! - Provisioning characteristic (once staged and certified): Noise XX channel in which the sensor proves it is
//!   genuine with its certificate, the phone proves it belongs to an authorized technician with its token, and
//!   the sensor then receives Wi-Fi credentials and reports the NetworkManager outcome (src/provision.rs,
//!   docs/SECURITY.md). It stays open: a technician may reconfigure a provisioned sensor.
//!
//! Primary manufacturer data carries state then five key-derived identity bytes; the scan-response name is diagnostic.
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use teton_provisioning::authority::{checked_now, device_id, device_id_bytes};
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
/// The latest time this sensor recorded (Unix seconds, decimal): a clock stepped back never goes before it, and a
/// clock stepped forward (a spoofed NTP answer) moves it no faster than the uptime, so it cannot lock codes out.
/// ponytail: after a long power-off the floor trails real time by the downtime, and each start may run FLOOR_STEP
/// ahead; a signed time source (Roughtime) if either matters.
const CLOCK_FLOOR_FILE: &str = "clock-floor";
/// The floor is rewritten only once the clock passed it by this much, to spare the flash.
const FLOOR_STEP: u64 = 3600;

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
                // Who set up, or why a code was refused (a replay shows as such): the code's name (escaped), never its
                // bytes or keys.
                if let Some(error) = peer.session.refused() {
                    println!("technician code refused: {error}");
                }
                if !peer.proven
                    && let Some(name) = peer.session.technician()
                {
                    println!("technician {name:?} accepted");
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

/// The current time for token expiry, never before `floor`: the firmware date (a new sensor's clock may be unset)
/// or the latest recorded time, whichever is later.
fn clock(floor: u64) -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    checked_now(now, floor)
}

/// The clock floor at startup: the recorded one, never before the firmware date (which also stands in for a missing
/// or unreadable file).
fn initial_floor(state_dir: &Path) -> u64 {
    std::fs::read_to_string(state_dir.join(CLOCK_FLOOR_FILE))
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
        .max(FIRMWARE_BUILT)
}

/// The floor to record, once the clock is at least FLOOR_STEP past the current one: the clock, but never beyond the
/// startup floor plus the uptime (`start`, `uptime`, seconds) and one step.
fn next_floor(now: u64, floor: u64, start: u64, uptime: u64) -> Option<u64> {
    let now = now.min(start.saturating_add(uptime).saturating_add(FLOOR_STEP));
    (now.saturating_sub(floor) >= FLOOR_STEP).then_some(now)
}

/// The working profile at startup, and whether the marker named it. An unreadable marker gives `false`: the active
/// profile (`active`) stands in and no profile may be deleted.
fn startup_profile(
    state_dir: &Path,
    active: impl Fn(&str) -> bool,
) -> (Option<&'static str>, bool) {
    match current_profile(state_dir) {
        Ok(current) => (current, true),
        // The active profile stands in, so the next attempt uses the other one and a failure brings this one back.
        Err(_) => {
            println!("provisioned marker unreadable; leaving Wi-Fi profiles alone");
            (wifi::PROFILE_UUIDS.into_iter().find(|p| active(p)), false)
        }
    }
}

/// The working profile from the provisioned marker: `Ok(None)` when absent, the first profile for an empty marker
/// (earlier versions). Any other content, or a failed read, is an error: the caller then deletes no profile.
fn current_profile(state_dir: &Path) -> std::io::Result<Option<&'static str>> {
    let content = match std::fs::read_to_string(state_dir.join(PROVISIONED_FILE)) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    match content.trim() {
        "" => Ok(Some(wifi::PROFILE_UUIDS[0])),
        content => wifi::PROFILE_UUIDS
            .into_iter()
            .find(|uuid| *uuid == content)
            .map(Some)
            .ok_or_else(|| std::io::Error::other("unknown profile")),
    }
}

/// Writes a state file durably: to a temporary file, synced, renamed, and the directory synced, so a power cut
/// leaves either the old content or the new one. An error means the file still holds the old content: once the
/// rename is done, a failed directory sync is only logged (the next start reads whichever name survived).
fn persist(state_dir: &Path, name: &str, content: &str) -> std::io::Result<()> {
    let temporary = state_dir.join(format!("{name}.new"));
    std::fs::write(&temporary, content)?;
    std::fs::File::open(&temporary)?.sync_all()?;
    std::fs::rename(&temporary, state_dir.join(name))?;
    if let Err(error) = std::fs::File::open(state_dir).and_then(|dir| dir.sync_all()) {
        println!("{name} recorded, directory not synced: {}", error.kind());
    }
    Ok(())
}

struct Context {
    shared: Shared,
    state_dir: PathBuf,
    interface: Option<String>,
    /// The profile of the working network, if any.
    current: Mutex<Option<&'static str>>,
    /// Token expiry never goes before this: the firmware date or the recorded clock floor.
    floor: AtomicU64,
    /// The floor at startup, and when: the floor never rises faster than the uptime.
    started: (u64, Instant),
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
            match persist(&context.state_dir, PROVISIONED_FILE, profile) {
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

/// Records the clock as the new floor once it moved FLOOR_STEP past it, as far as the uptime allows.
fn raise_floor(context: &Context) {
    let floor = context.floor.load(Ordering::Relaxed);
    let (start, since) = context.started;
    if let Some(next) = next_floor(clock(floor), floor, start, since.elapsed().as_secs()) {
        match persist(&context.state_dir, CLOCK_FLOOR_FILE, &next.to_string()) {
            Ok(()) => context.floor.store(next, Ordering::Relaxed),
            Err(error) => println!("cannot record the clock floor: {}", error.kind()),
        }
    }
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

fn advertisement(state: u8, name: &str, id: Option<[u8; 5]>) -> Advertisement {
    Advertisement {
        service_uuids: [Uuid::from_u128(SERVICE_UUID)].into(),
        manufacturer_data: [(STATE_COMPANY_ID, protocol::manufacturer_data(state, id))].into(),
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
                    let starts = value.first() == Some(&FRAME_HANDSHAKE);
                    let result = on_write.shared.lock().unwrap().write(
                        req.device_address,
                        req.offset,
                        &value,
                        Instant::now(),
                        clock(on_write.floor.load(Ordering::Relaxed)),
                    );
                    // The negotiated MTU, for hardware runs; nothing else about the link.
                    if starts && result.is_ok() {
                        println!("provisioning session started (mtu {})", req.mtu);
                    }
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
    let keys = KeyPair::load(&state_dir).map_err(unreadable)?;
    let public_key = identity
        .as_ref()
        .map(|identity| &identity.keys.public_key)
        .or_else(|| keys.as_ref().map(|keys| &keys.public_key));
    let name = public_key
        .map(device_id)
        .unwrap_or_else(|| "TETON-UNSTAGED".to_string());
    let id = public_key.map(device_id_bytes);
    let (current, known) = startup_profile(&state_dir, wifi::profile_active);
    let staged = identity.is_some();
    let changed = Arc::new(Notify::new());
    let floor = initial_floor(&state_dir);
    let context = identity.map(|identity| {
        Arc::new(Context {
            shared: Arc::new(Mutex::new(Provisioning {
                identity,
                provisioner: Provisioner::default(),
                peers: HashMap::new(),
            })),
            state_dir: state_dir.clone(),
            interface: std::env::var("TETON_WIFI_INTERFACE").ok(),
            current: Mutex::new(current),
            floor: AtomicU64::new(floor),
            started: (floor, Instant::now()),
            changed: changed.clone(),
        })
    });
    // Only the working profile may autoconnect; one left by an attempt that never recorded success goes.
    if known && context.is_some() && wifi::forget_except(current).is_err() {
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
    let mut adv: AdvertisementHandle = adapter.advertise(advertisement(state, &name, id)).await?;
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
    // an attempt, and every STATE_REFRESH in case the network drops; that tick also records the clock floor.
    let mut refresh = tokio::time::interval(STATE_REFRESH);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            _ = refresh.tick() => {
                if let Some(context) = &context {
                    let context = context.clone();
                    tokio::task::spawn_blocking(move || raise_floor(&context)); // fsyncs: off the GATT runtime
                }
            }
            _ = changed.notified() => {}
        }
        let profile = working();
        let next = sensor_state(staged, profile.is_some(), online(profile).await);
        if next != state {
            drop(adv);
            adv = adapter.advertise(advertisement(next, &name, id)).await?;
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
            provisioner: Provisioner::default(),
            peers: HashMap::new(),
        }
    }

    /// The holder private key of the test phone's technician code.
    const HOLDER: [u8; 32] = [3; 32];

    fn token(customer: &str) -> Vec<u8> {
        let holder = curve25519_dalek::MontgomeryPoint::mul_base_clamped(HOLDER).to_bytes();
        TechnicianToken::issue(
            &technicians(),
            "Noé",
            &[customer.to_string()],
            CLOCK + 3600,
            holder,
        )
        .unwrap()
        .encode()
    }

    /// A first handshake message as a real phone would send it, and the phone's handshake state.
    fn first_message() -> (snow::HandshakeState, Vec<u8>) {
        let mut phone = snow::Builder::new(NOISE_PARAMS.parse().unwrap())
            .local_private_key(&HOLDER)
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
        let adv = advertisement(
            STATE_ONLINE,
            "TETON-3F9A2C81D4",
            Some([0x3f, 0x9a, 0x2c, 0x81, 0xd4]),
        );
        assert_eq!(
            adv.manufacturer_data.get(&STATE_COMPANY_ID),
            Some(&vec![STATE_ONLINE, 0x3f, 0x9a, 0x2c, 0x81, 0xd4])
        );
        assert!(adv.service_uuids.contains(&Uuid::from_u128(SERVICE_UUID)));
        assert_eq!(adv.local_name.as_deref(), Some("TETON-3F9A2C81D4"));
        assert_eq!(adv.service_uuids.len(), 1);
        assert_eq!(adv.manufacturer_data.len(), 1);
        assert_eq!(adv.discoverable, Some(true));
        assert!(adv.service_data.is_empty());
        assert!(adv.system_includes.is_empty());
        assert!(adv.solicit_uuids.is_empty());
        assert!(adv.advertising_data.is_empty());
        assert!(adv.appearance.is_none());
        assert!(adv.secondary_channel.is_none());
        assert!(adv.min_interval.is_none() && adv.max_interval.is_none());
    }

    #[test]
    fn the_working_profile_is_recorded_durably_and_read_back() {
        let dir = std::env::temp_dir().join(format!("teton-persist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let [first, second] = wifi::PROFILE_UUIDS;
        assert_eq!(current_profile(&dir).unwrap(), None, "never provisioned");
        persist(&dir, PROVISIONED_FILE, second).unwrap();
        assert_eq!(current_profile(&dir).unwrap(), Some(second));
        std::fs::write(dir.join(PROVISIONED_FILE), b"").unwrap();
        assert_eq!(
            current_profile(&dir).unwrap(),
            Some(first),
            "earlier versions wrote an empty marker"
        );
        for garbled in [&b"4a7db77c-6fda"[..], &[0xff, 0xfe][..]] {
            std::fs::write(dir.join(PROVISIONED_FILE), garbled).unwrap();
            assert!(
                current_profile(&dir).is_err(),
                "an unreadable marker leaves the profiles alone"
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            persist(&dir, PROVISIONED_FILE, first).is_err(),
            "a missing state directory fails instead of passing silently"
        );
    }

    #[test]
    fn a_garbled_marker_leaves_the_profiles_alone() {
        let dir = std::env::temp_dir().join(format!("teton-startup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let [_, second] = wifi::PROFILE_UUIDS;
        let active = |p: &str| p == second;
        assert_eq!(
            startup_profile(&dir, active),
            (None, true),
            "never provisioned"
        );
        std::fs::write(dir.join(PROVISIONED_FILE), b"4a7db77c-6fda").unwrap();
        assert_eq!(
            startup_profile(&dir, active),
            (Some(second), false),
            "the active profile stands in; known is false, so forget_except is skipped"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_floor_never_starts_before_the_firmware_date() {
        let dir = std::env::temp_dir().join(format!("teton-floor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(initial_floor(&dir), FIRMWARE_BUILT, "no floor recorded yet");
        for (recorded, floor) in [
            ("junk", FIRMWARE_BUILT),
            ("1000", FIRMWARE_BUILT),
            ("1900000000\n", 1_900_000_000),
        ] {
            persist(&dir, CLOCK_FLOOR_FILE, recorded).unwrap();
            assert_eq!(initial_floor(&dir), floor, "{recorded:?}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_clock_floor_rises_by_the_hour_and_never_falls() {
        assert_eq!(
            next_floor(CLOCK + FLOOR_STEP - 1, CLOCK, CLOCK, 0),
            None,
            "spares the flash"
        );
        assert_eq!(
            next_floor(CLOCK + FLOOR_STEP, CLOCK, CLOCK, 0),
            Some(CLOCK + FLOOR_STEP)
        );
        assert_eq!(
            next_floor(CLOCK - 86_400, CLOCK, CLOCK, 0),
            None,
            "a clock stepped back"
        );
        assert_eq!(next_floor(u64::MAX, u64::MAX, u64::MAX, u64::MAX), None);
        // A clock stepped years ahead (one spoofed NTP answer): the floor follows the uptime, not the clock.
        let ahead = CLOCK + 10 * 365 * 86_400;
        assert_eq!(
            next_floor(ahead, CLOCK, CLOCK, 60),
            Some(CLOCK + 60 + FLOOR_STEP),
            "at most the startup floor, the uptime and one step"
        );
        assert_eq!(next_floor(ahead, CLOCK + 60 + FLOOR_STEP, CLOCK, 120), None);
        assert_eq!(
            next_floor(ahead, CLOCK + 60 + FLOOR_STEP, CLOCK, 60 + FLOOR_STEP),
            Some(CLOCK + 60 + 2 * FLOOR_STEP)
        );
        assert_eq!(
            clock(u64::MAX),
            u64::MAX,
            "the floor holds over the system clock"
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
