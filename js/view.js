// Rendering: renderer, camera rig, lights, materials, guide texture, thumbnails.
// World units are millimetres. Y up, X east, -Z north, board centre at the origin.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export class View {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const low = !!opts.low;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !low, alpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(low ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;

    const scene = this.scene = new THREE.Scene();
    this.bg = new THREE.Color('#1d1a16');
    scene.background = this.bg;
    const pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;

    const sun = this.sun = new THREE.DirectionalLight(0xfff3e0, 2.3);
    sun.position.set(-160, 260, -120);   // from the north-west, like a map
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -175; sc.right = 175; sc.top = 175; sc.bottom = -175; sc.near = 50; sc.far = 700;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.35;
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0xf2efe6, 0x4a3f30, 0.55));

    this.camera = new THREE.PerspectiveCamera(30, 1, 10, 5000);
    // camera rig: target on the floor, distance, tilt from vertical, yaw around Y
    this.rig = { x: 0, z: 0, dist: 800, tilt: 0, yaw: 0 };
    this.anim = null;
    this.insets = { top: 0, bottom: 0 };
    this.fitDist = 800;
    this.floorY = 0;
    this.extent = 300;
    this.uTime = { value: 0 };
    this.material = this.makePieceMaterial();
    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.needsRender = true;
    this.size = { w: 1, h: 1 };
  }

  makePieceMaterial() {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.0 });
    const uTime = this.uTime;
    m.onBeforeCompile = (sh) => {
      // water is marked by vertex-colour alpha 128 (see tools/glb.py); it gets a slow shimmer
      sh.uniforms.uTime = uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vWPos;\nfloat waterFx = 0.0;')
        .replace('#include <color_fragment>', `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  diffuseColor.rgb *= vColor.rgb;
#endif
#if defined( USE_COLOR_ALPHA )
  waterFx = 1.0 - step(0.75, vColor.a);
#endif
  if (waterFx > 0.5) {
    float w = sin(vWPos.x * 0.33 + uTime * 1.5) * sin(vWPos.z * 0.41 - uTime * 1.1)
            + 0.55 * sin((vWPos.x + vWPos.z) * 0.71 + uTime * 2.2);
    diffuseColor.rgb *= 0.93 + 0.10 * w;
    diffuseColor.rgb += vec3(0.05, 0.07, 0.09) * smoothstep(0.7, 1.45, w);
  }`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  if (waterFx > 0.5) roughnessFactor = 0.32;');
    };
    m.customProgramCacheKey = () => 'piece-water-v2';
    return m;
  }

  setInsets(top, bottom) { this.insets = { top, bottom }; this.resize(); }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    const { top, bottom } = this.insets;
    const freeH = Math.max(80, h - top - bottom);
    const s = (top + h - bottom) / 2 - h / 2;   // where the free area's centre sits relative to the canvas centre
    const full = h + 2 * Math.abs(s);
    const yoff = Math.abs(s) - s;
    this.camera.aspect = w / h;
    this.camera.setViewOffset(w, full, 0, yoff, w, h);
    this.fullH = full;
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const ext = this.extent * 1.05;
    // world height visible across `full` px at distance d is 2 d tan; the free area must hold ext x ext
    const dW = ext / w * full / (2 * tanH);
    const dH = ext / freeH * full / (2 * tanH);
    this.fitDist = Math.max(dW, dH);
    this.camera.near = this.fitDist * 0.05;
    this.camera.far = this.fitDist * 6;
    this.camera.updateProjectionMatrix();
    this.clampRig();
    this.needsRender = true;
  }

  clampRig() {
    const r = this.rig;
    r.dist = THREE.MathUtils.clamp(r.dist, this.fitDist * 0.16, this.fitDist * 1.35);
    r.tilt = THREE.MathUtils.clamp(r.tilt, 0, 1.1);
    const lim = this.extent / 2 + 10;
    r.x = THREE.MathUtils.clamp(r.x, -lim, lim);
    r.z = THREE.MathUtils.clamp(r.z, -lim, lim);
  }

  applyRig() {
    const r = this.rig, c = this.camera;
    const cy = Math.cos(r.yaw), sy = Math.sin(r.yaw);
    const ox = 0, oy = Math.cos(r.tilt), oz = Math.sin(r.tilt);
    c.position.set(r.x + (ox * cy + oz * sy) * r.dist, this.floorY + oy * r.dist, r.z + (-ox * sy + oz * cy) * r.dist);
    c.up.set(-sy, 0, -cy);
    c.lookAt(r.x, this.floorY, r.z);
    c.updateMatrixWorld();
  }

  // Animate the rig towards `to` (any subset of x, z, dist, tilt, yaw).
  animateTo(to, ms = 450) {
    const from = { ...this.rig };
    const t0 = performance.now();
    this.anim = { from, to, t0, ms };
    this.needsRender = true;
  }

  stepAnim(now) {
    if (!this.anim) return false;
    const { from, to, t0, ms } = this.anim;
    const t = Math.min(1, (now - t0) / ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    for (const k of Object.keys(to)) this.rig[k] = from[k] + (to[k] - from[k]) * e;
    if (t >= 1) this.anim = null;
    this.clampRig();
    return true;
  }

  fit(tilt = 0, ms = 450) { this.animateTo({ x: 0, z: 0, dist: this.fitDist, tilt, yaw: 0 }, ms); }

  // Screen (CSS px, relative to canvas) to a point on the horizontal plane at height y.
  screenToPlane(sx, sy, y = this.floorY, out = new THREE.Vector3()) {
    const { w, h } = this.size;
    this.applyRig();
    this.raycaster.setFromCamera({ x: (sx / w) * 2 - 1, y: -(sy / h) * 2 + 1 }, this.camera);
    this.plane.constant = -y;
    return this.raycaster.ray.intersectPlane(this.plane, out);
  }

  worldToScreen(v, out = { x: 0, y: 0, z: 0 }) {
    const p = v.clone().project(this.camera);
    out.x = (p.x + 1) / 2 * this.size.w;
    out.y = (1 - p.y) / 2 * this.size.h;
    out.z = p.z;
    return out;
  }

  // mm of world per CSS px at the target
  mmPerPx() { return 2 * this.rig.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / this.fullH; }

  render() {
    this.applyRig();
    this.renderer.render(this.scene, this.camera);
    this.needsRender = false;
  }

  // ---------- guide map on the tray floor (outlines + codes) ----------
  makeGuide(puzzle) {
    const [x0, z0, x1, z1] = puzzle.tray.inner;
    const W = 2048, sx = W / (x1 - x0), H = Math.round((z1 - z0) * sx);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(70,55,40,0.55)';
    g.lineWidth = 3;
    for (const p of puzzle.pieces) {
      g.beginPath();
      p.outline.forEach(([x, z], i) => {
        const X = (p.pos[0] + x - x0) * sx, Y = (p.pos[1] + z - z0) * sx;
        i ? g.lineTo(X, Y) : g.moveTo(X, Y);
      });
      g.closePath();
      g.stroke();
    }
    g.fillStyle = 'rgba(70,55,40,0.42)';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `600 ${Math.round(9 * sx)}px system-ui, sans-serif`;
    for (const p of puzzle.pieces) g.fillText(p.code, (p.pos[0] - x0) * sx, (p.pos[1] - z0) * sx);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((x0 + x1) / 2, puzzle.tray.floorY + 0.06, (z0 + z1) / 2);
    mesh.renderOrder = 1;
    return mesh;
  }

  // ---------- thumbnails ----------
  // Renders each mesh straight down (north up) into its own 2D canvas.
  makeThumbnails(items, px = 168) {
    const r = this.renderer;
    const scene = new THREE.Scene();
    scene.environment = this.scene.environment;
    scene.environmentIntensity = 0.7;
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.4);
    sun.position.set(-1.2, 2.6, -0.9);
    scene.add(sun, new THREE.HemisphereLight(0xf2efe6, 0x4a3f30, 0.6));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    cam.position.set(0, 400, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0);
    const pr = r.getPixelRatio();
    const prevSize = r.getSize(new THREE.Vector2());
    const prevBg = this.scene.background;
    const S = Math.max(px, 64);
    if (prevSize.x < S || prevSize.y < S) r.setSize(Math.max(S, prevSize.x), Math.max(S, prevSize.y), false);
    r.setClearColor(0x000000, 0);
    const out = [];
    for (const it of items) {
      const m = it.object.clone(true);
      m.position.set(0, 0, 0);
      m.rotation.set(0, 0, 0);
      scene.add(m);
      cam.left = -it.half; cam.right = it.half; cam.top = it.half; cam.bottom = -it.half;
      cam.updateProjectionMatrix();
      r.setRenderTarget(null);
      r.setViewport(0, 0, S, S);
      r.setScissor(0, 0, S, S);
      r.setScissorTest(true);
      r.clear();
      r.render(scene, cam);
      const cv = document.createElement('canvas');
      cv.width = Math.round(S * pr); cv.height = Math.round(S * pr);
      cv.getContext('2d').drawImage(this.canvas, 0, this.canvas.height - cv.height, cv.width, cv.height, 0, 0, cv.width, cv.height);
      out.push(cv);
      scene.remove(m);
    }
    r.setScissorTest(false);
    r.setSize(prevSize.x, prevSize.y, false);
    r.setViewport(0, 0, prevSize.x, prevSize.y);
    this.scene.background = prevBg;
    this.needsRender = true;
    return out;
  }

  // Top-down picture of the finished puzzle (the "box cover").
  makeCover(group, px = 720) {
    const r = this.renderer;
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
    const half = this.extent / 2 * 1.02;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.position.set(0, 900, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0); cam.updateProjectionMatrix();
    const prevSize = r.getSize(new THREE.Vector2());
    const pr = r.getPixelRatio();
    const S = Math.min(px, Math.floor(4096 / pr));
    if (prevSize.x < S || prevSize.y < S) r.setSize(Math.max(S, prevSize.x), Math.max(S, prevSize.y), false);
    const vis = [];
    this.scene.traverse(o => { if (o.userData.hideInCover && o.visible) { vis.push(o); o.visible = false; } });
    const wasVisible = group.visible; group.visible = true;
    this.renderer.shadowMap.needsUpdate = true;
    r.setViewport(0, 0, S, S); r.setScissor(0, 0, S, S); r.setScissorTest(true);
    r.render(this.scene, cam);
    const cv = document.createElement('canvas');
    cv.width = Math.round(S * pr); cv.height = Math.round(S * pr);
    cv.getContext('2d').drawImage(this.canvas, 0, this.canvas.height - cv.height, cv.width, cv.height, 0, 0, cv.width, cv.height);
    r.setScissorTest(false);
    group.visible = wasVisible;
    vis.forEach(o => { o.visible = true; });
    r.setSize(prevSize.x, prevSize.y, false);
    r.setViewport(0, 0, prevSize.x, prevSize.y);
    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true;
    return cv;
  }
}

// Soft round shadow under a lifted piece.
export function makeBlob(THREE_) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.42)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.22)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 2;
  return m;
}
