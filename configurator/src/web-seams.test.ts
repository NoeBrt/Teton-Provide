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

test('a question with a choice runs the chosen button, or the cancel one', () => {
  const ran: string[] = [];
  const buttons = [{ text: 'Stay', style: 'cancel' as const, onPress: () => ran.push('stay') }, { text: 'Leave', onPress: () => ran.push('leave') }];
  const g = globalThis as { confirm?: (message: string) => boolean };
  g.confirm = () => true;
  ask('Leave the demo?', 'Back to the sensors around you.', buttons);
  g.confirm = () => false;
  ask('Leave the demo?', 'Back to the sensors around you.', buttons);
  assert.deepEqual(ran, ['leave', 'stay']);
});
