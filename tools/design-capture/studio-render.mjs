// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// The Animation Studio's video export: renders a scene to MP4 or WebM, frame by frame.
//
// Studio scenes are seekable (every frame is a pure function of time, 3D included), so the render
// is exact: headless Chrome shows the scene at the requested size, jumps to each frame in turn, takes a
// screenshot and pipes it into ffmpeg. Nothing plays in real time, so a slow machine only renders
// slower, never drops or blurs frames. The scene picks its breakpoint layout from the video's width
// (a vertical 1080x1920 render uses the mobile layout, as a phone would).
//
// Jobs run one at a time in the background; the Studio polls for progress and downloads the file.
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, existsSync, readdirSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const OUT = join(process.env.CAPTURE_OUT || join(process.cwd(), 'capture-out'), 'studio-renders');
const MAX_FRAMES = 60 * 60 * 3; // three minutes at 60 fps
const jobs = new Map();
let queue = Promise.resolve();

let ffmpegBin = null;
async function findFfmpeg() {
  if (ffmpegBin !== null) return ffmpegBin;
  ffmpegBin = await new Promise((resolve) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(''));
    p.on('exit', (code) => resolve(code === 0 ? (process.env.FFMPEG || 'ffmpeg') : ''));
  });
  return ffmpegBin;
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
  const format = input.format === 'webm' ? 'webm' : 'mp4';
  const duration = Math.max(0.1, Math.min(600, +scene.duration || 1));
  const frames = Math.min(MAX_FRAMES, Math.round(duration * fps));
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const slug = String(scene.title || 'scene').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scene';
  const job = { id, state: 'queued', done: 0, total: frames, width, height, fps, format, file: join(OUT, `${slug}-${width}x${height}-${id}.${format}`), name: `${slug}-${width}x${height}.${format}`, error: '', startedAt: Date.now(), cancel: false };
  jobs.set(id, job);
  queue = queue.then(() => run(job, scene, playerBase)).catch(() => {});
  return job;
}

export function jobInfo(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { id: j.id, state: j.state, done: j.done, total: j.total, error: j.error, name: j.name, bytes: j.bytes || 0, seconds: Math.round((Date.now() - j.startedAt) / 1000) };
}
export const jobFile = (id) => { const j = jobs.get(id); return j && j.state === 'done' && existsSync(j.file) ? j : null; };
export function cancelRender(id) { const j = jobs.get(id); if (j) j.cancel = true; return !!j; }

function pageHtml(scene, playerBase) {
  // The stage fills the window exactly; the scene's own trigger is ignored (the render seeks it).
  const s = { ...scene, stage: { ...scene.stage, heightMode: 'fill', heightOffset: 0 }, playback: { ...scene.playback, trigger: 'manual' } };
  const json = JSON.stringify(s).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}</style>
