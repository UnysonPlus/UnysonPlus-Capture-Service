// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Word pins for the kit: layers and clips timed by what a voice says ("when the voice says *database*") rather than by
// seconds. The same rule as the player's words.ts (keep the two in step): a pin { audio, text, index?, edge?, offset? }
// on a layer (at, until) or a clip (at) is moved onto that word of the voice clip, so a voice spoken again (another
// language, a spreadsheet's row, a better take) re-times everything pinned to it. The player applies pins when it
// plays; the kit applies them when it writes a scene, so the file's times are the ones that play.

const r3 = (x) => Math.round(x * 1000) / 1000;
export const normWord = (w) => String(w).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const tokens = (text) => String(text).split(/\s+/).map(normWord).filter(Boolean);

function occurrences(words, want) {
  const out = [];
  if (!want.length) return out;
  const said = words.map((w) => normWord(w.w));
  for (let i = 0; i + want.length <= said.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) if (said[i + k] !== want[k]) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

function likeness(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
/** Speech recognition mishears ("exceso" for "acceso"): the closest stretch of words (one more or fewer), if alike enough. */
export const PIN_LIKENESS = 0.72;
function closest(words, want, hint) {
  const said = words.map((w) => normWord(w.w));
  const target = want.join('');
  if (target.length < 5) return null; // short words must be heard as written ("the" and "they")
  let best = null;
  for (let count = Math.max(1, want.length - 1); count <= want.length + 1; count++) {
    for (let i = 0; i + count <= said.length; i++) {
      const score = likeness(said.slice(i, i + count).join(''), target);
      if (score < PIN_LIKENESS) continue;
      if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && typeof hint === 'number' && Math.abs(i - hint) < Math.abs(best.index - hint))) best = { index: i, count, score };
    }
  }
  return best;
}

/** The moment a pin points at ({ t, audio, index }), or null when its voice or its words are not there. */
export function pinTime(scene, pin) {
  const audio = scene.audio || [];
  const named = audio.find((a) => a.id === pin.audio);
  if (!named) return null;
  const pool = [named, ...(named.group ? audio.filter((a) => a !== named && a.group === named.group) : [])];
  const want = tokens(pin.text);
  for (const pass of ['exact', 'close']) for (const clip of pool) {
    const words = clip.words || [];
    const hint = clip === named ? pin.index : undefined;
    let near = -1, count = want.length;
    if (pass === 'exact') {
      const found = occurrences(words, want);
      if (!found.length) continue;
      near = typeof hint === 'number' ? found.reduce((b, i) => (Math.abs(i - hint) < Math.abs(b - hint) ? i : b), found[0]) : found[0];
    } else {
      const c = want.length ? closest(words, want, hint) : null;
      if (!c) continue;
      near = c.index; count = c.count;
    }
    const first = words[near], last = words[near + count - 1];
    const fileT = pin.edge === 'end' ? last.t + last.d : first.t;
    return { t: r3(Math.max(0, clip.start + (fileT - (clip.offset || 0)) + (pin.offset || 0))), audio: clip.id, index: near };
  }
  return null;
}

/** The scene (a copy) with every pinned layer and clip on its word, and the pins whose words were not found. */
export function applyWordPins(input) {
  const scene = JSON.parse(JSON.stringify(input));
  const problems = [];
  let moved = 0;
  const at = (pin, layerId, clipId) => {
    const m = pinTime(scene, pin);
    if (!m) problems.push({ layerId, clipId, text: pin.text, reason: (scene.audio || []).some((a) => a.id === pin.audio) ? 'words' : 'audio' });
    else if (m.audio === pin.audio) pin.index = m.index;
    return m;
  };
  const walk = (list, base) => list.forEach((l) => {
    if (l.at) {
      const m = at(l.at, l.id);
      if (m) {
        const delta = r3(m.t - base - (l.start || 0));
        if (Math.abs(delta) > 0.0005) {
          moved++;
          l.start = r3((l.start || 0) + delta);
          if (typeof l.end === 'number') l.end = r3(l.end + delta);
          (l.clips || []).forEach((c) => { c.start = r3(c.start + delta); });
        }
      }
    }
    if (l.until) {
      const m = at(l.until, l.id);
      if (m) { const end = r3(m.t - base); if (l.end !== end) { moved++; l.end = end; } }
    }
    (l.clips || []).forEach((c) => {
      if (!c.at) return;
      const m = at(c.at, l.id, c.id);
      if (m) { const start = r3(m.t - base); if (Math.abs(start - c.start) > 0.0005) moved++; c.start = start; }
    });
    if (l.type === 'group') walk(l.layers || [], base + (l.start || 0));
    if (l.type === 'repeat' && l.item) walk([l.item], base);
  });
  walk(scene.layers || [], 0);
  return { scene, problems, moved };
}

/** Every pin in a scene: { layerId, clipId?, kind: 'at' | 'until', pin } (the live objects, to change them in place). */
export function wordPins(scene) {
  const out = [];
  const walk = (list) => list.forEach((l) => {
    if (l.at) out.push({ layerId: l.id, kind: 'at', pin: l.at });
    if (l.until) out.push({ layerId: l.id, kind: 'until', pin: l.until });
    (l.clips || []).forEach((c) => { if (c.at) out.push({ layerId: l.id, clipId: c.id, kind: 'at', pin: c.at }); });
    if (l.type === 'group') walk(l.layers || []);
    if (l.type === 'repeat' && l.item) walk([l.item]);
  });
  walk(scene.layers || []);
  return out;
}
