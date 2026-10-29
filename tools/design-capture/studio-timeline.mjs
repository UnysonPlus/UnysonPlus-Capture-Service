// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// A timeline at a glance: one picture of a stretch of a scene, so an agent (or a person) sees timing without pulling
// dozens of frames: a strip of frames, the sound wave (voice and music apart), every spoken word at its time with the
// pauses inside phrases marked, and the words on screen as bars. Look at it to place cuts, captions and narration.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { sceneStills, transcribeFile } from './studio-tools.mjs';

const RATE = 2000; // audio samples per second for the wave (plenty for a picture)
const QUIET = 0.0126; // about -38 dB: below this the voice is silent

/** A clip's sound as mono samples (Float32Array), or null when it cannot be read. */
function decode(src, offset, seconds) {
  return new Promise((ok) => {
    const args = ['-hide_banner', '-loglevel', 'error', ...(offset > 0 ? ['-ss', String(offset)] : []), '-i', src, ...(seconds ? ['-t', String(seconds)] : []), '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'];
    const p = spawn('ffmpeg', args, { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', () => ok(null));
    p.on('exit', (code) => {
      if (code !== 0 || !chunks.length) return ok(null);
      const b = Buffer.concat(chunks);
      ok(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
  });
}

/** A file path ffmpeg and the recogniser can open, for a clip's src (relative paths are relative to the scene). */
function pathOf(src, base, tmp) {
  if (typeof src !== 'string' || !src || src.startsWith('sfx:') || src.startsWith('local:') || src.startsWith('blob:')) return null;
  if (src.startsWith('data:')) {
    const f = join(tmp, `clip-${Math.random().toString(36).slice(2)}.bin`);
    writeFileSync(f, Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'));
    return f;
  }
  if (/^https?:/.test(src)) return src;
  const f = resolve(base, src);
  return existsSync(f) ? f : null;
}

const transcripts = new Map();
async function wordsOf(file) {
  if (!transcripts.has(file)) transcripts.set(file, transcribeFile(file).then((r) => r.words).catch(() => []));
  return transcripts.get(file);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Draws the timeline of `scene` from `from` to `to` seconds into a PNG at `out`.
 * Returns { file, words, pauses: [{ t, seconds, after, before }] } (pauses: silences inside a phrase, longer than maxGap).
 */
export async function sceneTimeline(scene, opts = {}) {
  const base = scene.__base || process.cwd();
  const from = Math.max(0, Number(opts.from) || 0);
  const to = Math.min(scene.duration, Number(opts.to) || scene.duration);
  if (!(to > from)) throw Object.assign(new Error('Give a stretch of the scene: from must be before to.'), { code: 400 });
  const span = to - from;
  const frames = Math.max(3, Math.min(16, Number(opts.frames) || Math.round(Math.min(12, Math.max(6, span / 2.5)))));
  const maxGap = Number(opts.maxGap) || 0.4;
  const tmp = mkdtempSync(join(tmpdir(), 'upw-timeline-'));
  try {
    // 1. Frames, evenly across the stretch (the middle of each slice).
    const times = Array.from({ length: frames }, (_, i) => +(from + (span * (i + 0.5)) / frames).toFixed(2));
    const st = await sceneStills(scene, { times, out: join(tmp, 'frames'), width: 320, player: opts.player });
    const frameImgs = st.files.map((f) => ({ t: f.t, src: `data:image/jpeg;base64,${readFileSync(f.file).toString('base64')}` }));

    // 2. Sound: every clip decoded into the stretch, voice and the rest apart; 3. words from voice clips.
    const n = Math.ceil(span * RATE);
    const voice = new Float32Array(n), other = new Float32Array(n);
    const words = [], pauses = [];
    for (const a of scene.audio || []) {
      const file = pathOf(a.src, base, tmp);
      if (!file) continue;
      const start = a.start || 0, offset = a.offset || 0;
      const clipLen = typeof a.duration === 'number' ? a.duration : null;
      const clipEnd = clipLen != null ? start + clipLen : Infinity;
      if (clipEnd <= from || start >= to) continue;
      const skip = Math.max(0, from - start);
      const take = Math.min(to, clipEnd) - Math.max(from, start);
      const samples = await decode(file, offset + skip, isFinite(take) ? take : span);
      if (!samples) continue;
      const at = Math.round((Math.max(from, start) - from) * RATE);
      const target = a.role === 'voice' ? voice : other;
      const vol = a.volume ?? 1;
      for (let i = 0; i < samples.length && at + i < n; i++) target[at + i] += samples[i] * vol;
      if (a.role !== 'voice') continue;
      // Words: the clip's own transcript when the scene has it, else the recogniser's.
      const ws = Array.isArray(a.words) && a.words.length ? a.words : (/^https?:/.test(file) ? [] : await wordsOf(file));
      const placed = ws.map((w) => ({ w: w.w, t: start + w.t - offset, d: w.d || 0.2 })).filter((w) => w.t + w.d > from && w.t < to);
      words.push(...placed);
      // Pauses inside a phrase: silent runs in this clip between two words, where the SCRIPT has no punctuation. The
      // script is the subtitle on screen meanwhile; the recogniser's own punctuation is a guess, often caused by the
      // very pause ("page builder? Pro plan"), so it only counts (full stops) when there is no subtitle to go by.
      const own = await decode(file, offset, clipLen ?? undefined);
      if (!own) continue;
      const norm = (x) => String(x).toLowerCase().replace(/\+/g, 'plus').replace(/[^\p{L}\p{N}']+/gu, '');
      const script = [];
      const sub = (list, shift) => (list || []).forEach((l) => {
        if (l.type === 'group') return sub(l.layers, shift + (l.start || 0));
        if (l.type !== 'text' || typeof l.text !== 'string') return;
        const s = shift + (l.start ?? 0), e = shift + (l.end ?? scene.duration);
        if (e > start && s < (clipEnd === Infinity ? scene.duration : clipEnd) + 1) script.push(...l.text.split(/\s+/).map((raw) => ({ n: norm(raw), stop: /[.,;:!?…—–-]["')\]]*$/.test(raw) })).filter((x) => x.n));
      });
      sub(scene.layers, 0);
      const stopAfter = (A, B) => {
        const a = norm(A.w), b = norm(B.w);
        for (let i = 0; i + 1 < script.length; i++) if (script[i].n === a && script[i + 1].n === b) return script[i].stop;
        // Glued or split by the recogniser ("Unison Plus"): the script word that starts with this word.
        for (let i = 0; i + 1 < script.length; i++) if (script[i].n.startsWith(a) && script[i + 1].n.startsWith(b)) return script[i].stop;
        return /[.!…]$/.test(A.w);
      };
      for (let j = 0; j + 1 < placed.length; j++) {
        const A = placed[j], B = placed[j + 1];
        if (stopAfter(A, B)) continue;
        let run = 0, best = 0, bestAt = 0;
        // own[i] is scene time start + i / RATE (it was decoded from the clip's offset).
        const i0 = Math.max(0, Math.round((A.t - start) * RATE)), i1 = Math.min(own.length, Math.round((B.t - start) * RATE));
        for (let i = i0; i < i1; i++) {
          if (Math.abs(own[i]) < QUIET) { run++; if (run > best) { best = run; bestAt = i - run + 1; } } else run = 0;
        }
        const secs = best / RATE;
        if (secs > maxGap) pauses.push({ t: +(start + bestAt / RATE).toFixed(2), seconds: +secs.toFixed(2), after: A.w, before: B.w });
      }
    }

    // 4. Words on screen: text layers (and captions) as bars.
    const onScreen = [];
    const walk = (list, shift) => (list || []).forEach((l) => {
      if (l.type === 'group') return walk(l.layers, shift + (l.start || 0));
      if (l.type !== 'text' || typeof l.text !== 'string') return;
      const s = shift + (l.start ?? 0), e = shift + (l.end ?? scene.duration);
      if (e > from && s < to) onScreen.push({ s: Math.max(s, from), e: Math.min(e, to), text: l.text.replace(/\s+/g, ' ') });
    });
    walk(scene.layers, 0);
    onScreen.sort((a, b) => a.s - b.s);
    const lanes = [];
    for (const b of onScreen) { let k = lanes.findIndex((end) => end <= b.s + 0.05); if (k < 0) { k = lanes.length; lanes.push(0); } lanes[k] = b.e; b.lane = k; }

    // The wave as peaks per pixel.
    const W = 1600, PAD = 16, inner = W - PAD * 2;
    const peaks = (buf) => Array.from({ length: inner }, (_, x) => {
      const a = Math.floor((x * n) / inner), b = Math.max(a + 1, Math.floor(((x + 1) * n) / inner));
      let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(buf[i] || 0)); return Math.min(1, m);
    });
    const X = (t) => PAD + ((t - from) / span) * inner;
    const tick = span <= 12 ? 1 : span <= 40 ? 2 : span <= 90 ? 5 : 10;
    const ticks = []; for (let t = Math.ceil(from / tick) * tick; t <= to + 1e-6; t += tick) ticks.push(t);
    // Words in rows, so labels never overlap.
    const wordRows = []; const wordEls = [];
    for (const w of words.sort((a, b) => a.t - b.t)) {
      const x = X(Math.max(from, w.t)), width = Math.max(7.2 * w.w.length + 6, ((w.d) / span) * inner);
      let r = wordRows.findIndex((end) => end <= x - 2); if (r < 0) { r = wordRows.length; wordRows.push(0); } wordRows[r] = x + width;
      wordEls.push(`<div class="w" style="left:${x}px;top:${r * 20}px">${esc(w.w)}</div>`);
    }
    const frameW = inner / frames;
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#101114;color:#e8e8ea;font:12px/1.2 system-ui,Segoe UI,sans-serif;width:${W}px}
      .row{position:relative;margin:0 ${PAD}px} h4{margin:10px ${PAD}px 4px;font:600 11px system-ui;letter-spacing:.06em;text-transform:uppercase;color:#8a8f99}
      .frames{display:flex;gap:2px;margin:${PAD}px ${PAD}px 0} .frames div{flex:1;position:relative} .frames img{width:100%;display:block;max-height:300px;object-fit:cover;border-radius:3px}
      .frames span{position:absolute;left:4px;top:4px;background:#000a;padding:1px 5px;border-radius:3px;font-size:11px}
      canvas{display:block} .w{position:absolute;white-space:nowrap;background:#20242c;border-left:2px solid #5aa9ff;padding:1px 4px;font-size:12px;height:16px}
      .bar{position:absolute;height:16px;background:#2b3a2f;border:1px solid #4caf7a;border-radius:3px;overflow:hidden;white-space:nowrap;font-size:11px;padding:1px 4px;box-sizing:border-box}
      .pause{position:absolute;top:0;bottom:0;background:#ff4d4d33;border-left:2px solid #ff4d4d;border-right:2px solid #ff4d4d}
      .pause b{position:absolute;bottom:2px;left:3px;color:#ff8080;font-size:11px}
      .tick{position:absolute;top:0;bottom:0;border-left:1px solid #ffffff14} .tick i{position:absolute;top:-14px;left:2px;font-style:normal;color:#8a8f99;font-size:10px}
      .legend{margin:8px ${PAD}px ${PAD}px;color:#8a8f99} .legend em{font-style:normal;padding:0 6px}
    </style>
    <div class="frames">${frameImgs.map((f) => `<div><img src="${f.src}"><span>${f.t.toFixed(1)}s</span></div>`).join('')}</div>
    <h4>Sound · voice (blue) · music and effects (grey)</h4>
    <div class="row" style="height:90px;margin-top:18px"><canvas id="wave" width="${inner}" height="90"></canvas>
      ${pauses.map((p) => `<div class="pause" style="left:${X(p.t) - PAD}px;width:${Math.max(3, (p.seconds / span) * inner)}px"><b>${p.seconds}s</b></div>`).join('')}
      ${ticks.map((t) => `<div class="tick" style="left:${X(t) - PAD}px"><i>${t}s</i></div>`).join('')}</div>
    <h4>Spoken words${pauses.length ? ` · <span style="color:#ff8080">${pauses.length} pause(s) inside a phrase</span>` : ''}</h4>
    <div class="row" style="height:${Math.max(1, wordRows.length) * 20 + 4}px">${wordEls.map((e) => e.replace(/left:([\d.]+)px/, (_, v) => `left:${v - PAD}px`)).join('')}${words.length ? '' : '<span style="color:#8a8f99">(no voice-over)</span>'}</div>
    <h4>On screen (text layers)</h4>
    <div class="row" style="height:${Math.max(1, lanes.length) * 20 + 4}px">${onScreen.map((b) => `<div class="bar" style="left:${X(b.s) - PAD}px;width:${Math.max(4, X(b.e) - X(b.s))}px;top:${b.lane * 20}px" title="${esc(b.text)}">${esc(b.text)}</div>`).join('')}</div>
    <div class="legend">${esc(scene.title || 'Scene')} · ${from.toFixed(1)}–${to.toFixed(1)} s<em>red: a silence longer than ${maxGap} s inside a phrase (sounds machine-made)</em></div>
    <script>
      const v=${JSON.stringify(peaks(voice).map((x) => +x.toFixed(3)))}, o=${JSON.stringify(peaks(other).map((x) => +x.toFixed(3)))};
      const c=document.getElementById('wave').getContext('2d'), h=90, mid=h/2;
      const draw=(p,col)=>{c.fillStyle=col;p.forEach((m,x)=>{const y=Math.max(1,m*mid);c.fillRect(x,mid-y,1,y*2);});};
      draw(o,'#6b6f78'); draw(v,'#5aa9ff');
    </script>`;
    const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: W, height: 600 }, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'load' });
      const out = resolve(opts.out || 'timeline.png');
      await page.screenshot({ path: out, fullPage: true });
      return { file: out, from, to, words: words.length, pauses, onScreen: onScreen.length };
    } finally { await browser.close(); }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const timelineDir = (sceneFile) => dirname(resolve(sceneFile));
