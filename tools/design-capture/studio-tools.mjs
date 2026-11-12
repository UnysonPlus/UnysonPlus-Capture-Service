// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Kinetic Scenes' scene tools for agents and the command line: the same checks, frames, renders and audio
// analysis the Studio uses, on a scene file on disk. studio-cli.mjs runs them as commands, studio-mcp.mjs
// offers them to an AI agent as MCP tools. Nothing here needs the Studio open; the player is loaded from
// the Studio's site (or from UPW_PLAYER_BASE).

import { spawn } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { keyMoments, renderStills } from './studio-director.mjs';
import { jobCover, jobFile, jobInfo, renderStatus, startRender } from './studio-render.mjs';
import { startTranscribe, transcribeJob, transcribeStatus } from './studio-transcribe.mjs';
import { separateFile, separateStatus } from './studio-separate.mjs';

const SITE = 'https://kinetic-scenes.unysonplus.com/';
const HERE_TOOLS = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FALLBACK_PLAYER = `${SITE}player/0.0.39/`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const fail = (message) => Object.assign(new Error(message), { code: 400 });

/** Where the player is: an explicit address, UPW_PLAYER_BASE, or the newest version the Studio publishes. */
export async function playerBase(explicit) {
  const given = explicit || process.env.UPW_PLAYER_BASE;
  if (given) return given.endsWith('/') ? given : `${given}/`;
  try {
    const r = await fetch(`${SITE}player/latest.json`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const j = await r.json(); if (j.base) return new URL(j.base, SITE).href; }
  } catch { /* offline or older site: the known version */ }
  return FALLBACK_PLAYER;
}

/** A scene from a file path, or the scene object itself. Local media in it is found next to the scene file. */
export function loadScene(input) {
  const scene = typeof input === 'string' ? JSON.parse(readFileSync(resolve(input), 'utf8')) : input;
  if (!scene || scene.format !== 'unysonplus-scene') throw fail('That is not a Kinetic Scenes scene file (format "unysonplus-scene").');
  if (typeof input === 'string') Object.defineProperty(scene, '__base', { value: dirname(resolve(input)), enumerable: false });
  return scene;
}

/**
 * Footage, pictures and sound given as local files (a path, relative to the scene file) are served from a small web
 * server that allows seeking, for as long as `fn` runs; the browser that renders the scene cannot read files itself.
 */
