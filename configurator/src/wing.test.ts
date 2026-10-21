/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupOf, minutesLeft } from './wing.ts';

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
