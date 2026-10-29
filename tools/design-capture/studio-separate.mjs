// Kinetic Scenes' voice and music separation: a clip's sound in, the voice and the music out as two tracks. Runs
// HTDemucs v4 (Meta's Demucs, MIT; the MIT ONNX export published by the WebNN project) with ONNX Runtime on this
// computer: nothing is uploaded anywhere. ONNX Runtime and the model (about 170 MB) are downloaded once, on request,
// into the kit (assembled/separate) or, for a standalone capture service, ~/.unysonplus/separate.
//
// What it is for: transcribing the voice alone gives cleaner word timings under music; "remove the music, keep the
// voice"; re-scoring a clip with new music; and ducking the music under the voice automatically.
//
// The signal processing around the model (segments, STFT / iSTFT, overlap-add) is vendor/htdemucs.mjs.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SAMPLE_RATE, SEGMENT_LENGTH, HOP, STEM_NAMES, SPECTROGRAM_SHAPE, WAVEFORM_SHAPE,
  addSegmentToStems, buildOverlapWeights, createStemBuffers, extractSegment, finalizeStemRange, getSegmentLayout,
  htdemucsPostForward, htdemucsPreForward,
} from './vendor/htdemucs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** ONNX Runtime for Node, installed into the separate folder on first use (pinned). */
const ORT_VERSION = '1.30.0';
const MODEL_HOST = 'https://huggingface.co/webnn/stem-separator/resolve/main/onnx/';
const MODEL_FILES = [{ file: 'htdemucs_fwd.onnx', mb: 2.3 }, { file: 'htdemucs_fwd.onnx.data', mb: 168 }];

function separateDir() {
  if (process.env.UPW_SEPARATE_DIR) return resolve(process.env.UPW_SEPARATE_DIR);
  const assembled = resolve(HERE, '../../..');
  if (basename(assembled) === 'assembled') return join(assembled, 'separate');
  return join(homedir(), '.unysonplus', 'separate');
}
const modelPath = (f) => join(separateDir(), 'model', f);
const hasModel = () => MODEL_FILES.every((m) => existsSync(modelPath(m.file)) && statSync(modelPath(m.file)).size > 1000);
const ortPath = () => join(separateDir(), 'runtime', 'node_modules', 'onnxruntime-node');
const hasRuntime = () => existsSync(join(ortPath(), 'package.json'));

let install = null;
let ortCache = null;
async function ort() {
  if (ortCache) return ortCache;
  const req = createRequire(join(separateDir(), 'runtime', 'index.js'));
  ortCache = req('onnxruntime-node');
  return ortCache;
}

function runs(cmd, args) {
  return new Promise((done) => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore' });
      p.on('error', () => done(false));
      p.on('exit', (c) => done(c === 0));
    } catch { done(false); }
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`${basename(cmd)} failed (${c}): ${err.trim().split('\n').slice(-2).join(' ')}`))));
  });
}

export async function separateStatus() {
  return {
    runtime: hasRuntime(),
    model: hasModel(),
    mb: Math.round(MODEL_FILES.reduce((s, m) => s + m.mb, 0)),
    ffmpeg: await runs(process.env.FFMPEG || 'ffmpeg', ['-version']),
    install: install ? { ...install } : null,
    busy: !!active,
  };
}

