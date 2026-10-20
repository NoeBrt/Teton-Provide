// Wi-Fi setup of one sensor over the encrypted channel (docs/SECURITY.md):
// label → connect → Noise handshake → encrypted credentials → wait for the device's own result.
// Credentials are encrypted only after the device proved it holds the label's key and secret.
import { initiator, type Label } from './noise.ts';
import { ATTEMPT_ID_LEN, decodeResponse, PROVISION_CHARACTERISTIC_UUID, provisionRequest, statusRequest, type Failure, type Outcome } from './provision.ts';
import { SERVICE_UUID, TimeoutError, withTimeout, type BleLink } from './probe.ts';

// First byte of every write (src/provision.rs FRAME_*): new handshake, or encrypted message.
const FRAME_HANDSHAKE = 0;
const FRAME_TRANSPORT = 1;
const MAX_MESSAGE = 512;

export type SetupStep = 'connect' | 'secure' | 'send' | 'join';
/** `closed`: the sensor has no provisioning service: already set up (it removes it), or never staged. */
export type SetupFailure = Failure | 'timeout' | 'rejected' | 'not-authenticated' | 'unknown' | 'closed';
/** The phone cannot tell what happened: retrying must reuse this attempt so the device can answer it. */
export const isUnsettled = (result: SetupResult) =>
  !result.ok && result.attempt !== undefined && (result.reason === 'timeout' || result.reason === 'rejected');

export type SetupResult =
  | { ok: true; ipv4: string; attempt: Uint8Array }
  | { ok: false; step: SetupStep; reason: SetupFailure; attempt?: Uint8Array };

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(byte => parseInt(byte, 16)));

/** `T1:<device id>:<public key hex>:<label secret hex>`, as printed by `stage`. Anything else is refused. */
export function parseLabel(text: string): Label | null {
  const match = /^T1:([A-Za-z0-9-]{1,32}):([0-9a-f]{64}):([0-9a-f]{64})$/.exec(text.trim());
  return match ? { deviceId: match[1], devicePublic: fromHex(match[2]), secret: fromHex(match[3]) } : null;
}

export interface SetupOptions {
  /** Retry after an unknown result: the device answers a repeated attempt with its stored result. */
  attempt?: Uint8Array;
  timeoutMs?: number; // per BLE operation
  joinMs?: number; // how long the device may take to join the network
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function setup(
  ble: BleLink,
  id: string,
  label: Label,
  ssid: string,
  password: string,
  random: (length: number) => Uint8Array,
  onStep: (step: SetupStep) => void = () => {},
  { attempt: resume, timeoutMs = 10_000, joinMs = 60_000, pollMs = 1_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }: SetupOptions = {},
): Promise<SetupResult> {
  let step: SetupStep = 'connect';
  let attempt: Uint8Array | undefined;
  const at = (next: SetupStep) => { step = next; onStep(next); };
  const exchange = async (frame: number, message: Uint8Array) => {
    // One Noise message per GATT write: never let the library split it (src/provision.rs MAX_MESSAGE).
    await withTimeout(ble.write(id, SERVICE_UUID, PROVISION_CHARACTERISTIC_UUID, [frame, ...message], 1 + MAX_MESSAGE), timeoutMs);
    return Uint8Array.from(await withTimeout(ble.read(id, SERVICE_UUID, PROVISION_CHARACTERISTIC_UUID), timeoutMs));
  };
  const settled = (outcome: Outcome, a: Uint8Array): SetupResult | null => {
    if (outcome.state === 'connected') return { ok: true, ipv4: outcome.ipv4, attempt: a };
    if (outcome.state === 'failed') return { ok: false, step, reason: outcome.failure, attempt: a };
    if (outcome.state === 'unknown') return { ok: false, step, reason: 'unknown', attempt: a };
    return null; // pending
  };

  try {
    at('connect');
    await withTimeout(ble.connect(id), timeoutMs);
    // Sensors are never bonded, so the phone discovers their services afresh at each connection: no stale cache.
    const { characteristics } = await withTimeout(ble.retrieveServices(id, [SERVICE_UUID]), timeoutMs);
    if (characteristics && !characteristics.some(c => c.characteristic.toLowerCase() === PROVISION_CHARACTERISTIC_UUID)) {
      return { ok: false, step, reason: 'closed' }; // nothing was written
    }

    at('secure');
    const phone = initiator(label, random(32));
    const reply = await exchange(FRAME_HANDSHAKE, phone.first());
    let channel;
    try {
      channel = phone.finish(reply);
    } catch {
      return { ok: false, step, reason: 'not-authenticated' }; // nothing secret was sent
    }

    at('send');
    attempt = resume ?? random(ATTEMPT_ID_LEN);
    const request = provisionRequest(attempt, ssid, password);
    const first = settled(decodeResponse(channel.open(await exchange(FRAME_TRANSPORT, channel.seal(request))), attempt), attempt);
    request.fill(0);
    if (first) return first;

    at('join');
    const deadline = Date.now() + joinMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const outcome = decodeResponse(channel.open(await exchange(FRAME_TRANSPORT, channel.seal(statusRequest(attempt)))), attempt);
      const result = settled(outcome, attempt);
      if (result) return result;
    }
    return { ok: false, step, reason: 'timeout', attempt }; // the device may still join: ask again with this attempt
  } catch (error) {
    return { ok: false, step, reason: error instanceof TimeoutError ? 'timeout' : 'rejected', attempt };
  } finally {
    await withTimeout(ble.disconnect(id), timeoutMs).catch(() => {});
  }
}
