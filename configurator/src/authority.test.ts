/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { x25519 } from '@noble/curves/ed25519.js';
import { checkToken, decodeToken, deviceId, fromHex, OLD_LINK, parseTokenText, verifyCertificate } from './authority.ts';

// Certificate and token signed by snow's side with fixed authority keys (device/tests/noise_vectors.rs).
const vectors = JSON.parse(readFileSync(new URL('./noise-vectors.json', import.meta.url), 'utf8'));
const deviceAuthority = fromHex(vectors.deviceAuthority);
const technicianAuthority = fromHex(vectors.technicianAuthority);
const certificate = fromHex(vectors.certificate);
const tokenBytes = fromHex(vectors.token);
const holderPrivate = fromHex(vectors.holderPrivate);
const link = `${vectors.token}.${vectors.holderPrivate}`; // the bare code
const flip = (bytes: Uint8Array, i: number) => Uint8Array.from(bytes, (b, j) => (j === i ? b ^ 1 : b));

test('a certificate from the device authority gives the key, customer and ID the device advertises', () => {
  const checked = verifyCertificate(certificate, deviceAuthority);
  assert.deepEqual(checked?.publicKey, fromHex(vectors.devicePublic));
  assert.equal(checked?.customer, vectors.customer);
  assert.equal(deviceId(checked!.publicKey), vectors.deviceId, 'same ID as the device computes');
});

test('any changed byte, another authority, or a truncated certificate is refused', () => {
  for (let i = 0; i < certificate.length; i++) assert.equal(verifyCertificate(flip(certificate, i), deviceAuthority), null, `byte ${i}`);
  assert.equal(verifyCertificate(certificate, technicianAuthority), null, 'the technician authority does not certify devices');
  assert.equal(verifyCertificate(certificate.slice(0, -1), deviceAuthority), null);
  assert.equal(verifyCertificate(new Uint8Array(0), deviceAuthority), null);
});

test('a token reads its name, holder key, customers and expiry, and checks its signature then its date', () => {
  const token = decodeToken(tokenBytes, holderPrivate);
  assert.equal(token?.name, 'Noé');
  assert.deepEqual(token?.holder, x25519.getPublicKey(holderPrivate));
  assert.deepEqual(token?.holderPrivate, holderPrivate);
  assert.deepEqual(token?.customers, [vectors.customer]);
  assert.equal(token?.expires, 4_102_444_800);
  assert.equal(checkToken(token!, 1_800_000_000, technicianAuthority), 'ok');
  assert.equal(checkToken(token!, 4_102_444_800, technicianAuthority), 'expired');
  assert.equal(checkToken(token!, 0, deviceAuthority), 'invalid', 'the device authority cannot sign tokens');
  const forged = decodeToken(flip(tokenBytes, 3), holderPrivate);
  assert.equal(forged && checkToken(forged, 0, technicianAuthority), 'invalid');
});

test('a version 1 token, or a holder key that is not the token\'s, is refused', () => {
  assert.equal(decodeToken(Uint8Array.from(tokenBytes, (b, i) => (i === 0 ? 1 : b)), holderPrivate), null);
  assert.equal(decodeToken(tokenBytes, fromHex(vectors.phoneEphemeral)), null);
  assert.equal(decodeToken(fromHex(vectors.wrongHolderToken), holderPrivate), null);
  assert.equal(decodeToken(tokenBytes, holderPrivate.slice(1)), null);
});

test('a token comes from its bare code, the code pasted with the old link prefix, or nothing else', () => {
  assert.equal(parseTokenText(` ${link}\n`)?.name, 'Noé');
  assert.equal(parseTokenText(`${OLD_LINK}${link}`)?.name, 'Noé');
  const bad = ['', 'https://example.com', 'WIFI:T:WPA;S:Ward-3;P:correct horse;;', `${OLD_LINK}zz`, link.slice(0, -2),
    vectors.token, `${OLD_LINK}${vectors.token}`, `${vectors.token}.`, `${link}.${vectors.holderPrivate}`, `${vectors.token}.${vectors.phoneEphemeral}`];
  for (const text of bad) assert.equal(parseTokenText(text), null, text);
});

// The code `authority issue` prints (device/tests/noise_vectors.rs writes it as `code` with authority::code_text).
test('the code the authority prints is read as is', () => {
  assert.match(vectors.code, /^[0-9a-f]+\.[0-9a-f]+$/, 'the bare code, no link prefix');
  const token = parseTokenText(vectors.code);
  assert.equal(token?.name, 'Noé');
  assert.deepEqual(token?.holder, x25519.getPublicKey(holderPrivate));
});
