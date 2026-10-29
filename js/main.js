// Slagalica Gusinje: the 3D-printed Gusinje jigsaw, played with fingers.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { View, makeBlob } from './view.js';
import { Gestures } from './input.js';
import { t, setLang, getLang } from './i18n.js';
import { sound, buzz } from './sound.js';
import { ArMode } from './ar.js';

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

// tol: snap distance in mm; px: minimum snap distance in screen pixels (helps when zoomed out)
const LEVELS = {
  easy: { tol: 12, px: 26, rotate: false, guide: true, codes: true },
  normal: { tol: 9, px: 22, rotate: false, guide: false, codes: false },
  hard: { tol: 8, px: 20, rotate: true, guide: false, codes: false },
};
const HOVER = 7;         // mm a dragged piece floats above the tray
const UP = new THREE.Vector3(0, 1, 0);

const canvas = $('#gl');
const LOW = params.has('lowpower');   // no antialiasing, 1x pixels, no idle animation (slow devices, tests)
const view = new View(canvas, { low: LOW });
let lastFound = null;
const ar = new ArMode(view, {
  onStart() { document.body.dataset.ar = 'placing'; $('#arHint').textContent = t('arPoint'); syncArSizes(); layout(); },
  onSurface(found) { if (document.body.dataset.ar === 'placing' && found !== lastFound) { lastFound = found; $('#arHint').textContent = t(found ? 'arFound' : 'arPoint'); } },
  onPlaced() { document.body.dataset.ar = 'on'; $('#arHint').textContent = ''; toast(t('arPlaced'), 3600); sound.drop(); buzz(20); },
  onSize() { syncArSizes(); },
  onEnd() { delete document.body.dataset.ar; $('#arHint').textContent = ''; lastFound = null; layout(); if (mode === 'play') view.fit(0, 10); },
});
function syncArSizes() {
  document.querySelectorAll('.arsizes button').forEach(b => b.classList.toggle('sel', Math.abs(parseFloat(b.dataset.size) - ar.size) < 0.02));
}
const gestures = new Gestures(canvas, view, { onTap: (x, y) => onBoardTap(x, y), onInteract: () => { if (mode === 'attract') return; } });

let puzzle, dataId, pieces = new Map(), board, guide, blob, ghost = null;
let mode = 'loading';            // loading | attract | play | explore
let drag = null, press = null;
const tweens = [];
let prefs = store.get('slagalica.prefs', { lang: 'me', sound: true, seenHelp: false });
const state = { level: 'easy', order: [], placed: new Set(), rot: {}, elapsed: 0, hints: 0, done: false, started: false, lastTried: null };

