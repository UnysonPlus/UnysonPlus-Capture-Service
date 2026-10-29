// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Kinetic Scenes' "Cut out the person" and "Follow the face" for footage, on this computer (nothing uploaded).
//
// Cut-out: two models in the kit's headless browser, each downloaded once. MODNet (Apache-2.0, portrait matting,
// the 6.6 MB quantised ONNX export) gives fine edges (hair); MediaPipe's multiclass selfie segmenter (Apache-2.0,
// 16 MB) knows hair, skin and clothes, so the body is solid even where it is the colour of the wall. The matte
// is the stronger of the two; each is blended with the frame before so edges do not flicker; ffmpeg then joins the original frames and the mattes into a WebM with transparency (VP9 alpha),
// which the Studio places above its graphics: words go behind the person, the background can be swapped.
//
// Speed: when the kit has ONNX Runtime for Node (installed with voice and music separation), MODNet runs in Node on
// the graphics card (DirectML on Windows, else the CPU) while the browser does the body and the edges, frame by frame
// in parallel; the see-through video is encoded with VP9's realtime settings. Otherwise it all runs in the browser.
//
// Robust Video Matting (quality "rvm"): RVM's MobileNetV3 model (GPL-3.0, 15 MB, downloaded only when this method is
// chosen) in Node, frame after frame with its memory of the frames before, so edges hold steady without the blending
// above. Very fast on the graphics card. It needs ONNX Runtime for Node; the browser then only finds the face.
//
// Face: MediaPipe's face detector (Apache-2.0, a 230 KB model) finds the face in the same frames; the path is
// filled where a frame has no face and smoothed, so a layer can follow it (the Follow preset).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const MATTE_URL = process.env.UPW_MATTE_URL || 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx';
const BODY_URL = process.env.UPW_BODY_URL || 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
const RVM_URL = process.env.UPW_RVM_URL || 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx';
const FACE_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
// 1.20 or later: older runtimes call a WebGPU function current browsers no longer have, and silently fall back.
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/';

function modelsDir() {
  const assembled = resolve(HERE, '../../..');
  if (basename(assembled) === 'assembled') return join(assembled, 'models', 'matte');
  return join(homedir(), '.unysonplus', 'models', 'matte');
}

async function ensure(url, name) {
  const dir = modelsDir();
  const file = join(dir, name);
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`could not download ${name} (HTTP ${r.status})`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

function run(cmd, args) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok(out) : bad(new Error(`${basename(cmd)} failed: ${err.trim().split('\n').slice(-2).join(' ')}`))));
  });
}

const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE || 'ffprobe';
const ceil32 = (n) => Math.max(32, Math.ceil(n / 32) * 32);

/** ONNX Runtime for Node, from the kit's separation runtime, or null when it is not installed. */
function nodeOrt() {
  const assembled = resolve(HERE, '../../..');
  const dir = basename(assembled) === 'assembled' ? join(assembled, 'separate', 'runtime') : join(homedir(), '.unysonplus', 'separate', 'runtime');
  try { return createRequire(join(dir, 'package.json'))('onnxruntime-node'); } catch { return null; }
}

/**
 * MODNet in Node, on the graphics card when it can: reads the frames as raw RGB (w x h) and fills `mattes[i]` with a
 * Uint8Array (0-255) per frame, resolving `ready[i]` as each is done, so the browser can use them as they come.
 */
async function nodeModnet(ort, model, rgbFile, count, w, h) {
  let session = null, ep = 'cpu';
  for (const p of process.platform === 'win32' ? ['dml', 'cpu'] : ['cuda', 'cpu']) {
    try { session = await ort.InferenceSession.create(model, { executionProviders: [p] }); ep = p; break; } catch { /* next */ }
  }
  if (!session) throw new Error('MODNet could not start in Node');
  const mattes = new Array(count), waiters = new Array(count);
  const ready = Array.from({ length: count }, (_, i) => new Promise((ok) => { waiters[i] = ok; }));
  const frame = w * h * 3, input = new Float32Array(3 * w * h);
  const fd = await import('node:fs').then((m) => m.openSync(rgbFile, 'r'));
  const buf = Buffer.alloc(frame);
  const { readSync, closeSync } = await import('node:fs');
  const done = (async () => {
    try {
      for (let i = 0; i < count; i++) {
        readSync(fd, buf, 0, frame, i * frame);
        for (let p = 0; p < w * h; p++) for (let ch = 0; ch < 3; ch++) input[ch * w * h + p] = (buf[p * 3 + ch] / 255 - 0.5) / 0.5;
        const r = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) });
        const d = r[session.outputNames[0]].data, m = new Uint8Array(w * h);
        for (let p = 0; p < w * h; p++) m[p] = Math.round(Math.max(0, Math.min(1, d[p])) * 255);
        mattes[i] = m;
        waiters[i]();
      }
    } finally { closeSync(fd); }
  })();
  return { ep, ready, mattes, done };
}

