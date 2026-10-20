/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkToken, decodeToken, deviceId, fromHex, parseTokenText, TOKEN_LINK, verifyCertificate } from './authority.ts';

// Certificate and token signed by snow's side with fixed authority keys (tests/noise_vectors.rs).
const vectors = JSON.parse(readFileSync(new URL('./noise-vectors.json', import.meta.url), 'utf8'));
const deviceAuthority = fromHex(vectors.deviceAuthority);
const technicianAuthority = fromHex(vectors.technicianAuthority);
const certificate = fromHex(vectors.certificate);
const tokenBytes = fromHex(vectors.token);
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

test('a token reads its holder, customers and expiry, and checks its signature then its date', () => {
  const token = decodeToken(tokenBytes);
  assert.equal(token?.name, 'Noé');
  assert.deepEqual(token?.customers, [vectors.customer]);
  assert.equal(token?.expires, 4_102_444_800);
  assert.equal(checkToken(token!, 1_800_000_000, technicianAuthority), 'ok');
  assert.equal(checkToken(token!, 4_102_444_800, technicianAuthority), 'expired');
  assert.equal(checkToken(token!, 0, deviceAuthority), 'invalid', 'the device authority cannot sign tokens');
  const forged = decodeToken(flip(tokenBytes, 3));
  assert.equal(forged && checkToken(forged, 0, technicianAuthority), 'invalid');
});

test('a token comes from its link, bare hex, or nothing else', () => {
  assert.equal(parseTokenText(`${TOKEN_LINK}${vectors.token}`)?.name, 'Noé');
  assert.equal(parseTokenText(` ${vectors.token}\n`)?.name, 'Noé');
  for (const bad of ['', 'https://example.com', 'WIFI:T:WPA;S:Ward-3;P:correct horse;;', `${TOKEN_LINK}zz`, vectors.token.slice(0, -2)]) {
    assert.equal(parseTokenText(bad), null, bad);
  }
});
