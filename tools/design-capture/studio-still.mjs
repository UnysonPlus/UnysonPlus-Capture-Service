// Path-traced stills for Kinetic Scenes' 3D layers: the layer's model rendered in Blender's Cycles at exactly the pose
// and camera the player shows it with at the scene's still frame, as a transparent picture the size of the layer's 3D
// canvas. The player shows it instead of the live 3D for the cover image and for visitors who turn motion off.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { findFfmpeg, launchRenderer, pageHtml } from './studio-render.mjs';
import { spawnSync } from 'node:child_process';
import { blenderStill } from './studio-blender.mjs';
import * as ws from './studio-workspace.mjs';

const BLEED = 0.35;

/** Every layer of a scene, groups included. */
const flat = (list, out = []) => { for (const l of list || []) { out.push(l); if (l.layers) flat(l.layers, out); } return out; };

/** The model file a layer points at, as a local path (data: URLs and web addresses are written to a temporary file). */
async function glbFile(src, project) {
  if (!src) throw new Error('This 3D layer has no model file.');
  const tmp = join(tmpdir(), `upw-still-${Date.now()}.glb`);
  if (src.startsWith('data:')) { writeFileSync(tmp, Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')); return tmp; }
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`Could not download the model (${r.status}).`);
    writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
    return tmp;
  }
  if (isAbsolute(src) && existsSync(src)) return src;
  if (project) { const p = ws.projectFile(project, src); if (p && existsSync(p)) return p; }
  if (existsSync(src)) return resolve(src);
  throw new Error(`Can't find the model "${src}"${project ? ` in project ${project}` : ' (give the project it is in)'}.`);
}

/**
 * Renders a path-traced still for one 3D layer (a glTF / GLB model) at the scene's still frame (playback.posterTime,
 * or `at`). Returns { still (a PNG data: URL, or a media/ path when project is given), at, seconds, device, size }.
 * glb: the model's bytes when the scene names a file only the caller can read (the Studio's own files).
 */
export async function pathTracedStill({ scene, layerId, playerBase, project = null, at, width = 1920, scale = 2, samples = 48, glb = null }) {
  if (!scene || scene.format !== 'unysonplus-scene') throw new Error('Send a scene file.');
  if (!/^https?:\/\/[^\s"'<>]+\/$/.test(String(playerBase || ''))) throw new Error('Send the player address (playerBase).');
  const layer = flat(scene.layers).find((l) => l.id === layerId);
  if (!layer || layer.type !== 'model') throw new Error(`No 3D layer "${layerId}" in the scene.`);
  if (layer.model?.kind !== 'gltf') throw new Error('Path-traced stills work on glTF / GLB models (3D text, shapes, logos and devices are drawn by the player itself).');
  const t = typeof at === 'number' ? at : Math.min(scene.duration, typeof scene.playback?.posterTime === 'number' ? scene.playback.posterTime : scene.duration - 0.01);
  // The stage at the scene's first (largest) layout, as the cover is taken.
  const bp = scene.stage?.breakpoints?.[0];
  const ratio = bp?.aspect ? bp.aspect[0] / bp.aspect[1] : 16 / 9;
  const w = Math.round(width), h = Math.round(width / ratio);
  // Where the layer sits and what pose it has at that moment, from the player itself.
  const { browser } = await launchRenderer();
  let info;
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(pageHtml({ ...scene, layers: scene.layers }, playerBase), { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 60000 });
    const err = await page.evaluate(() => window.__error);
    if (err) throw new Error(`The player could not show the scene: ${err}`);
    info = await page.evaluate(({ id, t }) => {
      window.P.seek(t);
      const el = document.querySelector(`[data-layer="${CSS.escape(id)}"] .upw-3d`) || document.querySelector(`[data-layer="${CSS.escape(id)}"]`);
      const r = el ? el.getBoundingClientRect() : null;
      const st = window.P.modelState ? window.P.modelState(id) : null;
      const pick = st ? Object.fromEntries(['rx', 'ry', 'rz', 's', 'px', 'py', 'orbit', 'tilt', 'dolly', 'open'].map((k) => [k, Number(st[k]) || 0])) : null;
      if (pick && !st.s) pick.s = 1;
      if (pick && !st.dolly) pick.dolly = 1;
      return { state: pick, box: r ? { w: r.width, h: r.height } : null };
    }, { id: layerId, t });
  } finally { await browser.close().catch(() => {}); }
  if (!info?.state) throw new Error('This player is too old for path-traced stills: use player 0.0.75 or later.');
  if (!info.box || info.box.w < 4 || info.box.h < 4) throw new Error(`The layer is not on the stage at ${t} s.`);
  // Twice the layer's size on screen (sharp on high-density screens), but no side over 1,600 px: it is one picture in a web page.
  let cw = info.box.w * (1 + 2 * BLEED) * scale, ch = info.box.h * (1 + 2 * BLEED) * scale;
  const cap = 1600 / Math.max(cw, ch);
  if (cap < 1) { cw *= cap; ch *= cap; }
  const canvas = { w: Math.round(cw), h: Math.round(ch) };
  let file;
  if (glb) { file = join(tmpdir(), `upw-still-${Date.now()}.glb`); writeFileSync(file, glb); } else file = await glbFile(layer.model.src, project);
  const r = await blenderStill({ glb: file, state: info.state, pose: layer.pose || {}, canvas, light: layer.light ?? 1, samples });
  // WebP keeps the transparency at a fraction of the PNG's size (falls back to the PNG without ffmpeg).
  let file2 = r.png, type = 'image/png', ext = 'png';
  const ff = await findFfmpeg();
  if (ff) {
    const webp = r.png.replace(/\.png$/i, '.webp');
    const run = spawnSync(ff, ['-y', '-v', 'error', '-i', r.png, '-c:v', 'libwebp', '-lossless', '0', '-quality', '90', '-pix_fmt', 'yuva420p', webp]);
    if (run.status === 0 && existsSync(webp)) { file2 = webp; type = 'image/webp'; ext = 'webp'; }
  }
  const pic = readFileSync(file2);
  let still;
  if (project) { mkdirSync(ws.projectDir(project, { create: false }), { recursive: true }); still = ws.addMedia(project, `${layerId}-still.${ext}`, pic); }
  else still = `data:${type};base64,${pic.toString('base64')}`;
  return { still, at: t, seconds: r.seconds, device: r.device, size: canvas, file: file2, bytes: pic.length };
}
