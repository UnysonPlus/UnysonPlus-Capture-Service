// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Translate a video: a copy of a Kinetic Scenes project in another language. Every word on screen is translated, every
// voice-over is spoken again in a voice for that language (a free Piper voice by default; a Voicebox voice can speak
// ten languages, so the person's own voice can carry over), its words are timed in that language, captions follow the
// new words, and the word pins move to the translated words, so whatever was pinned plays on the new voice. The
// original project is never changed.
//
// The AI translates in one request: the texts, and each voice's script with its pinned phrases wrapped in ⟦n⟧…⟦/n⟧
// markers, which come back around their translations; that is how a pin finds its word in the new language.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, projectDir, readProject, writeProject, addNote, projectLink } from './studio-workspace.mjs';
import { VOICES, VOICEBOX_LANGUAGES, ensureVoice, startVoice, voiceForLanguage, voiceJob } from './studio-voice.mjs';
import { applyWordPins, normWord, wordPins } from './studio-pins.mjs';

const MEDIA = /^(?![a-z][a-z0-9+.-]*:)(?!\/)[^\s?#]+\.[a-z0-9]{2,5}$/i;
const r2 = (x) => Math.round(x * 100) / 100;

export function languageName(code, inLang = 'en') {
  try { return new Intl.DisplayNames([inLang], { type: 'language' }).of(code) || code; } catch { return code; }
}

/** Every piece of on-screen wording, as getters and setters on the (copied) scene. */
function textSlots(scene) {
  const slots = [];
  const add = (get, set) => { const v = get(); if (typeof v === 'string' && /\p{L}/u.test(v) && !MEDIA.test(v.trim())) slots.push({ text: v, set }); };
  add(() => scene.title, (v) => { scene.title = v; });
  const walk = (list) => (list || []).forEach((l) => {
    if (l.type === 'text') add(() => l.text, (v) => { l.text = v; });
    for (const o of Object.values(l.overrides || {})) if (o && typeof o.text === 'string') add(() => o.text, (v) => { o.text = v; });
    if (typeof l.alt === 'string' && l.alt) add(() => l.alt, (v) => { l.alt = v; });
    if (l.link && typeof l.link.label === 'string') add(() => l.link.label, (v) => { l.link.label = v; });
    if (l.type === 'diagram') (l.nodes || []).forEach((n) => { add(() => n.label, (v) => { n.label = v; }); add(() => n.sub, (v) => { n.sub = v; }); });
    if (l.type === 'repeat') {
      (l.items || []).forEach((row) => Object.keys(row).forEach((k) => {
        const v = row[k];
        // Values that are words, not files, addresses or colours.
        if (typeof v === 'string' && !/^(#|https?:|data:|sfx:|brand:)/i.test(v)) add(() => row[k], (x) => { row[k] = x; });
      }));
      walk([l.item]);
    }
    if (l.type === 'group') walk(l.layers);
  });
  walk(scene.layers);
  return slots;
}

/** A voice clip's script: kept with it, else its words joined. */
const scriptOf = (clip) => (clip.script && clip.script.trim()) || (clip.words || []).map((w) => w.w).join(' ');

/** The script with each pinned phrase wrapped in ⟦n⟧…⟦/n⟧ (n = the pin's number); pins not found in it are listed. */
function markScript(script, pins) {
  const tokens = script.split(/(\s+)/); // words and the spaces between them, kept
  const wordAt = []; // token index of each word
  tokens.forEach((t, i) => { if (t.trim()) wordAt.push(i); });
  const said = wordAt.map((i) => normWord(tokens[i]));
  const lost = [];
  const open = new Map(), close = new Map();
  for (const { n, pin } of pins) {
    const want = pin.text.split(/\s+/).map(normWord).filter(Boolean);
    const hits = [];
    for (let i = 0; i + want.length <= said.length; i++) if (want.every((w, k) => said[i + k] === w)) hits.push(i);
    if (!hits.length) { lost.push(n); continue; }
    const at = typeof pin.index === 'number' ? hits.reduce((b, i) => (Math.abs(i - pin.index) < Math.abs(b - pin.index) ? i : b), hits[0]) : hits[0];
    const a = wordAt[at], b = wordAt[at + want.length - 1];
    if (open.has(a) || close.has(b)) { lost.push(n); continue; } // two pins on one word: the first keeps it
    open.set(a, n); close.set(b, n);
  }
  const out = tokens.map((t, i) => `${open.has(i) ? `⟦${open.get(i)}⟧` : ''}${t}${close.has(i) ? `⟦/${close.get(i)}⟧` : ''}`).join('');
  return { marked: out, lost };
}

/** The translated phrase of each marker, and the word index where it starts. */
function readMarkers(translated) {
  const found = new Map();
  const re = /⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧/g;
  let m;
  while ((m = re.exec(translated))) {
    const before = translated.slice(0, m.index).replace(/⟦\/?\d+⟧/g, '');
    const index = before.split(/\s+/).filter((w) => normWord(w)).length;
    found.set(Number(m[1]), { text: m[2].replace(/⟦\/?\d+⟧/g, '').trim(), index });
  }
  return { found, plain: translated.replace(/⟦\/?\d+⟧/g, '') };
}

const SYSTEM = (lang) => `You translate a short video into ${lang}: the words shown on screen and the voice-over scripts.
Rules:
- Natural, idiomatic ${lang} as a native speaker would say it in a video, not a word-for-word rendering. Keep each text about as long as the original (a voice line must fit the same time; on-screen lines must fit the same space).
- Keep exactly: brand and product names (Unyson+, WordPress, Kinetic Scenes…), {{placeholders}}, URLs, numbers, line breaks (\\n), and *asterisks* around emphasised words (move them to the translated words that carry the emphasis).
- Voice scripts contain markers like ⟦3⟧…⟦/3⟧ around a word or phrase that something on screen is timed to. Put every marker, with the same number, around the translated word or phrase that means the same thing. Keep every marker exactly once.
- A brand name the voice spells for the speech engine (like "Unisonplus") stays as it is.
Answer with JSON only: {"texts": [...], "scripts": [...]} with the same number of entries in the same order.`;

/**
 * Translates a project into `to` (a two-letter language code). voice: a voice id for the new voice-overs (a Piper id,
 * or voicebox:<profile> to keep a Voicebox voice); default: the kit's free voice for that language. Returns the new
 * project's id and link, and what to look at.
 */
export async function translateProject({ project, to, voice, name, onStep = () => {} }) {
  const lang = String(to || '').toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) throw Object.assign(new Error('Give the language as a two-letter code, like "es" or "fr".'), { code: 400 });
  const langName = languageName(lang);
  const { scene: original } = readProject(project);
  const scene = JSON.parse(JSON.stringify(original));
  const warnings = [];

  // The voice the new voice-overs are spoken in.
  let vid = voice || voiceForLanguage(lang);
  if (vid && vid.startsWith('voicebox:') && !VOICEBOX_LANGUAGES.includes(lang)) throw Object.assign(new Error(`Voicebox voices do not speak ${langName}; leave the voice out to use the free ${langName} voice.`), { code: 400 });
  if (vid && !vid.startsWith('voicebox:') && !VOICES[vid]) throw Object.assign(new Error(`There is no voice "${vid}".`), { code: 400 });
  if (vid && VOICES[vid]?.lang && VOICES[vid].lang !== lang) throw Object.assign(new Error(`"${vid}" speaks ${languageName(VOICES[vid].lang)}, not ${langName}.`), { code: 400 });
  const voices = (scene.audio || []).filter((a) => a.role === 'voice' && scriptOf(a));
  if (voices.length && !vid) throw Object.assign(new Error(`The kit has no free voice for ${langName}. Give a Voicebox voice (voicebox:<profile>) if it speaks ${langName}.`), { code: 400 });

  // What to translate: the on-screen texts, and each voice's script with its pins marked.
  const slots = textSlots(scene);
  const pins = wordPins(scene).map((p, n) => ({ ...p, n: n + 1 }));
  const marked = voices.map((clip) => markScript(scriptOf(clip), pins.filter((p) => p.pin.audio === clip.id)));
  marked.forEach((m) => m.lost.forEach((n) => warnings.push(`A pin to "${pins[n - 1].pin.text}" was not found in its voice's script, so it keeps its old word.`)));

  onStep(`Translating ${slots.length} text${slots.length === 1 ? '' : 's'} and ${voices.length} voice-over${voices.length === 1 ? '' : 's'} into ${langName}`);
  const { askText, extractJson } = await import('./to-ai.mjs');
  const user = JSON.stringify({ texts: slots.map((s) => s.text), scripts: marked.map((m) => m.marked) }, null, 1);
  let answer = null;
  for (let attempt = 1; attempt <= 2 && !answer; attempt++) {
    const raw = await askText({ system: SYSTEM(langName), user, maxTokens: 16000 });
    try {
      const j = extractJson(raw);
      if (Array.isArray(j?.texts) && j.texts.length === slots.length && Array.isArray(j?.scripts) && j.scripts.length === voices.length) answer = j;
    } catch { /* asked again */ }
  }
  if (!answer) throw new Error('The AI did not return the translation in the expected shape. Try again.');
  slots.forEach((s, i) => { if (typeof answer.texts[i] === 'string' && answer.texts[i].trim()) s.set(answer.texts[i]); });

  // New voice-overs (kept in memory until all are made: a failure leaves no half-made project behind).
  const files = [];
  if (vid && !vid.startsWith('voicebox:')) await ensureVoice(vid, (s) => onStep(`Installing the ${langName} voice: ${s}`));
  const before = new Map(voices.map((c) => [c.id, { start: c.start, end: c.start + clipLength(c) }]));
  for (let i = 0; i < voices.length; i++) {
    const clip = voices[i];
    const { found, plain } = readMarkers(String(answer.scripts[i] || ''));
    const lines = plain.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { warnings.push(`The voice-over "${clip.name || clip.id}" came back empty, so it was left in the original language.`); continue; }
    onStep(`Speaking voice-over ${i + 1} of ${voices.length} in ${langName}`);
    const job = startVoice({ lines, voice: vid, language: lang });
    let res;
    for (;;) {
      await new Promise((ok) => setTimeout(ok, 800));
      const j = voiceJob(job.id);
      if (j?.state === 'error') throw new Error(`Voice-over ${i + 1}: ${j.error}`);
      if (j?.state === 'done') { res = j.result; break; }
      if (j?.step) onStep(`Voice-over ${i + 1} of ${voices.length}: ${j.step}`);
    }
    const file = `${clip.id}-${lang}.mp3`;
    files.push({ file, buf: Buffer.from(res.src.split(',')[1], 'base64') });
    Object.assign(clip, { src: `media/${file}`, words: res.words, speech: res.speech, script: lines.join(String.fromCharCode(10)), voice: VOICES[vid]?.label || vid, voiceId: vid, ...(lang !== 'en' ? { lang } : {}) });
    delete clip.offset; delete clip.duration;
    if (lang === 'en') delete clip.lang;
    // The pins on this voice move to the translated words.
    for (const p of pins.filter((x) => x.pin.audio === clip.id)) {
      const f = found.get(p.n);
      if (f && f.text) { p.pin.text = f.text; p.pin.index = f.index; } else if (!marked[i].lost.includes(p.n)) warnings.push(`The translation lost the word "${p.pin.text}" was pinned to, so that pin keeps its old word.`);
    }
    const was = before.get(clip.id);
    const now = clip.start + res.duration;
    if (now > was.end + 0.3) warnings.push(`"${clip.name || clip.id}" is ${r2(now - was.end)} s longer in ${langName}.`);
  }
  // Voice-overs that now run into the next one.
  const sorted = voices.slice().sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].start + clipLength(sorted[i - 1]);
    if (prevEnd > sorted[i].start + 0.05) warnings.push(`"${sorted[i - 1].name || sorted[i - 1].id}" now runs into "${sorted[i].name || sorted[i].id}" by ${r2(prevEnd - sorted[i].start)} s: move the later one (and what goes with it) or shorten the line.`);
  }
  const lastVoice = Math.max(0, ...voices.map((c) => c.start + clipLength(c)));
  if (lastVoice + 0.5 > scene.duration) { warnings.push(`The scene is ${r2(lastVoice + 0.5 - scene.duration)} s longer, to fit the last voice-over.`); scene.duration = r2(lastVoice + 0.5); }

  // Everything pinned plays on the new words.
  const pinned = applyWordPins(scene);
  pinned.problems.forEach((p) => warnings.push(`A pin to "${p.text}" (${p.layerId}) found no matching word in the ${langName} voice-over.`));
  const created = createProject(name || `${original.title || project} (${langName})`, pinned.scene);
  const dir = projectDir(created.id);
  copyMedia(projectDir(project), dir);
  for (const f of files) writeFileSync(join(dir, 'media', f.file), f.buf);
  writeProject(created.id, pinned.scene);
  addNote(created.id, `Translated from "${project}" into ${langName} (${slots.length} texts, ${voices.length} voice-overs, ${pins.length} word pins${vid ? `, voice ${vid}` : ''}).`);
  return { id: created.id, link: projectLink(created.id), language: lang, texts: slots.length, voices: voices.length, pins: pins.length, moved: pinned.moved, warnings };
}

