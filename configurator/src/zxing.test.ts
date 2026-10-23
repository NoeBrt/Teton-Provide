/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ZXING_WASM_SHA256 } from 'barcode-detector/ponyfill';

test('the app serves the QR decoder wasm the installed decoder expects', () => {
  const wasm = readFileSync(new URL('../public/zxing_reader.wasm', import.meta.url));
  assert.equal(createHash('sha256').update(wasm).digest('hex'), ZXING_WASM_SHA256, 'run npm install: its postinstall copies it');
});
