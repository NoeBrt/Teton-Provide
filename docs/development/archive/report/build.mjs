// Captures the technician mockup screens with Playwright, then prints rapport.html to PDF.
// Usage from the repo: PLAYWRIGHT=<dir>/node_modules/playwright/index.mjs node docs/development/archive/report/build.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium, devices } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const here = dirname(fileURLToPath(import.meta.url));
const mockup = pathToFileURL(join(here, '..', 'architecture-demo.html')).href;
const browser = await chromium.launch();

async function screens(format, preview, shots) {
  const page = await (await browser.newContext({ ...format, deviceScaleFactor: 2 })).newPage();
  await page.goto(mockup, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.click(`button[data-preview="${preview}"]`);
  const shell = page.locator('.device-shell');
  for (const [name, scenario, steps] of shots) {
    await page.click('#reset');
    await page.selectOption('#scenario', scenario);
    for (const step of steps) await step(page);
    await shell.screenshot({ path: join(here, 'img', `${preview}-${name}.png`), animations: 'disabled' });
  }
  await page.context().close();
}
const saveSite = async page => { await page.click('#site-form button[type="submit"]'); await page.waitForSelector('[data-screen="room"]:not([hidden])'); };
const scan3 = async page => { for (let i = 0; i < 3; i++) await page.click('#scan'); };
const connect = page => page.click('#connect');
const result = page => page.waitForSelector('[data-screen="result"]:not([hidden])');
const midway = page => page.waitForSelector('#progress li:nth-child(2)[data-state="active"]');

await screens(devices['iPhone 13'], 'phone', [
  ['1-site', 'success', []],
  ['2-room', 'success', [saveSite, scan3]],
  ['3-progress', 'success', [saveSite, scan3, connect, midway]],
  ['4-success', 'success', [saveSite, scan3, connect, result]],
  ['5-partial', 'range', [saveSite, scan3, connect, result]],
]);
await screens({ viewport: { width: 1440, height: 900 } }, 'desktop', [['room', 'success', [saveSite, scan3]]]);

const page = await browser.newPage();
await page.goto(pathToFileURL(join(here, 'rapport.html')).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
if (!(await page.evaluate(() => document.fonts.check('500 16px Onest')))) throw new Error('Onest font did not load');
await page.pdf({
  path: join(here, '..', 'rapport-solution.pdf'),
  format: 'A4',
  printBackground: true,
  margin: { top: '14mm', bottom: '16mm', left: '0', right: '0' },
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: '<div style="width:100%;font:8px sans-serif;color:#646c74;padding:0 16mm;display:flex;justify-content:space-between"><span>Provisioning Wi-Fi par BLE · rapport de solution</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
});
await browser.close();
console.log('wrote docs/development/archive/rapport-solution.pdf');
