/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeSite, upsertSite, type Site } from './sites.ts';

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
