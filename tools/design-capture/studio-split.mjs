// Kinetic Scenes' "Split into layers": a picture in, a stack of transparent layers out (background,
// subject, objects…) in exactly the same place, so the Studio can reveal it piece by piece or give each
// layer a depth for a 2.5D camera move.
//
// Two engines, picked automatically:
//   - fal.ai's Qwen-Image-Layered, when the user has their own fal.ai key (FAL_KEY in the environment or
//     in the kit's .env). The picture is sent to fal.ai; they charge the user's account (about $0.05).
//   - A local cut-out that runs on any computer, nothing uploaded: the U2-Net-p salient-object model
//     (Apache-2.0, 4.7 MB, downloaded once from the rembg project's releases) finds the subject in the
//     kit's own headless browser, and the hole it leaves in the background is filled from its edges
//     (a push-pull fill), so the background stands on its own. Two layers: background and subject.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx';
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/';

function modelsDir() {
  const assembled = resolve(HERE, '../../..');
  if (basename(assembled) === 'assembled') return join(assembled, 'models', 'cutout');
  return join(homedir(), '.unysonplus', 'models', 'cutout');
}

/** The fal.ai key: the environment, or a FAL_KEY= line in the kit's .env file. */
function falKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY.trim();
  for (const f of [resolve(HERE, '../../../../.env'), resolve(HERE, '.env')]) {
    try {
      const m = /^\s*FAL_KEY\s*=\s*(.+)\s*$/m.exec(readFileSync(f, 'utf8'));
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch { /* no file */ }
  }
  return '';
}

export function splitStatus() {
  const model = join(modelsDir(), 'u2netp.onnx');
  return { engine: falKey() ? 'fal' : 'local', fal: !!falKey(), localModel: existsSync(model) };
}

async function asDataUrl(src) {
  if (src.startsWith('data:')) return src;
  const r = await fetch(src);
  if (!r.ok) throw new Error(`could not download the picture (HTTP ${r.status})`);
  const type = r.headers.get('content-type') || 'image/png';
  return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
}

