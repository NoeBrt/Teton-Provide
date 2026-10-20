/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATCH_CONCURRENCY, runBatch, type BatchEntry } from './batch.ts';
import type { SetupFailure, SetupResult } from './setup.ts';

const sensors = Array.from({ length: 200 }, (_, i) => `TETON-${String(i).padStart(10, '0')}`);
const tick = () => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 3)));

/** A fake fleet: each sensor answers after a short random delay, with `failure(index)` or success. */
function fleet(failure: (index: number) => SetupFailure | null) {
  let running = 0;
  let peak = 0;
  const started: string[] = [];
  const setupOne = async (id: string): Promise<SetupResult> => {
    started.push(id);
    const reason = failure(sensors.indexOf(id));
    // A refusal answers at once, so sensors in flight cannot overtake it and the stop tests are not timing-dependent.
    if (reason) return { ok: false, step: 'join', reason };
    peak = Math.max(peak, ++running);
    await tick();
    running--;
    return { ok: true, ipv4: '10.0.0.2', attempt: new Uint8Array(16) };
  };
  return { setupOne, started, peak: () => peak };
}

const record = () => {
  const last = new Map<string, BatchEntry>();
  return { last, onChange: (id: string, entry: BatchEntry) => last.set(id, entry) };
};

test('200 sensors, three at a time, all set up', async () => {
  const { setupOne, peak } = fleet(() => null);
  const { last, onChange } = record();
  const summary = await runBatch(sensors, setupOne, onChange);
  assert.deepEqual(summary, { ok: 200, failed: 0, stopped: 0 });
  assert.equal(peak(), BATCH_CONCURRENCY, 'never more than three links at once');
  assert.ok([...last.values()].every(entry => entry.state === 'ok' && entry.ipv4 === '10.0.0.2'));
});

test('failures that belong to one sensor do not stop the batch', async () => {
  const { setupOne } = fleet(i => (i % 7 === 0 ? 'NotInRange' : i % 13 === 0 ? 'not-genuine' : i % 17 === 0 ? 'timeout' : null));
  const { last, onChange } = record();
  const summary = await runBatch(sensors, setupOne, onChange);
  const failed = sensors.filter((_, i) => i % 7 === 0 || i % 13 === 0 || i % 17 === 0).length;
  assert.deepEqual(summary, { ok: 200 - failed, failed, stopped: 0 });
  assert.equal(last.get(sensors[13])?.reason, 'not-genuine', 'each failure keeps its reason for the list');
});

test('a wrong site password stops new starts; sensors already running finish', async () => {
  const { setupOne, started } = fleet(i => (i === 10 ? 'WrongPsk' : null));
  const { last, onChange } = record();
  const summary = await runBatch(sensors, setupOne, onChange);
  assert.equal(summary.stopReason, 'WrongPsk');
  assert.equal(summary.ok + summary.failed + summary.stopped, 200, 'every sensor accounted for');
  assert.ok(started.length <= 11 + BATCH_CONCURRENCY, `started ${started.length}: at most the ones already in flight`);
  assert.ok(summary.stopped >= 200 - 11 - BATCH_CONCURRENCY);
  assert.ok([...last.values()].every(entry => entry.state !== 'running' && entry.state !== 'queued'), 'nothing left hanging');
  assert.equal(last.get(sensors[199])?.state, 'stopped');
  assert.equal(last.get(sensors[199])?.reason, 'WrongPsk', 'the list says why it was not tried');
});

test('an expired token stops the batch at the first sensor', async () => {
  const { setupOne, started } = fleet(() => 'token-expired');
  const summary = await runBatch(sensors, setupOne, record().onChange);
  assert.equal(summary.stopReason, 'token-expired');
  assert.ok(started.length <= BATCH_CONCURRENCY);
});

test('a setup that throws counts as a failed sensor, not a broken batch', async () => {
  const summary = await runBatch(['a', 'b'], async id => { if (id === 'a') throw new Error('boom'); return { ok: true, ipv4: '10.0.0.3', attempt: new Uint8Array(16) }; }, () => {});
  assert.deepEqual(summary, { ok: 1, failed: 1, stopped: 0 });
});

test('a setup that throws before returning a promise is one failed sensor, and the batch still ends', async () => {
  const { last, onChange } = record();
  const setupOne = (id: string): Promise<SetupResult> => {
    if (id === 'a') throw new Error('boom');
    return Promise.resolve({ ok: true, ipv4: '10.0.0.3', attempt: new Uint8Array(16) });
  };
  const summary = await runBatch(['a', 'b'], setupOne, onChange);
  assert.deepEqual(summary, { ok: 1, failed: 1, stopped: 0 });
  assert.equal(last.get('a')?.state, 'failed', 'not left running');
});

test('code and site password locked mid-batch (app left): the batch stops instead of failing every sensor', async () => {
  const { setupOne, started } = fleet(i => (i >= 10 ? 'locked' : null));
  const { last, onChange } = record();
  const summary = await runBatch(sensors, setupOne, onChange);
  assert.equal(summary.stopReason, 'locked');
  assert.ok(summary.failed <= BATCH_CONCURRENCY, `${summary.failed} failed: only the ones taken before the stop`);
  assert.ok(started.length <= 10 + BATCH_CONCURRENCY);
  assert.equal(summary.ok + summary.failed + summary.stopped, 200);
  assert.deepEqual(last.get(sensors[199]), { state: 'stopped', reason: 'locked' });
});

test('the first failure that stops a batch is the one reported', async () => {
  const setupOne = async (id: string): Promise<SetupResult> => {
    if (id === 'b') return { ok: false, step: 'join', reason: 'WrongPsk' };
    await new Promise(resolve => setTimeout(resolve, 5));
    return { ok: false, step: 'connect', reason: 'locked' };
  };
  const summary = await runBatch(['a', 'b'], setupOne, () => {}, 2);
  assert.equal(summary.stopReason, 'WrongPsk');
});
