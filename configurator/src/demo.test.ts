/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startDemo, DEMO_SIZE } from './demo.ts';
import { setup } from './setup.ts';
import { probe, sensorId } from './probe.ts';

const random = (n: number) => Uint8Array.from(randomBytes(n));

test('the demo wing against the real setup(): the expected outcome for every simulated sensor', async () => {
  const demo = startDemo(random);
  try {
    assert.equal(demo.sensors.length, DEMO_SIZE);
    for (const sensor of demo.sensors) assert.equal(sensorId(sensor.advertising), sensor.name);
    const tried = demo.sensors.filter(s => s.kind !== 'not-staged');
    const results = await Promise.all(tried.map(s => setup(demo.radio, s.id, s.advertising, demo.token, demo.site.ssid, demo.password, random, () => {},
      { deviceAuthority: demo.deviceAuthority, pollMs: 5 })));
    const outcome = (kind: string) => results.filter((_, i) => tried[i].kind === kind).map(r => (r.ok ? 'ok' : r.reason));
    assert.ok(outcome('genuine').every(r => r === 'ok'));
    assert.ok(outcome('slow').every(r => r === 'ok'), 'a slow join ends after a poll');
    assert.ok(outcome('online').every(r => r === 'ok'), 'set up before: reconfigured');
    assert.deepEqual(outcome('impostor'), ['not-genuine', 'not-genuine', 'not-genuine'], 'a copied certificate without its key');
    assert.deepEqual(outcome('other-customer'), ['other-customer', 'other-customer']);
    assert.deepEqual(outcome('out-of-range'), ['NotInRange', 'NotInRange', 'NotInRange']);
  } finally {
    demo.stop();
  }
});

test('the demo sensors are only trusted with the demo authority', async () => {
  const demo = startDemo(random);
  try {
    const s = demo.sensors.find(sensor => sensor.kind === 'genuine')!;
    const result = await setup(demo.radio, s.id, s.advertising, demo.token, demo.site.ssid, demo.password, random); // real authority
    assert.deepEqual(result.ok ? 'ok' : result.reason, 'not-genuine');
  } finally {
    demo.stop();
  }
});

test('Test answers on a demo sensor', async () => {
  const demo = startDemo(random);
  try {
    assert.equal((await probe(demo.radio, demo.sensors[1].id)).ok, true);
  } finally {
    demo.stop();
  }
});

test('restarting a demo scan cancels its old deadline', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const demo = startDemo(random);
  let stopped = 0;
  demo.radio.onStopScan(() => { stopped++; });
  try {
    await demo.radio.scan();
    context.mock.timers.tick(1000);
    await demo.radio.stopScan();
    await demo.radio.scan();
    context.mock.timers.tick(2000);
    assert.equal(stopped, 0, 'the stopped scan must not end its replacement');
    context.mock.timers.tick(1000);
    assert.equal(stopped, 1);
    await demo.radio.scan();
    demo.stop();
    context.mock.timers.tick(3000);
    assert.equal(stopped, 1, 'leaving the demo cancels the deadline too');
  } finally { demo.stop(); }
});

test('the demo honors the shorter manual refresh duration', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const demo = startDemo(random);
  let stopped = 0;
  demo.radio.onStopScan(() => { stopped++; });
  try {
    await demo.radio.scan({ seconds: 2 });
    context.mock.timers.tick(1999);
    assert.equal(stopped, 0);
    context.mock.timers.tick(1);
    assert.equal(stopped, 1);
  } finally { demo.stop(); }
});
