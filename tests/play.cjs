// End-to-end check in a phone-size Chromium with real touch events.
// usage: node tests/play.cjs <url> <outdir>
const { chromium } = require('playwright');
const fs = require('fs');

const url = process.argv[2] || 'http://127.0.0.1:8099/';
const out = process.argv[3] || 'build/shots';
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const vp = (process.env.VP || '412x892').split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width: vp[0], height: vp[1] }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'sr' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 8, radiusY: 8, force: 1 })) });
  async function swipe(a, b, steps = 16, hold = 30) {
    await touch('touchStart', [a]);
    await sleep(hold);
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      await touch('touchMove', [{ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }]);
      await sleep(16);
    }
    await sleep(60);
    await touch('touchEnd', []);
    await sleep(120);
  }
  async function two(a1, a2, b1, b2, steps = 14) {
    await touch('touchStart', [{ ...a1, id: 1 }, { ...a2, id: 2 }]);
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      await touch('touchMove', [{ x: a1.x + (b1.x - a1.x) * k, y: a1.y + (b1.y - a1.y) * k, id: 1 }, { x: a2.x + (b2.x - a2.x) * k, y: a2.y + (b2.y - a2.y) * k, id: 2 }]);
      await sleep(16);
    }
    await touch('touchEnd', []);
    await sleep(150);
  }
  const G = (fn, arg) => page.evaluate(fn, arg);
  const shot = async name => { await sleep(350); await page.screenshot({ path: `${out}/${name}.png` }); log('shot', name); };
  const results = [];
  let placedWhileTurned = null;
  const check = (name, ok, extra = '') => { results.push([name, ok]); log(ok ? 'PASS' : 'FAIL', name, extra); };

  await page.goto(url + '?reset&lowpower', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state.mode === 'attract', null, { timeout: 120000 });
  await sleep(1500);
  await shot('01_start');

  // start Easy
  await page.tap('[data-level="easy"]');
  await page.waitForFunction(() => window.__game.state.mode === 'play');
  await sleep(500);
  check('help shown first time', await page.isVisible('#help'));
  await shot('02_help');
  await page.tap('#bHelpGo');
  await sleep(900);
  await shot('03_play');

  // drag the first tile to its place
  async function dragToPlace(code, offset = { x: 0, y: 0 }) {
    const tile = await page.$(`.pc[data-code="${code}"]`);
    await tile.scrollIntoViewIfNeeded();
    await sleep(250);
    const b = await tile.boundingBox();
    const start = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const tgt = await G(c => window.__game.screenOf(c), code);
    const lift = await G(c => window.__game.liftFor(c, true), code);
    const end = { x: tgt.x + offset.x, y: tgt.y + lift + offset.y };
    // first move straight up to start the drag, then to the target
    await touch('touchStart', [start]);
    await sleep(40);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: start.x, y: start.y - i * 6 }]); await sleep(16); }
    const mid = { x: start.x, y: start.y - 36 };
    for (let i = 1; i <= 18; i++) {
      const k = i / 18;
      await touch('touchMove', [{ x: mid.x + (end.x - mid.x) * k, y: mid.y + (end.y - mid.y) * k }]);
      await sleep(16);
    }
    await sleep(80);
    return end;
  }
  const order = await G(() => window.__game.state.order);
  const first = order[0];
  await dragToPlace(first);
  await shot('04_dragging');
  await touch('touchEnd', []);
  await sleep(500);
  let st = await G(() => window.__game.state);
  check('drag first piece into place', st.placed.includes(first), first);
  check('tile removed from drawer', !(await page.$(`.pc[data-code="${first}"]:not(.gone)`)));

  // wrong place
  const second = order[1];
  const p2 = await G(c => window.__game.pieces.get(c).target, second);
  const wrongOff = { x: p2.x > 0 ? -120 : 120, y: 0 };
  await dragToPlace(second, wrongOff);
  await touch('touchEnd', []);
  await sleep(500);
  st = await G(() => window.__game.state);
  check('wrong drop is rejected', !st.placed.includes(second));
  check('rejected tile back in drawer', !!(await page.$(`.pc[data-code="${second}"]:not(.gone):not(.lifted)`)));
  await shot('05_wrong');

  // pinch zoom in the middle of the map
  const d0 = await G(() => window.__game.view.rig.dist);
  await two({ x: 180, y: 420 }, { x: 230, y: 470 }, { x: 120, y: 360 }, { x: 290, y: 530 });
  const d1 = await G(() => window.__game.view.rig.dist);
  check('pinch zooms in', d1 < d0 * 0.8, `${d0.toFixed(0)} -> ${d1.toFixed(0)}`);
  // one-finger pan
  const x0 = await G(() => window.__game.view.rig.x);
  await swipe({ x: 300, y: 400 }, { x: 150, y: 400 });
  const x1 = await G(() => window.__game.view.rig.x);
  check('one finger pans', x1 > x0 + 5, `${x0.toFixed(1)} -> ${x1.toFixed(1)}`);
  // two-finger tilt
  const t0 = await G(() => window.__game.view.rig.tilt);
  await two({ x: 170, y: 520 }, { x: 250, y: 520 }, { x: 170, y: 400 }, { x: 250, y: 400 });
  const t1 = await G(() => window.__game.view.rig.tilt);
  check('two fingers up tilt the view', t1 > t0 + 0.2, `${t0.toFixed(2)} -> ${t1.toFixed(2)}`);
  await shot('06_zoom_tilt');

  // twist with two fingers: the map turns with them
  await G(() => window.__game.view.fit(0, 10));
  await sleep(300);
  const y0 = await G(() => window.__game.view.rig.yaw);
  {
    const c = { x: 206, y: 470 }, r = 70, a0 = Math.PI, a1 = Math.PI + 1.0;   // +1 rad = clockwise on screen
    const pt = (a, s) => ({ x: c.x + Math.cos(a) * r * s, y: c.y + Math.sin(a) * r * s });
    await touch('touchStart', [{ ...pt(a0, 1), id: 1 }, { ...pt(a0 + Math.PI, 1), id: 2 }]);
    for (let i = 1; i <= 16; i++) {
      const a = a0 + (a1 - a0) * i / 16;
      await touch('touchMove', [{ ...pt(a, 1), id: 1 }, { ...pt(a + Math.PI, 1), id: 2 }]);
      await sleep(16);
    }
    await touch('touchEnd', []);
    await sleep(200);
  }
  const y1 = await G(() => window.__game.view.rig.yaw);
  const na1 = await G(() => window.__game.view.northAngle());
  check('two-finger twist turns the map clockwise', y1 - y0 > 0.7 && na1 > 0.7, `yaw ${y0.toFixed(2)} -> ${y1.toFixed(2)}, north at ${(na1 * 180 / Math.PI).toFixed(0)} deg`);
  await page.tap('#bNorth');
  await sleep(700);
  const na2 = await G(() => window.__game.view.northAngle());
  check('compass puts north back up', Math.abs(na2) < 0.03, `${(na2 * 180 / Math.PI).toFixed(1)} deg`);
  await page.tap('#bTurn');
  await sleep(700);
  const na3 = await G(() => window.__game.view.northAngle());
  check('turn button turns a quarter clockwise', Math.abs(na3 - Math.PI / 2) < 0.03, `${(na3 * 180 / Math.PI).toFixed(1)} deg`);
  const z0 = await G(() => window.__game.view.rig.dist);
  await page.tap('#bZin'); await sleep(500);
  const z1 = await G(() => window.__game.view.rig.dist);
  await page.tap('#bZout'); await sleep(500);
  const z2 = await G(() => window.__game.view.rig.dist);
  check('zoom buttons', z1 < z0 * 0.7 && z2 > z1 * 1.4, `${z0.toFixed(0)} -> ${z1.toFixed(0)} -> ${z2.toFixed(0)}`);
  await shot('06b_turned');
  // place a piece while the map is turned
  {
    const st2 = await G(() => window.__game.state);
    const code = st2.order.find(c => !st2.placed.includes(c) && c !== st2.order[1] && c !== st2.order[2]);
    await dragToPlace(code);
    await touch('touchEnd', []);
    await sleep(500);
    const st3 = await G(() => window.__game.state);
    check('place a piece on the turned map', st3.placed.includes(code), code);
    placedWhileTurned = code;
  }
  await page.tap('#bNorth');
  await sleep(600);

  // place a piece while zoomed in and tilted
  const third = order[2];
  await G(c => { const p = window.__game.pieces.get(c).target; window.__game.view.animateTo({ x: p.x, z: p.z }, 10); }, third);
  await sleep(300);
  await dragToPlace(third);
  await touch('touchEnd', []);
  await sleep(500);
  st = await G(() => window.__game.state);
  check('place piece while zoomed and tilted', st.placed.includes(third));
  await page.tap('#bView');
  await sleep(700);

  // hint
  await page.tap('#bHint');
  await sleep(900);
  st = await G(() => window.__game.state);
  check('hint counted', st.hints === 1);
  await shot('07_hint');

  // picture
  await page.tap('#bPic');
  await sleep(400);
  check('picture opens', await page.isVisible('#pic'));
  await shot('08_picture');
  await page.tap('#pic');
  await sleep(300);

  // reload resumes
  await page.goto(url + '?lowpower', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state.mode === 'attract', null, { timeout: 120000 });
  await sleep(800);
  check('continue offered after reload', await page.isVisible('#bContinue'));
  await shot('09_continue');
  await page.tap('#bContinue');
  await page.waitForFunction(() => window.__game.state.mode === 'play');
  st = await G(() => window.__game.state);
  check('resume keeps placed pieces', st.placed.length === 3 && st.hints === 1, `${st.placed.length} placed`);

  // finish: place all but one, drag the last
  const left = st.order.filter(c => !st.placed.includes(c));
  await G(cs => cs.forEach(c => window.__game.place(c, false)), left.slice(0, -1));
  await sleep(600);
  await G(() => window.__game.view.fit(0, 10));
  await sleep(300);
  await dragToPlace(left[left.length - 1]);
  await touch('touchEnd', []);
  await sleep(3500);
  st = await G(() => window.__game.state);
  check('finished', st.done && st.mode === 'explore');
  check('done card shown', await page.isVisible('#done'));
  await shot('10_done');
  await page.tap('#bExplore');
  await sleep(900);
  await shot('11_explore');
  const lbl = (await page.$$('#labels.on .lbl')).length ? await page.evaluateHandle(() => [...document.querySelectorAll('#labels.on .lbl')].find(e => e.style.display !== 'none')) : null;
  check('landmark labels visible', !!lbl);
  if (lbl && await lbl.evaluate(e => !!e)) { await lbl.asElement().tap(); await sleep(400); check('landmark card opens', await page.isVisible('#card')); await shot('12_card'); await page.tap('#card [data-close]'); }

  // hard level: rotate + wrong rotation message, English
  await page.tap('#bExploreNew');
  await sleep(600);
  await page.tap('#start [data-lang="en"]');
  await sleep(400);
  await shot('13_start_en');
  await page.tap('[data-level="hard"]');
  await page.waitForFunction(() => window.__game.state.mode === 'play');
  await sleep(900);
  st = await G(() => window.__game.state);
  const h1 = st.order[0];
  const r0 = st.rot[h1];
  await page.tap(`.pc[data-code="${h1}"]`);
  await sleep(300);
  st = await G(() => window.__game.state);
  check('tap rotates on Hard', st.rot[h1] === (r0 + 1) % 4, `${r0} -> ${st.rot[h1]}`);
  if (st.rot[h1] !== 0) {
    await dragToPlace(h1);
    await touch('touchEnd', []);
    await sleep(300);
    const txt = await page.textContent('#toast');
    st = await G(() => window.__game.state);
    check('wrong rotation rejected with "Turn it"', !st.placed.includes(h1) && /Turn it/.test(txt), txt);
  }
  // turn to 0 and place
  st = await G(() => window.__game.state);
  let k = st.rot[h1];
  while (k % 4 !== 0) { await page.tap(`.pc[data-code="${h1}"]`); await sleep(250); k = (await G(() => window.__game.state)).rot[h1]; }
  await shot('14_hard_en');
  await dragToPlace(h1);
  await touch('touchEnd', []);
  await sleep(500);
  st = await G(() => window.__game.state);
  check('Hard: place after turning', st.placed.includes(h1));

  const perf = await G(() => ({ calls: window.__game.view.renderer.info.render.calls, tris: window.__game.view.renderer.info.render.triangles }));
  log('render info', JSON.stringify(perf));
  log('console errors/warnings:', errors.length ? '\n  ' + errors.join('\n  ') : 'none');
  const failed = results.filter(r => !r[1]).length;
  log(`\n${results.length - failed}/${results.length} checks passed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
