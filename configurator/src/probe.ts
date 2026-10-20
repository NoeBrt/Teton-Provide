// Harmless BLE probe: write "hello", read "world". Mirrors src/protocol.rs on the device.
export const SERVICE_UUID = '3b0a90ce-9564-40d1-b96b-14cf8858aba3';
export const CHARACTERISTIC_UUID = '29b3765c-de49-4114-889e-89b05852c968';
export const REQUEST = bytes('hello');
const RESPONSE = bytes('world');

// The subset of react-native-ble-manager the probe needs, so tests can use a fake.
export interface BleLink {
  connect(id: string): Promise<void>;
  retrieveServices(id: string, serviceUUIDs: string[]): Promise<unknown>;
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
