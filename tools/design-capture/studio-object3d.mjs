// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// "3D objects from a description": the AI designs an object as simple parts (box, rounded box, sphere, cylinder, cone,
// ring), the kit builds it as a real glTF model (GLB) for a 3D layer, and checks every attempt by measurement:
//   - every part touches the rest (no floating pieces),
//   - no part sits deep inside another (a lid half buried in its jar),
//   - sane proportions (no part a hair thin, nothing hundreds of times bigger than the rest).
// Problems go back to the AI (up to three attempts) and the attempt with the fewest is kept. Then the kit renders it
// from four sides and the AI looks: one more fix if something reads wrong (a mug handle on the inside, a backwards
// chair). Parts in metres; y is up; the object sits on y = 0.

import { writeFileSync } from 'node:fs';

const MAT = { matte: [0, 0.9], satin: [0, 0.55], glossy: [0, 0.2], metal: [1, 0.35], chrome: [1, 0.05] };

// ---- meshes: { pos: number[], nrm: number[], idx: number[] } in local space, unit size ----
function box(round = 0) {
  // A rounded box is a box with each vertex pushed toward a sphere (enough for soft product edges).
  const seg = round > 0 ? 6 : 1, pos = [], nrm = [], idx = [];
  const faces = [[0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1]];
  for (const [u, v, w, s] of faces) {
    const base = pos.length / 3;
    for (let i = 0; i <= seg; i++) for (let j = 0; j <= seg; j++) {
      const p = [0, 0, 0]; p[u] = (i / seg - 0.5) * s; p[v] = j / seg - 0.5; p[w] = 0.5 * s;
      let n = [0, 0, 0]; n[w] = s;
      if (round > 0) {
        const c = p.map((x) => Math.max(-0.5 + round, Math.min(0.5 - round, x)));
        const d = p.map((x, k) => x - c[k]), len = Math.hypot(...d) || 1;
        for (let k = 0; k < 3; k++) { p[k] = c[k] + (d[k] / len) * round; n[k] = d[k] / len; }
      }
      pos.push(...p); nrm.push(...n);
    }
    for (let i = 0; i < seg; i++) for (let j = 0; j < seg; j++) {
      const a = base + i * (seg + 1) + j, b = a + seg + 1;
      if (s > 0) idx.push(a, b, a + 1, b, b + 1, a + 1); else idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  return { pos, nrm, idx };
}
function lathe(profile, seg = 40) {
  // profile: [[r, y]] from bottom to top; normals from the profile's slope.
  const pos = [], nrm = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    profile.forEach(([r, y], k) => {
      const [r0, y0] = profile[Math.max(0, k - 1)], [r1, y1] = profile[Math.min(profile.length - 1, k + 1)];
      const dr = r1 - r0, dy = y1 - y0, l = Math.hypot(dr, dy) || 1;
      pos.push(r * ca, y, r * sa); nrm.push((dy / l) * ca, -dr / l, (dy / l) * sa);
    });
  }
  const P = profile.length;
  for (let i = 0; i < seg; i++) for (let k = 0; k < P - 1; k++) { const a = i * P + k, b = a + P; idx.push(a, a + 1, b, b, a + 1, b + 1); }
  return { pos, nrm, idx };
}
const sphere = () => lathe(Array.from({ length: 25 }, (_, i) => { const t = (i / 24) * Math.PI; return [0.5 * Math.sin(t), -0.5 * Math.cos(t)]; }));
const cylinder = () => lathe([[0, -0.5], [0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [0.5, 0.5], [0, 0.5]]);
const cone = () => lathe([[0, -0.5], [0.5, -0.5], [0.5, -0.5], [0, 0.5]]);
function ring(thick = 0.2) {
  const pos = [], nrm = [], idx = [], S = 40, T = 16, R = 0.5 - thick / 2, r = thick / 2;
  for (let i = 0; i <= S; i++) for (let j = 0; j <= T; j++) {
    const u = (i / S) * Math.PI * 2, v = (j / T) * Math.PI * 2;
    const n = [Math.cos(v) * Math.cos(u), Math.sin(v), Math.cos(v) * Math.sin(u)];
    pos.push((R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u)); nrm.push(...n);
  }
  for (let i = 0; i < S; i++) for (let j = 0; j < T; j++) { const a = i * (T + 1) + j, b = a + T + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  return { pos, nrm, idx };
}

const rot = ([rx = 0, ry = 0, rz = 0]) => {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  const X = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Y = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const Z = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  return mul(Y, mul(X, Z));
};
const apply = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);

/** A part placed in the world: its triangles and its world box. */
function build(part) {
  const size = part.size || [0.1, 0.1, 0.1];
  const base = part.shape === 'sphere' ? sphere() : part.shape === 'cylinder' ? cylinder() : part.shape === 'cone' ? cone()
    : part.shape === 'ring' ? ring(Math.min(0.45, (part.thickness ?? 0.2))) : box(part.shape === 'rounded-box' ? Math.min(0.45, part.round ?? 0.15) : 0);
  const R = rot(part.rotation || []), at = part.position || [0, 0, 0];
  const pos = [], nrm = [];
  for (let i = 0; i < base.pos.length; i += 3) {
    const p = apply(R, [base.pos[i] * size[0], base.pos[i + 1] * size[1], base.pos[i + 2] * size[2]]);
    pos.push(p[0] + at[0], p[1] + at[1], p[2] + at[2]);
    const n = apply(R, [base.nrm[i] / size[0], base.nrm[i + 1] / size[1], base.nrm[i + 2] / size[2]]), l = Math.hypot(...n) || 1;
    nrm.push(n[0] / l, n[1] / l, n[2] / l);
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  return { name: part.name || part.shape, pos, nrm, idx: base.idx, min, max, color: part.color || '#cccccc', finish: part.finish || 'satin' };
}

/** The measured problems with an object (its parts built): words the AI can act on. */
export function checkObject(built) {
  const problems = [];
  const gap = (a, b) => Math.max(0, ...[0, 1, 2].map((k) => Math.max(a.min[k] - b.max[k], b.min[k] - a.max[k])));
  const vol = (x) => [0, 1, 2].reduce((s, k) => s * Math.max(1e-6, x.max[k] - x.min[k]), 1);
  const all = { min: [0, 1, 2].map((k) => Math.min(...built.map((p) => p.min[k]))), max: [0, 1, 2].map((k) => Math.max(...built.map((p) => p.max[k]))) };
  const span = Math.max(...[0, 1, 2].map((k) => all.max[k] - all.min[k]));
  // Every part joined to the rest (a chain of touching parts from the first).
  const near = (a, b) => gap(a, b) <= span * 0.01;
  const seen = new Set([0]), todo = [0];
  while (todo.length) { const i = todo.pop(); built.forEach((p, j) => { if (!seen.has(j) && near(built[i], p)) { seen.add(j); todo.push(j); } }); }
  built.forEach((p, j) => { if (!seen.has(j)) problems.push(`"${p.name}" floats: it touches nothing (move it until it meets the part it belongs to).`); });
  // Buried: a part entirely inside another on every axis, so none of it shows. A band round a body, a lid on a jar or
  // a handle into a cup overlap on purpose and stick out somewhere, which is fine.
  const e = span * 0.005;
  for (let i = 0; i < built.length; i++) for (let j = 0; j < built.length; j++) {
    if (i === j) continue;
    const a = built[i], b = built[j];
    if (vol(a) < vol(b) && [0, 1, 2].every((k) => a.min[k] > b.min[k] + e && a.max[k] < b.max[k] - e)) problems.push(`"${a.name}" is buried inside "${b.name}": none of it shows. Move it out to where it belongs, or make it bigger.`);
  }
  for (const p of built) {
    const d = [0, 1, 2].map((k) => p.max[k] - p.min[k]);
    if (Math.min(...d) < span * 0.004) problems.push(`"${p.name}" is paper-thin (${Math.min(...d).toFixed(4)} m): give it some thickness.`);
  }
  if (all.min[1] < -span * 0.02 || all.min[1] > span * 0.02) problems.push(`The object should sit on the ground (its lowest point at y = 0; now ${all.min[1].toFixed(3)}).`);
  return { problems, span: Math.round(span * 1000) / 1000, parts: built.length };
}

/** The object as a GLB file (one mesh per part, each with its own material). */
export function toGlb(built) {
  const bufs = [], views = [], accessors = [], meshes = [], materials = [], nodes = [];
  let offset = 0;
  const add = (arr, type, target) => {
    const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), pad = (4 - (b.length % 4)) % 4;
    bufs.push(b, Buffer.alloc(pad)); views.push({ buffer: 0, byteOffset: offset, byteLength: b.length, target }); offset += b.length + pad;
    return views.length - 1;
  };
  built.forEach((p, i) => {
    const pos = new Float32Array(p.pos), nrm = new Float32Array(p.nrm), idx = new Uint32Array(p.idx);
    const vp = add(pos, 'p', 34962), vn = add(nrm, 'n', 34962), vi = add(idx, 'i', 34963);
    accessors.push({ bufferView: vp, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: p.min, max: p.max });
    accessors.push({ bufferView: vn, componentType: 5126, count: nrm.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: vi, componentType: 5125, count: idx.length, type: 'SCALAR' });
    const c = /^#([0-9a-f]{6})$/i.exec(p.color)?.[1] ?? 'cccccc';
    const lin = [0, 2, 4].map((k) => { const v = parseInt(c.slice(k, k + 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const [metal, rough] = MAT[p.finish] ?? MAT.satin;
    materials.push({ name: p.name, pbrMetallicRoughness: { baseColorFactor: [...lin, 1], metallicFactor: metal, roughnessFactor: rough } });
    meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: i * 3, NORMAL: i * 3 + 1 }, indices: i * 3 + 2, material: i }] });
    nodes.push({ name: p.name, mesh: i });
  });
  const bin = Buffer.concat(bufs);
  const gltf = { asset: { version: '2.0', generator: 'Unyson+ AI Dev Kit' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }] };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.write(type, 4); return b; };
  return Buffer.concat([head, ch(json.length, 'JSON'), json, ch(bin.length, 'BIN\0'), bin]);
}

