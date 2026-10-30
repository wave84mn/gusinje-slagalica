// AR start-up and table mode, played with a pretend WebXR (no phone needed):
//  - Chrome refusing every setting, the camera refused, the tap too old: the right message each time
//  - Chrome refusing the buttons-over-camera layer: the same tap starts table mode, and a whole
//    piece drag, a wrong drop, moving the tray, a hint and the finish all work through WebXR taps
//  - a phone that can't find surfaces: the tray spot waits in front of the phone
// usage: node tests/ar_start.cjs <url>
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:8099/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fakeXR = (mode) => {
  const ua = navigator.userAgent.replace(/\(([^)]*)\)/, '(Linux; Android 14; Pixel 7)');
  Object.defineProperty(navigator, 'userAgent', { get: () => ua });
  window.__asked = [];
  const makeSession = (overlay) => {
    const L = {};
    const s = {
      enabledFeatures: overlay ? ['hit-test', 'dom-overlay'] : ['local'],
      domOverlayState: overlay ? { type: 'screen' } : undefined,
      addEventListener(t, f) { (L[t] = L[t] || []).push(f); }, removeEventListener() {},
      end() { window.__ended = (window.__ended || 0) + 1; setTimeout(() => (L.end || []).forEach(f => f({})), 0); return Promise.resolve(); },
      requestReferenceSpace: async () => ({}),
      requestHitTestSource: async () => { throw new DOMException('no hit test here', 'NotSupportedError'); },
    };
    return s;
  };
  Object.defineProperty(navigator, 'xr', { value: {
    isSessionSupported: async () => true,
    requestSession: async (m, opts) => {
      window.__asked.push({ m, required: opts.requiredFeatures || [], optional: opts.optionalFeatures || [], overlay: !!(opts.domOverlay && opts.domOverlay.root) });
      if (mode === 'notsupported') throw new DOMException('The specified session configuration is not supported.', 'NotSupportedError');
      if (mode === 'denied') throw new DOMException('Permission denied.', 'NotAllowedError');
      if (mode === 'again') throw new DOMException('The requested session requires user activation.', 'SecurityError');
      if (mode === 'overlayfails' && opts.domOverlay) throw new DOMException('The specified session configuration is not supported.', 'NotSupportedError');
      return makeSession(false);
    },
    addEventListener() {},
  } });
};
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = [];
  const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
  const open = async (mode) => {
    const ctx = await b.newContext({ viewport: { width: 412, height: 892 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'sr-Latn-ME' });
    await ctx.addInitScript(fakeXR, mode);
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(url + '?reset&lowpower');
    await p.waitForFunction(() => window.__game && window.__game.state.mode === 'attract', null, { timeout: 120000 });
    await p.tap('[data-level="easy"]'); await sleep(400);
    await p.tap('#bHelpGo'); await sleep(700);
    return { ctx, p, errors };
  };
  const info = p => p.evaluate(() => ({ shown: !document.querySelector('#arInfo').hidden, why: document.querySelector('#arWhy').textContent,
    detail: document.querySelector('#arDetail').textContent, asked: window.__asked, store: !document.querySelector('#arOpenStore').hidden,
    ar: document.body.dataset.ar || '', active: window.__game.ar.active }));

  // 1. Chrome refuses everything: all three settings tried in one tap, then the "blocked" advice
  {
    const { ctx, p, errors } = await open('notsupported');
    await p.tap('#bAR'); await sleep(500);
    const r = await info(p);
    check('refused: one tap tries the full game, table mode and plain AR', r.asked.length === 3 && r.asked[0].overlay && !r.asked[1].overlay && r.asked[2].optional.length === 0 && r.asked.every(a => a.required.length === 0), JSON.stringify(r.asked));
    check('refused: explains what to reset, with the Play Store button', r.shown && /Resetuj dozvole/.test(r.why) && /Google Play Services for AR/.test(r.why) && r.store, r.why);
    check('refused: detail lists each try and the camera permission', /overlay: NotSupportedError/.test(r.detail) && /table: NotSupportedError/.test(r.detail) && /plain: NotSupportedError/.test(r.detail) && /camera: /.test(r.detail) && /Chrome /.test(r.detail), r.detail);
    check('refused: game left as it was', r.ar === '' && !r.active);
    await p.tap('#arInfo [data-close]'); await sleep(300);
    await p.evaluate(() => { window.__asked = []; });
    await p.tap('#bAR'); await sleep(400);
    check('refused: the next tap tries everything again', (await p.evaluate(() => window.__asked.length)) === 3);
    check('refused: no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }
  // 2. camera refused / tap too old: stop at once with the matching message
  for (const [mode, re, name] of [['denied', /Kamera/, 'NotAllowedError'], ['again', /Dodirni AR još jednom/, 'SecurityError']]) {
    const { ctx, p, errors } = await open(mode);
    await p.tap('#bAR'); await sleep(500);
    const r = await info(p);
    check(`${mode}: stops after the first try with the right message`, r.asked.length === 1 && r.shown && re.test(r.why), r.why);
    check(`${mode}: detail names it`, r.detail.includes(name), r.detail);
    check(`${mode}: no page errors`, errors.length === 0, errors.join('; '));
    await ctx.close();
  }
  // 3. the overlay refused: table mode
  {
    const { ctx, p, errors } = await open('overlayfails');
    await p.evaluate(() => {
      const xr = window.__game.view.renderer.xr;
      xr.setSession = async () => {};            // no real XR in the test browser
      xr.getReferenceSpace = () => ({});
    });
    await p.tap('#bAR'); await sleep(600);
    const r = await p.evaluate(() => { const g = window.__game; return { asked: window.__asked, active: g.ar.active, bare: g.ar.bare, bench: g.bench, info: !document.querySelector('#arInfo').hidden, note: g.ar._noteText }; });
    check('overlay refused: the same tap starts table mode', r.active && r.bare && !r.info && r.asked.length === 2 && r.asked[0].overlay && !r.asked[1].overlay, JSON.stringify({ asked: r.asked.length, active: r.active, bare: r.bare, info: r.info }));
    check('table mode: 16 pieces wait on the table, the note says where to tap', r.bench.length === 16 && /podlog/i.test(r.note), `${r.bench.length} pieces · "${r.note}"`);

    // put the tray down (the screen camera stands in for the phone) and play with WebXR taps
    await p.evaluate(() => {
      const g = window.__game, v = g.view;
      v.rig = { x: 0, z: 60, dist: v.fitDist * 1.1, tilt: 0.6, yaw: 0 }; v.applyRig();
      v.world.position.set(0, 0, 0); v.world.rotation.set(0, 0, 0); v.setWorldScale(1);
      g.ar.placed = true; v.world.visible = true; g.ar.hooks.onPlaced();
      const T = v.world.position.constructor, M = v.world.matrix.constructor;
      window.__pose = L => {          // a WebXR pose from the camera through the game point L (mm)
        v.world.updateMatrixWorld();
        const W = v.world.localToWorld(new T(L[0], L[1], L[2]));
        const C = v.activeCamera().getWorldPosition(new T());
        const m = new M().lookAt(C, W, new T(0, 1, 0)).setPosition(C);
        return { transform: { matrix: m.elements } };
      };
      const src = { targetRaySpace: {} };
      window.__ev = L => ({ inputSource: src, frame: { getPose: () => window.__pose(L) } });
      window.__frame = L => ({ getPose: () => window.__pose(L), getViewerPose: () => null });
    });
    const note = await p.evaluate(() => window.__game.ar._noteText);
    check('table mode: after placing, the note explains the moves and Back', /Nazad/.test(note), note);
    // drag the first bench piece to its place: the piece sits just beyond the finger
    const dragTo = async (code, aim) => p.evaluate(([code, aim]) => {
      const g = window.__game, v = g.view, a = g.ar;
      const i = g.bench.indexOf(code), s = g.benchSlot(i);
      a.select('down', window.__ev([s.x, 0, s.z]));
      const y = v.floorY + 7;
      // finger point that leaves the piece (pushed away from the camera by half + 10) right on the aim
      v.world.updateMatrixWorld();
      const cam = v.activeCamera().getWorldPosition(new (v.world.position.constructor)()); v.world.worldToLocal(cam);
      const dx = aim[0] - cam.x, dz = aim[1] - cam.z, len = Math.hypot(dx, dz), off = g.pieces.get(code).half + 10;
      const fx = aim[0] - dx / len * off, fz = aim[1] - dz / len * off;
      for (let k = 1; k <= 12; k++) { const t = k / 12; a.onFrame(window.__frame([s.x + (fx - s.x) * t, y, s.z + (fz - s.z) * t])); }
      const pos = g.pieces.get(code).obj.position;
      const held = { x: pos.x, z: pos.z };
      a.select('up', window.__ev([fx, y, fz]));
      return held;
    }, [code, aim]);
    const first = (await p.evaluate(() => window.__game.bench))[0];
    const tgt = await p.evaluate(c => { const t = window.__game.pieces.get(c).target; return [t.x, t.z]; }, first);
    const held = await dragTo(first, tgt);
    await sleep(400);
    const s1 = await p.evaluate(() => ({ placed: window.__game.state.placed, bench: window.__game.bench }));
    check('table mode: drag a piece from the table into its place', s1.placed.includes(first) && Math.hypot(held.x - tgt[0], held.z - tgt[1]) < 2, `${first} held at ${held.x.toFixed(1)},${held.z.toFixed(1)} for ${tgt.map(n => n.toFixed(1))}`);
    check('table mode: the table refills to 16 pieces', s1.bench.length === 16 && !s1.bench.includes(first));
    // a wrong drop goes back to the table
    const second = s1.bench[0];
    const far = await p.evaluate(c => { const t = window.__game.pieces.get(c).target; return [-t.x * 0.2 + (t.x > 0 ? -110 : 110), t.z > 0 ? -100 : 100]; }, second);
    await dragTo(second, far);
    await sleep(300);
    const s2 = await p.evaluate(c => { const g = window.__game, i = g.bench.indexOf(c), s = g.benchSlot(i), o = g.pieces.get(c).obj.position; return { placed: g.state.placed.includes(c), i, d: Math.hypot(o.x - s.x, o.z - s.z) }; }, second);
    check('table mode: a wrong drop goes back to its spot on the table', !s2.placed && s2.i === 0 && s2.d < 0.01, JSON.stringify(s2));
    // drag an empty spot: the tray moves with the finger
    const mv = await p.evaluate(() => {
      const g = window.__game, v = g.view, a = g.ar;
      const P0 = [0, 0, -60];
      a.select('down', window.__ev(P0));
      v.world.updateMatrixWorld();
      const W0 = v.world.localToWorld(new (v.world.position.constructor)(...P0));
      const dest = W0.clone().add(new (v.world.position.constructor)(40, 0, 25));
      for (let k = 1; k <= 10; k++) {
        const t = k / 10, Wt = W0.clone().lerp(dest, t);
        const L = v.world.worldToLocal(Wt.clone());
        a.onFrame(window.__frame([L.x, L.y, L.z]));
      }
      const L = v.world.worldToLocal(dest.clone());
      a.select('up', window.__ev([L.x, L.y, L.z]));
      v.world.updateMatrixWorld();
      const under = v.world.worldToLocal(dest.clone());
      return { pos: [v.world.position.x, v.world.position.z], under: [under.x, under.z] };
    });
    check('table mode: dragging an empty spot moves the tray with the finger', Math.abs(mv.pos[0] - 40) < 1 && Math.abs(mv.pos[1] - 25) < 1 && Math.hypot(mv.under[0], mv.under[1] + 60) < 1, JSON.stringify(mv));
    // hold an empty spot: hint
    const h0 = await p.evaluate(() => window.__game.state.hints);
    await p.evaluate(() => window.__game.ar.select('down', window.__ev([0, 0, -60])));
    await sleep(700);
    await p.evaluate(() => window.__game.ar.select('up', window.__ev([0, 0, -60])));
    await sleep(200);
    check('table mode: holding an empty spot gives a hint', (await p.evaluate(() => window.__game.state.hints)) === h0 + 1);
    // finish: place all but one, drag the last one, AR closes and the result card shows
    await p.evaluate(() => { const g = window.__game, keep = g.bench[0]; g.state.order.filter(c => c !== keep && !g.state.placed.includes(c)).forEach(c => g.place(c, false)); g.layoutBench(); });
    const last = (await p.evaluate(() => window.__game.bench))[0];
    const lt = await p.evaluate(c => { const t = window.__game.pieces.get(c).target; return [t.x, t.z]; }, last);
    await dragTo(last, lt);
    await sleep(800);
    const f1 = await p.evaluate(() => ({ placed: window.__game.state.placed.length, note: window.__game.ar._noteText, active: window.__game.ar.active }));
    check('table mode: the last piece finishes the puzzle in AR', f1.placed === 64 && f1.active && /Bravo/.test(f1.note), JSON.stringify(f1));
    await sleep(4000);
    const f2 = await p.evaluate(() => ({ active: window.__game.ar.active, done: !document.querySelector('#done').hidden, ar: document.body.dataset.ar || '', loose: [...window.__game.pieces.values()].filter(p => p.obj.parent === window.__game.view.world).length }));
    check('table mode: AR closes by itself and the result card shows', !f2.active && f2.done && f2.ar === '' && f2.loose === 0, JSON.stringify(f2));
    check('table mode: no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }
  // 4. a phone without surface finding: the spot waits 55 cm ahead and 45 cm below the phone
  {
    const { ctx, p } = await open('none');
    const r = await p.evaluate(() => {
      const g = window.__game, v = g.view, a = g.ar;
      const M = new (v.world.matrix.constructor)();
      const E = new (v.world.rotation.constructor)(-0.61, Math.PI / 2, 0, 'YXZ');   // turned left, looking down
      M.makeRotationFromEuler(E).setPosition(0.3, 1.4, -0.2);
      const xr = v.renderer.xr, orig = xr.getReferenceSpace;
      xr.getReferenceSpace = () => ({});
      a.session = { fake: true }; a.hitSource = null; a.placed = false; let seen = null;
      const hook = a.hooks.onSurface; a.hooks.onSurface = f => { seen = f; };
      a.onFrame({ getViewerPose: () => ({ transform: { matrix: M.elements } }) });
      const P = new (v.world.position.constructor)().setFromMatrixPosition(a.reticle.matrix);
      a.hooks.onSurface = hook; xr.getReferenceSpace = orig; a.session = null;
      return { x: P.x, y: P.y, z: P.z, hasHit: a.hasHit, vis: a.reticle.visible, seen };
    });
    const ok = Math.abs(r.x - (0.3 - 0.55)) < 1e-3 && Math.abs(r.y - 0.95) < 1e-3 && Math.abs(r.z + 0.2) < 1e-3 && r.hasHit && r.vis && r.seen === true;
    check('no surface finding: tray spot waits in front of the phone, ready to tap', ok, JSON.stringify(r));
    await ctx.close();
  }
  await b.close();
  const failed = results.filter(r => !r).length;
  console.log(`${results.length - failed}/${results.length} AR start checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
