// Demo mode: 200 simulated sensors inside the app, with no radio. Each one plays the sensor's side of the Noise XX
// handshake with its own key and a certificate from a throwaway demo authority, so the app's own setup() runs the real
// handshake, certificate checks and encryption against it; the outcomes cover a real wing (set up before, not prepared,
// out of Wi-Fi range, impostors, another customer's sensors, slow joins).
// The demo authority is trusted only for these simulated sensors, on the demo's own radio: real sensors are always
// checked against DEVICE_AUTHORITY, and demo mode never touches Bluetooth, the saved code or the saved sites.
import type { BleState, Peripheral } from 'react-native-ble-manager/src/types';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { concat, NOISE_PARAMS, PROLOGUE } from './noise.ts';
import { deviceId, parseTokenText, toHex, type Token } from './authority.ts';
import { REQUEST } from './probe.ts';
import type { Site } from './sites.ts';

const enc = new TextEncoder();
const seed = (byte: number) => new Uint8Array(32).fill(byte); // public on purpose: a demo, not a secret
const DEVICE_SEED = seed(0x51);
const TECHNICIAN_SEED = seed(0x52);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const DEMO_SITE: Site = { id: 'demo-site', name: 'Demo site · Wing B', ssid: 'Demo-Wing-B' };
export const DEMO_PASSWORD = 'demo password';
export const DEMO_SIZE = 200;

function certificate(publicKey: Uint8Array, customer: string) {
  const body = concat(Uint8Array.of(1), publicKey, Uint8Array.of(customer.length), enc.encode(customer));
  return concat(body, ed25519.sign(concat(enc.encode('iot-device-cert/1'), body), DEVICE_SEED));
}

/** A technician code (v2, holder-bound) for the demo customer, as `authority issue` prints it; valid ten years, so the
 * demo never asks for another one. */
function demoToken(): Token {
  const holderPrivate = sha256(enc.encode('demo-holder'));
  const at = new Uint8Array(8);
  new DataView(at.buffer).setBigUint64(0, BigInt(Math.floor(Date.now() / 1000) + 10 * 365 * 86400), false);
  const name = enc.encode('Demo technician');
  const body = concat(Uint8Array.of(2), at, x25519.getPublicKey(holderPrivate), Uint8Array.of(name.length), name, Uint8Array.of(1, 4), enc.encode('DEMO'));
  const token = concat(body, ed25519.sign(concat(enc.encode('iot-technician-token/2'), body), TECHNICIAN_SEED));
  return parseTokenText(`${toHex(token)}.${toHex(holderPrivate)}`)!;
}

