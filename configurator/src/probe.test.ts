/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe, type BleLink } from './probe.ts';

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
