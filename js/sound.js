// Small synthesized sounds (no audio files): a wooden click, a soft "no", a finish chime.
let ctx = null;
export const sound = {
  on: true,
  unlock() {
    if (ctx || !this.on) return;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; }
  },
  click() {
    if (!this.on || !ctx) return;
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.05);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 1.4;
    const g = ctx.createGain(); g.gain.value = 0.9;
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.08);
    og.gain.setValueAtTime(0.35, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(og).connect(ctx.destination); o.start(t); o.stop(t + 0.12);
  },
  no() {
    if (!this.on || !ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(260, t); o.frequency.linearRampToValueAtTime(190, t + 0.16);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.22);
  },
  chime() {
    if (!this.on || !ctx) return;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const s = t + i * 0.12;
      g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.2, s + 0.02); g.gain.exponentialRampToValueAtTime(0.001, s + 0.9);
      o.connect(g).connect(ctx.destination); o.start(s); o.stop(s + 1);
    });
  },
};

export function buzz(ms) { try { navigator.vibrate?.(ms); } catch { /* not supported */ } }
