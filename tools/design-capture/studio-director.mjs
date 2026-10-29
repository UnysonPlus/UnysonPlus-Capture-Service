// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Kinetic Scenes' AI director: the steps around making a scene that turn a one-shot answer into designed work.
 *
 *   plan    A storyboard (or, for an explainer, a narration script split into segments) the person can
 *           adjust before anything is built.
 *   review  Look, criticise, fix: the scene's key frames are rendered (each act once it has settled, and the
 *           middle of each transition), the Studio's own Check scene runs, and the AI looks at the frames like
 *           a reviewer and returns a corrected scene (or says it is fine).
 *   quick   A website's real words, colours, fonts and screenshots, for a scene built from them.
 *
 * Everything runs on the person's computer with their own AI (see to-ai.mjs); frames are rendered by the
 * kit's browser with the Studio's published player.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { aiBackend, askText, askWithImages, extractJson, stripReasoning } from './to-ai.mjs';
import { pageHtml } from './studio-render.mjs';

const clip = (s, n) => String(s || '').slice(0, n);
const err = (msg, code = 400) => Object.assign(new Error(msg), { code });

/* ------------------------------------------------------------------ plan */

const PLAN_SYSTEM = `You are the director of a motion-graphics scene for Unyson+ Kinetic Scenes (animated website heroes,
explainers, product tours and short videos made of text, shapes, images, code, diagrams and a cursor, animated by presets).
Before anything is built you write the plan, so the person can steer. Answer with ONE JSON object and nothing else.

For a STORYBOARD: { "title": "...", "plan": "<markdown>" } where the plan has, in this order:
- **Hook** (the first two seconds: what grabs attention), **Acts** (a numbered list: each act's length in seconds, what
  appears one by one, its layout in a phrase, its entrance and its transition into the next), **Ending** (the call to
  action, and whether the last part loops), **Sound** (music, the few sounds and where they land), **Length** (total).

For an EXPLAINER or a TUTORIAL: { "title": "...", "plan": "<markdown summary>", "segments": [ { "narration": "<what is
said, one or two sentences>", "visual": "<what the screen shows and does while it is said>" } ] } following: a hook in
the first two seconds, the problem, the product in use (entry, the key action, the result), why it matters, a call to
action. The narration explains what the viewer sees instead of reading the screen aloud; every segment moves the picture
(a cursor click, a focus, a state change, kinetic type for the key phrase). For a coding tutorial, the visuals name the
exact code typed or changed in each segment, and the code must be correct.

Never invent facts, numbers, names or claims the request does not give.`;

