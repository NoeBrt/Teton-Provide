// Messages carried inside the Noise channel. Mirrors Request/Response in device/src/provision.rs on the device.
export const PROVISION_CHARACTERISTIC_UUID = '3c2c02fa-847e-480c-9f22-b239dfa524c9';
export const ATTEMPT_ID_LEN = 16;
export const MAX_SSID = 32;
export const PASSWORD_LEN = { min: 8, max: 63 }; // WPA2-Personal passphrase (IEEE 802.11i)
export const ENTERPRISE_MAX = 255; // WPA2-Enterprise username and password: one length byte each
export const MAX_DOMAIN = 253;

/** WPA2-Enterprise (802.1X) sign-in; the sensor joins only if the RADIUS server's certificate names `domain`. */
export type Enterprise = { username: string; domain: string };

const encoder = new TextEncoder();

export type Failure = 'WrongPsk' | 'NotInRange' | 'Timeout' | 'NmcliError' | 'AlreadyProvisioned' | 'Busy' | 'Conflict';
const FAILURES: Failure[] = ['WrongPsk', 'NotInRange', 'Timeout', 'NmcliError', 'AlreadyProvisioned', 'Busy', 'Conflict'];

export type Outcome =
  | { state: 'pending' }
  | { state: 'connected'; ipv4: string }
  | { state: 'failed'; failure: Failure }
  | { state: 'unknown' };

/** Checks what the technician typed before anything is encrypted; returns a message or null. */
export function credentialError(ssid: string, password: string, enterprise?: Enterprise): string | null {
  const ssidBytes = encoder.encode(ssid).length;
  const passwordBytes = encoder.encode(password).length;
  if (ssidBytes === 0) return 'Enter the Wi-Fi network name.';
  if (ssidBytes > MAX_SSID) return 'The network name is too long (32 bytes at most).';
  if (enterprise) {
    const usernameBytes = encoder.encode(enterprise.username).length;
    const domainBytes = encoder.encode(enterprise.domain).length;
    if (usernameBytes === 0) return 'Enter the username.';
    if (usernameBytes > ENTERPRISE_MAX) return 'The username is too long (255 bytes at most).';
    if (domainBytes === 0) return 'Enter the server domain, for example radius.hospital.org: the sensor checks the network is genuine with it.';
    if (domainBytes > MAX_DOMAIN) return 'The server domain is too long (253 characters at most).';
    if (passwordBytes === 0) return 'Enter the password.';
    if (passwordBytes > ENTERPRISE_MAX) return 'The password is too long (255 bytes at most).';
    return null;
  }
  if (passwordBytes < PASSWORD_LEN.min) return 'The password needs at least 8 characters.';
  if (passwordBytes > PASSWORD_LEN.max) return 'The password is too long (63 characters at most).';
  return null;
}

/** `[1][attempt 16][ssid len][ssid][password len][password]`, then `[username len][username][domain len][domain]` for 802.1X */
export function provisionRequest(attempt: Uint8Array, ssid: string, password: string, enterprise?: Enterprise): Uint8Array {
  const error = credentialError(ssid, password, enterprise);
  if (error || attempt.length !== ATTEMPT_ID_LEN) throw new Error(error ?? 'bad attempt id');
  const fields = [ssid, password, ...(enterprise ? [enterprise.username, enterprise.domain] : [])].map(f => encoder.encode(f));
  return Uint8Array.from([1, ...attempt, ...fields.flatMap(f => [f.length, ...f])]);
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