/**
 * Robust Video Matting in Node: every frame in order (the model carries what it learnt from the frames before), RGB
 * w x h in, a Uint8Array matte (0-255) per frame out. ratio: how much the model shrinks the frame inside (0.25-1).
 */
async function nodeRvm(ort, model, rgbFile, count, w, h, ratio, onFrame) {
  let session = null, ep = 'cpu';
  for (const p of process.platform === 'win32' ? ['dml', 'cpu'] : ['cuda', 'cpu']) {
    try { session = await ort.InferenceSession.create(model, { executionProviders: [p] }); ep = p; break; } catch { /* next */ }
  }
  if (!session) throw new Error('Robust Video Matting could not start');
  const { openSync, readSync, closeSync } = await import('node:fs');
  const frame = w * h * 3, buf = Buffer.alloc(frame), src = new Float32Array(3 * w * h);
  const zero = () => new ort.Tensor('float32', new Float32Array(1), [1, 1, 1, 1]);
  let rec = { r1i: zero(), r2i: zero(), r3i: zero(), r4i: zero() };
  const dr = new ort.Tensor('float32', new Float32Array([ratio]), [1]);
  const out = [];
  const fd = openSync(rgbFile, 'r');
  try {
    for (let i = 0; i < count; i++) {
      readSync(fd, buf, 0, frame, i * frame);
      for (let p = 0; p < w * h; p++) for (let ch = 0; ch < 3; ch++) src[ch * w * h + p] = buf[p * 3 + ch] / 255;
      const r = await session.run({ src: new ort.Tensor('float32', src, [1, 3, h, w]), ...rec, downsample_ratio: dr });
      const pha = r.pha.data, m = new Uint8Array(w * h);
      for (let p = 0; p < w * h; p++) m[p] = Math.round(Math.max(0, Math.min(1, pha[p])) * 255);
      out.push(Buffer.from(m.buffer));
      rec = { r1i: r.r1o, r2i: r.r2o, r3i: r.r3o, r4i: r.r4o };
      onFrame?.(i + 1);
    }
  } finally { closeSync(fd); }
  return { ep, mattes: out };
}

/** The cut-out methods, and whether each can run here: what the Studio shows next to the choice. */
export function matteMethods() {
  const dir = modelsDir();
  const runtime = !!nodeOrt();
  return {
    fast: { ready: true, note: 'A quick body outline, for drafts.' },
    fine: { ready: true, note: 'Fine edges, hair included; the default.' },
    rvm: { ready: runtime, downloaded: existsSync(join(dir, 'rvm_mobilenetv3_fp32.onnx')), runtime,
      note: runtime ? 'Very fast and steady from frame to frame; downloads a 15 MB model (GPL-3.0) the first time.' : 'Needs voice and music separation installed first (Add-ons): it brings the runtime this uses.' },
    hold: { ready: runtime, downloaded: existsSync(join(dir, '..', 'sam2', 'vision_encoder.onnx_data')), runtime,
      note: runtime ? 'Click the person and what they hold on the first frame; both are followed through the video. Downloads 170 MB of models the first time.' : 'Needs voice and music separation installed first (Add-ons): it brings the runtime this uses.' },
  };
}

