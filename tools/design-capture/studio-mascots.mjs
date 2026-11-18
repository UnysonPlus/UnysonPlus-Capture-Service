// Mascots for AI agents: list the mascots in the workspace's projects, copy one (with its pictures) into another
// project, and direct one (poses pinned to words of the voice-over). A mascot is a Kinetic Scenes "mascot" layer, made
// by the person in the Studio (Insert > Mascot...): see docs/mascots.md.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addMedia, listProjects, projectDir, readProject, writeProject } from './studio-workspace.mjs';

const bad = (m) => Object.assign(new Error(m), { code: 400 });
const allLayers = (list, out = []) => { for (const l of list || []) { out.push(l); if (l.layers) allLayers(l.layers, out); } return out; };
const normWord = (w) => String(w).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

// The sample mascots that come with the Studio (Pip, Daniel, Grace, Bolt…): the Studio publishes their list with their
// pictures, and a sample is used by full address (nothing to copy).
const STUDIO = process.env.KINETIC_STUDIO_URL || 'https://kinetic-scenes.unysonplus.com/';
let samplesCache = null;
export async function sampleMascots() {
  if (samplesCache) return samplesCache;
  const url = new URL('mascots/samples.json', STUDIO).href;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r?.ok) throw Object.assign(new Error(`Could not read the sample mascots (${url}): check the internet connection.`), { code: 503 });
  const j = await r.json();
  samplesCache = (j.samples || []).map((s) => ({ ...s, base: new URL('mascots/', STUDIO).href }));
  return samplesCache;
}
/** A sample as a mascot layer (pictures by full address). */
function sampleLayer(s) {
  const at = (f) => new URL(f, s.base).href;
  return {
    id: s.id, name: s.name, type: 'mascot', alt: s.alt, clips: [],
    poses: s.poses.map((p) => ({ id: p.id, name: p.name, src: at(p.file), ratio: s.ratio, mouth: s.face.mouth, eyes: s.face.eyes })),
    mouths: Object.fromEntries(Object.entries(s.mouths || {}).map(([k, f]) => [k, at(f)])),
  };
}

/** Every mascot in every workspace project. */
export async function listMascots() {
  const { projects } = await listProjects();
  const out = [];
  for (const p of projects) {
    let scene;
    try { scene = readProject(p.id).scene; } catch { continue; }
    for (const l of allLayers(scene.layers)) {
      if (l.type !== 'mascot') continue;
      out.push({
        project: p.id, layer: l.id, name: l.name || l.id,
        poses: (l.poses || []).map((x) => ({ id: x.id, name: x.name, talks: !!x.mouth, blinks: !!(x.eyes || []).length && !x.eyesClosed })),
        mouths: Object.keys(l.mouths || {}).length, mainPose: l.pose || l.poses?.[0]?.id, talksOn: l.audio || null,
      });
    }
  }
  return out;
}