// ------------------------------------------------------------------ loading
async function load() {
  setLang(prefs.lang);
  sound.on = prefs.sound !== false;
  if (params.has('reset')) { Object.keys(localStorage).filter(k => k.startsWith('slagalica.')).forEach(k => store.del(k)); prefs = { lang: prefs.lang, sound: true, seenHelp: false }; }
  const bar = $('#loading i');
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  MeshoptDecoder.ready?.catch?.(() => {});   // only needed for compressed files
  const prog = { a: 0, b: 0 };
  const showProg = () => { bar.style.width = `${Math.round(100 * (0.1 + 0.9 * (prog.a * 0.92 + prog.b * 0.08)))}%`; };
  const get = async (url, key) => {
    if (url.endsWith('.txt')) {   // base64 text copy of a .glb, for hosts that don't serve .glb files
      const txt = await (await fetch(url)).text();
      const bin = Uint8Array.from(atob(txt.trim()), c => c.charCodeAt(0));
      prog[key] = 1; showProg();
      return new Promise((res, rej) => loader.parse(bin.buffer, '', res, rej));
    }
    return new Promise((res, rej) => loader.load(url, res, e => { if (e.total) { prog[key] = e.loaded / e.total; showProg(); } }, rej));
  };
  const files = window.SLAGALICA_FILES || { pieces: 'data/pieces.glb', tray: 'data/tray.glb' };
  puzzle = await (await fetch('data/puzzle.json')).json();
  dataId = puzzle.id || (puzzle.standin ? 'standin' : 'v1');
  const [pg, tg] = await Promise.all([get(files.pieces, 'a'), get(files.tray, 'b')]);

  view.floorY = puzzle.tray.floorY;
  view.extent = Math.max(...puzzle.tray.size);
  view.sun.target.position.set(0, view.floorY, 0);

  // tray
  tg.scene.updateMatrixWorld(true);
  tg.scene.traverse(o => { if (o.isMesh) { o.material = view.material; o.receiveShadow = true; o.castShadow = true; } });
  view.world.add(tg.scene);

  // pieces: one pivot group per code, positioned at its assembled place
  pg.scene.updateMatrixWorld(true);
  const inv = new THREE.Matrix4();
  for (const info of puzzle.pieces) {
    const node = pg.scene.getObjectByName(info.code);
    if (!node) { console.warn('missing piece', info.code); continue; }
    const target = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
    inv.copy(node.matrixWorld).invert();
    const obj = new THREE.Group();
    obj.name = info.code;
    node.traverse(o => {
      if (!o.isMesh) return;
      const m = new THREE.Mesh(o.geometry, view.material);
      m.matrixAutoUpdate = false;
      m.matrix.multiplyMatrices(inv, o.matrixWorld);
      m.castShadow = true; m.receiveShadow = true;
      obj.add(m);
    });
    let half = 0;
    for (const [x, z] of info.outline) half = Math.max(half, Math.abs(x), Math.abs(z));
    pieces.set(info.code, { info, obj, target, half: half + 1.2, thumb: null, tile: null });
  }

  board = new THREE.Group();
  view.world.add(board);
  guide = view.makeGuide(puzzle);
  guide.userData.hideInCover = true;
  view.world.add(guide);
  blob = makeBlob();
  blob.visible = false;
  blob.userData.hideInCover = true;
  view.world.add(blob);

  layout();
  // thumbnails and the "box cover" picture
  const thumbs = view.makeThumbnails([...pieces.values()].map(p => ({ object: p.obj, half: p.half })), 112);
  [...pieces.values()].forEach((p, i) => { p.thumb = thumbs[i]; });
  for (const p of pieces.values()) board.add(p.obj);
  guide.visible = false;
  const cover = view.makeCover(board, 900);
  $('#picImg').src = cover.toDataURL('image/jpeg', 0.86);
  view.renderer.shadowMap.needsUpdate = true;

  buildLabels();
  wireUI();
  if (puzzle.standin) $('#standin').hidden = false;
  $('#loading').classList.add('gone');
  showStart();
  view.renderer.setAnimationLoop(tick);
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.SLAGALICA_NO_SW) {
    // When a new version has been downloaded, switch to it at once, unless a game is under way
    // (then it switches the next time the start screen opens; progress is saved either way).
    const hadOld = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadOld || updateReady) return;
      updateReady = true;
      if (mode !== 'play') location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ------------------------------------------------------------------ layout / insets
function layout() {
  const h = window.innerHeight;
  let top = 0, bottom = 0;
  if (mode === 'play') {
    top = $('#bar').getBoundingClientRect().bottom;
    bottom = h - $('#drawer').getBoundingClientRect().top;
  } else if (mode === 'attract') {
    bottom = h - $('#startPanel').getBoundingClientRect().top;
  } else if (mode === 'explore') {
    top = $('#bar').getBoundingClientRect().bottom;
    bottom = h - $('#exploreBar').getBoundingClientRect().top;
  }
  view.setInsets(top, Math.max(0, bottom));
  document.documentElement.style.setProperty('--dock-h', `${Math.max(0, bottom)}px`);
}
window.addEventListener('resize', () => { layout(); });

// ------------------------------------------------------------------ screens
function savedGame() {
  const s = store.get(`slagalica.game.${dataId}`, null);
  return s && !s.done && s.placed?.length ? s : null;
}

let updateReady = false;
function showStart() {
  if (ar.active) ar.end();
  if (updateReady && mode === 'play') { save(); location.reload(); return; }
  mode = 'attract';
  gestures.enabled = false;
  document.body.dataset.mode = 'attract';
  for (const p of pieces.values()) { p.obj.rotation.set(0, 0, 0); p.obj.position.copy(p.target); board.add(p.obj); }
  view.renderer.shadowMap.needsUpdate = true;
  guide.visible = false;
  clearGhost();
  hideLabels();
  closeAll();
  $('#start').hidden = false;
  const s = savedGame();
  $('#bContinue').hidden = !s;
  if (s) $('#contInfo').textContent = `${t(s.level)} · ${s.placed.length}/${pieces.size} · ${fmt(s.elapsed)}`;
  requestAnimationFrame(() => {
    layout();
    view.rig = { x: 0, z: 0, dist: view.fitDist * 1.0, tilt: 0.82, yaw: view.rig.yaw || 0 };
    view.needsRender = true;
  });
}

