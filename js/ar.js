// AR through the phone's own camera, in any phone browser: Safari and Chrome on iPhone; Chrome,
// Samsung Internet and Firefox on Android. Nothing to install, no ARCore needed.
//
// The rear camera's picture fills the screen behind the transparent 3D view. The phone's motion
// sensors turn the 3D camera exactly as the phone turns, so the tray stays put on the real table
// while the phone looks around it. A web page can follow the phone turning but not moving, so the
// 3D camera stays at one point and the table (or floor) is taken to be a set distance below it.
//   placing: the tray hovers where the middle of the screen points; a tap sets it down
//   one finger on the empty screen: slide the tray; two fingers: pinch to resize, twist to turn
//   Freeze: holds the picture still, so the player can lower the phone and keep playing
// Without motion sensors (or when they're refused) the game is the same, with the tray fixed on
// the screen; the fingers move it.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const TRAY_MM = 300;
const MIN_M = 0.1, MAX_M = 3.2;
const TWIST_START = 0.1;
const DEG = Math.PI / 180;
// how far below the phone the surface is taken to be, and the tray's size there
export const SURFACES = { table: { h: 0.42, size: 0.3 }, floor: { h: 1.3, size: 1.0 } };
const HOVER_M = 0.035;   // the tray floats this high while it is being placed
const FOV_LONG = 66;     // degrees across the long side of the camera picture (phones' main cameras: about 63-72)
const NO_SENSOR_PITCH = -50 * DEG;   // how the fixed camera looks down when there are no motion sensors

function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// phone orientation (degrees) to a camera quaternion: Y up, the back camera looking along -Z
const _eul = new THREE.Euler(), _q0 = new THREE.Quaternion(), _zee = new THREE.Vector3(0, 0, 1);
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
export function deviceQuaternion(out, alpha, beta, gamma, screenAngle) {
  _eul.set(beta * DEG, alpha * DEG, -gamma * DEG, 'YXZ');
  out.setFromEuler(_eul);
  out.multiply(_q1);
  out.multiply(_q0.setFromAxisAngle(_zee, -screenAngle * DEG));
  return out;
}

