/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectMenuBar, type MenuBarApi, type MenuAction, type MenuSnapshot } from './menuBar.ts';

function fakeApi() {
  const listeners = new Map<string, (event: { payload: never }) => void>();
  const sent: unknown[][] = [];
  const api: MenuBarApi = {
    event: {
      listen: async (name, cb) => { listeners.set(name, cb); return () => { listeners.delete(name); }; },
      emitTo: async (...args) => { sent.push(args); },
    },
    core: { invoke: async () => undefined as never },
  };
  return { api, listeners, sent, emit: (name: string, payload: unknown) => listeners.get(name)?.({ payload: payload as never }) };
}

const snapshot: MenuSnapshot = { demo: false, bluetooth: 'Bluetooth on', site: null, canRefresh: true, refresh: 'idle', canSetUpAll: false, sensors: [] };

test('a panel opened later gets the current state; actions reach the existing app once', async () => {
  const fake = fakeApi();
  let current = snapshot;
  const actions: MenuAction[] = [];
  const connection = connectMenuBar(fake.api, () => current, action => { actions.push(action); });
  await connection.ready;
  current = { ...snapshot, demo: true };
  fake.emit('provide-menu-ready', null);
  await Promise.resolve();
  assert.deepEqual(fake.sent.at(-1), ['menubar', 'provide-menu-state', current]);
  fake.emit('provide-menu-action', { kind: 'refresh' });
  assert.deepEqual(actions, [{ kind: 'refresh' }]);
  connection.dispose();
  fake.emit('provide-menu-action', { kind: 'refresh' });
  assert.equal(actions.length, 1);
  assert.equal(fake.listeners.size, 0);
});

test('closing or switching modes during subscription setup leaves no listeners behind', async () => {
  const fake = fakeApi();
  const connection = connectMenuBar(fake.api, () => snapshot, () => assert.fail('disposed listener'));
  connection.dispose();
  await connection.ready;
  assert.equal(fake.listeners.size, 0);
  await connection.publish();
  assert.equal(fake.sent.length, 0, 'a disposed mode must not overwrite the panel with its old state');
});
