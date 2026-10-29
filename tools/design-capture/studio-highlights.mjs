// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// "Make a reel from this video": a long video watched second by second, the moments worth keeping found, and a cut of
// the length asked for built from them. What counts (each scored 0-1, then weighed):
//   - sharp:    detail in the picture (the mean edge strength), so blurry and out-of-focus stretches lose;
//   - steady:   little change from one sampled moment to the next inside a shot (a shaky or panning camera loses);
//   - exposed:  neither dark nor blown out;
//   - talked:   words being said (when speech recognition is installed), so the cut keeps what is talked about.
// Shots come from ffmpeg's scene detection; a chosen stretch never crosses a cut. Stretches are picked best first,
// kept apart, then put back in the order they happened. With music, each stretch's length lands on a beat. Every
// chosen stretch becomes an ordinary footage clip in the scene (hard cuts on the beat, each with a slow push-in): swap,
// trim or move it like any other. Titles come from the words and are a first draft to edit.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE || 'ffprobe';
const r2 = (x) => Math.round(x * 100) / 100;

function run(cmd, args, { binary = false } = {}) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-200000); });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok({ out: binary ? Buffer.concat(out) : Buffer.concat(out).toString(), err }) : bad(new Error(`${basename(cmd)} failed: ${err.trim().split('\n').slice(-2).join(' ')}`))));
  });
}

/** The cuts in a video (seconds), from ffmpeg's scene detection. */
export async function findCuts(file, threshold = 0.3) {
  const { err } = await run(FFMPEG(), ['-hide_banner', '-i', file, '-an', '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-']);
  return [...err.matchAll(/pts_time:([\d.]+)/g)].map((m) => r2(Number(m[1])));
}