function startGame(level, resume) {
  sound.unlock();
  const s = resume ? savedGame() : null;
  state.level = s ? s.level : level;
  state.rot = {};
  state.placed = new Set();
  state.elapsed = s ? s.elapsed : 0;
  state.hints = s ? s.hints : 0;
  state.done = false;
  state.started = !!s;
  state.lastTried = null;
  const codes = [...pieces.keys()];
  if (s && s.order?.length === codes.length) {
    state.order = s.order; state.rot = s.rot || {};
    s.placed.forEach(c => state.placed.add(c));
  } else {
    state.order = shuffle(codes);
    if (LEVELS[state.level].rotate) for (const c of codes) state.rot[c] = 1 + Math.floor(Math.random() * 3);
  }
  for (const p of pieces.values()) {
    p.obj.rotation.set(0, 0, 0);
    if (state.placed.has(p.info.code)) { p.obj.position.copy(p.target); board.add(p.obj); } else board.remove(p.obj);
  }
  view.renderer.shadowMap.needsUpdate = true;
  document.body.dataset.mode = 'play';
  document.body.dataset.level = state.level;
  $('#start').hidden = true;
  closeAll();
  mode = 'play';
  gestures.mode = 'board';
  gestures.enabled = true;
  guide.visible = LEVELS[state.level].guide;
  hideLabels();
  buildDrawer();
  updateHud();
  requestAnimationFrame(() => {
    layout();
    view.rig.yaw = ((view.rig.yaw % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    view.fit(0, 700);
  });
  save();
  if (!prefs.seenHelp) { openOverlay('#help'); prefs.seenHelp = true; store.set('slagalica.prefs', prefs); }
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function save() {
  store.set(`slagalica.game.${dataId}`, {
    v: 1, level: state.level, order: state.order, placed: [...state.placed], rot: state.rot,
    elapsed: Math.round(state.elapsed), hints: state.hints, done: state.done,
  });
}

// ------------------------------------------------------------------ drawer
function buildDrawer() {
  const strip = $('#strip');
  strip.textContent = '';
  for (const code of state.order) {
    if (state.placed.has(code)) continue;
    const p = pieces.get(code);
    const b = document.createElement('button');
    b.className = 'pc';
    b.dataset.code = code;
    b.setAttribute('aria-label', code);
    const wrap = document.createElement('span');
    wrap.className = 'tw';
    p.thumb.className = 'th';
    wrap.appendChild(p.thumb);
    b.appendChild(wrap);
    const lab = document.createElement('span');
    lab.className = 'code';
    lab.textContent = code;
    b.appendChild(lab);
    setTileRot(b, state.rot[code] || 0, false);
    b.addEventListener('pointerdown', e => tileDown(e, b));
    b.addEventListener('pointermove', e => tileMove(e, b));
    b.addEventListener('pointerup', e => tileUp(e, b));
    b.addEventListener('pointercancel', e => tileCancel(e, b));
    b.addEventListener('contextmenu', e => e.preventDefault());
    p.tile = b;
    strip.appendChild(b);
  }
  strip.scrollLeft = 0;
}

// A tile shows its piece turned the same way the map is turned (--map-rot), plus the piece's own
// quarter turns on Teško (--k).
function setTileRot(tile, k, animate = true) {
  const th = tile.querySelector('.tw');
  th.style.transition = animate ? '' : 'none';
  th.style.setProperty('--k', k);
  if (!animate) requestAnimationFrame(() => { th.style.transition = ''; });
  tile.dataset.rot = k;
}

function tileDown(e, tile) {
  if (mode !== 'play' || drag) return;
  sound.unlock();
  try { tile.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  press = { id: e.pointerId, tile, code: tile.dataset.code, x0: e.clientX, y0: e.clientY, t0: performance.now(), type: e.pointerType };
}

function tileMove(e, tile) {
  if (drag && drag.id === e.pointerId) { dragMove(e.clientX, e.clientY); return; }
  if (!press || press.id !== e.pointerId) return;
  const dx = e.clientX - press.x0, dy = e.clientY - press.y0;
  const mouse = press.type === 'mouse';
  if ((dy < -9 && Math.abs(dy) > Math.abs(dx) * 1.1) || (mouse && Math.hypot(dx, dy) > 6)) {
    dragStart(press, e.clientX, e.clientY);
    press = null;
  }
}

function tileUp(e, tile) {
  if (drag && drag.id === e.pointerId) { dragEnd(e.clientX, e.clientY); return; }
  if (!press || press.id !== e.pointerId) return;
  const moved = Math.hypot(e.clientX - press.x0, e.clientY - press.y0);
  if (moved < 8 && performance.now() - press.t0 < 400) tileTap(tile);
  press = null;
}

function tileCancel(e, tile) {
  if (drag && drag.id === e.pointerId) { dragCancel(); }
  if (press && press.id === e.pointerId) press = null;
}

function tileTap(tile) {
  const code = tile.dataset.code;
  state.lastTried = code;
  if (LEVELS[state.level].rotate) {
    const k = ((state.rot[code] || 0) + 1) % 4;
    state.rot[code] = k;
    setTileRot(tile, k);
    save();
  } else {
    tile.classList.remove('hop'); void tile.offsetWidth; tile.classList.add('hop');
  }
}

// ------------------------------------------------------------------ dragging
function dragStart(pr, cx, cy) {
  const p = pieces.get(pr.code);
  const touch = pr.type !== 'mouse';
  drag = { id: pr.id, code: pr.code, p, tile: pr.tile, touch, cx, cy, pos: new THREE.Vector3(), over: false };
  state.lastTried = pr.code;
  if (!state.started) { state.started = true; }
  pr.tile.classList.add('lifted');
  sound.pick();
  buzz(8);
  p.obj.rotation.set(0, -(state.rot[pr.code] || 0) * Math.PI / 2, 0);
  p.obj.position.set(0, -9999, 0);
  view.world.add(p.obj);
  const ext = p.half * 2 * 1.05;
  blob.scale.set(ext, ext, 1);
  blob.visible = true;
  document.body.classList.add('dragging');
  dragMove(cx, cy);
}

function liftPx() {
  if (!drag.touch) return 0;
  const px = drag.p.half / view.mmPerPx();
  return Math.min(110, Math.max(56, px + 34));
}

function dragMove(cx, cy) {
  if (!drag) return;
  drag.cx = cx; drag.cy = cy;
  const r = canvas.getBoundingClientRect();
  const drawerTop = $('#drawer').getBoundingClientRect().top;
  drag.over = cy < drawerTop - 4;
  const sx = cx - r.left, sy = cy - r.top - liftPx();
  const P = view.screenToPlane(sx, sy, view.floorY + HOVER, drag.pos);
  if (!P) return;
  drag.p.obj.position.set(P.x, view.floorY + HOVER, P.z);
  blob.position.set(P.x, view.floorY + 0.12, P.z);
  drag.p.obj.visible = true;
  blob.visible = drag.over;
  drag.p.obj.visible = drag.over || cy < drawerTop + 30;
  view.needsRender = true;
}

function dragEnd(cx, cy) {
  if (!drag) return;
  dragMove(cx, cy);
  const d = drag;
  const p = d.p;
  const lv = LEVELS[state.level];
  const dist = Math.hypot(p.obj.position.x - p.target.x, p.obj.position.z - p.target.z);
  const tol = Math.max(lv.tol, lv.px * view.mmPerPx());
  const rotOk = (state.rot[d.code] || 0) % 4 === 0;
  if (d.over && dist <= tol && rotOk) {
    place(d.code, true);
  } else {
    if (!d.over) sound.back();
    if (d.over) {
      sound.no(); buzz(12);
      toast(dist <= tol && !rotOk ? t('turnIt') : t('notHere'));
    }
    returnToDrawer(d);
  }
  endDrag();
}

function dragCancel() { if (drag) { returnToDrawer(drag); endDrag(); } }

function endDrag() {
  blob.visible = false;
  document.body.classList.remove('dragging');
  drag = null;
  view.needsRender = true;
}

function returnToDrawer(d) {
  const p = d.p;
  const start = p.obj.position.clone();
  const tile = d.tile;
  tile.classList.remove('lifted');
  tile.classList.remove('shake'); void tile.offsetWidth;
  if (d.over) tile.classList.add('shake');
  tween(160, e => { p.obj.position.y = start.y + 40 * e; p.obj.scale.setScalar(1 - 0.6 * e); }, () => {
    view.world.remove(p.obj); p.obj.scale.setScalar(1); p.obj.visible = true;
  });
}

function place(code, animate) {
  const p = pieces.get(code);
  state.placed.add(code);
  p.obj.rotation.set(0, 0, 0);
  p.obj.position.copy(p.target);
  board.add(p.obj);
  if (p.tile) {
    const tile = p.tile;
    tile.classList.add('gone');
    setTimeout(() => tile.remove(), 260);
    p.tile = null;
  }
  if (ghost && ghost.code === code) clearGhost();
  if (animate) {
    // set down in the tray; if it joins pieces already there, the knobs click in too
    const joined = neighbours(code).filter(c => c !== code && state.placed.has(c)).length;
    sound.drop();
    if (joined) { setTimeout(() => sound.connect(joined), 60); buzz([14, 40, 20]); } else buzz(16);
    const y0 = p.target.y;
    p.obj.position.y = y0 + 3.2;
    tween(220, e => { p.obj.position.y = y0 + 3.2 * (1 - e) * (1 - e); }, () => { view.renderer.shadowMap.needsUpdate = true; });
    popLandmarks(code);
  }
  view.renderer.shadowMap.needsUpdate = true;
  view.needsRender = true;
  updateHud();
  save();
  if (state.placed.size === pieces.size) finish();
}

// pieces next to this one in the 8 x 8 grid (A-H west to east, 1-8 north to south)
function neighbours(code) {
  const i = 'ABCDEFGH'.indexOf(code[0]), j = parseInt(code.slice(1), 10);
  const out = [];
  for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const ii = i + di, jj = j + dj;
    if (ii >= 0 && ii < 8 && jj >= 1 && jj <= 8) out.push('ABCDEFGH'[ii] + jj);
  }
  return out;
}

function onBoardTap() { /* reserved: tapping the board does nothing in play */ }

// auto-pan when a dragged piece is held near the edge of the map area
const _ea = new THREE.Vector3(), _eb = new THREE.Vector3();
function edgePan(dt) {
  if (!drag || !drag.over || view.xr) return false;
  if (view.rig.dist > view.fitDist * 0.85) return false;
  const r = canvas.getBoundingClientRect();
  const top = view.insets.top;
  const sx = drag.cx - r.left, sy = drag.cy - r.top - liftPx();
  const m = 34;
  let vx = 0, vy = 0;
  if (sx < m) vx = -(m - sx) / m; else if (sx > r.width - m) vx = (sx - (r.width - m)) / m;
  if (sy < top + m) vy = -(top + m - sy) / m;
  if (!vx && !vy) return false;
  // turn the screen direction into a map direction (the map may be rotated or tilted)
  const A = view.screenToPlane(r.width / 2, (top + r.height - view.insets.bottom) / 2, view.floorY, _ea);
  const B = view.screenToPlane(r.width / 2 + vx * 40, (top + r.height - view.insets.bottom) / 2 + vy * 40, view.floorY, _eb);
  if (!A || !B) return false;
  const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz) || 1;
  const speed = view.mmPerPx() * 540 * dt * Math.hypot(vx, vy);
  view.rig.x += dx / len * speed; view.rig.z += dz / len * speed;
  view.clampRig();
  dragMove(drag.cx, drag.cy);
  return true;
}

// ------------------------------------------------------------------ hints
function hint() {
  if (mode !== 'play') return;
  const tiles = [...document.querySelectorAll('#strip .pc:not(.gone)')];
  if (!tiles.length) return;
  let code = state.lastTried && !state.placed.has(state.lastTried) ? state.lastTried : null;
  if (!code) {
    const strip = $('#strip').getBoundingClientRect();
    const visible = tiles.find(tl => { const b = tl.getBoundingClientRect(); return b.left >= strip.left - 2 && b.right <= strip.right + 2; });
    code = (visible || tiles[0]).dataset.code;
  }
  state.hints++;
  updateHud();
  save();
  const p = pieces.get(code);
  p.tile?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  p.tile?.classList.remove('pulse'); void p.tile?.offsetWidth; p.tile?.classList.add('pulse');
  showGhost(code);
  const s = view.worldToScreen(p.target);
  const r = canvas.getBoundingClientRect();
  const inView = s.x > 20 && s.x < r.width - 20 && s.y > view.insets.top + 20 && s.y < r.height - view.insets.bottom - 20;
  if (!view.xr && (!inView || view.rig.dist > view.fitDist * 0.7)) view.animateTo({ x: p.target.x, z: p.target.z, dist: Math.min(view.rig.dist, view.fitDist * 0.55) }, 600);
}

function showGhost(code) {
  clearGhost();
  const p = pieces.get(code);
  const shape = new THREE.Shape(p.info.outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color: 0xffc94d, transparent: true, opacity: 0.35, depthWrite: false }));
  fill.rotation.x = -Math.PI / 2;
  const pts = p.info.outline.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xffd36b, transparent: true }));
  const g = new THREE.Group();
  g.add(fill, line);
  g.position.set(p.target.x, view.floorY + 0.2, p.target.z);
  g.renderOrder = 3;
  g.userData.hideInCover = true;
  view.world.add(g);
  ghost = { code, g, t0: performance.now() };
}

