// Bluetooth bridge: the calls App.tsx makes on react-native-ble-manager, over btleplug (CoreBluetooth on macOS, WinRT
// on Windows, BlueZ on Linux). Protocol logic stays in TypeScript; this only moves bytes and reports advertisements.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use btleplug::api::{
    Central, CentralEvent, CentralState, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager as _, State};
use tokio::sync::{Mutex, OnceCell};
use uuid::Uuid;

const REPORT_EVERY: Duration = Duration::from_millis(250);
/// The only service the page may scan for, read or write (configurator/src/probe.ts SERVICE_UUID): a script in the
/// page cannot reach any other Bluetooth device's data through this bridge.
const TETON_SERVICE: Uuid = Uuid::from_u128(0x3b0a90ce_9564_40d1_b96b_14cf8858aba3);

#[derive(Default)]
pub struct Ble {
    adapter: OnceCell<Adapter>,
    /// Peripherals heard so far, by the id the app uses (CoreBluetooth's UUID, or the address elsewhere).
    known: Mutex<HashMap<String, Peripheral>>,
    /// A scan round's timer only stops its own round.
    round: AtomicU64,
}

/// One advertisement, in the shape `ble.web.ts` turns into a react-native-ble-manager `Peripheral`.
#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Heard {
    pub id: String,
    /// The system's name for it (on macOS a cache of the device's GATT name): what the app falls back on when no
    /// packet carried the advertised name.
    pub name: Option<String>,
    /// The name the sensor advertised (its scan response), preferred by the app.
    pub advertised: Option<String>,
    pub rssi: Option<i16>,
    /// Company ID as four lowercase hex digits, as react-native-ble-manager keys it (`ffff`).
    pub manufacturer: HashMap<String, Vec<u8>>,
}

pub fn heard(
    id: String,
    name: Option<String>,
    advertised: Option<String>,
    rssi: Option<i16>,
    data: &HashMap<u16, Vec<u8>>,
) -> Heard {
    let manufacturer = data
        .iter()
        .map(|(company, bytes)| (format!("{company:04x}"), bytes.clone()))
        .collect();
    Heard {
        id,
        name,
        advertised,
        rssi,
        manufacturer,
    }
}

fn state_name(state: CentralState) -> &'static str {
    match state {
        CentralState::PoweredOn => "on",
        CentralState::PoweredOff => "off",
        CentralState::Unknown => "unknown",
    }
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

async fn adapter<'a>(ble: &'a Ble, app: &AppHandle) -> Result<&'a Adapter, String> {
    ble.adapter
        .get_or_try_init(|| async {
            let adapter = Manager::new()
                .await
                .map_err(text)?
                .adapters()
                .await
                .map_err(text)?
                .into_iter()
                .next()
                .ok_or("No Bluetooth adapter on this computer")?;
            listen(app.clone(), adapter.clone());
            Ok::<_, String>(adapter)
        })
        .await
}

/// Forwards discoveries and Bluetooth state changes to the page, for the life of the app.
fn listen(app: AppHandle, adapter: Adapter) {
    tauri::async_runtime::spawn(async move {
        let Ok(mut events) = adapter.events().await else {
            eprintln!("Bluetooth events unavailable: no sensor will be listed");
            let _ = app.emit("ble-state", "unknown");
            return;
        };
        let mut heard_at: HashMap<String, Instant> = HashMap::new();
        while let Some(event) = events.next().await {
            let id = match event {
                CentralEvent::StateUpdate(state) => {
                    let _ = app.emit("ble-state", state_name(state));
                    continue;
                }
                // On macOS a known sensor's later advertisements come as DeviceUpdated only when they carry a name;
                // otherwise as these. Missing them, a sensor dropped from the list never came back until Bluetooth
                // was turned off and on (btleplug then forgets it).
                CentralEvent::DeviceDiscovered(id)
                | CentralEvent::DeviceUpdated(id)
                | CentralEvent::RssiUpdate { id, .. }
                | CentralEvent::ManufacturerDataAdvertisement { id, .. }
                | CentralEvent::ServicesAdvertisement { id, .. }
                | CentralEvent::ServiceDataAdvertisement { id, .. } => id,
                _ => continue,
            };
            // One advertisement raises several of these: one report per sensor per REPORT_EVERY is enough.
            let now = Instant::now();
            let key = id.to_string();
            if heard_at
                .get(&key)
                .is_some_and(|at| now.duration_since(*at) < REPORT_EVERY)
            {
                continue;
            }
            let ble = app.state::<Ble>();
            let Ok(peripheral) = adapter.peripheral(&id).await else {
                continue;
            };
            let Ok(Some(props)) = peripheral.properties().await else {
                continue;
            };
            if !props.services.contains(&TETON_SERVICE) {
                continue; // other devices are neither reported nor remembered
            }
            if heard_at.len() > 1024 {
                heard_at.retain(|_, at| now.duration_since(*at) < Duration::from_secs(10)); // sensors gone out of range
            }
            heard_at.insert(key.clone(), now);
            ble.known.lock().await.insert(key.clone(), peripheral);
            let _ = app.emit(
                "ble-discover",
                heard(
                    key,
                    props.local_name,
                    props.advertisement_name,
                    props.rssi,
                    &props.manufacturer_data,
                ),
            );
        }
    });
}

