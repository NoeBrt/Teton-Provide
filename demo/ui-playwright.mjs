// PLAYWRIGHT / AXE: paths to playwright's index.mjs and axe-core's axe.min.js when not installed here.
const { chromium, devices } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const AXE = process.env.AXE;
import { pathToFileURL } from 'node:url';
const [, , archFile, demoFile, out] = process.argv;
const browser = await chromium.launch();
const formats = { pc: { viewport: { width: 1440, height: 900 } }, iphone13: devices['iPhone 13'], pixel7: devices['Pixel 7'] };
let failures = 0;
const log = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };

async function open(file, fmt, scheme) {
  const context = await browser.newContext({ ...formats[fmt], colorScheme: scheme });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}
async function renderedFont(page, selector) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  return fonts.map(f => f.familyName).join(',');
}
async function layoutChecks(page, label, scrollers) {
  const r = await page.evaluate(sc => {
    const vw = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('body *')].filter(e => {
      if (sc && e.closest(sc)) return false;
      const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > vw + 1 || b.left < -1);
    }).slice(0, 5).map(e => e.tagName + '.' + e.className);
    return { overflow: document.documentElement.scrollWidth - vw, wide };
  }, scrollers);
  log(r.overflow <= 0 && r.wide.length === 0, `${label}: no horizontal page scroll (overflow ${r.overflow}px${r.wide.length ? ', wide: ' + r.wide.join(' ') : ''})`);
}

