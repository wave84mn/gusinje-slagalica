// Touch and mouse gestures on the 3D view.
//   one finger: move the map (in "explore" mode: turn around it)
//   two fingers: pinch to zoom and move; both fingers up/down together: tilt
//   double tap: zoom in, double tap again: back to the whole tray
//   mouse wheel: zoom at the cursor
import * as THREE from 'three';

export class Gestures {
  constructor(el, view, hooks = {}) {
    this.el = el;
    this.view = view;
    this.hooks = hooks;
    this.mode = 'board';
    this.enabled = true;
    this.p = new Map();
    this.kind = null;
    this.lastTap = null;
    this.a = new THREE.Vector3();
    this.b = new THREE.Vector3();
    el.addEventListener('pointerdown', e => this.down(e));
    el.addEventListener('pointermove', e => this.move(e));
    el.addEventListener('pointerup', e => this.up(e));
    el.addEventListener('pointercancel', e => this.up(e, true));
    el.addEventListener('wheel', e => this.wheel(e), { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  local(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  down(e) {
    if (!this.enabled) return;
    this.el.setPointerCapture(e.pointerId);
    const q = this.local(e);
    this.p.set(e.pointerId, { x: q.x, y: q.y, x0: q.x, y0: q.y, t0: performance.now() });
    this.view.anim = null;
    this.kind = this.p.size === 2 ? 'two?' : this.p.size === 1 ? 'one' : this.kind;
    this.moved = false;
    this.hooks.onInteract?.();
  }

  move(e) {
    const s = this.p.get(e.pointerId);
    if (!s || !this.enabled) return;
    const q = this.local(e);
    const px = s.x, py = s.y;
    if (Math.hypot(q.x - s.x0, q.y - s.y0) > 7) this.moved = true;
    const v = this.view;
    if (this.p.size === 1 && this.kind === 'one') {
      if (this.mode === 'explore') {
        v.rig.yaw -= (q.x - px) * 0.006;
        v.rig.tilt += (q.y - py) * 0.004;
      } else {
        const A = v.screenToPlane(px, py, v.floorY, this.a), B = v.screenToPlane(q.x, q.y, v.floorY, this.b);
        if (A && B) { v.rig.x += A.x - B.x; v.rig.z += A.z - B.z; }
      }
      s.x = q.x; s.y = q.y;
      v.clampRig();
      v.needsRender = true;
      return;
    }
    if (this.p.size !== 2) { s.x = q.x; s.y = q.y; return; }
    const [p1, p2] = [...this.p.values()];
    const before = { cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2, d: Math.hypot(p1.x - p2.x, p1.y - p2.y) };
    s.x = q.x; s.y = q.y;
    const after = { cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2, d: Math.hypot(p1.x - p2.x, p1.y - p2.y) };
    if (this.kind === 'two?') {
      const d1 = { x: p1.x - p1.x0, y: p1.y - p1.y0 }, d2 = { x: p2.x - p2.x0, y: p2.y - p2.y0 };
      const m1 = Math.hypot(d1.x, d1.y), m2 = Math.hypot(d2.x, d2.y);
      // pointer events arrive one finger at a time, so wait until both have moved
      if (m1 > 6 && m2 > 6 && Math.max(m1, m2) > 10) {
        const vertical = Math.abs(d1.y) > 1.7 * Math.abs(d1.x) && Math.abs(d2.y) > 1.7 * Math.abs(d2.x) && d1.y * d2.y > 0;
        const d0 = Math.hypot(p1.x0 - p2.x0, p1.y0 - p2.y0);
        this.kind = vertical && Math.abs(after.d - d0) < 0.35 * Math.max(m1, m2) + 6 ? 'tilt' : 'pinch';
      } else if (Math.max(m1, m2) > 28) this.kind = 'pinch';
      else return;
    }
    if (this.kind === 'tilt') {
      v.rig.tilt -= (after.cy - before.cy) * 0.007;
    } else if (this.kind === 'pinch') {
      const A = v.screenToPlane(before.cx, before.cy, v.floorY, this.a)?.clone();
      if (before.d > 0 && after.d > 0) v.rig.dist *= before.d / after.d;
      v.clampRig();
      const B = v.screenToPlane(after.cx, after.cy, v.floorY, this.b);
      if (A && B) { v.rig.x += A.x - B.x; v.rig.z += A.z - B.z; }
    }
    v.clampRig();
    v.needsRender = true;
  }

  up(e, cancelled = false) {
    const s = this.p.get(e.pointerId);
    if (!s) return;
    this.p.delete(e.pointerId);
    const now = performance.now();
    if (!cancelled && this.kind === 'one' && !this.moved && now - s.t0 < 350) {
      const q = { x: s.x, y: s.y };
      if (this.lastTap && now - this.lastTap.t < 320 && Math.hypot(q.x - this.lastTap.x, q.y - this.lastTap.y) < 36) {
        this.lastTap = null;
        this.doubleTap(q.x, q.y);
      } else {
        this.lastTap = { ...q, t: now };
        this.hooks.onTap?.(q.x, q.y);
      }
    }
    if (this.p.size === 0) this.kind = null;
    else if (this.p.size === 1) {
      // continue with the remaining finger without a jump
      const r = [...this.p.values()][0];
      r.x0 = r.x; r.y0 = r.y;
      this.kind = 'one';
      this.moved = true;
    }
  }

  doubleTap(x, y) {
    const v = this.view;
    if (v.rig.dist < v.fitDist * 0.62) { v.fit(v.rig.tilt); return; }
    const P = v.screenToPlane(x, y);
    if (!P) return;
    v.animateTo({ x: P.x, z: P.z, dist: v.rig.dist * 0.45 }, 380);
  }

  wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const v = this.view;
    v.anim = null;
    const q = this.local(e);
    const A = v.screenToPlane(q.x, q.y)?.clone();
    v.rig.dist *= Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
    v.clampRig();
    const B = v.screenToPlane(q.x, q.y);
    if (A && B) { v.rig.x += A.x - B.x; v.rig.z += A.z - B.z; }
    v.clampRig();
    v.needsRender = true;
  }
}
