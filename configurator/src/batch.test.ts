/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATCH_CONCURRENCY, RETRIES, runBatch, type BatchControl, type BatchEntry } from './batch.ts';
import type { SetupFailure, SetupResult } from './setup.ts';

const sensors = Array.from({ length: 200 }, (_, i) => `SENSOR-${String(i).padStart(10, '0')}`);
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

test('200 sensors, BATCH_CONCURRENCY at a time, all set up', async () => {
  const { setupOne, peak } = fleet(() => null);
  const { last, onChange } = record();
  const summary = await runBatch(sensors, setupOne, onChange);
  assert.deepEqual(summary, { ok: 200, failed: 0, stopped: 0 });
  assert.equal(peak(), BATCH_CONCURRENCY, 'never more links at once than BATCH_CONCURRENCY');
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

test('a stop marks the queue at once, while a sensor still in progress has not finished', async () => {
  let release = () => {};
  const slow = new Promise<void>(resolve => { release = resolve; });
  const { last, onChange } = record();
  const done = runBatch(sensors.slice(0, 20), async id => {
    if (id === sensors[0]) { await slow; return { ok: true, ipv4: '10.0.0.2', attempt: new Uint8Array(16) }; }
    return { ok: false, step: 'secure', reason: 'WrongPsk' };
  }, onChange);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(last.get(sensors[0])?.state, 'running', 'still joining');
  assert.deepEqual(last.get(sensors[19]), { state: 'stopped', reason: 'WrongPsk' }, 'not counted as waiting any more');
  assert.equal(last.get(sensors[1])?.step, 'secure', 'a failure keeps the step it failed at');
  release();
  assert.equal((await done).stopped, 20 - BATCH_CONCURRENCY);
});

test('a link failure goes back to the queue, and counts as failed only after its retries', async () => {
  const calls = new Map<string, number>();
  const { last, onChange } = record();
  const summary = await runBatch(['flaky', 'gone', 'wifi'], async id => {
    const n = (calls.get(id) ?? 0) + 1;
    calls.set(id, n);
    if (id === 'flaky' && n === 1) return { ok: false, step: 'connect', reason: 'timeout' };
    if (id === 'gone') return { ok: false, step: 'connect', reason: 'timeout' };
    if (id === 'wifi') return { ok: false, step: 'join', reason: 'NotInRange' };
    return { ok: true, ipv4: '10.0.0.2', attempt: new Uint8Array(16) };
  }, onChange);
  assert.deepEqual(summary, { ok: 1, failed: 2, stopped: 0 });
  assert.equal(calls.get('flaky'), 2, 'retried once, then set up');
  assert.equal(calls.get('gone'), 1 + RETRIES, 'out of range: tried, then retried RETRIES times');
  assert.equal(calls.get('wifi'), 1, 'a Wi-Fi failure is final');
  assert.equal(last.get('gone')?.state, 'failed');
});

test('sensors found while the batch runs join its queue, within the same number of links', async () => {
  const { setupOne, started, peak } = fleet(() => null);
  const { last, onChange } = record();
  const control: BatchControl = {};
  const done = runBatch(sensors.slice(0, 10), setupOne, onChange, BATCH_CONCURRENCY, control);
  await new Promise(resolve => setTimeout(resolve, 1));
  control.add?.(sensors.slice(10, 20));
  const summary = await done;
  assert.deepEqual(summary, { ok: 20, failed: 0, stopped: 0 });
  assert.equal(started.length, 20);
  assert.ok(peak() <= BATCH_CONCURRENCY);
  assert.equal(last.get(sensors[19])?.state, 'ok');
  assert.equal(control.add, undefined, 'nothing can be added once it has ended');
});

test('a link failure after a stop is final: every sensor ends counted, none left waiting', async () => {
  let release = () => {};
  const slow = new Promise<void>(resolve => { release = resolve; });
  const { last, onChange } = record();
  const ids = sensors.slice(0, 12);
  const done = runBatch(ids, async id => {
    if (id === ids[1]) return { ok: false, step: 'join', reason: 'WrongPsk' };
    if (id === ids[0]) { await slow; return { ok: false, step: 'connect', reason: 'timeout' }; }
    return { ok: true, ipv4: '10.0.0.2', attempt: new Uint8Array(16) };
  }, onChange);
  await new Promise(resolve => setTimeout(resolve, 5));
  release();
  const summary = await done;
  assert.equal(summary.ok + summary.failed + summary.stopped, ids.length);
  assert.ok(ids.every(id => !['queued', 'running'].includes(last.get(id)!.state)), 'nothing left waiting');
  assert.equal(last.get(ids[0])?.state, 'failed');
});
