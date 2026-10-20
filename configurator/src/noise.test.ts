/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { initiator, NOISE_PARAMS, prologue, type Label } from './noise.ts';
import { decodeResponse, provisionRequest, statusRequest } from './provision.ts';

// Produced by snow on the device side (tests/noise_vectors.rs): fixed keys make every byte deterministic.
const vectors = JSON.parse(readFileSync(new URL('./noise-vectors.json', import.meta.url), 'utf8'));
const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const label: Label = { deviceId: vectors.deviceId, devicePublic: hex(vectors.devicePublic), secret: hex(vectors.secret) };
const [m1, m2, request1, response1, request2, response2] = vectors.messages.map((m: { message: string }) => hex(m.message));
const plain = vectors.messages.map((m: { plaintext: string }) => hex(m.plaintext));
const attempt = new Uint8Array(16).fill(0xa5);

const handshake = (l: Label = label) => {
  const phone = initiator(l, hex(vectors.phoneEphemeral));
  const first = phone.first();
  return { first, channel: () => phone.finish(m2) };
};

test('matches snow byte for byte: params, prologue, handshake and both exchanges', () => {
  assert.equal(vectors.params, NOISE_PARAMS);
  assert.deepEqual(prologue(label.deviceId), hex(vectors.prologue));
  const { first, channel } = handshake();
  assert.deepEqual(first, m1);
  const transport = channel();

  assert.deepEqual(provisionRequest(attempt, 'Ward-3', 'correct horse'), plain[2]);
  assert.deepEqual(transport.seal(plain[2]), request1);
  assert.deepEqual(decodeResponse(transport.open(response1), attempt), { state: 'pending' });
  assert.deepEqual(statusRequest(attempt), plain[4]);
  assert.deepEqual(transport.seal(plain[4]), request2);
  assert.deepEqual(decodeResponse(transport.open(response2), attempt), { state: 'connected', ipv4: '192.168.1.40' });
});

test('a device without the label secret, or with another key, fails the handshake', () => {
  assert.throws(() => handshake({ ...label, secret: new Uint8Array(32).fill(9) }).channel());
  assert.throws(() => handshake({ ...label, devicePublic: randomBytes(32) }).channel());
  assert.throws(() => handshake({ ...label, deviceId: 'TETON-DEMO-002' }).channel());
});

test('tampered, truncated, replayed and reordered replies are rejected', () => {
  const tampered = response1.slice();
  tampered[3] ^= 1;
  for (const reply of [tampered, response1.slice(0, -1)]) {
    const transport = handshake().channel();
    transport.seal(plain[2]);
    assert.throws(() => transport.open(reply));
  }
  const transport = handshake().channel();
  transport.seal(plain[2]);
  assert.throws(() => transport.open(response2), 'reordered: second reply first');
  const replay = handshake().channel();
  replay.open(response1);
  assert.throws(() => replay.open(response1), 'replayed');
});

test('a reply for another attempt, or a malformed one, is refused', () => {
  const other = new Uint8Array(16).fill(1);
  assert.throws(() => decodeResponse(Uint8Array.from([...attempt, 0]), other));
  for (const body of [[], [0, 0], [1, 1, 2, 3], [2, 99], [9]]) {
    assert.throws(() => decodeResponse(Uint8Array.from([...attempt, ...body]), attempt));
  }
  assert.deepEqual(decodeResponse(Uint8Array.from([...attempt, 2, 1]), attempt), { state: 'failed', failure: 'WrongPsk' });
});

test('credentials outside WPA2-Personal bounds are refused before encryption', () => {
  assert.throws(() => provisionRequest(attempt, '', 'correct horse'));
  assert.throws(() => provisionRequest(attempt, 'Ward-3', '1234567'));
  assert.throws(() => provisionRequest(attempt, 'Ward-3', 'p'.repeat(64)));
  assert.throws(() => provisionRequest(attempt, 'x'.repeat(33), 'correct horse'));
  assert.throws(() => provisionRequest(new Uint8Array(15), 'Ward-3', 'correct horse'));
});

test('a handshake cannot be restarted or finished early', () => {
  const phone = initiator(label, hex(vectors.phoneEphemeral));
  assert.throws(() => phone.finish(m2), 'finish before first');
  phone.first();
  assert.throws(() => phone.first());
});
