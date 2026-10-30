// The game stays open (a home-screen app in the background) while a new version is deployed, and
// comes back on screen more than a minute later: it should look for the update then and switch to it.
// usage: WORK=<dir> SPKI=<cert hash> node resume.cjs OLD NEW
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const DIR = process.env.WORK, url = 'https://127.0.0.1:8443/?lowpower';
const [OLD, NEW] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const live = v => fs.writeFileSync(path.join(DIR, 'live'), v);
const ver = v => fs.readFileSync(path.join(DIR, v, 'js/version.js'), 'utf8').match(/'(.*)'/)[1];
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} resume: ${name} ${info}`); };
(async () => {
  try { fs.unlinkSync(path.join(DIR, 'hold')); } catch {}
  const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${process.env.SPKI}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext({ viewport: { width: 412, height: 892 }, locale: 'sr' })).newPage();
  const read = () => page.evaluate(() => ({ ver: document.querySelector('#ver').textContent, mode: window.__game?.state.mode, sw: !!navigator.serviceWorker.controller })).catch(() => null);
  live(OLD); await page.goto(url);
  for (let i = 0; i < 100; i++) { const s = await read(); if (s?.sw && s.mode === 'attract') break; await sleep(200); }
  await page.reload();
  await sleep(15000);   // Chrome's own update check runs a few seconds after a page loads; let it pass
  live(NEW);
  await sleep(62000);   // more than the game's once-a-minute limit
  let s = await read();
  check('nothing changes while the app stays in the background', s.ver === ver(OLD), s.ver);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // back on screen
  for (let i = 0; i < 100; i++) { s = await read(); if (s?.ver === ver(NEW) && s.mode === 'attract') break; await sleep(200); }
  check('back on screen: switches to the new version', s.ver === ver(NEW) && s.mode === 'attract', s.ver);
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
