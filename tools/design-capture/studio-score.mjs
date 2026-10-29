// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// "Music composed to the scene": a short score written to the scene's own timing and played by instruments made here
// in code (no add-on, no graphics card, any computer). What it listens to in the scene:
//   - the moments things land (an entrance finishing, a marker, a group starting): the tempo is the one whose beats
//     fall closest to them, and the strongest get an accent;
//   - the sections (markers, else groups, else even parts): a chord change at each;
//   - the reveal (the still frame, else the biggest entrance after the first third): a rising lift into it, the drums
//     dropping out for a bar before it and coming back on it.
// Instruments: a plucked string (Karplus-Strong, a physical model of a string), a soft pad (detuned saws through a
// low-pass filter), a bass, a kick, a clap, a hi-hat, a riser and an impact. Mixed to a stereo WAV.

const SR = 44100;
const r2 = (x) => Math.round(x * 100) / 100;

const MOODS = {
  bright: { scale: 'major', root: 60, prog: [0, 4, 5, 3], drums: true, bpm: [100, 124] },   // I V vi IV
  calm: { scale: 'major', root: 57, prog: [0, 3, 5, 4], drums: false, bpm: [76, 96] },
  dark: { scale: 'minor', root: 57, prog: [0, 5, 2, 6], drums: true, bpm: [90, 118] },     // i VI III VII
  driving: { scale: 'minor', root: 52, prog: [0, 0, 5, 6], drums: true, bpm: [118, 132] },
};
const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

/** The scene's timing: moments things land, sections, the reveal. */
export function sceneTiming(scene) {
  const land = [];
  const walk = (ls, at) => ls.forEach((l) => {
    if (l.type === 'group') { land.push({ t: at + (l.start ?? 0), w: 2 }); return walk(l.layers || [], at + (l.start ?? 0)); }
    for (const c of l.clips || []) {
      const ends = c.start + c.duration;
      // Entrances (presets that bring a layer in) land at their end; size matters: big text lands harder.
      if (/rise|slam|pop|zoom|grow|stretch|wipe|iris|slide|fade|blur|flip|tumble|in$/.test(c.preset)) land.push({ t: at + ends, w: (l.type === 'text' && (l.style?.fontSize ?? 4) >= 6) || l.type === 'model' ? 1.5 : 1 });
    }
  });
  walk(scene.layers || [], 0);
  for (const m of scene.markers || []) land.push({ t: m.t, w: 2 });
  const D = scene.duration;
  const moments = land.filter((m) => m.t > 0.05 && m.t < D - 0.05).sort((a, b) => a.t - b.t);
  let sections = (scene.markers || []).map((m) => m.t).filter((t) => t > 0.5 && t < D - 1);
  if (!sections.length) sections = (scene.layers || []).filter((l) => l.type === 'group').map((l) => l.start ?? 0).filter((t) => t > 0.5 && t < D - 1);
  const poster = scene.playback?.posterTime;
  const big = moments.filter((m) => m.t > D / 3 && m.w >= 1.5).sort((a, b) => b.w - a.w || a.t - b.t)[0];
  const reveal = typeof poster === 'number' && poster > 2 && poster < D - 0.5 ? poster : big ? big.t : D * 0.6;
  return { duration: D, moments, sections: [...new Set(sections.map(r2))].sort((a, b) => a - b), reveal: r2(reveal) };
}

/** The tempo (in the mood's range) whose beat grid sits closest to the landing moments. */
export function pickTempo(moments, range) {
  let best = { bpm: range[0], score: Infinity };
  for (let bpm = range[0]; bpm <= range[1]; bpm++) {
    const beat = 60 / bpm, eighth = beat / 2;
    const score = moments.reduce((s, m) => { const off = Math.abs(m.t / eighth - Math.round(m.t / eighth)) * eighth; return s + off * m.w; }, 0);
    if (score < best.score) best = { bpm, score };
  }
  return best.bpm;
}