/** Runs in the headless browser: sets up the matting model and the face detector once. */
const PAGE_SETUP = async ({ ort, mp, faces, cutout, fine, threads, nodeMod }) => {
  const load = (url) => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = url; s.onload = ok; s.onerror = () => bad(new Error('could not load the model runtime')); document.head.appendChild(s); });
  window.__prev = null;
  window.__nodeMod = !!nodeMod;
  if (cutout && fine && !nodeMod) {
    // The graphics card when the browser offers it (WebGPU), else several cores (the page is served
    // cross-origin isolated so it can use them).
    await load(`${ort}ort.webgpu.min.js`);
    window.ort.env.wasm.wasmPaths = ort;
    window.ort.env.wasm.numThreads = self.crossOriginIsolated ? threads : 1;
    if (window.ort.env.webgpu) window.ort.env.webgpu.powerPreference = 'high-performance';
    let ep = 'wasm';
    if (navigator.gpu) {
      try { window.__matte = await window.ort.InferenceSession.create('/matte.onnx', { executionProviders: ['webgpu'] }); ep = 'webgpu'; } catch { window.__matte = null; }
    }
    if (!window.__matte) window.__matte = await window.ort.InferenceSession.create('/matte.onnx', { executionProviders: ['wasm'] });
    window.__ep = ep;
  }
  const vision = await import(`${mp}vision_bundle.mjs`);
  const files = await vision.FilesetResolver.forVisionTasks(`${mp}wasm`);
  // The body and face models on the graphics card (WebGL) when the browser can, else the processor.
  window.__gpuDelegate = 'GPU';
  try {
    const probe = await vision.FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: '/face-probe.tflite', delegate: 'GPU' }, runningMode: 'IMAGE' });
    probe.close();
  } catch { window.__gpuDelegate = 'CPU'; }
  if (cutout) window.__body = await vision.ImageSegmenter.createFromOptions(files, { baseOptions: { modelAssetPath: '/body.tflite', delegate: window.__gpuDelegate }, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false });
  if (faces) window.__faces = await vision.FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: '/face.tflite', delegate: window.__gpuDelegate }, runningMode: 'IMAGE', minDetectionConfidence: 0.4 });
  return { isolated: self.crossOriginIsolated, ep: window.__ep || 'none', delegate: window.__gpuDelegate };
};