// --- The sensor's side of Noise XX, from the Noise spec, with the primitives of src/noise.ts.
function hkdf(ck: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(sha256, ck, input);
  const first = hmac(sha256, temp, Uint8Array.of(1));
  return [first, hmac(sha256, temp, concat(first, Uint8Array.of(2)))];
}
function cipherState(key: Uint8Array | null) {
  let nonce = 0n;
  const iv = () => { const v = new Uint8Array(12); new DataView(v.buffer).setBigUint64(4, nonce++, true); return v; };
  return {
    encrypt: (ad: Uint8Array, p: Uint8Array) => (key ? chacha20poly1305(key, iv(), ad).encrypt(p) : p),
    decrypt: (ad: Uint8Array, c: Uint8Array) => (key ? chacha20poly1305(key, iv(), ad).decrypt(c) : c),
  };
}
function responder(staticPrivate: Uint8Array, payload: Uint8Array, random: (n: number) => Uint8Array) {
  const name = enc.encode(NOISE_PARAMS);
  let h: Uint8Array = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
  let ck: Uint8Array = h;
  let cipher = cipherState(null);
  const mixHash = (d: Uint8Array) => { h = sha256(concat(h, d)); };
  const mixKey = (i: Uint8Array) => { const [next, key] = hkdf(ck, i); ck = next; cipher = cipherState(key); };
  const encryptAndHash = (p: Uint8Array) => { const out = cipher.encrypt(h, p); mixHash(out); return out; };
  const decryptAndHash = (c: Uint8Array) => { const out = cipher.decrypt(h, c); mixHash(c); return out; };
  mixHash(PROLOGUE);
  const e = random(32);
  return {
    second(m1: Uint8Array) {
      const re = m1.slice(0, 32);
      mixHash(re);
      decryptAndHash(m1.slice(32));
      const ePub = x25519.getPublicKey(e);
      mixHash(ePub);
      mixKey(x25519.getSharedSecret(e, re));
      const s = encryptAndHash(x25519.getPublicKey(staticPrivate));
      mixKey(x25519.getSharedSecret(staticPrivate, re));
      return concat(ePub, s, encryptAndHash(payload));
    },
    third(m3: Uint8Array) {
      const rs = decryptAndHash(m3.slice(0, 48));
      mixKey(x25519.getSharedSecret(e, rs));
      decryptAndHash(m3.slice(48)); // the code: a real sensor checks it and its holder key here
      const [receive, send] = hkdf(ck, new Uint8Array(0));
      const out = cipherState(send);
      const inbound = cipherState(receive);
      const none = new Uint8Array(0);
      return { seal: (p: Uint8Array) => out.encrypt(none, p), open: (c: Uint8Array) => inbound.decrypt(none, c) };
    },
  };
}

// --- The wing.
type Kind = 'genuine' | 'impostor' | 'other-customer' | 'not-staged' | 'online' | 'out-of-range' | 'slow';
const kindOf = (i: number): Kind =>
  [23, 97, 151].includes(i) ? 'impostor' // copies another sensor's certificate, without its key
  : [61, 140].includes(i) ? 'other-customer'
  : [8, 77, 133, 188].includes(i) ? 'not-staged'
  : [3, 41, 90, 120, 166, 199].includes(i) ? 'online' // set up before
  : [55, 112, 175].includes(i) ? 'out-of-range' // cannot see the site network
  : i % 9 === 0 ? 'slow' // joins after one more poll
  : 'genuine';

export type Demo = ReturnType<typeof startDemo>;

