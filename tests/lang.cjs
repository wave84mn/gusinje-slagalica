// Language checks: every switch, the phone-language start, and Albanian landmark names.
// usage: node tests/lang.cjs <url> <outdir>
const { chromium } = require('playwright');
const fs = require('fs');
const url = process.argv[2] || 'http://127.0.0.1:8099/';
const out = process.argv[3] || 'build/lang';
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = [];
  const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
  const open = async (locale) => {
    const ctx = await b.newContext({ viewport: { width: 412, height: 892 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(url + '?lowpower');
    await p.waitForFunction(() => window.__game && window.__game.state.mode === 'attract', null, { timeout: 120000 });
    await sleep(500);
    return { ctx, p, errors };
  };
  // phone language decides the first language
  for (const [locale, want] of [['sq-AL', 'Bashko Gucinë'], ['sr-Latn-ME', 'Slagalica Gusinje'], ['en-GB', 'Gusinje Puzzle'], ['de-DE', 'Slagalica Gusinje']]) {
    const { ctx, p } = await open(locale);
    const title = await p.textContent('#startPanel h1');
    check(`phone in ${locale} starts with "${want}"`, title === want, title);
    await ctx.close();
  }
  // switching to Albanian
  const { ctx, p, errors } = await open('sr-Latn-ME');
  await p.tap('#start [data-lang="sq"]');
  await sleep(400);
  const s = await p.evaluate(() => ({
    h1: document.querySelector('#startPanel h1').textContent, lead: document.querySelector('#startPanel .lead').textContent,
    lvl: [...document.querySelectorAll('.lvl b')].map(e => e.textContent), lang: document.documentElement.lang, title: document.title,
    sel: document.querySelector('#start [data-lang="sq"]').classList.contains('sel'),
  }));
  check('start screen in Albanian', s.h1 === 'Bashko Gucinë' && s.lvl.join('|') === 'Lehtë|Mesatar|Vështirë' && s.lang === 'sq' && s.title === 'Bashko Gucinë' && s.sel, JSON.stringify(s));
  await p.screenshot({ path: `${out}/1_start_sq.png` });
  await p.tap('[data-level="easy"]');
  await sleep(500);
  const help = await p.textContent('#help h2');
  check('help in Albanian', help === 'Si luhet', help);
  await p.screenshot({ path: `${out}/2_help_sq.png` });
  await p.tap('#bHelpGo');
  await sleep(500);
  // finish quickly and look at the landmark names
  await p.evaluate(() => { const g = window.__game; g.state.order.forEach(c => g.place(c, false)); });
  await sleep(3500);
  const names = await p.evaluate(() => [...document.querySelectorAll('#labels .lbl')].map(e => e.textContent));
  check('landmark names in Albanian', names.includes('Xhamia e Vezirit') && names.includes('Kulla e Sahatit') && names.includes('Komuna'), names.join(', '));
  const done = await p.textContent('#done h2') + ' / ' + await p.textContent('#done .lead');
  check('finish card in Albanian', done.includes('Gucia u bashkua.'), done);
  await p.screenshot({ path: `${out}/3_done_sq.png` });
  // menu switch back to English, remembered after reload
  await p.tap('#bExplore'); await sleep(400);
  await p.tap('#bMenu'); await sleep(300);
  await p.tap('#menu [data-lang="en"]'); await sleep(300);
  const t2 = await p.textContent('#bar .ttl');
  check('menu switch to English', t2 === 'Gusinje Puzzle', t2);
  await p.goto(url + '?lowpower');
  await p.waitForFunction(() => window.__game && window.__game.state.mode === 'attract', null, { timeout: 120000 });
  check('language remembered', (await p.textContent('#startPanel h1')) === 'Gusinje Puzzle');
  check('no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
  await b.close();
  const failed = results.filter(r => !r).length;
  console.log(`${results.length - failed}/${results.length} language checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