/** Runs in the headless browser: one batch of frames → a matte (PNG) and a face box for each. */
const PAGE_BATCH = async ({ names, w, h, smooth }) => {
  const out = [];
  for (const name of names) {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error(`could not read ${name}`)); i.src = `/frames/${name}`; });
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    const T = { s: performance.now() };
    let face = null;
    if (window.__faces) {
      const d = window.__faces.detect(img).detections;
      const best = d.sort((a, b) => b.boundingBox.width * b.boundingBox.height - a.boundingBox.width * a.boundingBox.height)[0];
      if (best) {
        const bb = best.boundingBox, iw = img.naturalWidth, ih = img.naturalHeight;
        face = { x: (bb.originX + bb.width / 2) / iw, y: (bb.originY + bb.height / 2) / ih, w: bb.width / iw, h: bb.height / ih };
      }
    }
    T.face = performance.now();
    if (!window.__body) { out.push({ png: '', face }); continue; }
    g.drawImage(img, 0, 0, w, h);
    T.matte = performance.now();
    // The body: the segmenter's person confidence, scaled smoothly to the matte's size.
    const seg = window.__body.segment(c);
    T.seg = performance.now();
    const cm = seg.confidenceMasks;
    const pm = cm[cm.length - 1];
    const bw = pm.width, bh = pm.height, pd = pm.getAsFloat32Array();
    const fg = cm.length > 1 && cm[0] !== pm; // a multiclass model: the first mask is the background
    const bgd = fg ? cm[0].getAsFloat32Array() : null;
    const body = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(bw - 1, (x / w) * bw - 0.5)), fy = Math.max(0, Math.min(bh - 1, (y / h) * bh - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      const at = (xx, yy) => (bgd ? 1 - bgd[yy * bw + xx] : pd[yy * bw + xx]);
      body[y * w + x] = (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
    }
    if (seg.close) seg.close();
    T.resize = performance.now();
    let m = new Float32Array(w * h);
    if (window.__matte || window.__nodeMod) {
      // Fine: MODNet for the edge (hair), counted only near the body. Made in Node (graphics card) when it can be.
      let mod;
      if (window.__nodeMod) {
        const u8 = new Uint8Array(await (await fetch(`/mod/${name}`)).arrayBuffer());
        mod = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) mod[i] = u8[i] / 255;
      } else {
        const px = g.getImageData(0, 0, w, h).data;
        const input = new Float32Array(3 * w * h);
        for (let i = 0; i < w * h; i++) for (let ch = 0; ch < 3; ch++) input[ch * w * h + i] = (px[i * 4 + ch] / 255 - 0.5) / 0.5;
        const s = window.__matte;
        const res = await s.run({ [s.inputNames[0]]: new window.ort.Tensor('float32', input, [1, 3, h, w]) });
        mod = res[s.outputNames[0]].data;
      }
      T.mod = performance.now();
      // "Near the body": the body grown by about 6% of the width (a box blur of the body mask, then a threshold).
      const r = Math.max(2, Math.round(w * 0.06));
      const rows = new Float32Array(w * h);
      for (let y = 0; y < h; y++) { let acc = 0; for (let x = -r; x < w; x++) { if (x + r < w) acc += body[y * w + x + r]; if (x - r - 1 >= 0) acc -= body[y * w + x - r - 1]; if (x >= 0) rows[y * w + x] = acc; } }
      for (let x = 0; x < w; x++) { let acc = 0; for (let y = -r; y < h; y++) { if (y + r < h) acc += rows[(y + r) * w + x]; if (y - r - 1 >= 0) acc -= rows[(y - r - 1) * w + x]; if (y >= 0) { const near = Math.min(1, (acc / ((2 * r + 1) ** 2)) * 4); m[y * w + x] = mod[y * w + x] * near; } } }
    }
    for (let i = 0; i < w * h; i++) { const b = Math.min(1, Math.max(0, (body[i] - 0.3) / 0.45)); if (b > m[i]) m[i] = b; }
    T.body = performance.now();
    // Blend with the frame before: edges stop flickering, movement still follows (the new frame weighs most).
    if (window.__prev && window.__prev.length === m.length) {
      const b = new Float32Array(m.length);
      for (let i = 0; i < m.length; i++) b[i] = m[i] * (1 - smooth) + window.__prev[i] * smooth;
      m = b;
    }
    window.__prev = Float32Array.from(m);
    // A gentle curve: the inside solid, the edge soft (hair), the background clean. Sent as raw grey bytes.
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = Math.round(Math.min(1, Math.max(0, (m[i] - 0.08) / 0.84)) * 255);
    let bin = '';
    for (let i = 0; i < gray.length; i += 0x8000) bin += String.fromCharCode.apply(null, gray.subarray(i, i + 0x8000));
    const png = btoa(bin);
    T.png = performance.now();
    out.push({ png, face, ms: { face: T.face - T.s, seg: T.seg - T.matte, resize: T.resize - T.seg, modnet: (T.mod ?? T.resize) - T.resize, near: T.body - (T.mod ?? T.resize), png: T.png - T.body } });
  }
  return out;
};

const jobs = new Map();
let seq = 0;
let queue = Promise.resolve();

export function matteJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { id: j.id, state: j.state, step: j.step, done: j.done, total: j.total, error: j.error, result: j.state === 'done' ? j.result : null };
}

/**
 * Cuts the person out of a video and/or follows the face: { src (a video data: URL), cutout?: true, faces?: true,
 * quality?: 'fine' | 'fast', smooth? (0-0.9) } → a job. Result: { src (WebM with transparency, if cutout), track: [{ t, x, y, w, h }] (file
 * seconds; the face's centre and size as fractions of the frame, if faces), width, height, fps, seconds }.
 */
