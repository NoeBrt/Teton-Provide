/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { SetupFlow } from './flow.ts';
import type { Token } from './authority.ts';
import type { SetupResult } from './setup.ts';

const site = { ssid: 'Ward-3', password: 'correct horse' };
const token: Token = { bytes: new Uint8Array(0), name: 'Noé', customers: ['DEMO'], expires: 4_102_444_800, holder: new Uint8Array(32), holderPrivate: new Uint8Array(32) };
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

test('a result that ends after the app locked the network neither breaks the retry nor keeps the password', () => {
  const flow = ready();
  flow.request('s1');
  flow.network = null; // the app was left (or the site forgotten) during the join
  flow.token = null;
  flow.finished('s1', lost);
  assert.ok(!inspect(flow, { depth: null }).includes(site.password), 'no copy of the password left in the flow');
  flow.tokenReady(token);
  flow.networkSaved(site);
  const retry = flow.request('s1');
  assert.equal(retry.kind === 'join' && retry.attempt, attempt, 'same network: the sensor can answer the lost attempt');
});

test('an expired technician code counts as missing', () => {
  const flow = new SetupFlow(site);
  flow.tokenReady({ ...token, expires: 1 });
  assert.deepEqual(flow.request('s1'), { kind: 'ask-token' });
});

test('a batch never asks: locked credentials or an expired code stop it', () => {
  const noToken = new SetupFlow(site);
  assert.deepEqual(noToken.batchRequest('s1'), { kind: 'stop', reason: 'locked' });
  const noNetwork = new SetupFlow(null);
  noNetwork.tokenReady(token);
  assert.deepEqual(noNetwork.batchRequest('s1'), { kind: 'stop', reason: 'locked' });
  const old = new SetupFlow(site);
  old.tokenReady({ ...token, expires: 1 });
  assert.deepEqual(old.batchRequest('s1'), { kind: 'stop', reason: 'token-expired' });
  // Nothing waits: credentials arriving later resume no sensor.
  assert.equal(noToken.tokenReady(token), null);
  assert.equal(noNetwork.networkSaved(site), null);
  assert.equal(old.tokenReady(token), null);
  const flow = ready();
  assert.equal(flow.batchRequest('s1').kind, 'join');
  assert.equal(flow.batchRequest('s1').kind, 'busy');
});

test('a lost result keeps no copy of the password once the app drops the network', () => {
  const flow = ready();
  flow.request('s1');
  flow.finished('s1', lost);
  flow.network = null; // the app was left after the join ended
  assert.ok(!inspect(flow, { depth: null }).includes(site.password));
});

test('another network with the same password starts a fresh attempt', () => {
  const flow = ready();
  flow.request('s1');
  flow.finished('s1', lost);
  flow.networkSaved({ ssid: 'Ward-4', password: site.password });
  const next = flow.request('s1');
  assert.equal(next.kind === 'join' && next.attempt, undefined);
});
