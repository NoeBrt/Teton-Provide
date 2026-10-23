/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changed, keepAdvertised, probe, sensorState, type BleLink } from './probe.ts';

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

test('a rediscovered sensor is redrawn only when its state, name or signal (5 dB or more) changed', () => {
  const seen = (rssi: number, state?: number, localName?: string) =>
    ({ rssi, advertising: { localName, manufacturerData: state === undefined ? undefined : { ffff: { bytes: [state] } } } });
  assert.equal(changed(undefined, seen(-50, 1)), true, 'first sighting');
  assert.equal(changed(seen(-50, 1, 'TETON-DEMO-001'), seen(-52, 1, 'TETON-DEMO-001')), false, 'same state, small signal change');
  assert.equal(changed(seen(-50, 1, 'TETON-DEMO-001'), seen(-56, 1, 'TETON-DEMO-001')), true, 'signal moved 6 dB');
  assert.equal(changed(seen(-50, 1, 'TETON-DEMO-001'), seen(-50, 2, 'TETON-DEMO-001')), true, 'set up');
  assert.equal(changed(seen(-50, 1), seen(-50, 1, 'TETON-DEMO-001')), true, 'name from the scan response');
});

test('a packet without the name or the state keeps the ones last advertised (scan response vs advertisement)', () => {
  type Heard = { id: string; name?: string; rssi: number; advertising: { localName?: string; manufacturerData?: Record<string, { bytes: number[] }> } };
  const named: Heard = { id: 'A', name: 'FLWR-O-019', rssi: -50, advertising: { localName: 'TETON-7B09F20339', manufacturerData: { ffff: { bytes: [1] } } } };
  const bare: Heard = { id: 'A', name: 'FLWR-O-019', rssi: -44, advertising: {} };
  const merged = keepAdvertised(named, bare);
  assert.equal(merged.advertising.localName, 'TETON-7B09F20339', 'not the cached host name');
  assert.equal(sensorState(merged.advertising), 'ready');
  assert.equal(merged.rssi, -44, 'the signal is the newest');
  const update: Heard = { id: 'A', rssi: -40, advertising: { localName: 'TETON-7B09F20339', manufacturerData: { ffff: { bytes: [2] } } } };
  assert.equal(sensorState(keepAdvertised(named, update).advertising), 'online', 'a new state replaces the old one');
  assert.equal(keepAdvertised(undefined, bare), bare);
});
