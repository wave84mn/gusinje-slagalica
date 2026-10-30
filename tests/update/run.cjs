// One update over HTTPS with the offline cache on: install version OLD, "deploy" NEW, open the game again.
// usage: WORK=<dir> SPKI=<cert hash> node run.cjs OLD NEW [plain|tap|touch]
//   plain: just reopen          -> the new version runs, Easy starts with 45 of 64 in
//   tap:   start Easy on the old version while the update is held back -> once it lands, the
//          untouched game starts again on the new version, same level
//   touch: also drag a piece, so the game is under way -> no reload, a note; the switch happens on the start screen
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const DIR = process.env.WORK;
const url = 'https://127.0.0.1:8443/?lowpower';
const [OLD, NEW, how = 'plain'] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const live = v => fs.writeFileSync(path.join(DIR, 'live'), v);
const hold = on => { const f = path.join(DIR, 'hold'); if (on) fs.writeFileSync(f, '1'); else try { fs.unlinkSync(f); } catch {} };
const ver = v => fs.readFileSync(path.join(DIR, v, 'js/version.js'), 'utf8').match(/'(.*)'/)[1];
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${how}: ${name} ${info}`); };

(async () => {
  hold(false);
  const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${process.env.SPKI}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 892 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'sr' });
  const page = await ctx.newPage();
  page.on('pageerror', e => { fails++; console.log('pageerror:', e.message); });
  let navs = 0; page.on('framenavigated', f => { if (f === page.mainFrame()) navs++; });
  const read = async () => { try { return await page.evaluate(() => ({ ver: document.querySelector('#ver')?.textContent, mode: window.__game?.state.mode,
    level: window.__game?.state.level, placed: window.__game?.state.placed.length, started: window.__game?.state.started,
    sw: !!navigator.serviceWorker.controller, toast: document.querySelector('#toast.on')?.textContent || '' })); } catch { return null; } };
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await read(); if (s && fn(s)) return s; await sleep(150); } return s; };

  live(OLD);
  await page.goto(url);
  let s = await until(st => st.mode === 'attract' && st.sw);
  await page.reload();
  s = await until(st => st.mode === 'attract' && st.sw);
  check('old version installed', s.ver === ver(OLD), s.ver);

  live(NEW);
  if (how !== 'plain') hold(true);
  await page.reload({ waitUntil: 'load' });
  if (how !== 'plain') {
    s = await until(st => st.mode === 'attract' && st.ver === ver(OLD));
    await page.click('[data-level="easy"]');
    s = await until(st => st.mode === 'play');
    if (how === 'touch') {
      if (await page.isVisible('#bHelpGo')) { await page.tap('#bHelpGo'); await sleep(600); }
      const cdp = await ctx.newCDPSession(page);
      const tp = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 8, radiusY: 8, force: 1 })) });
      const b = await page.locator('.pc:not(.gone)').first().boundingBox();
      const a = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      await tp('touchStart', [a]); await sleep(40);
      for (let i = 1; i <= 16; i++) { await tp('touchMove', [{ x: a.x, y: a.y - i * 14 }]); await sleep(16); }
      await tp('touchEnd', []);
      s = await until(st => st.started, 3000);
      check('game under way on the old version', s.started && s.ver === ver(OLD));
    }
    await sleep(1600);   // the piece's own note ("not there") fades first
    const n0 = navs;
    hold(false);
    s = await until(st => st.ver === ver(NEW) || /nova verzija/i.test(st.toast), 30000);
    if (how === 'tap') {
      check('untouched game started again on the new version, same level', navs > n0 && s.ver === ver(NEW) && s.mode === 'play' && s.level === 'easy' && s.placed === 45,
        `${s.ver} ${s.mode} ${s.level} ${s.placed}`);
    } else {
      check('game under way kept, with a note', navs === n0 && s.ver === ver(OLD) && s.mode === 'play' && /nova verzija/i.test(s.toast), s.toast);
      await page.click('#bMenu'); await sleep(300); await page.click('#bMenuNew');
      s = await until(st => st.ver === ver(NEW) && st.mode === 'attract', 20000);
      check('new version on the start screen', s.ver === ver(NEW) && s.mode === 'attract', s.ver);
    }
  } else {
    s = await until(st => st.ver === ver(NEW), 30000);
    check('new version running (not the old files)', s.ver === ver(NEW), `${s.ver}, new is ${ver(NEW)}`);
  }
  if (s.mode === 'attract') {
    await page.click('[data-level="easy"]');
    s = await until(st => st.mode === 'play');
    check('Easy starts with 45 of 64 in', s.placed === 45, `${s.placed}/64`);
  }
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
