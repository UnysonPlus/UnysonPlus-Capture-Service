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
import { mkdirSync, statSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
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
  window.P = UnysonPlusScene.mount(document.getElementById('h'), sc, { autoplay: false, editor: true, allowCode: true });
  P.seek(0);
  const models = (function count(ls){ return ls.reduce(function(n,l){ return n + (l.type === 'model' ? 1 : 0) + (l.layers ? count(l.layers) : 0); }, 0); })(sc.layers);
  // Ready once fonts are in and every 3D layer has its canvas.
  document.fonts.ready.then(function wait(){ if (document.querySelectorAll('.upw-3d canvas').length >= models) { setTimeout(function(){ window.__ready = true; }, 600); } else setTimeout(wait, 100); });
} catch (e) { window.__error = String(e && e.message || e); }
</script></body></html>`;
}

async function run(job, scene, playerBase) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) { job.state = 'error'; job.error = 'ffmpeg is not installed. Install it (Windows: winget install Gyan.FFmpeg; macOS: brew install ffmpeg), restart the kit and try again.'; return; }
  mkdirSync(OUT, { recursive: true });
  pruneOld();
  job.state = 'rendering';
  let browser;
  let enc;
  try {
    browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'] });
    const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
    await page.setContent(pageHtml(scene, playerBase), { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 60000 });
    const err = await page.evaluate(() => window.__error);
    if (err) throw new Error(`The scene could not be played: ${err}`);

    const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(job.fps), '-c:v', 'mjpeg', '-i', '-'];
    if (job.format === 'webm') args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-row-mt', '1', '-pix_fmt', 'yuv420p');
    else args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
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
