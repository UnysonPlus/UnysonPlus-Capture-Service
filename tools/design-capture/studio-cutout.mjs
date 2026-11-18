// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// "Cut out the object" for photos, on this computer (nothing uploaded).
//
// A business that only has photos (a dish, a product, a bouquet, a pet after its groom) gets reels that read as a
// slideshow: the whole rectangle moves. Cutting the subject out of its photo lets a scene treat it as its own layer:
// a new background behind it, words behind it, a drop with a shadow, the subject lifting off its own table.
//
// Cut-out: BiRefNet lite (MIT, the 224 MB ONNX export, downloaded the first time) finds the main subject of the photo
// (or of a region of it, to pick one thing among several) and gives a matte with fine edges. It runs with ONNX
// Runtime for Node (the runtime the voice and music separation uses; installed here when missing), on the graphics
// card when it can (DirectML on Windows, CUDA elsewhere), else the processor.
// Plate (opt-in, "fill"): LaMa (Apache-2.0, 208 MB ONNX, downloaded the first time it is asked for) paints the photo
// without the subject, so the cut-out can rise off the plate it was standing on.
// Shadow (opt-in): the cut-out with a soft drop shadow baked in, on a canvas padded by three times the blur so the
// shadow's edge is never clipped (for thumbnails and website images; in a scene, use the layer's own shadow).
//
// Each cut-out gets a report: where the subject sat in the photo (to line the cut-out up with the photo it came
// from), how much of the photo it fills, which photo edges cut it off, how sure the matte is, and a verdict.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORT_VERSION = '1.30.0';
const CUT_URL = process.env.UPW_CUTOUT_URL || 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx';
const FILL_URL = process.env.UPW_FILL_URL || 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx';
const CUT_MB = 224, FILL_MB = 208;
const S = 1024; // BiRefNet's input
const F = 512; // LaMa's input
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

function kitDir(...p) {
  const assembled = resolve(HERE, '../../..');
  return basename(assembled) === 'assembled' ? join(assembled, ...p) : join(homedir(), '.unysonplus', ...p);
}
const modelFile = (name) => join(kitDir('models', 'cutout'), name);
const runtimeDir = () => (process.env.UPW_SEPARATE_DIR ? join(resolve(process.env.UPW_SEPARATE_DIR), 'runtime') : kitDir('separate', 'runtime'));
const hasRuntime = () => existsSync(join(runtimeDir(), 'node_modules', 'onnxruntime-node', 'package.json'));
const has = (f) => existsSync(f) && statSync(f).size > 1e6;

function run(cmd, args, opts = {}) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok(Buffer.concat(out)) : bad(new Error(`${basename(cmd)} failed: ${err.trim().split('\n').slice(-2).join(' ')}`))));
  });
}
const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE || 'ffprobe';

async function download(url, dest, mb, onStep) {
  mkdirSync(dirname(dest), { recursive: true });
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`Could not download ${basename(dest)} (HTTP ${r.status}).`);
  const total = Number(r.headers.get('content-length')) || mb * 1e6;
  const part = `${dest}.part`;
  const out = createWriteStream(part);
  let got = 0, shown = -1;
  for await (const chunk of r.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
    const pc = Math.floor((got / total) * 100);
    if (pc !== shown && pc % 5 === 0) { shown = pc; onStep?.(`Downloading ${basename(dest)} (${mb} MB, once): ${pc}%`); }
  }
  await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
  renameSync(part, dest);
}

/** ONNX Runtime for Node: the kit's (shared with voice and music separation), installed here when missing. */
async function ensureOrt(onStep) {
  if (!hasRuntime()) {
    onStep?.('Installing ONNX Runtime (once)');
    const dir = runtimeDir();
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'upw-separate-runtime', private: true }));
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const [cmd, pre] = existsSync(npmCli) ? [process.execPath, [npmCli]] : ['npm', []];
    await run(cmd, [...pre, 'install', `onnxruntime-node@${ORT_VERSION}`, '--no-audit', '--no-fund', '--omit=dev'], { cwd: dir, shell: !existsSync(npmCli) && process.platform === 'win32' });
    if (!hasRuntime()) throw new Error('ONNX Runtime could not be installed.');
  }
  return createRequire(join(runtimeDir(), 'package.json'))('onnxruntime-node');
}