/** The length a request asks for, in seconds ("a 20 second explainer", "30s", "1 minute"), or 0. */
export function requestedSeconds(text) {
  const m = /(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(seconds?|secs?|s|minutes?|mins?)\b/i.exec(String(text || ''));
  if (!m) return 0;
  const n = Number(m[1]);
  return /^m/i.test(m[2]) ? n * 60 : n;
}

/**
 * The narration words that fit a length: the kit's voice speaks about 2.6 words a second, with a short pause
 * between segments and a moment of picture before the first line and after the last.
 */
const wordBudget = (seconds, segments = 6) => Math.max(8, Math.floor((seconds - 1.2 - 0.4 * (segments - 1)) * 2.6));
const narrationWords = (segs) => segs.reduce((n, s) => n + s.narration.split(/\s+/).filter(Boolean).length, 0);

export async function studioPlan(input) {
  const prompt = clip(input.prompt, 4000).trim();
  if (!prompt) throw err('Describe what to make.');
  if (!aiBackend()) throw err('AI is off in the AI Dev Kit. Connect an AI first.', 503);
  const kind = ['storyboard', 'explainer', 'tutorial'].includes(input.kind) ? input.kind : 'storyboard';
  const rules = clip(input.rules, 60000);
  const secs = kind === 'storyboard' ? 0 : requestedSeconds(prompt);
  const budget = secs ? wordBudget(secs) : 0;
  const user = JSON.stringify({
    kind: kind.toUpperCase(), request: prompt, ...(input.context ? { context: clip(input.context, 30000) } : {}), stage: input.stage,
    ...(budget ? { length: `${secs} seconds: the narration of all segments together is at most ${budget} words (spoken, it fills the length)` } : {}),
    PRESETS: Array.isArray(input.catalog) ? input.catalog.map((p) => `${p.id}: ${p.label}`) : undefined,
  });
  const system = rules ? `${PLAN_SYSTEM}\n\nTHE STUDIO'S MOTION RULES (plan within them)\n${rules}` : PLAN_SYSTEM;
  const read = (raw) => {
    const j = extractJson(stripReasoning(raw));
    if (!j || typeof j.plan !== 'string') throw new Error('The AI did not return a plan. Try rephrasing the request.');
    return { title: String(j.title || ''), plan: j.plan, segments: Array.isArray(j.segments) ? j.segments.filter((s) => s && s.narration).map((s) => ({ narration: String(s.narration), visual: String(s.visual || '') })) : undefined };
  };
  let out = read(await askText({ system, user, maxTokens: 6000 }));
  // A script well over its length would make a longer video than asked for: one chance to tighten it.
  if (budget && out.segments?.length) {
    const words = narrationWords(out.segments);
    const fit = wordBudget(secs, out.segments.length);
    if (words > fit * 1.25) {
      try {
        const again = read(await askText({ system, user: `${user}\n\nYOUR PLAN (too long: ${words} narration words; ${secs} seconds holds about ${fit})\n${JSON.stringify(out)}\n\nReturn the same plan with the narration cut to at most ${fit} words in total: fewer, shorter segments, the same story.`, maxTokens: 6000 }));
        if (again.segments?.length && narrationWords(again.segments) < words) out = again;
      } catch { /* keep the first plan */ }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the moments worth looking at */

/** Each act once it has settled, the middle of every transition, and the still frame: at most 8, in order. */
export function keyMoments(scene) {
  const out = new Set();
  const dur = Number(scene.duration) || 6;
  const layers = Array.isArray(scene.layers) ? scene.layers : [];
  const groups = layers.filter((l) => l && l.type === 'group');
  const settled = (l, off) => {
    const ins = (l.clips || []).filter((c) => (c.params || {}).direction !== 'out');
    return off + Math.max(0, ...ins.map((c) => c.start + c.duration));
  };
  for (const g of groups) {
    const a = g.start || 0;
    const kids = (g.layers || []).map((k) => settled(k, a));
    const t = Math.max(settled(g, 0), ...kids) + 0.2;
    const exits = [...(g.clips || []), ...(g.layers || []).flatMap((k) => k.clips || [])].filter((c) => (c.params || {}).direction === 'out');
    const firstExit = exits.length ? Math.min(...exits.map((c) => (g.clips.includes(c) ? 0 : a) + c.start)) : (g.end ?? dur);
    out.add(Math.min(t, firstExit - 0.1, dur - 0.05));
    for (const c of g.clips || []) if (String(c.preset).startsWith('tr-') && (c.params || {}).direction !== 'out') out.add(c.start + c.duration / 2);
  }
  if (!groups.length) for (const f of [0.3, 0.55, 0.85]) out.add(dur * f);
  if (typeof scene.playback?.posterTime === 'number') out.add(scene.playback.posterTime);
  return [...out].filter((t) => t >= 0 && t <= dur).map((t) => Math.round(t * 100) / 100).sort((a, b) => a - b).slice(0, 8);
}

/** Renders frames of a scene (JPEG files in a temp folder) and runs the player's own checks. */
export async function renderStills({ scene, playerBase, times, width = 1280 }) {
  if (!playerBase || !/^https?:\/\//.test(playerBase)) throw err('The Studio did not say where its player is.');
  const bp = (scene.stage?.breakpoints || [])[0];
  const aspect = bp ? bp.aspect[0] / bp.aspect[1] : 16 / 9;
  const height = Math.round(width / aspect);
  const dir = mkdtempSync(join(tmpdir(), 'upw-stills-'));
  const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'] });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(pageHtml(scene, playerBase, { composite: true }), { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 45000 }).catch(() => {});
    const bad = await page.evaluate(() => window.__error || '');
    if (bad) throw new Error(`The scene did not play: ${bad}`);
    const issues = await page.evaluate((sc) => (window.UnysonPlusScene.lintScene ? window.UnysonPlusScene.lintScene(sc).map((i) => `${i.severity}: ${i.message}`) : []), scene).catch(() => []);
    // "settled": the moments each part has fully landed, from the player (older players: the kit's own key moments).
    if (times === 'settled' || !Array.isArray(times) || !times.length) {
      const settled = await page.evaluate(() => (window.UnysonPlusScene.settledMoments ? window.UnysonPlusScene.settledMoments(window.P.scene) : null)).catch(() => null);
      times = settled && settled.length ? settled : keyMoments(scene);
    }
    const files = [];
    const layout = [];
    for (const t of times) {
      await page.evaluate(async (s) => { window.P.seek(s); if (window.P.settle) await window.P.settle(); }, t);
      // Footage still loading (a file on disk, the first still) can show its first frame: wait until every video has
      // finished seeking and has the frame (up to 5 s), then seek once more so the layer shows it.
      const waited = await page.waitForFunction(() => [...document.querySelectorAll('video')].every((v) => !v.seeking && v.readyState >= 2), null, { timeout: 5000 }).then(() => true).catch(() => false);
      if (waited) await page.evaluate(async (s) => { window.P.seek(s); if (window.P.settle) await window.P.settle(); }, t);
      await page.waitForTimeout(120);
      // The rendered frame's layout: words on words, crossing panels, ticks far from their words, uneven lists.
      const found = await page.evaluate((s) => (window.UnysonPlusScene.layoutIssues ? window.UnysonPlusScene.layoutIssues(window.P.canvas(), window.P.scene, s) : []), t).catch(() => []);
      for (const i of found) layout.push(`${i.severity} at ${t}s: ${i.message}`);
      const f = join(dir, `frame-${String(Math.round(t * 100)).padStart(5, '0')}.jpg`);
      await page.screenshot({ path: f, type: 'jpeg', quality: 72 });
      files.push({ t, file: f });
    }
    return { dir, files, issues, layout };
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ look, criticise, fix */

const REVIEW_SYSTEM = `You are a demanding motion designer reviewing a Unyson+ Kinetic Scenes scene before it is shown to the
person who asked for it. You are given the scene file, the Studio's Check scene report and rendered frames at key
moments: each part once it has fully landed, everything in and nothing leaving yet. "layout" lists what was measured on
those frames (words on words, a tick far from its words, uneven or off-centre lists, words crossing or touching a panel's
edge): fix every one. Then look at every frame yourself and go through this list for each one:
- Alignment: things that belong together share an edge or a centre; a list sits centred under its heading.
- Spacing: equal gaps between the items of a list; marks (ticks, bullets) next to their words, not at a box's edge.
- Panels: words have room inside a panel and never touch or cross its edge; captions sit clear of panels.
- Balance: nothing crowds one side while the other is empty; the frame isn't cramped or cluttered.
- Edges and reading: nothing cut off; text big enough, long enough and with enough contrast to read.
- Motion: no muddy transition, a strong ending, nothing that breaks the motion rules.

Then judge the scene as a design jury would, from all the frames together (they span the whole scene, so judge how it
moves, not one still). Score each point 1-5:
  style (does it look like the style asked for, from every frame?), idea (is there one clear idea and a hero moment
  that lands, about two-thirds through?), motion (timing, easing, rhythm, a hook in the first half-second, a held end
  frame), design (hierarchy, composition, type, colour), finish (detail, alignment, nothing rough or placeholder),
  sound (hits on the moves they belong to; 3 when there is no sound), technical (nothing cut off, readable, inside the
  safe and covered areas).
Fix the WEAKEST points first. Every fix names its moment and concrete numbers ("at 4.2 s the headline holds 0.4 s: hold
it 1.2 s", "the logo at x 62 is 6 off centre: x 50"), never a vague wish. What was MEASURED ("check", "layout") overrules
what you think you see: never leave a measured problem unfixed because a frame looks fine to you, and never undo a fix
the measurements asked for.

Answer with ONE JSON object and nothing else:
{ "ok": true, "notes": "<one sentence>", "scores": { "style": n, "idea": n, "motion": n, "design": n, "finish": n, "sound": n, "technical": n } }
when nothing needs fixing (only when no point is below 4 and nothing was measured), or
{ "scene": <the WHOLE corrected scene>, "explanation": "<what you saw and what you fixed, weakest first, two or three plain sentences>", "scores": { ...the scores before your fixes } }.
Keep everything that works exactly as it is, including ids. Use only presets from PRESETS and only params they list.`;

/**
 * The scene as the AI reads it: embedded files (pictures, sounds: often megabytes) become short placeholders
 * and the audio loses its word lists; restore() puts the files back into the answer and keeps the audio
 * exactly as it was (the AI never changes it). The frames are rendered from the real scene.
 */
function forAi(scene) {
  const assets = new Map();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.startsWith('data:') && v.length > 200) { const k = `asset:${assets.size + 1}`; assets.set(k, v); return k; }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const audio = Array.isArray(scene.audio) ? scene.audio.map(({ words: _w, speech: _s, beats: _b, envelope: _e, ...a }) => a) : undefined;
  const slim = walk({ ...scene, ...(audio ? { audio } : {}) });
  const back = (v) => {
    if (typeof v === 'string') return assets.get(v) ?? v;
    if (Array.isArray(v)) return v.map(back);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, back(x)]));
    return v;
  };
  const restore = (answer) => {
    const out = back(answer);
    if (Array.isArray(scene.audio) && scene.audio.length) out.audio = scene.audio; else delete out.audio;
    return out;
  };
  return { slim, restore, back };
}

const REVIEW_PATCH = `
ANSWER WITH CHANGES ONLY (this request): instead of the whole scene, return
{ "update": [ <each layer you change, whole, with its id unchanged (nested layers too)> ], "add": [ <new layers, on top> ],
  "remove": [ <ids of layers to delete> ], "explanation": "<two or three plain sentences>" }
or { "ok": true, "notes": "<one sentence>" } when nothing needs fixing. Add "scores" (the seven points, 1-5) to either answer. Leave out every layer you do not change.`;

/** Applies a review's changes to the scene: changed layers replaced by id (anywhere in the tree), new ones on top, removed ones dropped. */
function applyChanges(scene, j, back) {
  const upd = new Map((Array.isArray(j.update) ? j.update : []).filter((l) => l && l.id).map((l) => [l.id, back(l)]));
  const gone = new Set(Array.isArray(j.remove) ? j.remove : []);
  const walk = (list) => list.filter((l) => !gone.has(l.id)).map((l) => {
    const n = upd.get(l.id) ?? l;
    return Array.isArray(n.layers) ? { ...n, layers: walk(n.layers) } : n;
  });
  return { ...scene, layers: [...walk(scene.layers || []), ...(Array.isArray(j.add) ? j.add.map(back) : [])] };
}

export async function studioReview(input) {
  const scene = input.scene;
  if (!scene || typeof scene !== 'object') throw err('Give the scene to review.');
  if (!aiBackend()) throw err('AI is off in the AI Dev Kit. Connect an AI first.', 503);
  let stills = await renderStills({ scene, playerBase: input.playerBase, times: Array.isArray(input.times) && input.times.length ? input.times.slice(0, 8) : 'settled' });
  // A scene of continuous effects (particles, a grade, footage) has few "settled" moments, sometimes one: look at
  // frames spread across the whole scene instead, so the review sees how it plays, not a single instant.
  // The jury judges motion, so it needs enough frames: with fewer than six settled ones, frames spread across the whole
  // scene are added to them.
  if (!input.times?.length && stills.files.length < 6 && Number(scene.duration) > 2) {
    const settled = stills.files.map((f) => f.t);
    rmSync(stills.dir, { recursive: true, force: true });
    const d = Number(scene.duration);
    const spread = [0.1, 0.28, 0.46, 0.64, 0.82, 0.96].map((f) => Math.round(f * d * 100) / 100);
    const times = [...new Set([...settled, ...spread])].sort((x, y) => x - y).filter((t, i, all) => i === 0 || t - all[i - 1] > 0.25);
    stills = await renderStills({ scene, playerBase: input.playerBase, times });
  }
  // Too many frames slow the look down: keep up to ten, spread across the scene.
  if (stills.files.length > 10) stills.files = stills.files.filter((_, i, all) => i % Math.ceil(all.length / 10) === 0 || i === all.length - 1);
  const times = stills.files.map((f) => f.t);
  const ai = forAi(scene);
  try {
    const rules = clip(input.rules, 60000);
    const user = JSON.stringify({
      request: clip(input.prompt, 2000), frames: stills.files.map((f) => `${f.file.split(/[\\/]/).pop()} = the frame at ${f.t} s`),
      check: stills.issues.slice(0, 40), layout: (stills.layout || []).slice(0, 40), scene: ai.slim, PRESETS: input.catalog,
    });
    // Changes only (much shorter, so much quicker) when the Studio asks; the kit puts them into the scene.
    const system = `${REVIEW_SYSTEM}${input.patch ? REVIEW_PATCH : ''}`;
    const r = await askWithImages({ system: rules ? `${system}\n\nTHE STUDIO'S MOTION RULES\n${rules}` : system, user, images: stills.files.map((f) => f.file) });
    const j = extractJson(stripReasoning(r.text)) || {};
    if (input.patch && j.ok !== true && (j.update || j.add || j.remove)) {
      return { ok: false, scene: applyChanges(scene, j, ai.back), explanation: String(j.explanation || ''), scores: j.scores ?? null, looked: r.looked, frames: times };
    }
    if (j.ok === true || !j.scene) return { ok: true, notes: String(j.notes || j.explanation || 'No changes needed.'), scores: j.scores ?? null, looked: r.looked, frames: times };
    return { ok: false, scene: ai.restore(j.scene), explanation: String(j.explanation || ''), scores: j.scores ?? null, looked: r.looked, frames: times };
  } finally {
    rmSync(stills.dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ quick scene from a website or a project */

export async function studioQuick(input) {
  const url = String(input.url || '').trim();
  const folder = String(input.folder || '').trim();
  if (!url && !folder) throw err('Give a website address or a project folder.');
  const out = { brief: '', context: '', shots: [] };
  const facts = {};
  if (url) {
    if (!/^https?:\/\//i.test(url)) throw err('The address must start with http:// or https://.');
    const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || 'chrome', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => page.goto(url, { waitUntil: 'load', timeout: 45000 }));
      await page.waitForTimeout(1200);
      Object.assign(facts, await page.evaluate(() => {
        const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
        const cs = (el) => (el ? getComputedStyle(el) : null);
        const h1 = document.querySelector('h1');
        const btns = [...document.querySelectorAll('a[class*="btn"], a[class*="button"], button, .wp-block-button a')].map(text).filter((t) => t && t.length < 40).slice(0, 6);
        const firstBtn = document.querySelector('a[class*="btn"], a[class*="button"], button, .wp-block-button a');
        return {
          title: document.title, description: document.querySelector('meta[name="description"]')?.content || '',
          headline: text(h1), subheads: [...document.querySelectorAll('h2, h3')].map(text).filter(Boolean).slice(0, 8),
          paragraphs: [...document.querySelectorAll('p')].map(text).filter((t) => t.length > 40 && t.length < 280).slice(0, 5),
          buttons: [...new Set(btns)],
          colors: { background: cs(document.body)?.backgroundColor, text: cs(document.body)?.color, headline: cs(h1)?.color, button: cs(firstBtn)?.backgroundColor, buttonText: cs(firstBtn)?.color },
          fonts: { headline: cs(h1)?.fontFamily, body: cs(document.body)?.fontFamily },
        };
      }));
      // Two screenshots the scene can show (the top of the page, and the next screen down).
      for (const y of [0, 900]) {
        await page.evaluate((v) => window.scrollTo(0, v), y);
        await page.waitForTimeout(500);
        const buf = await page.screenshot({ type: 'jpeg', quality: 68 });
        out.shots.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
      }
    } finally {
      await browser.close();
    }
  }
  if (folder) {
    const read = (f) => { try { return readFileSync(join(folder, f), 'utf8'); } catch { return ''; } };
    const pkg = (() => { try { return JSON.parse(read('package.json')); } catch { return {}; } })();
    facts.project = { name: pkg.name || '', description: pkg.description || '', readme: clip(read('README.md') || read('readme.md'), 4000) };
  }
  out.context = `THE PRODUCT (from ${url || folder}; use only these facts):\n${JSON.stringify(facts, null, 1)}`;
  out.brief = `QUICK SCENE FROM ${url ? 'A WEBSITE' : 'A PROJECT'}: build an editable scene that shows this product in use, from the facts in "context" only (never invent claims, numbers or names). Use its real colours and fonts (map the font to the nearest Google Font). ${out.shots.length ? `There are ${out.shots.length} screenshots of it: put them in image layers with "src": "shot:1" and "shot:2" (the Studio fills them in); show them inside a browser frame, scrolling (scroll preset) or with a cursor pointing at the call to action, rather than describing the product.` : ''} Structure: a hook in the first two seconds (the headline idea), the product in use, the main benefit, and the call to action (one of the real button labels) at the end, looping its last part.`;
  return out;
}

export const directorReady = () => !!aiBackend();
