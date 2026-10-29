// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// "Learn the rhythm of a reel": a finished reference video (a reel that works, or the client's own best one) read for
// its pacing, so a new scene can be cut the same way. What comes out:
//   - every cut (ffmpeg's scene detection) and the shots between them, with their lengths;
//   - the pace: shot-length statistics, cuts per 10 seconds, and how the pace changes over the reel (per 5 s window);
//   - 3-8 sections at real cuts (hook, middle beats, ending), each snapped to the cut nearest an even split;
//   - a contact sheet: one frame from the middle of each shot, numbered in order, to read the visual flow at a glance.
// The timing map can be stretched to a new length (fitRhythm) and put on a scene as markers (rhythmMarkers), which
// the Studio and the agent use to place each clip. Nothing is copied from the reference except its timing.

import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { findCuts } from './studio-highlights.mjs';

const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE || 'ffprobe';
const r2 = (x) => Math.round(x * 100) / 100;

function run(cmd, args) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok(out) : bad(new Error(`${basename(cmd)} failed: ${err.trim().split('\n').slice(-2).join(' ')}`))));
  });
}

async function probe(file) {
  const j = JSON.parse(await run(FFPROBE(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]));
  return { duration: r2(Number(j.format?.duration) || 0), width: j.streams?.[0]?.width || 0, height: j.streams?.[0]?.height || 0 };
}

/**
 * Motion peaks: the moments the picture changes most (a reveal, a wipe, a transition), which in motion graphics carry
 * the rhythm far more often than hard cuts do. Small grey frames at 10 per second; the change between neighbours is
 * smoothed, and a peak counts when it stands well above the reel's own typical change. Peaks are at least 0.5 s apart.
 */
