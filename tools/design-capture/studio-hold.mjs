// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// "Person and what they hold": SAM 2.1 (Apache-2.0, the tiny model's ONNX export, about 155 MB, downloaded the first
// time) follows what was clicked on the first frame through the whole video. The first click is the person, any
// others are what they hold (a product, a phone, a mug). Each frame is prompted with each object's outline from the
// frame before (a box round it and its centre), so an object is followed as it moves; when an object is lost for a
// frame (it turns edge-on, a hand covers it), its last outline holds. The masks come out at 256 x 256 over the whole
// frame; studio-matte.mjs puts them together with Robust Video Matting's fine edges for the person.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.UPW_SAM_URL || 'https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/';
const FILES = ['vision_encoder.onnx', 'vision_encoder.onnx_data', 'prompt_encoder_mask_decoder.onnx', 'prompt_encoder_mask_decoder.onnx_data'];
const S = 1024, MS = 256;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

/** The SAM 2.1 files, downloaded once into dir. */
export async function ensureSam(dir, onStep) {
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) {
    const file = join(dir, f);
    if (existsSync(file)) continue;
    onStep?.('Getting the model that follows what they hold (155 MB, once)');
    const r = await fetch(BASE + f, { redirect: 'follow' });
    if (!r.ok) throw new Error(`could not download ${f} (HTTP ${r.status})`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  return dir;
}
export const samDownloaded = (dir) => FILES.every((f) => existsSync(join(dir, f)));

/** An object's box (fractions of the frame, x0 y0 x1 y1) and centre, from a 256 x 256 mask; null when empty. */
function shape(m) {
  let x0 = MS, y0 = MS, x1 = -1, y1 = -1, sx = 0, sy = 0, n = 0;
  for (let y = 0; y < MS; y++) for (let x = 0; x < MS; x++) if (m[y * MS + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; sx += x; sy += y; n++; }
  if (!n) return null;
  let cx = sx / n, cy = sy / n;
  // The centre must be on the object (a ring or an L has its average outside it): else the nearest pixel that is.
  if (!m[Math.round(cy) * MS + Math.round(cx)]) {
    let best = Infinity;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (m[y * MS + x]) { const d = (x - cx) ** 2 + (y - cy) ** 2; if (d < best) { best = d; var bx = x, by = y; } }
    cx = bx; cy = by;
  }
  return { box: [x0 / MS, y0 / MS, (x1 + 1) / MS, (y1 + 1) / MS], c: [(cx + 0.5) / MS, (cy + 0.5) / MS], area: n };
}

/**
 * Follows the clicked objects through the video: { ort, dir (the model folder), input (the video), fps, count (frames),
 * points: [{ x, y }] (fractions of the first frame; the first is the person), onFrame } → { ep, masks: [[Uint8Array
 * 256x256 (1 = in) per object] per frame] }.
 */
export async function followObjects({ ort, dir, input, fps, count, points, onFrame }) {
  let enc = null, dec = null, ep = 'cpu';
  for (const p of process.platform === 'win32' ? ['dml', 'cpu'] : ['cuda', 'cpu']) {
    try {
      const o = { executionProviders: [p], logSeverityLevel: 3 };
      enc = await ort.InferenceSession.create(join(dir, 'vision_encoder.onnx'), o);
      dec = await ort.InferenceSession.create(join(dir, 'prompt_encoder_mask_decoder.onnx'), o);
      ep = p; break;
    } catch { enc = dec = null; }
  }
  if (!enc) throw new Error('The model that follows what they hold could not start');
  // Frames as 1024 x 1024 RGB, one after another, straight from ffmpeg.
  const ff = spawn(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-i', input, '-an', '-vf', `fps=${fps},scale=${S}:${S}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const frameBytes = S * S * 3;
  let pending = Buffer.alloc(0), ended = false, wake = null;
  ff.stdout.on('data', (d) => { pending = Buffer.concat([pending, d]); if (pending.length >= frameBytes * 2) ff.stdout.pause(); wake?.(); });
  ff.stdout.on('end', () => { ended = true; wake?.(); });
  const nextFrame = async () => {
    while (pending.length < frameBytes && !ended) await new Promise((r) => { wake = r; ff.stdout.resume(); });
    if (pending.length < frameBytes) return null;
    const f = pending.subarray(0, frameBytes);
    pending = pending.subarray(frameBytes);
    if (pending.length < frameBytes) ff.stdout.resume();
    return Buffer.from(f);
  };

  const px = new Float32Array(3 * S * S);
  let prev = points.map(() => null); // each object's mask on the frame before
  const masks = [];
  for (let i = 0; i < count; i++) {
    const rgb = await nextFrame();
    if (!rgb) break;
    for (let p = 0; p < S * S; p++) for (let c = 0; c < 3; c++) px[c * S * S + p] = (rgb[p * 3 + c] / 255 - MEAN[c]) / STD[c];
    const e = await enc.run({ pixel_values: new ort.Tensor('float32', px, [1, 3, S, S]) });
    const emb = { 'image_embeddings.0': e['image_embeddings.0'], 'image_embeddings.1': e['image_embeddings.1'], 'image_embeddings.2': e['image_embeddings.2'] };
    const now = [];
    for (let k = 0; k < points.length; k++) {
      const was = prev[k] && shape(prev[k]);
      // The first frame: the click alone. Later: the object's box from the frame before (grown a little, it moves)
      // and its centre.
      const c = was ? was.c : [points[k].x, points[k].y];
      const g = 0.04;
      const box = was ? [Math.max(0, was.box[0] - g), Math.max(0, was.box[1] - g), Math.min(1, was.box[2] + g), Math.min(1, was.box[3] + g)] : null;
      const r = await dec.run({
        input_points: new ort.Tensor('float32', Float32Array.from([c[0] * S, c[1] * S]), [1, 1, 1, 2]),
        input_labels: new ort.Tensor('int64', BigInt64Array.from([1n]), [1, 1, 1]),
        input_boxes: box ? new ort.Tensor('float32', Float32Array.from(box.map((v) => v * S)), [1, 1, 4]) : new ort.Tensor('float32', new Float32Array(0), [1, 0, 4]),
        ...emb,
      });
      const iou = [...r.iou_scores.data];
      // The person: the whole-object mask (the largest of the good ones); a held thing: the best scored.
      const order = iou.map((s, j) => j).sort((a, b) => iou[b] - iou[a]);
      const pickIdx = order[0];
      const m = new Uint8Array(MS * MS);
      const d = r.pred_masks.data;
      for (let p = 0; p < MS * MS; p++) m[p] = d[pickIdx * MS * MS + p] > 0 ? 1 : 0;
      const got = shape(m);
      // Lost (nothing, or a sudden collapse or blow-up against the frame before): keep the last outline.
      const lost = !got || (was && (got.area < was.area * 0.35 || got.area > was.area * 2.5)) || iou[pickIdx] < 0.3;
      now.push(lost && prev[k] ? prev[k] : m);
    }
    prev = now;
    masks.push(now);
    onFrame?.(i + 1);
  }
  ff.kill();
  return { ep, masks };
}

/**
 * The cut-out for one frame at w x h (0-255): the person from Robust Video Matting kept inside SAM's outline of them
 * (grown a little, so hair at the edge stays), and every held object from SAM, softened at the edge.
 */
export function combine(objs, rvm, w, h) {
  const out = new Uint8Array(w * h);
  const grow = 3; // in 256 px: about 1% of the frame
  const at = (m, x, y) => m[Math.min(MS - 1, Math.max(0, y)) * MS + Math.min(MS - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    const sy = Math.floor((y / h) * MS);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((x / w) * MS);
      let v = 0;
      // The person (object 0): fine edges from RVM where SAM says the person is (near).
      if (rvm) {
        let near = 0;
        for (let dy = -grow; dy <= grow && !near; dy += grow) for (let dx = -grow; dx <= grow && !near; dx += grow) near = at(objs[0], sx + dx, sy + dy);
        if (near) v = rvm[y * w + x];
      } else v = at(objs[0], sx, sy) * 255;
      // What they hold: SAM's mask, averaged over its 3 x 3 neighbours for a soft edge.
      for (let k = 1; k < objs.length; k++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += at(objs[k], sx + dx, sy + dy);
        v = Math.max(v, Math.round((s / 9) * 255));
      }
      out[y * w + x] = v;
    }
  }
  return out;
}