/** Copies a mascot layer and its pictures from one project into another (placed at x / y %, sized by height %). */
export async function copyMascot({ from, layer, to, x = 50, y = 58, height = 70, id }) {
  let m;
  if (String(from).toLowerCase() === 'sample') {
    const samples = await sampleMascots();
    const s = samples.find((x) => x.id === String(layer).toLowerCase() || x.name.toLowerCase() === String(layer).toLowerCase());
    if (!s) throw bad(`No sample mascot "${layer}" (samples: ${samples.map((x) => x.name).join(', ')}).`);
    m = sampleLayer(s);
  } else {
    const src = readProject(from).scene;
    m = allLayers(src.layers).find((l) => l.id === layer && l.type === 'mascot');
  }
  if (!m) throw bad(`No mascot "${layer}" in project "${from}" (mascot_list shows them).`);
  const target = readProject(to);
  const scene = target.scene;
  const copy = JSON.parse(JSON.stringify(m));
  // Its pictures: copied into the target's media/ (pictures by full address, like the sample Pip, stay as they are).
  const bring = (s) => {
    if (typeof s !== 'string' || /^(https?:|data:)/.test(s)) return s;
    const file = join(projectDir(from), s);
    if (!existsSync(file)) throw bad(`The picture ${s} of "${layer}" is missing from project "${from}".`);
    return addMedia(to, s.split('/').pop(), readFileSync(file));
  };
  for (const p of copy.poses) p.src = bring(p.src);
  for (const k of Object.keys(copy.mouths || {})) copy.mouths[k] = bring(copy.mouths[k]);
  const taken = new Set(allLayers(scene.layers).map((l) => l.id));
  let nid = id || copy.id, n = 2;
  while (taken.has(nid)) nid = `${id || copy.id}-${n++}`;
  copy.id = nid;
  copy.clips = (copy.clips || []).filter((c) => c.preset !== 'mascot-pose'); // poses belong to the old voice
  delete copy.audio; delete copy.start; delete copy.end; delete copy.at; delete copy.until; delete copy.overrides;
  const bp = scene.stage?.breakpoints?.[0], aspect = bp ? bp.aspect[0] / bp.aspect[1] : 16 / 9;
  const ratio = copy.poses[0]?.ratio || 0.8;
  copy.box = { x, y, w: +Math.min(95, (height * ratio) / aspect).toFixed(2), h: height };
  scene.layers.push(copy);
  writeProject(to, scene, { base: target.mtime });
  return { project: to, layer: nid, pictures: copy.poses.length + Object.keys(copy.mouths || {}).length };
}

/**
 * Directs a mascot: each cue holds a pose while a word (or phrase) of the voice-over is said, pinned to the word so it
 * follows a new take. cues: [{ pose, word, index?, hold? }]. Replaces the mascot's Pose clips when replace is true.
 */
export function directMascot({ project, layer, cues, audio, replace = true }) {
  const p = readProject(project);
  const scene = p.scene;
  const m = allLayers(scene.layers).find((l) => l.id === layer && l.type === 'mascot');
  if (!m) throw bad(`No mascot "${layer}" in project "${project}".`);
  const voice = (scene.audio || []).find((a) => a.id === (audio || m.audio)) ?? (scene.audio || []).find((a) => a.role === 'voice' && a.words?.length) ?? (scene.audio || []).find((a) => a.words?.length);
  if (!voice) throw bad('The scene has no voice-over with its words: add one first (voice_over), then direct the mascot.');
  const ids = new Set(m.poses.map((x) => x.id));
  const byName = new Map(m.poses.map((x) => [normWord(x.name), x.id]));
  const clips = replace ? m.clips.filter((c) => c.preset !== 'mascot-pose') : [...m.clips];
  const report = [];
  let n = 1;
  for (const cue of cues || []) {
    const pose = ids.has(cue.pose) ? cue.pose : byName.get(normWord(cue.pose));
    if (!pose) { report.push(`- "${cue.pose}": no such pose (poses: ${m.poses.map((x) => x.id).join(', ')})`); continue; }
    const want = String(cue.word || '').split(/\s+/).map(normWord).filter(Boolean);
    const words = voice.words || [];
    const hits = [];
    for (let i = 0; i + want.length <= words.length; i++) if (want.every((w, k) => normWord(words[i + k].w) === w)) hits.push(i);
    const i = hits[Math.min(hits.length - 1, Math.max(0, (cue.index ?? 1) - 1))];
    if (i === undefined) { report.push(`- "${cue.word}": not said in the voice-over`); continue; }
    const t = +(voice.start + words[i].t - (voice.offset || 0) - 0.08).toFixed(2);
    let cid = `${m.id}-pose-${n++}`;
    while (clips.some((c) => c.id === cid)) cid = `${m.id}-pose-${n++}`;
    const hold = Math.max(0.6, Math.min(6, cue.hold ?? 1.6));
    clips.push({ id: cid, preset: 'mascot-pose', start: Math.max(0, t), duration: +hold.toFixed(2), params: { pose }, at: { audio: voice.id, text: cue.word, index: i, offset: -0.08 } });
    report.push(`- ${pose} at ${Math.max(0, t).toFixed(2)} s on "${cue.word}" for ${hold.toFixed(1)} s`);
  }
  m.clips = clips.sort((a, b) => a.start - b.start);
  writeProject(project, scene, { base: p.mtime });
  return { project, layer, report };
}
