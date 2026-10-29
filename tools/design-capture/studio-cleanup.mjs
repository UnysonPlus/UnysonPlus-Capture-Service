// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Clean up spoken footage, from the words and their times (speech recognition on this computer):
//   - false starts: a phrase said, broken off and said again ("build your own… build your own header") keeps the last;
//   - fillers: um, uh, er, erm, ah, hmm, when the recogniser writes them;
//   - long pauses: silences longer than maxPause shortened to keepPause;
// and renders the clip with those parts cut out, each cut with a short fade so it cannot click.
// bestTake() ranks several takes of the same line by the voice check (changed words, pauses inside a phrase).

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { transcribeFile, voiceCheck } from './studio-tools.mjs';

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm']);
const norm = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
const r3 = (x) => Math.round(x * 1000) / 1000;

const run = (args) => new Promise((ok, bad) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', bad);
  p.on('exit', (code) => (code === 0 ? ok() : bad(new Error(`ffmpeg stopped (${code}): ${err.trim().slice(-300)}`))));
});
const probe = (file) => new Promise((ok) => {
  const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('exit', () => { try { const j = JSON.parse(out); ok({ duration: +j.format.duration, video: (j.streams || []).some((s) => s.codec_type === 'video') }); } catch { ok({ duration: 0, video: false }); } });
});

/** Silent stretches in a file (ffmpeg silencedetect): [{ start, end }]. */
const silences = (file, min) => new Promise((ok) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `silencedetect=n=-38dB:d=${min}`, '-f', 'null', '-'], { windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', () => ok([]));
  p.on('exit', () => ok([...err.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)].map((m) => ({ start: +m[1], end: +m[2] }))));
});

/**
 * What to cut: [{ start, end, why }] in seconds of the file, from its words and its silences. Long pauses are found in
 * the sound itself: the recogniser stretches a word across the silence after it, so word times hide pauses.
 */
export function planCuts(words, { maxPause = 0.6, keepPause = 0.25, fillers = true, quiet = [] } = {}) {
  const ws = words.map((w) => ({ ...w, n: norm(w.w), end: w.t + (w.d || 0.2) })).filter((w) => w.n);
  const drop = new Set();
  const cuts = [];
  // False starts: the same 1-4 words twice in a row: the first time was broken off, the second is kept.
  for (let i = 0; i < ws.length; i++) {
    for (let k = 4; k >= 1; k--) {
      if (i + 2 * k > ws.length) continue;
      let same = true;
      for (let j = 0; j < k; j++) if (ws[i + j].n !== ws[i + k + j].n) { same = false; break; }
      if (same && !(k === 1 && ['that', 'had', 'very', 'really', 'so', 'no', 'yes'].includes(ws[i].n))) { // "that that", "very very" may be meant
        for (let j = 0; j < k; j++) drop.add(i + j);
        cuts.push({ start: ws[i].t, end: ws[i + k].t, why: `false start: "${ws.slice(i, i + k).map((w) => w.w).join(' ')}"` });
        i += k - 1;
        break;
      }
    }
  }
  if (fillers) ws.forEach((w, i) => { if (!drop.has(i) && FILLERS.has(w.n)) { drop.add(i); cuts.push({ start: w.t, end: w.end, why: `filler: "${w.w}"` }); } });
  // Long pauses: silent stretches in the sound between the first and the last word, shortened to keepPause.
  const first = ws.length ? ws[0].t : 0, last = ws.length ? ws[ws.length - 1].t : 0;
  for (const q of quiet) {
    const gap = q.end - q.start;
    if (gap > maxPause && q.end > first && q.start < last) cuts.push({ start: q.start + keepPause / 2, end: q.end - keepPause / 2, why: `pause of ${gap.toFixed(2)} s shortened to ${keepPause} s` });
  }
  // Merge overlapping cuts.
  cuts.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 0.02) { last.end = Math.max(last.end, c.end); last.why += `; ${c.why}`; } else merged.push({ ...c });
  }
  return merged.map((c) => ({ start: r3(c.start), end: r3(c.end), why: c.why }));
}

/** Cleans a spoken clip: plans the cuts from its words and renders the result (out), with an edit list beside it. */
export async function cleanupClip(file, opts = {}) {
  const src = resolve(file);
  if (!existsSync(src)) throw Object.assign(new Error(`No file at ${src}.`), { code: 400 });
  const { words } = await transcribeFile(src, { language: opts.language });
  if (!words.length) throw new Error('No speech found in that clip.');
  const info = await probe(src);
  const cuts = planCuts(words, { ...opts, quiet: await silences(src, opts.maxPause || 0.6) });
  // What stays: the clip minus the cuts.
  const keep = [];
  let at = 0;
  for (const c of cuts) { if (c.start > at + 0.02) keep.push({ start: r3(at), end: r3(c.start) }); at = Math.max(at, c.end); }
  if (info.duration > at + 0.02) keep.push({ start: r3(at), end: r3(info.duration) });
  const out = resolve(opts.out || join(dirname(src), `${basename(src, extname(src))}-clean${info.video ? '.mp4' : '.wav'}`));
  const F = 0.012; // a fade at each join: a cut mid-sound cannot click
  const parts = keep.map((k, i) => {
    const d = (k.end - k.start).toFixed(3);
    const a = `[0:a]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${F},afade=t=out:st=${Math.max(0, k.end - k.start - F).toFixed(3)}:d=${F}[a${i}]`;
    return info.video ? `[0:v]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}];${a}` : a;
  });
  const inputs = keep.map((_, i) => (info.video ? `[v${i}][a${i}]` : `[a${i}]`)).join('');
  const graph = `${parts.join(';')};${inputs}concat=n=${keep.length}:v=${info.video ? 1 : 0}:a=1${info.video ? '[v][a]' : '[a]'}`;
  await run(['-y', '-i', src, '-filter_complex', graph, ...(info.video ? ['-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] : ['-map', '[a]']), out]);
  const removed = cuts.reduce((s, c) => s + (c.end - c.start), 0);
  const edl = { source: src, out, before: r3(info.duration), after: r3(info.duration - removed), removed: r3(removed), cuts, keep };
  writeFileSync(out.replace(/\.[a-z0-9]+$/i, '.edl.json'), JSON.stringify(edl, null, 2));
  return edl;
}

/** Ranks takes of one line: fewest problems first (changed words, pauses inside a phrase), then the shortest pause. */
export async function bestTake(files, script, opts = {}) {
  const ranked = [];
  for (const f of files) {
    const r = await voiceCheck(resolve(f), script, opts);
    ranked.push({ file: resolve(f), ok: r.ok, problems: r.problems, heard: r.heard, longestGap: r.longestGap });
  }
  ranked.sort((a, b) => a.problems.length - b.problems.length || a.longestGap - b.longestGap);
  return ranked;
}