async function session(ort, file, onlyCpu = false) {
  const want = process.env.UPW_CUTOUT_EP; // 'cpu' forces the processor (a graphics card too small for the model)
  for (const p of onlyCpu || want === 'cpu' ? ['cpu'] : process.platform === 'win32' ? ['dml', 'cpu'] : ['cuda', 'cpu']) {
    try { return { s: await ort.InferenceSession.create(file, { executionProviders: [p], logSeverityLevel: 4 }), ep: p, file }; } catch { /* next */ }
  }
  throw new Error(`${basename(file)} could not start.`);
}

/** Runs a model; when the graphics card runs out of memory, moves the model to the processor and runs again. */
async function infer(ort, sess, feeds) {
  const short = (e) => (/alloc|memory/i.test(String(e?.message)) ? new Error('Not enough memory for the cut-out model right now (it needs about 3 GB free). Close other heavy programs, or restart the computer if the memory stays full, and try again.') : e);
  try { return await sess.s.run(feeds); } catch (e) {
    if (sess.ep === 'cpu') throw short(e);
    try { await sess.s.release(); } catch { /* gone already */ }
    Object.assign(sess, await session(ort, sess.file, true));
    try { return await sess.s.run(feeds); } catch (e2) { throw short(e2); }
  }
}

/** What is installed, and what the first use will download. */
export function cutoutStatus() {
  return { runtime: hasRuntime(), cutModel: has(modelFile('birefnet-lite.onnx')), fillModel: has(modelFile('lama.onnx')), downloads: { cutMB: CUT_MB, fillMB: FILL_MB } };
}

/* ------------------------------------------------------------------ pixels */

async function probe(file) {
  const j = JSON.parse(String(await run(FFPROBE(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', file])));
  const st = j.streams?.[0];
  if (!st?.width) throw new Error(`${basename(file)} is not a picture ffmpeg can read.`);
  return { w: st.width, h: st.height };
}

/** Raw RGB (or RGBA) of a picture, optionally cropped and scaled, straight from ffmpeg. */
const raw = (file, vf, fmt = 'rgb24') => run(FFMPEG(), ['-v', 'error', '-i', file, '-frames:v', '1', ...(vf ? ['-vf', vf] : []), '-pix_fmt', fmt, '-f', 'rawvideo', '-']);

/** Bilinear resize of a one-channel float map. */
function resize1(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / dh - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / dw - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      out[y * dw + x] = (src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx) * (1 - ty) + (src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx) * ty;
    }
  }
  return out;
}

/** Box blur of a one-channel Uint8 map (three passes ≈ a gaussian), with a radius in pixels. */
function blur8(a, w, h, r) {
  if (r < 1) return a;
  let src = Float32Array.from(a), tmp = new Float32Array(w * h);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += src[y * w + Math.max(0, Math.min(w - 1, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = s / (2 * r + 1);
        s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
      for (let y = 0; y < h; y++) {
        src[y * w + x] = s / (2 * r + 1);
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  return Uint8Array.from(src, (v) => Math.round(v));
}

/** Drops specks (connected parts of the matte smaller than `frac` of the largest one); returns the kept parts' sizes. */
function dropSpecks(alpha, w, h, frac = 0.004) {
  const lab = new Int32Array(w * h).fill(-1), sizes = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (alpha[i] < 32 || lab[i] !== -1) continue;
    const id = sizes.length;
    let n = 0;
    lab[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop(); n++;
      const x = p % w, y = (p - x) / w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && lab[q] === -1 && alpha[q] >= 32) { lab[q] = id; stack.push(q); }
      }
    }
    sizes.push(n);
  }
  if (!sizes.length) return [];
  const big = Math.max(...sizes);
  let dropped = 0;
  for (let i = 0; i < w * h; i++) {
    if (lab[i] >= 0 && sizes[lab[i]] < big * frac) { alpha[i] = 0; dropped++; }
    else if (lab[i] === -1 && alpha[i] > 0) {
      // faint pixels (< 32) keep their value only next to a kept part, else they are haze
      const x = i % w;
      const near = [i - 1, i + 1, i - w, i + w].some((q) => q >= 0 && q < w * h && Math.abs((q % w) - x) <= 1 && lab[q] >= 0 && sizes[lab[q]] >= big * frac);
      if (!near) alpha[i] = 0;
    }
  }
  return sizes.filter((n) => n >= big * frac).sort((a, b) => b - a); // the parts kept, largest first
}

function writePng(file, w, h, rgba) {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  writeFileSync(file, PNG.sync.write(png, { colorType: 6 }));
}

/* ------------------------------------------------------------------ models */

async function matte(cut, ort, file, region, W, H) {
  const [x0, y0, x1, y1] = region;
  const cw = Math.max(16, Math.round((x1 - x0) * W)), ch = Math.max(16, Math.round((y1 - y0) * H));
  const cx = Math.round(x0 * W), cy = Math.round(y0 * H);
  const crop = cw === W && ch === H ? '' : `crop=${cw}:${ch}:${cx}:${cy},`;
  const px = await raw(file, `${crop}scale=${S}:${S}:flags=bicubic`);
  const input = new Float32Array(3 * S * S);
  for (let p = 0; p < S * S; p++) for (let c = 0; c < 3; c++) input[c * S * S + p] = (px[p * 3 + c] / 255 - MEAN[c]) / STD[c];
  const r = await infer(ort, cut, { [cut.s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) });
  const out = r[cut.s.outputNames[cut.s.outputNames.length - 1]].data;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < out.length; i += 97) { if (out[i] < lo) lo = out[i]; if (out[i] > hi) hi = out[i]; }
  const logits = lo < -0.01 || hi > 1.01;
  const m = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) m[i] = logits ? 1 / (1 + Math.exp(-out[i])) : out[i];
  const big = resize1(m, S, S, cw, ch);
  const alpha = new Uint8Array(W * H);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const v = big[y * cw + x];
    alpha[(cy + y) * W + cx + x] = v < 0.03 ? 0 : v > 0.97 ? 255 : Math.round(v * 255);
  }
  return alpha;
}

