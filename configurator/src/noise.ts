// Noise_NKpsk2_25519_ChaChaPoly_SHA256, initiator side (the phone). Mirrors src/provision.rs on the device,
// which uses snow. Written from the Noise spec (rev. 34) on the audited @noble primitives; byte-for-byte
// interop is checked against vectors produced by snow (noise-vectors.json, tests/noise_vectors.rs).
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

export const NOISE_PARAMS = 'Noise_NKpsk2_25519_ChaChaPoly_SHA256';
const KEY_LEN = 32;
const TAG_LEN = 16;
const encoder = new TextEncoder();

export const prologue = (deviceId: string) => encoder.encode(`teton-provision/1:${deviceId}`);

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

// HKDF as the Noise spec defines it (HMAC-SHA256 chained outputs).
function hkdf(chainingKey: Uint8Array, input: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const temp = hmac(sha256, chainingKey, input);
  const out: Uint8Array[] = [];
  let previous: Uint8Array = new Uint8Array(0);
  for (let i = 1; i <= outputs; i++) {
    previous = hmac(sha256, temp, concat(previous, Uint8Array.of(i)));
    out.push(previous);
  }
  return out;
}

class CipherState {
  private nonce = 0n;
  private readonly key: Uint8Array | null;
  constructor(key: Uint8Array | null = null) { this.key = key; }
  get hasKey() { return this.key !== null; }

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

export interface Label {
  deviceId: string;
  devicePublic: Uint8Array; // the device's static X25519 key, printed on its label
  secret: Uint8Array; // 32-byte label secret, the Noise PSK
}

/**
 * Starts a handshake. `first()` is the message to write; `finish(reply)` checks the device's answer and
 * returns the encrypted channel. It throws when the device does not hold the key or the label secret,
 * so no credential is ever encrypted for a device that failed the handshake.
 */
export function initiator(label: Label, ephemeralPrivate: Uint8Array) {
  if (label.devicePublic.length !== KEY_LEN || label.secret.length !== KEY_LEN || ephemeralPrivate.length !== KEY_LEN) {
    throw new Error('bad key length');
  }
  const name = encoder.encode(NOISE_PARAMS);
  let h: Uint8Array = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
  let ck: Uint8Array = h;
  const cipher = { current: new CipherState() };
  const mixHash = (data: Uint8Array) => { h = sha256(concat(h, data)); };
  const mixKey = (input: Uint8Array) => { const [nextCk, key] = hkdf(ck, input, 2); ck = nextCk; cipher.current = new CipherState(key); };
  const mixKeyAndHash = (input: Uint8Array) => {
    const [nextCk, hashInput, key] = hkdf(ck, input, 3);
    ck = nextCk;
    mixHash(hashInput);
    cipher.current = new CipherState(key);
  };
  const encryptAndHash = (plain: Uint8Array) => { const out = cipher.current.encrypt(h, plain); mixHash(out); return out; };
  const decryptAndHash = (data: Uint8Array) => { const out = cipher.current.decrypt(h, data); mixHash(data); return out; };

  mixHash(prologue(label.deviceId));
  mixHash(label.devicePublic); // <- s (pre-message)
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
  let started = false;

  return {
    /** -> e, es */
    first(): Uint8Array {
      if (started) throw new Error('handshake already started');
      started = true;
      mixHash(ephemeralPublic);
      mixKey(ephemeralPublic); // PSK handshakes also mix the ephemeral into the key
      mixKey(x25519.getSharedSecret(ephemeralPrivate, label.devicePublic));
      return concat(ephemeralPublic, encryptAndHash(new Uint8Array(0)));
    },
    /** <- e, ee, psk */
    finish(reply: Uint8Array): Transport {
      if (!started || reply.length !== KEY_LEN + TAG_LEN) throw new Error('bad handshake reply');
      const deviceEphemeral = reply.slice(0, KEY_LEN);
      mixHash(deviceEphemeral);
      mixKey(deviceEphemeral);
      mixKey(x25519.getSharedSecret(ephemeralPrivate, deviceEphemeral));
      mixKeyAndHash(label.secret);
      if (decryptAndHash(reply.slice(KEY_LEN)).length !== 0) throw new Error('unexpected handshake payload');
      const [send, receive] = hkdf(ck, new Uint8Array(0), 2);
      const out = new CipherState(send);
      const inbound = new CipherState(receive);
      const none = new Uint8Array(0);
      return { seal: plain => out.encrypt(none, plain), open: data => inbound.decrypt(none, data) };
    },
  };
}