async fn peripheral(ble: &Ble, id: &str) -> Result<Peripheral, String> {
    ble.known
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| format!("Unknown sensor {id}"))
}

fn uuid(text: &str) -> Result<Uuid, String> {
    Uuid::parse_str(text).map_err(|error| format!("{text}: {error}"))
}

async fn characteristic(
    p: &Peripheral,
    service: &str,
    characteristic: &str,
) -> Result<btleplug::api::Characteristic, String> {
    let (service, characteristic) = (uuid(service)?, uuid(characteristic)?);
    if service != TETON_SERVICE {
        return Err(format!("Not a Teton service: {service}"));
    }
    p.characteristics()
        .into_iter()
        .find(|c| c.service_uuid == service && c.uuid == characteristic)
        .ok_or_else(|| format!("No characteristic {characteristic}"))
}

#[tauri::command]
pub async fn ble_state(app: AppHandle, ble: State<'_, Ble>) -> Result<&'static str, String> {
    Ok(state_name(
        adapter(&ble, &app)
            .await?
            .adapter_state()
            .await
            .map_err(text)?,
    ))
}

#[tauri::command]
pub async fn ble_scan(
    app: AppHandle,
    ble: State<'_, Ble>,
    services: Vec<String>,
    seconds: f64,
) -> Result<(), String> {
    let wanted = services
        .iter()
        .map(|s| uuid(s))
        .collect::<Result<Vec<_>, _>>()?;
    if wanted != [TETON_SERVICE] {
        return Err("Only Teton sensors can be scanned for".into());
    }
    let adapter = adapter(&ble, &app).await?;
    adapter
        .start_scan(ScanFilter { services: wanted })
        .await
        .map_err(text)?;
    let round = ble.round.fetch_add(1, Ordering::SeqCst) + 1;
    let (app, adapter) = (app.clone(), adapter.clone());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs_f64(seconds.clamp(0.1, 60.0))).await;
        if app.state::<Ble>().round.load(Ordering::SeqCst) == round {
            let _ = adapter.stop_scan().await;
            let _ = app.emit("ble-stop", ());
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn ble_stop_scan(app: AppHandle, ble: State<'_, Ble>) -> Result<(), String> {
    ble.round.fetch_add(1, Ordering::SeqCst);
    adapter(&ble, &app).await?.stop_scan().await.map_err(text)
}

#[tauri::command]
pub async fn ble_connect(ble: State<'_, Ble>, id: String) -> Result<(), String> {
    peripheral(&ble, &id).await?.connect().await.map_err(text)
}

#[derive(Serialize)]
pub struct Found {
    service: String,
    characteristic: String,
}

#[tauri::command]
pub async fn ble_services(ble: State<'_, Ble>, id: String) -> Result<Vec<Found>, String> {
    let p = peripheral(&ble, &id).await?;
    p.discover_services().await.map_err(text)?;
    Ok(p.characteristics()
        .into_iter()
        .filter(|c| c.service_uuid == TETON_SERVICE)
        .map(|c| Found {
            service: c.service_uuid.to_string(),
            characteristic: c.uuid.to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn ble_write(
    ble: State<'_, Ble>,
    id: String,
    service: String,
    characteristic: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let p = peripheral(&ble, &id).await?;
    let c = self::characteristic(&p, &service, &characteristic).await?;
    p.write(&c, &data, WriteType::WithResponse)
        .await
        .map_err(text)
}

#[tauri::command]
pub async fn ble_read(
    ble: State<'_, Ble>,
    id: String,
    service: String,
    characteristic: String,
) -> Result<Vec<u8>, String> {
    let p = peripheral(&ble, &id).await?;
    let c = self::characteristic(&p, &service, &characteristic).await?;
    p.read(&c).await.map_err(text)
}

#[tauri::command]
pub async fn ble_disconnect(ble: State<'_, Ble>, id: String) -> Result<(), String> {
    peripheral(&ble, &id)
        .await?
        .disconnect()
        .await
        .map_err(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manufacturer_data_is_keyed_like_react_native_ble_manager() {
        let data = HashMap::from([(0xffff, vec![1]), (0x004c, vec![2, 3])]);
        let h = heard(
            "A".into(),
            Some("FLWR-O-019".into()),
            Some("TETON-AFD042F349".into()),
            Some(-60),
            &data,
        );
        assert_eq!(h.advertised.as_deref(), Some("TETON-AFD042F349"));
        assert_eq!(h.manufacturer["ffff"], vec![1]);
        assert_eq!(h.manufacturer["004c"], vec![2, 3]);
        assert_eq!(state_name(CentralState::PoweredOn), "on");
    }
}
