/// <reference types="node" />
// The desktop Bluetooth seam: react-native-ble-manager's calls over the Tauri bridge (desktop/src-tauri/src/ble.rs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridge, type Tauri } from './ble.web.ts';
import { sensorId } from './probe.ts';

function fakeTauri() {
  const calls: [string, unknown][] = [];
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const tauri: Tauri = {
    core: { invoke: async (cmd, args) => { calls.push([cmd, args]); return (cmd === 'ble_read' ? [119, 111] : cmd === 'ble_state' ? 'on' : undefined) as never; } },
    event: { listen: async (name, cb) => { listeners.set(name, cb as never); return () => listeners.delete(name); } },
  };
  return { tauri, calls, emit: (name: string, payload: unknown) => listeners.get(name)?.({ payload }), listeners };
}

test('an advertisement reaches the app as a react-native-ble-manager peripheral', async () => {
  const { tauri, emit } = fakeTauri();
  const ble = bridge(tauri);
  const heard: unknown[] = [];
  ble.onDiscoverPeripheral(p => heard.push(p));
  await new Promise(resolve => setTimeout(resolve));
  emit('ble-discover', { id: 'A', name: 'FLWR-O-019', advertised: 'IOT-AFD042F349', rssi: -61, manufacturer: { ffff: [1, 0x7b, 9, 0xf2, 3, 0x39] } });
  emit('ble-discover', { id: 'B', name: 'FLWR-O-019', advertised: null, rssi: null, manufacturer: {} });
  assert.deepEqual(heard, [
    { id: 'A', name: 'FLWR-O-019', rssi: -61, advertising: { localName: 'IOT-AFD042F349', manufacturerData: { ffff: { bytes: [1, 0x7b, 9, 0xf2, 3, 0x39] } } } },
    // The system's cached name is never passed off as the advertised one.
    { id: 'B', name: 'FLWR-O-019', rssi: 127, advertising: { localName: undefined, manufacturerData: {} } },
  ]);
  assert.equal(sensorId((heard[0] as { advertising: Parameters<typeof sensorId>[0] }).advertising), 'IOT-7B09F20339');
});

test('scan, write, read and state go to the matching commands; remove stops listening', async () => {
  const { tauri, calls, emit, listeners } = fakeTauri();
  const ble = bridge(tauri);
  let stops = 0;
  const sub = ble.onStopScan(() => stops++);
  await new Promise(resolve => setTimeout(resolve));
  await ble.scan({ serviceUUIDs: ['3b0a90ce-9564-40d1-b96b-14cf8858aba3'], seconds: 5, allowDuplicates: true });
  await ble.write('A', 's', 'c', [1, 2], 513);
  assert.deepEqual(await ble.read('A', 's', 'c'), [119, 111]);
  assert.equal(await ble.checkState(), 'on');
  emit('ble-stop', null);
  sub.remove();
  assert.equal(listeners.has('ble-stop'), false);
  assert.equal(stops, 1);
  assert.deepEqual(calls.slice(0, 3), [
    ['ble_scan', { services: ['3b0a90ce-9564-40d1-b96b-14cf8858aba3'], seconds: 5 }],
    ['ble_write', { id: 'A', service: 's', characteristic: 'c', data: [1, 2] }],
    ['ble_read', { id: 'A', service: 's', characteristic: 'c' }],
  ]);
});
