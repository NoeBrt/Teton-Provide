// Real UI, isolated fake Tauri radio. Metro must run; pass an installed Playwright module as argv[2].
import assert from 'node:assert/strict';
const pw = await import(process.argv[2] || 'playwright');
const engine = process.argv[3] || 'chromium';
const browser = await pw[engine].launch({ headless: true });
try {
  const width = Number(process.argv[4] || 1280);
  const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: width < 900 ? 'reduce' : 'no-preference' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const listeners = new Map();
    const calls = [];
    let fail = location.search.includes('fixture-empty');
    let starting = false;
    window.fixture = { calls, end: () => listeners.get('ble-stop')?.({ payload: null }), fail: () => { fail = true; }, recover: () => { fail = false; } };
    window.__TAURI__ = {
      event: { listen: async (name, callback) => { listeners.set(name, callback); return () => { if (listeners.get(name) === callback) listeners.delete(name); }; } },
      core: { invoke: async command => {
        calls.push(command);
        if (command === 'ble_state') return 'on';
        if (command === 'ble_stop_scan') {
          if (starting) throw new Error('scan stopped before its pending start completed');
          await new Promise(resolve => setTimeout(() => {
            listeners.get('ble-stop')?.({ payload: null });
            calls.push('stop-complete');
            resolve();
          }, 80));
        }
        if (command === 'ble_scan') {
          if (fail) throw new Error('fixture scan failure');
          starting = true;
          await new Promise(resolve => setTimeout(resolve, 150));
          starting = false;
          const count = calls.filter(c => c === 'ble_scan').length;
          setTimeout(() => listeners.get('ble-discover')?.({ payload: {
            id: 'fixture', name: 'stale-cache', rssi: -50, manufacturer: { ffff: [count === 1 ? 1 : 2, 0x7b, 9, 0xf2, 3, 0x39] },
          } }), 30);
        }
        return null;
      } },
    };
  });
  await page.goto('http://localhost:8081');
  const refresh = page.getByRole('button', { name: 'Refresh the list', exact: true });
  await refresh.waitFor({ timeout: 30000 });
  await page.getByText('Ready to set up', { exact: true }).waitFor();
  await refresh.click();
  await page.waitForFunction(() => window.fixture.calls.filter(c => c === 'ble_scan').length >= 2, null, { timeout: 2000 });
  const calls = await page.evaluate(() => window.fixture.calls);
  assert.equal(calls.filter(c => c === 'ble_scan').length, 2, 'old stop event must not create an extra scan or complete refresh');
  assert.ok(calls.indexOf('stop-complete') < calls.lastIndexOf('ble_scan'), 'old stop must finish before the new scan');
  assert.equal(await refresh.getAttribute('aria-busy'), 'true');
  assert.equal(await refresh.isDisabled(), true, 'one refresh at a time');
  await page.getByText('Refreshing…', { exact: true }).waitFor();
  await page.screenshot({ path: `/private/tmp/iot-refresh-${engine}-${width}-progress.png` });
  await page.getByText(/Reports set up · connected to/).waitFor();
  await page.evaluate(() => window.fixture.end());
  await page.getByText('List updated', { exact: true }).waitFor();
  await page.screenshot({ path: `/private/tmp/iot-refresh-${engine}-${width}-updated.png` });
  assert.equal(await refresh.isDisabled(), false);
  // The automatic next round is still starting when the user refreshes again.
  await refresh.click();
  await page.getByText('Refreshing…', { exact: true }).waitFor();
  await page.waitForTimeout(400);
  const lateCalls = await page.evaluate(() => window.fixture.calls);
  assert.equal(lateCalls.filter(c => c === 'stop-complete').length, 2, 'stop waits for an in-flight start');
  await page.evaluate(() => window.fixture.end());
  await page.getByText('List updated', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pause search', exact: true }).click();
  await page.getByRole('button', { name: 'Resume search', exact: true }).waitFor();
  const scans = await page.evaluate(() => window.fixture.calls.filter(c => c === 'ble_scan').length);
  await refresh.click();
  await page.waitForFunction(before => window.fixture.calls.filter(c => c === 'ble_scan').length > before, scans);
  assert.equal(await refresh.getAttribute('aria-busy'), 'true', 'refresh resumes a paused search');
  await page.evaluate(() => window.fixture.end());
  await page.getByText('List updated', { exact: true }).waitFor();
  await page.evaluate(() => window.fixture.fail());
  await refresh.click();
  await page.getByText('Search failed · retry', { exact: true }).waitFor();
  assert.equal(await refresh.isDisabled(), false, 'a failed scan can be retried');
  await page.goto('http://localhost:8081/?fixture-empty=1');
  await page.getByText('Search failed. Tap refresh to try again.', { exact: true }).first().waitFor();
  assert.equal(await refresh.isVisible(), true, 'an empty list must still offer retry');
  await page.evaluate(() => window.fixture.recover());
  await refresh.click();
  await page.getByText(/Reports set up · connected to/).waitFor();
  await page.evaluate(() => window.fixture.end());
  await page.getByText('List updated', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/private/tmp/iot-refresh-verified.png' });
  console.log(`PASS ${engine} ${width}px: new scan, visible progress, sensor update, completion and recoverable failure`);
} finally { await browser.close(); }