async function viaFal(src, layers, prompt) {
  const r = await fetch('https://fal.run/fal-ai/qwen-image-layered', {
    method: 'POST',
    headers: { Authorization: `Key ${falKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: src, num_layers: Math.max(2, Math.min(10, layers | 0 || 4)), output_format: 'png', sync_mode: true, ...(prompt ? { prompt } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`fal.ai answered ${r.status}: ${j.detail ? JSON.stringify(j.detail).slice(0, 200) : 'no detail'}`);
  const images = Array.isArray(j.images) ? j.images : [];
  if (!images.length) throw new Error('fal.ai returned no layers');
  const out = [];
  for (const im of images) out.push({ src: await asDataUrl(im.url) });
  return out;
}

async function ensureModel() {
  const dir = modelsDir();
  const file = join(dir, 'u2netp.onnx');
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error(`could not download the cut-out model (HTTP ${r.status})`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

/** Runs in the headless browser: cut the subject out and fill the background behind it. */
const PAGE_JOB = async ({ src, ort }) => {
  const load = (url) => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = url; s.onload = ok; s.onerror = () => bad(new Error('could not load the model runtime')); document.head.appendChild(s); });
  await load(`${ort}ort.min.js`);
  window.ort.env.wasm.wasmPaths = ort;
  window.ort.env.wasm.numThreads = 1;
  const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('could not read the picture')); i.src = src; });
  const W = img.naturalWidth, H = img.naturalHeight;
  const S = 320;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, S, S);
  const px = g.getImageData(0, 0, S, S).data;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const input = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let ch = 0; ch < 3; ch++) input[ch * S * S + i] = (px[i * 4 + ch] / 255 - mean[ch]) / std[ch];
  const session = await window.ort.InferenceSession.create('/model.onnx', { executionProviders: ['wasm'] });
  const feeds = { [session.inputNames[0]]: new window.ort.Tensor('float32', input, [1, 3, S, S]) };
  const res = await session.run(feeds);
  const pred = res[session.outputNames[0]].data;
  let lo = Infinity, hi = -Infinity;
  for (const v of pred) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  // The mask, scaled up to the picture (smoothly), softened at its edge.
  const m = document.createElement('canvas'); m.width = S; m.height = S;
  const mg = m.getContext('2d');
  const md = mg.createImageData(S, S);
  for (let i = 0; i < S * S; i++) { const a = Math.round(((pred[i] - lo) / (hi - lo || 1)) * 255); md.data[i * 4 + 3] = a; }
  mg.putImageData(md, 0, 0);
  const big = document.createElement('canvas'); big.width = W; big.height = H;
  const bg = big.getContext('2d');
  bg.imageSmoothingQuality = 'high';
  bg.drawImage(m, 0, 0, W, H);
  const mask = bg.getImageData(0, 0, W, H).data;
  const full = document.createElement('canvas'); full.width = W; full.height = H;
  const fg = full.getContext('2d');
  fg.drawImage(img, 0, 0);
  const pic = fg.getImageData(0, 0, W, H);
  // Subject: the picture with the mask as its transparency (a gentle curve keeps hair and edges soft).
  const subj = new ImageData(new Uint8ClampedArray(pic.data), W, H);
  for (let i = 0; i < W * H; i++) { const a = mask[i * 4 + 3] / 255; subj.data[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, (a - 0.2) / 0.6))); }
  // Background: the subject's area (grown a little) is filled from around it by push-pull: averaging the
  // known pixels down a pyramid, then filling each unknown pixel from the level above.
  const known = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) known[i] = mask[i * 4 + 3] < 40 ? 1 : 0;
  const levels = [];
  let w = W, h = H, rgb = new Float32Array(W * H * 3), wt = new Float32Array(known);
  for (let i = 0; i < W * H; i++) for (let ch = 0; ch < 3; ch++) rgb[i * 3 + ch] = pic.data[i * 4 + ch] * known[i];
  levels.push({ w, h, rgb, wt });
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const nr = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let sw = 0; const s = [0, 0, 0];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(w - 1, x * 2 + dx), sy = Math.min(h - 1, y * 2 + dy), k = sy * w + sx;
        sw += wt[k]; for (let ch = 0; ch < 3; ch++) s[ch] += rgb[k * 3 + ch];
      }
      const o = y * nw + x; nwt[o] = sw / 4; for (let ch = 0; ch < 3; ch++) nr[o * 3 + ch] = s[ch] / 4;
    }
    w = nw; h = nh; rgb = nr; wt = nwt; levels.push({ w, h, rgb, wt });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const cur = levels[l], up = levels[l + 1];
    for (let y = 0; y < cur.h; y++) for (let x = 0; x < cur.w; x++) {
      const k = y * cur.w + x;
      const a = Math.min(1, cur.wt[k] * 4);
      // The level above, sampled smoothly (bilinear), so the fill has no blocks.
      const fx = Math.max(0, Math.min(up.w - 1, (x + 0.5) / 2 - 0.5)), fy = Math.max(0, Math.min(up.h - 1, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(up.w - 1, x0 + 1), y1 = Math.min(up.h - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      const at = (xx, yy, ch) => { const q = yy * up.w + xx; return up.rgb[q * 3 + ch] / (up.wt[q] || 1e-6); };
      for (let ch = 0; ch < 3; ch++) {
        const mine = cur.wt[k] > 0 ? cur.rgb[k * 3 + ch] / cur.wt[k] : 0;
        const fill = (at(x0, y0, ch) * (1 - tx) + at(x1, y0, ch) * tx) * (1 - ty) + (at(x0, y1, ch) * (1 - tx) + at(x1, y1, ch) * tx) * ty;
        cur.rgb[k * 3 + ch] = (mine * a + fill * (1 - a));
      }
      cur.wt[k] = 1;
    }
  }
  const back = new ImageData(new Uint8ClampedArray(pic.data), W, H);
  const base = levels[0];
  for (let i = 0; i < W * H; i++) {
    if (known[i] >= 1) continue;
    for (let ch = 0; ch < 3; ch++) back.data[i * 4 + ch] = Math.round(base.rgb[i * 3 + ch]);
  }
  const png = (data) => { const k = document.createElement('canvas'); k.width = W; k.height = H; k.getContext('2d').putImageData(data, 0, 0); return k.toDataURL('image/png'); };
  return [{ name: 'Background', src: png(back) }, { name: 'Subject', src: png(subj) }];
};

async function viaLocal(src) {
  const model = await ensureModel();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/model.onnx', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(model) }));
    await page.route('**/split.html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>split</title>' }));
    await page.goto('https://kit.local/split.html');
    return await page.evaluate(PAGE_JOB, { src, ort: ORT });
  } finally {
    await browser.close();
  }
}

/** Splits a picture: { src, layers?, prompt? } → { engine, layers: [{ name, src }] } (bottom to top). */
export async function splitImage(body) {
  const src = await asDataUrl(String(body?.src || ''));
  if (!/^data:image\//.test(src)) throw Object.assign(new Error('give the picture as an image (a data: URL or an address)'), { code: 400 });
  if (falKey()) {
    const layers = await viaFal(src, body.layers, body.prompt);
    return { engine: 'fal', layers: layers.map((l, i) => ({ name: `Layer ${i + 1}`, src: l.src })) };
  }
  return { engine: 'local', layers: await viaLocal(src) };
}
