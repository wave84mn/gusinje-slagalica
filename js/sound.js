// Synthesized sound effects (no audio files, so they work offline and cost nothing to download).
//   pick     - lifting a piece out of the drawer
//   drop     - setting a piece down in the tray
//   connect  - the piece clicking into placed neighbours (higher and brighter with more neighbours)
//   back     - a piece sliding back into the drawer
//   no       - dropped in the wrong place
//   victory  - the whole puzzle is done
// Each effect is a function (ctx, out, t, rev, ...args) so it can also be rendered offline for checks.

const noiseCache = new WeakMap();
function noise(c) {
  let b = noiseCache.get(c);
  if (!b) {
    b = c.createBuffer(1, Math.floor(c.sampleRate * 1.0), c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(c, b);
  }
  return b;
}

// envelope helper: quick attack, exponential decay
function env(g, t, peak, attack, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function burst(c, out, t, { type = 'bandpass', f0 = 2000, f1 = f0, q = 1, peak = 0.3, attack = 0.003, decay = 0.05 }) {
  const src = c.createBufferSource();
  src.buffer = noise(c);
  const f = c.createBiquadFilter();
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
  const g = c.createGain();
  env(g, t, peak, attack, decay);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + attack + decay + 0.02);
}

function tone(c, out, t, { type = 'sine', f0 = 440, f1 = f0, peak = 0.2, attack = 0.005, decay = 0.2, slide = null }) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + (slide ?? attack + decay));
  const g = c.createGain();
  env(g, t, peak, attack, decay);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

const PENTA = [659.25, 783.99, 880.0, 1046.5, 1174.66];   // E5 G5 A5 C6 D6

export const SFX = {
  pick(c, out, t) {
    burst(c, out, t, { f0: 1700, f1: 3900, q: 1.3, peak: 0.2, attack: 0.006, decay: 0.07 });
    tone(c, out, t, { f0: 520, f1: 820, peak: 0.05, attack: 0.004, decay: 0.07 });
  },
  drop(c, out, t) {
    burst(c, out, t, { type: 'lowpass', f0: 1300, f1: 500, q: 0.7, peak: 0.45, attack: 0.002, decay: 0.04 });
    burst(c, out, t, { f0: 2600, q: 3, peak: 0.18, attack: 0.001, decay: 0.015 });
    tone(c, out, t, { f0: 200, f1: 110, peak: 0.32, attack: 0.003, decay: 0.1 });
  },
  connect(c, out, t, rev, n = 1) {
    const k = Math.max(1, Math.min(4, n));
    // the knobs snapping in: two crisp clicks
    burst(c, out, t, { f0: 3400, q: 4, peak: 0.42, attack: 0.001, decay: 0.022 });
    burst(c, out, t + 0.045, { f0: 3900, q: 4, peak: 0.32, attack: 0.001, decay: 0.02 });
    // a small bell, one step higher for each neighbour it joins
    const f = PENTA[k - 1];
    const bell = c.createGain(); bell.gain.value = 1;
    bell.connect(out);
    if (rev) { const s = c.createGain(); s.gain.value = 0.25; bell.connect(s).connect(rev); }
    tone(c, bell, t + 0.05, { type: 'triangle', f0: f, peak: 0.1, attack: 0.004, decay: 0.38 });
    tone(c, bell, t + 0.05, { f0: f * 2, peak: 0.035, attack: 0.004, decay: 0.22 });
    if (k >= 3) tone(c, bell, t + 0.13, { type: 'triangle', f0: PENTA[Math.min(4, k)] * 1.5, peak: 0.06, attack: 0.004, decay: 0.32 });
  },
  back(c, out, t) {
    burst(c, out, t, { f0: 2600, f1: 900, q: 0.9, peak: 0.22, attack: 0.02, decay: 0.12 });
  },
  no(c, out, t) {
    tone(c, out, t, { type: 'triangle', f0: 262, f1: 196, peak: 0.16, attack: 0.02, decay: 0.2, slide: 0.16 });
  },
  victory(c, out, t, rev) {
    const bus = c.createGain(); bus.gain.value = 0.9;
    bus.connect(out);
    if (rev) { const s = c.createGain(); s.gain.value = 0.32; bus.connect(s).connect(rev); }
    // brass-like voice: two detuned saws through a low-pass that opens with each note
    const voice = (f, at, len, peak) => {
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + 0.03);
      g.gain.setValueAtTime(peak, at + Math.max(0.04, len - 0.12));
      g.gain.exponentialRampToValueAtTime(0.0001, at + len + 0.25);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 0.8;
      lp.frequency.setValueAtTime(f * 1.5, at);
      lp.frequency.exponentialRampToValueAtTime(f * 5, at + 0.06);
      lp.frequency.exponentialRampToValueAtTime(f * 2.5, at + len);
      lp.connect(g).connect(bus);
      const vib = c.createOscillator(), vg = c.createGain();
      vib.frequency.value = 5.2; vg.gain.value = f * 0.004;
      vib.connect(vg);
      for (const det of [-6, 6]) {
        const o = c.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
        vg.connect(o.frequency);
        o.connect(lp); o.start(at); o.stop(at + len + 0.3);
      }
      vib.start(at); vib.stop(at + len + 0.3);
    };
    const n = [392.0, 523.25, 659.25, 783.99];          // G4 C5 E5 G5
    voice(n[0], t, 0.12, 0.09); voice(n[1], t + 0.13, 0.12, 0.09); voice(n[2], t + 0.26, 0.12, 0.09);
    voice(n[3], t + 0.39, 0.45, 0.1);
    for (const f of [523.25, 659.25, 783.99, 1046.5]) voice(f, t + 0.95, 1.5, 0.06);   // C major chord
    // drum hits under the long notes
    for (const at of [t + 0.39, t + 0.95]) {
      tone(c, bus, at, { f0: 110, f1: 62, peak: 0.45, attack: 0.004, decay: 0.45, slide: 0.3 });
      burst(c, bus, at, { type: 'lowpass', f0: 900, f1: 300, peak: 0.25, attack: 0.002, decay: 0.12 });
    }
    // little bells sparkling over the chord
    const bells = [1046.5, 1174.66, 1318.5, 1568.0, 1760.0, 2093.0];
    for (let i = 0; i < 12; i++) {
      const at = t + 1.0 + i * 0.13 + Math.random() * 0.05;
      const f = bells[(i * 2 + (i % 3)) % bells.length];
      tone(c, bus, at, { type: 'triangle', f0: f, peak: 0.045, attack: 0.003, decay: 0.45 });
    }
  },
};

