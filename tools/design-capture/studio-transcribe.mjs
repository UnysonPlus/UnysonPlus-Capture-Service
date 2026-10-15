// The Animation Studio's speech recognition: a voice-over in, its words out, each with its time and how it
// is said. Runs whisper.cpp (MIT) on this computer: nothing is uploaded anywhere. The program and a speech
// model are downloaded once, on request, into the kit (assembled/whisper, beside the local AI models) or,
// for a standalone capture service, ~/.unysonplus/whisper. macOS has no ready-made program, so there the
// Homebrew one is used (brew install whisper-cpp).
//
// Beyond the words, each word is measured from the audio itself: loudness, pitch and how long it is held,
// compared with the speaker's own average, give it an emphasis score; across the whole recording, the pace,
// the loudness range and the pitch range describe the delivery (calm, conversational, energetic, ...).
// That is what "make a scene from a voice-over" builds on: which words to show big, where the beats fall.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** whisper.cpp build the kit downloads (a pinned GitHub release of ggml-org/whisper.cpp). */
const WHISPER_BUILD = 'b5454';
const RELEASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_BUILD}/`;
const PROGRAMS = {
  'win32-x64': { asset: 'whisper-bin-x64.zip', exe: 'whisper-cli.exe' },
  'win32-arm64': { asset: 'whisper-bin-win-cpu-arm64.zip', exe: 'whisper-cli.exe' },
  'linux-x64': { asset: 'whisper-bin-ubuntu-x64.tar.gz', exe: 'whisper-cli' },
  'linux-arm64': { asset: 'whisper-bin-ubuntu-arm64.tar.gz', exe: 'whisper-cli' },
};

/** Speech models (multilingual; they detect the language). Sizes in MB, for the Studio to show. */
export const MODELS = {
  base: { file: 'ggml-base.bin', mb: 148, label: 'Fast' },
  small: { file: 'ggml-small.bin', mb: 488, label: 'Accurate' },
};
const MODEL_URL = (file) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;

/** Where Whisper lives: the kit's assembled folder, or the user's home for a standalone service. */
function whisperDir() {
  if (process.env.UPW_WHISPER_DIR) return resolve(process.env.UPW_WHISPER_DIR);
  const assembled = resolve(HERE, '../../..');
  if (basename(assembled) === 'assembled') return join(assembled, 'whisper');
  return join(homedir(), '.unysonplus', 'whisper');
}

const platformKey = () => `${process.platform}-${process.arch}`;

/** Finds a program by trying to run it (PATH lookup without a `which` dependency). */
function runs(cmd, args = ['--help']) {
  return new Promise((done) => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore' });
      p.on('error', () => done(false));
      p.on('exit', () => done(true));
    } catch { done(false); }
  });
}

function findFile(root, name, depth = 4) {
  if (!existsSync(root)) return null;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, d] = stack.pop();
    let entries = [];
    try { entries = readdirSyncSafe(dir); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory() && d < depth) stack.push([p, d + 1]);
    }
  }
  return null;
}
const readdirSyncSafe = (dir) => readdirSync(dir, { withFileTypes: true });

let programCache = null;
/** The whisper-cli program: the downloaded one, or (macOS) one on PATH. */
async function findProgram() {
  if (programCache && existsSync(programCache)) return programCache;
  const spec = PROGRAMS[platformKey()];
  if (spec) {
    const p = findFile(join(whisperDir(), 'bin'), spec.exe);
    if (p) return (programCache = p);
  }
  for (const name of ['whisper-cli', 'whisper-cpp']) if (await runs(name)) return (programCache = name);
  return null;
}

const modelPath = (key) => join(whisperDir(), 'models', MODELS[key].file);
const hasModel = (key) => { try { return statSync(modelPath(key)).size > MODELS[key].mb * 1024 * 1024 * 0.9; } catch { return false; } };

/* ------------------------------------------------------------------ install */

let install = null; // { state, step, done, total, error, model }

/** What is installed, what can be, and any install in progress. */
export async function transcribeStatus() {
  const program = await findProgram();
  const spec = PROGRAMS[platformKey()];
  return {
    program: !!program,
    // Without a ready-made program for this system (macOS), the kit can't install it itself.
    canInstallProgram: !!spec,
    installHint: spec ? null : process.platform === 'darwin' ? 'Install it with Homebrew: brew install whisper-cpp, then restart the kit.' : 'Install whisper.cpp (whisper-cli) and restart the kit.',
    models: Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, { installed: hasModel(k), mb: m.mb, label: m.label }])),
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

function extract(archive, into) {
  // Windows' own tar (bsdtar) opens zips; elsewhere tar handles .tar.gz.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  mkdirSync(into, { recursive: true });
  return new Promise((ok, bad) => {
    const p = spawn(tar, ['-xf', archive, '-C', into], { stdio: 'ignore' });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`Could not unpack ${basename(archive)} (tar exited ${c}).`))));
  });
}

/** Installs the program (where the kit can) and a model, in the background. */
export function startInstall(body = {}) {
  const key = MODELS[body.model] ? body.model : 'base';
  if (install && install.state === 'running') return { ...install };
  install = { state: 'running', step: 'Checking', done: 0, total: 0, error: '', model: key };
  (async () => {
    try {
      if (!(await findProgram())) {
        const spec = PROGRAMS[platformKey()];
        if (!spec) throw new Error((await transcribeStatus()).installHint);
        install.step = 'Downloading speech recognition';
        const zip = join(whisperDir(), spec.asset);
        await download(RELEASE + spec.asset, zip, (d, t) => { install.done = d; install.total = t; });
        install.step = 'Unpacking';
        await extract(zip, join(whisperDir(), 'bin'));
        try { unlinkSync(zip); } catch { /* fine */ }
        programCache = null;
        if (!(await findProgram())) throw new Error('The speech recognition program could not be found after unpacking.');
      }
      if (!hasModel(key)) {
        install.step = `Downloading the ${MODELS[key].label.toLowerCase()} speech model`;
        await download(MODEL_URL(MODELS[key].file), modelPath(key), (d, t) => { install.done = d; install.total = t; });
      }
      install.state = 'done';
      install.step = 'Ready';
      console.log('[studio-transcribe] installed', key, 'in', whisperDir());
    } catch (e) {
      install.state = 'error';
      install.error = String(e && e.message || e);
      console.warn('[studio-transcribe] install failed:', install.error);
    }
  })();
  return { ...install };
}

/* ------------------------------------------------------------------ transcribing */

const jobs = new Map();
let active = null;
let seq = 0;

function run(cmd, args) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`${basename(cmd)} failed (${c}): ${err.trim().split('\n').slice(-2).join(' ')}`))));
  });
}

/** Writes the clip's audio (a data: URL or an address) to a file. */
async function audioFile(src, dir) {
  if (typeof src !== 'string' || !src) throw Object.assign(new Error('Send the audio (src).'), { code: 400 });
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',');
    const meta = src.slice(5, comma);
    const file = join(dir, 'in.audio');
    writeFileSync(file, meta.includes(';base64') ? Buffer.from(src.slice(comma + 1), 'base64') : Buffer.from(decodeURIComponent(src.slice(comma + 1))));
    return file;
  }
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`Could not load the audio (HTTP ${r.status}).`);
    const file = join(dir, 'in.audio');
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return file;
  }
  throw Object.assign(new Error('Built-in sounds have no words to transcribe.'), { code: 400 });
}

/** Starts a transcription; follow it with jobInfo(id). */
export function startTranscribe(body = {}) {
  const key = MODELS[body.model] ? body.model : hasModel('small') && !hasModel('base') ? 'small' : 'base';
  if (!hasModel(key)) throw Object.assign(new Error('Install speech recognition first.'), { code: 400 });
  if (typeof body.src !== 'string' || !body.src) throw Object.assign(new Error('Send the audio (src).'), { code: 400 });
  const id = `t${Date.now().toString(36)}${(seq++).toString(36)}`;
  const job = { id, state: 'queued', step: 'Waiting', error: '', result: null, model: key, started: Date.now() };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (Date.now() - j.started > 3600e3) jobs.delete(k);
  const go = async () => {
    active = job;
    const dir = join(tmpdir(), `upw-transcribe-${id}`);
    mkdirSync(dir, { recursive: true });
    try {
      const program = await findProgram();
      if (!program) throw new Error('The speech recognition program is not installed.');
      job.state = 'running';
      job.step = 'Reading the audio';
      const input = await audioFile(body.src, dir);
      const wav = join(dir, 'speech.wav');
      const ffmpeg = process.env.FFMPEG || 'ffmpeg';
      await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
      job.step = 'Listening';
      const outBase = join(dir, 'out');
      const args = ['-m', modelPath(key), '-f', wav, '-ojf', '-of', outBase, '-np', '-t', String(Math.max(2, Math.min(8, (await cpuCount()) - 1)))];
      if (typeof body.language === 'string' && /^[a-z]{2}$/.test(body.language)) args.push('-l', body.language);
      else args.push('-l', 'auto');
      await run(program, args);
      job.step = 'Measuring the delivery';
      const whisper = JSON.parse(readFileSync(`${outBase}.json`, 'utf8'));
      const pcm = readPcm(wav);
      job.result = analyse(whisper, pcm, key);
      job.state = 'done';
      job.step = 'Done';
      console.log(`[studio-transcribe] ${id}: ${job.result.words.length} words, ${job.result.speech.wpm} wpm, ${job.result.speech.delivery.join(', ')}`);
    } catch (e) {
      job.state = 'error';
      job.error = String(e && e.message || e);
      console.warn('[studio-transcribe]', id, job.error);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      active = null;
    }
  };
  queue = queue.then(go, go);
  return { id, state: job.state };
}
let queue = Promise.resolve();

export function transcribeJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { id: j.id, state: j.state, step: j.step, error: j.error, model: j.model, result: j.state === 'done' ? j.result : null };
}

async function cpuCount() {
  const os = await import('node:os');
  return (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 4;
}

/* ------------------------------------------------------------------ analysis */

/** 16 kHz mono PCM from the WAV ffmpeg wrote (16-bit, 44-byte header). */
function readPcm(wav) {
  const b = readFileSync(wav);
  let off = 12;
  while (off + 8 <= b.length && b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
  const start = off + 8;
  const n = Math.floor((b.length - start) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(start + i * 2) / 32768;
  return out;
}

const SR = 16000;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const std = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1)); };
const r2 = (v) => Math.round(v * 100) / 100;

/** Loudness of a stretch of audio, in dB. */
function loudness(pcm, t0, t1) {
  const a = Math.max(0, Math.floor(t0 * SR));
  const b = Math.min(pcm.length, Math.ceil(t1 * SR));
  if (b <= a) return -90;
  let s = 0;
  for (let i = a; i < b; i++) s += pcm[i] * pcm[i];
  return 10 * Math.log10(s / (b - a) + 1e-10);
}

/** Median pitch (Hz) over a stretch, by YIN on 40 ms frames; 0 when unvoiced. */
function pitch(pcm, t0, t1) {
  const W = 640; // 40 ms
  const minLag = Math.floor(SR / 400);
  const maxLag = Math.floor(SR / 70);
  const found = [];
  for (let s = Math.floor(t0 * SR); s + W + maxLag < Math.min(pcm.length, t1 * SR + W); s += 320) {
    const d = new Float32Array(maxLag + 1);
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < W; i++) { const x = pcm[s + i] - pcm[s + i + lag]; sum += x * x; }
      d[lag] = sum;
    }
    // Cumulative mean normalised difference; the first dip under 0.15 is the period.
    let run = 0;
    let best = 0;
    for (let lag = 1; lag <= maxLag; lag++) {
      run += d[lag];
      const v = (d[lag] * lag) / (run || 1);
      if (lag >= minLag && v < 0.15) { best = lag; break; }
    }
    if (best) found.push(SR / best);
  }
  return found.length >= 2 ? median(found) : 0;
}

/** For tests: the analysis of a whisper.cpp JSON result and its 16 kHz WAV. */
export function analyseFiles(whisperJson, wavPath, model = 'base') {
  return analyse(JSON.parse(readFileSync(whisperJson, 'utf8')), readPcm(wavPath), model);
}

/**
 * Words with times and emphasis, and the delivery overall.
 * Word: { w, t (s from the file start), d (s), s (emphasis 0-1), p (pause before, s) }.
 */
function analyse(whisper, pcm, model) {
  const words = [];
  for (const seg of whisper.transcription || []) {
    for (const tok of seg.tokens || []) {
      if (/^\[_|^\[[A-Z_]+\]$/.test(tok.text)) continue;
      const from = tok.offsets.from / 1000;
      const to = tok.offsets.to / 1000;
      const text = tok.text;
      if ((text.startsWith(' ') || !words.length) && /\w/.test(text)) words.push({ w: text.trim(), t: from, e: to, prob: [tok.p] });
      else if (words.length) { const w = words[words.length - 1]; w.w += text; w.e = Math.max(w.e, to); w.prob.push(tok.p); }
    }
  }
  const dur = pcm.length / SR;
  if (!words.length) return { language: whisper.result?.language || '', duration: r2(dur), words: [], speech: { wpm: 0, pace: 'silent', delivery: [], model } };

  // Per word: loudness, pitch, and how long it is held for its length.
  for (const w of words) {
    const d = Math.max(0.05, w.e - w.t);
    w.db = loudness(pcm, w.t, w.e);
    w.f0 = d >= 0.12 ? pitch(pcm, w.t, w.e) : 0;
    const letters = Math.max(1, w.w.replace(/[^\p{L}\p{N}]/gu, '').length);
    w.hold = d / (0.07 * letters + 0.08);
  }
  const dbs = words.map((w) => w.db);
  const f0s = words.filter((w) => w.f0 > 0).map((w) => w.f0);
  const holds = words.map((w) => w.hold);
  const dbM = median(dbs);
  const dbS = std(dbs) || 1;
  const f0M = median(f0s) || 1;
  const semis = words.map((w) => (w.f0 > 0 ? 12 * Math.log2(w.f0 / f0M) : 0));
  const semiS = std(semis.filter((v) => v !== 0)) || 1;
  const holdM = median(holds) || 1;
  const holdS = std(holds) || 1;

  const out = words.map((w, i) => {
    const zl = (w.db - dbM) / dbS;
    const zp = semis[i] / semiS;
    const zh = (w.hold - holdM) / holdS;
    const s = Math.max(0, Math.min(1, 0.5 + 0.2 * zl + 0.12 * zp + 0.12 * zh));
    const prev = words[i - 1];
    const word = { w: w.w, t: r2(w.t), d: r2(Math.max(0.05, w.e - w.t)), s: r2(s) };
    const pause = prev ? w.t - prev.e : w.t;
    if (pause >= 0.15) word.p = r2(pause);
    return word;
  });

  // Delivery: pace (words per minute of speaking), loudness range, pitch range.
  const speaking = out.reduce((a, w) => a + w.d, 0) + out.reduce((a, w) => a + Math.min(w.p ?? 0, 0.5), 0);
  const wpm = Math.round(out.length / Math.max(1, speaking) * 60);
  const pace = wpm < 115 ? 'slow' : wpm < 150 ? 'steady' : wpm < 185 ? 'brisk' : 'fast';
  const dynamics = r2(pct(dbs, 0.9) - pct(dbs, 0.1));
  const pitchRange = r2(pct(semis.filter((v) => v !== 0), 0.9) - pct(semis.filter((v) => v !== 0), 0.1));
  const delivery = [];
  if ((pace === 'brisk' || pace === 'fast') && (dynamics > 12 || pitchRange > 7)) delivery.push('energetic');
  if (pace === 'slow' && dynamics < 10 && pitchRange < 6) delivery.push('calm');
  if (dynamics > 14 || pitchRange > 9) delivery.push('expressive');
  if (dynamics < 7 && pitchRange < 4) delivery.push('even');
  if (!delivery.length) delivery.push('conversational');
  // Strong moments: the most emphasised words (top tenth, at least 0.75), for big type and hits.
  const cut = Math.max(0.75, pct(out.map((w) => w.s), 0.9));
  const emphasis = out.map((w, i) => (w.s >= cut ? i : -1)).filter((i) => i >= 0);

  return {
    language: whisper.result?.language || '',
    duration: r2(dur),
    text: out.map((w) => w.w).join(' '),
    words: out,
    speech: { wpm, pace, dynamics, pitchRange, delivery, emphasis, model },
  };
}