async function download(url, dest, onBytes) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status}) for ${basename(dest)}.`);
  const total = Number(r.headers.get('content-length')) || 0;
  onBytes(0, total);
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const out = createWriteStream(part);
  let got = 0;
  for await (const chunk of r.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
    onBytes(got, total);
  }
  await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
  renameSync(part, dest);
}

/** Installs ONNX Runtime and the model, in the background. */
export function startSeparateInstall() {
  if (install && install.state === 'running') return { ...install };
  install = { state: 'running', step: 'Checking', done: 0, total: 0, error: '' };
  (async () => {
    try {
      if (!hasRuntime()) {
        install.step = 'Installing ONNX Runtime';
        const dir = join(separateDir(), 'runtime');
        mkdirSync(dir, { recursive: true });
        if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'upw-separate-runtime', private: true }));
        // npm's own script, run by this Node (no shell, and the same Node the kit runs on).
        const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        const [cmd, pre] = existsSync(npmCli) ? [process.execPath, [npmCli]] : ['npm', []];
        await run(cmd, [...pre, 'install', `onnxruntime-node@${ORT_VERSION}`, '--no-audit', '--no-fund', '--omit=dev'], { cwd: dir });
        if (!hasRuntime()) throw new Error('ONNX Runtime could not be installed.');
      }
      for (const m of MODEL_FILES) {
        if (existsSync(modelPath(m.file))) continue;
        install.step = `Downloading the separation model (${m.mb} MB)`;
        await download(MODEL_HOST + m.file, modelPath(m.file), (d, t) => { install.done = d; install.total = t; });
      }
      install.state = 'done';
      install.step = 'Ready';
      console.log('[studio-separate] installed in', separateDir());
    } catch (e) {
      install.state = 'error';
      install.error = String(e && e.message || e);
      console.warn('[studio-separate] install failed:', install.error);
    }
  })();
  return { ...install };
}

/* ------------------------------------------------------------------ separating */

/** Decodes any audio or video file to planar stereo 44.1 kHz float samples with ffmpeg. */
async function decode(file, dir) {
  const raw = join(dir, 'mix.f32');
  await run(process.env.FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vn', '-ac', '2', '-ar', String(SAMPLE_RATE), '-f', 'f32le', raw]);
  const buf = readFileSync(raw);
  const all = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const n = all.length >> 1;
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) { left[i] = all[2 * i]; right[i] = all[2 * i + 1]; }
  return { left, right };
}

/** A 16-bit stereo WAV of two channels. */
function wav(left, right) {
  const n = left.length;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(SAMPLE_RATE * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  const s = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) { b.writeInt16LE(s(left[i]), 44 + i * 4); b.writeInt16LE(s(right[i]), 46 + i * 4); }
  return b;
}

/**
 * Separates a file: returns WAV buffers of the voice and of everything else (the music and effects), and, with
 * `stems`, the four stems (drums, bass, other, vocals). onProgress(done, total) counts segments of about 8 s.
 */
export async function separateFile(file, opts = {}) {
  if (!hasRuntime() || !hasModel()) throw Object.assign(new Error('Install voice and music separation first.'), { code: 400 });
  const dir = join(tmpdir(), `upw-separate-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const { left, right } = await decode(file, dir);
    if (!left.length) throw new Error('The file has no sound.');
    const { InferenceSession, Tensor } = await ort();
    const session = await InferenceSession.create(modelPath('htdemucs_fwd.onnx'), { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
    const total = left.length;
    const { count } = getSegmentLayout(total);
    const stems = createStemBuffers(total);
    const weightTotals = new Float32Array(total);
    const weights = buildOverlapWeights();
    for (let i = 0; i < count; i++) {
      const segment = extractSegment(left, right, i);
      const { spectrogram, waveform, spectrogramStats, waveformStats } = htdemucsPreForward(segment);
      const out = await session.run({ x: new Tensor('float32', spectrogram, SPECTROGRAM_SHAPE), xt: new Tensor('float32', waveform, WAVEFORM_SHAPE) });
      const sources = htdemucsPostForward(out.x_out.data, out.xt_out.data, spectrogramStats, waveformStats);
      addSegmentToStems(stems, weightTotals, sources, weights, i * HOP);
      opts.onProgress?.(i + 1, count);
    }
    finalizeStemRange(stems, weightTotals, 0, total);
    const musicL = new Float32Array(total), musicR = new Float32Array(total);
    for (const name of STEM_NAMES) {
      if (name === 'vocals') continue;
      const s = stems[name];
      for (let i = 0; i < total; i++) { musicL[i] += s.left[i]; musicR[i] += s.right[i]; }
    }
    const result = { seconds: Math.round((total / SAMPLE_RATE) * 100) / 100, voice: wav(stems.vocals.left, stems.vocals.right), music: wav(musicL, musicR) };
    if (opts.stems) result.stems = Object.fromEntries(STEM_NAMES.map((n) => [n, wav(stems[n].left, stems[n].right)]));
    return result;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/* ------------------------------------------------------------------ jobs for the Studio */

const jobs = new Map();
let active = null;
let seq = 0;
let queue = Promise.resolve();

/** Turns the clip's sound (a data: URL or an address) into a file. */
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
  throw Object.assign(new Error('Built-in sounds have nothing to separate.'), { code: 400 });
}

/** Encodes a WAV to a compact AAC data URL for the scene. */
async function toDataUrl(wavBuf, dir, name) {
  const w = join(dir, `${name}.wav`), m = join(dir, `${name}.m4a`);
  writeFileSync(w, wavBuf);
  await run(process.env.FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', w, '-c:a', 'aac', '-b:a', '160k', m]);
  return `data:audio/mp4;base64,${readFileSync(m).toString('base64')}`;
}

export function startSeparate(body = {}) {
  if (!hasRuntime() || !hasModel()) throw Object.assign(new Error('Install voice and music separation first.'), { code: 400 });
  const id = `s${Date.now().toString(36)}${(seq++).toString(36)}`;
  const job = { id, state: 'queued', step: 'Waiting', done: 0, total: 0, error: '', result: null, started: Date.now() };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (Date.now() - j.started > 3600e3) jobs.delete(k);
  const go = async () => {
    active = job;
    const dir = join(tmpdir(), `upw-separate-job-${id}`);
    mkdirSync(dir, { recursive: true });
    try {
      job.state = 'running';
      job.step = 'Reading the sound';
      const file = await inputFile(body.src, dir);
      job.step = 'Separating the voice from the music';
      const r = await separateFile(file, { onProgress: (d, t) => { job.done = d; job.total = t; } });
      job.step = 'Packing the tracks';
      job.result = { seconds: r.seconds, voice: await toDataUrl(r.voice, dir, 'voice'), music: await toDataUrl(r.music, dir, 'music') };
      job.state = 'done';
      job.step = 'Done';
      console.log(`[studio-separate] ${id}: ${r.seconds} s separated`);
    } catch (e) {
      job.state = 'error';
      job.error = String(e && e.message || e);
      console.warn('[studio-separate]', id, job.error);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      active = null;
    }
  };
  queue = queue.then(go, go);
  return { id, state: job.state };
}

export function separateJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { id: j.id, state: j.state, step: j.step, done: j.done, total: j.total, error: j.error, result: j.state === 'done' ? j.result : null };
}