function clearGhost() {
  if (!ghost) return;
  view.world.remove(ghost.g);
  ghost.g.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  ghost = null;
  view.needsRender = true;
}

// ------------------------------------------------------------------ finish + explore
function finish() {
  state.done = true;
  save();
  setTimeout(() => sound.victory(), 250); buzz([30, 60, 30, 60, 60]);
  guide.visible = false;
  const lv = state.level;
  const bestAll = store.get(`slagalica.best.${dataId}`, {});
  const prev = bestAll[lv];
  const isBest = !prev || state.elapsed < prev;
  if (isBest) { bestAll[lv] = Math.round(state.elapsed); store.set(`slagalica.best.${dataId}`, bestAll); }
  const stars = state.hints <= 2 ? 3 : state.hints <= 6 ? 2 : 1;
  $('#doneTime').textContent = fmt(state.elapsed);
  $('#doneBest').textContent = fmt(isBest ? state.elapsed : prev) + (isBest ? ' ★' : '');
  $('#doneHints').textContent = String(state.hints);
  document.querySelectorAll('#stars i').forEach((el, i) => el.classList.toggle('on', i < stars));
  store.del(`slagalica.game.${dataId}`);
  setTimeout(() => {
    mode = 'explore';
    document.body.dataset.mode = 'explore';
    gestures.mode = 'explore';
    layout();
    view.animateTo({ x: 0, z: 0, dist: view.fitDist * 0.8, tilt: 0.85 }, 1400);
    setTimeout(() => { showLabels(); openOverlay('#done'); }, 1200);
  }, 450);
}

