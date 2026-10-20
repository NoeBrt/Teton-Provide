/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SetupFlow } from './flow.ts';
import type { Label } from './noise.ts';
import type { SetupResult } from './setup.ts';

const site = { ssid: 'Ward-3', password: 'correct horse' };
const label = (deviceId = 'TETON-DEMO-001'): Label => ({ deviceId, devicePublic: new Uint8Array(32), secret: new Uint8Array(32) });
const attempt = new Uint8Array(16).fill(7);
const lost: SetupResult = { ok: false, step: 'join', reason: 'timeout', attempt };

test('first setup: asks for the site Wi-Fi once, then the label, then joins', () => {
  const flow = new SetupFlow(null);
  assert.deepEqual(flow.request('s1'), { kind: 'ask-network' });
  // Bug 1 (review): saving the network must resume this sensor, not ask for the network again.
  assert.deepEqual(flow.networkSaved(site), { kind: 'scan-label', sensorId: 's1' });
  assert.deepEqual(flow.labelScanned('s1', label()), { kind: 'join', sensorId: 's1', label: label(), site, attempt: undefined });
});

test('a label scanned twice starts the setup only once', () => {
  // Bug 2 (review): the camera reports the same QR several times before the scanner closes.
  const flow = new SetupFlow(site);
  flow.request('s1');
  assert.equal(flow.labelScanned('s1', label())?.kind, 'join');
  assert.equal(flow.labelScanned('s1', label()), null);
  assert.equal(flow.request('s1').kind, 'busy', 'no second setup while one runs');
});

test('a label that failed the handshake is forgotten, so the next tap rescans', () => {
  // Bug 3 (review): the cached wrong label used to be reused forever.
  const flow = new SetupFlow(site);
  flow.request('s1');
  flow.labelScanned('s1', label());
  flow.finished('s1', { ok: false, step: 'secure', reason: 'not-authenticated' });
  assert.deepEqual(flow.request('s1'), { kind: 'scan-label', sensorId: 's1' });
});

test('a known label is reused for a retry, without scanning again', () => {
  const flow = new SetupFlow(site);
  flow.request('s1');
  flow.labelScanned('s1', label());
  flow.finished('s1', { ok: false, step: 'join', reason: 'WrongPsk', attempt });
  assert.equal(flow.request('s1').kind, 'join');
});

test('after a lost result, a retry with the same network reuses the attempt; a changed network does not', () => {
  const flow = new SetupFlow(site);
  flow.request('s1');
  flow.labelScanned('s1', label());
  flow.finished('s1', lost);
  const retry = flow.request('s1');
  assert.equal(retry.kind === 'join' && retry.attempt, attempt);
  flow.finished('s1', lost);
  flow.networkSaved({ ssid: 'Ward-3', password: 'fixed password' });
  const changed = flow.request('s1');
  assert.equal(changed.kind === 'join' && changed.attempt, undefined);
});

test('a scan for another sensor, or after cancel, is ignored', () => {
  const flow = new SetupFlow(site);
  flow.request('s1');
  assert.equal(flow.labelScanned('s2', label()), null);
  flow.cancelScan();
  assert.equal(flow.labelScanned('s1', label()), null);
});

test('cancelling the network form forgets the waiting sensor', () => {
  const flow = new SetupFlow(null);
  flow.request('s1');
  flow.cancelNetwork();
  assert.equal(flow.networkSaved(site), null);
});
