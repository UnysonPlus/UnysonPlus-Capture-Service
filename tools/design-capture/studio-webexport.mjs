// Kinetic Scenes: the scene made light for the web. A project's media is sized for editing and video export (a 4K
// wall, a whole 3-minute music track, phone videos at full length); a page that plays the scene live needs far less.
// This makes a copy of the scene with media cut to what it really uses:
//
//   - every picture and video is measured in a real browser, at every moment, at the scene's largest size (camera
//     moves and zoom presets included), and scaled to that size (twice it for small ones, for sharp HiDPI screens);
//     pictures become WebP (transparency kept);
//   - each video is trimmed to the seconds the timeline plays, has its sound track removed (the player keeps footage
//     muted) and is re-encoded as H.264 with fast start;
//   - each sound is trimmed to the range its clips play (a looped clip keeps the whole file); voice lines become mono
//     at a speech bitrate;
//   - a file used by several layers is made once, big enough and long enough for all of them;
//   - other project files (a 3D model, a Lottie file) are copied as they are.
//
// The result is a folder: scene.json (its media addresses relative, "media/…", or absolute with a base address),
// media/ and report.json (every file before and after). Put the folder on the site and the scene on the page:
// with --base the scene's addresses point at where the folder will be, ready for the Kinetic Scene element.
//
//   import { webExport } from './studio-webexport.mjs';
//   const r = await webExport('E:/…/project/scene.json', { base: 'https://example.com/wp-content/uploads/unysonplus/scenes/promo/' });
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

const ffmpegBin = () => process.env.FFMPEG || 'ffmpeg';
const ffprobeBin = () => process.env.FFPROBE || 'ffprobe';
const fail = (msg, code = 400) => Object.assign(new Error(msg), { code });

const IMAGE = /\.(jpe?g|png|webp|avif|bmp|tiff?)$/i;
const KEEP_IMAGE = /\.(gif|svg)$/i; // animated or vector: copied as they are
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i;
const isLocal = (s) => typeof s === 'string' && s && !/^(data:|https?:|blob:|sfx:|#)/i.test(s) && !s.startsWith('//');
const DOT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function probe(file) {
  const r = spawnSync(ffprobeBin(), ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,channels,r_frame_rate:format=duration', '-of', 'json', file], { encoding: 'utf8', windowsHide: true });
  try {
    const j = JSON.parse(r.stdout || '{}');
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    const [fn, fd] = String(v?.r_frame_rate || '0/1').split('/').map(Number);
    return { width: v?.width || 0, height: v?.height || 0, fps: fd ? fn / fd : 0, duration: Number(j.format?.duration) || 0, audio: !!a, channels: a?.channels || 0 };
  } catch { return { width: 0, height: 0, fps: 0, duration: 0, audio: false, channels: 0 }; }
}

function ffmpeg(args) {
  return new Promise((ok, bad) => {
    const p = spawn(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', bad);
    p.on('close', (c) => (c === 0 ? ok() : bad(new Error(`FFmpeg failed: ${err.trim().split('\n').slice(-3).join(' ')}`))));
  });
}

/** Every layer, groups opened up. */
function allLayers(list, out = []) {
  for (const l of list || []) { out.push(l); if (l.layers) allLayers(l.layers, out); }
  return out;
}

/** The pixel sizes the scene is shown at: each of its layouts at full HD (16:9 → 1920×1080, 9:16 → 1080×1920). */
function stageSizes(scene, longSide) {
  const bps = scene.stage?.breakpoints?.length ? scene.stage.breakpoints : [{ aspect: [16, 9] }];
  const seen = new Map();
  for (const b of bps) {
    const [aw, ah] = b.aspect || [16, 9];
    const r = aw / ah;
    const w = Math.round(r >= 1 ? longSide : longSide * r), h = Math.round(r >= 1 ? longSide / r : longSide);
    seen.set(`${w}x${h}`, { w, h });
  }
  return [...seen.values()];
}

/**
 * The largest size each picture and video layer is drawn at, in pixels at the given stage sizes: measured in a browser
 * at every moment (step seconds), so camera moves, zooms, presets and frames all count. → Map(layerId → { w, h }).
 */
async function measure(scene, sizes, onStep) {
  const [{ pageHtml }, { playerBase }, { chromium }] = await Promise.all([import('./studio-render.mjs'), import('./studio-tools.mjs'), import('playwright-core')]);
  const probeScene = JSON.parse(JSON.stringify(scene));
  for (const l of allLayers(probeScene.layers)) if (l.type === 'image' || l.type === 'video') l.src = DOT; // only the boxes matter
  delete probeScene.audio;
  const html = pageHtml(probeScene, await playerBase());
  const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true });
  const max = new Map();
  try {
    for (const s of sizes) {
      // Half size is measured (twice as quick); sizes are doubled back.
      const k = 2;
      const page = await browser.newPage({ viewport: { width: Math.round(s.w / k), height: Math.round(s.h / k) } });
      await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 60000 });
      const err = await page.evaluate(() => window.__error);
      if (err) throw new Error(`The scene did not load for measuring: ${err}`);
      const dur = Number(scene.duration) || 10;
      const step = Math.max(0.25, dur / 400);
      for (let t = 0; t <= dur + 1e-6; t += step) {
        onStep?.(`Measuring ${s.w}×${s.h}: ${Math.round((t / dur) * 100)}%`);
        const got = await page.evaluate(async (time) => {
          window.P.seek(time);
          if (window.P.settle) await window.P.settle();
          const out = [];
          for (const el of document.querySelectorAll('[data-layer]')) {
            const m = el.querySelector(':scope img, :scope video');
            if (!m) continue;
            let shown = true;
            for (let e = m; e && e !== document.body; e = e.parentElement) { const c = getComputedStyle(e); if (c.display === 'none' || c.visibility === 'hidden' || +c.opacity === 0) { shown = false; break; } }
            if (!shown) continue;
            const r = m.getBoundingClientRect();
            if (r.width > 0.5 && r.height > 0.5) out.push([el.dataset.layer, r.width, r.height]);
          }
          return out;
        }, Math.min(t, dur - 0.01));
        for (const [id, w, h] of got) {
          const cur = max.get(id) || { w: 0, h: 0 };
          max.set(id, { w: Math.max(cur.w, w * k), h: Math.max(cur.h, h * k) });
        }
      }
      await page.close();
    }
  } finally { await browser.close().catch(() => {}); }
  return max;
}

