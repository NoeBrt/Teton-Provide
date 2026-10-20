/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SetupFlow } from './flow.ts';
import type { Token } from './authority.ts';
import type { SetupResult } from './setup.ts';

const site = { ssid: 'Ward-3', password: 'correct horse' };
const token: Token = { bytes: new Uint8Array(0), name: 'Noé', customers: ['DEMO'], expires: 4_102_444_800 };
const attempt = new Uint8Array(16).fill(7);
const lost: SetupResult = { ok: false, step: 'join', reason: 'timeout', attempt };

const ready = () => {
  const flow = new SetupFlow(site);
  flow.tokenReady(token);
  return flow;
};

test('first setup: asks for the technician token, then the site Wi-Fi, then joins, each once', () => {
  const flow = new SetupFlow(null);
  assert.deepEqual(flow.request('s1'), { kind: 'ask-token' });
  // Bug 1 (review, kept): saving must resume this sensor, not ask again.
  assert.deepEqual(flow.tokenReady(token), { kind: 'ask-network' });
  assert.deepEqual(flow.networkSaved(site), { kind: 'join', sensorId: 's1', site, attempt: undefined });
  assert.equal(flow.request('s2').kind, 'join', 'the next sensor needs neither again');
});

test('several sensors run at once, but one sensor never twice', () => {
  const flow = ready();
  assert.equal(flow.request('s1').kind, 'join');
  assert.equal(flow.request('s2').kind, 'join', 'a batch runs sensors side by side');
  assert.equal(flow.request('s1').kind, 'busy');
  flow.finished('s1', { ok: true, ipv4: '10.0.0.2', attempt });
  assert.equal(flow.request('s1').kind, 'join', 'free again once finished');
});

test('after a lost result, a retry with the same network reuses the attempt; a changed network does not', () => {
  const flow = ready();
  flow.request('s1');
  flow.finished('s1', lost);
  const retry = flow.request('s1');
  assert.equal(retry.kind === 'join' && retry.attempt, attempt);
  flow.finished('s1', lost);
  flow.networkSaved({ ssid: 'Ward-3', password: 'fixed password' });
  const changed = flow.request('s1');
  assert.equal(changed.kind === 'join' && changed.attempt, undefined);
});

test('a settled failure starts a fresh attempt next time', () => {
  const flow = ready();
  flow.request('s1');
  flow.finished('s1', { ok: false, step: 'join', reason: 'WrongPsk', attempt });
  const next = flow.request('s1');
  assert.equal(next.kind === 'join' && next.attempt, undefined);
});

test('closing the token or network sheet forgets the waiting sensor', () => {
  const flow = new SetupFlow(null);
  flow.request('s1');
  flow.cancelWaiting();
  assert.equal(flow.tokenReady(token), null);
  flow.request('s1');
  flow.cancelWaiting();
  assert.equal(flow.networkSaved(site), null);
});
