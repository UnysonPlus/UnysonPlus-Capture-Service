#!/usr/bin/env node
// benchmark-models.mjs — score AI models on the header-translation task.
//
//   node benchmark-models.mjs [--models a,b,c]
//
// Runs the SAME header-translation prompt (guides/header-translation-guide.md) against each candidate
// model on a FIXED, known-answer header (the "wegic" FreshPaws capture) and scores the returned JSON
// against a transparent rubric (0–100). Prints a ranked table and writes <CAPTURE_OUT>/_benchmark.json.
//
// Candidates: the --models list if given, else EVERY already-pulled Ollama tag (GET /api/tags) PLUS
// 'claude-code' if the `claude` CLI is on PATH. Nothing is ever pulled/downloaded — only what's local.
//
// Quality note: bigger local models generally score higher, and Claude is the ceiling. Pull more models
// (dashboard → Local AI) and re-run to add rows.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateHeader } from './header-translate.mjs';
import { listPulledModels, claudeAvailable } from './to-ai.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE_OUT = (process.env.CAPTURE_OUT || 'D:/Web Dev/capture-out').replace(/\\/g, '/');

// Service version — stamped on every history record so runs can be attributed to a build.
function serviceVersion() {
  try { return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}

/* ---------------------------------------------------------------------- *
 * Persistent benchmark HISTORY database — accumulates every run so results
 * are remembered (not overwritten). Lives at <capOut>/benchmark-history.json
 * as { version:1, runs:[ record, … ] }. Reused by the leaderboard export +
 * the dashboard's /api/benchmarks route.
 * ---------------------------------------------------------------------- */
const HISTORY_VERSION = 1;
const HISTORY_CAP = 500; // keep the DB bounded

export function historyPath(capOut = CAPTURE_OUT) { return join(capOut, 'benchmark-history.json'); }

// Load the history DB. Tolerates a missing file (fresh DB) or a corrupt file
// (back it up to .bak, then start fresh) so a bad write never loses future runs.
export function loadHistory(capOut = CAPTURE_OUT) {
  const p = historyPath(capOut);
  if (!existsSync(p)) return { version: HISTORY_VERSION, runs: [] };
  try {
    const db = JSON.parse(readFileSync(p, 'utf8'));
    if (!db || typeof db !== 'object' || !Array.isArray(db.runs)) throw new Error('bad shape');
    return { version: db.version || HISTORY_VERSION, runs: db.runs };
  } catch (e) {
    try { copyFileSync(p, p + '.bak'); } catch { /* best-effort backup */ }
    console.error(`benchmark-history.json unreadable (${e.message}) — backed up to .bak, starting fresh.`);
    return { version: HISTORY_VERSION, runs: [] };
  }
}

// Trim to HISTORY_CAP records, but never drop a model's BEST or MOST-RECENT record.
function trimHistory(runs) {
  if (runs.length <= HISTORY_CAP) return runs;
  const keep = new Set();
  const best = new Map(), latest = new Map();
  runs.forEach((r, i) => {
    const b = best.get(r.model); if (b == null || r.score > runs[b].score) best.set(r.model, i);
    const l = latest.get(r.model); if (l == null || (r.ts || 0) > (runs[l].ts || 0)) latest.set(r.model, i);
  });
  best.forEach((i) => keep.add(i)); latest.forEach((i) => keep.add(i));
  // Fill the rest with the most-recent records until we hit the cap.
  const byRecent = runs.map((r, i) => i).sort((a, b) => (runs[b].ts || 0) - (runs[a].ts || 0));
  for (const i of byRecent) { if (keep.size >= HISTORY_CAP) break; keep.add(i); }
  return runs.filter((_, i) => keep.has(i)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

// Append records (one per model in the run), save, return the updated DB.
export function appendHistory(records, capOut = CAPTURE_OUT) {
  const db = loadHistory(capOut);
  db.runs.push(...records);
  db.runs = trimHistory(db.runs);
  db.version = HISTORY_VERSION;
  try { writeFileSync(historyPath(capOut), JSON.stringify(db, null, 2) + '\n'); }
  catch (e) { console.error(`Could not write benchmark-history.json: ${e.message}`); }
  return db;
}

/* ---------------------------------------------------------------------- *
 * Leaderboard aggregation — all-time per-model stats from the full history.
 * Reusable by the dashboard/server (imported without side effects).
 * ---------------------------------------------------------------------- */
export function leaderboard(capOut = CAPTURE_OUT) {
  const { runs } = loadHistory(capOut);
  const by = new Map();
  for (const r of runs) {
    if (!r || !r.model) continue;
    let a = by.get(r.model);
    if (!a) { a = { model: r.model, runs: 0, sumScore: 0, sumSeconds: 0, best_score: 0, latest_score: 0, last_ts: 0, last_iso: '', ever_valid: false }; by.set(r.model, a); }
    a.runs++;
    a.sumScore += Number(r.score) || 0;
    a.sumSeconds += Number(r.seconds) || 0;
    if ((Number(r.score) || 0) > a.best_score) a.best_score = Number(r.score) || 0;
    if ((r.ts || 0) >= a.last_ts) { a.last_ts = r.ts || 0; a.latest_score = Number(r.score) || 0; a.last_iso = r.iso || ''; }
    if (r.valid) a.ever_valid = true;
  }
  return [...by.values()].map((a) => ({
    model: a.model,
    best_score: a.best_score,
    latest_score: a.latest_score,
    avg_score: a.runs ? Math.round(a.sumScore / a.runs) : 0,
    runs: a.runs,
    avg_seconds: a.runs ? +(a.sumSeconds / a.runs).toFixed(1) : 0,
    last_iso: a.last_iso,
    ever_valid: a.ever_valid,
  })).sort((x, y) => y.best_score - x.best_score || x.avg_seconds - y.avg_seconds);
}

// last N history records (most-recent first) — for the dashboard "recent runs" list.
export function recentRuns(capOut = CAPTURE_OUT, n = 20) {
  const { runs } = loadHistory(capOut);
  return runs.slice(-n).reverse();
}

function printLeaderboard(capOut = CAPTURE_OUT) {
  const rows = leaderboard(capOut);
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log('\nLeaderboard (all-time)');
  console.log(pad('MODEL', 22) + padL('BEST', 6) + padL('LATEST', 8) + padL('AVG', 6) + padL('RUNS', 6) + padL('AVG-S', 8) + '  LAST RUN');
  console.log('-'.repeat(72));
  if (!rows.length) { console.log('  (no benchmark history yet — run `node benchmark-models.mjs`)'); return; }
  rows.forEach((r) => {
    console.log(pad(r.model, 22) + padL(r.best_score, 6) + padL(r.latest_score, 8) + padL(r.avg_score, 6) + padL(r.runs, 6) + padL(r.avg_seconds, 8) + '  ' + (r.last_iso || '—'));
  });
  console.log('');
}
// The fixed benchmark input: the FreshPaws (wegic) header — its correct mapping is what the rubric encodes.
const SAMPLE_HTML = join(CAPTURE_OUT, 'my_website_3qzyf6ez_wegic_net', 'rendered.html');

/* ---------------------------------------------------------------------- *
 * Extract the <header>…</header> region from a captured rendered.html.
 * ---------------------------------------------------------------------- */
function extractHeader(file) {
  const html = readFileSync(file, 'utf8');
  const m = html.match(/<header[\s\S]*?<\/header>/i);
  if (!m) throw new Error(`No <header> found in ${file}`);
  return m[0];
}

/* ---------------------------------------------------------------------- *
 * Color helpers (for the rubric's color checks).
 * ---------------------------------------------------------------------- */
function parseHex(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  const rgb = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
  s = s.replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}
// Relative luminance 0..1 (perceptual). Low = dark.
function luminance(c) { return c ? (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 : 1; }
// Hue in degrees 0..360 (HSL). Used to check "greenish" (~120–160).
function hue(c) {
  if (!c) return -1;
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return -1;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60); if (h < 0) h += 360;
  return h;
}

/* ---------------------------------------------------------------------- *
 * RUBRIC — score the wegic FreshPaws header against its KNOWN-CORRECT mapping.
 * Correct answer: logo "FreshPaws" (icon+text) LEFT; nav Home/Services/Facility/Contact;
 * a rounded "Book a Stay" CTA RIGHT; header transparent over hero → white on scroll;
 * dark-green brand text; green icon. Every point below is transparent + commented so the
 * user can trust WHY a model scored what it did. Total = 100 (bonuses can't exceed cap).
 * ---------------------------------------------------------------------- */
function scoreHeader(j) {
  const notes = [];
  // fields — a per-rubric-item pass/fail map (true only on FULL credit for that item),
  // persisted with each history record so the leaderboard/dashboard can show WHAT a model got right.
  const fields = { keys: false, cta: false, identity: false, menu: false, behavior: false, title_color: false, icon_color: false };
  let score = 0;
  const zones = ['left', 'center', 'right'];
  const allEls = () => zones.flatMap((z) => (Array.isArray(j?.[z]) ? j[z] : []));

  // (1) +20 — valid JSON with all 6 top-level keys, each the right type.
  const hasKeys = j && zones.every((z) => Array.isArray(j[z])) &&
    ['layout', 'identity', 'menu'].every((k) => j[k] && typeof j[k] === 'object' && !Array.isArray(j[k]));
  if (hasKeys) { score += 20; fields.keys = true; notes.push('+20 all 6 top-level keys present & correct type'); }
  else { notes.push('+0 missing/mistyped top-level keys'); return { score, notes, valid: false, fields }; }

  const els = allEls();

  // (2) +20 — a cta_button with text ~ /book a stay/i and style pill|filled (pill ideal).
  const cta = els.find((e) => e && e.type === 'cta_button');
  if (cta && /book\s*a\s*stay/i.test(String(cta.text || '')) && /^(pill|filled)$/i.test(String(cta.style || ''))) {
    score += 20; fields.cta = true; notes.push(`+20 cta_button "${cta.text}" style=${cta.style}`);
  } else if (cta && /book\s*a\s*stay/i.test(String(cta.text || ''))) {
    score += 12; notes.push(`+12 cta_button text ok but style="${cta.style}" not pill/filled`);
  } else { notes.push('+0 no correct cta_button (want text≈"Book a Stay", style pill/filled)'); }

  // (3) +20 — identity.logo_type == "custom" AND site_title ~ /fresh\s*paws/i.
  const id = j.identity || {};
  if (String(id.logo_type) === 'custom' && /fresh\s*paws/i.test(String(id.site_title || ''))) {
    score += 20; fields.identity = true; notes.push(`+20 identity custom "${id.site_title}"`);
  } else if (/fresh\s*paws/i.test(String(id.site_title || ''))) {
    score += 12; notes.push(`+12 site_title ok but logo_type="${id.logo_type}" (want "custom")`);
  } else { notes.push('+0 identity not custom/FreshPaws'); }

  // (4) +15 — exactly ONE menu_area (menu=="primary") in center or right.
  const menus = els.filter((e) => e && e.type === 'menu_area');
  const inCR = (t) => (j.center || []).includes(t) || (j.right || []).includes(t);
  if (menus.length === 1 && String(menus[0].menu) === 'primary' && inCR(menus[0])) {
    score += 15; fields.menu = true; notes.push('+15 one primary menu_area in center/right');
  } else if (menus.length === 1 && String(menus[0].menu) === 'primary') {
    score += 9; notes.push('+9 one primary menu_area but wrong zone');
  } else { notes.push(`+0 menu_area count=${menus.length} (want exactly 1, primary, center/right)`); }

  // (5) +10 — layout.behavior transparent-overlay (ideal, +10) or sticky (+6).
  const beh = String(j.layout?.behavior || '');
  if (beh === 'transparent-overlay') { score += 10; fields.behavior = true; notes.push('+10 behavior transparent-overlay'); }
  else if (beh === 'sticky') { score += 6; notes.push('+6 behavior sticky (transparent-overlay ideal)'); }
  else { notes.push(`+0 behavior="${beh}"`); }

  // (6) +15 — colors sane: title_color dark (low luminance) AND icon_color greenish (hue ~120–160).
  //     Partial credit: ~7.5 each half.
  const tc = parseHex(id.title_color), ic = parseHex(id.icon_color);
  let cScore = 0;
  if (tc && luminance(tc) < 0.35) { cScore += 7.5; fields.title_color = true; notes.push(`+7.5 title_color dark (${id.title_color})`); }
  else notes.push(`+0 title_color not dark (${id.title_color || '—'})`);
  const h = hue(ic);
  if (ic && h >= 90 && h <= 170) { cScore += 7.5; fields.icon_color = true; notes.push(`+7.5 icon_color greenish (hue ${h})`); }
  else notes.push(`+0 icon_color not greenish (${id.icon_color || '—'}${ic ? `, hue ${h}` : ''})`);
  score += cScore;

  // Deductions — hallucinated element types not in the guide, or duplicated logo/menu.
  const ALLOWED = new Set(['logo', 'menu_area', 'cta_button', 'icon_text', 'social_icons', 'search']);
  const bogus = els.filter((e) => e && !ALLOWED.has(e.type));
  if (bogus.length) { score -= 5 * bogus.length; notes.push(`-${5 * bogus.length} hallucinated type(s): ${bogus.map((e) => e.type).join(',')}`); }
  const logos = els.filter((e) => e && e.type === 'logo').length;
  if (logos > 1) { score -= 5 * (logos - 1); notes.push(`-${5 * (logos - 1)} duplicate logo`); }
  if (menus.length > 1) { score -= 5 * (menus.length - 1); notes.push(`-${5 * (menus.length - 1)} duplicate menu_area`); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, notes, valid: true, fields };
}

/* ---------------------------------------------------------------------- *
 * Determine candidate models.
 * ---------------------------------------------------------------------- */
async function candidates(argModels) {
  if (argModels && argModels.length) return argModels;
  const models = await listPulledModels(); // already-pulled Ollama tags (never pulls)
  if (claudeAvailable()) models.push('claude-code'); // Claude via the CLI (the ceiling)
  return models;
}

function parseArgs(argv) {
  const out = { models: null, leaderboardOnly: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--models' && argv[i + 1]) { out.models = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); }
    else if (argv[i].startsWith('--models=')) { out.models = argv[i].slice(9).split(',').map((s) => s.trim()).filter(Boolean); }
    else if (argv[i] === '--leaderboard' || argv[i] === '--leaderboard-only') { out.leaderboardOnly = true; }
  }
  return out;
}

/* ---------------------------------------------------------------------- */
async function main() {
  const { models: argModels, leaderboardOnly } = parseArgs(process.argv);

  // No-run mode: just print the accumulated all-time leaderboard (fast, offline).
  if (leaderboardOnly) { printLeaderboard(CAPTURE_OUT); return; }

  if (!existsSync(SAMPLE_HTML)) { console.error(`Sample header not found: ${SAMPLE_HTML}\nSet CAPTURE_OUT or capture the wegic site first.`); process.exit(1); }
  const headerHtml = extractHeader(SAMPLE_HTML);
  const models = await candidates(argModels);

  if (!models.length) {
    console.error('No candidate models. Start Ollama (`ollama serve`) with a pulled model, install the `claude` CLI, or pass --models a,b,c.');
    process.exit(1);
  }

  console.log(`\nHeader-translation benchmark — ${models.length} model(s), input = FreshPaws (wegic) header (${headerHtml.length} chars)\n`);

  const svcVer = serviceVersion();
  const sampleName = basename(dirname(SAMPLE_HTML));
  const rows = [];
  const records = []; // one history record per model this run
  for (const model of models) {
    process.stdout.write(`  running ${model} … `);
    const res = await translateHeader({ headerHtml, model });
    const scored = res.ok ? scoreHeader(res.json) : { score: 0, notes: [res.error || 'no valid JSON returned'], valid: false, fields: {} };
    const seconds = +(res.ms / 1000).toFixed(1);
    const row = { model, score: scored.score, valid: scored.valid, seconds, notes: scored.notes, error: res.error || '' };
    rows.push(row);
    const ts = Date.now();
    records.push({ ts, iso: new Date(ts).toISOString(), task: 'header', model, score: scored.score, valid: scored.valid, seconds, fields: scored.fields || {}, input: sampleName, service_version: svcVer });
    console.log(`${scored.score}/100  (${row.seconds}s${scored.valid ? '' : ', invalid'})`);
  }

  // Persist to the accumulating history DB (append; never overwrites past runs).
  appendHistory(records, CAPTURE_OUT);

  rows.sort((a, b) => b.score - a.score || a.seconds - b.seconds);

  // Ranked table.
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log('\n' + pad('#', 3) + pad('MODEL', 22) + padL('SCORE', 7) + padL('VALID', 8) + padL('SECONDS', 9));
  console.log('-'.repeat(49));
  rows.forEach((r, i) => {
    console.log(pad(i + 1, 3) + pad(r.model, 22) + padL(`${r.score}/100`, 7) + padL(r.valid ? 'yes' : 'no', 8) + padL(r.seconds, 9));
  });
  console.log('\nWinner: ' + (rows[0] ? `${rows[0].model} (${rows[0].score}/100)` : '—'));
  console.log('Note: bigger local models generally score higher; Claude is the ceiling. Pull more models');
  console.log('      (dashboard → Local AI) and re-run to add rows.\n');

  // JSON report.
  const report = {
    task: 'header-translation',
    input: SAMPLE_HTML,
    header_chars: headerHtml.length,
    generated_at: new Date().toISOString(),
    rubric_max: 100,
    ranking: rows,
  };
  const outFile = join(CAPTURE_OUT, '_benchmark.json');
  try { writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n'); console.log(`Report written: ${outFile}\n`); }
  catch (e) { console.error(`Could not write report to ${outFile}: ${e.message}`); }

  // All-time leaderboard (accumulated across every run in the history DB).
  printLeaderboard(CAPTURE_OUT);
}

// Only run the benchmark when invoked directly — importing this module (e.g. the dashboard
// server pulling in `leaderboard`) must NOT kick off a benchmark run.
const INVOKED_DIRECTLY = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();
if (INVOKED_DIRECTLY) { main().catch((e) => { console.error(e); process.exit(1); }); }
