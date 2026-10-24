// Layout and resize checks of the desktop build in real browsers (Chromium and WebKit), demo mode (200 sensors).
// Metro must be running (npm run web). Usage: node desktop/layout-check.mjs <playwright module> [chrome executable]
// This test tool is not shipped with Provide; it only drives the demo.
import assert from 'node:assert/strict';
const pw = await import(process.argv[2] || 'playwright');
const chrome = process.argv[3];
const URL = 'http://localhost:8081/?demo=1';
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

const launch = engine => pw[engine].launch({ headless: true, ...(engine === 'chromium' && chrome && { executablePath: chrome }) });
const open = async (browser, width, height) => {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', e => failures.push(`page error: ${e.message}`));
  await page.goto(URL);
  await page.getByRole('button', { name: /Set up all ready/ }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(2000); // crowded: the phone radar has folded
  return page;
};
// The radar ring, the first requirement row, and the gap between them; the list's scroll element.
const measure = page => page.evaluate(() => {
  let ring = document.querySelector('[aria-label="Pause search"], [aria-label="Resume search"]');
  while (ring && !(ring.getBoundingClientRect().width > 44 && Math.abs(ring.getBoundingClientRect().width - ring.getBoundingClientRect().height) < 2)) ring = ring.parentElement;
  const r = ring?.getBoundingClientRect();
  const code = document.querySelector('[aria-label^="Technician code"]')?.getBoundingClientRect();
  const site = document.querySelector('[aria-label^="Site Wi-Fi"]')?.getBoundingClientRect();
  return {
    width: innerWidth, circle: Math.round(r?.width ?? 0), gap: r && code ? Math.round(code.top - r.bottom) : null,
    radarLeft: Math.round(r?.left ?? 0), siteBottom: Math.round(site?.bottom ?? 0), overflowX: document.documentElement.scrollWidth > innerWidth,
  };
});
const list = page => page.evaluateHandle(() => [...document.querySelectorAll('div')].find(d => d.scrollHeight > d.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(d).overflowY)));

for (const engine of ['chromium', 'webkit']) {
  const browser = await launch(engine);

  // 1. Each window size gets its layout: desktop (radar 180 px, two columns) from 900 px, phone (compact radar) below.
  for (const [w, h] of [[400, 700], [600, 800], [899, 800], [900, 600], [1280, 800], [1920, 1080]]) {
    const page = await open(browser, w, h);
    const m = await measure(page);
    check(!m.overflowX, `${engine} ${w}x${h}: horizontal overflow`);
    if (w >= 900) check(m.circle === 180, `${engine} ${w}x${h}: desktop radar ${m.circle} px, not 180`);
    else check(m.circle <= 50 && m.gap !== null && m.gap >= 0 && m.gap < 70, `${engine} ${w}x${h}: phone radar ${m.circle} px, gap ${m.gap}`);
    await page.close();
  }

  // 2. Live resizes during a batch, across 900 px both ways and within the phone layout: right layout, compact phone
  //    radar with the list right below it (no gap), no fade of what is already there.
  const page = await open(browser, 1280, 800);
  await page.getByRole('button', { name: /Set up all ready/ }).click();
  for (const [w, h] of [[880, 800], [600, 900], [420, 760], [1100, 700], [900, 600], [500, 800], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    const lowest = await page.evaluate(() => new Promise(done => { // lowest opacity of the site row over 20 frames
      const site = () => document.querySelector('[aria-label^="Site Wi-Fi"]');
      let low = 1, n = 0;
      const tick = () => {
        for (let e = site(); e; e = e.parentElement) low = Math.min(low, +getComputedStyle(e).opacity);
        if (++n < 20) requestAnimationFrame(tick); else done(low);
      };
      requestAnimationFrame(tick);
    }));
    check(lowest > 0.95, `${engine} resize to ${w}x${h}: the site row faded (opacity ${lowest})`);
    await page.waitForTimeout(900);
    const m = await measure(page);
    if (w >= 900) check(m.circle === 180, `${engine} resize to ${w}x${h}: desktop radar ${m.circle} px`);
    else check(m.circle <= 50 && m.gap !== null && m.gap > -80 && m.gap < 70, `${engine} resize to ${w}x${h}: radar ${m.circle} px, gap ${m.gap}`);
  }

  await page.close();

  // 3. Phone layout opened as such (it folds by itself once crowded): scrolling back up brings the large radar back,
  //    the list following it (no gap).
  const phone = await open(browser, 600, 800);
  const scroller = await list(phone);
  const travel = await scroller.evaluate(el => el.scrollTop);
  for (const top of [travel, Math.round(travel / 2), 0]) {
    await scroller.evaluate((el, t) => { el.scrollTop = t; }, top);
    await phone.waitForTimeout(400);
    const m = await measure(phone);
    check(m.gap !== null && m.gap >= 0 && m.gap < 70, `${engine} scrolled to ${top}: gap ${m.gap}`);
    if (top === 0) check(m.circle > 250, `${engine} scrolled to the top: radar ${m.circle} px, not large`);
  }
  await phone.close();

  // 4. A drag of the window edge (one resize per frame): every card fits its column, its frame on its content.
  const drag = await open(browser, 1400, 800);
  for (let w = 1400; w >= 920; w -= 16) {
    await drag.setViewportSize({ width: w, height: 800 });
    const bad = await drag.evaluate(() => {
      const frames = [...new Set([...document.querySelectorAll('[role=button]')].map(b => b.parentElement?.parentElement)
        .filter(f => f && getComputedStyle(f).overflow === 'hidden' && f.firstElementChild))];
      return frames.filter(f => {
        const r = f.getBoundingClientRect();
        return r.right > innerWidth + 1 || Math.abs(r.height - f.firstElementChild.getBoundingClientRect().height) > 1;
      }).length;
    });
    check(bad === 0, `${engine} drag at ${w} px: ${bad} cards off their column or content`);
  }
  // The radar's waves run as CSS animations (they keep going while macOS pauses page frames during a drag).
  const waves = await drag.evaluate(() => [...document.querySelectorAll('[data-wave]')].map(e => getComputedStyle(e).animationName));
  check(waves.length === 4 && waves.every(n => n === 'provide-wave'), `${engine} radar waves: ${waves.join(',') || 'none'}`);
  await drag.close();
  await browser.close();
}

assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
console.log('PASS: layouts, resizes, scrolling back up, drag, radar waves (Chromium and WebKit)');
