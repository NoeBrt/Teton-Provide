// Metro on :8081; the existing demo owns all 200 sensors. Only the native event transport is replaced here.
// Pass an installed Playwright module and, optionally, a Chromium executable. No real credentials or Bluetooth.
import assert from 'node:assert/strict';
const { chromium } = await import(process.argv[2] || 'playwright');
const browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], ...(process.argv[3] && { executablePath: process.argv[3] }) });
const context = await browser.newContext();
const pages = new Map();
const errors = [];
let snapshot;
await context.exposeBinding('menuEmit', async (_source, target, event, payload) => {
  if (event === 'provide-menu-state') snapshot = payload;
  const page = pages.get(target);
  if (page && !page.isClosed()) await page.evaluate(({ event, payload }) => {
    for (const callback of window.menuListeners.get(event) ?? []) callback({ payload });
  }, { event, payload });
});
await context.addInitScript(() => {
  window.menuListeners = new Map();
  window.menuCalls = [];
  window.__TAURI__ = {
    core: { invoke: async (command, args) => { window.menuCalls.push({ command, args }); } },
    event: {
      listen: async (name, callback) => {
        const callbacks = window.menuListeners.get(name) ?? new Set();
        callbacks.add(callback);
        window.menuListeners.set(name, callbacks);
        return () => callbacks.delete(callback);
      },
      emitTo: (target, event, payload) => window.menuEmit(target, event, payload),
    },
  };
});
try {
  const main = await context.newPage();
  pages.set('main', main);
  main.on('pageerror', error => errors.push(error.message));
  await main.clock.install();
  await main.goto('http://localhost:8081/?demo=1');
  await main.getByRole('button', { name: /Set up all ready/ }).waitFor();
  await main.clock.fastForward(65_000);
  await main.getByText('200 sensors nearby · still searching', { exact: true }).first().waitFor({ timeout: 80_000 });
  const panel = await context.newPage();
  pages.set('menubar', panel);
  await panel.setViewportSize({ width: 380, height: 560 });
  panel.on('pageerror', error => errors.push(error.message));
  await panel.goto('http://localhost:8081/?menubar=1');
  await panel.getByText('200 sensors nearby', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: /^Open IOT-/ }).count(), 200);
  const sensor = snapshot.sensors.find(sensor => sensor.id === 'demo-1').name;
  const test = panel.getByRole('button', { name: `Test ${sensor}`, exact: true });
  await test.click();
  await panel.getByText('“world” received', { exact: true }).waitFor();
  await main.getByText('“world” received', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Refresh the list', exact: true }).click();
  await panel.getByRole('button', { name: 'Cancel refresh', exact: true }).click();
  await panel.getByText('Refresh cancelled', { exact: true }).waitFor();
  await panel.getByRole('button', { name: `Set up ${sensor}`, exact: true }).click();
  await panel.getByText('Device connected', { exact: true }).waitFor();
  await main.getByText('Device connected', { exact: true }).waitFor();
  await main.getByRole('tab', { name: /^Not set up,/ }).click();
  await panel.getByRole('button', { name: `Open ${sensor}`, exact: true }).click();
  assert(await main.evaluate(() => window.menuCalls.some(call => call.command === 'open_main')));
  await main.getByRole('button', { name: `Test ${sensor}`, exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Set up all ready', exact: true }).click();
  await panel.getByText('Operation in progress…', { exact: true }).waitFor();
  assert(await test.isDisabled(), 'a second action must not overlap the shared batch');
  assert(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'panel overflow');
  await panel.screenshot({ path: '/private/tmp/provide-menu-panel.png' });
  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.screenshot({ path: '/private/tmp/provide-menu-panel-dark.png' });
  await panel.keyboard.press('Escape');
  assert(await panel.evaluate(() => window.menuCalls.some(call => call.command === 'hide_menu_bar')));
  assert.deepEqual(errors, []);
  console.log('PASS: 200 shared sensors, test, refresh/cancel, setup, batch guard, open, Escape, light/dark panel');
} catch (error) {
  for (const [name, page] of pages) {
    console.error(name, (await page.locator('body').innerText()).slice(0, 1800));
    console.error(name, await page.evaluate(() => ({ listeners: [...window.menuListeners.keys()], calls: window.menuCalls })));
  }
  console.error(errors);
  throw error;
} finally {
  await browser.close();
}
