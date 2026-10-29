// Renders the sound effects offline in Chromium, checks their levels, and writes a preview WAV.
// usage: node tests/sfx.cjs <url> <out.wav>
const { chromium } = require('playwright');
const fs = require('fs');
const url = process.argv[2] || 'http://127.0.0.1:8099/';
const outWav = process.argv[3] || 'build/zvukovi.wav';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto(url + 'css/app.css');   // any page on the same origin, so the module import works
  const res = await p.evaluate(async () => {
    const m = await import('/js/sound.js');
    const seq = [
      ['pick', 0.3], ['drop', 1.0],
      ['pick', 2.0], ['drop', 2.7], ['connect', 2.76, 1],
      ['pick', 3.7], ['drop', 4.4], ['connect', 4.46, 2],
      ['pick', 5.4], ['drop', 6.1], ['connect', 6.16, 4],
      ['back', 7.1], ['no', 7.8], ['victory', 8.8],
    ];
    const buf = await m.renderSfx(seq);
    const L = buf.getChannelData(0), R = buf.getChannelData(1), sr = buf.sampleRate;
    const stats = seq.map(([name, t], i) => {
      const t1 = i + 1 < seq.length ? seq[i + 1][1] : buf.duration;
      let peak = 0, sum = 0, n = 0;
      for (let k = Math.floor(t * sr); k < Math.min(L.length, Math.floor(t1 * sr)); k++) { const v = Math.max(Math.abs(L[k]), Math.abs(R[k])); peak = Math.max(peak, v); sum += L[k] * L[k]; n++; }
      return { name, t, peak: +peak.toFixed(3), rms: +Math.sqrt(sum / Math.max(1, n)).toFixed(4) };
    });
    // 16-bit stereo WAV
    const n = L.length, data = new DataView(new ArrayBuffer(44 + n * 4));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); data.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 2, true); data.setUint32(24, sr, true);
    data.setUint32(28, sr * 4, true); data.setUint16(32, 4, true); data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) {
      data.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      data.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    }
    let bin = ''; const u8 = new Uint8Array(data.buffer);
    for (let i = 0; i < u8.length; i += 32768) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return { stats, wav: btoa(bin), duration: buf.duration };
  });
  fs.writeFileSync(outWav, Buffer.from(res.wav, 'base64'));
  for (const s of res.stats) console.log(`${s.name.padEnd(8)} at ${s.t.toFixed(2)}s  peak ${s.peak}  rms ${s.rms}`);
  console.log(`wrote ${outWav} (${res.duration.toFixed(1)} s)`);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
