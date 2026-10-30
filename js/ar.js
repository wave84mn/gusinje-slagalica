// AR on a real table or floor (WebXR "immersive-ar": Chrome on Android phones with ARCore).
// Point the phone at a surface, tap to put the tray down, then play as usual with the drawer.
//   one finger on the empty screen: slide the tray along the surface
//   two fingers: pinch to resize, twist to turn the tray
//   size buttons: 30 cm (real size), 60 cm, 1 m, 2 m
// If Chrome refuses the buttons-over-camera layer (dom-overlay), the game still starts in a simpler
// "table" mode: the pieces wait on the table in front of the tray and are dragged straight from
// there, an empty spot drags the tray, a long press shows a hint and the phone's Back button exits.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const TRAY_MM = 300;
const MIN_M = 0.12, MAX_M = 3.0;
const TWIST_START = 0.1;

function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

export class ArMode {
  constructor(view, hooks = {}) {
    this.view = view;
    this.hooks = hooks;
    this.session = null;
    this.hitSource = null;
    this.placed = false;
    this.hasHit = false;
    this.size = 0.3;                       // metres across the tray
    this.bare = false;                     // true: no buttons over the camera, play with taps on the scene
    this.input = null;                     // the touch being followed in table mode
    this.failed = new Set();               // session settings Chrome refused on this visit
    this.log = [];
    this.p = new Map();
    this.twist = 0; this.rotating = false;
    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane();

    // reticle: a ring where the tray will go, and a square showing its size
    const r = this.reticle = new THREE.Group();
    r.matrixAutoUpdate = false;
    r.visible = false;
    const mat = new THREE.MeshBasicMaterial({ color: 0xdba543, transparent: true, opacity: 0.9, depthTest: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.04, 40).rotateX(-Math.PI / 2), mat);
    const sq = this.square = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
      [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, z]) => new THREE.Vector3(x, 0, z))),
      new THREE.LineBasicMaterial({ color: 0xffe2a8, transparent: true, opacity: 0.85, depthTest: false }));
    ring.renderOrder = sq.renderOrder = 10;
    r.add(ring, sq);
    view.scene.add(r);

    // a short note floating in the scene (table mode has no buttons or text over the camera)
    const cv = this._noteCanvas = document.createElement('canvas');
    cv.width = 1024; cv.height = 300;
    this._noteTex = new THREE.CanvasTexture(cv);
    this._noteTex.colorSpace = THREE.SRGBColorSpace;
    const note = this.note = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._noteTex, transparent: true, depthTest: false, depthWrite: false }));
    note.renderOrder = 20;
    note.visible = false;
    note.center.set(0.5, 0);
    view.scene.add(note);
    this._noteText = '';
    this._noteUntil = 0;

    const el = this.touchEl = document.getElementById('touch');
    el.addEventListener('pointerdown', e => this.down(e));
    el.addEventListener('pointermove', e => this.move(e));
    el.addEventListener('pointerup', e => this.up(e));
    el.addEventListener('pointercancel', e => this.up(e, true));
  }

  static async supported() { return (await ArMode.check()).ok; }

  // Can this phone and browser do AR? If not, why not (so the game can say what to do).
  static async check() {
    const ua = navigator.userAgent || '';
    const android = /Android/i.test(ua);
    const ios = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const inApp = /; wv\)|FBAN|FBAV|Instagram|Line\/|Viber|WhatsApp|Telegram|GSA\//i.test(ua);
    const chrome = /Chrome\/\d+/.test(ua) && !/EdgA|OPR|SamsungBrowser|YaBrowser|Firefox|DuckDuckGo|Brave/i.test(ua) && !inApp;
    const base = { android, ios, inApp, chrome };
    if (!window.isSecureContext) return { ...base, ok: false, reason: 'secure' };
    if (!navigator.xr) return { ...base, ok: false, reason: ios ? 'ios' : android ? (inApp ? 'inapp' : 'browser') : 'desktop' };
    let ok = false;
    try { ok = await navigator.xr.isSessionSupported('immersive-ar'); } catch { ok = false; }
    if (ok) return { ...base, ok: true, reason: '' };
    return { ...base, ok: false, reason: ios ? 'ios' : android ? (inApp ? 'inapp' : chrome ? 'arcore' : 'browser') : 'desktop' };
  }

  get active() { return !!this.session; }

  // Start AR. Chrome is asked for the full game first (buttons over the camera); if it refuses,
  // the same tap asks again without the overlay (table mode), then with nothing extra at all.
  async start() {
    if (this.session || this.starting) return;
    this.starting = true;
    const v = this.view, r = v.renderer;
    const ui = document.getElementById('ui');
    let tries = [
      { id: 'overlay', init: { optionalFeatures: ['hit-test', 'dom-overlay'], domOverlay: { root: ui } } },
      { id: 'table', init: { optionalFeatures: ['hit-test'] } },
      { id: 'plain', init: {} },
    ];
    if (tries.every(t => this.failed.has(t.id))) this.failed.clear();
    tries = tries.filter(t => !this.failed.has(t.id));
    const log = this.log = [];
    let session = null;
    try {
      for (const t of tries) {
        const t0 = performance.now();
        try {
          // nothing else may be awaited before this: Chrome only starts AR straight after a tap
          session = await navigator.xr.requestSession('immersive-ar', t.init);
          log.push(`${t.id}: ok`);
          break;
        } catch (err) {
          log.push(`${t.id}: ${err.name} ${Math.round(performance.now() - t0)}ms`);
          if (err.name !== 'NotSupportedError') throw err;     // tap too old, camera refused...: stop here
          this.failed.add(t.id);
        }
      }
      if (!session) {
        this.failed.clear();
        const e = new Error('Chrome refused every AR setting.');
        e.name = 'AllRefused';
        throw e;
      }
      this.features = Array.from(session.enabledFeatures || []);
      this.overlay = !!session.domOverlayState;
      this.bare = !this.overlay;
      this.session = session;
      session.addEventListener('end', () => this.cleanup());
      session.addEventListener('selectstart', ev => this.select('down', ev));
      session.addEventListener('selectend', ev => this.select('up', ev));
      r.xr.setReferenceSpaceType('local');
      await r.xr.setSession(session);
      try {
        const viewer = await session.requestReferenceSpace('viewer');
        this.hitSource = await session.requestHitTestSource({ space: viewer });
      } catch {
        this.hitSource = null;    // no surface finding: the tray waits in front of the phone instead
      }
      v.setAR(true);
      this.placed = false;
      v.world.visible = false;
      this.setSize(this.size, false);
      this.hooks.onStart?.(!!this.hitSource);
    } catch (err) {
      err.log = log.slice();
      if (session) {
        if (!this.session) session.end().catch(() => {});
        else this.end();
      }
      throw err;
    } finally {
      this.starting = false;
    }
  }

  describe() {
    const chrome = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '?';
    return `${this.log.join(', ')}${this.session ? `; features: ${(this.features || []).join(', ') || 'none'}` : ''}; Chrome ${chrome}`;
  }

  // the camera permission Chrome has for this site: granted, prompt, denied (or ? if unknown)
  static async cameraState() { return ArMode.permState('camera'); }

  // a permission's state for this site; '?' where the browser can't say (e.g. 'ar' on older Chrome)
  static async permState(name) {
    try { return (await navigator.permissions.query({ name })).state; } catch { return '?'; }
  }

  end() { this.session?.end().catch(() => {}); }

  cleanup() {
    try { this.hitSource?.cancel(); } catch { /* already gone */ }
    this.hitSource = null;
    this.session = null;
    this.reticle.visible = false;
    this.note.visible = false;
    this.input = null;
    this.p.clear();
    this.view.world.visible = true;
    this.view.setAR(false);
    this.hooks.onEnd?.();
    this.bare = false;
  }

  // called every XR frame: keep the reticle on the surface the phone points at
  onFrame(frame) {
    if (!this.session || !frame) return;
    const space = this.view.renderer.xr.getReferenceSpace();
    if (!space) return;
    this.updateNote(frame, space);
    if (this.placed) {
      if (this.bare && this.input) this.hooks.onPointer?.('move', this.rayFrom(this.input, frame, space));
      return;
    }
    if (!this.hitSource) {
      // no surface finding on this phone: keep the spot 55 cm ahead and 45 cm below the phone
      const vp = frame.getViewerPose(space);
      if (!vp) return;
      const m = new THREE.Matrix4().fromArray(vp.transform.matrix);
      const pos = new THREE.Vector3().setFromMatrixPosition(m);
      const fwd = new THREE.Vector3(0, 0, -1).transformDirection(m);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
      fwd.normalize();
      const p = pos.addScaledVector(fwd, 0.55);
      p.y -= 0.45;
      this.reticle.matrix.makeTranslation(p.x, p.y, p.z);
      this.hasHit = true;
      this.reticle.visible = true;
      this.hooks.onSurface?.(true);
      return;
    }
    const res = frame.getHitTestResults(this.hitSource);
    const pose = res.length ? res[0].getPose(space) : null;
    this.hasHit = !!pose;
    this.reticle.visible = !!pose;
    if (pose) this.reticle.matrix.fromArray(pose.transform.matrix);
    this.hooks.onSurface?.(this.hasHit);
  }

  // ---------- table mode (no overlay): taps arrive as WebXR "select" events ----------
  select(kind, ev) {
    if (!this.bare || !this.session) return;
    const space = this.view.renderer.xr.getReferenceSpace();
    if (!space) return;
    if (!this.placed) {
      if (kind === 'up') this.placeAtReticle();
      return;
    }
    if (kind === 'down') {
      if (this.input) return;
      this.input = ev.inputSource;
    } else {
      if (ev.inputSource !== this.input) return;
      this.input = null;
    }
    this.hooks.onPointer?.(kind, this.rayFrom(ev.inputSource, ev.frame, space));
  }

  // the line from the phone through the finger, in scene coordinates (metres)
  rayFrom(input, frame, space) {
    let pose = null;
    try { pose = frame.getPose(input.targetRaySpace, space); } catch { pose = null; }
    if (!pose) return null;
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    return new THREE.Ray(new THREE.Vector3().setFromMatrixPosition(m), new THREE.Vector3(0, 0, -1).transformDirection(m));
  }

  // a note floating in the scene: over the reticle while placing, over the tray for a while after
  say(text, ms = 0) {
    this._noteUntil = ms ? performance.now() + ms : 0;
    if (text === this._noteText) return;
    this._noteText = text;
    const cv = this._noteCanvas, g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    if (!text) return;
    g.font = '600 54px system-ui, sans-serif';
    const words = text.split(/\s+/), lines = [];
    let line = '';
    for (const w of words) {
      const tryLine = line ? line + ' ' + w : w;
      if (g.measureText(tryLine).width > cv.width - 90 && line) { lines.push(line); line = w; } else line = tryLine;
    }
    if (line) lines.push(line);
    const shown = lines.slice(0, 3), lh = 68, h = shown.length * lh + 50;
    const y0 = cv.height - h;
    g.fillStyle = 'rgba(28, 24, 19, 0.86)';
    g.beginPath(); g.roundRect(8, y0, cv.width - 16, h - 8, 34); g.fill();
    g.strokeStyle = 'rgba(219, 165, 67, 0.9)'; g.lineWidth = 4; g.stroke();
    g.fillStyle = '#f3e7cf'; g.textAlign = 'center'; g.textBaseline = 'middle';
    shown.forEach((l, i) => g.fillText(l, cv.width / 2, y0 + 25 + lh * (i + 0.5)));
    this._noteTex.needsUpdate = true;
  }

  updateNote(frame, space) {
    const n = this.note;
    if (!this.bare || !this._noteText || (this._noteUntil && performance.now() > this._noteUntil)) { n.visible = false; return; }
    const at = new THREE.Vector3();
    let width;
    if (!this.placed) {
      if (!this.reticle.visible) { n.visible = false; return; }
      at.setFromMatrixPosition(this.reticle.matrix);
      at.y += 0.04;
      width = 0.26;
    } else {
      const w = this.view.world;
      w.updateMatrixWorld();
      at.set(0, 60, -150);                       // above the far (north) edge of the tray
      w.localToWorld(at);
      width = Math.max(0.24, this.size * 0.9);
    }
    n.position.copy(at);
    n.scale.set(width, width * this._noteCanvas.height / this._noteCanvas.width, 1);
    n.visible = true;
  }

  placeAtReticle() {
    if (!this.hasHit) return false;
    const v = this.view, w = v.world;
    const pos = new THREE.Vector3().setFromMatrixPosition(this.reticle.matrix);
    w.position.copy(pos);
    // turn the tray so its front (the GUSINJE side, the game's south) faces the player
    const cp = new THREE.Vector3().setFromMatrixPosition(v.activeCamera().matrixWorld);
    w.quaternion.setFromAxisAngle(UP, Math.atan2(cp.x - pos.x, cp.z - pos.z));
    v.setWorldScale(this.size / TRAY_MM);
    w.visible = true;
    this.reticle.visible = false;
    this.placed = true;
    v.renderer.shadowMap.needsUpdate = true;
    this.hooks.onPlaced?.();
    return true;
  }

  // pick a new spot for the tray
  replace() {
    this.placed = false;
    this.view.world.visible = false;
    this.hooks.onStart?.(!!this.hitSource);
  }

  setSize(m, keep = true) {
    this.size = THREE.MathUtils.clamp(m, MIN_M, MAX_M);
    this.square.scale.setScalar(this.size);
    if (keep && this.placed) this.view.setWorldScale(this.size / TRAY_MM);
    this.hooks.onSize?.(this.size);
  }

  // ---------- touch on the empty screen ----------
  ground(sx, sy) {
    // where a screen point meets the horizontal plane the tray stands on (world metres)
    const v = this.view;
    const { w, h } = v.screenSize();
    this._ray.setFromCamera({ x: (sx / w) * 2 - 1, y: -(sy / h) * 2 + 1 }, v.activeCamera());
    // ignore rays that only graze the surface near the horizon: they would fling the tray away
    if (this._ray.ray.direction.y > -0.06) return null;
    this._plane.set(UP, -v.world.position.y);
    return this._ray.ray.intersectPlane(this._plane, new THREE.Vector3());
  }

  down(e) {
    try { this.touchEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.p.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
    if (this.p.size === 2) { this.twist = 0; this.rotating = false; }
    this.moved = false;
  }

  move(e) {
    const s = this.p.get(e.pointerId);
    if (!s) return;
    if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) > 8) this.moved = true;
    const v = this.view, w = v.world;
    if (!this.placed) { s.x = e.clientX; s.y = e.clientY; return; }
    if (this.p.size === 1) {
      const A = this.ground(s.x, s.y), B = this.ground(e.clientX, e.clientY);
      s.x = e.clientX; s.y = e.clientY;
      if (A && B) { w.position.add(B.sub(A)); v.renderer.shadowMap.needsUpdate = true; }
      return;
    }
    if (this.p.size !== 2) return;
    const [p1, p2] = [...this.p.values()];
    const bc = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, bd = Math.hypot(p1.x - p2.x, p1.y - p2.y), ba = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    s.x = e.clientX; s.y = e.clientY;
    const ac = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, ad = Math.hypot(p1.x - p2.x, p1.y - p2.y), aa = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const A = this.ground(bc.x, bc.y), B = this.ground(ac.x, ac.y);
    if (!A || !B || bd < 1 || ad < 1) return;
    w.updateMatrixWorld();
    const local = w.worldToLocal(A.clone());
    this.setSize(this.size * ad / bd);
    const da = wrap(aa - ba);
    this.twist += da;
    if (!this.rotating && Math.abs(this.twist) > TWIST_START) this.rotating = true;
    if (this.rotating) w.rotateOnWorldAxis(UP, -da);
    w.updateMatrixWorld();
    const now = w.localToWorld(local);
    w.position.add(B.sub(now));
    v.renderer.shadowMap.needsUpdate = true;
  }

  up(e, cancelled = false) {
    const s = this.p.get(e.pointerId);
    if (!s) return;
    this.p.delete(e.pointerId);
    if (!cancelled && !this.moved && this.p.size === 0 && performance.now() - s.t0 < 400 && !this.placed) this.placeAtReticle();
    if (this.p.size === 1) { const r = [...this.p.values()][0]; r.x0 = r.x; r.y0 = r.y; this.moved = true; }
  }
}
