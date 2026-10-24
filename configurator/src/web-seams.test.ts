/// <reference types="node" />
// The desktop (web) side of the platform seams: same calls as on iOS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from './secureStore.web.ts';
import { secretStore } from './secureStore.web.ts';
import { ask } from './ask.web.ts';

test('the secure store keeps, replaces and forgets a value', async () => {
  assert.equal(await store.getItemAsync('k', { keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY }), null);
  await store.setItemAsync('k', 'one');
  await store.setItemAsync('k', 'two', { requireAuthentication: true });
  assert.equal(await store.getItemAsync('k'), 'two');
  await store.deleteItemAsync('k');
  assert.equal(await store.getItemAsync('k'), null);
  assert.equal(store.canUseBiometricAuthentication(), true, 'the keychain protects it, no biometric gate');
});

test('a question runs its choice: the desktop window answers "cancel" to every confirm() and shows no dialog', () => {
  const ran: string[] = [];
  (globalThis as { confirm?: () => boolean }).confirm = () => false; // what WKWebView does without a dialog
  ask('Demo with simulated sensors', '200 simulated sensors.', [{ text: 'Cancel', style: 'cancel', onPress: () => ran.push('cancel') }, { text: 'Start the demo', onPress: () => ran.push('demo') }]);
  ask('Leave the demo?', 'Back to the sensors around you.', [{ text: 'Stay', style: 'cancel', onPress: () => ran.push('stay') }, { text: 'Leave', onPress: () => ran.push('leave') }]);
  assert.deepEqual(ran, ['demo', 'leave']);
});

test('in the desktop window, secrets go to the system keychain and survive a restart', async () => {
  const keychain = new Map<string, string>();
  const calls: string[] = [];
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(cmd);
    const key = String(args?.key);
    if (cmd === 'secret_set') keychain.set(key, String(args?.value));
    if (cmd === 'secret_delete') keychain.delete(key);
    return (cmd === 'secret_get' ? keychain.get(key) ?? null : undefined) as T;
  };
  await secretStore(invoke).set('technician-token', 'code');
  assert.equal(await secretStore(invoke).get('technician-token'), 'code', 'a new window (a restart) reads it back');
  await secretStore(invoke).delete('technician-token');
  assert.equal(await secretStore(invoke).get('technician-token'), null);
  assert.deepEqual(calls, ['secret_set', 'secret_get', 'secret_delete', 'secret_get']);
});