async function withLocalMedia(scene, fn) {
  const base = scene.__base || process.cwd();
  const files = new Map();
  const local = (src) => typeof src === 'string' && src && !/^(https?:|data:|blob:|sfx:|brand:)/i.test(src);
  const map = (src) => { const file = resolve(base, src); if (!existsSync(file)) return src; const key = `/m${files.size}/${basename(file)}`; files.set(key, file); return key; };
  const copy = JSON.parse(JSON.stringify(scene));
  const walk = (list) => (list || []).forEach((l) => {
    if (local(l.src)) l.src = map(l.src);
    if (l.model && local(l.model.src)) l.model.src = map(l.model.src);
    // A picture a clip brings in (Before and after's second screen) is a file too.
    for (const k of l.clips || []) if (k.params && local(k.params.src)) k.params.src = map(k.params.src);
    if (l.layers) walk(l.layers);
    if (l.item) walk([l.item]);
  });
  walk(copy.layers);
  (copy.audio || []).forEach((a) => { if (local(a.src)) a.src = map(a.src); });
  if (!files.size) return fn(scene);
  const { createServer } = await import('node:http');
  const types = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary' };
  const server = createServer((req, res) => {
    // A page from the web may reach a server on this computer only after asking (Chrome's private network access).
    const allow = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Headers': 'range', 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length' };
    if (req.method === 'OPTIONS') { res.writeHead(204, allow); return res.end(); }
    const file = files.get(decodeURI(req.url.split('?')[0]));
    if (!file) { res.writeHead(404); return res.end(); }
    const size = statSync(file).size, type = types[extname(file).toLowerCase()] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...allow };
    if (m) {
      const a = m[1] ? Number(m[1]) : 0, b = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
      return createReadStream(file, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': size });
    createReadStream(file).pipe(res);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fix = (list) => (list || []).forEach((l) => {
    if (typeof l.src === 'string' && files.has(l.src)) l.src = origin + l.src;
    if (l.model && files.has(l.model.src)) l.model.src = origin + l.model.src;
    for (const k of l.clips || []) if (k.params && files.has(k.params.src)) k.params.src = origin + k.params.src;
    if (l.layers) fix(l.layers);
    if (l.item) fix([l.item]);
  });
  fix(copy.layers);
  (copy.audio || []).forEach((a) => { if (files.has(a.src)) a.src = origin + a.src; });
  try { return await fn(copy); } finally { server.close(); }
}

/** The player's own validation and Check scene report. */
export async function checkScene(scene, opts = {}) {
  return withLocalMedia(scene, (sc) => checkLocal(sc, opts));
}
async function checkLocal(scene, opts) {
  try {
    // Also measures the rendered layout at the moments each part has landed (words on words, ticks far from
    // their words, uneven or off-centre lists, words crossing a panel): things the scene file alone can't show.
    const r = await renderStills({ scene, playerBase: await playerBase(opts.player), times: 'settled' });
    rmSync(r.dir, { recursive: true, force: true });
    const errors = r.issues.filter((i) => i.startsWith('error'));
    return { ok: !errors.length, errors: [], issues: [...r.issues, ...(r.layout || []).map((l) => `layout ${l}`), ...spokenCaptionIssues(scene)] };
  } catch (e) {
    const msg = String(e && e.message || e);
    const list = msg.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    return { ok: false, errors: list.length ? list : [msg], issues: [] };
  }
}

/** Text timed to the voice (the Spoken rhythm) must stay up until its last word has been seen: a late word never appears. */
function spokenCaptionIssues(scene) {
  const norm = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const said = (scene.audio || []).filter((a) => a.role === 'voice' && a.words?.length).flatMap((a) => a.words.map((w) => ({ n: norm(w.w), t: (a.start ?? 0) + w.t - (a.offset ?? 0) })));
  const out = [];
  for (const l of scene.layers || []) {
    if (l.type !== 'text') continue;
    const clip = (l.clips || []).find((c) => c.params?.rhythm === 'spoken' && c.params?.direction !== 'out');
    if (!clip) continue;
    const last = norm(String(l.text).replace(/\*/g, '').trim().split(/\s+/).pop());
    const word = said.filter((w) => w.n === last && w.t >= clip.start && w.t <= clip.start + clip.duration + 3).pop();
    if (!word) continue;
    const gone = Math.min(l.end ?? Infinity, ...(l.clips || []).filter((c) => c.params?.direction === 'out' && c.start > clip.start).map((c) => c.start));
    if (gone < word.t + 0.3) out.push(`warn: "${short(l.text, 28)}": its last word, "${last}", is said at ${word.t.toFixed(2)} s but the text leaves at ${gone.toFixed(2)} s, so it is barely seen or never appears. Keep the text up about 0.3 s past it.`);
  }
  return out;
}

const short = (s, n = 48) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A readable outline of a scene: its stage, layers and clips in time, sound and the moments worth looking at. */
export function inspectScene(scene) {
  const layer = (l, depth) => {
    const what = l.text ?? l.label ?? l.code ?? l.src ?? '';
    const head = `${'  '.repeat(depth)}${l.id} (${l.type}${what && !String(what).startsWith('data:') ? `: "${short(what)}"` : ''})${l.type === 'group' && (l.start != null || l.end != null) ? ` ${l.start ?? 0}s to ${l.end ?? 'end'}` : ''}`;
    const clips = (l.clips || []).map((c) => `${'  '.repeat(depth + 1)}- ${c.preset} at ${c.start}s for ${c.duration}s${c.params?.direction === 'out' ? ' (out)' : ''}`);
    return [head, ...clips, ...(l.layers || []).flatMap((k) => layer(k, depth + 1))];
  };
  const count = (ls) => ls.reduce((n, l) => n + 1 + count(l.layers || []), 0);
  const bps = (scene.stage?.breakpoints || []).map((b) => `${b.id} ${b.aspect?.join(':')}${b.minWidth ? ` from ${b.minWidth}px` : ''}`);
  const audio = (scene.audio || []).map((a) => `${a.id} ${a.role || 'sound'} "${a.name || ''}" at ${a.start}s${a.duration ? ` for ${a.duration}s` : ''}${a.words ? `, ${a.words.length} words` : ''}${a.beats ? `, ${a.beats.bpm} bpm` : ''}`);
  return {
    title: scene.title || '', duration: scene.duration, loop: !!scene.playback?.loop,
    breakpoints: bps, layers: count(scene.layers || []), audio,
    markers: (scene.markers || []).map((m) => `${m.t}s ${m.label || m.id || ''}`.trim()),
    keyMoments: keyMoments(scene),
    outline: (scene.layers || []).flatMap((l) => layer(l, 0)).join('\n'),
  };
}

/** Frames of the scene (JPEG) at given times, or at its key moments, into a folder. */
export async function sceneStills(scene, opts = {}) {
  const times = Array.isArray(opts.times) && opts.times.length ? opts.times.map(Number).filter((t) => t >= 0).slice(0, 24) : 'settled';
  const out = resolve(opts.out || 'stills');
  const r = await withLocalMedia(scene, async (sc) => renderStills({ scene: sc, playerBase: await playerBase(opts.player), times, width: opts.width || 1280 }));
  try {
    mkdirSync(out, { recursive: true });
    const files = r.files.map((f) => { const to = join(out, basename(f.file)); copyFileSync(f.file, to); return { t: f.t, file: to }; });
    return { files, issues: r.issues, layout: r.layout || [] };
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
}

/** Renders the scene to a video file (MP4 or WebM), reporting progress. */
export async function renderScene(scene, opts = {}) {
  if (!(await renderStatus()).ffmpeg) throw new Error('ffmpeg is not installed (Windows: winget install Gyan.FFmpeg; macOS: brew install ffmpeg).');
  return withLocalMedia(scene, (sc) => renderLocal(sc, opts));
}
/** The scene's sound alone, as a render would mix it, into out (an MP3). False when it has none. */
export async function mixSceneSound(scene, out, opts = {}) {
  const { mixSound } = await import('./studio-render.mjs');
  return withLocalMedia(scene, async (sc) => mixSound(sc, await playerBase(opts.player), out));
}
async function renderLocal(scene, opts) {
  const job = startRender({ scene, playerBase: await playerBase(opts.player), width: opts.width, height: opts.height, fps: opts.fps, format: opts.format, transparent: opts.transparent, composite: opts.composite, cover: opts.cover, blur: opts.blur });
  for (;;) {
    await sleep(700);
    const i = jobInfo(job.id);
    if (i.state === 'error' || i.state === 'cancelled') throw new Error(i.error || 'The render stopped.');
    opts.onProgress?.(i.done, i.total);
    if (i.state === 'done') {
      const f = jobFile(job.id);
      const out = resolve(opts.out || i.name);
      if (resolve(f.file) !== out) { mkdirSync(dirname(out), { recursive: true }); copyFileSync(f.file, out); }
      let cover = '';
      const c = jobCover(job.id);
      if (c) { cover = out.replace(/\.[a-z0-9]+$/i, '-cover.png'); copyFileSync(c, cover); }
      return { file: out, bytes: i.bytes, seconds: i.seconds, warnings: i.warnings, cover, gpu: i.gpu, encoder: i.encoder, workers: i.workers };
    }
  }
}

/** An audio file's samples as mono 44.1 kHz floats (decoded by ffmpeg). */
function decode(file) {
  return new Promise((ok, bad) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const parts = [];
    let err = '';
    p.stdout.on('data', (d) => parts.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => bad(new Error('ffmpeg is not installed.')));
    p.on('exit', (c) => {
      if (c !== 0) return bad(new Error(`Could not read the audio: ${err.trim().slice(-200)}`));
      const b = Buffer.concat(parts);
      ok(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
  });
}

/**
 * Music analysis: tempo, beat grid, each beat's strength and a loudness and bass envelope. The same
 * method as the Studio's (apps/studio/src/lib/beats.ts), so the numbers match what it shows.
 */
export async function analyseBeats(file) {
  if (!existsSync(file)) throw fail(`No file at ${file}.`);
  const mono = await decode(file);
  const sr = 44100, FPS = 86, n = mono.length;
  const hop = Math.max(1, Math.round(sr / FPS));
  const frames = Math.floor(n / hop);
  const energy = new Float32Array(frames), bass = new Float32Array(frames);
  const a = Math.exp((-2 * Math.PI * 150) / sr);
  let lp = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0, b = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) { const x = mono[i]; lp = a * lp + (1 - a) * x; e += x * x; b += lp * lp; }
    energy[f] = Math.sqrt(e / hop);
    bass[f] = Math.sqrt(b / hop);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const d = Math.log1p(energy[f] * 40) - Math.log1p(energy[f - 1] * 40);
    const db = Math.log1p(bass[f] * 60) - Math.log1p(bass[f - 1] * 60);
    onset[f] = Math.max(0, d) + 0.6 * Math.max(0, db);
  }
  let bestLag = 0, best = -Infinity;
  for (let lag = Math.round((60 / 180) * FPS); lag <= Math.round(FPS); lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += onset[f] * onset[f - lag];
    s *= Math.exp(-0.5 * (Math.log2((60 * FPS) / lag / 120) / 1.2) ** 2);
    if (s > best) { best = s; bestLag = lag; }
  }
  const bpm = bestLag ? (60 * FPS) / bestLag : 120;
  let phase = 0, bestSum = -Infinity;
  for (let p = 0; p < bestLag; p++) { let s = 0; for (let f = p; f < frames; f += bestLag) s += onset[f]; if (s > bestSum) { bestSum = s; phase = p; } }
  const win = Math.round(0.04 * FPS);
  const times = [], raw = [];
  for (let f = phase; bestLag && f < frames; f += bestLag) {
    let at = f, m = onset[f];
    for (let k = Math.max(0, f - win); k <= Math.min(frames - 1, f + win); k++) if (onset[k] > m) { m = onset[k]; at = k; }
    times.push(at / FPS); raw.push(m);
  }
  const norm = (arr) => { const top = Math.max(1e-9, ...arr); return arr.map((v) => v / top); };
  const on = norm(raw);
  const loud = norm(times.map((t) => energy[Math.min(frames - 1, Math.round(t * FPS))]));
  const low = norm(times.map((t) => bass[Math.min(frames - 1, Math.round(t * FPS))]));
  const cn = norm(on.map((v, i) => { const around = [on[i - 2], on[i - 1], on[i + 1], on[i + 2]].filter((x) => x !== undefined); const mean = around.length ? around.reduce((s, x) => s + x, 0) / around.length : v; return Math.max(0, v - mean); }));
  const strengths = on.map((v, i) => Math.round((0.4 * v + 0.25 * cn[i] + 0.2 * loud[i] + 0.15 * low[i]) * 100) / 100);
  const EF = 20, per = Math.max(1, Math.round(FPS / EF));
  const loudEnv = [], bassEnv = [];
  for (let f = 0; f < frames; f += per) {
    let e = 0, b = 0;
    for (let k = f; k < Math.min(frames, f + per); k++) { e = Math.max(e, energy[k]); b = Math.max(b, bass[k]); }
    loudEnv.push(e); bassEnv.push(b);
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  const beats = { bpm: Math.round(bpm * 10) / 10, times: times.map((t) => Math.round(t * 1000) / 1000), strengths };
  // The strongest moments (beats well above the rest, 1.6 s apart): where a big reveal should land.
  const strong = [];
  for (const b of beats.times.map((t, i) => ({ t, s: strengths[i] })).sort((x, y) => y.s - x.s)) {
    if (b.s < 0.55) break;
    if (strong.every((o) => Math.abs(o.t - b.t) >= 1.6)) strong.push(b);
  }
  return { seconds: Math.round((n / sr) * 100) / 100, beats, envelope: { fps: EF, loud: norm(loudEnv).map(r2), bass: norm(bassEnv).map(r2) }, strong: strong.sort((x, y) => x.t - y.t) };
}

const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm', '.aac': 'audio/aac' };

/** Every word of a spoken audio file with its time, and how it is delivered (the kit's speech recognition). */
export async function transcribeFile(file, opts = {}) {
  if (!existsSync(file)) throw fail(`No file at ${file}.`);
  const st = await transcribeStatus();
  if (!st.program || !Object.values(st.models).some((m) => m.installed)) throw new Error('Install speech recognition first (in the Studio: select an audio clip, Words, Install; or POST /studio/transcribe/install to the running kit).');
  const type = AUDIO_TYPES[extname(file).toLowerCase()] || 'audio/mpeg';
  const job = startTranscribe({ src: `data:${type};base64,${readFileSync(file).toString('base64')}`, language: opts.language, model: opts.model });
  for (;;) {
    await sleep(700);
    const i = transcribeJob(job.id);
    if (!i) throw new Error('The transcription was lost.');
    if (i.state === 'error') throw new Error(i.error);
    opts.onProgress?.(i.step);
    if (i.state === 'done') return i.result;
  }
}

/**
 * Splits a sound or video file into the voice and everything else (music and effects), as voice.wav and music.wav in
 * a folder (with `stems`, also drums, bass, other and vocals). The kit's voice and music separation, on this computer.
 */
export async function separateAudio(file, opts = {}) {
  if (!existsSync(file)) throw fail(`No file at ${file}.`);
  const st = await separateStatus();
  if (!st.runtime || !st.model) throw new Error('Install voice and music separation first (in the Studio: select a sound or footage, Separate voice and music, Install; or POST /studio/separate/install to the running kit).');
  const r = await separateFile(file, { stems: !!opts.stems, onProgress: opts.onProgress });
  const out = resolve(opts.out || 'separated');
  mkdirSync(out, { recursive: true });
  const files = { voice: join(out, 'voice.wav'), music: join(out, 'music.wav') };
  writeFileSync(files.voice, r.voice);
  writeFileSync(files.music, r.music);
  for (const [name, buf] of Object.entries(r.stems || {})) { files[name] = join(out, `${name}.wav`); writeFileSync(files[name], buf); }
  return { seconds: r.seconds, files };
}

/** A Studio link that opens the scene there (the scene travels compressed in the link, as Share link does). */
export function studioLink(scene, studio = SITE) {
  const data = deflateRawSync(Buffer.from(JSON.stringify(scene))).toString('base64url');
  return `${studio.replace(/\/?$/, '/')}#s=1.${data}`;
}

/** Validates a scene and writes it to a file (for AI apps that cannot write files themselves). */
export async function saveScene(scene, path, opts = {}) {
  const r = await checkScene(scene, opts);
  if (!r.ok) return { saved: false, ...r };
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), JSON.stringify(scene, null, 2));
  return { saved: true, file: resolve(path), ...r };
}

const SKILL_DIRS = [resolve(HERE_TOOLS, '../../../../skills/kinetic-scenes'), resolve(HERE_TOOLS, '../../../skills/kinetic-scenes')];
const GUIDE_TOPICS = { workflow: 'SKILL.md', format: 'reference/scene-format.md', presets: 'reference/presets.md', rules: 'reference/motion-rules.md', sounds: 'reference/sounds.md', styles: 'reference/styles.md' };

/** The Kinetic Scenes skill (how to make a good scene, the format, every preset, the rules): the kit's copy, or the published one. */
export async function sceneGuide(topic = 'workflow') {
  const file = GUIDE_TOPICS[topic] ?? GUIDE_TOPICS.workflow;
  for (const dir of SKILL_DIRS) {
    const p = join(dir, file);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  const r = await fetch(`${SITE}skill/${file}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('The Kinetic Scenes guide could not be read.');
  return r.text();
}

/** Silent stretches in a sound file (ffmpeg silencedetect): [{ start, end }]. */
function silences(file, { db = -38, min = 0.25 } = {}) {
  return new Promise((ok) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=n=${db}dB:d=${min}`, '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => ok([]));
    p.on('exit', () => {
      const out = [];
      for (const m of err.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)) out.push({ start: +m[1], end: +m[2] });
      ok(out);
    });
  });
}

/**
 * Checks a voice line against its script: words that came out differently, and pauses inside a phrase (longer than
 * `maxGap` seconds where the script has no punctuation). A text-to-speech voice sometimes stops mid-phrase ("page
 * builder … Pro plan"); the words still match and speech recognition stretches a word over the gap, so the pause is
 * measured in the sound itself and placed between the words around it. Such a pause sounds machine-made.
 */
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** A whole number in words, joined ("sevenhundredthirty"); `and` adds the British "and" after hundred. */
function numberWords(n, and = false) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + 'hundred' + (n % 100 ? (and ? 'and' : '') + numberWords(n % 100, and) : '');
  if (n < 1e6) return numberWords(Math.floor(n / 1000), and) + 'thousand' + (n % 1000 ? (and && n % 1000 < 100 ? 'and' : '') + numberWords(n % 1000, and) : '');
  return null;
}
const ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
/**
 * The ways a number written in digits is spoken, each joined into one word, so "730" (or "7:30") matches "seven thirty"
 * and "seven hundred thirty", "2026" matches "twenty twenty six", "705" "seven oh five", "1st" "first", "50%" "fifty
 * percent". Speech recognition writes numbers as digits; scripts usually spell them out (or the other way round).
 */
