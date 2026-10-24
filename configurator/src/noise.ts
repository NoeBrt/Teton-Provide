// Noise_XX_25519_ChaChaPoly_SHA256, initiator side (the phone). Mirrors device/src/provision.rs on the device, which
// uses snow. Written from the Noise spec (rev. 34) on the audited @noble primitives; byte-for-byte interop is
// checked against vectors produced by snow (noise-vectors.json, device/tests/noise_vectors.rs).
//   -> e
//   <- e, ee, s, es   (payload: the device certificate)
//   -> s, se          (payload: the technician token)
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

export const NOISE_PARAMS = 'Noise_XX_25519_ChaChaPoly_SHA256';
export const PROLOGUE = new TextEncoder().encode('iot-provision/2');
const KEY_LEN = 32;
const TAG_LEN = 16;

export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

// HKDF as the Noise spec defines it (HMAC-SHA256 chained outputs).
function hkdf(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(sha256, chainingKey, input);
  const first = hmac(sha256, temp, Uint8Array.of(1));
  return [first, hmac(sha256, temp, concat(first, Uint8Array.of(2)))];
}

class CipherState {
  private nonce = 0n;
  private readonly key: Uint8Array | null;
  constructor(key: Uint8Array | null = null) { this.key = key; }

  private iv() {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, this.nonce, true); // 32 zero bits, then the 64-bit counter LE
    return iv;
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array) {
    if (!this.key) return plaintext;
    const out = chacha20poly1305(this.key, this.iv(), ad).encrypt(plaintext);
    this.nonce++;
    return out;
  }

  /** Throws on a wrong key, tampering, truncation, replay or reordering (the nonce must match). */
  decrypt(ad: Uint8Array, ciphertext: Uint8Array) {
    if (!this.key) return ciphertext;
    const out = chacha20poly1305(this.key, this.iv(), ad).decrypt(ciphertext);
    this.nonce++;
    return out;
  }
}

export interface Transport {
  /** Encrypts one request: one Noise transport message, one GATT write. */
  seal(plaintext: Uint8Array): Uint8Array;
  /** Decrypts the device's reply; throws if it was altered, replayed or reordered. */
  open(ciphertext: Uint8Array): Uint8Array;
}

/**
 * Starts a handshake with this phone's static key and a fresh ephemeral key. The three steps must run in order:
 * `first()` to write, `second(reply)` to read the device's static key and certificate, and only once the caller
 * has checked that certificate, `third(token)` to send the technician token and get the encrypted channel.
 */
export function initiator(staticPrivate: Uint8Array, ephemeralPrivate: Uint8Array) {
  if (staticPrivate.length !== KEY_LEN || ephemeralPrivate.length !== KEY_LEN) throw new Error('bad key length');
  const name = new TextEncoder().encode(NOISE_PARAMS);
  let h: Uint8Array = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
  let ck: Uint8Array = h;
  let cipher = new CipherState();
  const mixHash = (data: Uint8Array) => { h = sha256(concat(h, data)); };
  const mixKey = (input: Uint8Array) => { const [nextCk, key] = hkdf(ck, input); ck = nextCk; cipher = new CipherState(key); };
  const encryptAndHash = (plain: Uint8Array) => { const out = cipher.encrypt(h, plain); mixHash(out); return out; };
  const decryptAndHash = (data: Uint8Array) => { const out = cipher.decrypt(h, data); mixHash(data); return out; };

  mixHash(PROLOGUE);
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
  let deviceEphemeral: Uint8Array | null = null;
  // Each step starts by poisoning `step`: if it throws (a forged reply), every later step refuses to run.
  let step = 0;
  const begin = (expected: number) => { if (step !== expected) throw new Error('handshake out of order'); step = -1; };

  return {
    /** -> e (no payload). */
    first(): Uint8Array {
      begin(0);
      mixHash(ephemeralPublic);
      const message = concat(ephemeralPublic, encryptAndHash(new Uint8Array(0)));
      step = 1;
      return message;
    },
    /** <- e, ee, s, es: returns the device's proven static key and its payload (the certificate). */
    second(reply: Uint8Array): { deviceStatic: Uint8Array; payload: Uint8Array } {
      begin(1);
      if (reply.length < KEY_LEN + KEY_LEN + TAG_LEN + TAG_LEN) throw new Error('bad handshake reply');
      deviceEphemeral = reply.slice(0, KEY_LEN);
      mixHash(deviceEphemeral);
      mixKey(x25519.getSharedSecret(ephemeralPrivate, deviceEphemeral));
      const deviceStatic = decryptAndHash(reply.slice(KEY_LEN, KEY_LEN * 2 + TAG_LEN));
      mixKey(x25519.getSharedSecret(ephemeralPrivate, deviceStatic));
      const payload = decryptAndHash(reply.slice(KEY_LEN * 2 + TAG_LEN));
      step = 2;
      return { deviceStatic, payload };
    },
    /** -> s, se, carrying `payload` (the technician token); returns the message and the encrypted channel. */
    third(payload: Uint8Array): { message: Uint8Array; transport: Transport } {
      begin(2);
      const encryptedStatic = encryptAndHash(x25519.getPublicKey(staticPrivate));
      mixKey(x25519.getSharedSecret(staticPrivate, deviceEphemeral!));
      const message = concat(encryptedStatic, encryptAndHash(payload));
      const [send, receive] = hkdf(ck, new Uint8Array(0));
      const out = new CipherState(send);
      const inbound = new CipherState(receive);
      const none = new Uint8Array(0);
      step = 3;
      return { message, transport: { seal: plain => out.encrypt(none, plain), open: data => inbound.decrypt(none, data) } };
    },
  };
}
