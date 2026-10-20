/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isUnsettled, parseLabel, setup } from './setup.ts';
import type { BleLink } from './probe.ts';

// The device side of this conversation was produced by snow (tests/noise_vectors.rs).
const vectors = JSON.parse(readFileSync(new URL('./noise-vectors.json', import.meta.url), 'utf8'));
const hex = (s: string) => Array.from(Buffer.from(s, 'hex'));
const [m1, m2, request1, response1, request2, response2] = vectors.messages.map((m: { message: string }) => hex(m.message));
const labelText = `T1:${vectors.deviceId}:${vectors.devicePublic}:${vectors.secret}`;
const label = parseLabel(labelText)!;
// The phone's randomness: first its ephemeral key, then the attempt ID, as in the vectors.
const scripted = () => {
  const values = [Buffer.from(vectors.phoneEphemeral, 'hex'), new Uint8Array(16).fill(0xa5)];
  return (length: number) => { const next = Uint8Array.from(values.shift()!); assert.equal(next.length, length); return next; };
};

function device(replies: number[][]) {
  const writes: number[][] = [];
  const link: BleLink = {
    connect: async () => {},
    retrieveServices: async () => ({}),
    write: async (_id, _service, _characteristic, data, maxByteSize) => {
      assert.ok((maxByteSize ?? 20) > data.length, 'one GATT write per Noise message');
      writes.push(data);
    },
    read: async () => replies.shift() ?? [],
    disconnect: async () => {},
  };
  return { link, writes };
}

const fast = { sleep: async () => {}, pollMs: 0 };

test('label: accepts only the staged format', () => {
  assert.equal(label.deviceId, 'IOT-DEMO-001');
  for (const bad of ['', 'IOT-DEMO-001', `T2:${labelText.slice(3)}`, labelText.slice(0, -1), `${labelText}0`, labelText.toUpperCase()]) {
    assert.equal(parseLabel(bad), null);
  }
});

test('full setup against the device transcript: handshake, credentials, then the connected result', async () => {
  const { link, writes } = device([m2, response1, response2]);
  const steps: string[] = [];
  const result = await setup(link, 'id', label, 'Ward-3', 'correct horse', scripted(), step => steps.push(step), fast);
  assert.deepEqual(result, { ok: true, ipv4: '192.168.1.40', attempt: new Uint8Array(16).fill(0xa5) });
  assert.deepEqual(writes, [[0, ...m1], [1, ...request1], [1, ...request2]], 'exact bytes on the air');
  assert.deepEqual(steps, ['connect', 'secure', 'send', 'join']);
});

test('a device that fails the handshake never receives the credentials', async () => {
  const forged = m2.slice();
  forged[40] ^= 1;
  const { link, writes } = device([forged]);
  const result = await setup(link, 'id', label, 'Ward-3', 'correct horse', scripted(), () => {}, fast);
  assert.deepEqual(result, { ok: false, step: 'secure', reason: 'not-authenticated' });
  assert.equal(writes.length, 1, 'only the handshake was written');
  assert.equal(JSON.stringify(writes).includes(JSON.stringify(Array.from(Buffer.from('correct horse')))), false);
});

test('no answer while joining gives a timeout that keeps the attempt for recovery', async () => {
  const { link } = device([m2, response1]);
  const result = await setup(link, 'id', label, 'Ward-3', 'correct horse', scripted(), () => {}, { ...fast, joinMs: 0 });
  assert.deepEqual(result, { ok: false, step: 'join', reason: 'timeout', attempt: new Uint8Array(16).fill(0xa5) });
});

test('a tampered device reply is rejected, and the link is always released', async () => {
  const tampered = response1.slice();
  tampered[5] ^= 1;
  let disconnected = false;
  const { link } = device([m2, tampered]);
  link.disconnect = async () => { disconnected = true; };
  const result = await setup(link, 'id', label, 'Ward-3', 'correct horse', scripted(), () => {}, fast);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'rejected');
  assert.equal(disconnected, true);
});

test('a retry after an unknown result reuses the attempt, so the device answers with its stored result', async () => {
  const lost = await setup(device([m2, response1]).link, 'id', label, 'Ward-3', 'correct horse', scripted(), () => {}, { ...fast, joinMs: 0 });
  assert.equal(isUnsettled(lost), true);
  const { link, writes } = device([m2, response1, response2]);
  const ephemeralOnly = scripted();
  const result = await setup(link, 'id', label, 'Ward-3', 'correct horse', n => { assert.equal(n, 32, 'no new attempt ID drawn'); return ephemeralOnly(n); }, () => {}, { ...fast, attempt: !lost.ok ? lost.attempt : undefined });
  assert.deepEqual(writes[1], [1, ...request1], 'same attempt and credentials as before');
  assert.equal(result.ok, true);
  assert.equal(isUnsettled(result), false);
});

test('a write refused during the handshake (device busy with another phone) is a plain failure, not an unknown result', async () => {
  const { link, writes } = device([m2]);
  link.write = async () => { throw { code: 'InProgress', message: 'busy' }; }; // iOS rejects with plain objects
  const result = await setup(link, 'id', label, 'Ward-3', 'correct horse', scripted(), () => {}, fast);
  assert.deepEqual(result, { ok: false, step: 'secure', reason: 'rejected', attempt: undefined });
  assert.equal(isUnsettled(result), false, 'nothing reached the device: a retry draws a new attempt');
  assert.equal(writes.length, 0);
});
