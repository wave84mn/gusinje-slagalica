// AR on a real table or floor (WebXR "immersive-ar": Chrome on Android phones with ARCore).
// Point the phone at a surface, tap to put the tray down, then play as usual with the drawer.
//   one finger on the empty screen: slide the tray along the surface
//   two fingers: pinch to resize, twist to turn the tray
//   size buttons: 30 cm (real size), 60 cm, 1 m, 2 m
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

  async start() {
    if (this.session) return;
    const v = this.view, r = v.renderer;
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'dom-overlay'],
      domOverlay: { root: document.getElementById('ui') },
    });
    this.session = session;
    session.addEventListener('end', () => this.cleanup());
    r.xr.setReferenceSpaceType('local');
    await r.xr.setSession(session);
    const viewer = await session.requestReferenceSpace('viewer');
    this.hitSource = await session.requestHitTestSource({ space: viewer });
    v.setAR(true);
    this.placed = false;
    v.world.visible = false;
    this.setSize(this.size, false);
    this.hooks.onStart?.();
  }

  end() { this.session?.end().catch(() => {}); }

  cleanup() {
    try { this.hitSource?.cancel(); } catch { /* already gone */ }
    this.hitSource = null;
    this.session = null;
    this.reticle.visible = false;
    this.p.clear();
    this.view.world.visible = true;
    this.view.setAR(false);
    this.hooks.onEnd?.();
  }

  // called every XR frame: keep the reticle on the surface the phone points at
  onFrame(frame) {
    if (!this.session || !frame || this.placed || !this.hitSource) return;
    const res = frame.getHitTestResults(this.hitSource);
    const space = this.view.renderer.xr.getReferenceSpace();
    const pose = res.length ? res[0].getPose(space) : null;
    this.hasHit = !!pose;
    this.reticle.visible = !!pose;
    if (pose) this.reticle.matrix.fromArray(pose.transform.matrix);
    this.hooks.onSurface?.(this.hasHit);
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
    this.hooks.onStart?.();
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