// ---- instruments: each adds into a Float32Array buffer at a time ----
function pluck(buf, t, midi, len = 1.2, vol = 0.25) {
  const f = hz(midi), N = Math.max(2, Math.round(SR / f)), ring = new Float32Array(N);
  for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
  const s0 = Math.round(t * SR), n = Math.round(len * SR);
  let idx = 0;
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const a = ring[idx], b = ring[(idx + 1) % N];
    ring[idx] = 0.4985 * (a + b);
    const env = i < 40 ? i / 40 : 1;
    buf[s0 + i] += a * vol * env * (1 - i / n) ** 0.3;
    idx = (idx + 1) % N;
  }
}
function pad(buf, t, len, midis, vol = 0.05) {
  const s0 = Math.round(t * SR), n = Math.round(len * SR), att = 0.4 * SR, rel = 0.6 * SR;
  let lp = 0;
  const osc = midis.flatMap((m) => [hz(m) * 0.997, hz(m) * 1.003]).map((f) => ({ f, ph: Math.random() }));
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    let v = 0;
    for (const o of osc) { o.ph += o.f / SR; v += 2 * (o.ph % 1) - 1; }
    lp += 0.06 * (v / osc.length - lp); // a soft low-pass
    const env = Math.min(1, i / att, (n - i) / rel);
    buf[s0 + i] += lp * vol * env * 4;
  }
}
function bass(buf, t, len, midi, vol = 0.22) {
  const s0 = Math.round(t * SR), n = Math.round(len * SR), f = hz(midi);
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const ph = (i * f) / SR, env = Math.min(1, i / 200) * Math.exp(-i / (SR * 0.9));
    buf[s0 + i] += (Math.sin(2 * Math.PI * ph) + 0.25 * Math.sin(4 * Math.PI * ph)) * vol * env;
  }
}
function kick(buf, t, vol = 0.6) {
  const s0 = Math.round(t * SR);
  let ph = 0;
  for (let i = 0; i < SR * 0.4 && s0 + i < buf.length; i++) {
    const f = 45 + 110 * Math.exp(-i / (SR * 0.03)); ph += f / SR;
    buf[s0 + i] += Math.sin(2 * Math.PI * ph) * vol * Math.exp(-i / (SR * 0.12));
  }
}
function noiseHit(buf, t, len, vol, hp) {
  const s0 = Math.round(t * SR);
  let last = 0;
  for (let i = 0; i < len * SR && s0 + i < buf.length; i++) {
    const w = Math.random() * 2 - 1, h = hp ? w - last : w; last = w;
    buf[s0 + i] += h * vol * Math.exp(-i / (SR * len * 0.3));
  }
}
const clap = (buf, t) => { for (const d of [0, 0.012, 0.024]) noiseHit(buf, t + d, 0.18, 0.12, true); };
const hat = (buf, t, vol = 0.05) => noiseHit(buf, t, 0.05, vol, true);
function riser(buf, from, to, vol = 0.12) {
  const s0 = Math.round(from * SR), n = Math.round((to - from) * SR);
  let lp = 0;
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const k = i / n, a = 0.01 + 0.3 * k * k;
    lp += a * ((Math.random() * 2 - 1) - lp);
    buf[s0 + i] += lp * vol * k * 2;
  }
}
function impact(buf, t) { kick(buf, t, 0.8); noiseHit(buf, t, 0.9, 0.18, false); }

/**
 * Composes and plays the score: { scene, mood?: bright|calm|dark|driving } →
 * { wav (Buffer, 16-bit stereo), bpm, key, mood, accents, reveal, seconds }.
 */
