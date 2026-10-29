// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Sound identification: names the sounds in a clip (speech, music, a door slam, rain, applause…) and when each one is
// heard, with CLAP (LAION's audio-text model, Apache-2.0; the 8-bit ONNX copy) run by Transformers.js inside Node: on
// the processor, nothing uploaded. Installed once, on request, into its own folder (<assembled>/clap, with its own
// package.json, so npm never touches anything else); the model (about 156 MB) is cached there too.
//
// CLAP scores a sound against words, so the list of sounds is open: pass your own labels, or use the default set below.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = 'Xenova/clap-htsat-unfused';
const PACKAGE = '@huggingface/transformers@3.8.1';
const RATE = 48000;
export const CLAP_MB = 560; // on disk: the program (about 400 MB) and the 8-bit model (about 156 MB)

/** The sounds looked for when no labels are given: what a video editor usually needs to find. */
export const DEFAULT_LABELS = [
  'speech', 'music', 'singing', 'silence', 'applause', 'laughter', 'a crowd cheering', 'a door slam', 'a door creak',
  'a knock on a door', 'footsteps', 'a phone ringing', 'a notification beep', 'typing on a keyboard', 'a mouse click',
  'glass breaking', 'a car engine', 'a car horn', 'traffic', 'a siren', 'an airplane', 'rain', 'thunder', 'wind',
  'birds singing', 'a dog barking', 'a cat meowing', 'water running', 'ocean waves', 'a whoosh', 'an explosion',
  'a drum hit', 'a cymbal crash', 'a camera shutter', 'paper rustling', 'cooking sizzle', 'a crowd talking', 'room ambience',
  'white noise', 'a beep tone',
];

function clapDir() {
  const assembled = resolve(HERE, '../../..');
  return basename(assembled) === 'assembled' ? join(assembled, 'clap') : join(homedir(), '.unysonplus', 'clap');
}
const entry = (dir) => join(dir, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
const cacheDir = (dir) => join(dir, 'models');
export function clapInstalled() {
  const dir = clapDir();
  return existsSync(entry(dir)) && existsSync(cacheDir(dir)) && readdirSync(cacheDir(dir)).length > 0;
}

function run(cmd, args, cwd) {
  return new Promise((ok, bad) => {
    const win = process.platform === 'win32' && cmd === 'npm';
    const p = spawn(win ? 'npm.cmd' : cmd, args, { cwd, shell: win, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`${cmd} failed (${c}): ${err.trim().split('\n').slice(-2).join(' ')}`))));
  });
}

let clf = null;
let loading = null;
/** The classifier, loaded once per kit run (about 12 s the first time). */
async function classifier() {
  if (clf) return clf;
  if (!loading) {
    loading = (async () => {
      const dir = clapDir();
      const tf = await import(pathToFileURL(entry(dir)).href);
      tf.env.cacheDir = cacheDir(dir);
      clf = await tf.pipeline('zero-shot-audio-classification', MODEL, { dtype: 'q8' });
      return clf;
    })().finally(() => { loading = null; });
  }
  return loading;
}

let install = null;
/** Installs Transformers.js into its own folder and downloads the model (by loading it once). Poll clapStatus(). */
export function startClapInstall() {
  if (install && install.state === 'running') return { ...install };
  install = { state: 'running', step: 'Checking', error: '' };
  (async () => {
    const dir = clapDir();
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'upw-clap', private: true, description: 'Sound identification for the Unyson+ AI Dev Kit' }, null, 2));
    if (!existsSync(entry(dir))) {
      install.step = 'Installing the sound identification program';
      await run('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', PACKAGE], dir);
    }
    install.step = 'Downloading the sound model (about 156 MB)';
    mkdirSync(cacheDir(dir), { recursive: true });
    await classifier();
  })()
    .then(() => { install.state = 'done'; install.step = 'Done'; })
    .catch((e) => { install.state = 'error'; install.error = String(e && e.message || e); });
  return { ...install };
}

export function clapStatus() {
  return { installed: clapInstalled(), mb: CLAP_MB, install: install ? { ...install } : null, labels: DEFAULT_LABELS };
}