/**
 * Pictures resized and encoded by Chrome itself: it applies the file's colour profile (an Adobe RGB photo would look
 * washed out from FFmpeg, which ignores it), its EXIF rotation and transparency exactly as a page shows them, and
 * encodes WebP natively. → { encode(file, width, type, quality) → Buffer, close() }
 */
async function browserEncoder() {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>encode</title>');
  return {
    async encode(file, width, type = 'image/webp', quality = 0.8) {
      const ext = extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
      const b64 = readFileSync(file).toString('base64');
      const out = await page.evaluate(async ({ b64, mime, width, type, quality }) => {
        const blob = await (await fetch(`data:${mime};base64,${b64}`)).blob();
        const full = await createImageBitmap(blob);
        const w = Math.min(width, full.width), h = Math.max(1, Math.round((full.height * w) / full.width));
        const bmp = w === full.width ? full : await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
        const c = new OffscreenCanvas(w, h);
        c.getContext('2d').drawImage(bmp, 0, 0);
        const res = await c.convertToBlob({ type, quality });
        if (res.type !== type) throw new Error(`This browser cannot write ${type}.`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { data: btoa(s), w, h };
      }, { b64, mime: `image/${ext}`, width, type, quality });
      return { buf: Buffer.from(out.data, 'base64'), w: out.w, h: out.h };
    },
    close: () => browser.close().catch(() => {}),
  };
}

/** A layer's size from its box alone (when it could not be measured): its widest layout, with room for a zoom. */
function boxSize(layer, sizes) {
  let w = 0, h = 0;
  for (const s of sizes) {
    const bw = ((layer.box?.w ?? 100) / 100) * s.w;
    const bh = layer.box?.ratio ? bw / layer.box.ratio : ((layer.box?.h ?? 100) / 100) * s.h;
    w = Math.max(w, bw * 1.25); h = Math.max(h, bh * 1.25);
  }
  return { w, h };
}

/**
 * The source width a picture needs: drawn w×h, the file's own w×h, how it fits (cover crops, contain shows all).
 * Small pictures get twice their drawn size for HiDPI screens; big ones need no more than full HD (or their drawn size).
 */
function neededWidth(drawn, src, fit, dpr, longSide) {
  if (!src.width || !src.height) return 0;
  const sx = drawn.w / src.width, sy = drawn.h / src.height;
  const scale = fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  const shownW = src.width * scale; // the file's width, as drawn
  const sharp = Math.max(shownW, Math.min(shownW * dpr, longSide));
  return Math.min(src.width, Math.ceil(sharp));
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const size = (f) => { try { return statSync(f).size; } catch { return 0; } };
const safeName = (s) => basename(s).replace(/[^\w.-]+/g, '-');

/**
 * Makes the web copy of a scene. → { out, scene, files: [{ src, out, before, after, did }], before, after, measured }
 * Options: out (folder; default <project>/web), base (address the folder will have on the site; scene addresses
 * become absolute), longSide (1920), dpr (2), webp (true), measure (true), onStep(text).
 */
export async function webExport(sceneFile, opts = {}) {
  const file = resolve(sceneFile);
  if (!existsSync(file)) throw fail(`No scene file at ${file}.`);
  const scene = JSON.parse(readFileSync(file, 'utf8'));
  if (scene.format !== 'unysonplus-scene') throw fail('That is not a Kinetic Scenes scene file (format "unysonplus-scene").');
  const dir = dirname(file);
  const out = resolve(opts.out || join(dir, 'web'));
  if (out === dir) throw fail('Choose an output folder other than the project itself.');
  const longSide = opts.longSide || 1920, dpr = opts.dpr || 2, webp = opts.webp !== false;
  const step = opts.onStep || (() => {});
  const base = opts.base ? (opts.base.endsWith('/') ? opts.base : `${opts.base}/`) : '';
  const duration = Number(scene.duration) || 0;

  const layers = allLayers(scene.layers);
  const sizes = stageSizes(scene, longSide);

  // 1. Where each picture and video is drawn biggest.
  let drawn = new Map(), measured = false;
  const media = layers.filter((l) => (l.type === 'image' || l.type === 'video') && isLocal(l.src));
  if (media.length && opts.measure !== false) {
    try { drawn = await measure(scene, sizes, step); measured = true; } catch (e) { step(`Measuring failed (${e.message}); sizing from the layer boxes instead.`); }
  }

  // 2. A plan per source file.
  const plans = new Map(); // abs src → { kind, uses: [...], rel }
  const plan = (rel, kind) => {
    const abs = resolve(dir, rel);
    if (!plans.has(abs)) plans.set(abs, { abs, rel, kind, uses: [] });
    return plans.get(abs);
  };
  for (const l of media) {
    const kind = VIDEO.test(l.src) ? 'video' : IMAGE.test(l.src) ? 'image' : 'copy';
    plan(l.src, kind).uses.push({ layer: l, drawn: drawn.get(l.id) || boxSize(l, sizes) });
  }
  for (const c of scene.audio || []) if (isLocal(c.src)) plan(c.src, AUDIO.test(c.src) ? 'audio' : 'copy').uses.push({ clip: c });
  // Any other project file the scene names (a model, a Lottie file, a picture fill): copied as it is.
  const others = [];
  const walk = (v, holder, key) => {
    if (typeof v === 'string') { if (/^media\//.test(v) && !plans.has(resolve(dir, v))) others.push({ holder, key, rel: v }); return; }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, v, i));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], v, k);
  };
  walk(scene);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'media'), { recursive: true });
  const used = new Set();
  const name = (rel, ext) => {
    let n = safeName(rel).replace(/\.[^.]+$/, '') + ext, i = 2;
    while (used.has(n)) n = safeName(rel).replace(/\.[^.]+$/, '') + `-${i++}${ext}`;
    used.add(n);
    return n;
  };
  const files = [];
  let done = 0, enc = null;
  const total = plans.size;

  try {
  for (const p of plans.values()) {
    done++;
    if (!existsSync(p.abs)) { files.push({ src: p.rel, out: null, before: 0, after: 0, did: 'missing: left as it is' }); continue; }
    const before = size(p.abs);
    const info = probe(p.abs);
    let outName, did;
    step(`${done}/${total} ${p.rel}`);

    if (p.kind === 'image' && !KEEP_IMAGE.test(p.rel)) {
      const want = Math.max(...p.uses.map((u) => neededWidth(u.drawn, info, u.layer.fit, dpr, longSide)), 0) || info.width;
      const w = Math.max(16, Math.min(info.width || want, want));
      outName = name(p.rel, webp ? '.webp' : extname(p.rel));
      const dst = join(out, 'media', outName);
      const vf = `scale=${w}:-2:flags=lanczos`;
      let byBrowser = false;
      if (webp) {
        try {
          enc = enc || (await browserEncoder());
          writeFileSync(dst, (await enc.encode(p.abs, w)).buf);
          byBrowser = true;
        } catch (e) { step(`Chrome could not encode ${p.rel} (${e.message}); using FFmpeg.`); }
      }
      if (!byBrowser) await ffmpeg(webp ? ['-i', p.abs, '-vf', vf, '-c:v', 'libwebp', '-quality', '80', '-compression_level', '6', dst]
        : ['-i', p.abs, '-vf', vf, '-q:v', '3', dst]);
      did = `${info.width}×${info.height} → ${w} wide${webp ? ', WebP' : ''}`;
      // A file that came out bigger (an already small JPEG): the original is kept.
      if (size(dst) >= before) { rmSync(dst); used.delete(outName); outName = name(p.rel, extname(p.rel)); copyFileSync(p.abs, join(out, 'media', outName)); did = 'kept (already small)'; }
      for (const u of p.uses) u.layer.src = `media/${outName}`;
    } else if (p.kind === 'video') {
      // The seconds the layers play: from the earliest offset to the latest end, all uses together.
      let from = Infinity, to = 0;
      for (const u of p.uses) {
        const l = u.layer, rate = l.rate || 1, off = l.offset || 0;
        const shown = Math.max(0, (l.end ?? duration) - (l.start ?? 0));
        from = Math.min(from, off);
        to = Math.max(to, off + shown * rate + 0.5);
      }
      if (info.duration) to = Math.min(to, info.duration);
      from = Math.max(0, Math.min(from, to - 0.1));
      const want = Math.max(...p.uses.map((u) => neededWidth(u.drawn, info, u.layer.fit, dpr, longSide)), 0) || info.width;
      const w = even(Math.min(info.width || want, want));
      outName = name(p.rel, '.mp4');
      const dst = join(out, 'media', outName);
      await ffmpeg(['-ss', String(from), '-i', p.abs, '-t', String(to - from), '-an', '-vf', `scale=${w}:-2:flags=lanczos${info.fps > 31 ? ',fps=30' : ''}`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dst]);
      did = `${info.width}×${info.height}, ${info.duration.toFixed(1)} s → ${w} wide, ${from.toFixed(1)}-${to.toFixed(1)} s${info.audio ? ', sound removed' : ''}`;
      for (const u of p.uses) { u.layer.src = `media/${outName}`; if (from) u.layer.offset = +(((u.layer.offset || 0) - from).toFixed(3)); }
    } else if (p.kind === 'audio') {
      const loops = p.uses.some((u) => u.clip.loop);
      let from = 0, to = info.duration || 0;
      if (!loops) {
        from = Infinity; to = 0;
        for (const u of p.uses) {
          const off = u.clip.offset || 0;
          from = Math.min(from, off);
          to = Math.max(to, u.clip.duration != null ? off + u.clip.duration + 0.1 : (info.duration || off + 600));
        }
        if (info.duration) to = Math.min(to, info.duration);
        from = Math.max(0, Math.min(from, to - 0.05));
      }
      const voice = p.uses.every((u) => u.clip.role === 'voice');
      outName = name(p.rel, '.mp3');
      const dst = join(out, 'media', outName);
      await ffmpeg(['-ss', String(from), '-i', p.abs, ...(to ? ['-t', String(to - from)] : []), '-vn', '-c:a', 'libmp3lame',
        ...(voice ? ['-ac', '1', '-b:a', '64k'] : ['-ac', String(Math.min(2, info.channels || 2)), '-b:a', '128k']), dst]);
      did = `${info.duration.toFixed(1)} s → ${from.toFixed(1)}-${to.toFixed(1)} s${voice ? ', mono 64 kbps (speech)' : ', 128 kbps'}`;
      // Kept only when smaller (a short, already light voice line).
      if (size(dst) >= before && !from && (!info.duration || to >= info.duration - 0.05)) { rmSync(dst); used.delete(outName); outName = name(p.rel, extname(p.rel)); copyFileSync(p.abs, join(out, 'media', outName)); did = 'kept (already small)'; }
      for (const u of p.uses) { u.clip.src = `media/${outName}`; if (from && outName.endsWith('.mp3')) u.clip.offset = +(((u.clip.offset || 0) - from).toFixed(3)); }
    } else {
      outName = name(p.rel, extname(p.rel));
      copyFileSync(p.abs, join(out, 'media', outName));
      did = 'copied as it is';
      for (const u of p.uses) { if (u.layer) u.layer.src = `media/${outName}`; if (u.clip) u.clip.src = `media/${outName}`; }
    }
    files.push({ src: p.rel, out: `media/${outName}`, before, after: size(join(out, 'media', outName)), did, uses: p.uses.length });
  }
  } finally { await enc?.close(); }

  // Other files the scene names.
  const copied = new Map();
  for (const o of others) {
    const abs = resolve(dir, o.rel);
    if (!existsSync(abs)) continue;
    if (!copied.has(abs)) {
      const n = name(o.rel, extname(o.rel));
      copyFileSync(abs, join(out, 'media', n));
      copied.set(abs, `media/${n}`);
      files.push({ src: o.rel, out: `media/${n}`, before: size(abs), after: size(abs), did: 'copied as it is', uses: 1 });
    }
    o.holder[o.key] = copied.get(abs);
  }

  // Addresses: relative to the folder, or absolute with the base.
  if (base) {
    const abs = (v) => (typeof v === 'string' && v.startsWith('media/') ? base + v : v);
    for (const l of layers) if (l.src) l.src = abs(l.src);
    for (const c of scene.audio || []) c.src = abs(c.src);
    for (const o of others) o.holder[o.key] = abs(o.holder[o.key]);
  }

  writeFileSync(join(out, 'scene.json'), JSON.stringify(scene, null, 1));
  const before = files.reduce((s, f) => s + f.before, 0), after = files.reduce((s, f) => s + f.after, 0);
  const report = { scene: file, out, base: base || null, measured, sizes, before, after, files };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 1));
  writeFileSync(join(out, 'README.txt'), [
    'The web version of a Kinetic Scenes scene: its media cut to what the scene really uses.',
    '',
    base ? `Upload the media folder so its files are at ${base}media/…` : 'Upload this folder to your site. scene.json names its files as media/…, relative to the page that plays it.',
    base ? 'Then paste scene.json into the Kinetic Scene element (Unyson+), or the embed code\'s scene.' : 'To use it on a WordPress page, export again with the folder\'s address (--base), so the addresses are complete.',
    '',
    `Media: ${mb(before)} → ${mb(after)} (${files.length} files). Details in report.json.`,
  ].join('\n'));
  return { ...report, scene: join(out, 'scene.json') };
}