export function composeScore(scene, { mood = 'bright' } = {}) {
  const M = MOODS[mood] || MOODS.bright;
  const tm = sceneTiming(scene);
  const bpm = pickTempo(tm.moments, M.bpm), beat = 60 / bpm, bar = beat * 4;
  const D = tm.duration, tail = 1.5, len = Math.ceil((D + tail) * SR);
  const L = new Float32Array(len), R = new Float32Array(len);
  const scale = SCALES[M.scale];
  const chordAt = (deg) => [0, 2, 4].map((k) => { const d = deg + k; return M.root + scale[d % 7] + 12 * Math.floor(d / 7); });
  // Sections: chord changes at each section start, else every two bars.
  const starts = tm.sections.length ? [0, ...tm.sections] : Array.from({ length: Math.ceil(D / (bar * 2)) }, (_, i) => i * bar * 2);
  const snap = (t) => Math.round(t / beat) * beat;
  const secs = [...new Set(starts.map(snap))].sort((a, b) => a - b);
  const quietFrom = Math.max(0, snap(tm.reveal) - bar), revealT = snap(tm.reveal);
  secs.forEach((s, i) => {
    const e = i + 1 < secs.length ? secs[i + 1] : D + 0.6;
    const deg = M.prog[i % M.prog.length], ch = chordAt(deg);
    pad(L, s, e - s + 0.4, ch); pad(R, s, e - s + 0.4, ch.map((m) => m + 12), 0.035);
    // Bass on each beat's start of the bar, plucked arpeggio on eighths.
    for (let t = s; t < e - 0.01; t += beat) {
      if (Math.round((t - s) / beat) % 2 === 0) { bass(L, t, beat * 1.8, ch[0] - 24); bass(R, t, beat * 1.8, ch[0] - 24); }
    }
    let n = 0;
    for (let t = s; t < e - 0.01; t += beat / 2, n++) {
      const m = ch[[0, 1, 2, 1][n % 4]] + 12;
      (n % 2 ? R : L)[0] !== undefined && pluck(n % 2 ? R : L, t, m, 0.9, mood === 'calm' ? 0.18 : 0.22);
    }
  });
  // Drums (not for calm): out for the bar before the reveal, back on it.
  if (M.drums) for (let t = 0, i = 0; t < D; t += beat / 2, i++) {
    if (t >= quietFrom && t < revealT) continue;
    if (i % 4 === 0) { kick(L, t); kick(R, t); }
    if (i % 8 === 4) { clap(L, t); clap(R, t); }
    hat(i % 2 ? L : R, t, i % 2 ? 0.035 : 0.05);
  }
  // The lift into the reveal, and an impact on it.
  if (revealT > bar) { riser(L, quietFrom, revealT); riser(R, quietFrom, revealT); }
  impact(L, revealT); impact(R, revealT);
  // Accents: the strongest landings (a few), on the nearest eighth, as a high pluck.
  const accents = tm.moments.filter((m) => m.w >= 1.5 && Math.abs(m.t - tm.reveal) > beat).slice(0, 8).map((m) => r2(Math.round(m.t / (beat / 2)) * (beat / 2)));
  for (const a of accents) { pluck(L, a, M.root + 24 + scale[4], 1.4, 0.2); pluck(R, a, M.root + 24, 1.4, 0.2); }
  // Fade out over the last bar after the scene, then mix down.
  const fadeFrom = Math.round(D * SR), fadeN = len - fadeFrom;
  let peak = 0;
  for (let i = 0; i < len; i++) { if (i > fadeFrom) { const k = 1 - (i - fadeFrom) / fadeN; L[i] *= k; R[i] *= k; } peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
  // Loud enough to sit under a voice at the Studio's music level: an RMS target, with a soft limiter (tanh) catching
  // the impact and accents so the peak stays near -1 dBFS.
  let sum = 0;
  for (let i = 0; i < len; i++) sum += L[i] * L[i] + R[i] * R[i];
  const rms = Math.sqrt(sum / (2 * len)) || 1;
  const drive = Math.min(0.2 / rms, 4 / (peak || 1));
  const soft = (x) => 0.89 * Math.tanh((x * drive) / 0.89);
  for (let i = 0; i < len; i++) { L[i] = soft(L[i]); R[i] = soft(R[i]); }
  const g = 1;
  const wav = Buffer.alloc(44 + len * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + len * 4, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(len * 4, 40);
  for (let i = 0; i < len; i++) { wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4); wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4); }
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return { wav, bpm, key: `${names[M.root % 12]} ${M.scale}`, mood, accents, reveal: r2(revealT), sections: secs.map(r2), seconds: r2(len / SR) };
}
