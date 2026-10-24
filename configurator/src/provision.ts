// Messages carried inside the Noise channel. Mirrors Request/Response in device/src/provision.rs on the device.
export const PROVISION_CHARACTERISTIC_UUID = '3c2c02fa-847e-480c-9f22-b239dfa524c9';
export const ATTEMPT_ID_LEN = 16;
export const MAX_SSID = 32;
export const PASSWORD_LEN = { min: 8, max: 63 }; // WPA2-Personal passphrase (IEEE 802.11i)

const encoder = new TextEncoder();

export type Failure = 'WrongPsk' | 'NotInRange' | 'Timeout' | 'NmcliError' | 'AlreadyProvisioned' | 'Busy' | 'Conflict';
const FAILURES: Failure[] = ['WrongPsk', 'NotInRange', 'Timeout', 'NmcliError', 'AlreadyProvisioned', 'Busy', 'Conflict'];

export type Outcome =
  | { state: 'pending' }
  | { state: 'connected'; ipv4: string }
  | { state: 'failed'; failure: Failure }
  | { state: 'unknown' };

/** Checks what the technician typed before anything is encrypted; returns a message or null. */
export function credentialError(ssid: string, password: string): string | null {
  const ssidBytes = encoder.encode(ssid).length;
  const passwordBytes = encoder.encode(password).length;
  if (ssidBytes === 0) return 'Enter the Wi-Fi network name.';
  if (ssidBytes > MAX_SSID) return 'The network name is too long (32 bytes at most).';
  if (passwordBytes < PASSWORD_LEN.min) return 'The password needs at least 8 characters.';
  if (passwordBytes > PASSWORD_LEN.max) return 'The password is too long (63 characters at most).';
  return null;
}

/** `[1][attempt 16][ssid len][ssid][password len][password]` */
export function provisionRequest(attempt: Uint8Array, ssid: string, password: string): Uint8Array {
  const error = credentialError(ssid, password);
  if (error || attempt.length !== ATTEMPT_ID_LEN) throw new Error(error ?? 'bad attempt id');
  const s = encoder.encode(ssid);
  const p = encoder.encode(password);
  return Uint8Array.from([1, ...attempt, s.length, ...s, p.length, ...p]);
}

/** `[2][attempt 16]` */
export function statusRequest(attempt: Uint8Array): Uint8Array {
  if (attempt.length !== ATTEMPT_ID_LEN) throw new Error('bad attempt id');
  return Uint8Array.from([2, ...attempt]);
}

/** Decodes the device's reply and checks it answers this attempt; throws otherwise. */
export function decodeResponse(bytes: Uint8Array, attempt: Uint8Array): Outcome {
  if (bytes.length < ATTEMPT_ID_LEN + 1 || !attempt.every((b, i) => bytes[i] === b)) throw new Error('reply for another attempt');
  const body = bytes.slice(ATTEMPT_ID_LEN);
  if (body.length === 1 && body[0] === 0) return { state: 'pending' };
  if (body.length === 5 && body[0] === 1) return { state: 'connected', ipv4: Array.from(body.slice(1)).join('.') };
  if (body.length === 2 && body[0] === 2 && FAILURES[body[1] - 1]) return { state: 'failed', failure: FAILURES[body[1] - 1] };
  if (body.length === 1 && body[0] === 3) return { state: 'unknown' };
  throw new Error('malformed reply');
}
