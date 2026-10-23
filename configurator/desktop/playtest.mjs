// Metro must be running. Pass an installed Playwright module path, and optionally a Chromium executable.
// This test tool is not shipped with Provide; all captured data is demo data or an empty form.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.argv[2] || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.argv[3] && { executablePath: process.argv[3] }) });
const out = new URL('../../docs/desktop/', import.meta.url).pathname;
await mkdir(out, { recursive: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const capture = name => page.screenshot({ path: `${out}${name}.png` });
const check = async () => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
  const names = await page.getByText(/^IOT-[0-9A-F]{10}$/).allTextContents();
  assert.equal(new Set(names).size, names.length, 'duplicate sensor');
};
try {
  await page.goto('http://localhost:8081/?demo=1');
  await page.getByRole('button', { name: /Set up all ready/ }).waitFor();
  await page.waitForTimeout(1800); // finish the existing entrance animation
  await check();
  const site = page.getByRole('button', { name: /Site Wi-Fi:/ });
  const siteBox = await site.boundingBox();
  const summary = page.getByText(/set up of \d+ in range/);
  assert((await summary.boundingBox()).x > siteBox.x + siteBox.width);
  await capture('t7-1280-before');
  // Opening a row: full-size buttons from the first frame and no scaled card (Reanimated web layout transitions scale).
  const frames = await page.getByRole('button', { name: /^IOT-/ }).first().evaluate(row => new Promise(resolve => {
    const samples = [];
    row.click();
    const tick = () => {
      const test = [...row.parentElement.querySelectorAll('[role=button]')].find(b => /^Test /.test(b.getAttribute('aria-label') ?? ''));
      samples.push({ scale: getComputedStyle(row.parentElement).transform, h: test?.getBoundingClientRect().height });
      if (samples.length < 20) requestAnimationFrame(tick); else resolve(samples);
    };
    requestAnimationFrame(tick);
  }));
  assert(frames.every(f => f.scale === 'none'), 'the card is scaled while it opens');
  assert.equal(Math.round(frames.find(f => f.h)?.h ?? 0), 44, 'Test is not full size on its first frame');
  await page.getByRole('button', { name: /^Test IOT-/ }).click();
  await page.getByText('“world” received').waitFor();
  await capture('t7-1280-open-test');
  await page.getByRole('button', { name: /Set up all ready/ }).click();
  await page.getByRole('tab', { name: /^Not set up,/ }).click();
  await page.getByText(/IN PROGRESS · 6/).waitFor();
  await check();
  await capture('t7-1280-running');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(1400);
  await capture('t7-1920-running');
  const add = page.getByRole('button', { name: /Add \d+ to the batch/ });
  await add.waitFor({ timeout: 30000 });
  await add.click();
  await page.getByRole('button', { name: /Retry failed/ }).waitFor({ timeout: 180000 });
  await page.getByRole('tab', { name: /^Errors,/ }).click();
  await page.waitForTimeout(1400);
  await check();
  await capture('t7-1920-errors');
  await page.getByRole('button', { name: /Retry failed/ }).click();
  await page.getByRole('button', { name: /Retry failed/ }).waitFor({ timeout: 60000 });
  await page.getByRole('tab', { name: /^Set up,/ }).click();
  await capture('t7-1920-done');
  await page.getByRole('button', { name: /Refresh the list/ }).click();
  const top = (await summary.boundingBox()).y;
  await page.getByRole('button', { name: /^IOT-/ }).last().scrollIntoViewIfNeeded();
  assert.equal((await summary.boundingBox()).y, top, 'summary moved when list scrolled');
  assert.equal((await site.boundingBox()).y, siteBox.y, 'site moved when list scrolled');
  for (const width of [1280, 2560, 900, 899, 768, 400, 320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(1400);
    await check();
    if (width === 899) await capture('t7-899-narrow');
    if (width === 1280) await capture('t7-1280-after');
  }
  await page.goto('http://localhost:8081/');
  const trigger = page.getByRole('button', { name: 'Technician code required. Add it' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const form = dialog.getByText('Technician code', { exact: true }).first();
  assert((await form.boundingBox()).x > 300, 'dialog is not centered');
  await page.getByRole('button', { name: 'Paste the code instead' }).click();
  // A pasted code that cannot be used is explained in its card, and Save is hidden until it is cleared.
  await page.getByRole('textbox', { name: 'Technician code', exact: true }).fill('invalid-code');
  await dialog.getByText('This is not a technician code', { exact: false }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Save' }).count(), 0, 'Save shown for an unusable code');
  await dialog.getByRole('button', { name: 'Clear the pasted code' }).click();
  await dialog.getByText('Paste your technician code').waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert(await trigger.evaluate(element => element === document.activeElement), 'focus did not return');
  await page.getByRole('button', { name: 'Site Wi-Fi required. Choose a site' }).click();
  await dialog.waitFor();
  await page.getByRole('textbox', { name: 'Site name', exact: true }).fill('Layout check');
  await page.keyboard.press('Enter');
  assert(await page.getByRole('textbox', { name: 'Network name', exact: true }).evaluate(element => element === document.activeElement));
  await capture('t7-site-dialog'); // no network or password entered
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'Tab escaped the dialog');
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  await writeFile(`${out}playtest.json`, JSON.stringify({ result: 'PASS', evidence: 'SIMULATION', sizes: ['1280x800', '1920x1080'], responsiveWidths: [320, 400, 768, 899, 900, 1280, 1920, 2560], scenarios: ['Open without distortion', 'Test world', 'six batch slots', 'Add during batch', 'Retry', 'tabs', 'Refresh', 'independent scrolling', 'unique sensors', 'Escape/focus return', 'Tab trap', 'Enter field navigation', 'pasted code card and Clear'], errors }, null, 2) + '\n');
  console.log('PASS: desktop demo, responsive layout and keyboard dialogs');
} finally { await browser.close(); }