export function startMatte(body = {}) {
  if (typeof body.src !== 'string' || !/^data:video\//.test(body.src)) throw Object.assign(new Error('Send the footage (a video data: URL).'), { code: 400 });
  const cutout = body.cutout !== false;
  const faces = body.faces !== false;
  const smooth = Math.max(0, Math.min(0.9, Number(body.smooth ?? 0.35)));
  // fine: fine edges (hair) from MODNet as well, about a second a frame; fast: the body only, about 20 times faster.
  // hold: the person and what they hold (SAM 2.1 follows the clicked points; RVM gives the person's fine edges).
  const hold = body.quality === 'hold';
  const points = hold && Array.isArray(body.points) ? body.points.filter((p) => p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1).slice(0, 6) : [];
  if (hold && cutout && !points.length) throw Object.assign(new Error('Click the person (and what they hold) on the first frame first.'), { code: 400 });
  const rvm = body.quality === 'rvm' || hold;
  const fine = body.quality !== 'fast' && !rvm;
  if (rvm && cutout && !nodeOrt()) throw Object.assign(new Error('Robust Video Matting needs voice and music separation installed first (Tools › Add-ons): it brings the runtime it uses.'), { code: 400 });
  const id = `m${Date.now().toString(36)}${(seq++).toString(36)}`;
  const job = { id, state: 'queued', step: 'Waiting', done: 0, total: 0, error: '', result: null };
  jobs.set(id, job);
  const go = async () => {
    const dir = join(tmpdir(), `upw-matte-${id}`);
    mkdirSync(join(dir, 'frames'), { recursive: true });
    mkdirSync(join(dir, 'mattes'), { recursive: true });
    let browser;
    try {
      job.state = 'running';
      job.step = 'Getting the models ready';
      const matteModel = cutout && fine ? await ensure(MATTE_URL, basename(new URL(MATTE_URL).pathname) === 'model.onnx' ? 'modnet.onnx' : 'modnet_quantized.onnx') : null;
      const faceModel = faces ? await ensure(FACE_URL, 'blaze_face_short_range.tflite') : null;
      const bodyModel = cutout && !rvm ? await ensure(BODY_URL, basename(new URL(BODY_URL).pathname)) : null;
      const rvmModel = cutout && rvm ? await ensure(RVM_URL, 'rvm_mobilenetv3_fp32.onnx') : null;
      const comma = body.src.indexOf(',');
      const input = join(dir, 'in.mp4');
      writeFileSync(input, Buffer.from(body.src.slice(comma + 1), 'base64'));
      const probe = JSON.parse(await run(FFPROBE(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', input]));
      const st = probe.streams?.[0] || {};
      const [fn, fd] = String(st.r_frame_rate || '30/1').split('/').map(Number);
      const fps = Math.min(30, Math.max(1, Math.round((fn / (fd || 1)) || 30)));
      const W = st.width || 1080, H = st.height || 1920;
      const seconds = Number(probe.format?.duration) || 0;
      // The model sees a smaller picture (short side about 384, both sides multiples of 32); the matte is scaled back up.
      const k = (rvm ? 720 : fine ? 320 : 384) / Math.min(W, H);
      const pw = ceil32(W * k), ph = ceil32(H * k);
      job.step = 'Reading the frames';
      await run(FFMPEG(), ['-v', 'error', '-y', '-i', input, '-vf', `fps=${fps},scale=${pw}:${ph}`, '-q:v', '3', join(dir, 'frames', '%05d.jpg')]);
      const names = readdirSync(join(dir, 'frames')).filter((f) => f.endsWith('.jpg')).sort();
      job.total = names.length;
      // MODNet in Node on the graphics card, alongside the browser, when the kit has the runtime.
      let node = null;
      const ortNode = matteModel && process.env.UPW_MATTE_NODE !== '0' ? nodeOrt() : null;
      if (ortNode) {
        try {
          const rgb = join(dir, 'frames.rgb');
          await run(FFMPEG(), ['-v', 'error', '-y', '-i', input, '-vf', `fps=${fps},scale=${pw}:${ph}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', rgb]);
          node = await nodeModnet(ortNode, matteModel, rgb, names.length, pw, ph);
          node.done.catch((e) => console.warn('[studio-matte] MODNet in Node stopped:', e.message));
        } catch (e) { console.warn('[studio-matte] MODNet in Node unavailable, using the browser:', e.message); node = null; }
      }
      // Robust Video Matting: all the mattes in Node, in order; the browser below then only looks for the face.
      let rvmGrays = null;
      if (rvmModel) {
        const rgb = join(dir, 'frames.rgb');
        await run(FFMPEG(), ['-v', 'error', '-y', '-i', input, '-vf', `fps=${fps},scale=${pw}:${ph}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', rgb]);
        // Progress counts the mattes, then (when the face is wanted too) each frame again in the browser.
        job.total = names.length * ((faces ? 2 : 1) + (hold ? 1 : 0));
        job.step = 'Cutting out the person (Robust Video Matting)';
        const r = await nodeRvm(nodeOrt(), rvmModel, rgb, names.length, pw, ph, Math.min(1, 288 / Math.min(pw, ph)), (n) => { job.done = n; });
        console.log(`[studio-matte] ${id}: Robust Video Matting on the ${r.ep === 'cpu' ? 'processor' : 'graphics card'}`);
        rvmGrays = r.mattes;
        if (hold) {
          const h = await import('./studio-hold.mjs');
          const samDir = join(modelsDir(), '..', 'sam2');
          await h.ensureSam(samDir, (s) => { job.step = s; });
          job.step = 'Following the person and what they hold';
          const f = await h.followObjects({ ort: nodeOrt(), dir: samDir, input, fps, count: names.length, points, onFrame: (n) => { job.done = names.length + n; } });
          console.log(`[studio-matte] ${id}: ${points.length} object(s) followed on the ${f.ep === 'cpu' ? 'processor' : 'graphics card'}`);
          rvmGrays = rvmGrays.map((g, i) => Buffer.from(h.combine(f.masks[Math.min(i, f.masks.length - 1)], g, pw, ph).buffer));
        }
      }
      const browserCutout = cutout && !rvmModel;
      const track = new Array(names.length);
      const grays = rvmGrays || new Array(names.length);
      if (browserCutout || faces) {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--force_high_performance_gpu'] });
      // Several pages work on their own runs of frames at once (each smooths its run from frame to frame).
      const pages = Math.max(1, Math.min(Number(process.env.UPW_MATTE_PAGES) || 3, Math.ceil(names.length / 60)));
      const threads = Math.max(1, Math.min(8, Math.floor((cpus().length - 2) / pages)));
      const setupPage = async () => {
        const page = await browser.newPage();
        if (matteModel) await page.route('**/matte.onnx', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(matteModel) }));
        if (bodyModel) await page.route('**/body.tflite', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(bodyModel) }));
        await page.route('**/face-probe.tflite', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(faceModel || bodyModel) }));
        if (faceModel) await page.route('**/face.tflite', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(faceModel) }));
        if (node) {
          await page.route('**/mod/*', async (r) => {
            const i = names.indexOf(basename(new URL(r.request().url()).pathname));
            await node.ready[i];
            r.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from(node.mattes[i].buffer) });
            node.mattes[i] = null; // used once: free it
          });
        }
        await page.route('**/frames/*', (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', body: readFileSync(join(dir, 'frames', basename(new URL(r.request().url()).pathname))) }));
        // Cross-origin isolated, so the model can use several cores.
        await page.route('**/matte.html', (r) => r.fulfill({ status: 200, contentType: 'text/html', headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' }, body: '<!doctype html><title>matte</title>' }));
        await page.goto('https://kit.local/matte.html');
        const setup = await page.evaluate(PAGE_SETUP, { ort: ORT, mp: MP, faces, cutout: browserCutout, fine, threads, nodeMod: !!node });
        return { page, setup };
      };
      const workers = await Promise.all(Array.from({ length: pages }, setupPage));
      const setup = workers[0].setup;
      console.log(`[studio-matte] ${id}: ${pages} page${pages === 1 ? '' : 's'}; ${node ? `MODNet in Node (${node.ep === 'dml' ? 'graphics card, DirectML' : node.ep === 'cuda' ? 'graphics card, CUDA' : 'processor'})` : setup.ep === 'webgpu' ? 'MODNet on the graphics card' : setup.isolated ? `${threads} threads` : 'one thread'}; body and face on the ${setup.delegate === 'GPU' ? 'graphics card' : 'processor'}`);
      job.step = browserCutout ? `Cutting out the person${fine ? '' : ' (fast)'}` : 'Following the face';
      const per = Math.ceil(names.length / pages);
      await Promise.all(workers.map(async ({ page }, p) => {
        for (let i = p * per; i < Math.min(names.length, (p + 1) * per); i += 12) {
          const batch = names.slice(i, Math.min(i + 12, (p + 1) * per));
          const res = await page.evaluate(PAGE_BATCH, { names: batch, w: pw, h: ph, smooth });
          if (process.env.UPW_MATTE_PROFILE && p === 0 && res[0]?.ms) console.log('[studio-matte] ms', JSON.stringify(res[0].ms));
          res.forEach((r, j) => {
            if (browserCutout) grays[i + j] = Buffer.from(r.png, 'base64');
            track[i + j] = r.face ? { t: (i + j) / fps, ...r.face } : { t: (i + j) / fps };
          });
          job.done += batch.length;
        }
      }));
      await browser.close();
      browser = null;
      }
      if (cutout) writeFileSync(join(dir, 'mattes.gray'), Buffer.concat(grays));
      const result = { width: W, height: H, fps, seconds, track: faces ? smoothTrack(track) : undefined, src: undefined };
      if (cutout) {
        job.step = 'Making the see-through video';
        // The original frames at full size (up to 1920 on the long side) with the matte as their transparency.
        const s = Math.min(1, 1920 / Math.max(W, H));
        const ow = Math.round((W * s) / 2) * 2, oh = Math.round((H * s) / 2) * 2;
        const out = join(dir, 'cutout.webm');
        await run(FFMPEG(), ['-v', 'error', '-y', '-i', input, '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${pw}x${ph}`, '-framerate', String(fps), '-i', join(dir, 'mattes.gray'),
          '-filter_complex', `[0:v]fps=${fps},scale=${ow}:${oh}[v];[1:v]scale=${ow}:${oh}:flags=bicubic,format=gray[m];[v][m]alphamerge,format=yuva420p[o]`,
          '-map', '[o]', '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '30', '-row-mt', '1',
          // Realtime settings: about 7x faster than the default, for a slightly larger working file.
          '-deadline', 'realtime', '-cpu-used', '6', '-shortest', out]);
        result.src = `data:video/webm;base64,${readFileSync(out).toString('base64')}`;
      }
      job.result = result;
      job.state = 'done';
      job.step = 'Done';
      console.log(`[studio-matte] ${id}: ${names.length} frames${cutout ? ', cut out' : ''}${faces ? `, face in ${track.filter((x) => x.x !== undefined).length}` : ''}`);
    } catch (e) {
      job.state = 'error';
      job.error = String(e && e.message || e);
      console.warn('[studio-matte]', id, job.error);
    } finally {
      try { await browser?.close(); } catch { /* closed */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
  queue = queue.then(go, go);
  return { id, state: job.state };
}

/** Fills frames with no face from their neighbours and smooths the path (a five-frame average). */
function smoothTrack(track) {
  const known = track.map((p, i) => (p.x !== undefined ? i : -1)).filter((i) => i >= 0);
  if (!known.length) return [];
  const filled = track.map((p, i) => {
    if (p.x !== undefined) return p;
    const before = [...known].reverse().find((k) => k < i), after = known.find((k) => k > i);
    const a = track[before ?? after], b = track[after ?? before];
    const f = before !== undefined && after !== undefined ? (i - before) / (after - before) : 0;
    const mix = (k) => a[k] + (b[k] - a[k]) * f;
    return { t: p.t, x: mix('x'), y: mix('y'), w: mix('w'), h: mix('h') };
  });
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return filled.map((p, i) => {
    const win = filled.slice(Math.max(0, i - 2), i + 3);
    const avg = (k) => win.reduce((s, q) => s + q[k], 0) / win.length;
    return { t: Math.round(p.t * 1000) / 1000, x: r4(avg('x')), y: r4(avg('y')), w: r4(avg('w')), h: r4(avg('h')) };
  });
}

/** The footage's own sound, as an MP3 (for transcribing, captions and the voice track): { src } → { src, seconds }. */
export async function footageAudio(body = {}) {
  if (typeof body.src !== 'string' || !/^data:video\//.test(body.src)) throw Object.assign(new Error('Send the footage (a video data: URL).'), { code: 400 });
  const dir = join(tmpdir(), `upw-faudio-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const input = join(dir, 'in.video');
    writeFileSync(input, Buffer.from(body.src.slice(body.src.indexOf(',') + 1), 'base64'));
    const out = join(dir, 'sound.mp3');
    try {
      await run(FFMPEG(), ['-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '128k', out]);
    } catch {
      throw Object.assign(new Error('This footage has no sound.'), { code: 400 });
    }
    const seconds = Number(JSON.parse(await run(FFPROBE(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', out])).format?.duration) || 0;
    return { src: `data:audio/mpeg;base64,${readFileSync(out).toString('base64')}`, seconds };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