/** Decodes any sound or video to mono 48 kHz float samples (what CLAP listens to). */
async function samples(file, dir) {
  const raw = join(dir, 'clap.f32');
  await run(process.env.FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', raw]);
  const b = readFileSync(raw);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Names the sounds in a file. Listens in windows (2 s, every 1 s), keeps each window's best label when it is clear
 * enough (score ≥ minScore), and joins neighbouring windows with the same label into one stretch.
 * Returns { seconds, overall: [{ label, score }], segments: [{ start, end, label, score }] }.
 */
export async function identifySounds(file, opts = {}) {
  if (!clapInstalled()) throw Object.assign(new Error('Install sound identification first (Add-ons, or `studio-cli clap-install`).'), { code: 400 });
  const labels = (Array.isArray(opts.labels) && opts.labels.length ? opts.labels : DEFAULT_LABELS).map(String).filter(Boolean).slice(0, 100);
  const win = Math.max(0.5, Math.min(10, Number(opts.window) || 2));
  const hop = Math.max(0.25, Math.min(win, Number(opts.hop) || 1));
  const minScore = Math.max(0, Math.min(1, opts.minScore ?? 0.3));
  const dir = join(tmpdir(), `upw-clap-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const a = await samples(file, dir);
    const seconds = a.length / RATE;
    const c = await classifier();
    const totals = Object.fromEntries(labels.map((l) => [l, 0]));
    const segments = [];
    const starts = [];
    for (let t = 0; t === 0 || t + win <= seconds + hop / 2; t += hop) starts.push(t);
    for (let i = 0; i < starts.length; i++) {
      const t = starts[i];
      const piece = a.subarray(Math.floor(t * RATE), Math.min(a.length, Math.floor((t + win) * RATE)));
      if (piece.length < RATE * 0.25) break;
      const r = (await c(piece, labels)).sort((x, y) => y.score - x.score);
      for (const x of r) totals[x.label] += x.score;
      opts.onProgress?.(i + 1, starts.length);
      const best = r[0];
      if (best.score < minScore) continue;
      const end = Math.min(seconds, t + win);
      const last = segments[segments.length - 1];
      if (last && last.label === best.label && t <= last.end) { last.end = end; last.scores.push(best.score); }
      else {
        // Windows overlap: where one sound gives way to the next, split the overlap down the middle.
        let start = t;
        if (last && t < last.end) { start = round((t + last.end) / 2); last.end = start; }
        segments.push({ start, end, label: best.label, scores: [best.score] });
      }
    }
    const n = Math.max(1, starts.length);
    const overall = Object.entries(totals).map(([label, s]) => ({ label, score: round(s / n) })).sort((x, y) => y.score - x.score).filter((x) => x.score >= 0.05).slice(0, 8);
    return {
      seconds: round(seconds),
      overall,
      segments: segments.map((s) => ({ start: round(s.start), end: round(s.end), label: s.label, score: round(s.scores.reduce((p, q) => p + q, 0) / s.scores.length) })),
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Jobs, for the Studio: POST a clip, poll its id.
const jobs = new Map();
let seq = 0;
let queue = Promise.resolve();

async function inputFile(src, dir) {
  if (typeof src !== 'string' || !src) throw Object.assign(new Error('Send the sound or footage (src).'), { code: 400 });
  const file = join(dir, 'in.media');
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',');
    writeFileSync(file, src.slice(5, comma).includes(';base64') ? Buffer.from(src.slice(comma + 1), 'base64') : Buffer.from(decodeURIComponent(src.slice(comma + 1))));
    return file;
  }
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`Could not load the sound (HTTP ${r.status}).`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return file;
  }
  throw Object.assign(new Error('Send the clip as a file or an address.'), { code: 400 });
}

export function startIdentify(body = {}) {
  if (!clapInstalled()) throw Object.assign(new Error('Install sound identification first.'), { code: 400 });
  const id = `c${Date.now().toString(36)}${(seq++).toString(36)}`;
  const job = { id, state: 'queued', step: 'Waiting', done: 0, total: 0, error: '', result: null, started: Date.now() };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (Date.now() - j.started > 3600e3) jobs.delete(k);
  const go = async () => {
    const dir = join(tmpdir(), `upw-clap-job-${id}`);
    mkdirSync(dir, { recursive: true });
    try {
      job.state = 'running';
      job.step = 'Reading the sound';
      const file = await inputFile(body.src, dir);
      job.step = clf ? 'Listening' : 'Listening (the model loads the first time)';
      job.result = await identifySounds(file, { labels: body.labels, window: body.window, hop: body.hop, minScore: body.minScore, onProgress: (d, t) => { job.done = d; job.total = t; } });
      job.state = 'done';
      job.step = 'Done';
      console.log(`[studio-clap] ${id}: ${job.result.segments.length} stretches in ${job.result.seconds} s`);
    } catch (e) {
      job.state = 'error';
      job.error = String(e && e.message || e);
      console.warn('[studio-clap]', id, job.error);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
  queue = queue.then(go, go);
  return { id, state: job.state };
}

export function identifyJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { id: j.id, state: j.state, step: j.step, done: j.done, total: j.total, error: j.error, result: j.state === 'done' ? j.result : null };
}