function spokenForms(x) {
  const m = /^(\d{1,6})(st|nd|rd|th|%)?$/.exec(x);
  if (!m) return [];
  const n = +m[1], out = new Set([numberWords(n), numberWords(n, true)]);
  // Times and years are read in pairs: 730 "seven thirty", 1045 "ten forty five", 705 "seven oh five", 700 "seven hundred".
  if (m[1].length >= 3 && m[1].length <= 4) {
    const hi = Math.floor(n / 100), lo = n % 100;
    out.add(numberWords(hi) + (lo === 0 ? 'hundred' : lo < 10 ? 'oh' + ONES[lo] : numberWords(lo)));
    if (lo === 0) out.add(numberWords(hi) + "o'clock");
  }
  if (m[2] === '%') return [...out].map((w) => w + 'percent');
  if (m[2]) return [...out].map((w) => { const last = Object.keys(ORD).find((k) => w.endsWith(k)); return last ? w.slice(0, -last.length) + ORD[last] : w.endsWith('y') ? w.slice(0, -1) + 'ieth' : w + 'th'; });
  return [...out].filter(Boolean);
}
/** Two normalised words are the same: equal, or one is digits the other spells out. */
const sameWord = (a, b) => a === b || spokenForms(a).includes(b) || spokenForms(b).includes(a);