/** One score per second: { t, sharp, steady, exposed } (0-1 each), from small grey frames. */
async function lookAt(file, seconds) {
  const W = 96, H = 54;
  const { out } = await run(FFMPEG(), ['-v', 'error', '-i', file, '-an', '-vf', `fps=2,scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { binary: true });
  const n = Math.floor(out.length / (W * H));
  const frames = Array.from({ length: n }, (_, i) => out.subarray(i * W * H, (i + 1) * W * H));
  const per = [];
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    let edge = 0, sum = 0, diff = 0;
    for (let y = 1; y < H; y++) for (let x = 1; x < W; x++) { const p = f[y * W + x]; edge += Math.abs(p - f[y * W + x - 1]) + Math.abs(p - f[(y - 1) * W + x]); sum += p; }
    if (i > 0) for (let k = 0; k < W * H; k++) diff += Math.abs(f[k] - frames[i - 1][k]);
    per.push({ edge: edge / (W * H), mean: sum / (W * H), diff: i > 0 ? diff / (W * H) : 0 });
  }
  // Relative to this video: its own sharpest and calmest moments set the scale.
  const edges = per.map((p) => p.edge).sort((a, b) => a - b), top = edges[Math.floor(edges.length * 0.9)] || 1;
  const out2 = [];
  for (let s = 0; s < Math.ceil(seconds); s++) {
    const a = per.slice(s * 2, s * 2 + 2);
    if (!a.length) break;
    const edge = a.reduce((x, p) => x + p.edge, 0) / a.length, mean = a.reduce((x, p) => x + p.mean, 0) / a.length, diff = a.reduce((x, p) => x + p.diff, 0) / a.length;
    out2.push({ t: s, sharp: Math.min(1, edge / top), steady: Math.max(0, 1 - diff / 30), exposed: Math.max(0, 1 - Math.abs(mean - 120) / 110) });
  }
  return out2;
}

// Small words a title should not end on.
const TAIL = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'with', 'in', 'on', 'of', 'to', 'for', 'from', 'at', 'by', 'is', 'are', 'your', 'our', 'my', 'this', 'that', 'it']);

/** A short title from what is said: the first phrase (up to the first pause in punctuation), at most six words, never ending on a small word. */
function titleFrom(said) {
  if (!said) return '';
  const phrase = said.split(/(?<=[,.;:!?])\s/)[0];
  let w = (phrase.split(' ').length >= 3 ? phrase : said).split(' ').slice(0, 6).map((x) => x.replace(/[,.;:!?"]+$/, ''));
  while (w.length > 2 && TAIL.has(w[w.length - 1].toLowerCase())) w = w.slice(0, -1);
  const t = w.join(' ');
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

/**
 * Finds the moments worth keeping: { file, length (seconds wanted), part? (seconds per stretch, default 3), words?
 * ([{ w, t, d }], the video's speech), beats? (music beat times, for stretch lengths on the beat) } →
 * { parts: [{ from, to, score, why, title }], cuts, seconds }.
 */
export async function findHighlights({ file, length = 30, part = 3, words = null, beats = null, onStep }) {
  if (!existsSync(file)) throw Object.assign(new Error(`No file at ${file}.`), { code: 400 });
  const probe = JSON.parse((await run(FFPROBE(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file])).out);
  const seconds = Number(probe.format?.duration) || 0;
  if (seconds < length) throw Object.assign(new Error(`The video is ${Math.round(seconds)} s long, shorter than the ${length} s reel asked for.`), { code: 400 });
  onStep?.('Finding the cuts');
  const cuts = await findCuts(file);
  onStep?.('Watching the video');
  const look = await lookAt(file, seconds);
  const talk = new Array(look.length).fill(0);
  for (const w of words ?? []) { const s = Math.floor(w.t); if (s < talk.length) talk[s] = 1; }
  const hasWords = !!words?.length;
  const score = look.map((m, s) => 0.4 * m.sharp + 0.3 * m.steady + 0.1 * m.exposed + (hasWords ? 0.2 * talk[s] : 0.2 * m.sharp));

  // Stretch lengths: on the music's beat when there is music (the nearest whole number of beats to `part`).
  const beat = beats?.length > 2 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0;
  const len = beat ? Math.max(beat * 2, Math.round(part / beat) * beat) : part;
  const want = Math.max(1, Math.round(length / len));
  const bounds = [0, ...cuts, seconds];
  const shotOf = (t) => { let i = 0; while (i + 1 < bounds.length && bounds[i + 1] <= t) i++; return [bounds[i], bounds[i + 1] ?? seconds]; };

  // Every possible stretch (starting each half second) inside one shot, skipping the first and last half second of the
  // shot (a cut's blur), scored by its average.
  const cands = [];
  for (let t = 0.5; t + len <= seconds - 0.25; t += 0.5) {
    const [a, b] = shotOf(t);
    if (t < a + 0.4 || t + len > b - 0.4) continue;
    const s0 = Math.floor(t), s1 = Math.min(score.length, Math.ceil(t + len));
    const avg = score.slice(s0, s1).reduce((x, y) => x + y, 0) / Math.max(1, s1 - s0);
    cands.push({ from: t, to: t + len, score: avg, s0, s1 });
  }
  // Not enough long shots: allow stretches across a cut rather than return too few.
  if (cands.length < want) for (let t = 0; t + len <= seconds; t += len) cands.push({ from: t, to: t + len, score: 0, s0: Math.floor(t), s1: Math.ceil(t + len) });
  cands.sort((a, b) => b.score - a.score);
  // Best first, at least one stretch apart, and spread across the video (no more than a third from any one tenth).
  const picked = [];
  const tenth = seconds / 10, perTenth = Math.max(1, Math.ceil(want / 3));
  for (const c of cands) {
    if (picked.length >= want) break;
    if (picked.some((p) => c.from < p.to + len && c.to > p.from - len)) continue;
    if (picked.filter((p) => Math.floor(p.from / tenth) === Math.floor(c.from / tenth)).length >= perTenth) continue;
    picked.push(c);
  }
  // A short video can't keep every rule: fill what is left with the best stretches that don't overlap.
  for (const c of cands) {
    if (picked.length >= want) break;
    if (!picked.some((p) => c.from < p.to && c.to > p.from)) picked.push(c);
  }
  picked.sort((a, b) => a.from - b.from);

  const parts = picked.map((c) => {
    const m = look.slice(c.s0, c.s1), avg = (k) => m.reduce((x, y) => x + y[k], 0) / Math.max(1, m.length);
    const why = [avg('sharp') > 0.7 && 'sharp', avg('steady') > 0.7 && 'steady', avg('exposed') > 0.7 && 'well lit', hasWords && talk.slice(c.s0, c.s1).some(Boolean) && 'talked about'].filter(Boolean);
    const said = (words ?? []).filter((w) => w.t >= c.from && w.t < c.to).map((w) => w.w.trim()).join(' ').replace(/\s+/g, ' ');
    const title = titleFrom(said);
    return { from: r2(c.from), to: r2(c.to), score: r2(c.score), why: why.join(', ') || 'the best of what is there', title };
  });
  return { parts, cuts, seconds: r2(seconds) };
}

/**
 * A scene from the parts: the footage back to back (each an ordinary clip), a title on each part when it has one, the
 * music under it at 25%. format: 9x16 | 1x1 | 4x5 | 16x9. src: the footage as the scene should name it.
 */
export function highlightScene({ parts, src, title = 'Highlights', format = '9x16', music = null, titles = true }) {
  const aspect = { '9x16': [9, 16], '1x1': [1, 1], '4x5': [4, 5], '16x9': [16, 9] }[format] || [9, 16];
  let at = 0;
  const layers = [], titleLayers = [];
  parts.forEach((p, i) => {
    const len = r2(p.to - p.from);
    layers.push({ id: `part-${i + 1}`, name: `Part ${i + 1} (${p.from}-${p.to} s: ${p.why})`, type: 'video', src, fit: 'cover', box: { x: 50, y: 50, w: 100, h: 100 }, start: r2(at), end: r2(at + len), offset: p.from, sound: 1, clips: [{ id: `push-${i + 1}`, preset: 'keyframes', start: r2(at), duration: len, ease: 'none', params: { frames: [{ t: 0, scale: 1 }, { t: len, scale: 1.06 }] } }] });
    if (titles && p.title) titleLayers.push({ id: `title-${i + 1}`, name: `Title ${i + 1}`, type: 'text', text: p.title, box: { x: 50, y: 14, w: 86 }, start: r2(at + 0.2), end: r2(at + len - 0.1), style: { fontSize: 5.5, fontWeight: 800, color: '#ffffff', textAlign: 'center', shadow: '0 2px 12px rgba(0,0,0,.6)' }, clips: [{ id: `t-in-${i + 1}`, preset: i % 2 ? 'pop' : 'text-rise', start: r2(at + 0.2), duration: 0.5 }] });
    at += len;
  });
  const duration = r2(at);
  return {
    format: 'unysonplus-scene', version: 1, title, duration, mode: 'video',
    video: { formats: [format], fps: 30, platform: format === '16x9' ? 'youtube' : 'shorts' },
    stage: { breakpoints: [{ id: format, label: format.replace('x', ':'), minWidth: 0, aspect }], heightMode: 'fill', background: '#000000', fonts: [] },
    playback: { trigger: 'load', loop: false },
    layers: [...layers, ...titleLayers],
    audio: music ? [{ id: 'music', name: 'Music', role: 'music', src: music, start: 0, volume: 0.25 }] : [],
  };
}

/**
 * For the Studio: { src (the video as a data: URL), length?, part?, words? (true: transcribe it if speech recognition
 * is installed), beats? (the music's beat times), format?, title?, titles? } → { parts, cuts, seconds, spoken, scene }; the
 * scene names the footage "{{footage}}" for the Studio to replace with its own copy.
 */
export async function highlightsFromData(body = {}) {
  if (typeof body.src !== 'string' || !/^data:video\//.test(body.src)) throw Object.assign(new Error('Send the video (a data: URL).'), { code: 400 });
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'upw-hl-'));
  try {
    const file = join(dir, 'in.mp4');
    writeFileSync(file, Buffer.from(body.src.slice(body.src.indexOf(',') + 1), 'base64'));
    let words = null;
    if (body.words !== false) {
      try {
        const mp3 = join(dir, 'speech.mp3');
        await run(FFMPEG(), ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3]);
        words = (await (await import('./studio-tools.mjs')).transcribeFile(mp3)).words;
      } catch { words = null; /* no speech recognition, or no sound: the picture alone decides */ }
    }
    const r = await findHighlights({ file, length: Number(body.length) || 30, part: Number(body.part) || 3, words, beats: Array.isArray(body.beats) ? body.beats : null });
    const scene = highlightScene({ parts: r.parts, src: '{{footage}}', title: body.title || 'Highlights', format: body.format || '9x16', titles: body.titles !== false });
    return { ...r, spoken: !!words?.length, scene };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
