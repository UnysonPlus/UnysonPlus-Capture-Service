// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Kinetic Scenes' video export: renders a scene to MP4 or WebM, frame by frame.
//
// Studio scenes are seekable (every frame is a pure function of time, 3D included), so the render
// is exact: headless Chrome shows the scene at the requested size, jumps to each frame in turn, takes a
// screenshot and pipes it into ffmpeg. Nothing plays in real time, so a slow machine only renders
// slower, never drops or blurs frames. The scene picks its breakpoint layout from the video's width
// (a vertical 1080x1920 render uses the mobile layout, as a phone would).
//
// Jobs run one at a time in the background; the Studio polls for progress and downloads the file.
import { ffmpegNeeded } from './studio-ffmpeg.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, mkdirSync, renameSync, statSync, existsSync, readdirSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const OUT = join(process.env.CAPTURE_OUT || join(process.cwd(), 'capture-out'), 'studio-renders');
const MAX_FRAMES = 60 * 60 * 3; // three minutes at 60 fps
const jobs = new Map();
let queue = Promise.resolve();

let ffmpegBin = null;
async function findFfmpeg() {
  if (ffmpegBin) return ffmpegBin; // a missing one is asked for again: it may have been installed meanwhile
  ffmpegBin = await new Promise((resolve) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(''));
    p.on('exit', (code) => resolve(code === 0 ? (process.env.FFMPEG || 'ffmpeg') : ''));
  });
  return ffmpegBin;
}

/*
 * The graphics card. Encoding: a hardware H.264 encoder when this computer has one that works (NVIDIA NVENC, AMD AMF,
 * Intel Quick Sync, Apple VideoToolbox), tried once with a tiny test clip; the processor (libx264) otherwise.
 * Drawing: Chrome on the graphics card, checked after launch (its WebGL renderer must not be the software one); the
 * software renderer (SwiftShader) otherwise. STUDIO_RENDER_GPU=0 turns both off.
 */
const GPU_OFF = /^(0|off|false|no)$/i.test(process.env.STUDIO_RENDER_GPU || '');
const ENCODERS = [
  { name: 'h264_nvenc', label: 'NVIDIA NVENC', args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0'] },
  { name: 'h264_amf', label: 'AMD AMF', args: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '20'] },
  { name: 'h264_qsv', label: 'Intel Quick Sync', args: ['-c:v', 'h264_qsv', '-global_quality', '20'] },
  { name: 'h264_videotoolbox', label: 'Apple VideoToolbox', args: ['-c:v', 'h264_videotoolbox', '-q:v', '65'] },
];
let hwEncoder; // undefined = not tried yet, null = none works here
function findHwEncoder(ffmpeg) {
  if (hwEncoder !== undefined) return hwEncoder;
  hwEncoder = null;
  if (GPU_OFF) return hwEncoder;
  const list = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 15000, windowsHide: true }).stdout || '';
  for (const e of ENCODERS) {
    if (!list.includes(e.name)) continue;
    // Listed is not working: the driver or the card must take a real (tiny) clip.
    const t = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.2', ...e.args, '-pix_fmt', 'yuv420p', '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (t.status === 0) { hwEncoder = e; break; }
  }
  return hwEncoder;
}

