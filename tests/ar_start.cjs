// What the player sees when the phone says yes to AR but then something goes wrong, played with a
// pretend WebXR (no phone needed): a refused session, a refused camera, a session without the
// buttons-over-camera overlay, and a phone that can't find surfaces (the tray then waits in front).
// usage: node tests/ar_start.cjs <url>
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:8099/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fakeXR = (mode) => {
  const ua = navigator.userAgent.replace(/\(([^)]*)\)/, '(Linux; Android 14; Pixel 7)');
  Object.defineProperty(navigator, 'userAgent', { get: () => ua });
  const session = { enabledFeatures: ['hit-test'], domOverlayState: undefined, ended: 0,
    addEventListener() {}, removeEventListener() {}, end() { session.ended++; window.__ended = session.ended; return Promise.resolve(); } };
  Object.defineProperty(navigator, 'xr', { value: {
    isSessionSupported: async () => true,
    requestSession: async (m, opts) => {
      window.__asked = JSON.parse(JSON.stringify({ m, required: opts.requiredFeatures || [], optional: opts.optionalFeatures || [], overlay: !!(opts.domOverlay && opts.domOverlay.root) }));
      if (mode === 'notsupported') throw new DOMException('The specified session configuration is not supported.', 'NotSupportedError');
      if (mode === 'denied') throw new DOMException('Permission denied.', 'NotAllowedError');
      return session;
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
    await p.goto(url + '?reset&lowpower');
    await p.waitForFunction(() => window.__game && window.__game.state.mode === 'attract', null, { timeout: 120000 });
    await p.tap('[data-level="easy"]'); await sleep(400);
    await p.tap('#bHelpGo'); await sleep(700);
    return { ctx, p, errors };
  };
  for (const [mode, key, want] of [['notsupported', 'start', 'NotSupportedError'], ['denied', 'denied', 'NotAllowedError'], ['nooverlay', 'overlay', 'overlay: no']]) {
    const { ctx, p, errors } = await open(mode);
    const off = await p.$eval('#bAR', e => e.classList.contains('off'));
    await p.tap('#bAR'); await sleep(500);
    const r = await p.evaluate(k => ({ shown: !document.querySelector('#arInfo').hidden, why: document.querySelector('#arWhy').textContent,
      expect: window.__i18n ? '' : null, detail: document.querySelector('#arDetail').textContent, asked: window.__asked, ended: window.__ended || 0,
      ar: document.body.dataset.ar || '', active: window.__game.ar.active }), key);
    const textOk = { start: /dodirni AR još jednom/, denied: /Kamera/, overlay: /preko kamere/ }[key].test(r.why);
    check(`${mode}: AR button on, tap explains in Montenegrin`, !off && r.shown && textOk, r.why);
    check(`${mode}: detail names the cause`, r.detail.includes(want), r.detail);
    check(`${mode}: asked leniently (nothing required, overlay offered)`, r.asked && r.asked.required.length === 0 && r.asked.optional.includes('dom-overlay') && r.asked.optional.includes('hit-test') && r.asked.overlay, JSON.stringify(r.asked));
    check(`${mode}: game left as it was`, r.ar === '' && !r.active && (mode !== 'nooverlay' || r.ended === 1), JSON.stringify({ ar: r.ar, active: r.active, ended: r.ended }));
    if (mode === 'notsupported') {
      // second tap tries again (not stuck)
      await p.tap('#arInfo [data-close]'); await sleep(300);
      await p.evaluate(() => { window.__asked = null; });
      await p.tap('#bAR'); await sleep(400);
      check('notsupported: second tap asks the phone again', !!(await p.evaluate(() => window.__asked)));
    }
    check(`${mode}: no page errors`, errors.length === 0, errors.join('; '));
    await ctx.close();
  }
  // a phone without surface finding: the spot waits 55 cm ahead and 45 cm below the phone
  {
    const { ctx, p } = await open('none');
    const r = await p.evaluate(() => {
      const g = window.__game, v = g.view, a = g.ar;
      const M = new (v.world.matrix.constructor)();
      // phone 1.4 m up, turned 90 degrees left, looking 35 degrees down
      const E = new (v.world.rotation.constructor)(-0.61, Math.PI / 2, 0, 'YXZ');
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
