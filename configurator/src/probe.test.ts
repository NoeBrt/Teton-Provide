/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changed, keepAdvertised, probe, sensorId, sensorLabel, sensorState, setUpLabel, type Advertising, type BleLink } from './probe.ts';

const text = (data: number[]) => String.fromCharCode(...data);

function fake(overrides: Partial<BleLink> = {}) {
  const calls: string[] = [];
  const link: BleLink = {
    connect: async () => { calls.push('connect'); },
    retrieveServices: async () => { calls.push('services'); return {}; },
    write: async (_id, _service, _characteristic, data) => { calls.push(`write:${text(data)}`); },
    read: async () => { calls.push('read'); return [...'world'].map(c => c.charCodeAt(0)); },
    disconnect: async () => { calls.push('disconnect'); },
    ...overrides,
  };
  return { link, calls };
}

test('writes hello, reads world, then disconnects', async () => {
  const { link, calls } = fake();
  const result = await probe(link, 'phone-1');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['connect', 'services', 'write:hello', 'read', 'disconnect']);
});

test('an empty or different reply fails at the read step', async () => {
  for (const reply of [[], [...'worle'].map(c => c.charCodeAt(0))]) {
    const { link, calls } = fake({ read: async () => reply });
    const result = await probe(link, 'phone-1');
    assert.deepEqual(result.ok ? null : [result.step, result.reason], ['read', 'unexpected-reply']);
    assert.equal(calls.at(-1), 'disconnect');
  }
});

test('a rejected write reports the step and the native message, then disconnects', async () => {
  const iosError = { code: 6, domain: 'CBATTErrorDomain', message: 'The request is not supported.' };
  for (const failure of [new Error('Request not supported'), iosError]) {
    const { link, calls } = fake({ write: async () => { throw failure; } });
    const result = await probe(link, 'phone-1');
    assert.deepEqual(result.ok ? null : [result.step, result.reason, result.detail], ['write', 'rejected', failure.message]);
    assert.equal(calls.at(-1), 'disconnect');
  }
});

test('a service lookup that never answers times out at the services step', { timeout: 1000 }, async () => {
  const { link, calls } = fake({ retrieveServices: () => new Promise(() => {}) });
  const result = await probe(link, 'phone-1', () => {}, 20);
  assert.deepEqual(result.ok ? null : [result.step, result.reason], ['services', 'timeout']);
  assert.deepEqual(calls, ['connect', 'disconnect']);
});

test('a disconnect that never answers does not hang the probe', { timeout: 1000 }, async () => {
  const { link } = fake({ disconnect: () => new Promise(() => {}) });
  const result = await probe(link, 'phone-1', () => {}, 20);
  assert.equal(result.ok, true);
});

test('a connection that never answers times out instead of hanging', { timeout: 1000 }, async () => {
  const { link, calls } = fake({ connect: () => new Promise(() => {}) });
  const steps: string[] = [];
  const result = await probe(link, 'phone-1', step => steps.push(step), 20);
  assert.deepEqual(result.ok ? null : [result.step, result.reason], ['connect', 'timeout']);
  assert.deepEqual(steps, ['connect']);
  assert.deepEqual(calls, ['disconnect']);
});

test('the advertised state byte (manufacturer data 0xFFFF) tells what a sensor is ready for', () => {
  const adv = (bytes: number[]) => ({ manufacturerData: { ffff: { bytes } } });
  assert.equal(sensorState(adv([0])), 'not-staged');
  assert.equal(sensorState(adv([1])), 'ready');
  assert.equal(sensorState(adv([2])), 'online');
  assert.equal(sensorState(adv([3])), 'offline');
  assert.equal(sensorState(adv([9])), null, 'unknown value');
  assert.equal(sensorState({ manufacturerData: { '004c': { bytes: [2] } } }), null, 'another company');
  assert.equal(sensorState(undefined), null, 'older firmware advertises nothing');
});

