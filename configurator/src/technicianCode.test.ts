/// <reference types="node" />
// What the technician code card says about a pasted code (TechnicianSheet's CodeField), from the test vectors' code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeToken, fromHex } from './authority.ts';
import { pastedCode } from './technicianCode.ts';

const vectors = JSON.parse(readFileSync(new URL('./noise-vectors.json', import.meta.url), 'utf8'));
const code = `${vectors.token}.${vectors.holderPrivate}`;
const authority = fromHex(vectors.technicianAuthority);
const expires = decodeToken(fromHex(vectors.token), fromHex(vectors.holderPrivate))!.expires;

test('an empty field asks for the code', () => {
  assert.deepEqual(pastedCode('', 0, authority), { kind: 'empty' });
  assert.deepEqual(pastedCode('  \n', 0, authority), { kind: 'empty' });
});

test('a valid code says whose it is, never the code itself', () => {
  const card = pastedCode(` ${code}\n`, expires - 1, authority);
  assert.equal(card.kind, 'ok');
  if (card.kind !== 'ok') return;
  assert.equal(card.name, 'Noé');
  assert.match(card.line, /^DEMO.* · valid until \d{1,2} \w{3} \d{4}$/);
  assert.equal(card.length, code.length, 'spaces around a pasted code do not count');
  assert.ok(!JSON.stringify(card).includes(vectors.holderPrivate), 'the holder key never reaches the card');
});

test('an unusable code says why: expired, not ours, not a code', () => {
  const expired = pastedCode(code, expires, authority);
  assert.equal(expired.kind, 'problem');
  assert.match(expired.kind === 'problem' ? expired.message : '', /^This code expired on/);
  const foreign = pastedCode(code, expires - 1); // the real technician authority did not sign the test code
  assert.deepEqual(foreign, { kind: 'problem', message: 'This code was not issued for these sensors.', length: code.length });
  const garbage = pastedCode('x'.repeat(305), 0, authority);
  assert.equal(garbage.kind, 'problem');
  assert.match(garbage.kind === 'problem' ? garbage.message : '', /^This is not a technician code/);
});