export const mb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A short table of the report, for a terminal. */
export function webExportText(r) {
  const pct = r.before ? Math.round((1 - r.after / r.before) * 100) : 0;
  const rows = r.files.map((f) => `  ${f.src.padEnd(28)} ${mb(f.before).padStart(8)} → ${mb(f.after).padStart(8)}  ${f.did}`);
  return `${r.scene}\nMedia ${mb(r.before)} → ${mb(r.after)} (${pct}% smaller, ${r.files.length} files${r.measured ? '' : '; sized from layer boxes, not measured'})\n${rows.join('\n')}`;
}

// ---- background jobs, for the Studio (POST starts one, GET follows it) ----
const jobs = new Map();
export function startWebExport({ project, base, dpr }) {
  const id = Math.random().toString(36).slice(2, 10);
  const job = { id, state: 'running', step: 'Starting', error: null, result: null };
  jobs.set(id, job);
  (async () => {
    const w = await import('./studio-workspace.mjs');
    const dir = w.projectDir(project);
    const r = await webExport(join(dir, 'scene.json'), { base, dpr: Number(dpr) || undefined, onStep: (s) => { job.step = s; } });
    job.result = { ...r, code: readFileSync(r.scene, 'utf8') };
    job.state = 'done';
  })().catch((e) => { job.state = 'error'; job.error = e.message; });
  return { id };
}
export const webExportJob = (id) => jobs.get(id) || null;