/** LaMa on the whole photo at 512 x 512; only the (grown) subject area of the original is replaced. */
async function plate(fill, ort, file, alpha, W, H) {
  const px = await raw(file, `scale=${F}:${F}:flags=bicubic`);
  const img = new Float32Array(3 * F * F);
  for (let p = 0; p < F * F; p++) for (let c = 0; c < 3; c++) img[c * F * F + p] = px[p * 3 + c] / 255;
  // The hole: the subject grown by ~2% of the photo, so its own contact shadow and edge colour go with it.
  const grow = Math.max(2, Math.round(Math.max(W, H) * 0.02));
  const hole = blur8(alpha.map((v) => (v > 20 ? 255 : 0)), W, H, grow).map((v) => (v > 8 ? 255 : 0));
  const small = resize1(Float32Array.from(hole, (v) => v / 255), W, H, F, F);
  const mask = Float32Array.from(small, (v) => (v > 0.05 ? 1 : 0));
  const feeds = {};
  for (const n of fill.s.inputNames) feeds[n] = /mask/i.test(n) ? new ort.Tensor('float32', mask, [1, 1, F, F]) : new ort.Tensor('float32', img, [1, 3, F, F]);
  const r = await infer(ort, fill, feeds);
  const o = r[fill.s.outputNames[0]].data;
  let mx = 0;
  for (let i = 0; i < o.length; i += 101) mx = Math.max(mx, o[i]);
  const k = mx > 2 ? 1 : 255; // some exports give 0-255, others 0-1
  const chans = [0, 1, 2].map((c) => resize1(o.subarray(c * F * F, (c + 1) * F * F), F, F, W, H));
  const orig = await raw(file, '');
  const soft = blur8(hole, W, H, Math.max(1, Math.round(grow / 3)));
  const outRgb = Buffer.alloc(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    const t = soft[p] / 255;
    for (let c = 0; c < 3; c++) outRgb[p * 3 + c] = Math.max(0, Math.min(255, Math.round(orig[p * 3 + c] * (1 - t) + chans[c][p] * k * t)));
  }
  return outRgb;
}

/* ------------------------------------------------------------------ the tool */

function parseRegion(r) {
  if (!r) return [0, 0, 1, 1];
  const v = (Array.isArray(r) ? r : String(r).split(',')).map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n))) throw new Error('A region is four numbers, fractions of the photo: left,top,right,bottom (e.g. 0,0.2,0.5,1).');
  const [a, b, c, d] = v.map((n) => Math.max(0, Math.min(1, n)));
  if (c - a < 0.05 || d - b < 0.05) throw new Error('The region is too small: at least 5% of the photo each way.');
  return [a, b, c, d];
}

/**
 * Cuts the main subject out of each photo.
 *   files:  photo paths (JPEG, PNG, WebP…)
 *   opts:   out (folder, default "<photo folder>/cutouts"), region ("l,t,r,b" fractions, to pick one thing among
 *           several; applies to every file), name (file name stem, one photo only), shadow (bool), fill (bool), onStep
 * → [{ file, out, size: [w, h], photo: [W, H], box: { x, y, w, h } (fractions of the photo: where the cut-out sat),
 *      cover, edges: ['bottom', …], sure, verdict: 'good'|'check'|'poor', notes: [], shadow?, shadowOffset?, plate?, check }]
 */
