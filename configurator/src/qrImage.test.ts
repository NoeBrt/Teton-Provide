/// <reference types="node" />
// Reading a QR code from a pasted, dropped or chosen image (desktop, QrImport.web.tsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeImage, firstImage } from './qrImage.ts';

const file = (type: string) => new Blob(['x'], { type });

test('the first image is taken; text is left to the paste field', () => {
  const png = file('image/png');
  const clipboard = [{ type: 'text/plain', getAsFile: () => file('text/plain') }, { type: 'image/png', getAsFile: () => png }];
  assert.equal(firstImage(clipboard), png);
  assert.equal(firstImage([{ type: 'text/plain', getAsFile: () => null }]), null);
  const jpeg = file('image/jpeg');
  assert.equal(firstImage([file('application/pdf'), jpeg]), jpeg, 'dropped files');
  assert.equal(firstImage([]), null);
});

test('an image is decoded locally, and its bitmap released', async () => {
  let closed = 0;
  const bitmap = { close: () => { closed++; } };
  const decoder = (found: { rawValue: string }[]) => ({ toBitmap: async () => bitmap, detect: async () => found });
  assert.equal(await decodeImage(file('image/png'), decoder([{ rawValue: 'WIFI:S:Lab;;' }])), 'WIFI:S:Lab;;');
  assert.equal(await decodeImage(file('image/png'), decoder([])), null, 'no code in the picture');
  assert.equal(closed, 2);
  assert.equal(await decodeImage(file('image/png'), null), null, 'no decoder: the page says so, nothing breaks');
});