function screenAngle() {
  const o = screen.orientation;
  if (o && typeof o.angle === 'number') return o.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

export class ArMode {
  constructor(view, hooks = {}) {
    this.view = view;
    this.hooks = hooks;
    this.on = false;
    this.starting = false;
    this.placed = false;
    this.frozen = false;
    this.surface = 'table';
    this.size = SURFACES.table.size;
    this.sensors = 'off';          // 'wait' for the first motion reading, then 'yes' or 'no'
    this.motionPerm = 'granted';
    const q = new URLSearchParams(location.search);
    this.fovLong = parseFloat(q.get('fov')) || FOV_LONG;
    this.cam = new THREE.PerspectiveCamera(60, 1, 0.01, 60);
    this.qRaw = new THREE.Quaternion();
    this.reading = null;           // last motion reading
    this.nReadings = 0;
    this.p = new Map();
    this.twist = 0; this.rotating = false;
    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane();
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3();
    this.aim = new THREE.Vector3(); this.aimYaw = 0; this.aimState = '';
    this.hover = 0;                // metres the tray floats above the surface
    this.drop = null;              // set-down animation
    this.light = null;             // camera brightness and colour, measured a few times a second
    this.lastVideoT = -1; this.lastVideoCheck = 0; this.stalled = false;

    this.makeReticle();

    const el = this.touchEl = document.getElementById('touch');
    el.addEventListener('pointerdown', e => this.down(e));
    el.addEventListener('pointermove', e => this.move(e));
    el.addEventListener('pointerup', e => this.up(e));
    el.addEventListener('pointercancel', e => this.up(e, true));
    this.arrow = document.getElementById('arArrow');

    this._onOrient = e => this.onOrient(e);
    this._onResize = () => this.fitCamera();
    this._onVisible = () => { if (!document.hidden) this.resume(); };
  }

  // Can AR run here at all? (The camera and motion permissions are asked when AR starts.)
  static check() {
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(ua);
    const inApp = /; wv\)|FBAN|FBAV|Instagram|Line\/|Viber|GSA\//i.test(ua);
    const base = { ios, android, inApp };
    if (!window.isSecureContext) return { ...base, ok: false, reason: 'secure' };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { ...base, ok: false, reason: inApp ? 'inapp' : 'nocam' };
    return { ...base, ok: true, reason: '' };
  }

  get active() { return this.on; }

  // Start AR. Must be called straight from a tap: iPhones only ask for the motion sensors then.
  async start() {
    if (this.on || this.starting) return;
    this.starting = true;
    const DOE = window.DeviceOrientationEvent;
    const ask = DOE && typeof DOE.requestPermission === 'function' ? DOE.requestPermission().then(r => r, () => 'denied') : null;
    try {
      this.motionPerm = ask ? await ask : 'granted';
      this.stream = await this.openCamera();
      await this.attachVideo(this.stream);
    } catch (err) {
      this.stopStream();
      delete document.body.dataset.cam;
      this.starting = false;
      throw err;
    }
    this.starting = false;
    this.on = true;
    const v = this.view;
    this.reading = null; this.nReadings = 0;
    // the readings decide: a browser may answer "denied" and still send them (or the reverse)
    this.sensors = 'wait';
    this.noReason = this.motionPerm === 'granted' ? 'none' : 'denied';
    this.frames3d = 0;
    this.t0 = performance.now();
    this.lastVideoT = -1; this.advanced = false; this.lastVideoCheck = 0; this.stalled = false;
    window.addEventListener('deviceorientation', this._onOrient);
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    document.addEventListener('visibilitychange', this._onVisible);
    this.cam.position.set(0, 0, 0);
    this.cam.quaternion.setFromEuler(new THREE.Euler(NO_SENSOR_PITCH, 0, 0, 'YXZ'));
    this.hasPose = false;
    this.fitCamera();
    this.saveLights();
    document.body.dataset.cam = 'live';
    v.setAR(true, this.cam);
    this.placed = false;
    this.frozen = false;
    this.drop = null;
    this.followed = false;
    this.setSize(SURFACES[this.surface].size);
    this.setHover(HOVER_M);
    v.world.visible = false;      // until the first aim
    this.aimState = '';
    this.hooks.onStart?.();
  }

  async openCamera() {
    const md = navigator.mediaDevices;
    const tries = [
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } },
      { audio: false, video: { facingMode: { ideal: 'environment' } } },
      { audio: false, video: true },
    ];
    let last = null;
    for (const c of tries) {
      try { return await md.getUserMedia(c); } catch (err) {
        last = err;
        // refused, or the camera is busy: asking again won't help
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError' || err.name === 'NotReadableError')) throw err;
      }
    }
    throw last || new Error('no camera');
  }

  async attachVideo(stream) {
    let v = this.video;
    if (!v) {
      v = this.video = document.createElement('video');
      v.id = 'cam';
      v.muted = true; v.autoplay = true; v.playsInline = true;
      v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.setAttribute('muted', '');
      // on the page, behind the 3D view: Safari pauses camera videos that are not on the page
      document.body.insertBefore(v, document.body.firstChild);
      const f = this.still = document.createElement('canvas');
      f.id = 'camStill';
      document.body.insertBefore(f, v.nextSibling);
      v.addEventListener('loadedmetadata', () => this.fitCamera());
      v.addEventListener('resize', () => this.fitCamera());
    }
    // shown before it plays (still under the opaque 3D view): Safari won't play, or pauses, a hidden video
    if (!document.body.dataset.cam) document.body.dataset.cam = 'live';
    v.srcObject = stream;
    this.frames = 0;
    if (v.requestVideoFrameCallback && !this._rvfc) {
      this._rvfc = true;
      const count = () => { this.frames++; v.requestVideoFrameCallback(count); };
      v.requestVideoFrameCallback(count);
    }
    try { await v.play(); } catch { /* a tap restarts it (see resume) */ }
    if (!v.videoWidth) {
      await new Promise(res => {
        const t = setTimeout(res, 2500);
        v.addEventListener('loadedmetadata', () => { clearTimeout(t); res(); }, { once: true });
      });
    }
    // the camera may stop when the phone is locked or another app takes it: open it again then
    for (const tr of stream.getVideoTracks()) tr.addEventListener('ended', () => { if (this.on && !document.hidden) this.reopen(); });
  }

  async reopen() {
    if (!this.on || this.reopening) return;
    this.reopening = true;
    try {
      this.stopStream();
      this.stream = await this.openCamera();
      await this.attachVideo(this.stream);
      this.setStalled(false);
    } catch (err) {
      console.warn('camera', err);
      this.setStalled(true);
    } finally { this.reopening = false; }
  }

  // back on screen, or a tap while the picture was stuck
  resume() {
    if (!this.on) return;
    const tr = this.stream && this.stream.getVideoTracks()[0];
    if (!tr || tr.readyState === 'ended') { this.reopen(); return; }
    if (this.video && this.video.paused) this.video.play().then(() => this.setStalled(false), () => this.setStalled(true));
  }

  stopStream() {
    if (this.stream) for (const tr of this.stream.getTracks()) { try { tr.stop(); } catch { /* already stopped */ } }
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  end() {
    if (!this.on) return;
    this.on = false;
    window.removeEventListener('deviceorientation', this._onOrient);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisible);
    this.stopStream();
    delete document.body.dataset.cam;
    this.frozen = false;
    this.stalled = false;
    this.reticle.visible = false;
    this.p.clear();
    if (this.arrow) this.arrow.classList.remove('on');
    this.restoreLights();
    this.setHover(0);
    this.view.world.visible = true;
    this.view.setAR(false);
    this.sensors = 'off';
    this.hooks.onEnd?.();
  }

  // ---------- the 3D camera follows the phone ----------
  onOrient(e) {
    if (e.alpha == null && e.beta == null && e.gamma == null) return;
    this.reading = { a: e.alpha || 0, b: e.beta || 0, g: e.gamma || 0 };
    this.nReadings++;
  }

  // Field of view of the picture as it fills the screen (object-fit: cover crops the camera's).
  fitCamera() {
    const v = this.video, c = this.cam;
    const W = window.innerWidth, H = window.innerHeight;
    const vw = (v && v.videoWidth) || 1280, vh = (v && v.videoHeight) || 720;
    const f = Math.max(vw, vh) / 2 / Math.tan(this.fovLong / 2 * DEG);   // focal length in camera pixels
    const s = Math.max(W / vw, H / vh);                                  // screen px per camera px
    c.fov = 2 * Math.atan(H / s / 2 / f) / DEG;
    c.aspect = W / H;
    c.updateProjectionMatrix();
    this.view.needsRender = true;
  }

  // Called every frame while AR is on.
  onFrame(now, dt) {
    if (!this.on) return;
    const v = this.view;
    this.frames3d++;
    if (this.sensors === 'wait') {
      if (this.nReadings >= 1) { this.sensors = 'yes'; this.hooks.onSensors?.('yes'); }
      else if (now - this.t0 > 1500 && this.frames3d > 30) {
        // nothing from the sensors after a second and a half of smooth running: there are none
        this.sensors = 'no'; this.nAtNo = this.nReadings; this.hasPose = true;
        this.cam.quaternion.setFromEuler(new THREE.Euler(NO_SENSOR_PITCH, 0, 0, 'YXZ'));
        this.hooks.onSensors?.('no', this.noReason);
      }
    } else if (this.sensors === 'no' && this.nReadings > this.nAtNo + 2) {
      // readings after all (a slow start): follow the phone from now on
      this.sensors = 'yes'; this.hasPose = false;
      this.hooks.onSensors?.('yes');
    }
    if (this.sensors === 'yes' && this.reading && !this.frozen) {
      const r = this.reading;
      deviceQuaternion(this.qRaw, r.a, r.b, r.g, screenAngle());
      // a little smoothing against sensor jitter; a big jump (or the first reading) is taken at once
      if (!this.hasPose || this.cam.quaternion.angleTo(this.qRaw) > 0.45) this.cam.quaternion.copy(this.qRaw);
      else this.cam.quaternion.slerp(this.qRaw, 1 - Math.exp(-dt * 32));
      this.hasPose = true;
    }
    this.cam.updateMatrixWorld();
    if (!this.hasPose) return;
    if (!this._lastQ) this._lastQ = new THREE.Quaternion(1, 0, 0, 0);
    if (Math.abs(this._lastQ.dot(this.cam.quaternion)) < 0.9999999) { this._lastQ.copy(this.cam.quaternion); v.needsRender = true; }

    if (!this.placed) this.follow(dt);
    else if (this.drop) this.stepDrop(now);
    if (this.ripple) this.stepRipple(now);
    this.updateArrow();
    this.checkVideo(now);
    if (!this.frozen) this.measureLight(now);
    this.applyLight(dt);
  }

  // where the middle of the screen meets the surface; the tray hovers there, its front to the player
  follow(dt) {
    const v = this.view, w = v.world;
    const h = SURFACES[this.surface].h, maxD = h * 3.4;
    const q = this.cam.quaternion;
    const dir = this._v.set(0, 0, -1).applyQuaternion(q);
    const up = this._w.set(0, 1, 0).applyQuaternion(q);
    // "forward" along the surface: where the phone looks, or where its top points when it looks down
    let fx = dir.x + up.x, fz = dir.z + up.z;
    const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const hl = Math.hypot(dir.x, dir.z);
    let d;
    if (dir.y < -0.02) d = Math.min(h * hl / -dir.y, maxD);
    else d = maxD;
    const ax = hl > 1e-4 ? dir.x / hl * d : 0, az = hl > 1e-4 ? dir.z / hl * d : 0;
    this.aim.set(ax, -h, az);
    const yaw = Math.atan2(-fx, -fz);
    const state = this.sensors === 'no' ? 'fixed' : (dir.y < -0.16 && d < maxD * 0.92 ? 'ready' : 'aim');
    if (state !== this.aimState) { this.aimState = state; this.hooks.onAim?.(state); }
    const k = this.followed ? 1 - Math.exp(-dt * 12) : 1;
    this.followed = true;
    this.setHover(HOVER_M + 0.004 * Math.sin(performance.now() / 380));     // a gentle bob while it floats
    const tgt = this._w.set(ax, -h + this.hover, az);
    w.position.lerp(tgt, k);
    this.aimYaw = this.aimYaw + wrap(yaw - this.aimYaw) * k;
    w.quaternion.setFromAxisAngle(UP, this.aimYaw);
    w.visible = true;
    this.reticle.visible = true;
    this.reticle.position.set(w.position.x, -h + 0.001, w.position.z);
    this.reticle.quaternion.copy(w.quaternion);
    const pulse = 1 + 0.025 * Math.sin(performance.now() / 260);
    this.reticle.scale.setScalar(this.size * 1.14 * pulse);
    v.needsRender = true;
  }

  // set the tray down where it hovers
  place() {
    if (!this.on || this.placed || !this.hasPose) return false;
    this.placed = true;
    this.followed = false;
    this.reticle.visible = false;
    this.drop = { t0: performance.now(), from: this.hover };
    this.hooks.onPlace?.();
    return true;
  }

  stepDrop(now) {
    const d = this.drop, ms = 420;
    const t = Math.min(1, (now - d.t0) / ms);
    // falls, then a small bounce
    const e = t < 0.72 ? Math.pow(t / 0.72, 2) : 1 - 0.12 * Math.sin((t - 0.72) / 0.28 * Math.PI);
    this.setHover(d.from * (1 - Math.min(1, e)));
    if (t >= 1) {
      this.drop = null; this.setHover(0);
      this.ripple = { t0: now };
      this.hooks.onPlaced?.();
    }
  }

  // landing: the brackets spread out over the table and fade
  stepRipple(now) {
    const r = this.ripple, ret = this.reticle, mat = ret.children[0].material, w = this.view.world;
    const t = Math.min(1, (now - r.t0) / 650);
    if (t === 0 || !this.placed) { ret.visible = false; mat.opacity = 1; this.ripple = null; return; }
    ret.visible = true;
    ret.position.set(w.position.x, w.position.y + 0.001, w.position.z);
    ret.quaternion.copy(w.quaternion);
    ret.scale.setScalar(this.size * (1.04 + 0.4 * (1 - Math.pow(1 - t, 3))));
    mat.opacity = 0.85 * (1 - t);
    this.view.needsRender = true;
    if (t >= 1) { ret.visible = false; mat.opacity = 1; this.ripple = null; }
  }

  // The tray floats `m` metres above the surface; its shadow stays on the surface.
  setHover(m) {
    const v = this.view, w = v.world;
    const s = w.scale.x || 1;
    const planeY = w.position.y - this.hover;
    this.hover = m;
    if (this.on) w.position.y = planeY + m;
    const mm = m / s;
    v.catcher.position.y = 0.05 - mm;
    v.contact.position.y = 0.08 - mm;
    v.contact.material.opacity = v.contactOpacity * Math.max(0.25, 1 - m / HOVER_M * 0.7);
    v.needsRender = true;
  }

  // pick a new spot for the tray
  replace() {
    if (!this.on) return;
    this.setFrozen(false);       // the Freeze button is hidden while placing
    this.placed = false;
    this.drop = null;
    this.ripple = null;
    this.reticle.children[0].material.opacity = 1;
    this.followed = true;
    const f = this._v.set(0, 0, -1).applyQuaternion(this.view.world.quaternion);
    this.aimYaw = Math.atan2(-f.x, -f.z);
    this.setHover(HOVER_M);
    this.aimState = '';
    this.hooks.onStart?.();
    if (this.sensors === 'no') this.hooks.onAim?.('fixed');
  }

  // table or floor: the surface's distance below the phone and the tray's size there
  setSurface(name) {
    if (!SURFACES[name] || name === this.surface) { this.hooks.onSurface?.(this.surface); return; }
    const w = this.view.world;
    const ratio = SURFACES[name].h / SURFACES[this.surface].h;
    this.surface = name;
    // the camera is at the origin, so scaling the position keeps the tray on the same screen spot
    if (this.placed) { w.position.x *= ratio; w.position.z *= ratio; w.position.y = -SURFACES[name].h + this.hover; }
    this.setSize(SURFACES[name].size);
    this.hooks.onSurface?.(name);
  }

  setSize(m) {
    this.size = THREE.MathUtils.clamp(m, MIN_M, MAX_M);
    this.view.setWorldScale(this.size / TRAY_MM);
    this.setHover(this.hover);      // the hover is in metres: keep it as the scale changes
    this.hooks.onSize?.(this.size);
  }

  // Freeze: keep the current picture and camera direction, so the phone can be lowered.
  setFrozen(on) {
    if (!this.on || on === this.frozen) return;
    const v = this.video, c = this.still;
    if (on) {
      if (!v || !v.videoWidth) return;
      c.width = v.videoWidth; c.height = v.videoHeight;
      try { c.getContext('2d').drawImage(v, 0, 0); } catch { return; }
      document.body.dataset.cam = 'still';
    } else {
      document.body.dataset.cam = 'live';
      this.hasPose = this.sensors === 'no';      // take the phone's direction at once, no smoothing
      if (v && v.paused) v.play().catch(() => {});
    }
    this.frozen = on;
    this.view.needsRender = true;
    this.hooks.onFreeze?.(on);
  }

  // ---------- the picture stopping ----------
  checkVideo(now) {
    if (now - this.lastVideoCheck < 1200 || this.frozen || !this.video) return;
    this.lastVideoCheck = now;
    // new frames counted where the browser can (requestVideoFrameCallback), else the play time
    const t = this._rvfc ? this.frames : this.video.currentTime;
    if (t !== this.lastVideoT && this.lastVideoT >= 0) this.advanced = true;
    const stuck = this.video.paused || (this.advanced && t === this.lastVideoT);
    this.lastVideoT = t;
    if (stuck !== this.stalled) this.setStalled(stuck);
    if (stuck && this.video.paused) this.video.play().then(() => this.setStalled(false), () => {});
  }

  setStalled(on) { this.stalled = on; this.hooks.onStalled?.(on); }

  // ---------- light: the model takes the room's brightness and colour from the camera ----------
  saveLights() {
    const v = this.view;
    this.base = { sun: v.sun.intensity, hemi: v.hemi.intensity, env: v.scene.environmentIntensity, sunColor: v.sun.color.clone(), hemiColor: v.hemi.color.clone() };
    this.light = null;
    this.lightNow = { k: 1, r: 1, g: 1, b: 1 };
  }

  restoreLights() {
    const v = this.view, b = this.base;
    if (!b) return;
    v.sun.intensity = b.sun; v.hemi.intensity = b.hemi; v.scene.environmentIntensity = b.env;
    v.sun.color.copy(b.sunColor); v.hemi.color.copy(b.hemiColor);
    v.catcher.material.opacity = v.catcherOpacity;
  }

  measureLight(now) {
    const v = this.video;
    if (!v || !v.videoWidth || now - (this.lastLight || 0) < 400) return;
    this.lastLight = now;
    if (!this._lc) { this._lc = document.createElement('canvas'); this._lc.width = this._lc.height = 16; this._lx = this._lc.getContext('2d', { willReadFrequently: true }); }
    let d;
    try { this._lx.drawImage(v, 0, 0, 16, 16); d = this._lx.getImageData(0, 0, 16, 16).data; } catch { return; }
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += lin(d[i] / 255); g += lin(d[i + 1] / 255); b += lin(d[i + 2] / 255); }
    const n = d.length / 4;
    r /= n; g /= n; b /= n;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < 0.002) return;      // a black frame while the camera starts
    // brightness relative to a normal room, softened so the model never goes very dark or blown out
    const k = THREE.MathUtils.clamp(Math.pow(lum / 0.13, 0.42), 0.62, 1.28);
    const m = Math.max(r, g, b) || 1;
    this.light = { k, r: r / m, g: g / m, b: b / m };
  }

  applyLight(dt) {
    const L = this.light, cur = this.lightNow, b = this.base, v = this.view;
    if (!L || !b) return;
    const a = 1 - Math.exp(-dt * 3);
    cur.k += (L.k - cur.k) * a; cur.r += (L.r - cur.r) * a; cur.g += (L.g - cur.g) * a; cur.b += (L.b - cur.b) * a;
    v.sun.intensity = b.sun * cur.k;
    v.hemi.intensity = b.hemi * (0.75 + 0.25 * cur.k);
    v.scene.environmentIntensity = b.env * cur.k;
    // a hint of the room's colour, more on the sky light than on the sun
    v.hemi.color.copy(b.hemiColor).multiply(this._tint(cur, 0.45));
    v.sun.color.copy(b.sunColor).multiply(this._tint(cur, 0.22));
    v.catcher.material.opacity = THREE.MathUtils.clamp(v.catcherOpacity * (0.75 + 0.3 * cur.k), 0.2, 0.46);
    if (Math.abs(L.k - cur.k) > 0.004) v.needsRender = true;
  }

  _tint(c, amount) {
    const t = this._c2 || (this._c2 = new THREE.Color());
    return t.setRGB(1 + (c.r - 1) * amount, 1 + (c.g - 1) * amount, 1 + (c.b - 1) * amount);
  }

  // ---------- an arrow at the edge of the screen when the tray is out of view ----------
  updateArrow() {
    const a = this.arrow;
    if (!a) return;
    const v = this.view;
    if (!this.placed || this.frozen) { a.classList.remove('on'); return; }
    const c = this._v.set(0, v.floorY, 0);
    v.world.updateMatrixWorld();
    v.world.localToWorld(c);
    const camSpace = c.clone().applyMatrix4(this.cam.matrixWorldInverse);
    c.project(this.cam);
    let x = c.x, y = c.y;
    const behind = camSpace.z > 0;
    if (behind) { x = -x; y = -y; }
    if (!behind && Math.abs(x) < 0.92 && Math.abs(y) < 0.86) { a.classList.remove('on'); return; }
    const W = window.innerWidth, H = window.innerHeight;
    // keep clear of the bars and of the buttons at the side
    const ctl = this.ctl || (this.ctl = document.getElementById('arCtl'));
    const ctlTop = ctl && ctl.offsetHeight ? ctl.getBoundingClientRect().top - 34 : Infinity;
    const top = v.insets.top + 36, bottom = Math.max(top + 80, Math.min(H - v.insets.bottom - 36, ctlTop));
    const cx = W / 2, cy = (top + bottom) / 2;
    let dx = x * W / 2, dy = -y * H / 2;
    if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) dy = 1;
    const sx = (W / 2 - 36) / Math.abs(dx || 1e-6), sy = ((bottom - top) / 2) / Math.abs(dy || 1e-6);
    const s = Math.min(sx, sy);
    const px = cx + dx * s, py = cy + dy * s;
    a.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%) rotate(${Math.atan2(dy, dx)}rad)`;
    a.classList.add('on');
  }

  // ---------- the reticle: brackets showing where the tray goes ----------
  makeReticle() {
    const S = 512, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    const m = 22, r = 30;
    g.beginPath();
    if (g.roundRect) g.roundRect(m, m, S - 2 * m, S - 2 * m, r); else g.rect(m, m, S - 2 * m, S - 2 * m);
    g.fillStyle = 'rgba(255, 228, 170, 0.12)';
    g.fill();
    g.setLineDash([16, 14]);
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(255, 236, 205, 0.55)';
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = '#eab54c';
    g.lineWidth = 13;
    g.lineCap = 'round'; g.lineJoin = 'round';
    const L = 92, a = m + 4, b = S - m - 4;
    for (const [x, y, sx, sy] of [[a, a, 1, 1], [b, a, -1, 1], [a, b, 1, -1], [b, b, -1, -1]]) {
      g.beginPath();
      g.moveTo(x, y + sy * L); g.lineTo(x, y + sy * r * 0.6); g.quadraticCurveTo(x, y, x + sx * r * 0.6, y); g.lineTo(x + sx * L, y);
      g.stroke();
    }
    // the front edge (towards the player) gets a small notch
    g.lineWidth = 9;
    g.beginPath(); g.moveTo(S / 2 - 26, b - 2); g.lineTo(S / 2, b + 14); g.lineTo(S / 2 + 26, b - 2); g.stroke();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    mesh.renderOrder = 4;
    const grp = this.reticle = new THREE.Group();
    grp.add(mesh);
    grp.visible = false;
    this.view.scene.add(grp);
  }

  // ---------- touch on the empty screen ----------
  ground(sx, sy) {
    // where a screen point meets the horizontal plane the tray stands on (scene metres)
    const v = this.view;
    const { w, h } = v.screenSize();
    this._ray.setFromCamera({ x: (sx / w) * 2 - 1, y: -(sy / h) * 2 + 1 }, this.cam);
    // ignore rays that only graze the surface near the horizon: they would fling the tray away
    if (this._ray.ray.direction.y > -0.05) return null;
    this._plane.set(UP, -(v.world.position.y - this.hover));
    return this._ray.ray.intersectPlane(this._plane, new THREE.Vector3());
  }

  down(e) {
    if (!this.on) return;
    try { this.touchEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.stalled) this.resume();
    // event times, not handling times: on a busy phone the two can be far apart
    this.p.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp });
    if (this.p.size === 2) { this.twist = 0; this.rotating = false; }
    this.moved = false;
  }

  move(e) {
    const s = this.p.get(e.pointerId);
    if (!s) return;
    if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) > 8) this.moved = true;
    const v = this.view, w = v.world;
    if (this.p.size === 1) {
      const A = this.placed && !this.drop ? this.ground(s.x, s.y) : null;
      const B = A ? this.ground(e.clientX, e.clientY) : null;
      s.x = e.clientX; s.y = e.clientY;
      if (A && B) { w.position.x += B.x - A.x; w.position.z += B.z - A.z; v.needsRender = true; }
      return;
    }
    if (this.p.size !== 2) return;
    const [p1, p2] = [...this.p.values()];
    const bc = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, bd = Math.hypot(p1.x - p2.x, p1.y - p2.y), ba = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    s.x = e.clientX; s.y = e.clientY;
    const ac = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, ad = Math.hypot(p1.x - p2.x, p1.y - p2.y), aa = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    if (bd < 1 || ad < 1) return;
    if (!this.placed) { this.setSize(this.size * ad / bd); return; }     // while placing: only the size
    const A = this.ground(bc.x, bc.y), B = this.ground(ac.x, ac.y);
    if (!A || !B) return;
    w.updateMatrixWorld();
    const local = w.worldToLocal(A.clone());
    this.setSize(this.size * ad / bd);
    const da = wrap(aa - ba);
    this.twist += da;
    if (!this.rotating && Math.abs(this.twist) > TWIST_START) this.rotating = true;
    if (this.rotating) w.rotateOnWorldAxis(UP, -da);
    w.updateMatrixWorld();
    const now = w.localToWorld(local);
    w.position.x += B.x - now.x; w.position.z += B.z - now.z;
    v.needsRender = true;
  }

  up(e, cancelled = false) {
    const s = this.p.get(e.pointerId);
    if (!s) return;
    this.p.delete(e.pointerId);
    if (!cancelled && !this.moved && this.p.size === 0 && e.timeStamp - s.t0 < 450 && !this.placed) this.place();
    if (this.p.size === 1) { const r = [...this.p.values()][0]; r.x0 = r.x; r.y0 = r.y; this.moved = true; }
  }
}