function startExplore() {
  closeAll();
  mode = 'explore';
  document.body.dataset.mode = 'explore';
  gestures.mode = 'explore';
  gestures.enabled = true;
  layout();
  showLabels();
  toast(t('exploreHint'), 3200);
}

// landmark labels
const labels = [];
function buildLabels() {
  const root = $('#labels');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.id = 'leaders';
  root.appendChild(svg);
  for (const lm of puzzle.landmarks || []) {
    const el = document.createElement('button');
    el.className = 'lbl';
    el.type = 'button';
    el.addEventListener('click', () => openCard(lm));
    root.appendChild(el);
    const line = document.createElementNS(SVGNS, 'line');
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('r', 2.6);
    line.style.display = dot.style.display = 'none';
    svg.append(line, dot);
    labels.push({ lm, el, line, dot, pos: new THREE.Vector3(...lm.pos), pop: 0 });
  }
  refreshLabelText();
}
function refreshLabelText() { for (const l of labels) { l.el.textContent = l.lm.name[getLang()] || l.lm.name.me; l.w = 0; } }
let labelsOn = false;
function showLabels() { labelsOn = true; $('#labels').classList.add('on'); }
function hideLabels() { labelsOn = false; $('#labels').classList.remove('on'); }
function popLandmarks(code) {
  for (const l of labels) if (l.lm.piece === code) { l.pop = performance.now() + 2600; }
}
const SVGNS = 'http://www.w3.org/2000/svg';
function updateLabels(now) {
  // Most important first: each label tries a few spots near its building; if none is free it waits
  // until the user zooms in. A thin leader line joins the label to its building.
  const svg = $('#leaders');
  const items = [];
  labels.forEach((l, i) => {
    const show = labelsOn || l.pop > now;
    if (!show) { l.el.style.display = 'none'; l.line.style.display = 'none'; l.dot.style.display = 'none'; return; }
    const s = view.worldToScreen(l.pos);
    if (s.z > 1 || s.z < -1) { l.el.style.display = 'none'; l.line.style.display = 'none'; l.dot.style.display = 'none'; return; }
    if (l.el.style.display !== 'block') { l.el.style.display = 'block'; l.w = 0; }
    if (!l.w) { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }
    items.push({ l, s, prio: i });
  });
  items.sort((a, b) => a.prio - b.prio);
  const taken = [];
  const top = view.insets.top + 4, bottom = view.size.h - view.insets.bottom - 4;
  for (const { l, s } of items) {
    const g = 10, w = l.w, h = l.h;
    const spots = [[0, -g], [0, -g - h - 6], [w / 2 + 12, -g - h / 2], [-(w / 2 + 12), -g - h / 2], [0, g + h], [w / 2 + 12, -g - h - 8], [-(w / 2 + 12), -g - h - 8]];
    let chosen = null;
    for (const [dx, dy] of spots) {
      const cx = s.x + dx, by = s.y + dy;            // label centre x, bottom y
      const r = { x0: cx - w / 2 - 3, x1: cx + w / 2 + 3, y0: by - h - 3, y1: by + 1 };
      if (r.y0 < top || r.y1 > bottom || r.x0 < 2 || r.x1 > view.size.w - 2) continue;
      if (!taken.some(q => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) { chosen = { cx, by, r }; break; }
    }
    if (!chosen) { l.el.style.display = 'none'; l.line.style.display = 'none'; l.dot.style.display = 'none'; continue; }
    taken.push(chosen.r);
    l.el.style.transform = `translate(${chosen.cx}px, ${chosen.by}px) translate(-50%, -100%)`;
    l.el.classList.toggle('popping', !labelsOn && l.pop > now);
    // leader from the building to the nearest point of the label
    const lx = Math.max(chosen.r.x0 + 6, Math.min(chosen.r.x1 - 6, s.x));
    const ly = chosen.by < s.y ? chosen.by : chosen.by - h;
    l.line.setAttribute('x1', s.x); l.line.setAttribute('y1', s.y);
    l.line.setAttribute('x2', lx); l.line.setAttribute('y2', ly);
    l.dot.setAttribute('cx', s.x); l.dot.setAttribute('cy', s.y);
    l.line.style.display = ''; l.dot.style.display = '';
  }
  svg.setAttribute('viewBox', `0 0 ${view.size.w} ${view.size.h}`);
}
function openCard(lm) {
  $('#cardTitle').textContent = lm.name[getLang()] || lm.name.me;
  $('#cardPiece').textContent = `${t('onPiece')} ${lm.piece}`;
  $('#cardText').textContent = (lm.text && (lm.text[getLang()] || lm.text.me)) || t('soon');
  openOverlay('#card');
}

// ------------------------------------------------------------------ HUD, overlays
function fmt(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
function updateHud() {
  $('#count').textContent = `${state.placed.size}/${pieces.size}`;
  $('#clock').textContent = fmt(state.elapsed);
  $('#hintN').textContent = state.hints ? String(state.hints) : '';
}
let toastTimer = 0;
function toast(msg, ms = 1300) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}
function openOverlay(sel) { closeAll(); $(sel).hidden = false; }
function closeAll() { document.querySelectorAll('.ov, .sheet').forEach(el => { if (el.id !== 'start') el.hidden = true; }); }

function wireUI() {
  $('#bContinue').addEventListener('click', () => startGame(null, true));
  document.querySelectorAll('[data-level]').forEach(b => b.addEventListener('click', () => startGame(b.dataset.level, false)));
  document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => {
    prefs.lang = b.dataset.lang; store.set('slagalica.prefs', prefs); setLang(prefs.lang); refreshLabelText(); syncToggles();
    if (mode === 'attract') showStart();
  }));
  $('#bHow').addEventListener('click', () => openOverlay('#help'));
  $('#bHelpGo').addEventListener('click', closeAll);
  $('#bMenu').addEventListener('click', () => { syncToggles(); openOverlay('#menu'); });
  $('#bHint').addEventListener('click', hint);
  $('#bPic').addEventListener('click', () => openOverlay('#pic'));
  $('#pic').addEventListener('click', closeAll);
  $('#bView').addEventListener('click', () => view.animateTo({ tilt: view.rig.tilt > 0.3 ? 0 : 0.85 }, 500));
  $('#bZin').addEventListener('click', () => view.zoomBy(0.6));
  $('#bZout').addEventListener('click', () => view.zoomBy(1 / 0.6));
  $('#bTurn').addEventListener('click', () => view.turnQuarter(1));
  $('#bNorth').addEventListener('click', () => view.northUp());
  $('#bAR').addEventListener('click', () => {
    sound.unlock();
    if (ar.active) { ar.end(); return; }
    ar.start().catch(err => { console.warn('AR', err); toast(t('arFail'), 3000); });
  });
  $('#bArExit').addEventListener('click', () => ar.end());
  $('#bArMove').addEventListener('click', () => ar.replace());
  document.querySelectorAll('.arsizes button').forEach(b => b.addEventListener('click', () => ar.setSize(parseFloat(b.dataset.size))));
  ArMode.supported().then(ok => { $('#bAR').hidden = !ok; $('#arNote').hidden = !ok; });
  $('#bSound').addEventListener('click', () => { prefs.sound = !(prefs.sound !== false); sound.on = prefs.sound; store.set('slagalica.prefs', prefs); syncToggles(); sound.unlock(); });
  $('#bMenuHow').addEventListener('click', () => openOverlay('#help'));
  $('#bMenuNew').addEventListener('click', () => { closeAll(); save(); showStart(); });
  $('#bAbout').addEventListener('click', () => openOverlay('#about'));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => {
    closeAll();
  }));
  document.querySelectorAll('.ov, .sheet').forEach(el => el.addEventListener('click', e => { if (e.target === el && el.id !== 'start' && el.id !== 'done') closeAll(); }));
  $('#bExplore').addEventListener('click', startExplore);
  $('#bAgain').addEventListener('click', () => showStart());
  $('#bExploreNew').addEventListener('click', () => showStart());
  document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'play') save(); });
  window.addEventListener('pagehide', () => { if (mode === 'play') save(); });
  syncToggles();
}
function syncToggles() {
  document.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('sel', b.dataset.lang === getLang()));
  $('#soundState').textContent = t(prefs.sound !== false ? 'on' : 'off');
}

