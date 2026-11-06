// AR through the camera, checked in a phone-size Chromium: a fake camera films a wooden table
// (tests/fake_camera.py writes build/table.y4m) and the phone's motion sensors are played by the
// test (window.__ori: alpha, beta, gamma in degrees, sent 60 times a second). An iPhone-style motion
// permission call is stubbed so the test can see it is asked inside the tap.
// usage: node tests/ar_cam.cjs <url> [screenshot dir]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const url = process.argv[2] || 'http://127.0.0.1:8099/';
const shots = process.argv[3] || '';
const Y4M = path.join(__dirname, '..', 'build', 'table.y4m');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(Y4M)) require('child_process').execFileSync('python3', [path.join(__dirname, 'fake_camera.py'), Y4M]);
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${Y4M}`] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    window.__ori = { alpha: 0, beta: 50, gamma: 0 };
    setInterval(() => { if (window.__ori) window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', window.__ori)); }, 16);
    window.__perm = { calls: 0, active: null, answer: 'granted' };
    DeviceOrientationEvent.requestPermission = function () {
      window.__perm.calls++;
      window.__perm.active = navigator.userActivation ? navigator.userActivation.isActive : null;
      return Promise.resolve(window.__perm.answer);
    };
  });
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })) });
  // a quick tap with the finger's own times (this slow test browser would otherwise stretch it out)
  const tap = async (x, y) => { const ts = Date.now() / 1000; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }], timestamp: ts }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: ts + 0.09 }); };
  const G = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, ms = 60000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
  const results = [];
  const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
  const shot = async n => { if (shots) await page.screenshot({ path: path.join(shots, n + '.png') }); };
  const ori = (o) => G(o => { window.__ori = o; }, o);
  // let the smoothed camera catch up with the sensors (the software renderer here is slow)
  const settle = () => until(() => {
    const a = window.__game.ar, o = window.__ori, r = a.reading;
    if (!o || a.sensors !== 'yes' || a.frozen) return true;
    return r && r.a === o.alpha && r.b === o.beta && r.g === o.gamma && a.cam.quaternion.angleTo(a.qRaw) < 1e-3;
  }).then(() => sleep(250));
  const trayOnScreen = () => G(() => { const v = window.__game.view; const s = v.worldToScreen(new v.world.position.constructor(0, v.floorY, 0)); return { x: s.x, y: s.y }; });
  const T = k => G(k => window.__t(k), k);

  await page.goto(url + (url.includes('?') ? '&' : '?') + 'reset&lowpower');
  await until(() => window.__game && window.__game.state.mode === 'attract', null, 180000);
  await G(() => { window.__t = k => import('./js/i18n.js').then(m => m.t(k)); });
  await page.tap('.lvl[data-level="easy"]');
  await sleep(400);
  await page.tap('#bHelpGo');
  await sleep(600);
  check('AR button ready (camera available)', !(await page.$eval('#bAR', e => e.classList.contains('off'))));

  // ---------- start ----------
  await page.tap('#bAR');
  await until(() => document.body.dataset.ar === 'placing' && document.body.dataset.cam === 'live');
  const vid = await G(() => { const v = document.getElementById('cam'); return { w: v.videoWidth, h: v.videoHeight, paused: v.paused, inPage: !!v.parentNode }; });
  check('camera picture on the page and playing', vid.w >= 640 && vid.h >= 640 && !vid.paused && vid.inPage, JSON.stringify(vid));
  const perm = await G(() => window.__perm);
  check('iPhone motion permission asked once, inside the tap', perm.calls === 1 && perm.active === true, JSON.stringify(perm));
  await until(() => window.__game.ar.sensors === 'yes');
  check('motion sensors followed', true);
  const fov = await G(() => window.__game.ar.cam.fov);
  check('field of view matches the picture filling the screen', Math.abs(fov - 66) < 0.5, fov.toFixed(2) + '°');

  // ---------- placing ----------
  await ori({ alpha: 0, beta: 50, gamma: 0 });
  await settle();
  await until(() => window.__game.ar.aimState === 'ready');
  const hov = await G(() => { const g = window.__game, w = g.view.world; return { y: w.position.y, vis: w.visible, hover: g.ar.hover, ret: g.ar.reticle.visible }; });
  check('aiming at the table: the tray hovers (and gently bobs) over it', hov.vis && hov.ret && Math.abs(hov.y - (-0.42 + 0.035)) < 0.006, JSON.stringify(hov));
  check('hint: tap to set it down', (await page.textContent('#arHintText')) === await T('arReady'));
  const mid = await trayOnScreen();
  check('the tray hovers in the middle of the screen', Math.abs(mid.x - 195) < 6 && Math.abs(mid.y - 422) < 40, JSON.stringify(mid));
  await shot('ar1_placing');
  await ori({ alpha: 0, beta: 90, gamma: 0 });
  await settle();
  await until(() => window.__game.ar.aimState === 'aim');
  check('looking at the horizon: hint to tilt down, with the tilting phone', (await page.textContent('#arHintText')) === await T('arAim')
    && await page.$eval('#arHint .tiltico', e => getComputedStyle(e).display !== 'none'));
  await shot('ar2_tilt');
  await ori({ alpha: 0, beta: 50, gamma: 0 });
  await settle();

  // ---------- set it down ----------
  await tap(195, 300);
  await until(() => window.__game.ar.placed && !window.__game.ar.drop && document.body.dataset.ar === 'on');
  const down = await G(() => { const w = window.__game.view.world; return { y: w.position.y, hover: window.__game.ar.hover }; });
  check('a tap sets the tray down on the table', Math.abs(down.y + 0.42) < 1e-6 && down.hover === 0, JSON.stringify(down));
  check('tip about fingers and Freeze', (await page.textContent('#toast')) === await T('arPlaced'));
  await shot('ar3_placed');

  // ---------- the tray stays on the table while the phone turns ----------
  const P0 = await G(() => window.__game.view.world.position.toArray());
  const S0 = await trayOnScreen();
  await ori({ alpha: 12, beta: 50, gamma: 0 });
  await settle();
  const P1 = await G(() => window.__game.view.world.position.toArray());
  const S1 = await trayOnScreen();
  check('turning the phone left: the tray stays put in the room', P0.every((v, i) => Math.abs(v - P1[i]) < 1e-9), JSON.stringify(P1));
  check('... and slides right on the screen', S1.x - S0.x > 40 && Math.abs(S1.y - S0.y) < 40, `${S0.x.toFixed(0)} -> ${S1.x.toFixed(0)}`);
  await ori({ alpha: 0, beta: 40, gamma: 0 });
  await settle();
  const S2 = await trayOnScreen();
  check('tilting the phone down: the tray moves up on the screen', S0.y - S2.y > 40, `${S0.y.toFixed(0)} -> ${S2.y.toFixed(0)}`);
  await ori({ alpha: 0, beta: 50, gamma: 0 });
  await settle();

  // ---------- play: drag a piece from the drawer into the tray ----------
  const st = await G(() => window.__game.state);
  const code = st.order.find(c => !st.placed.includes(c));
  const tile = await page.$(`.pc[data-code="${code}"]`);
  await tile.scrollIntoViewIfNeeded();
  await sleep(200);
  const tb = await tile.boundingBox();
  const start = { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 };
  const tgt = await G(c => window.__game.screenOf(c), code);
  const lift = await G(c => window.__game.liftFor(c, true), code);
  const end = { x: tgt.x, y: tgt.y + lift };
  await touch('touchStart', [start]);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: start.x, y: start.y - i * 6 }]); await sleep(16); }
  for (let i = 1; i <= 14; i++) { const k = i / 14; await touch('touchMove', [{ x: start.x + (end.x - start.x) * k, y: start.y - 36 + (end.y - start.y + 36) * k }]); await sleep(20); }
  await sleep(300);
  await shot('ar4_drag');
  // the phone turns a little while the finger holds still: the piece stays under the finger
  const before = await G(() => { const d = window.__game.drag; return d && d.p.obj.position.toArray(); });
  await ori({ alpha: 3, beta: 50, gamma: 0 });
  await settle();
  const during = await G(() => { const d = window.__game.drag; return d && d.p.obj.position.toArray(); });
  check('a held piece follows the finger while the phone turns', before && during && Math.hypot(during[0] - before[0], during[2] - before[2]) > 5,
    before && during ? `${Math.hypot(during[0] - before[0], during[2] - before[2]).toFixed(1)} mm` : 'no drag');
  await ori({ alpha: 0, beta: 50, gamma: 0 });
  await settle();
  await touch('touchMove', [end]);
  await sleep(200);
  await touch('touchEnd', []);
  await until(c => window.__game.state.placed.includes(c), code, 20000).catch(() => {});
  check('a piece dragged from the drawer drops into its place in AR', (await G(() => window.__game.state)).placed.includes(code), code);

  // ---------- fingers on the empty table: slide, pinch, twist ----------
  const under = (x, y) => G(([x, y]) => { const p = window.__game.view.screenToPlane(x, y, window.__game.view.floorY); return p && { x: p.x, z: p.z }; }, [x, y]);
  const a0 = await under(195, 360);
  await touch('touchStart', [{ x: 195, y: 360 }]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: 195 + i * 5, y: 360 - i * 3 }]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(300);
  const a1 = await under(245, 330);
  check('one finger slides the tray with the finger', a0 && a1 && Math.hypot(a1.x - a0.x, a1.z - a0.z) < 2, a0 && a1 ? Math.hypot(a1.x - a0.x, a1.z - a0.z).toFixed(2) + ' mm' : '');
  const m0 = await under(195, 400), s0 = await G(() => window.__game.ar.size);
  await touch('touchStart', [{ x: 165, y: 400, id: 1 }, { x: 225, y: 400, id: 2 }]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: 165 - i * 4, y: 400, id: 1 }, { x: 225 + i * 4, y: 400, id: 2 }]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(300);
  const m1 = await under(195, 400), s1 = await G(() => window.__game.ar.size);
  check('pinch makes the tray bigger', s1 > s0 * 1.4, `${s0.toFixed(2)} m -> ${s1.toFixed(2)} m`);
  check('... around the spot between the fingers', Math.hypot(m1.x - m0.x, m1.z - m0.z) < 3, Math.hypot(m1.x - m0.x, m1.z - m0.z).toFixed(2) + ' mm');
  const yaw = () => G(() => { const f = new (window.__game.view.world.position.constructor)(0, 0, -1).applyQuaternion(window.__game.view.world.quaternion); return Math.atan2(-f.x, -f.z); });
  const r0 = await yaw();
  {
    const c = { x: 195, y: 400 }, r = 60, pt = a => ({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
    await touch('touchStart', [{ ...pt(Math.PI), id: 1 }, { ...pt(0), id: 2 }]);
    for (let i = 1; i <= 12; i++) { const a = i / 12 * 0.9; await touch('touchMove', [{ ...pt(Math.PI + a), id: 1 }, { ...pt(a), id: 2 }]); await sleep(16); }
    await touch('touchEnd', []);
    await sleep(300);
  }
  const r1 = await yaw();
  check('twist turns the tray', Math.abs(Math.atan2(Math.sin(r1 - r0), Math.cos(r1 - r0))) > 0.5, `${r0.toFixed(2)} -> ${r1.toFixed(2)} rad`);

  // ---------- freeze ----------
  await page.tap('#bArFreeze');
  await until(() => document.body.dataset.cam === 'still');
  const still = await G(() => { const c = document.getElementById('camStill'), v = document.getElementById('cam'); const d = c.getContext('2d').getImageData(c.width / 2, c.height * 0.6, 1, 1).data; return { w: c.width, h: c.height, vw: v.videoWidth, vh: v.videoHeight, px: [...d] }; });
  check('Freeze keeps the camera picture', still.w === still.vw && still.h === still.vh && still.w > 0 && still.px[0] > 40, JSON.stringify(still));
  check('Freeze button turns into Camera', (await page.textContent('#bArFreeze .cap')) === await T('arLive'));
  const F0 = await trayOnScreen();
  await ori({ alpha: 25, beta: 70, gamma: 0 });
  await sleep(1500);
  const F1 = await trayOnScreen();
  check('frozen: turning the phone moves nothing', Math.hypot(F1.x - F0.x, F1.y - F0.y) < 0.5, `${F0.x.toFixed(1)},${F0.y.toFixed(1)} -> ${F1.x.toFixed(1)},${F1.y.toFixed(1)}`);
  await shot('ar5_frozen');
  await page.tap('#bArFreeze');
  await until(() => document.body.dataset.cam === 'live');
  await settle();
  const F2 = await trayOnScreen();
  check('Camera again: the view follows the phone', Math.hypot(F2.x - F0.x, F2.y - F0.y) > 40, `${F2.x.toFixed(0)},${F2.y.toFixed(0)}`);

  // ---------- the tray out of view: an arrow points to it ----------
  await ori({ alpha: 110, beta: 60, gamma: 0 });
  await settle();
  await until(() => document.getElementById('arArrow').classList.contains('on'), null, 20000).catch(() => {});
  check('tray out of view: an arrow at the edge points to it', await page.$eval('#arArrow', e => e.classList.contains('on')));
  await shot('ar6_arrow');
  await ori({ alpha: 0, beta: 50, gamma: 0 });
  await settle();
  await until(() => !document.getElementById('arArrow').classList.contains('on'), null, 20000).catch(() => {});
  check('back in view: no arrow', !(await page.$eval('#arArrow', e => e.classList.contains('on'))));

  // ---------- light from the camera ----------
  const light = await G(() => { const a = window.__game.ar, v = window.__game.view; return { k: a.light && a.light.k, sun: v.sun.intensity, base: a.base.sun }; });
  check('the model takes its light from the camera picture', light.k && Math.abs(light.sun - light.base) > 0.01, JSON.stringify(light));

  // ---------- floor ----------
  await page.tap('#bArMove');
  await until(() => document.body.dataset.ar === 'placing');
  await page.tap('.arsurf [data-surf="floor"]');
  await settle();
  await sleep(800);
  const fl = await G(() => { const g = window.__game; return { y: g.view.world.position.y, size: g.ar.size, sel: document.querySelector('.arsurf .sel').dataset.surf }; });
  check('Floor: farther down, a 1 m tray', Math.abs(fl.y - (-1.3 + 0.035)) < 0.012 && fl.size === 1 && fl.sel === 'floor', JSON.stringify(fl));
  await shot('ar7_floor');
  await page.tap('#bArPlace');
  await until(() => window.__game.ar.placed && !window.__game.ar.drop);
  await page.tap('#bArMove');
  await page.tap('.arsurf [data-surf="table"]');
  await page.tap('#bArPlace');
  await until(() => window.__game.ar.placed && !window.__game.ar.drop);

  // ---------- finish in AR: labels over the camera ----------
  await G(() => { const g = window.__game; for (const c of g.state.order) if (!g.state.placed.includes(c)) g.place(c, false); });
  await until(() => window.__game.state.mode === 'explore', null, 30000);
  await sleep(2500);
  const lbl = await G(() => [...document.querySelectorAll('.lbl')].filter(e => e.style.display === 'block').length);
  check('finished in AR: still in AR, landmark names over the camera', lbl > 0 && await G(() => document.body.dataset.ar === 'on'), `${lbl} labels`);
  await shot('ar8_done');

  // ---------- leave AR ----------
  await G(() => document.querySelectorAll('.ov').forEach(e => { e.hidden = true; }));
  await page.tap('#bArExit');
  await until(() => !document.body.dataset.ar);
  const off = await G(() => { const g = window.__game, v = g.view; return { stream: !!g.ar.stream, inAR: v.inAR, cam: document.body.dataset.cam || '', y: v.world.position.y, s: v.world.scale.x, sun: v.sun.intensity, base: g.ar.base.sun }; });
  check('Exit: camera off, back to the screen view, light restored', !off.stream && !off.inAR && !off.cam && off.y === 0 && off.s === 1 && off.sun === off.base, JSON.stringify(off));

  // ---------- no motion sensors ----------
  await page.tap('#bExploreNew').catch(() => {});
  await sleep(300);
  await page.tap('.lvl[data-level="easy"]');
  await sleep(500);
  await G(() => { window.__ori = null; });
  await page.tap('#bAR');
  await until(() => window.__game.ar.sensors === 'no', null, 90000);
  check('no sensor readings: the tray stays on the screen, with a note', (await page.textContent('#toast')) === await T('arNoSensors')
    && (await page.textContent('#arHintText')) === await T('arFixed'));
  await page.tap('#bArPlace');
  await until(() => window.__game.ar.placed && !window.__game.ar.drop);
  const n0 = await trayOnScreen();
  await touch('touchStart', [{ x: 195, y: 420 }]);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: 195 + i * 6, y: 420 }]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(300);
  const n1 = await trayOnScreen();
  check('... and fingers move it', n1.x - n0.x > 30, `${n0.x.toFixed(0)} -> ${n1.x.toFixed(0)}`);
  await shot('ar9_nosensors');
  await page.tap('#bArExit');
  await until(() => !document.body.dataset.ar);
  // iPhone, motion refused: the same, and the note says how to allow it
  await G(() => { window.__perm.answer = 'denied'; });
  await page.tap('#bAR');
  await until(() => window.__game.ar.sensors === 'no', null, 90000);
  check('motion refused on iPhone: says how to allow it', (await page.textContent('#toast')) === await T('arMotionDenied'));
  await page.tap('#bArCancel');
  await until(() => !document.body.dataset.ar);

  // ---------- camera refused / missing / busy ----------
  for (const [name, reason] of [['NotAllowedError', 'denied'], ['NotFoundError', 'nocam'], ['NotReadableError', 'busy']]) {
    await G(n => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('test', n)); }, name);
    await page.tap('#bAR');
    await until(() => !document.getElementById('arInfo').hidden, null, 20000).catch(() => {});
    const why = await page.textContent('#arWhy');
    check(`camera ${reason}: says why and what to do`, why === await T('arWhy_' + reason) && !(await G(() => !!document.body.dataset.ar)), why.slice(0, 60));
    if (reason === 'denied') await shot('ar10_denied');
    await G(() => { document.getElementById('arInfo').hidden = true; });
  }

  console.log('errors:', errors.length ? errors.join('\n') : 'none');
  check('no errors on the page', errors.length === 0);
  const failed = results.filter(r => !r).length;
  console.log(`${results.length - failed}/${results.length} AR camera checks passed`);
  await b.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