export async function cutoutImages(files, opts = {}) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list.length) throw new Error('Give at least one photo.');
  for (const f of list) if (!existsSync(f)) throw new Error(`No such file: ${f}`);
  const step = opts.onStep || (() => {});
  const region = parseRegion(opts.region);
  const ort = await ensureOrt(step);
  if (!has(modelFile('birefnet-lite.onnx'))) await download(CUT_URL, modelFile('birefnet-lite.onnx'), CUT_MB, step);
  if (opts.fill && !has(modelFile('lama.onnx'))) await download(FILL_URL, modelFile('lama.onnx'), FILL_MB, step);
  step('Starting the cut-out model');
  const cut = await session(ort, modelFile('birefnet-lite.onnx'));
  const results = [], plates = [];
  for (const [i, file] of list.entries()) {
    step(`Cutting out ${basename(file)} (${i + 1}/${list.length})`);
    const outDir = resolve(opts.out || join(dirname(resolve(file)), 'cutouts'));
    mkdirSync(outDir, { recursive: true });
    const stem = (list.length === 1 && opts.name) || basename(file, extname(file));
    const { w: W, h: H } = await probe(file);
    const alpha = await matte(cut, ort, file, region, W, H);
    const parts = dropSpecks(alpha, W, H);
    const things = parts.filter((n) => n >= parts[0] * 0.12).length; // separate things of some size
    // The subject's box and how sure the matte is (the share of its edge pixels that are neither in nor out).
    let x0 = W, y0 = H, x1 = -1, y1 = -1, solid = 0, soft = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = alpha[y * W + x];
      if (v > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (v >= 235) solid++; else if (v > 16) soft++;
    }
    const notes = [];
    if (x1 < 0) {
      results.push({ file, out: null, verdict: 'poor', cover: 0, notes: ['No subject found: the model saw only background. Try a region round the thing to cut out, or use the photo whole.'] });
      continue;
    }
    const cover = (solid + soft) / (W * H);
    const sure = solid / Math.max(1, solid + soft);
    const pad = 2;
    const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad), bx1 = Math.min(W - 1, x1 + pad), by1 = Math.min(H - 1, y1 + pad);
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    const edgeTol = Math.max(2, Math.round(Math.min(W, H) * 0.004));
    const edges = [];
    if (x0 <= edgeTol) edges.push('left');
    if (y0 <= edgeTol) edges.push('top');
    if (x1 >= W - 1 - edgeTol) edges.push('right');
    if (y1 >= H - 1 - edgeTol) edges.push('bottom');
    // How much of its own box the subject fills: a dish or a person fills half or more; scattered thin pieces
    // (arch outlines, a sign, a stray hand) mean the photo has no single subject.
    const density = (solid + soft) / Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1));
    const scattered = density < 0.2;
    if (scattered) notes.push('No single subject: the model picked scattered pieces (outlines, signs, parts of people). Use this photo whole (a background, a framed shot), not as a cut-out.');
    if (!scattered && things >= 2 && !opts.region) notes.push(`${things} separate things were cut out together (say, two dishes, or a dish and a hand): give a region round the one you want, one call each.`);
    if (cover > 0.8) notes.push('The "subject" fills most of the photo: there is no clear thing to lift out (a room, a landscape, a busy table). Use the photo whole, as a background.');
    if (cover < 0.01) notes.push('The subject is tiny in this photo: cut out from a closer photo, or give a region round it.');
    if (edges.length) notes.push(`The photo's ${edges.join(' and ')} edge${edges.length > 1 ? 's cut' : ' cuts'} the subject off: keep that side against the frame edge (or behind something) in the scene, never floating free.`);
    if (sure < 0.6) notes.push('Much of the edge is see-through: hair, fur, steam, glass or a busy background. Look at the check image before using it big.');
    const verdict = scattered || cover > 0.8 ? 'poor' : notes.length ? 'check' : 'good';

    // The cut-out, trimmed to the subject.
    const rgb = await raw(file, '');
    const rgba = new Uint8Array(bw * bh * 4);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const s = (by0 + y) * W + bx0 + x, d = (y * bw + x) * 4;
      rgba[d] = rgb[s * 3]; rgba[d + 1] = rgb[s * 3 + 1]; rgba[d + 2] = rgb[s * 3 + 2]; rgba[d + 3] = alpha[s];
    }
    const outFile = join(outDir, `${stem}-cutout.png`);
    writePng(outFile, bw, bh, rgba);
    let frameFile;
    if (opts.fullFrame) { // the subject at the photo's full size, in place (Split into layers stacks it on the plate)
      const full = new Uint8Array(W * H * 4);
      for (let p = 0; p < W * H; p++) { full[p * 4] = rgb[p * 3]; full[p * 4 + 1] = rgb[p * 3 + 1]; full[p * 4 + 2] = rgb[p * 3 + 2]; full[p * 4 + 3] = alpha[p]; }
      frameFile = join(outDir, `${stem}-frame.png`);
      writePng(frameFile, W, H, full);
    }
    const res = { file, out: outFile, size: [bw, bh], photo: [W, H], box: { x: +(bx0 / W).toFixed(4), y: +(by0 / H).toFixed(4), w: +(bw / W).toFixed(4), h: +(bh / H).toFixed(4) },
      ...(frameFile ? { frame: frameFile } : {}), cover: +cover.toFixed(3), things, density: +density.toFixed(2), edges, sure: +sure.toFixed(2), verdict, notes };

    // A soft drop shadow, baked in on a padded canvas (blur ~2.5% of the cut-out's larger side).
    if (opts.shadow) {
      const blurR = Math.max(4, Math.round(Math.max(bw, bh) * 0.025));
      const off = [Math.round(blurR * 0.6), Math.round(blurR * 2)];
      const P = blurR * 3;
      const sw = bw + P * 2 + Math.abs(off[0]), sh = bh + P * 2 + Math.abs(off[1]);
      const sa = new Uint8Array(sw * sh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) sa[(y + P + off[1]) * sw + x + P + off[0]] = Math.round(rgba[(y * bw + x) * 4 + 3] * 0.45);
      const sb = blur8(sa, sw, sh, Math.round(blurR / 1.7));
      const comp = new Uint8Array(sw * sh * 4);
      for (let p = 0; p < sw * sh; p++) comp[p * 4 + 3] = sb[p]; // black shadow
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const s = (y * bw + x) * 4, d = ((y + P) * sw + x + P) * 4, a = rgba[s + 3] / 255, ba = comp[d + 3] / 255;
        const oa = a + ba * (1 - a);
        for (let c = 0; c < 3; c++) comp[d + c] = oa ? Math.round((rgba[s + c] * a) / oa) : 0;
        comp[d + 3] = Math.round(oa * 255);
      }
      res.shadow = join(outDir, `${stem}-shadow.png`);
      res.shadowOffset = [-P, -P]; // where the shadow image's corner sits relative to the cut-out's, in pixels
      writePng(res.shadow, sw, sh, comp);
    }

    // The plate (the photo with the subject painted out) comes after every cut-out, one model at a time.
    if (opts.fill) plates.push({ res, file, alpha, W, H, outFile: join(outDir, `${stem}-plate.jpg`) });

    // A check image for the agent (and the person): the cut-out on dark, on white and on a checkerboard.
    const tile = Math.min(600, Math.max(bw, bh));
    const sc = tile / Math.max(bw, bh), tw = Math.max(1, Math.round(bw * sc)), th = Math.max(1, Math.round(bh * sc));
    const small = Uint8Array.from({ length: tw * th * 4 }, () => 0);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const sx = Math.min(bw - 1, Math.floor(x / sc)), sy = Math.min(bh - 1, Math.floor(y / sc));
      for (let c = 0; c < 4; c++) small[(y * tw + x) * 4 + c] = rgba[(sy * bw + sx) * 4 + c];
    }
    const gap = 16, cwid = tw * 3 + gap * 4, chei = th + gap * 2;
    const sheet = new Uint8Array(cwid * chei * 4);
    for (let p = 0; p < cwid * chei; p++) { sheet[p * 4] = 120; sheet[p * 4 + 1] = 120; sheet[p * 4 + 2] = 120; sheet[p * 4 + 3] = 255; }
    const bgs = [() => [28, 30, 34], () => [255, 255, 255], (x, y) => ((Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? [205, 205, 205] : [250, 250, 250])];
    bgs.forEach((bg, k) => {
      const ox = gap + k * (tw + gap);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const s = (y * tw + x) * 4, d = ((y + gap) * cwid + ox + x) * 4, a = small[s + 3] / 255, b = bg(x, y);
        for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(small[s + c] * a + b[c] * (1 - a));
      }
    });
    res.check = join(outDir, `${stem}-check.png`);
    writePng(res.check, cwid, chei, sheet);
    results.push(res);
  }
  const ep = cut.ep;
  if (plates.length) {
    try { await cut.s.release(); } catch { /* fine */ }
    step('Starting the model that paints the subject out');
    const fill = await session(ort, modelFile('lama.onnx'));
    for (const [i, p] of plates.entries()) {
      step(`Painting ${basename(p.file)} without its subject`);
      const px = await plate(fill, ort, p.file, p.alpha, p.W, p.H);
      const tmp = join(tmpdir(), `upw-plate-${process.pid}-${i}.rgb`);
      writeFileSync(tmp, px);
      await run(FFMPEG(), ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${p.W}x${p.H}`, '-i', tmp, '-q:v', '2', p.outFile]);
      rmSync(tmp, { force: true });
      p.res.plate = p.outFile;
    }
    try { await fill.s.release(); } catch { /* fine */ }
  } else {
    try { await cut.s.release(); } catch { /* fine */ }
  }
  return { ep, results };
}

/** One line per photo, for people and the CLI. */
export function cutoutText(r) {
  return [`Cut-outs (${r.ep === 'cpu' ? 'on the processor' : 'on the graphics card'}):`, ...r.results.map((x) => {
    if (!x.out) return `  ✗ ${basename(x.file)}: ${x.notes.join(' ')}`;
    const mark = x.verdict === 'good' ? '✓' : x.verdict === 'check' ? '!' : '✗';
    const extra = [x.shadow && `shadow ${basename(x.shadow)}`, x.plate && `plate ${basename(x.plate)}`].filter(Boolean).join(', ');
    return `  ${mark} ${basename(x.file)} → ${x.out} (${x.size[0]}×${x.size[1]}, ${Math.round(x.cover * 100)}% of the photo, fills ${Math.round(x.density * 100)}% of its box, sure ${Math.round(x.sure * 100)}%, at x ${x.box.x} y ${x.box.y} w ${x.box.w} h ${x.box.h})${extra ? `; ${extra}` : ''}\n     look: ${x.check}${x.notes.map((n) => `\n     - ${n}`).join('')}`;
  })].join('\n');
}

/* ------------------------------------------------------------------ the Studio (serve.mjs) */

const jobs = new Map();
let seq = 0;

/** POST /studio/cutout { src: data:image/… URL, region?, fill?, shadow? } → { id }; poll cutoutJob(id). */
export function startCutout(body = {}) {
  if (typeof body.src !== 'string' || !/^data:image\//.test(body.src)) throw Object.assign(new Error('Send the picture (an image data: URL).'), { code: 400 });
  const id = `c${Date.now().toString(36)}${(seq++).toString(36)}`;
  const job = { id, state: 'running', step: 'Starting', error: '', result: null };
  jobs.set(id, job);
  (async () => {
    const dir = join(tmpdir(), `upw-cutout-${id}`);
    try {
      mkdirSync(dir, { recursive: true });
      const comma = body.src.indexOf(',');
      const ext = (body.src.slice(11, comma).split(/[;+]/)[0] || 'png').replace('jpeg', 'jpg');
      const input = join(dir, `picture.${ext}`);
      writeFileSync(input, Buffer.from(body.src.slice(comma + 1), 'base64'));
      const r = await cutoutImages([input], { out: dir, region: body.region, fill: !!body.fill, shadow: !!body.shadow, onStep: (s) => { job.step = s; } });
      const x = r.results[0];
      const url = (f, type) => (f ? `data:${type};base64,${readFileSync(f).toString('base64')}` : undefined);
      job.result = { ...x, file: undefined, out: undefined, check: undefined, shadow: undefined, plate: undefined,
        png: url(x.out, 'image/png'), shadowPng: url(x.shadow, 'image/png'), plateJpg: url(x.plate, 'image/jpeg'), ep: r.ep };
      job.state = 'done';
    } catch (e) {
      job.state = 'error';
      job.error = String(e?.message || e);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      setTimeout(() => jobs.delete(id), 10 * 60 * 1000);
    }
  })();
  return { id };
}
export const cutoutJob = (id) => {
  const j = jobs.get(id);
  return j ? { id: j.id, state: j.state, step: j.step, error: j.error, result: j.state === 'done' ? j.result : null } : null;
};