function clipLength(c) {
  const words = c.words || [];
  const end = words.length ? words[words.length - 1].t + words[words.length - 1].d : 0;
  return c.duration ?? Math.max(0, end - (c.offset || 0));
}

function copyMedia(from, to) {
  const src = join(from, 'media');
  if (!existsSync(src)) return;
  mkdirSync(join(to, 'media'), { recursive: true });
  for (const f of readdirSync(src)) { const p = join(src, f); if (statSync(p).isFile()) copyFileSync(p, join(to, 'media', f)); }
}

/* ---- the kit's job runner for the Studio ---- */
const jobs = new Map();
let seq = 0;
export function startTranslate(body = {}) {
  const id = `tr${Date.now().toString(36)}${(seq++).toString(36)}`;
  const job = { id, state: 'running', step: 'Starting', error: '', result: null };
  jobs.set(id, job);
  translateProject({ project: body.project, to: body.to, voice: body.voice || undefined, name: body.name, onStep: (s) => { job.step = s; } })
    .then((r) => { job.result = r; job.state = 'done'; job.step = 'Done'; })
    .catch((e) => { job.state = 'error'; job.error = String(e && e.message || e); });
  return { id, state: job.state };
}
export const translateJob = (id) => { const j = jobs.get(id); return j ? { id: j.id, state: j.state, step: j.step, error: j.error, result: j.result } : null; };