function makeBus(c) {
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
  const master = c.createGain(); master.gain.value = 0.85;
  master.connect(comp).connect(c.destination);
  // small room: decaying stereo noise as an impulse response
  const len = Math.floor(c.sampleRate * 1.6);
  const ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  const rev = c.createConvolver();
  rev.buffer = ir;
  const wet = c.createGain(); wet.gain.value = 0.5;
  rev.connect(wet).connect(master);
  return { out: master, rev };
}

let ctx = null, bus = null;
export const sound = {
  on: true,
  unlock() {
    if (!this.on) return;
    try {
      if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); bus = makeBus(ctx); }
      if (ctx.state === 'suspended') ctx.resume();
    } catch { ctx = null; }
  },
  play(name, ...args) {
    if (!this.on || !ctx || !bus) return;
    try { SFX[name](ctx, bus.out, ctx.currentTime + 0.01, bus.rev, ...args); } catch { /* never let a sound break the game */ }
  },
  pick() { this.play('pick'); },
  drop() { this.play('drop'); },
  connect(n) { this.play('connect', n); },
  back() { this.play('back'); },
  no() { this.play('no'); },
  victory() { this.play('victory'); },
  // kept for older calls
  click() { this.play('drop'); },
  chime() { this.play('victory'); },
};

// Render a sequence offline: seq = [[name, timeSeconds, ...args], ...]. Used by the checks and the preview file.
export function renderSfx(seq, sampleRate = 44100) {
  const dur = Math.max(...seq.map(s => s[1])) + 3.2;
  const c = new OfflineAudioContext(2, Math.ceil(dur * sampleRate), sampleRate);
  const b = makeBus(c);
  for (const [name, t, ...a] of seq) SFX[name](c, b.out, t, b.rev, ...a);
  return c.startRendering();
}

export function buzz(ms) { try { navigator.vibrate?.(ms); } catch { /* not supported */ } }
