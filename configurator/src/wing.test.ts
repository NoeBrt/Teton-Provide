/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupOf, minutesLeft, isGone, wasReset, without, STALE_MS } from './wing.ts';

test('each sensor is in one group: the batch result first, then what it advertises', () => {
  assert.equal(groupOf('ready', { state: 'ok', ipv4: '10.0.0.2' }), 'done');
  assert.equal(groupOf('ready', { state: 'failed', reason: 'NotInRange' }), 'failed');
  assert.equal(groupOf('ready', { state: 'stopped', reason: 'locked' }), 'failed', 'not tried counts as an error');
  assert.equal(groupOf('ready', { state: 'running' }), 'left');
  assert.equal(groupOf('ready', { state: 'queued' }), 'left');
  assert.equal(groupOf('online', { state: 'failed', reason: 'Timeout' }), 'failed', 'this session’s result wins');
  assert.equal(groupOf('offline', { state: 'ok', ipv4: '10.0.0.2' }), 'failed', 'joined, then dropped off its Wi-Fi');
  assert.equal(groupOf('online', undefined), 'done', 'set up before');
  assert.equal(groupOf('offline', undefined), 'failed', 'set up but not on its Wi-Fi');
  assert.equal(groupOf('ready', undefined), 'left');
  assert.equal(groupOf('not-staged', undefined), 'left');
  assert.equal(groupOf(null, undefined), 'left');
});

test('the time left appears once ten sensors have finished', () => {
  assert.equal(minutesLeft(0, 60_000, 9, 50), null);
  assert.equal(minutesLeft(0, 10 * 60_000, 100, 50), 5, '100 in 10 min: 50 more take 5');
  assert.equal(minutesLeft(0, 60_000, 20, 0), null, 'nothing left');
});

test('refresh drops a sensor gone quiet, unless it is still queued or running', () => {
  const now = 100_000;
  const quiet = now - STALE_MS - 1;
  assert.equal(isGone(quiet, now, undefined, false), true);
  assert.equal(isGone(now - 1000, now, undefined, false), false, 'heard a second ago');
  assert.equal(isGone(undefined, now, undefined, false), true, 'never heard');
  assert.equal(isGone(quiet, now, undefined, true), false, 'a test is running on it');
  assert.equal(isGone(quiet, now, { state: 'queued' }, false), false);
  assert.equal(isGone(quiet, now, { state: 'running' }, false), false);
  for (const state of ['ok', 'failed', 'stopped'] as const) {
    assert.equal(isGone(quiet, now, { state }, false), true, `a finished result (${state}) does not keep an absent sensor`);
  }
});

test('a sensor reset after a finished result is offered again: its advertisement turns back to ready', () => {
  for (const state of ['ok', 'failed', 'stopped'] as const) {
    assert.equal(wasReset('online', 'ready', { state }), true, `${state}, then reset`);
    assert.equal(wasReset('offline', 'ready', { state }), true);
  }
  assert.equal(wasReset('ready', 'ready', { state: 'failed', reason: 'not-genuine' }), false, 'still the same advertisement');
  assert.equal(wasReset(undefined, 'ready', { state: 'ok' }), false, 'no earlier advertisement to compare');
  assert.equal(wasReset('ready', 'online', { state: 'ok' }), false, 'just set up');
  assert.equal(wasReset('online', 'ready', { state: 'running' }), false, 'a run in progress keeps its entry');
  assert.equal(wasReset('online', 'ready', { state: 'queued' }), false);
  assert.equal(wasReset('online', 'ready', undefined), false);
});

test('a sensor Refresh drops leaves its result behind: back and reset, it is offered again', () => {
  const batch = { a: { state: 'ok' as const }, b: { state: 'failed' as const, reason: 'NotInRange' as const } };
  assert.deepEqual(without(batch, ['a']), { b: batch.b });
  assert.equal(without(batch, []), batch, 'nothing dropped: the same map, so React skips a render');
});
