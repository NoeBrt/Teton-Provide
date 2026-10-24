// Teton's two authorities, phone side (device/src/authority.rs on the device): the app checks a sensor's certificate
// before anything secret leaves the phone, and reads and checks the technician token it imports.
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat } from './noise.ts';

// The demo authorities' public keys (`teton-workshop public`); a deployment replaces them with its own.
export const DEVICE_AUTHORITY = fromHex('3ef5b95202435ad8eeb62f5aee0cdd62c31eb972039afee13cb10cd8eef96f06');
export const TECHNICIAN_AUTHORITY = fromHex('2bdfed531076b0b78543ba46eb94796c4a790638aa04abb41e16c0cf313ee726');

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const DEVICE_CERT_DOMAIN = encoder.encode('teton-device-cert/1');
const TECHNICIAN_TOKEN_DOMAIN = encoder.encode('teton-technician-token/2');
const CERTIFICATE_VERSION = 1;
const TOKEN_VERSION = 2; // 2 added the holder key; version 1 tokens are refused as malformed
const KEY_LEN = 32;
const SIGNATURE_LEN = 64;
const CUSTOMER = /^[A-Za-z0-9_-]{1,32}$/;
// `teton-workshop issue` prints the bare code `<token hex>.<holder private key hex>`, imported only inside the app (scan or
// paste): a link would let another app claim the scheme and receive the code. Pasted with the old link prefix, it still reads.
export const OLD_LINK = 'provide://technician/';

export function fromHex(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error('not hex');
  return Uint8Array.from(hex.match(/../g) ?? [], byte => parseInt(byte, 16));
}

export const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/** `TETON-` and 10 hex digits of SHA-256(static public key), as the sensor advertises it. */
export const deviceId = (publicKey: Uint8Array) => `TETON-${toHex(sha256(publicKey).slice(0, 5)).toUpperCase()}`;

const text = (bytes: Uint8Array) => { try { return decoder.decode(bytes); } catch { return null; } };
const signed = (bytes: Uint8Array, version: number) =>
  bytes.length > SIGNATURE_LEN && bytes[0] === version ? { body: bytes.slice(0, -SIGNATURE_LEN), signature: bytes.slice(-SIGNATURE_LEN) } : null;
const verified = (domain: Uint8Array, body: Uint8Array, signature: Uint8Array, authority: Uint8Array) => {
  try { return ed25519.verify(signature, concat(domain, body), authority, { zip215: false }); } catch { return false; }
};

export type Certificate = { publicKey: Uint8Array; customer: string };

/** `[1][public key 32][customer len][customer]` + signature. The certificate if Teton's device authority signed it. */
export function verifyCertificate(bytes: Uint8Array, authority = DEVICE_AUTHORITY): Certificate | null {
  const parts = signed(bytes, CERTIFICATE_VERSION);
  if (!parts || parts.body.length < 1 + KEY_LEN + 1) return null;
  const { body, signature } = parts;
  const customer = text(body.slice(2 + KEY_LEN));
  if (body.length !== 2 + KEY_LEN + body[1 + KEY_LEN] || customer === null || !CUSTOMER.test(customer)) return null;
  return verified(DEVICE_CERT_DOMAIN, body, signature, authority) ? { publicKey: body.slice(1, 1 + KEY_LEN), customer } : null;
}

/** `holder`: the X25519 key the sensor requires the phone to prove; `holderPrivate`: its private half, from the code. */
export type Token = { bytes: Uint8Array; name: string; customers: string[]; expires: number; holder: Uint8Array; holderPrivate: Uint8Array };

/**
 * `[2][expires u64 BE][holder 32][name len][name][count][customer len][customer]…` + signature, without checking it;
 * null if `holderPrivate` is not the private half of its holder key.
 */
export function decodeToken(bytes: Uint8Array, holderPrivate: Uint8Array): Token | null {
  const parts = signed(bytes, TOKEN_VERSION);
  if (!parts || parts.body.length < 1 + 8 + KEY_LEN + 2) return null;
  const { body } = parts;
  const expires = Number(new DataView(body.buffer, body.byteOffset).getBigUint64(1));
  const holder = body.slice(9, 9 + KEY_LEN);
  let at = 9 + KEY_LEN;
  const field = () => { const len = body[at]; const value = len === undefined ? null : text(body.slice(at + 1, at + 1 + len)); at += 1 + (len ?? 0); return value; };
  const name = field();
  const count = body[at++] ?? 0;
  const customers = Array.from({ length: count }, field);
  const valid = name !== null && name.length > 0 && at === body.length && count >= 1 && count <= 8
    && customers.every(c => c !== null && CUSTOMER.test(c))
    && holderPrivate.length === KEY_LEN && toHex(x25519.getPublicKey(holderPrivate)) === toHex(holder);
  return valid ? { bytes, name, customers: customers as string[], expires, holder, holderPrivate } : null;
}

/** Signature first, then the date (Unix seconds); the sensor checks again, with its customer. */
export function checkToken(token: Token, now: number, authority = TECHNICIAN_AUTHORITY): 'ok' | 'invalid' | 'expired' {
  const parts = signed(token.bytes, TOKEN_VERSION)!;
  if (!verified(TECHNICIAN_TOKEN_DOMAIN, parts.body, parts.signature, authority)) return 'invalid';
  return now >= token.expires ? 'expired' : 'ok';
}

/** The token and its holder key in a scanned QR code or pasted text; null if it is not one. */
export function parseTokenText(input: string): Token | null {
  const value = input.trim();
  const parts = (value.startsWith(OLD_LINK) ? value.slice(OLD_LINK.length) : value).split('.');
  if (parts.length !== 2) return null; // a token without its holder key is useless: the sensor would refuse it
  try { return decodeToken(fromHex(parts[0]), fromHex(parts[1])); } catch { return null; }
}