/** Chrome on the graphics card when it really draws there; the software renderer otherwise. Returns { browser, gpu }. */
async function launchRenderer() {
  const channel = process.env.CAPTURE_CHANNEL || 'chrome';
  const soft = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'];
  if (!GPU_OFF) {
    const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'gl';
    let browser;
    try {
      browser = await chromium.launch({ channel, headless: true, args: [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--force_high_performance_gpu', '--hide-scrollbars'] });
      const p = await browser.newPage();
      const gpu = await p.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl');
        const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return gl ? String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : '';
      });
      await p.close();
      if (gpu && !/swiftshader|software|llvmpipe|basic render/i.test(gpu)) {
        // "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti (0x00002191) Direct3D11 …)" → "NVIDIA GeForce GTX 1660 Ti"
        const name = (/ANGLE \([^,]+, ([^(,]+)/.exec(gpu)?.[1] || gpu).trim();
        return { browser, gpu: name };
      }
    } catch { /* no usable graphics card here: the software renderer below */ }
    await browser?.close().catch(() => {});
  }
  return { browser: await chromium.launch({ channel, headless: true, args: soft }), gpu: null };
}

/**
 * Frames are taken in several tabs at once (taking a screenshot, not drawing it, is what costs the time); the encoder
 * still gets them in order. STUDIO_RENDER_WORKERS sets the number; by default a quarter of the processor's threads, 2-6.
 */
const WORKERS = Math.max(1, Math.min(8, +process.env.STUDIO_RENDER_WORKERS || Math.max(2, Math.min(6, Math.floor(availableParallelism() / 4)))));

/*
 * Footage made easy to seek. A camera-ready recording has a keyframe every few seconds, so each frame of the render
 * (a seek) decodes from the last keyframe: with several workers that is most of the time. Before rendering, each MP4
 * footage layer gets a copy with a keyframe on every frame, at full size (close-ups stay sharp), cached by source so a
 * re-render skips it; the render plays the copies from a small local server. Sound still comes from the originals.
 * STUDIO_RENDER_PROXY=0 turns it off. 35 s → 7.5 s for 10 s of a 3200x1800 screencast with 4 workers.
 */
const PROXIES = join(OUT, '..', 'studio-render-proxies');
async function sourceStamp(src) {
  try { const r = await fetch(src, { method: 'HEAD' }); return `${r.headers.get('content-length') || ''}:${r.headers.get('last-modified') || ''}`; } catch { return ''; }
}
async function videoProxies(scene, ffmpeg, job) {
  const none = { scene, close: () => {} };
  if (/^(0|off|false|no)$/i.test(process.env.STUDIO_RENDER_PROXY || '')) return none;
  const copy = JSON.parse(JSON.stringify(scene));
  const vids = [];
  const walk = (list) => (list || []).forEach((l) => {
    if (l.layers) walk(l.layers);
    if (l.item) walk([l.item]);
    // MP4 only: a WebM or MOV may carry transparency, which an H.264 copy would lose.
    if (l.type === 'video' && typeof l.src === 'string' && (/^https?:/.test(l.src) ? /\.(mp4|m4v)(\?|$)/i.test(l.src) : /^data:video\/mp4/.test(l.src))) vids.push(l);
  });
  walk(copy.layers);
  if (!vids.length) return none;
  mkdirSync(PROXIES, { recursive: true });
  try { for (const f of readdirSync(PROXIES)) { const p = join(PROXIES, f); if (Date.now() - statSync(p).mtimeMs > 7 * 24 * 3600 * 1000) unlinkSync(p); } } catch { /* best-effort */ }
  const made = new Map();
  for (const l of vids) {
    if (!made.has(l.src)) {
      let input = l.src;
      const key = createHash('sha1').update(input.startsWith('data:') ? input : `${input}|${await sourceStamp(input)}`).digest('hex').slice(0, 16);
      const out = join(PROXIES, `${key}.mp4`);
      if (!existsSync(out)) {
        job.step = 'Preparing footage';
        if (input.startsWith('data:')) { input = join(PROXIES, `${key}.src.mp4`); writeFileSync(input, Buffer.from(l.src.slice(l.src.indexOf(',') + 1), 'base64')); }
        const part = `${out}.part.mp4`;
        // Not spawnSync: the footage may be served by this very process (the kit, or the CLI's local server).
        const r = await new Promise((done) => {
          const p = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-g', '1', '-pix_fmt', 'yuv420p', '-an', part],
            { stdio: 'ignore', windowsHide: true });
          p.on('error', () => done({ status: 1 }));
          p.on('exit', (code) => done({ status: code }));
        });
        if (input !== l.src) try { unlinkSync(input); } catch { /* best-effort */ }
        if (r.status !== 0) { try { unlinkSync(part); } catch { /* none */ } made.set(l.src, null); continue; } // render from the original
        renameSync(part, out);
      }
      made.set(l.src, `${key}.mp4`);
    }
  }
  if (![...made.values()].some(Boolean)) return none;
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url || '').split('?')[0].replace(/^\/p\//, ''));
    const file = join(PROXIES, name);
    if (!/^[0-9a-f]{16}\.mp4$/.test(name) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    const size = statSync(file).size;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
      const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      res.writeHead(206, { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      createReadStream(file).pipe(res);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  for (const l of vids) { const p = made.get(l.src); if (p) l.src = `http://127.0.0.1:${port}/p/${p}`; }
  job.step = '';
  return { scene: copy, close: () => server.close() };
}

/** What the Studio needs to know before offering video export. */
export async function renderStatus() {
  return { ffmpeg: !!(await findFfmpeg()), busy: [...jobs.values()].some((j) => j.state === 'rendering' || j.state === 'queued') };
}

const clampInt = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : d);

/** Starts a render job; returns its id at once. */
export function startRender(input) {
  const scene = input && input.scene;
  if (!scene || scene.format !== 'unysonplus-scene') { const e = new Error('Send a scene file.'); e.code = 400; throw e; }
  const playerBase = String(input.playerBase || '');
  if (!/^https?:\/\/[^\s"'<>]+\/$/.test(playerBase)) { const e = new Error('Send the player address (playerBase).'); e.code = 400; throw e; }
  const width = clampInt(input.width, 160, 3840, 1920) & ~1; // even sizes for yuv420p
  const height = clampInt(input.height, 160, 3840, 1080) & ~1;
  const fps = [24, 25, 30, 50, 60].includes(+input.fps) ? +input.fps : 30;
  const format = input.format === 'webm' ? 'webm' : input.format === 'mov' ? 'mov' : 'mp4';
  // See-through (graphics to lay over footage): WebM with alpha or ProRes 4444; MP4 has no alpha.
  const transparent = !!input.transparent && format !== 'mp4';
  // A full composite shows reference footage; graphics-only leaves it out.
  const composite = !!input.composite;
  const cover = !!input.cover;
  // Motion blur: sub-frames per frame (2-16), or off.
  const blur = input.blur === true ? 8 : clampInt(input.blur, 0, 16, 0);
  const duration = Math.max(0.1, Math.min(600, +scene.duration || 1));
  const frames = Math.min(MAX_FRAMES, Math.round(duration * fps));
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const slug = String(scene.title || 'scene').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scene';
  const tag = transparent ? '-alpha' : '';
  const job = { id, state: 'queued', done: 0, total: frames, width, height, fps, format, transparent, composite, cover, blur, file: join(OUT, `${slug}-${width}x${height}${tag}-${id}.${format}`), name: `${slug}-${width}x${height}${tag}.${format}`, error: '', startedAt: Date.now(), cancel: false };
  jobs.set(id, job);
  queue = queue.then(() => run(job, scene, playerBase)).catch(() => {});
  return job;
}

export function jobInfo(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { id: j.id, state: j.state, done: j.done, total: j.total, error: j.error, name: j.name, bytes: j.bytes || 0, seconds: Math.round((Date.now() - j.startedAt) / 1000), warnings: j.warnings || [], step: j.step || '', workers: j.workers || 1, gpu: j.gpu || null, encoder: j.encoder || '', cover: j.coverFile && existsSync(j.coverFile) ? `${j.name.replace(/\.[a-z0-9]+$/, '')}-cover.png` : '' };
}
export const jobFile = (id) => { const j = jobs.get(id); return j && j.state === 'done' && existsSync(j.file) ? j : null; };
/** The cover image a render made (its poster frame), if it made one. */
export const jobCover = (id) => { const j = jobs.get(id); return j && j.coverFile && existsSync(j.coverFile) ? j.coverFile : null; };
export function cancelRender(id) { const j = jobs.get(id); if (j) j.cancel = true; return !!j; }

export function pageHtml(scene, playerBase, opts = {}) {
  // The stage fills the window exactly; the scene's own trigger is ignored (the render seeks it).
  const s = { ...scene, stage: { ...scene.stage, heightMode: 'fill', heightOffset: 0 }, playback: { ...scene.playback, trigger: 'manual' } };
  const json = JSON.stringify(s).replace(/</g, '\\u003c');
  const bg = opts.transparent ? 'transparent' : '#000';
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${bg};overflow:hidden}</style>
<script>window.UPW_SCENE_ASSET_BASE=${JSON.stringify(playerBase)}</script>
<script src="${playerBase}scene-player.js" data-auto-mount="false"></script></head>
<body><div id="h"></div><script>
window.__ready = false;
try {
  const sc = ${json};
  window.P = UnysonPlusScene.mount(document.getElementById('h'), sc, { autoplay: false, editor: true, allowCode: true, audio: false, reference: ${opts.composite ? 'true' : 'false'} });
  P.seek(0);
  const models = (function count(ls){ return ls.reduce(function(n,l){ return n + (l.type === 'model' ? 1 : 0) + (l.layers ? count(l.layers) : 0); }, 0); })(sc.layers);
  if (typeof P.whenReady === 'function') {
    // Fonts, images (decoded), background images and every 3D model; what never arrived is reported.
    P.whenReady(30000).then(function (r) { window.__missing = r.missing; P.seek(0); window.__ready = true; });
  } else {
    // Older players: ready once fonts are in and every 3D layer has its canvas.
    document.fonts.ready.then(function wait(){ if (document.querySelectorAll('.upw-3d canvas').length >= models) { setTimeout(function(){ window.__ready = true; }, 600); } else setTimeout(wait, 100); });
  }
} catch (e) { window.__error = String(e && e.message || e); }
</script></body></html>`;
}

/** Length of an audio file in seconds (ffprobe), or null. */
function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('exit', () => { const v = parseFloat(out); resolve(Number.isFinite(v) ? v : null); });
  });
}

/**
 * The scene's sound as ffmpeg inputs and one mix: each clip trimmed, faded, delayed to its start and
 * mixed at its volume. Uploaded clips (data: URLs) are written to a temp folder; addresses downloaded.
 * Built-in sounds ("sfx:<name>", on a track or attached to a clip) are synthesised by the scene's own
 * player in the render page, so the video carries exactly what the Studio plays.
 */
async function audioMix(scene, tmp, firstInput, page) {
  // The player works out the whole track (sound tracks plus clip sounds); older players only know tracks.
  const track = await page.evaluate((sc) => (window.UnysonPlusScene.soundTrack ? window.UnysonPlusScene.soundTrack(sc) : null), scene).catch(() => null);
  const list = [...(Array.isArray(track) ? track : (scene.audio || [])), ...footageSound(scene)];
  const clips = list.filter((a) => a && typeof a.src === 'string');
  if (!clips.length) return null;
  // When a voice is speaking (scene seconds): music is lowered under it, as the Studio plays it.
  const spans = await page.evaluate((all) => (window.UnysonPlusScene.voiceSpans ? window.UnysonPlusScene.voiceSpans(all) : []), clips).catch(() => []);
  const inputs = [];
  const parts = [];
  let k = 0;
  for (const c of clips) {
    let file = '';
    try {
      if (c.src.startsWith('data:')) {
        const comma = c.src.indexOf(',');
        const meta = c.src.slice(5, comma);
        const ext = (/audio\/([a-z0-9]+)/i.exec(meta) || [])[1] || 'bin';
        const body = c.src.slice(comma + 1);
        file = join(tmp, `a${k}.${ext.replace('mpeg', 'mp3')}`);
        writeFileSync(file, meta.includes(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body)));
      } else if (c.src.startsWith('sfx:')) {
        const b64 = await page.evaluate((src) => {
          const api = window.UnysonPlusScene;
          const bytes = api.sfxWav ? api.sfxWav(src) : null;
          if (!bytes) return null;
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return btoa(bin);
        }, c.src);
        if (!b64) throw new Error(`unknown built-in sound ${c.src}`);
        file = join(tmp, `a${k}.wav`);
        writeFileSync(file, Buffer.from(b64, 'base64'));
      } else if (/^https?:\/\//.test(c.src)) {
        const r = await fetch(c.src);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        file = join(tmp, `a${k}.audio`);
        writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      } else continue;
    } catch (e) {
      console.warn('[studio-render] skipped audio', c.id, String(e && e.message || e));
      continue;
    }
    const fileLen = await probeDuration(file);
    const trimIn = Math.max(0, +c.offset || 0);
    const len = Math.max(0.05, Math.min(c.duration > 0 ? c.duration : Infinity, fileLen != null ? fileLen - trimIn : Infinity));
    const finite = Number.isFinite(len);
    const vol = Math.max(0, Math.min(2, c.volume ?? 1));
    // At least 12 ms of fade at each end: a clip cut mid-sound otherwise clicks (inaudible as a fade).
    const fi = Math.max(0.012, +c.fadeIn || 0);
    const fo = Math.max(0.012, +c.fadeOut || 0);
    const delayMs = Math.round(Math.max(0, +c.start || 0) * 1000);
    const idx = firstInput + inputs.length / 2; // inputs holds "-i", file pairs
    inputs.push('-i', file);
    let chain = `[${idx}:a]atrim=start=${trimIn.toFixed(3)}${finite ? `:duration=${len.toFixed(3)}` : ''},asetpts=PTS-STARTPTS,volume=${vol.toFixed(3)}`;
    if (fi > 0) chain += `,afade=t=in:st=0:d=${fi.toFixed(3)}`;
    if (fo > 0 && finite) chain += `,afade=t=out:st=${Math.max(0, len - fo).toFixed(3)}:d=${fo.toFixed(3)}`;
    // Footage played faster or slower: its sound follows (atempo takes 0.5 to 2 per step).
    let rate = Math.max(0.25, Math.min(4, +c.rate || 1));
    while (Math.abs(rate - 1) > 1e-3) { const step = Math.max(0.5, Math.min(2, rate)); chain += `,atempo=${step.toFixed(4)}`; rate /= step; }
    chain += `,aresample=48000,adelay=delays=${delayMs}:all=1`;
    // Music ducks to 35% while the voice speaks (t is scene time once the clip has been delayed into place).
    if (c.role === 'music' && Array.isArray(spans) && spans.length) {
      const on = spans.map(([a, b]) => `between(t,${(a - 0.15).toFixed(2)},${(b + 0.25).toFixed(2)})`).join('+');
      chain += `,volume='if(${on},0.35,1)':eval=frame`;
    }
    chain += `[a${k}]`;
    parts.push(chain);
    k++;
  }
  if (!k) return null;
  // Mixed to the loudness platforms play at (-14 LUFS integrated, true peaks under -1 dB).
  const mix = `${Array.from({ length: k }, (_, i) => `[a${i}]`).join('')}amix=inputs=${k}:normalize=0:duration=longest,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000,apad[aout]`;
  return { inputs, filter: `${parts.join(';')};${mix}` };
}

/**
 * The scene's sound on its own, mixed exactly as a render mixes it (the same clips, fades, ducking and loudness) with no
 * frames drawn: seconds, not minutes. The page only needs the player for its sound track and built-in sounds. Returns
 * false when the scene has no sound.
 */
export async function mixSound(scene, playerBase, out) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error(ffmpegNeeded('Mixing the sound'));
  const tmp = join(tmpdir(), `upw-mix-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(tmp, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><script src="${playerBase}scene-player.js" data-auto-mount="false"></script>`, { waitUntil: 'load', timeout: 60000 });
    if (!(await page.evaluate(() => !!window.UnysonPlusScene))) throw new Error(`The scene player did not load from ${playerBase}.`);
    const mix = await audioMix(scene, tmp, 0, page);
    if (!mix) return false;
    const seconds = Math.max(0.1, Math.min(600, +scene.duration || 1));
    await new Promise((ok, bad) => {
      const p = spawn(ffmpeg, ['-y', '-loglevel', 'error', ...mix.inputs, '-filter_complex', mix.filter, '-map', '[aout]', '-t', String(seconds), '-c:a', 'libmp3lame', '-b:a', '128k', out], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', bad);
      p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`The sound could not be mixed: ${err.slice(-300)}`))));
    });
    return true;
  } finally {
    await browser.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Footage layers whose own sound is mixed in (layer.sound = its volume), as audio clips on the scene's clock:
 * a layer inside groups starts at the sum of their starts; its length is cut at the layer's out point.
 */
function footageSound(scene) {
  const out = [];
  const walk = (list, offset) => {
    for (const l of list || []) {
      if (l.type === 'group') { walk(l.layers, offset + (l.start || 0)); continue; }
      if (l.type !== 'video' || !(l.sound > 0) || l.reference || typeof l.src !== 'string') continue;
      const start = offset + (l.start || 0);
      const rate = l.rate || 1;
      out.push({ id: l.id, src: l.src, start, offset: l.offset || 0, volume: l.sound, rate, ...(typeof l.end === 'number' ? { duration: (l.end - (l.start || 0)) * rate } : {}) });
    }
  };
  walk(scene.layers, 0);
  return out;
}

async function run(job, scene, playerBase) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) { job.state = 'error'; job.error = ffmpegNeeded('Video export'); job.needs = 'ffmpeg'; return; }
  mkdirSync(OUT, { recursive: true });
  pruneOld();
  job.state = 'rendering';
  let browser;
  let enc;
  let tmp = '';
  let proxied = null;
  try {
    proxied = await videoProxies(scene, ffmpeg, job);
    const shown = proxied.scene;
    const launched = await launchRenderer();
    browser = launched.browser;
    job.gpu = launched.gpu; // the card drawing the frames, or null (software)
    const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
    await page.setContent(pageHtml(shown, playerBase, { transparent: job.transparent, composite: job.composite }), { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 60000 });
    const err = await page.evaluate(() => window.__error);
    if (err) throw new Error(`The scene could not be played: ${err}`);
    const missing = await page.evaluate(() => window.__missing || []);
    if (missing.length) {
      job.warnings = missing;
      console.warn('[studio-render] rendering without:', missing.join(', '));
    }

    // See-through frames go as PNG (JPEG has no alpha).
    // Motion blur: S sub-frames per frame, spread over half the frame's time (a 180-degree shutter, as a film camera
    // exposes), averaged by ffmpeg into one frame. Off (1) by default; it multiplies the work by S.
    const S = job.blur > 1 ? job.blur : 1;
    const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(job.fps * S), '-c:v', job.transparent ? 'png' : 'mjpeg', '-i', '-'];
    // Sound: the scene's audio clips, mixed and cut to the video's length.
    tmp = join(tmpdir(), `upw-render-${job.id}`);
    mkdirSync(tmp, { recursive: true });
    const mix = await audioMix(scene, tmp, 1, page);
    if (mix) args.push(...mix.inputs, '-filter_complex', mix.filter, '-map', '0:v', '-map', '[aout]');
    // Each group of S sub-frames becomes the average of the group, kept once (the last of each group sees them all).
    if (S > 1) args.push('-vf', `tmix=frames=${S},select='eq(mod(n\,${S})\,${S - 1})',setpts=N/(${job.fps}*TB)`, '-r', String(job.fps));
    if (job.format === 'webm') args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-row-mt', '1', '-pix_fmt', job.transparent ? 'yuva420p' : 'yuv420p', ...(job.transparent ? ['-auto-alt-ref', '0'] : []));
    else if (job.format === 'mov') args.push('-c:v', 'prores_ks', '-profile:v', job.transparent ? '4' : '3', '-pix_fmt', job.transparent ? 'yuva444p10le' : 'yuv422p10le', '-vendor', 'apl0');
    else {
      const hw = findHwEncoder(ffmpeg);
      job.encoder = hw ? hw.label : 'processor';
      args.push(...(hw ? hw.args : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']), '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    }
    if (mix) args.push(...(job.format === 'webm' ? ['-c:a', 'libopus', '-b:a', '160k'] : job.format === 'mov' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k']), '-t', (job.total / job.fps).toFixed(3));
    args.push(job.file);
    enc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let encErr = '';
    enc.stderr.on('data', (d) => { encErr += d; });
    const finished = new Promise((resolve, reject) => {
      enc.on('error', reject);
      enc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg stopped (${code}): ${encErr.trim().slice(-300)}`))));
    });

    // More tabs with the same scene: frame f is taken by tab f % n, each tab moving forward through its own frames.
    const pages = [page];
    const extra = []; // each worker its own Chrome: tabs of one Chrome take their screenshots one at a time
    const n = Math.min(WORKERS, Math.max(1, Math.floor((job.total * S) / 30)));
    for (let i = 1; i < n; i++) {
      const b = (await launchRenderer()).browser;
      extra.push(b);
      const p = await b.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
      await p.setContent(pageHtml(shown, playerBase, { transparent: job.transparent, composite: job.composite }), { waitUntil: 'load', timeout: 60000 });
      await p.waitForFunction(() => window.__ready || window.__error, null, { timeout: 60000 });
      pages.push(p);
    }
    job.workers = pages.length;
    job.closeExtra = () => Promise.all(extra.map((b) => b.close().catch(() => {})));
    const t0 = Date.now();
    const shoot = async (p, f) => {
      // Frame times are rounded down to 0.1 ms so a cut lands on its own frame, with a tolerance far below
      // that, so a time that floating point puts a hair under a boundary (0.29 * 10000 = 2899.9999...)
      // still lands on it instead of one frame early.
      // f counts sub-frames when blurring: frame floor(f / S), sub-frame f % S, half a frame's time apart at most.
      const t = Math.floor(((Math.floor(f / S) + ((f % S) / S) * 0.5) / job.fps) * 10000 + 1e-6) / 10000;
      await p.evaluate(async (s) => { window.P.seek(s); if (window.P.settle) await window.P.settle(); }, t);
      return job.transparent ? p.screenshot({ type: 'png', omitBackground: true }) : p.screenshot({ type: 'jpeg', quality: 95 });
    };
    const chains = pages.map(() => Promise.resolve());
    const pending = new Map();
    let scheduled = 0;
    const AHEAD = pages.length * 3; // frames waiting in memory at most
    const shots = job.total * S;
    for (let f = 0; f < shots; f++) {
      if (job.cancel) throw new Error('Cancelled.');
      while (scheduled < shots && scheduled < f + AHEAD) {
        const w = scheduled % pages.length, k = scheduled;
        chains[w] = chains[w].then(() => shoot(pages[w], k));
        pending.set(k, chains[w]);
        scheduled++;
      }
      const jpg = await pending.get(f);
      pending.delete(f);
      if (!enc.stdin.write(jpg)) await new Promise((r) => enc.stdin.once('drain', r));
      job.done = Math.floor((f + 1) / S);
    }
    enc.stdin.end();
    await finished;
    if (process.env.STUDIO_RENDER_DEBUG) console.error(`[studio-render] ${job.total} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s with ${pages.length} worker(s)`);
    // The cover: the scene's still frame (its poster time, or the end), as a PNG beside the video.
    if (job.cover) {
      const t = Math.min(scene.duration, typeof scene.playback?.posterTime === 'number' ? scene.playback.posterTime : scene.duration - 0.01);
      await page.evaluate(async (s) => { window.P.seek(s); if (window.P.settle) await window.P.settle(); }, t);
      job.coverFile = job.file.replace(/\.[a-z0-9]+$/, '-cover.png');
      await page.screenshot({ path: job.coverFile, type: 'png', omitBackground: !!job.transparent });
    }
    job.bytes = statSync(job.file).size;
    job.state = 'done';
  } catch (e) {
    job.state = job.cancel ? 'cancelled' : 'error';
    job.error = String((e && e.message) || e);
    try { enc && enc.stdin.destroy(); enc && enc.kill(); } catch { /* already gone */ }
    try { if (existsSync(job.file)) unlinkSync(job.file); } catch { /* best-effort */ }
  } finally {
    try { await browser?.close(); } catch { /* already closed */ }
    await job.closeExtra?.();
    proxied?.close();
    if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Keeps the renders folder small: files older than a day go. */
function pruneOld() {
  try {
    const now = Date.now();
    for (const f of readdirSync(OUT)) {
      const p = join(OUT, f);
      if (now - statSync(p).mtimeMs > 24 * 3600 * 1000) unlinkSync(p);
    }
  } catch { /* best-effort */ }
}
