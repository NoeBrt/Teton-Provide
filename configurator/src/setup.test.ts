/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isUnsettled, setup, type SetupOptions, type SetupResult } from './setup.ts';
import { RETRIED } from './batch.ts';
import { decodeToken, fromHex, type Token } from './authority.ts';
import type { Advertising, BleLink } from './probe.ts';

// The device side of this conversation was produced by snow (device/tests/noise_vectors.rs).
const vectors = JSON.parse(readFileSync(new URL('./noise-vectors.json', import.meta.url), 'utf8'));
const hex = (s: string) => Array.from(Buffer.from(s, 'hex'));
const [m1, m2, m3, accepted, request1, response1, request2, response2] = vectors.messages.map((m: { message: string }) => hex(m.message));
const refusedExpired = hex(vectors.refusedExpired);
const token = decodeToken(fromHex(vectors.token), fromHex(vectors.holderPrivate))!;
const options: SetupOptions = { sleep: async () => {}, pollMs: 0, deviceAuthority: fromHex(vectors.deviceAuthority) };
// The phone's randomness: its ephemeral key, then the attempt ID, as in the vectors (its static key is the code's holder key).
const scripted = () => {
  const values = [fromHex(vectors.phoneEphemeral), new Uint8Array(16).fill(0xa5)];
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

const advertising = (name: string): Advertising => ({ manufacturerData: { ffff: { bytes: [1, ...hex(name.slice('SENSOR-'.length))] } } });

const run = (link: BleLink, extra: SetupOptions = {}, sensor: string = vectors.deviceId, holder: Token = token, steps: string[] = []): Promise<SetupResult> =>
  setup(link, 'id', sensor ? advertising(sensor) : undefined, holder, 'Ward-3', 'correct horse', scripted(), step => steps.push(step), { ...options, ...extra });
const sent = (writes: number[][], bytes: number[]) => writes.some(w => JSON.stringify(w).includes(JSON.stringify(bytes).slice(1, -1)));
const password = Array.from(Buffer.from('correct horse'));

test('full setup against the device transcript: handshake, certificate, token, credentials, connected', async () => {
  const { link, writes } = device([m2, accepted, response1, response2]);
  const steps: string[] = [];
  const result = await run(link, {}, vectors.deviceId, token, steps);
  assert.deepEqual(result, { ok: true, ipv4: '192.168.1.40', attempt: new Uint8Array(16).fill(0xa5) });
  assert.deepEqual(writes, [[0, ...m1], [1, ...m3], [1, ...request1], [1, ...request2]], 'exact bytes on the air');
  assert.deepEqual(steps, ['connect', 'secure', 'send', 'join']);
});

test('an impostor never receives the token: forged reply, another advertised ID, another authority, another key', async () => {
  const forged = m2.slice();
  forged[90] ^= 1; // inside the encrypted certificate
  const cases: [number[][], SetupOptions, string][] = [
    [[forged], {}, vectors.deviceId],
    [[m2], {}, 'SENSOR-0000000000'], // a genuine certificate, but advertised under another sensor's ID
    [[m2], { deviceAuthority: fromHex(vectors.technicianAuthority) }, vectors.deviceId], // not the manufacturer's device authority
    [[hex(vectors.impostorReply)], {}, vectors.deviceId], // a copied genuine certificate, but the handshake proved another key
  ];
  for (const [replies, extra, sensor] of cases) {
    const { link, writes } = device(replies);
    assert.deepEqual(await run(link, extra, sensor), { ok: false, step: 'secure', reason: 'not-genuine' });
    assert.equal(writes.length, 1, 'only the first handshake message was written');
    assert.equal(sent(writes, m3) || sent(writes, password), false);
  }
});

test('a genuine sensor of another customer is skipped before the token leaves', async () => {
  const { link, writes } = device([m2]);
  const result = await run(link, {}, vectors.deviceId, { ...token, customers: ['ANOTHER-CUSTOMER'] });
  assert.deepEqual(result, { ok: false, step: 'secure', reason: 'other-customer' });
  assert.equal(writes.length, 1);
});

test('a token the sensor refuses (expired, held by another key) stops before any credential', async () => {
  // A recorded token presented without its holder key: the sensor refuses it as invalid.
  const recorded = { ...token, bytes: fromHex(vectors.wrongHolderToken) };
  for (const [reply, holder, reason] of [[refusedExpired, token, 'token-expired'], [hex(vectors.refusedWrongHolder), recorded, 'token-invalid']] as const) {
    const { link, writes } = device([m2, reply]);
    assert.deepEqual(await run(link, {}, vectors.deviceId, holder), { ok: false, step: 'secure', reason });
    assert.equal(writes.length, 2, 'handshake only');
    assert.equal(sent(writes, password), false);
  }
});

test('a code whose holder key does not match is refused before anything is sent', async () => {
  const { link, writes } = device([m2]);
  const mismatched = { ...token, holderPrivate: fromHex(vectors.phoneEphemeral) };
  assert.deepEqual(await run(link, {}, vectors.deviceId, mismatched), { ok: false, step: 'connect', reason: 'token-invalid' });
  assert.equal(writes.length, 0);
});

test('no answer while joining gives a timeout that keeps the attempt for recovery', async () => {
  const { link } = device([m2, accepted, response1]);
  const result = await run(link, { joinMs: 0 });
  assert.deepEqual(result, { ok: false, step: 'join', reason: 'timeout', attempt: new Uint8Array(16).fill(0xa5) });
});

test('a tampered device reply is rejected, and the link is always released', async () => {
  const tampered = response1.slice();
  tampered[5] ^= 1;
  let disconnected = false;
  const { link } = device([m2, accepted, tampered]);
  link.disconnect = async () => { disconnected = true; };
  const result = await run(link);
  assert.equal(!result.ok && result.reason, 'rejected');
  assert.equal(disconnected, true);
});

test('a retry after an unknown result reuses the attempt, so the device answers with its stored result', async () => {
  const lost = await run(device([m2, accepted, response1]).link, { joinMs: 0 });
  assert.equal(isUnsettled(lost), true);
  const { link, writes } = device([m2, accepted, response1, response2]);
  const keysOnly = scripted();
  const result = await setup(link, 'id', advertising(vectors.deviceId), token, 'Ward-3', 'correct horse',
    n => { assert.equal(n, 32, 'no new attempt ID drawn'); return keysOnly(n); }, () => {},
    { ...options, attempt: !lost.ok ? lost.attempt : undefined });
  assert.deepEqual(writes[2], [1, ...request1], 'same attempt and credentials as before');
  assert.equal(result.ok, true);
  assert.equal(isUnsettled(result), false);
});

test('a write refused during the handshake (device busy with another phone) is a plain failure, not an unknown result', async () => {
  const { link, writes } = device([m2]);
  link.write = async () => { throw { code: 'InProgress', message: 'busy' }; }; // iOS rejects with plain objects
  const result = await run(link);
  assert.deepEqual(result, { ok: false, step: 'secure', reason: 'rejected', attempt: undefined }, 'busy, not an impostor');
  assert.equal(isUnsettled(result), false, 'nothing reached the device: a retry draws a new attempt');
  assert.equal(writes.length, 0);
});

test('a sensor without the provisioning characteristic (not staged) is reported before any write', async () => {
  const { link, writes } = device([m2]);
  link.retrieveServices = async () => ({ characteristics: [{ service: '3B0A90CE-9564-40D1-B96B-14CF8858ABA3', characteristic: '29B3765C-DE49-4114-889E-89B05852C968' }] });
  assert.deepEqual(await run(link), { ok: false, step: 'connect', reason: 'closed' });
  assert.equal(writes.length, 0);
});

test('a listed provisioning characteristic matches whatever the case of its UUID', async () => {
  const { link } = device([m2, accepted, response1, response2]);
  link.retrieveServices = async () => ({ characteristics: [{ service: '3B0A90CE-9564-40D1-B96B-14CF8858ABA3', characteristic: '3C2C02FA-847E-480C-9F22-B239DFA524C9' }] });
  assert.equal((await run(link)).ok, true);
});

test('a sensor that has not advertised its ID yet is not contacted, and the attempt can be retried', async () => {
  const { link, writes } = device([m2]);
  assert.deepEqual(await run(link, {}, ''), { ok: false, step: 'connect', reason: 'unidentified' });
  assert.equal(writes.length, 0, 'nothing was written');
  assert.ok(RETRIED.includes('unidentified'), 'a batch tries it again once its identity is heard');
});


test('stale local name cannot block a valid manufacturer identity and certificate', async () => {
  const { link, writes } = device([m2, accepted, response1, response2]);
  const result = await setup(link, 'id', { ...advertising(vectors.deviceId), localName: 'SENSOR-0000000000' },
    token, 'Ward-3', 'correct horse', scripted(), () => {}, options);
  assert.equal(result.ok, true);
  assert.deepEqual(writes, [[0, ...m1], [1, ...m3], [1, ...request1], [1, ...request2]]);
});

test('missing or malformed manufacturer identity is rejected before connecting', async () => {
  const cases: (Advertising | undefined)[] = [
    undefined, { localName: vectors.deviceId },
    { manufacturerData: { '004c': { bytes: [1, 0, 0, 0, 0, 1] } } },
    ...[[1, 0, 0], [1, 0, 0, 0, 0, 256], [9, 0, 0, 0, 0, 1]].map(bytes => ({ manufacturerData: { ffff: { bytes } } })),
  ];
  for (const advertised of cases) {
    const { link, writes } = device([m2]);
    link.connect = async () => { assert.fail('unidentified sensor must not be contacted'); };
    assert.deepEqual(await setup(link, 'id', advertised, token, 'Ward-3', 'correct horse', scripted(), () => {}, options),
      { ok: false, step: 'connect', reason: 'unidentified' });
    assert.equal(writes.length, 0);
  }
});

test('old firmware with state only is rejected before connecting and is not retried', async () => {
  const { link, writes } = device([m2]);
  link.connect = async () => { assert.fail('old firmware must not be contacted'); };
  assert.deepEqual(await setup(link, 'id', { manufacturerData: { ffff: { bytes: [1] } } },
    token, 'Ward-3', 'correct horse', scripted(), () => {}, options),
    { ok: false, step: 'connect', reason: 'old-firmware' });
  assert.equal(writes.length, 0);
  assert.equal(RETRIED.some(reason => reason === 'old-firmware'), false);
});
