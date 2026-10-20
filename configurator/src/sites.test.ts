/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWifiQr, removeSite, upsertSite, type Site } from './sites.ts';

const nord: Site = { id: 'a', name: 'Hôpital Nord – Bât. B', ssid: 'HN-B-Staff' };
const sud: Site = { id: 'b', name: 'Clinique Sud', ssid: 'CS-IoT' };

test('a new site goes first, so the latest one is the easiest to pick', () => {
  assert.deepEqual(upsertSite([nord], sud), [sud, nord]);
});

test('editing a site replaces it in place of its old entry, first in the list', () => {
  const renamed = { ...nord, name: 'Hôpital Nord – Bât. C' };
  assert.deepEqual(upsertSite([sud, nord], renamed), [renamed, sud]);
});

test('forgetting a site removes only that one', () => {
  assert.deepEqual(removeSite([sud, nord], 'b'), [nord]);
  assert.deepEqual(removeSite([nord], 'missing'), [nord]);
});

const ward3 = { ssid: 'Ward-3', password: 'correct horse' };

test('Wi-Fi QR: reads the network and password of the standard format, fields in any order', () => {
  assert.deepEqual(parseWifiQr('WIFI:T:WPA;S:Ward-3;P:correct horse;;'), ward3);
  assert.deepEqual(parseWifiQr('WIFI:S:Ward-3;H:false;P:correct horse;T:WPA;;'), ward3, 'Android order, hidden flag');
  assert.deepEqual(parseWifiQr('WIFI:S:Ward-3;P:correct horse;;'), ward3, 'no type means WPA');
});

test('Wi-Fi QR: undoes backslash escapes and optional quotes', () => {
  assert.deepEqual(parseWifiQr('WIFI:T:WPA;S:Caf\\;e\\:3;P:a\\\\b\\,c\\"d1234;;'), { ssid: 'Caf;e:3', password: 'a\\b,c"d1234' });
  assert.deepEqual(parseWifiQr('WIFI:T:WPA;S:"0123";P:"abcdef12";;'), { ssid: '0123', password: 'abcdef12' });
});

test('Wi-Fi QR: refuses what the sensors cannot join, and says why', () => {
  const cases: [string, string][] = [
    ['https://teton.ai', 'not a Wi-Fi QR code'],
    ['T1:TETON-DEMO-001:aa:bb', 'not a Wi-Fi QR code'],
    ['WIFI:T:nopass;S:Guest;;', 'no password'],
    ['WIFI:T:WEP;S:Old;P:12345;;', 'another kind of network'],
    ['WIFI:T:WPA2-EAP;S:Staff;E:PEAP;I:me;P:secret123;;', 'another kind of network'],
    ['WIFI:T:WPA;S:Ward-3;P:short;;', 'at least 8 characters'],
  ];
  for (const [text, reason] of cases) {
    const result = parseWifiQr(text);
    assert.ok('error' in result && result.error.includes(reason), `${text} → ${JSON.stringify(result)}`);
  }
});

test('Wi-Fi QR: tolerates what real generators produce', () => {
  assert.deepEqual(parseWifiQr('WIFI:T:WPA2;S:Ward-3;P:correct horse;H:true;;\n'), ward3, 'WPA2 type, hidden network, trailing newline');
  assert.deepEqual(parseWifiQr('WIFI:T:wpa;S:Ward-3;P:correct horse;;'), ward3, 'lower-case type');
  assert.deepEqual(parseWifiQr('WIFI:T:WPA;S:Ward-3;P:correct horse;'), ward3, 'one final semicolon');
  assert.deepEqual(parseWifiQr('WIFI:T:WPA;S:Ward-3;P:ab:cd:1234;;'), { ssid: 'Ward-3', password: 'ab:cd:1234' }, 'unescaped colons');
  assert.deepEqual(parseWifiQr('WIFI:S:Ward-3;P:correct horse'), ward3, 'no semicolon after the last field');
  assert.deepEqual(parseWifiQr('WIFI:T:SAE;S:Ward-3;P:correct horse;;'), ward3, 'WPA3 transition, as Android shares it');
});

test('Wi-Fi QR: a quoted value may end with an escaped backslash', () => {
  assert.deepEqual(parseWifiQr('WIFI:T:WPA;S:Ward-3;P:"abcdefg\\\\";;'), { ssid: 'Ward-3', password: 'abcdefg\\' });
});

test('Wi-Fi QR: the code ends at ";;", and nothing after it overrides a field', () => {
  assert.deepEqual(parseWifiQr('WIFI:T:WPA;S:Ward-3;P:correct horse;;H:true;S:Evil;;'), ward3);
});

test('Wi-Fi QR: a code without a network name is refused', () => {
  const result = parseWifiQr('WIFI:T:WPA;P:correct horse;;');
  assert.ok('error' in result && result.error.includes('network name'), JSON.stringify(result));
});
