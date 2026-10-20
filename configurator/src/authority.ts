// the two authorities, phone side (src/authority.rs on the device): the app checks a sensor's certificate
// before anything secret leaves the phone, and reads and checks the technician token it imports.
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat } from './noise.ts';

// The demo authorities' public keys (`authority public`); a deployment replaces them with its own.
export const DEVICE_AUTHORITY = fromHex('5fa1436b880e8b8705f5f55fcc0caa5c72332caf32dfcfcb232cef5281762837');
export const TECHNICIAN_AUTHORITY = fromHex('e01026772cadd27c05ddbe2384f3c63818e39e87087ad13d526063f80b8c02ca');

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const DEVICE_CERT_DOMAIN = encoder.encode('iot-device-cert/1');
const TECHNICIAN_TOKEN_DOMAIN = encoder.encode('iot-technician-token/1');
const VERSION = 1;
const KEY_LEN = 32;
const SIGNATURE_LEN = 64;
const CUSTOMER = /^[A-Za-z0-9_-]{1,32}$/;
/** The link `authority issue` prints; the app also accepts the bare hex. */
export const TOKEN_LINK = 'provide://technician/';

export function fromHex(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error('not hex');
  return Uint8Array.from(hex.match(/../g) ?? [], byte => parseInt(byte, 16));
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/** `IOT-` and 10 hex digits of SHA-256(static public key), as the sensor advertises it. */
export const deviceId = (publicKey: Uint8Array) => `IOT-${toHex(sha256(publicKey).slice(0, 5)).toUpperCase()}`;

const text = (bytes: Uint8Array) => { try { return decoder.decode(bytes); } catch { return null; } };
const signed = (bytes: Uint8Array) =>
  bytes.length > SIGNATURE_LEN && bytes[0] === VERSION ? { body: bytes.slice(0, -SIGNATURE_LEN), signature: bytes.slice(-SIGNATURE_LEN) } : null;
const verified = (domain: Uint8Array, body: Uint8Array, signature: Uint8Array, authority: Uint8Array) => {
  try { return ed25519.verify(signature, concat(domain, body), authority, { zip215: false }); } catch { return false; }
};

export type Certificate = { publicKey: Uint8Array; customer: string };

/** `[1][public key 32][customer len][customer]` + signature. The certificate if the device authority signed it. */
export function verifyCertificate(bytes: Uint8Array, authority = DEVICE_AUTHORITY): Certificate | null {
  const parts = signed(bytes);
  if (!parts || parts.body.length < 1 + KEY_LEN + 1) return null;
  const { body, signature } = parts;
  const customer = text(body.slice(2 + KEY_LEN));
  if (body.length !== 2 + KEY_LEN + body[1 + KEY_LEN] || customer === null || !CUSTOMER.test(customer)) return null;
  return verified(DEVICE_CERT_DOMAIN, body, signature, authority) ? { publicKey: body.slice(1, 1 + KEY_LEN), customer } : null;
}

export type Token = { bytes: Uint8Array; name: string; customers: string[]; expires: number };

/** `[1][expires u64 BE][name len][name][count][customer len][customer]…` + signature, without checking it. */
export function decodeToken(bytes: Uint8Array): Token | null {
  const parts = signed(bytes);
  if (!parts || parts.body.length < 11) return null;
  const { body } = parts;
  const expires = Number(new DataView(body.buffer, body.byteOffset).getBigUint64(1));
  let at = 9;
  const field = () => { const len = body[at]; const value = len === undefined ? null : text(body.slice(at + 1, at + 1 + len)); at += 1 + (len ?? 0); return value; };
  const name = field();
  const count = body[at++] ?? 0;
  const customers = Array.from({ length: count }, field);
  const valid = name !== null && name.length > 0 && at === body.length && count >= 1 && count <= 8
    && customers.every(c => c !== null && CUSTOMER.test(c));
  return valid ? { bytes, name, customers: customers as string[], expires } : null;
}

/** Signature first, then the date (Unix seconds); the sensor checks again, with its customer. */
export function checkToken(token: Token, now: number, authority = TECHNICIAN_AUTHORITY): 'ok' | 'invalid' | 'expired' {
  const parts = signed(token.bytes)!;
  if (!verified(TECHNICIAN_TOKEN_DOMAIN, parts.body, parts.signature, authority)) return 'invalid';
  return now >= token.expires ? 'expired' : 'ok';
}

/** The token in a scanned QR code, a tapped link or pasted text; null if it is not one. */
export function parseTokenText(input: string): Token | null {
  const value = input.trim();
  const hex = value.startsWith(TOKEN_LINK) ? value.slice(TOKEN_LINK.length) : value;
  try { return decodeToken(fromHex(hex)); } catch { return null; }
}