<script>window.UPW_SCENE_ASSET_BASE=${JSON.stringify(playerBase)}</script>
<script src="${playerBase}scene-player.js" data-auto-mount="false"></script></head>
<body><div id="h"></div><script>
window.__ready = false;
try {
  const sc = ${json};
  window.P = UnysonPlusScene.mount(document.getElementById('h'), sc, { autoplay: false, editor: true, allowCode: true, audio: false });
  P.seek(0);
  const models = (function count(ls){ return ls.reduce(function(n,l){ return n + (l.type === 'model' ? 1 : 0) + (l.layers ? count(l.layers) : 0); }, 0); })(sc.layers);
  // Ready once fonts are in and every 3D layer has its canvas.
  document.fonts.ready.then(function wait(){ if (document.querySelectorAll('.upw-3d canvas').length >= models) { setTimeout(function(){ window.__ready = true; }, 600); } else setTimeout(wait, 100); });
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
  const list = Array.isArray(track) ? track : scene.audio;
  const clips = Array.isArray(list) ? list.filter((a) => a && typeof a.src === 'string') : [];
  if (!clips.length) return null;
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
    const fi = Math.max(0, +c.fadeIn || 0);
    const fo = Math.max(0, +c.fadeOut || 0);
    const delayMs = Math.round(Math.max(0, +c.start || 0) * 1000);
    const idx = firstInput + inputs.length / 2; // inputs holds "-i", file pairs
    inputs.push('-i', file);
    let chain = `[${idx}:a]atrim=start=${trimIn.toFixed(3)}${finite ? `:duration=${len.toFixed(3)}` : ''},asetpts=PTS-STARTPTS,volume=${vol.toFixed(3)}`;
    if (fi > 0) chain += `,afade=t=in:st=0:d=${fi.toFixed(3)}`;
    if (fo > 0 && finite) chain += `,afade=t=out:st=${Math.max(0, len - fo).toFixed(3)}:d=${fo.toFixed(3)}`;
    chain += `,aresample=48000,adelay=delays=${delayMs}:all=1[a${k}]`;
    parts.push(chain);
    k++;
  }
  if (!k) return null;
  const mix = `${Array.from({ length: k }, (_, i) => `[a${i}]`).join('')}amix=inputs=${k}:normalize=0:duration=longest,apad[aout]`;
  return { inputs, filter: `${parts.join(';')};${mix}` };
}

async function run(job, scene, playerBase) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) { job.state = 'error'; job.error = 'ffmpeg is not installed. Install it (Windows: winget install Gyan.FFmpeg; macOS: brew install ffmpeg), restart the kit and try again.'; return; }
  mkdirSync(OUT, { recursive: true });
  pruneOld();
  job.state = 'rendering';
  let browser;
  let enc;
  let tmp = '';
  try {
    browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'] });
    const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
    await page.setContent(pageHtml(scene, playerBase), { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 60000 });
    const err = await page.evaluate(() => window.__error);
    if (err) throw new Error(`The scene could not be played: ${err}`);

    const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(job.fps), '-c:v', 'mjpeg', '-i', '-'];
    // Sound: the scene's audio clips, mixed and cut to the video's length.
    tmp = join(tmpdir(), `upw-render-${job.id}`);
    mkdirSync(tmp, { recursive: true });
    const mix = await audioMix(scene, tmp, 1, page);
    if (mix) args.push(...mix.inputs, '-filter_complex', mix.filter, '-map', '0:v', '-map', '[aout]');
    if (job.format === 'webm') args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-row-mt', '1', '-pix_fmt', 'yuv420p');
    else args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    if (mix) args.push(...(job.format === 'webm' ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '192k']), '-t', (job.total / job.fps).toFixed(3));
    args.push(job.file);
    enc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let encErr = '';
    enc.stderr.on('data', (d) => { encErr += d; });
    const finished = new Promise((resolve, reject) => {
      enc.on('error', reject);
      enc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg stopped (${code}): ${encErr.trim().slice(-300)}`))));
    });

    for (let f = 0; f < job.total; f++) {
      if (job.cancel) throw new Error('Cancelled.');
      // Frame times are rounded down, so a cut lands on its own frame, never one late.
      const t = Math.floor((f / job.fps) * 10000) / 10000;
      await page.evaluate((s) => window.P.seek(s), t);
      const jpg = await page.screenshot({ type: 'jpeg', quality: 95 });
      if (!enc.stdin.write(jpg)) await new Promise((r) => enc.stdin.once('drain', r));
      job.done = f + 1;
    }
    enc.stdin.end();
    await finished;
    job.bytes = statSync(job.file).size;
    job.state = 'done';
  } catch (e) {
    job.state = job.cancel ? 'cancelled' : 'error';
    job.error = String((e && e.message) || e);
    try { enc && enc.stdin.destroy(); enc && enc.kill(); } catch { /* already gone */ }
    try { if (existsSync(job.file)) unlinkSync(job.file); } catch { /* best-effort */ }
  } finally {
    try { await browser?.close(); } catch { /* already closed */ }
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
