// Bluetooth seam, desktop: react-native-ble-manager's calls, as App.tsx makes them on iOS, over the Tauri bridge
// (desktop/src-tauri/src/ble.rs, btleplug). In a plain browser there is no radio; demo mode brings its own.
import type BleManagerInstance from 'react-native-ble-manager';
import type { Peripheral } from 'react-native-ble-manager/src/types';

export type Tauri = {
  core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(name: string, cb: (event: { payload: T }) => void): Promise<() => void> };
};
// `advertised`: the sensor's own name (its scan response), preferred as its ID; `name`: the system's (cached), the fallback.
type Heard = { id: string; name: string | null; advertised?: string | null; rssi: number | null; manufacturer: Record<string, number[]> };

const toPeripheral = ({ id, name, advertised, rssi, manufacturer }: Heard) => ({
  id, name: name ?? undefined, rssi: rssi ?? 127, // 127: signal unknown, as iOS reports it
  advertising: {
    localName: advertised ?? undefined,
    manufacturerData: Object.fromEntries(Object.entries(manufacturer).map(([company, bytes]) => [company, { bytes }])),
  },
}) as unknown as Peripheral;

export function bridge(tauri: Tauri) {
  const invoke = tauri.core.invoke;
  // listen() resolves later; a subscription removed before that still stops.
  const on = <T>(name: string, cb: (payload: T) => void) => {
    let off: (() => void) | null = null;
    let removed = false;
    tauri.event.listen<T>(name, event => cb(event.payload)).then(stop => (removed ? stop() : (off = stop)), error => console.error(`Bluetooth events (${name}) unavailable:`, error));
    return { remove() { removed = true; off?.(); } };
  };
  return {
    start: async () => {},
    checkState: () => invoke<string>('ble_state'),
    onDidUpdateState: (cb: (event: { state: string }) => void) => on<string>('ble-state', state => cb({ state })),
    onDiscoverPeripheral: (cb: (p: Peripheral) => void) => on<Heard>('ble-discover', heard => cb(toPeripheral(heard))),
    onStopScan: (cb: () => void) => on('ble-stop', () => cb()),
    // allowDuplicates: btleplug reports every advertisement it hears.
    scan: ({ serviceUUIDs = [], seconds = 5 }: { serviceUUIDs?: string[]; seconds?: number; allowDuplicates?: boolean }) =>
      invoke<void>('ble_scan', { services: serviceUUIDs, seconds }),
    stopScan: () => invoke<void>('ble_stop_scan'),
    connect: (id: string) => invoke<void>('ble_connect', { id }),
    retrieveServices: async (id: string) => ({ characteristics: await invoke<{ service: string; characteristic: string }[]>('ble_services', { id }) }),
    // maxByteSize is how iOS splits a write; the bridge sends the value whole (a long write when over the MTU).
    write: (id: string, service: string, characteristic: string, data: number[], _maxByteSize?: number) =>
      invoke<void>('ble_write', { id, service, characteristic, data }),
    read: (id: string, service: string, characteristic: string) => invoke<number[]>('ble_read', { id, service, characteristic }),
    disconnect: (id: string) => invoke<void>('ble_disconnect', { id }),
  };
}

const tauri = (globalThis as { __TAURI__?: Tauri }).__TAURI__;
export const BleManager = (tauri ? bridge(tauri) : null) as unknown as typeof BleManagerInstance | null;
export const bleStarted: Promise<void> | null = tauri ? Promise.resolve() : null;
