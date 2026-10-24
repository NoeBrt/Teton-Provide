/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const install = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts['desktop:install'] as string;

test('installation never removes the existing app after a failed build or copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iot-install-'));
  const trace = join(dir, 'trace');
  try {
    for (const command of ['npm', 'node', 'ditto', 'lsregister', 'rm', 'mv']) {
      writeFileSync(join(dir, command), '#!/bin/sh\nname=${0##*/}\nprintf "%s\\n" "$name" >> "$IOT_INSTALL_TRACE"\n[ "$name" != "$IOT_INSTALL_FAIL" ]\n', { mode: 0o755 });
    }
    const script = install.replace('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', 'lsregister');
    for (const failed of ['npm', 'node', 'ditto', 'lsregister', 'none']) {
      writeFileSync(trace, '');
      const result = spawnSync('/bin/sh', ['-c', script], {
        env: { ...process.env, PATH: dir, IOT_INSTALL_TRACE: trace, IOT_INSTALL_FAIL: failed },
      });
      const calls = readFileSync(trace, 'utf8').trim().split('\n');
      if (failed === 'npm' || failed === 'node' || failed === 'ditto') {
        assert.notEqual(result.status, 0);
        assert.ok(!calls.includes('rm') && !calls.includes('mv'), `failed ${failed} must preserve the installed app`);
      } else {
        assert.equal(result.status, 0);
        assert.deepEqual(calls, ['npm', 'node', 'ditto', 'lsregister', 'rm', 'mv']);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