export async function voiceCheck(file, script, { maxGap = 0.4, language } = {}) {
  const { words } = await transcribeFile(file, { language });
  const norm = (x) => String(x).toLowerCase().replace(/\+/g, 'plus').replace(/[^\p{L}\p{N}'%]+/gu, '');
  // Script tokens, each knowing whether punctuation follows it (a pause there is natural).
  const tokens = String(script).split(/\s+/).filter(Boolean).map((raw) => ({ w: norm(raw), stop: /[.,;:!?…—–-]["')\]]*$/.test(raw) })).filter((t) => t.w);
  const heard = words.map((w) => ({ ...w, n: norm(w.w) })).filter((w) => w.n);
  const problems = [];
  // Line the words up in order. Heard words that join into one script word ("Unison Plus" = "Unisonplus") count as
  // it; either side may skip a word (a misheard name).
  const at = []; // { tok, t0, t1 } script words with the time they were said
  let i = 0;
  for (let h = 0; h < heard.length;) {
    let k = -1, used = 1, span = 1;
    for (let j = i; j < Math.min(tokens.length, i + 4) && k < 0; j++) {
      let joined = '';
      for (let n = 0; n < 3 && h + n < heard.length; n++) { joined += heard[h + n].n; if (sameWord(joined, tokens[j].w)) { k = j; used = n + 1; break; } }
      // …or one heard word for several script words ("ProPageBuilder" = "Pro page builder").
      let glued = '';
      for (let n = 0; n < 4 && j + n < tokens.length && k < 0; n++) { glued += tokens[j + n].w; if ((n || /\d/.test(heard[h].n)) && sameWord(glued, heard[h].n)) { k = j; span = n + 1; } }
    }
    if (k < 0) { problems.push({ kind: 'word', t: heard[h].t, text: `heard "${heard[h].w}" where the script has "${tokens[i]?.w ?? '(nothing)'}"` }); h++; continue; }
    if (k > i) problems.push({ kind: 'word', t: heard[h].t, text: `"${tokens.slice(i, k).map((x) => x.w).join(' ')}" not heard` });
    const last = heard[h + used - 1];
    at.push({ tok: tokens[k + span - 1], t0: heard[h].t, t1: last.t + last.d, said: heard.slice(h, h + used).map((x) => x.w).join(' ') });
    i = k + span;
    h += used;
  }
  // Pauses: silences in the sound, between the start of one script word and the start of the next.
  const quiet = (await silences(file)).filter((q) => q.end - q.start > maxGap);
  for (let j = 0; j + 1 < at.length; j++) {
    const a = at[j], b = at[j + 1];
    if (a.tok.stop) continue;
    const q = quiet.find((x) => x.start >= a.t0 && x.start < b.t0 + 0.05);
    if (q) problems.push({ kind: 'pause', t: q.start, text: `${(q.end - q.start).toFixed(2)} s pause between "${a.said}" and "${b.said}" (no punctuation there): sounds machine-made` });
  }
  // A line written as a question should sound like one.
  let intonation = null;
  if (/\?["')\]]*\s*$/.test(String(script)) && words.length) {
    const lastWord = words[words.length - 1];
    intonation = await endPitch(file, lastWord.t + lastWord.d);
    // A yes/no question should rise at the end; the pitch decides. A What / Why / How / When / Where / Who / Which
    // question falls when said well, so its pitch proves nothing either way and it is not flagged (it used to be judged
    // by the transcript's "?", which flagged well-said wh-questions whenever the recogniser left the "?" off). The
    // recogniser adds "?" to anything worded like a question, however flatly said, so it only counts when the pitch of
    // a yes/no question could not be read. A measured rise is evidence, not proof: see docs/making-videos.md.
    const heardQuestion = /\?["')\]]*$/.test(lastWord.w);
    const falls = /^\W*((so|and|but|then)\s+)?(what|why|how|when|where|who|which)\b/i.test(String(script).split(/[.!?]\s+/).pop());
    if (!falls && (intonation.change === null ? !heardQuestion : !intonation.rises)) problems.push({ kind: 'question', t: lastWord.t, text: `written as a question but sounds like a statement (the pitch ${intonation.change === null ? 'could not be read' : `moves ${intonation.change > 0 ? '+' : ''}${intonation.change}% at the end`}, and the transcript ends "${lastWord.w}")` });
  }
  const inner = quiet.filter((q) => at.length && q.start > at[0].t0 && q.end < at[at.length - 1].t1);
  return { ok: !problems.length, problems: problems.sort((x, y) => x.t - y.t), heard: words.map((w) => w.w).join(' '), longestGap: inner.length ? Math.max(...inner.map((q) => q.end - q.start)) : 0, intonation };
}

/**
 * Reviews a whole script: { lines: [...], voice } is spoken through the running kit (lines already spoken come from its
 * cache, so this is the same audio the voice-over uses) and each line goes through voiceCheck on its own. Heard alone, a
 * line shows what a whole voice-over hides: the recogniser leans on the words around a slip and corrects it.
 */
export async function voiceReview(spec, { kit = 'http://127.0.0.1:8787', onStep = () => {} } = {}) {
  const lines = (spec.lines || []).map((l) => String(l).trim()).filter(Boolean);
  if (!lines.length) throw fail('Give the script: { "lines": [...], "voice": "..." }.');
  const dir = join(tmpdir(), `upw-review-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const out = [];
  try {
    for (const [i, text] of lines.entries()) {
      onStep(`Line ${i + 1} of ${lines.length}`);
      const start = await fetch(`${kit}/studio/voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: [text], voice: spec.voice }) }).catch(() => null);
      if (!start?.ok) throw fail('The kit is not answering: start it first.');
      const { id } = await start.json();
      let job;
      do {
        await new Promise((ok) => setTimeout(ok, 1500));
        job = await (await fetch(`${kit}/studio/voice/${id}`)).json();
      } while (!['done', 'error', 'failed'].includes(job.state));
      if (job.state !== 'done') { out.push({ text, ok: false, heard: '', problems: [{ t: 0, text: job.error || 'could not be spoken' }] }); continue; }
      const f = join(dir, `line${i}.mp3`);
      writeFileSync(f, Buffer.from(job.result.src.slice(job.result.src.indexOf(',') + 1), 'base64'));
      const r = await voiceCheck(f, text);
      out.push({ text, ok: r.ok, heard: r.heard, problems: r.problems, intonation: r.intonation });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { ok: out.every((l) => l.ok), lines: out };
}

/**
 * How the pitch moves at the end of a spoken line: the last quarter second of voice against the half second before it.
 * A question usually rises (rises: 6% or more). `change` is null when too little of the end is voiced to tell.
 */
export async function endPitch(file, end) {
  const rate = 16000;
  const pcm = await new Promise((ok, bad) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, end - 1.2)), '-t', '1.4', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-']);
    const parts = [];
    p.stdout.on('data', (d) => parts.push(d));
    p.on('error', bad);
    p.on('close', () => ok(Buffer.concat(parts)));
  });
  const x = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
  const win = 640, hop = 160, lo = Math.floor(rate / 400), hi = Math.floor(rate / 70);
  const track = [];
  for (let s = 0; s + win + hi < x.length; s += hop) {
    let e0 = 0;
    for (let i = 0; i < win; i++) e0 += x[s + i] * x[s + i];
    if (e0 / win < 2e-4) continue;
    let best = 0, lag = 0;
    for (let l = lo; l <= hi; l++) {
      let c = 0, e1 = 0;
      for (let i = 0; i < win; i++) { c += x[s + i] * x[s + i + l]; e1 += x[s + i + l] * x[s + i + l]; }
      const r = c / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best) { best = r; lag = l; }
    }
    if (best > 0.6) track.push({ t: s / rate, f: rate / lag });
  }
  if (track.length < 12) return { change: null, rises: false };
  const median = (a) => { const v = a.map((p) => p.f).sort((m, n) => m - n); return v[v.length >> 1]; };
  const lastT = track[track.length - 1].t;
  const tail = track.filter((p) => p.t > lastT - 0.25), before = track.filter((p) => p.t <= lastT - 0.25 && p.t > lastT - 0.75);
  if (tail.length < 4 || before.length < 4) return { change: null, rises: false };
  const change = Math.round((median(tail) / median(before) - 1) * 100);
  return { change, rises: change >= 6 };
}