const SYSTEM = `You design 3D objects from simple parts for a motion graphics tool. Answer with JSON only:
{ "name": "...", "parts": [ { "name": "body", "shape": "box|rounded-box|sphere|cylinder|cone|ring", "size": [x, y, z],
  "position": [x, y, z], "rotation": [rx, ry, rz], "color": "#rrggbb", "finish": "matte|satin|glossy|metal|chrome",
  "round": 0.15, "thickness": 0.2 } ] }
Units are metres; y is up; the object stands on y = 0 (its lowest point exactly at 0), centred on x = 0, z = 0.
size is the part's full width, height and depth before rotation (a cylinder's axis is y; a ring lies flat in x-z, rotate it to stand it up;
"thickness" is a ring's tube as a share of its size, "round" a rounded box's corner as a share of its size).
position is the part's centre. Rotation in degrees. Real proportions. 3 to 30 parts. Every part must touch the part it belongs to;
none may sit deep inside another. The front faces +z.`;

/**
 * Builds an object from a description: { prompt, attempts? (default 3), look? (render and review, default true),
 * playerBase? } → { glb (Buffer), name, parts, problems, attempts: [{ problems }], looked, notes }.
 */
export async function objectFromDescription({ prompt, attempts = 3, look = true, playerBase, onStep = () => {} }) {
  if (!prompt || !String(prompt).trim()) throw Object.assign(new Error('Describe the object.'), { code: 400 });
  const { askText, askWithImages, extractJson } = await import('./to-ai.mjs');
  const tries = [];
  let best = null, feedback = '';
  for (let k = 0; k < attempts; k++) {
    onStep(k ? `Fixing it (attempt ${k + 1})` : 'Designing the object');
    const raw = await askText({ system: SYSTEM, user: `${prompt}${feedback}`, maxTokens: 6000 });
    let spec;
    try { spec = extractJson(raw); } catch { tries.push({ problems: ['The answer was not JSON.'] }); feedback = '\n\nYour last answer was not valid JSON. Answer with the JSON only.'; continue; }
    const built = (spec.parts || []).slice(0, 40).map(build);
    if (!built.length) { tries.push({ problems: ['No parts.'] }); continue; }
    const c = checkObject(built);
    tries.push({ problems: c.problems });
    if (!best || c.problems.length < best.check.problems.length) best = { spec, built, check: c };
    if (!c.problems.length) break;
    feedback = `\n\nYOUR LAST DESIGN (fix it, keep what works):\n${JSON.stringify(spec)}\n\nMEASURED PROBLEMS:\n- ${c.problems.join('\n- ')}`;
  }
  if (!best) throw new Error('No usable design came back.');
  let notes = '', looked = false;
  if (look && playerBase) {
    try {
      onStep('Looking at it from four sides');
      const views = await renderViews(toGlb(best.built), playerBase);
      const r = await askWithImages({
        system: `${SYSTEM}\n\nYou now see the built object from the front, the right, the back and above (in that order). If something reads wrong (a part on the wrong side, facing backwards, wrong proportions for the thing described), answer with the corrected JSON. If it reads right, answer with exactly: OK`,
        user: `The object: ${prompt}\nThe design: ${JSON.stringify(best.spec)}`, images: views.files,
      });
      looked = true;
      const text = (r.text || '').trim();
      if (!/^OK\b/i.test(text)) {
        try {
          const spec = extractJson(text), built = (spec.parts || []).slice(0, 40).map(build), c = checkObject(built);
          if (built.length && c.problems.length <= best.check.problems.length) { best = { spec, built, check: c }; notes = 'Corrected after looking at it.'; }
        } catch { /* keep the measured best */ }
      } else notes = 'Looked right from every side.';
      views.cleanup();
    } catch (e) { notes = `Not looked at (${e.message}).`; }
  }
  return { glb: toGlb(best.built), name: best.spec.name || prompt.slice(0, 40), parts: best.built.length, problems: best.check.problems, attempts: tries, looked, notes };
}