test('identity requires a complete manufacturer record and ignores names', () => {
  const adv = (bytes: number[]) => ({ localName: 'TETON-0000000000', manufacturerData: { ffff: { bytes } } });
  for (const state of [0, 1, 2, 3]) assert.equal(sensorId(adv([state, 0x7b, 9, 0xf2, 3, 0x39])), 'TETON-7B09F20339');
  for (const bytes of [[], [1], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6, 7], [4, 1, 2, 3, 4, 5],
    [1, -1, 2, 3, 4, 5], [1, 256, 2, 3, 4, 5], [1, 1.5, 2, 3, 4, 5], [1, NaN, 2, 3, 4, 5]]) {
    assert.equal(sensorId(adv(bytes)), null, `invalid record: ${bytes}`);
  }
  assert.equal(sensorId({ localName: 'TETON-7B09F20339' }), null);
  assert.equal(sensorId({ manufacturerData: { '004c': { bytes: [1, 0x7b, 9, 0xf2, 3, 0x39] } } }), null);
  assert.equal(sensorId(undefined), null);
  assert.equal(sensorLabel({ name: 'TETON-7B09F20339', advertising: { localName: 'TETON-7B09F20339' } }), 'Unnamed sensor');
  assert.equal(sensorLabel({ name: 'jetson-019', advertising: adv([1, 0x7b, 9, 0xf2, 3, 0x39]) }), 'TETON-7B09F20339');
});

test('redraw follows identity, state and signal, ignoring cached names', () => {
  const seen = (rssi: number, state = 1, id = 1, localName?: string) =>
    ({ rssi, advertising: { localName, manufacturerData: { ffff: { bytes: [state, 0, 0, 0, 0, id] } } } });
  assert.equal(changed(undefined, seen(-50)), true);
  assert.equal(changed(seen(-50), seen(-52)), false);
  assert.equal(changed(seen(-50), seen(-56)), true);
  assert.equal(changed(seen(-50), seen(-50, 2)), true);
  assert.equal(changed(seen(-50), seen(-50, 1, 2)), true);
  assert.equal(changed(seen(-50, 1, 1, 'old'), seen(-50, 1, 1, 'new')), false);
});

test('packets without manufacturer identity retain the last complete record atomically', () => {
  const before: { rssi: number; advertising: Advertising } = { rssi: -50, advertising: { localName: 'old', manufacturerData: { ffff: { bytes: [1, 0, 0, 0, 0, 1] } } } };
  const bare: { rssi: number; advertising: Advertising } = { rssi: -44, advertising: { localName: 'new', manufacturerData: { '004c': { bytes: [2] } } } };
  const merged = keepAdvertised(before, bare);
  assert.equal(sensorId(merged.advertising), 'TETON-0000000001');
  assert.equal(sensorState(merged.advertising), 'ready');
  assert.equal(merged.rssi, -44);
  assert.equal(merged.advertising.manufacturerData?.['004c'], undefined, 'unrelated manufacturer records are not retained');
  const update = { rssi: -40, advertising: { manufacturerData: { ffff: { bytes: [2, 0, 0, 0, 0, 2] } } } };
  const replaced = keepAdvertised(before, update);
  assert.equal(sensorState(replaced.advertising), 'online');
  assert.equal(sensorId(replaced.advertising), 'TETON-0000000002');
  const malformed = { rssi: -40, advertising: { manufacturerData: { ffff: { bytes: [1] } } } };
  assert.equal(sensorId(keepAdvertised(before, malformed).advertising), null, 'a new record is not patched with an old ID');
  assert.equal(keepAdvertised(undefined, bare), bare);
});

test('a sensor that already joined a network offers Reconfigure, in the card and the menu-bar panel alike', () => {
  assert.equal(setUpLabel('ready'), 'Set up');
  assert.equal(setUpLabel('not-staged'), 'Set up');
  assert.equal(setUpLabel(null), 'Set up');
  assert.equal(setUpLabel('online'), 'Reconfigure');
  assert.equal(setUpLabel('offline'), 'Reconfigure');
  assert.equal(setUpLabel('ready', true), 'Reconfigure', 'set up here: the scan has not heard the new state yet');
  assert.equal(setUpLabel('ready', false), 'Set up');
});