/** Builds the wing (200 keys and certificates: done here, not at import) and its radio; `stop` ends its timer. */
export function startDemo(random: (n: number) => Uint8Array) {
  const fleet = Array.from({ length: DEMO_SIZE }, (_, i) => {
    const kind = kindOf(i);
    const key = sha256(enc.encode(`demo-sensor-${i}`));
    const publicKey = x25519.getPublicKey(key);
    return { id: `demo-${i}`, kind, key, publicKey, identity: Array.from(sha256(publicKey).slice(0, 5)), name: deviceId(publicKey), rssi: -42 - ((i * 13) % 45), state: kind === 'not-staged' ? 0 : kind === 'online' ? 2 : 1 };
  });
  type Sensor = (typeof fleet)[number];
  const byId = new Map(fleet.map(sensor => [sensor.id, sensor]));
  const payloadOf = (s: Sensor) =>
    s.kind === 'impostor' ? certificate(fleet[0].publicKey, 'DEMO') : certificate(s.publicKey, s.kind === 'other-customer' ? 'OTHER-CARE' : 'DEMO');

  type Session = { noise: ReturnType<typeof responder>; channel?: { seal(p: Uint8Array): Uint8Array; open(c: Uint8Array): Uint8Array }; reply?: Uint8Array; polls: number };
  const sessions = new Map<string, Session>();
  let discover: ((p: Peripheral) => void) | null = null;
  let stopped: (() => void) | null = null;
  let scanning = false;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let startedAt = 0; // the first scan: the technician walks into the wing
  const advertising = (s: Sensor) => ({ localName: s.name, manufacturerData: { ffff: { bytes: [s.state, ...s.identity] } } });
  const advertise = (s: Sensor) => {
    s.rssi = Math.max(-95, Math.min(-35, s.rssi + Math.round((Math.random() - 0.5) * 6)));
    discover?.({ id: s.id, name: s.name, rssi: s.rssi, advertising: advertising(s) } as unknown as Peripheral);
  };
  // Discovery as when walking into a wing: about half is heard within 4 s, the rest one by one over a minute; each
  // sensor then advertises every 0.3 to 1 s, and the phone misses some of them.
  const heardAfter = fleet.map((_, i) => (i % 2 === 0 ? Math.random() * 4000 : 4000 + Math.random() * 60000));
  const nextAt = fleet.map(() => 0);
  const timer = setInterval(() => {
    if (!scanning || !startedAt) return;
    const now = Date.now();
    fleet.forEach((s, i) => {
      if (now - startedAt < heardAfter[i] || now < nextAt[i]) return;
      nextAt[i] = now + 300 + Math.random() * 700;
      if (Math.random() < 0.7) advertise(s);
    });
  }, 50);

  // The calls the app makes on react-native-ble-manager.
  const radio = {
    start: async () => {},
    checkState: async () => 'on' as BleState,
    onDidUpdateState: () => ({ remove() {} }),
    onDiscoverPeripheral: (cb: (p: Peripheral) => void) => { discover = cb; return { remove() { discover = null; } }; },
    onStopScan: (cb: () => void) => { stopped = cb; return { remove() { stopped = null; } }; },
    scan: async ({ seconds = 3 }: { seconds?: number } = {}) => {
      startedAt ||= Date.now();
      scanning = true;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => { scanning = false; stopped?.(); }, seconds * 1000);
    },
    stopScan: async () => { clearTimeout(scanTimer); scanning = false; },
    connect: async (id: string) => {
      const s = byId.get(id)!;
      await wait(s.kind === 'out-of-range' ? 400 : 180 + Math.random() * 220);
      sessions.set(id, { noise: responder(s.key, payloadOf(s), random), polls: 0 });
    },
    retrieveServices: async () => { await wait(80); return {}; },
    write: async (id: string, _service: string, _characteristic: string, data: number[]) => {
      await wait(50 + Math.random() * 60);
      const session = sessions.get(id)!;
      const s = byId.get(id)!;
      if (data.length === REQUEST.length && data.every((byte, i) => byte === REQUEST[i])) { session.reply = enc.encode('world'); return; } // Test
      const message = Uint8Array.from(data.slice(1));
      if (data[0] === 0) { session.reply = session.noise.second(message); return; }
      if (!session.channel) { session.channel = session.noise.third(message); session.reply = session.channel.seal(Uint8Array.of(0)); return; }
      const request = session.channel.open(message);
      const attempt = request.slice(1, 17);
      const index = fleet.indexOf(s);
      if (s.kind === 'out-of-range') { session.reply = session.channel.seal(concat(attempt, Uint8Array.of(2, 2))); return; } // NotInRange
      const done = s.kind !== 'slow' || (request[0] === 2 && ++session.polls >= 1);
      if (done) s.state = 2;
      session.reply = session.channel.seal(concat(attempt, done ? Uint8Array.of(1, 10, 20, 3, 10 + (index % 200)) : Uint8Array.of(0)));
    },
    read: async (id: string) => { await wait(60 + Math.random() * 60); return Array.from(sessions.get(id)?.reply ?? []); },
    disconnect: async (id: string) => { sessions.delete(id); },
  };

  return {
    radio, deviceAuthority: ed25519.getPublicKey(DEVICE_SEED), token: demoToken(), site: DEMO_SITE, password: DEMO_PASSWORD,
    stop: () => { clearInterval(timer); clearTimeout(scanTimer); },
    /** For tests: each simulated sensor's id and kind. */
    sensors: fleet.map(s => ({ id: s.id, name: s.name, kind: s.kind, advertising: advertising(s) })),
  };
}