/** Front, right, back and top stills of a GLB, rendered by the Studio's own player in the kit's browser. */
async function renderViews(glb, playerBase) {
  const { renderStills } = await import('./studio-director.mjs');
  const { rmSync } = await import('node:fs');
  const src = `data:model/gltf-binary;base64,${glb.toString('base64')}`;
  const layer = (ry, rx) => ({ id: `v${ry}-${rx}`, type: 'model', model: { kind: 'gltf', src }, material: { original: true }, pose: { ry, rx }, box: { x: 50, y: 50, w: 60, h: 90 }, clips: [] });
  const views = [[0, 0], [90, 0], [180, 0], [0, 80]];
  const scene = { format: 'unysonplus-scene', version: 1, title: 'views', duration: views.length, stage: { breakpoints: [{ id: 'd', label: 'd', minWidth: 0, aspect: [1, 1] }], heightMode: 'ratio', background: '#e9ecef', fonts: [] },
    playback: { trigger: 'manual', loop: false }, layers: views.map(([ry, rx], i) => ({ ...layer(ry, rx), start: i, end: i + 1 })) };
  const r = await renderStills({ scene, playerBase, times: views.map((_, i) => i + 0.5), width: 512 });
  return { files: r.files.map((f) => f.file), cleanup: () => { try { rmSync(r.dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

export function writeGlb(file, glb) { writeFileSync(file, glb); }