async function motionPeaks(file, duration) {
  const W = 64, H = 36, FPS = 10;
  const raw = await new Promise((ok, bad) => {
    const p = spawn(FFMPEG(), ['-v', 'error', '-i', file, '-an', '-vf', `fps=${FPS},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok(Buffer.concat(out)) : bad(new Error('ffmpeg could not read the frames'))));
  });
  const n = Math.floor(raw.length / (W * H));
  const diff = [0];
  for (let i = 1; i < n; i++) {
    let d = 0;
    for (let k = 0; k < W * H; k++) d += Math.abs(raw[i * W * H + k] - raw[(i - 1) * W * H + k]);
    diff.push(d / (W * H));
  }
  const smooth = diff.map((_, i) => (diff[i - 1] ?? diff[i]) * 0.25 + diff[i] * 0.5 + (diff[i + 1] ?? diff[i]) * 0.25);
  const typical = median(smooth), floor = Math.max(typical * 2.2, typical + 4);
  const peaks = [];
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] < floor || smooth[i] < smooth[i - 1] || smooth[i] < smooth[i + 1]) continue;
    const t = r2(i / FPS);
    if (t < 0.2 || t > duration - 0.2) continue;
    const last = peaks[peaks.length - 1];
    if (last && t - last.t < 0.5) { if (smooth[i] > last.strength) peaks[peaks.length - 1] = { t, strength: smooth[i] }; continue; }
    peaks.push({ t, strength: smooth[i] });
  }
  const top = Math.max(1, ...peaks.map((p) => p.strength));
  return peaks.map((p) => ({ t: p.t, strength: r2(p.strength / top) }));
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

/** Sections at real cuts: about one per 4.5 s (3-8), each boundary snapped to the cut nearest an even split. */
export function planSections(duration, cuts) {
  const count = Math.max(3, Math.min(8, Math.round(duration / 4.5)));
  const bounds = [0];
  for (let i = 1; i < count; i++) {
    const ideal = (duration * i) / count, prev = bounds[bounds.length - 1], reach = (duration / count) * 0.45;
    const near = cuts.filter((c) => c > prev + 1 && c < duration - 1 && Math.abs(c - ideal) < reach).sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal));
    const at = near[0] ?? ideal;
    if (at > prev + 0.5) bounds.push(r2(at));
  }
  const names = (n) => (i) => (i === 0 ? 'hook' : i === n - 1 ? 'ending' : `beat ${i}`);
  const name = names(bounds.length);
  return bounds.map((from, i) => ({ name: name(i), from, to: r2(bounds[i + 1] ?? duration), cuts: cuts.filter((c) => c > from && c < (bounds[i + 1] ?? duration)).length }));
}

/**
 * Read a reference video's rhythm. Options: threshold (scene-change sensitivity, 0-1, default 0.2: lower finds softer
 * cuts), sheet (a path for the contact sheet JPEG, or null for none), onStep (progress messages).
 */
export async function analyseReference(file, { threshold = 0.2, sheet = null, onStep = () => {} } = {}) {
  onStep('Reading the video');
  const info = await probe(file);
  if (!info.duration) throw new Error(`No video found in ${file}`);
  onStep('Finding the cuts');
  const cuts = (await findCuts(file, threshold)).filter((c) => c > 0.15 && c < info.duration - 0.15)
    .filter((c, i, all) => i === 0 || c - all[i - 1] >= 0.25); // one cut seen on two neighbouring frames counts once
  const edges = [0, ...cuts, info.duration];
  const shots = edges.slice(0, -1).map((from, i) => ({ n: i + 1, from: r2(from), to: r2(edges[i + 1]), length: r2(edges[i + 1] - from) }));
  onStep('Finding the moments of change');
  const peaks = await motionPeaks(file, info.duration);
  // The rhythm: every cut, plus every motion peak that is not just a cut seen twice.
  const moments = [...cuts.map((t) => ({ t, kind: 'cut' })), ...peaks.filter((p) => !cuts.some((c) => Math.abs(c - p.t) < 0.35)).map((p) => ({ t: p.t, kind: 'motion', strength: p.strength }))].sort((a, b) => a.t - b.t);
  const times = moments.map((m) => m.t);
  const gaps = [0, ...times, info.duration].slice(1).map((t, i, all) => r2(t - (i ? all[i - 1] : 0)));
  const lengths = shots.map((s) => s.length);
  const stats = {
    shots: shots.length,
    cuts: cuts.length,
    moments: moments.length,
    beatEvery: r2(info.duration / (moments.length + 1)),
    beatMedian: r2(median(gaps)),
    shortestBeat: r2(Math.min(...gaps)),
    longestBeat: r2(Math.max(...gaps)),
    momentsPer10s: r2((moments.length / info.duration) * 10),
    shotAverage: r2(info.duration / shots.length),
    shotMedian: r2(median(lengths)),
  };
  const pace = [];
  for (let from = 0; from < info.duration; from += 5) {
    const to = Math.min(info.duration, from + 5);
    pace.push({ from, to: r2(to), moments: times.filter((c) => c >= from && c < to).length, cuts: cuts.filter((c) => c >= from && c < to).length });
  }
  const sections = planSections(info.duration, times);
  const map = { kind: 'kinetic-reference', version: 1, source: basename(file), ...info, threshold, cuts, moments, shots, stats, pace, sections, summary: describe(info.duration, stats, pace) };
  if (sheet) {
    onStep('Making the contact sheet');
    await contactSheet(file, shots, sheet, info);
    map.sheet = sheet;
  }
  return map;
}

/** A plain-words reading of the pace, for the agent and the person. */
function describe(duration, stats, pace) {
  const feel = stats.beatEvery < 1.2 ? 'very fast' : stats.beatEvery < 2 ? 'fast' : stats.beatEvery < 3.5 ? 'steady' : 'slow';
  const first = pace[0]?.moments ?? 0, rest = pace.slice(1);
  const later = rest.length ? rest.reduce((s, p) => s + p.moments, 0) / rest.length : first;
  const shape = first > later * 1.4 ? 'opens faster than it continues (a quick hook, then calmer)' : later > first * 1.4 ? 'starts calm and speeds up' : 'keeps an even pace';
  return `${stats.moments} moments of change in ${duration} s (${stats.cuts} hard cut(s), ${stats.moments - stats.cuts} reveal(s) or transition(s)): ${feel}, ` +
    `something new every ${stats.beatEvery} s on average (median ${stats.beatMedian} s, ${stats.momentsPer10s} per 10 s). It ${shape}.`;
}

/** One frame from the middle of each shot, tiled in order (up to 40 shots), each numbered. */
async function contactSheet(file, shots, out, info) {
  const picked = shots.length > 40 ? shots.filter((_, i) => i % Math.ceil(shots.length / 40) === 0) : shots;
  const cols = Math.min(picked.length, info.height > info.width ? 8 : 5);
  const rows = Math.ceil(picked.length / cols);
  const tw = info.height > info.width ? 180 : 320;
  const select = picked.map((s) => `lt(prev_t\\,${r2((s.from + s.to) / 2)})*gte(t\\,${r2((s.from + s.to) / 2)})`).join('+');
  const label = "drawtext=text='%{n}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6:start_number=1";
  await run(FFMPEG(), ['-v', 'error', '-y', '-i', file, '-an', '-vf', `select='${select}',scale=${tw}:-2,${label},tile=${cols}x${rows}:padding=6:margin=6:color=white`, '-frames:v', '1', '-fps_mode', 'vfr', out]);
}

/** The same rhythm at another length: every cut and section moved in proportion (a 30 s reference fitted to 20 s). */
export function fitRhythm(map, seconds) {
  const k = seconds / map.duration;
  const s = (t) => r2(t * k);
  return {
    ...map,
    fittedFrom: map.duration,
    duration: r2(seconds),
    cuts: map.cuts.map(s),
    moments: (map.moments || []).map((m) => ({ ...m, t: s(m.t) })),
    shots: map.shots.map((x) => ({ ...x, from: s(x.from), to: s(x.to), length: s(x.length) })),
    sections: map.sections.map((x) => ({ ...x, from: s(x.from), to: s(x.to) })),
  };
}

/**
 * Put the rhythm on a scene as markers (ids "r1", "r2"…, labelled "beat 3" or the section's name), fitted to the
 * scene's own length. Earlier rhythm markers are replaced; other markers are kept.
 */
export function rhythmMarkers(scene, map, { sectionsOnly = false } = {}) {
  const fitted = Math.abs(map.duration - scene.duration) > 0.05 ? fitRhythm(map, scene.duration) : map;
  const starts = new Map(fitted.sections.map((s) => [s.from, s.name]));
  const times = sectionsOnly ? fitted.sections.slice(1).map((s) => s.from) : (fitted.moments || fitted.cuts.map((t) => ({ t }))).map((m) => m.t);
  const keep = (scene.markers || []).filter((m) => !/^r\d+$/.test(m.id));
  const added = times.map((t, i) => ({ id: `r${i + 1}`, t, label: starts.get(t) || `beat ${i + 1}` }));
  return { ...scene, markers: [...keep, ...added].sort((a, b) => a.t - b.t) };
}
