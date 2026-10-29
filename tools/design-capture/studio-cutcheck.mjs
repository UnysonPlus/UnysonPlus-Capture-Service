// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Every cut checked: after a render, the video itself is inspected the way a careful editor would before showing it.
//   - cuts (picture changes), counted (clicks at cuts are prevented by the renderer's 12 ms fades, not measured);
//   - black frames that were not meant (a layer that failed to load leaves the stage empty);
//   - the narration: every voice line of the scene is heard in the finished video, at about its time
//     (a wrong file path once dropped every line silently);
//   - loudness: about -14 LUFS for social, and no clipping (true peak above -1 dBTP).
// Returns problems to fix and re-render, or ok.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { transcribeFile } from './studio-tools.mjs';

const ff = (args) => new Promise((ok) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-nostats', ...args], { windowsHide: true });
  let err = '';
  const out = [];
  p.stderr.on('data', (d) => { err += d; });
  p.stdout.on('data', (d) => out.push(d));
  p.on('error', () => ok({ err, out: Buffer.alloc(0) }));
  p.on('exit', () => ok({ err, out: Buffer.concat(out) }));
});

const norm = (x) => String(x).toLowerCase().replace(/\+/g, 'plus').replace(/[^\p{L}\p{N}']+/gu, '');

/** Problems in a rendered video. `scene` (optional) lets the narration and the sound clip edges be checked too. */
export async function cutCheck(videoFile, scene = null, opts = {}) {
  const file = resolve(videoFile);
  if (!existsSync(file)) throw Object.assign(new Error(`No video at ${file}.`), { code: 400 });
  const issues = [];
  const add = (kind, t, text, severity = 'warn') => issues.push({ kind, t: t == null ? null : +(+t).toFixed(2), severity, text });

  // Picture: cuts and unintended black.
  const pic = await ff(['-i', file, '-an', '-vf', 'select=gt(scene\\,0.32),metadata=print,blackdetect=d=0.12:pix_th=0.06', '-f', 'null', '-']);
  const cuts = [...pic.err.matchAll(/pts_time:([\d.]+)/g)].map((m) => +m[1]);
  for (const m of pic.err.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
    const s = +m[1], d = +m[3];
    if (s < 0.05) continue; // a scene may open on black
    add('black', s, `${d.toFixed(2)} s of black picture at ${s.toFixed(2)} s: a layer may have failed to load, or a gap between scenes.`);
  }

  // Clicks are not measured here: from the finished sound a drum hit or an "s" looks the same as a click. They are
  // prevented where they start instead: the renderer fades every sound clip in and out by at least 12 ms, so a clip cut
  // mid-sound cannot click (studio-render.mjs, audioMix).

  // Loudness and clipping.
  const loud = await ff(['-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const I = +(/I:\s+(-?[\d.]+) LUFS/.exec(loud.err.split('Summary:').pop() || '') || [])[1];
  const peak = +(/Peak:\s+(-?[\d.]+) dBFS/.exec(loud.err.split('Summary:').pop() || '') || [])[1];
  if (Number.isFinite(I)) {
    if (I < -20 || I > -10) add('loudness', null, `The video is ${I.toFixed(1)} LUFS; about -14 suits social video (raise or lower the music and voice).`, 'info');
    if (Number.isFinite(peak) && peak > -1) add('clipping', null, `The sound peaks at ${peak.toFixed(1)} dBTP and may distort on phones: keep it under -1 (lower the loudest clip).`);
  }

  // Narration: every voice line of the scene is heard in the video, at about its time.
  let narration = null;
  if (scene && (scene.audio || []).some((a) => a.role === 'voice') && opts.narration !== false) {
    const heard = (await transcribeFile(file).catch(() => ({ words: [] }))).words || [];
    narration = { lines: 0, missing: 0 };
    // Only words that fall inside the video are expected (a short test render, or a scene longer than its cut).
    const probe = await ff(['-i', file]);
    const dm = /Duration:\s+(\d+):(\d+):([\d.]+)/.exec(probe.err);
    const videoLen = dm ? +dm[1] * 3600 + +dm[2] * 60 + +dm[3] : Infinity;
    const base = scene.__base || process.cwd();
    for (const a of (scene.audio || []).filter((x) => x.role === 'voice')) {
      narration.lines++;
      let words = Array.isArray(a.words) && a.words.length ? a.words : null;
      if (!words) {
        const src = typeof a.src === 'string' && !/^(data:|https?:|sfx:|local:|blob:)/.test(a.src) ? resolve(base, a.src) : null;
        words = src && existsSync(src) ? ((await transcribeFile(src).catch(() => ({ words: [] }))).words || []) : [];
      }
      if (!words.length) continue;
      const expect = words.map((w) => ({ n: norm(w.w), t: (a.start || 0) + w.t - (a.offset || 0) })).filter((w) => w.n && w.t < videoLen - 0.3);
      if (expect.length < 2) { narration.lines--; continue; }
      // Matched in order, inside the line's own time (with room for the recogniser's timing drift).
      const t0 = expect[0].t - 2, t1 = expect[expect.length - 1].t + 3;
      const pool = heard.filter((h) => h.t >= t0 && h.t <= t1).map((h) => norm(h.w)).filter(Boolean);
      const same = (h, w) => h === w || h.startsWith(w) || w.startsWith(h);
      const found = [];
      let from = 0;
      for (const w of expect) { const i = pool.findIndex((h, j) => j >= from && same(h, w.n)); if (i >= 0) { found.push(w); from = i + 1; } }
      const share = found.length / expect.length;
      if (share < 0.6) {
        narration.missing++;
        add('narration', expect[0].t, `The voice line at ${expect[0].t.toFixed(2)} s ("${words.slice(0, 6).map((w) => w.w).join(' ')}…") is ${share === 0 ? 'not heard' : `only ${Math.round(share * 100)} % heard`} in the video: check its file and its volume.`);
      }
    }
  }

  return {
    ok: !issues.some((i) => i.severity === 'warn'),
    file, cuts: cuts.map((t) => +t.toFixed(2)), loudness: Number.isFinite(I) ? I : null, truePeak: Number.isFinite(peak) ? peak : null,
    narration, issues: issues.sort((x, y) => (x.t ?? 1e9) - (y.t ?? 1e9)),
  };
}
