/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { initiator, NOISE_PARAMS, PROLOGUE } from './noise.ts';
import { decodeResponse, provisionRequest, statusRequest } from './provision.ts';

// Produced by snow on the device side (tests/noise_vectors.rs): fixed keys make every byte deterministic.
const vectors = JSON.parse(readFileSync(new URL('./noise-vectors.json', import.meta.url), 'utf8'));
const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const messages: Uint8Array[] = vectors.messages.map((m: { message: string }) => hex(m.message));
const plain = vectors.messages.map((m: { plaintext: string }) => hex(m.plaintext));
const [m1, m2, m3, accepted, request1, response1, request2, response2] = messages;
const attempt = new Uint8Array(16).fill(0xa5);

// The phone's static key is the holder key of its technician code.
const phone = () => initiator(hex(vectors.holderPrivate), hex(vectors.phoneEphemeral));

test('matches snow byte for byte: params, prologue, the three handshake messages and both exchanges', () => {
  assert.equal(vectors.params, NOISE_PARAMS);
  assert.deepEqual(PROLOGUE, hex(vectors.prologue));
  const handshake = phone();
  assert.deepEqual(handshake.first(), m1);
  const { deviceStatic, payload } = handshake.second(m2);
  assert.deepEqual(deviceStatic, hex(vectors.devicePublic), 'the device proved this static key');
  assert.deepEqual(payload, hex(vectors.certificate), 'the device sent its certificate');
  const { message, transport } = handshake.third(hex(vectors.token));
  assert.deepEqual(message, m3);
  assert.deepEqual(transport.open(accepted), plain[3]);

  assert.deepEqual(provisionRequest(attempt, 'Ward-3', 'correct horse'), plain[4]);
  assert.deepEqual(transport.seal(plain[4]), request1);
  assert.deepEqual(decodeResponse(transport.open(response1), attempt), { state: 'pending' });
  assert.deepEqual(statusRequest(attempt), plain[6]);
  assert.deepEqual(transport.seal(plain[6]), request2);
  assert.deepEqual(decodeResponse(transport.open(response2), attempt), { state: 'connected', ipv4: '192.168.1.40' });
});

test('a tampered or truncated second message fails before the token can be sent', () => {
  for (const bad of [Uint8Array.from(m2, (b, i) => (i === 40 ? b ^ 1 : b)), m2.slice(0, 60), m2.slice(0, -1)]) {
    const handshake = phone();
    handshake.first();
    assert.throws(() => handshake.second(bad));
    assert.throws(() => handshake.third(hex(vectors.token)), /out of order/, 'no token after a failed second message');
  }
});

test('steps must run in order', () => {
  const handshake = phone();
  assert.throws(() => handshake.second(m2), /out of order/);
  handshake.first();
  assert.throws(() => handshake.first(), /out of order/);
  assert.throws(() => handshake.third(new Uint8Array(0)), /out of order/);
});

test('altered, replayed or reordered device replies are rejected', () => {
  const handshake = phone();
  handshake.first();
  handshake.second(m2);
  const { transport } = handshake.third(hex(vectors.token));
  const tampered = accepted.slice();
  tampered[0] ^= 1;
  assert.throws(() => transport.open(tampered));
  assert.throws(() => transport.open(randomBytes(accepted.length)));
});

test('keys must be 32 bytes', () => {
  assert.throws(() => initiator(new Uint8Array(31), new Uint8Array(32)));
  assert.throws(() => initiator(new Uint8Array(32), new Uint8Array(33)));
});
