/// <reference types="node" />
// The desktop app's content security policy (desktop/src-tauri/tauri.conf.json): a script injected into the page must
// not load code or send data elsewhere, and the app must keep what it needs to run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CONFIG = process.env.TAURI_CONF ?? new URL('../desktop/src-tauri/tauri.conf.json', import.meta.url);
const security = JSON.parse(readFileSync(CONFIG, 'utf8')).app.security;
const directives = Object.fromEntries(
  (security.csp as string).split(';').map(d => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]),
);

test('the packaged app has a content security policy that only allows its own origin', () => {
  assert.equal(typeof security.csp, 'string', 'csp: null lets any script run and send data anywhere');
  assert.deepEqual(directives['default-src'], ["'self'"]);
  for (const [name, sources] of Object.entries(directives)) {
    assert.ok(!sources.includes("'unsafe-eval'"), `${name} allows eval`);
    assert.ok(!sources.some(s => /^(https?:)?\*|^https:$|^http:$/.test(s) || /^https:\/\/(?!ipc\.)/.test(s)), `${name} allows a remote origin`);
  }
  assert.deepEqual(directives['script-src'], ["'self'", "'wasm-unsafe-eval'"], 'scripts from the app only, plus the QR decoder (WebAssembly)');
});

test('it keeps what the app needs: inline styles, camera stream, Tauri IPC', () => {
  assert.ok(directives['style-src'].includes("'unsafe-inline'"), 'react-native-web injects its styles');
  assert.deepEqual(security.dangerousDisableAssetCspModification, ['style-src'], "Tauri's nonces would disable 'unsafe-inline'");
  assert.ok(directives['media-src'].includes('mediastream:'), 'webcam preview');
  assert.ok(directives['connect-src'].includes('ipc:'), 'Tauri commands');
  assert.equal(security.devCsp, null, 'development only (Metro hot reload)');
});
