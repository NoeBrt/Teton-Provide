/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../desktop/sign.mjs', import.meta.url).pathname;
const identity = 'A'.repeat(40);

test('local installation signs with an existing Apple identity and verifies the whole bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provide-sign-'));
  const trace = join(dir, 'trace');
  try {
    writeFileSync(join(dir, 'security'), `#!/bin/sh\nprintf '  1) ${identity} "Apple Development: Test (TESTTEAM)"\\n     1 valid identities found\\n'\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'codesign'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$PROVIDE_SIGN_TRACE"\n[ "$PROVIDE_SIGN_FAIL" != 1 ]\n', { mode: 0o755 });
    const run = (extra: Record<string, string> = {}) => spawnSync(process.execPath, [script, join(dir, 'Provide test.app')], {
      env: { ...process.env, PATH: dir, APPLE_SIGNING_IDENTITY: '', PROVIDE_SIGN_TRACE: trace, ...extra }, encoding: 'utf8',
    });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), [
      '--force', '--sign', identity, '--identifier', 'dev.tetonchallenge.provide', join(dir, 'Provide test.app'),
      '--verify', '--deep', '--strict', join(dir, 'Provide test.app'),
    ]);
    writeFileSync(trace, '');
    result = run({ PROVIDE_SIGN_FAIL: '1' });
    assert.notEqual(result.status, 0, 'a failed signature must stop installation');
    assert.ok(!readFileSync(trace, 'utf8').includes('--verify'));
    writeFileSync(trace, '');
    result = run({ APPLE_SIGNING_IDENTITY: 'Explicit Identity' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(trace, 'utf8').includes('\nExplicit Identity\n'));
    writeFileSync(join(dir, 'security'), '#!/bin/sh\nprintf "0 valid identities found\\n"\n', { mode: 0o755 });
    writeFileSync(trace, '');
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(trace, 'utf8').includes('\n--sign\n-\n'));
    assert.match(result.stderr, /Keychain.*updates/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
