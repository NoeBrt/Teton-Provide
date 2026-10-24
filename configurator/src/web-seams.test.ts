/// <reference types="node" />
// The desktop (web) side of the platform seams: same calls as on iOS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from './secureStore.web.ts';
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