// ------------------------------------------------------------------ tweens + loop
function tween(ms, fn, done) { tweens.push({ t0: performance.now(), ms, fn, done }); view.needsRender = true; }
function runTweens(now) {
  if (!tweens.length) return false;
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    const k = Math.min(1, (now - tw.t0) / tw.ms);
    tw.fn(1 - Math.pow(1 - k, 3));
    if (k >= 1) { tweens.splice(i, 1); tw.done?.(); }
  }
  return true;
}

let last = performance.now(), lastRender = 0, lastSecond = 0, lastNorth = 0;
const needle = document.getElementById('needle');
const strip = document.getElementById('strip');
function tick(now, frame) {
  now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let active = view.stepAnim(now);
  active = runTweens(now) || active;
  if (mode === 'attract' && !LOW) { view.rig.yaw += dt * 0.12; active = true; }
  if (mode === 'explore' && !gestures.p.size && !view.anim && $('#done').hidden === false) { view.rig.yaw += dt * 0.06; active = true; }
  active = edgePan(dt) || active;
  if (mode === 'play' && state.started && !document.hidden) {
    state.elapsed += dt * 1000;
    if (now - lastSecond > 500) { lastSecond = now; $('#clock').textContent = fmt(state.elapsed); }
  }
  if (ghost) {
    const k = (now - ghost.t0) / 1000;
    const a = 0.5 + 0.5 * Math.sin(k * 5);
    ghost.g.children[0].material.opacity = 0.15 + 0.3 * a;
    ghost.g.children[1].material.opacity = 0.5 + 0.5 * a;
    if (k > 6) clearGhost();
    active = true;
  }
  view.uTime.value = now / 1000;
  if (ar.active) ar.onFrame(frame);
  if (view.renderer.xr.isPresenting || view.needsRender || active || (!LOW && now - lastRender > 48)) {
    view.render();
    lastRender = now;
    updateLabels(now);
    const na = view.northAngle();
    if (Math.abs(na - lastNorth) > 0.002) { lastNorth = na; needle.style.transform = `rotate(${na}rad)`; strip.style.setProperty('--map-rot', `${na}rad`); }
  }
}

// test hooks (used by the automated checks)
window.__game = {
  get state() { return { ...state, placed: [...state.placed], mode }; },
  view, pieces, startGame, place, hint, sound, neighbours, ar,
  screenOf(code) { const p = pieces.get(code); view.applyRig(); const s = view.worldToScreen(p.target); const r = canvas.getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top, lift: drag ? liftPx() : null }; },
  liftFor(code, touch = true) { const p = pieces.get(code); if (!touch) return 0; const px = p.half / view.mmPerPx(); return Math.min(110, Math.max(56, px + 34)); },
};

load().catch(err => {
  console.error(err);
  $('#loading span').textContent = 'Error: ' + err.message;
});
