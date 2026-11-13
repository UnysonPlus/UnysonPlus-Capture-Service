// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// One scene, many videos: a scene with {{placeholders}} in its words and media addresses, and a spreadsheet (CSV) with
// a column per placeholder, rendered once per row (a reel for every product in a shop, from one design). The fill rule
// is the same as the Studio's (apps/studio/src/lib/batch.ts): keep the two in step.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** CSV text → { columns, rows: [{ column: value }] }. Quotes, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text) {
  const t = String(text).replace(/^﻿/, '');
  const sep = (t.split(/\r?\n/)[0].match(/;/g) || []).length > (t.split(/\r?\n/)[0].match(/,/g) || []).length ? ';' : ',';
  const out = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  const lines = out.filter((r) => r.some((c) => c.trim() !== ''));
  if (!lines.length) return { columns: [], rows: [] };
  const columns = lines[0].map((c) => c.trim());
  return { columns, rows: lines.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? '').trim()]))) };
}

const key = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '_');
const PH = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Every placeholder name the scene uses. */
export function placeholders(scene) {
  const found = new Map();
  const walk = (v) => { if (typeof v === 'string') for (const m of v.matchAll(PH)) { if (!found.has(key(m[1]))) found.set(key(m[1]), m[1].trim()); } else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(scene);
  return [...found.values()];
}

/** The scene with one row's values in place of its {{placeholders}} (names match columns ignoring case and spaces). */
export function fillScene(scene, row, { media } = {}) {
  const vals = new Map(Object.entries(row).map(([k, v]) => [key(k), v]));
  const fill = (s) => {
    const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(s);
    const out = s.replace(PH, (m, n) => (vals.has(key(n)) ? vals.get(key(n)) : m));
    // A whole-value placeholder holding a relative file (a photo per product) is found next to the spreadsheet.
    if (whole && media && /\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov|mp3|wav|m4a|ogg)$/i.test(out) && !/^[a-z][a-z0-9+.-]*:/i.test(out) && !isAbsolute(out)) return resolve(media, out);
    return out;
  };
  const walk = (v) => (typeof v === 'string' ? fill(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(scene);
}

/** Placeholders with no column of that name. */
export function missingColumns(scene, columns) {
  const have = new Set(columns.map(key));
  return placeholders(scene).filter((p) => !have.has(key(p)));
}

/**
 * Voice-overs per row: a voice clip whose script changes with the row ({{placeholders}} in it) is spoken again in the
 * same voice (its voiceId, else `voice`, else the kit's default), timed, and everything pinned to its words follows
 * (word pins, studio-pins.mjs). The kit keeps every spoken line, so only lines whose words changed are spoken. Files go
 * in `dir`. Returns the scene (a copy) and the clips spoken again.
 */
export async function voiceRow(template, filled, { dir, voice, onStep = () => {} } = {}) {
  const changed = (filled.audio || []).filter((a) => {
    if (a.role !== 'voice' || !a.script) return false;
    const was = (template.audio || []).find((t) => t.id === a.id);
    return !was || was.script !== a.script;
  });
  if (!changed.length) return { scene: filled, spoken: [] };
  const { startVoice, voiceJob } = await import('./studio-voice.mjs');
  const { applyWordPins } = await import('./studio-pins.mjs');
  const scene = JSON.parse(JSON.stringify(filled));
  mkdirSync(dir, { recursive: true });
  for (const clip of scene.audio.filter((a) => changed.some((c) => c.id === a.id))) {
    const lines = clip.script.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
    onStep(`Speaking "${clip.name || clip.id}"`);
    const job = startVoice({ lines, voice: clip.voiceId || voice, ...(clip.lang ? { language: clip.lang } : {}) });
    let res;
    for (;;) {
      await new Promise((ok) => setTimeout(ok, 700));
      const j = voiceJob(job.id);
      if (j?.state === 'error') throw new Error(`The voice-over "${clip.name || clip.id}": ${j.error}`);
      if (j?.state === 'done') { res = j.result; break; }
    }
    const file = join(dir, `${clip.id}-${Date.now().toString(36)}.mp3`);
    writeFileSync(file, Buffer.from(res.src.split(',')[1], 'base64'));
    Object.assign(clip, { src: file, words: res.words, speech: res.speech, voiceId: res.voice });
    delete clip.offset; delete clip.duration;
  }
  const pinned = applyWordPins(scene);
  const end = Math.max(0, ...pinned.scene.audio.filter((a) => a.role === 'voice').map((a) => a.start + ((a.words || []).at(-1)?.t ?? 0) + ((a.words || []).at(-1)?.d ?? 0)));
  if (end + 0.4 > pinned.scene.duration) pinned.scene.duration = Math.round((end + 0.4) * 100) / 100;
  return { scene: pinned.scene, spoken: changed.map((c) => c.id), problems: pinned.problems };
}

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * Renders one video per row: { scene, csvFile, outDir?, name? (the column naming each file), rows? ("1-3,5"),
 * render options } → [{ row, file, error? }]. Rows are numbered from 1 (the first under the header).
 */
export async function renderBatch({ scene, csvFile, outDir, name, rows: pick, onRow, ...opts }) {
  const { columns, rows } = parseCsv(readFileSync(csvFile, 'utf8'));
  if (!rows.length) throw new Error('The spreadsheet has no rows under its header.');
  const missing = missingColumns(scene, columns);
  if (missing.length) throw new Error(`No column for ${missing.map((m) => `{{${m}}}`).join(', ')} (the columns are ${columns.join(', ')}).`);
  const want = pick ? new Set(String(pick).split(',').flatMap((p) => { const [a, b] = p.split('-').map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; })) : null;
  const dir = outDir || join(dirname(csvFile), 'videos');
  mkdirSync(dir, { recursive: true });
  const { renderScene } = await import('./studio-tools.mjs');
  const done = [];
  for (let i = 0; i < rows.length; i++) {
    if (want && !want.has(i + 1)) continue;
    const label = (name && rows[i][name]) || Object.values(rows[i])[0] || `row-${i + 1}`;
    const file = join(dir, `${String(i + 1).padStart(2, '0')}-${slug(label) || 'video'}.mp4`);
    onRow?.(i + 1, rows.length, label);
    try {
      const filled = fillScene(scene, rows[i], { media: dirname(csvFile) });
      const { scene: voiced } = await voiceRow(scene, filled, { dir: join(dir, '.voices'), voice: opts.voice, onStep: (st) => onRow?.(i + 1, rows.length, `${label}: ${st}`) });
      if (scene.__base) Object.defineProperty(voiced, '__base', { value: scene.__base, enumerable: false });
      const r = await renderScene(voiced, { ...opts, out: file });
      done.push({ row: i + 1, label, file: r.file });
    } catch (e) { done.push({ row: i + 1, label, file: null, error: e.message }); }
  }
  return done;
}
