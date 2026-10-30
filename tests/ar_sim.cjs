// Checks the AR maths without a phone: the game world is moved, turned and scaled the way AR places
// it on a table, and the touch gestures for sliding, resizing and turning the tray are played on
// the AR touch layer (with the normal screen camera standing in for the phone camera).
// usage: node tests/ar_sim.cjs <url>
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:8099/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 412, height: 892 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })) });
  const G = (fn, arg) => page.evaluate(fn, arg);
  const results = [];
  const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };

  await page.goto(url + '?reset&lowpower');
  await page.waitForFunction(() => window.__game && window.__game.state.mode === 'attract', null, { timeout: 120000 });
  await page.tap('[data-level="easy"]');
  await sleep(500);
  await page.tap('#bHelpGo');
  await sleep(900);
  check('AR button shown but marked off where AR is not available', await page.isVisible('#bAR') && await page.$eval('#bAR', e => e.classList.contains('off')));
  await page.tap('#bAR'); await sleep(400);
  check('tapping it explains why', await page.isVisible('#arInfo') && (await page.textContent('#arWhy')).length > 10, await page.textContent('#arWhy'));
  await page.tap('#arInfo [data-close]'); await sleep(300);

  // 1. world moved, turned and scaled (as AR does): screen <-> tray maths must still agree
  const round = await G(() => {
    const v = window.__game.view;
    v.world.position.set(25, 0, -18); v.world.rotation.set(0, 0.55, 0); v.setWorldScale(0.8); v.needsRender = true;
    const P = new (v.world.position.constructor)(60, v.floorY, -40);
    const s = v.worldToScreen(P);
    const Q = v.screenToPlane(s.x, s.y, v.floorY);
    return { err: Q.distanceTo(P), s };
  });
  check('screen <-> tray round trip with a moved, turned, scaled world', round.err < 0.05, `error ${round.err.toFixed(4)} mm`);

  // drag a real piece into place on that transformed world
  const st = await G(() => window.__game.state);
  const code = st.order[0];
  const tile = await page.$(`.pc[data-code="${code}"]`);
  const tb = await tile.boundingBox();
  const start = { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 };
  const tgt = await G(c => window.__game.screenOf(c), code);
  const lift = await G(c => window.__game.liftFor(c, true), code);
  const end = { x: tgt.x, y: tgt.y + lift };
  await touch('touchStart', [start]);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: start.x, y: start.y - i * 6 }]); await sleep(16); }
  for (let i = 1; i <= 18; i++) { const k = i / 18; await touch('touchMove', [{ x: start.x + (end.x - start.x) * k, y: start.y - 36 + (end.y - start.y + 36) * k }]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(500);
  check('drag a piece into place on the moved world', (await G(() => window.__game.state)).placed.includes(code), code);

  // 2. AR touch layer: slide, pinch, twist
  await G(() => { const g = window.__game; document.body.dataset.ar = 'on'; g.ar.placed = true; g.ar.setSize(0.3); });
  await sleep(200);
  const w0 = await G(() => { const w = window.__game.view.world; return { x: w.position.x, z: w.position.z, s: w.scale.x, r: w.rotation.y }; });
  // slide: the tray point under the finger must stay under the finger
  const before = await G(() => { const v = window.__game.view; const p = v.screenToPlane(206, 470, 0); return { x: p.x, z: p.z }; });
  await touch('touchStart', [{ x: 206, y: 470 }]);
  for (let i = 1; i <= 12; i++) { await touch('touchMove', [{ x: 206 + i * 5, y: 470 - i * 3 }]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(200);
  const after = await G(() => { const v = window.__game.view; const p = v.screenToPlane(266, 434, 0); return { x: p.x, z: p.z }; });
  const slideErr = Math.hypot(after.x - before.x, after.z - before.z);
  check('one finger slides the tray with the finger', slideErr < 1.5, `point under finger moved ${slideErr.toFixed(2)} mm`);
  // pinch out: bigger, and the point between the fingers stays put
  const mid0 = await G(() => { const v = window.__game.view; const p = v.screenToPlane(206, 470, 0); return { x: p.x, z: p.z }; });
  const s0 = await G(() => window.__game.ar.size);
  await touch('touchStart', [{ x: 176, y: 470, id: 1 }, { x: 236, y: 470, id: 2 }]);
  for (let i = 1; i <= 12; i++) { await touch('touchMove', [{ x: 176 - i * 4, y: 470, id: 1 }, { x: 236 + i * 4, y: 470, id: 2 }]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(200);
  const s1 = await G(() => window.__game.ar.size);
  const mid1 = await G(() => { const v = window.__game.view; const p = v.screenToPlane(206, 470, 0); return { x: p.x, z: p.z }; });
  check('pinch makes the tray bigger', s1 > s0 * 1.5, `${s0.toFixed(2)} m -> ${s1.toFixed(2)} m`);
  check('pinch keeps the spot between the fingers', Math.hypot(mid1.x - mid0.x, mid1.z - mid0.z) < 2, `${Math.hypot(mid1.x - mid0.x, mid1.z - mid0.z).toFixed(2)} mm`);
  // twist
  const r0 = await G(() => window.__game.view.world.rotation.y);
  {
    const c = { x: 206, y: 470 }, r = 60;
    const pt = (a) => ({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
    await touch('touchStart', [{ ...pt(Math.PI), id: 1 }, { ...pt(0), id: 2 }]);
    for (let i = 1; i <= 14; i++) { const a = i / 14 * 0.9; await touch('touchMove', [{ ...pt(Math.PI + a), id: 1 }, { ...pt(a), id: 2 }]); await sleep(16); }
    await touch('touchEnd', []);
    await sleep(200);
  }
  const r1 = await G(() => window.__game.view.world.rotation.y);
  check('twist turns the tray', Math.abs(r1 - r0) > 0.5, `${r0.toFixed(2)} -> ${r1.toFixed(2)} rad`);
  // size buttons
  await page.tap('.arsizes button[data-size="1"]');
  await sleep(150);
  const s2 = await G(() => ({ size: window.__game.ar.size, scale: window.__game.view.world.scale.x }));
  check('size button 1 m', Math.abs(s2.size - 1) < 1e-6 && Math.abs(s2.scale - 1 / 300) < 1e-9, JSON.stringify(s2));
  check('size button marked', await page.$eval('.arsizes button[data-size="1"]', e => e.classList.contains('sel')));

  // 3. placing on a (pretend) surface
  const placed = await G(() => {
    const g = window.__game, v = g.view;
    g.ar.placed = false; g.ar.hasHit = true; g.ar.setSize(0.6);
    g.ar.reticle.matrix.makeTranslation(0.2, -0.4, -0.8);
    g.ar.placeAtReticle();
    const w = v.world;
    return { placed: g.ar.placed, x: w.position.x, y: w.position.y, z: w.position.z, s: w.scale.x, mode: document.body.dataset.ar };
  });
  check('tap places the tray on the surface at the chosen size', placed.placed && Math.abs(placed.y + 0.4) < 1e-6 && Math.abs(placed.s - 0.6 / 300) < 1e-9 && placed.mode === 'on', JSON.stringify(placed));

  console.log('errors:', errors.length ? errors.join('\n') : 'none');
  const failed = results.filter(r => !r).length;
  console.log(`${results.length - failed}/${results.length} AR checks passed`);
  await b.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