// 1. Architecture artifact (pass "-" to skip; its source lives outside the repo)
if (archFile !== "-") for (const fmt of Object.keys(formats)) for (const scheme of ["light", "dark"]) {
  const label = `artifact ${fmt} ${scheme}`;
  const { context, page, errors } = await open(archFile, fmt, scheme);
  await layoutChecks(page, label, '.scroll, .table-wrap');
  const font = await renderedFont(page, 'h1');
  log(font.includes('Onest'), `${label}: h1 rendered with ${font}`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  log(bg === (scheme === 'dark' ? 'rgb(30, 30, 30)' : 'rgb(255, 255, 255)'), `${label}: body background ${bg}`);
  log(errors.length === 0, `${label}: no console errors ${errors.join(' | ')}`);
  await page.screenshot({ path: `${out}/artifact-${fmt}-${scheme}.png`, fullPage: true });
  await context.close();
}

// 2. Technician mockup: site network entered once, rooms of several sensors, every outcome
const expected = { success: 'Chambre 214 prête', range: '2 sur 3 capteurs connectés', identity: '2 sur 3 capteurs connectés', password: 'Mot de passe du site à vérifier', network: 'Réseau du site introuvable' };
const saveSite = async page => { await page.click('#site-form button[type="submit"]'); await page.waitForSelector('[data-screen="room"]:not([hidden])'); };
const scan = async (page, count) => { for (let i = 0; i < count; i++) await page.click('#scan'); };
const awaitResult = page => page.waitForSelector('[data-screen="result"]:not([hidden])', { timeout: 15000 });
const connect = async page => { await page.click('#connect'); await awaitResult(page); };
const results = page => page.$$eval('#results li', items => items.map(item => `${item.querySelector('strong').textContent}:${item.dataset.state}`).join(' '));
for (const fmt of Object.keys(formats)) {
  const { context, page, errors } = await open(demoFile, fmt, 'light');
  const label = `mockup ${fmt}`;
  await layoutChecks(page, label, null);
  log((await renderedFont(page, 'h1')).includes('Onest'), `${label}: h1 rendered with Onest (embedded, offline)`);
  for (const preview of ['phone', 'desktop']) {
    await page.click(`button[data-preview="${preview}"]`);
    for (const [scenario, title] of Object.entries(expected)) {
      await page.click('#reset');
      await page.selectOption('#scenario', scenario);
      await saveSite(page);
      const cleared = await page.inputValue('#password') === '';
      await scan(page, 3);
      await connect(page);
      const got = await page.textContent('#result-title');
      log(got === title && cleared, `${label} ${preview} ${scenario}: "${got}" [${await results(page)}], password not left in the form`);
      if (scenario === 'success') continue;
      await page.click('#result-action');
      if (scenario === 'password' || scenario === 'network') {
        await page.waitForSelector('[data-screen="site"]:not([hidden])');
        await page.fill('#password', 'DemoUniquement26');
        await saveSite(page);
        await connect(page);
      } else {
        await awaitResult(page);
      }
      const retried = await results(page);
      log(await page.textContent('#result-title') === 'Chambre 214 prête' && !retried.includes(':error'), `${label} ${preview} ${scenario}: correction succeeds [${retried}]`);
    }
    // The point of the design: the next room needs no credentials, only label scans.
    await page.click('#reset');
    await saveSite(page);
    await scan(page, 3);
    await layoutChecks(page, `${label} ${preview} room with 3 sensors`, null);
    const small = await page.evaluate(() => [...document.querySelectorAll('button, select, input')].filter(e => e.offsetParent)
      .map(e => [e.id || e.className || e.tagName, Math.round(e.getBoundingClientRect().height)]).filter(([, h]) => h < 44));
    log(small.length === 0, `${label} ${preview}: touch targets >= 44px ${JSON.stringify(small)}`);
    await page.screenshot({ path: `${out}/mockup-${fmt}-${preview}.png`, fullPage: true });
    await connect(page);
    await page.click('#result-action');
    await page.waitForSelector('[data-screen="room"]:not([hidden])');
    const roomTwo = await page.inputValue('#room');
    const noRetype = await page.isHidden('[data-screen="site"]') && await page.inputValue('#password') === '' && await page.textContent('#site-name') === 'Hotspot-Demo';
    await scan(page, 2);
    await connect(page);
    log(noRetype && await page.textContent('#result-title') === `Chambre ${roomTwo} prête`,
      `${label} ${preview}: next room ${roomTwo} provisioned without re-entering credentials [${await results(page)}]`);
  }
  log(errors.length === 0, `${label}: no console/CSP errors ${errors.join(' | ')}`);
  await context.close();
}

// 3. Accessibility (axe-core, WCAG 2.1 A/AA) on three mockup screens, and a keyboard-only run
async function axe(page, label) {
  if (!AXE) return log(false, `${label}: AXE path not set`);
  await page.addScriptTag({ path: AXE });
  const { violations } = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  log(violations.length === 0, `${label}: axe WCAG 2.1 AA, ${violations.length} violations ${violations.map(v => `${v.id}(${v.nodes.length})`).join(' ')}`);
}
for (const fmt of Object.keys(formats)) {
  const { context, page } = await open(demoFile, fmt, 'light');
  await axe(page, `a11y ${fmt} site network`);
  await page.selectOption('#scenario', 'range');
  await saveSite(page);
  await scan(page, 3);
  await axe(page, `a11y ${fmt} room with sensors`);
  await connect(page);
  await axe(page, `a11y ${fmt} partial result`);
  await context.close();
}
{
  const { context, page } = await open(demoFile, 'pc', 'light');
  const tabTo = async selector => {
    for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); if (await page.evaluate(sel => document.activeElement?.matches(sel), selector)) return true; }
    return false;
  };
  const reachedSave = await tabTo('#site-form button[type="submit"]');
  await page.keyboard.press('Enter');
  const focusRoom = await page.evaluate(() => document.activeElement?.id);
  const reachedScan = await tabTo('#scan');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
  const reachedConnect = await tabTo('#connect');
  await page.keyboard.press('Enter');
  await awaitResult(page);
  const focusResult = await page.evaluate(() => document.activeElement?.id);
  log(reachedSave && focusRoom === 'room-title' && reachedScan && reachedConnect && focusResult === 'result-title',
    `keyboard only: Tab/Enter reach every step, focus moves to each screen title (${focusRoom}, ${focusResult})`);
  await context.close();
}
await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
