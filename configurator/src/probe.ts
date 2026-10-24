// Harmless BLE probe: write "hello", read "world". Mirrors device/src/protocol.rs on the device.
export const SERVICE_UUID = '3b0a90ce-9564-40d1-b96b-14cf8858aba3';
export const CHARACTERISTIC_UUID = '29b3765c-de49-4114-889e-89b05852c968';
export const REQUEST = bytes('hello');

/** The sensor's state, advertised as one byte of manufacturer data under company 0xFFFF (device/src/protocol.rs STATE_*). */
export type SensorState = 'not-staged' | 'ready' | 'online' | 'offline';
const STATES: SensorState[] = ['not-staged', 'ready', 'online', 'offline'];
export type Advertising = { localName?: string; manufacturerData?: Record<string, { bytes: number[] }> };
/** `null` when the sensor advertises no state (older firmware) or an unknown one. */
export const sensorState = (advertising?: Advertising): SensorState | null =>
  STATES[advertising?.manufacturerData?.ffff?.bytes[0] ?? -1] ?? null;

/** The setup button's name, in the card and the menu-bar panel: Reconfigure for a sensor that already joined a network,
 * as it advertises or as this session set it up (`joined`, before the next scan hears its new state). */
export const setUpLabel = (state: SensorState | null, joined = false) =>
  joined || state === 'online' || state === 'offline' ? 'Reconfigure' : 'Set up';

/** The primary advertisement's untrusted claim; setup must still verify the certificate and proven key. */
export function sensorId(advertising?: Advertising): string | null {
  const data = advertising?.manufacturerData?.ffff?.bytes;
  if (!data || data.length !== 6 || !Array.from(data).every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    || sensorState(advertising) === null) return null;
  return `TETON-${data.slice(1).map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export const sensorLabel = (sensor: { name?: string; advertising?: Advertising }) => sensorId(sensor.advertising) ?? 'Unnamed sensor';

/** The scan reports every advertisement: a card is redrawn only when its state, name or signal (≥ 5 dB) changed. */
export const changed = (before: { rssi: number; advertising?: Advertising } | undefined, after: { rssi: number; advertising?: Advertising }) =>
  !before
  || sensorState(before.advertising) !== sensorState(after.advertising)
  || sensorId(before.advertising) !== sensorId(after.advertising)
  || Math.abs(before.rssi - after.rssi) >= 5;

/** Scan-response callbacks can omit manufacturer data: retain state and identity together, never mix two records. */
export function keepAdvertised<P extends { advertising?: Advertising }>(before: P | undefined, after: P): P {
  if (!before) return after;
  const manufacturerData = after.advertising?.manufacturerData?.ffff ? after.advertising.manufacturerData : before.advertising?.manufacturerData;
  return { ...after, advertising: { ...after.advertising, manufacturerData } };
}
const RESPONSE = bytes('world');

// The subset of react-native-ble-manager the probe needs, so tests can use a fake.
export interface BleLink {
  connect(id: string): Promise<void>;
  /** Discovers the services; `characteristics` lists what the peripheral exposes (react-native-ble-manager PeripheralInfo). */
  retrieveServices(id: string, serviceUUIDs: string[]): Promise<{ characteristics?: { service?: string; characteristic: string }[] }>;
  /** `maxByteSize`: the library splits larger data into separate writes (default 20 bytes). */
  write(id: string, service: string, characteristic: string, data: number[], maxByteSize?: number): Promise<void>;
  read(id: string, service: string, characteristic: string): Promise<number[]>;
  disconnect(id: string): Promise<void>;
}

export type Step = 'connect' | 'services' | 'write' | 'read';
export type ProbeResult =
  | { ok: true; ms: number }
  | { ok: false; step: Step; reason: 'timeout' | 'rejected' | 'unexpected-reply'; detail: string; ms: number };

export class TimeoutError extends Error {}

function bytes(text: string): number[] {
  return [...text].map(char => char.charCodeAt(0));
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// iOS never times out a connection attempt, so every step gets its own deadline.
export async function probe(
  ble: BleLink,
  id: string,
  onStep: (step: Step) => void = () => {},
  timeoutMs = 10_000,
): Promise<ProbeResult> {
  const started = Date.now();
  let step: Step = 'connect';
  const run = <T>(next: Step, action: () => Promise<T>) => {
    step = next;
    onStep(next);
    return withTimeout(action(), timeoutMs);
  };
  try {
    await run('connect', () => ble.connect(id));
    await run('services', () => ble.retrieveServices(id, [SERVICE_UUID]));
    await run('write', () => ble.write(id, SERVICE_UUID, CHARACTERISTIC_UUID, REQUEST));
    const reply = await run('read', () => ble.read(id, SERVICE_UUID, CHARACTERISTIC_UUID));
    if (reply.length !== RESPONSE.length || reply.some((byte, i) => byte !== RESPONSE[i])) {
      return { ok: false, step, reason: 'unexpected-reply', detail: `${reply.length} bytes`, ms: Date.now() - started };
    }
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    const timedOut = error instanceof TimeoutError;
    // iOS rejects with { code, domain, message } objects, not Error instances.
    const detail = timedOut ? '' : String((error as { message?: unknown } | null)?.message ?? error);
    return { ok: false, step, reason: timedOut ? 'timeout' : 'rejected', detail, ms: Date.now() - started };
  } finally {
    await withTimeout(ble.disconnect(id), timeoutMs).catch(() => {});
  }
}
