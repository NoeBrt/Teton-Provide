// Wi-Fi setup of one sensor over the encrypted channel (docs/SECURITY.md):
// connect → Noise XX → the sensor proves it is genuine (a certificate from the device authority, for the key it
// just proved, matching the ID it advertises) → only then the technician token → encrypted credentials → the
// sensor's own result. Nothing secret leaves the phone for a sensor that is not genuine or not this customer's.
import { x25519 } from '@noble/curves/ed25519.js';
import { initiator } from './noise.ts';
import { DEVICE_AUTHORITY, deviceId, verifyCertificate, type Token } from './authority.ts';
import { ATTEMPT_ID_LEN, decodeResponse, PROVISION_CHARACTERISTIC_UUID, provisionRequest, statusRequest, type Failure, type Outcome } from './provision.ts';
import { SERVICE_UUID, TimeoutError, withTimeout, type BleLink } from './probe.ts';

// First byte of every write (src/provision.rs FRAME_*): start a handshake, or continue the session.
const FRAME_HANDSHAKE = 0;
const FRAME_TRANSPORT = 1;
const MAX_MESSAGE = 511;
// The sensor's answer to the token (src/provision.rs TOKEN_*, REFUSED_*).
const TOKEN_ACCEPTED = 0;
const REFUSED_OTHER_CUSTOMER = 2;
const REFUSED_EXPIRED = 3;

export type SetupStep = 'connect' | 'secure' | 'send' | 'join';
/**
 * `unidentified`: the sensor has not advertised its ID yet (nothing was sent; try again once it is heard);
 * `not-genuine`: no valid IoT certificate for the key and ID it shows (nothing secret was sent);
 * `other-customer`: a genuine sensor of a customer this token does not cover;
 * `token-invalid` / `token-expired`: the sensor refused the token (or the app holds the wrong key for it, nothing sent);
 * `closed`: the sensor is not staged;
 * `locked`: not tried, the app had locked the token or the site password again.
 */
export type SetupFailure =
  | Failure | 'timeout' | 'rejected' | 'unidentified' | 'not-genuine' | 'other-customer' | 'token-invalid' | 'token-expired' | 'unknown' | 'closed' | 'locked';
/** The phone cannot tell what happened: retrying must reuse this attempt so the device can answer it. */
export const isUnsettled = (result: SetupResult) =>
  !result.ok && result.attempt !== undefined && (result.reason === 'timeout' || result.reason === 'rejected');

export type SetupResult =
  | { ok: true; ipv4: string; attempt: Uint8Array }
  | { ok: false; step: SetupStep; reason: SetupFailure; attempt?: Uint8Array };

export interface SetupOptions {
  /** Retry after an unknown result: the device answers a repeated attempt with its stored result. */
  attempt?: Uint8Array;
  timeoutMs?: number; // per BLE operation
  joinMs?: number; // how long the device may take to join the network
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  deviceAuthority?: Uint8Array;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

export async function setup(
  ble: BleLink,
  id: string,
  /** The sensor's name: the one it advertised, or the system's; it must be the certificate's ID. Missing: not contacted. */
  sensorName: string | undefined,
  token: Token,
  ssid: string,
  password: string,
  random: (length: number) => Uint8Array,
  onStep: (step: SetupStep) => void = () => {},
  {
    attempt: resume, timeoutMs = 10_000, joinMs = 60_000, pollMs = 500,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), deviceAuthority = DEVICE_AUTHORITY,
  }: SetupOptions = {},
): Promise<SetupResult> {
  if (!sensorName) return { ok: false, step: 'connect', reason: 'unidentified' };
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
    // The sensor only accepts the code from its holder key: with another key, every sensor would refuse it.
    if (!same(x25519.getPublicKey(token.holderPrivate), token.holder)) return { ok: false, step, reason: 'token-invalid' };
    at('connect');
    await withTimeout(ble.connect(id), timeoutMs);
    // Sensors are never bonded, so the phone discovers their services afresh at each connection: no stale cache.
    const { characteristics } = await withTimeout(ble.retrieveServices(id, [SERVICE_UUID]), timeoutMs);
    if (characteristics && !characteristics.some(c => c.characteristic.toLowerCase() === PROVISION_CHARACTERISTIC_UUID)) {
      return { ok: false, step, reason: 'closed' }; // nothing was written
    }

    at('secure');
    const handshake = initiator(token.holderPrivate, random(32)); // the code's holder key, then this session's ephemeral key
    const reply = await exchange(FRAME_HANDSHAKE, handshake.first()); // a busy or silent sensor fails here, as a link error
    let device;
    try {
      device = handshake.second(reply);
    } catch {
      return { ok: false, step, reason: 'not-genuine' }; // its reply does not prove any key
    }
    const certificate = verifyCertificate(device.payload, deviceAuthority);
    if (!certificate || !same(certificate.publicKey, device.deviceStatic) || deviceId(certificate.publicKey) !== sensorName) {
      return { ok: false, step, reason: 'not-genuine' }; // the token never left the phone
    }
    if (!token.customers.includes(certificate.customer)) return { ok: false, step, reason: 'other-customer' };
    const { message, transport: channel } = handshake.third(token.bytes);
    const answer = channel.open(await exchange(FRAME_TRANSPORT, message));
    if (answer[0] !== TOKEN_ACCEPTED) {
      const reason = answer[1] === REFUSED_OTHER_CUSTOMER ? 'other-customer' : answer[1] === REFUSED_EXPIRED ? 'token-expired' : 'token-invalid';
      return { ok: false, step, reason };
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
