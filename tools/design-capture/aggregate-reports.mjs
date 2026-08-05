#!/usr/bin/env node
// aggregate-reports.mjs — the MAINTAINER side of report-sharing.
//
// Reads the shared-report submissions (the Google Form's responses) and ranks the SYSTEMATIC
// converter failures so you know exactly what to fix next — without re-reading raw sites and without
// touching the Sheet. The Sheet stays the append-only source of truth; this script dedupes what it has
// already processed via a local watermark (deletion-safe, content-fingerprinted), so each run only
// surfaces NEW reports.
//
//   node aggregate-reports.mjs --csv responses.csv          # a CSV you downloaded (File → Download → CSV)
//   node aggregate-reports.mjs --url "<published-csv-url>"   # File → Share → Publish to web → CSV (live pull)
//   node aggregate-reports.mjs --csv responses.csv --all     # ignore the watermark; re-rank everything
//   node aggregate-reports.mjs --csv responses.csv --commit  # after acting on the list, record these as processed
//
// Output: a ranked markdown to stdout (and reports-todo.md). Each row = a recurring (role · srcTag ·
// class-token) pattern that became a fallback/opportunity, with how many reports + distinct sites hit
// it — that ranking IS the converter's to-do list. Mirror any fix to BOTH paths (see CLAUDE.md).
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

const DIR = dirname(fileURLToPath(import.meta.url));
const WATERMARK = join(DIR, '.reports-watermark.json'); // gitignored; the set of already-processed report fingerprints
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const val = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const ALL = flag('all');
const COMMIT = flag('commit');

// --- minimal RFC-4180 CSV parser (payload cells contain commas / quotes / newlines) ---
function parseCsv(text) {
  const rows = []; let row = [], field = '', i = 0, q = false;
  text = text.replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

// Find every upw-share payload in a responses table, whatever the column is titled.
function payloadsFrom(rows) {
  const out = [];
  for (const r of rows.slice(1)) {                          // skip the header row
    for (const cell of r) {
      const s = (cell || '').trim();
      if (s.startsWith('{') && s.includes('"schema"') && s.includes('upw-share')) {
        try { out.push(JSON.parse(s)); } catch { /* skip malformed */ }
        break;
      }
    }
  }
  return out;
}

const fp = (rep) => createHash('sha1').update(JSON.stringify(rep)).digest('hex').slice(0, 16);
const loadSeen = () => { try { return new Set(JSON.parse(readFileSync(WATERMARK, 'utf8')).seen || []); } catch { return new Set(); } };

async function readInput() {
  const url = val('url'); const csv = val('csv') || args.find((a) => !a.startsWith('--') && /\.csv$/i.test(a));
  if (url) { const res = await fetch(url); if (!res.ok) throw new Error('fetch failed: ' + res.status); return await res.text(); }
  if (csv) { if (!existsSync(csv)) throw new Error('no such file: ' + csv); return readFileSync(csv, 'utf8'); }
  throw new Error('provide --csv <file> or --url <published-csv-url>');
}

// A recurring failure pattern key: the shape that matters for writing a recognizer.
const patternKey = (e) => [e.role || '?', e.detected || '?', e.srcTag || '?',
  (e.classTokens || []).slice().sort().join(' ')].join(' | ');

(async () => {
  const text = await readInput();
  const all = payloadsFrom(parseCsv(text));
  const seen = ALL ? new Set() : loadSeen();
  const fresh = all.filter((r) => !seen.has(fp(r)));

  if (!all.length) { console.log('No upw-share reports found in the input.'); return; }
  console.log(`\nReports: ${all.length} total · ${fresh.length} new${ALL ? ' (--all: ignoring watermark)' : ''}`);
  if (!fresh.length) { console.log('Nothing new to analyze. (Use --all to re-rank everything.)'); return; }

  const sites = new Set(); let elements = 0, fallbacks = 0, opportunities = 0, overLarge = 0;
  const shortcodes = {}, roles = {}, drops = {};
  const patterns = new Map(); // key → { count, sites:Set, example }
  const findings = new Map(); // "got → expected" → { count, sites:Set, systematic, notes:Set }
  for (const rep of fresh) {
    if (rep.site && rep.site.hostHash) sites.add(rep.site.hostHash);
    for (const [k, v] of Object.entries((rep.stats && rep.stats.shortcodes) || {})) shortcodes[k] = (shortcodes[k] || 0) + v;
    for (const [k, v] of Object.entries((rep.stats && rep.stats.roles) || {})) roles[k] = (roles[k] || 0) + v;
    for (const s of (rep.sections || [])) { if (s.overLarge) overLarge++; for (const d of (s.stylingDropped || [])) drops[d] = (drops[d] || 0) + 1; }
    for (const e of (rep.elements || [])) {
      elements++;
      if (!e.fallback && !e.opportunity) continue;
      if (e.fallback) fallbacks++; if (e.opportunity) opportunities++;
      const key = patternKey(e);
      const rec = patterns.get(key) || { count: 0, sites: new Set(), kind: e.fallback ? 'fallback' : 'opportunity', why: e.why || '', mapped: e.mapped || '' };
      rec.count++; if (rep.site && rep.site.hostHash) rec.sites.add(rep.site.hostHash);
      patterns.set(key, rec);
    }
    // AGENT got-vs-expected findings — the high-value signal. From a full report's `findings[]` (batch
    // --share) OR a lean streaming payload (`kind:'finding'`, one `finding`). Rank by got→expected pair.
    for (const f of (rep.kind === 'finding' && rep.finding ? [rep.finding] : (rep.findings || []))) {
      if (!f || (!f.got && !f.expected)) continue;
      const key = (f.got || '?') + ' → ' + (f.expected || '?');
      const rec = findings.get(key) || { count: 0, sites: new Set(), systematic: 0, notes: new Set(), solutions: new Set() };
      rec.count++; if (f.systematic) rec.systematic++;
      if (rep.site && rep.site.hostHash) rec.sites.add(rep.site.hostHash);
      if (f.note) rec.notes.add(f.note);
      if (f.solution) rec.solutions.add(f.solution);   // agent's fix sketch — surfaced below for maintainer review
      findings.set(key, rec);
    }
  }

  const ranked = [...patterns.entries()]
    .map(([key, r]) => ({ key, ...r, sites: r.sites.size }))
    .sort((a, b) => b.sites - a.sites || b.count - a.count);

  const histo = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ') || '—';
  const nFindings = [...findings.values()].reduce((n, r) => n + r.count, 0);
  let md = `# Converter to-do — from shared reports\n\n`;
  md += `_${fresh.length} new reports · ${sites.size} distinct sites · ${elements} elements · `;
  md += `${fallbacks} fallbacks · ${opportunities} opportunities · ${nFindings} agent-findings · ${overLarge} over-large sections_\n\n`;
  md += `**Mapped shortcodes:** ${histo(shortcodes)}\n\n**Detected roles:** ${histo(roles)}\n\n`;
  if (Object.keys(drops).length) md += `**Styling dropped (property → count):** ${histo(drops)}\n\n`;
  md += `## Ranked systematic failures (fix highest first — most sites affected)\n\n`;
  md += `| # | sites | hits | kind | role | detected | tag | class tokens | why / currently |\n`;
  md += `|---|------:|-----:|------|------|----------|-----|--------------|-----------------|\n`;
  ranked.forEach((r, i) => {
    const [role, detected, tag, tokens] = r.key.split(' | ');
    md += `| ${i + 1} | ${r.sites} | ${r.count} | ${r.kind} | ${role} | ${detected} | ${tag || '—'} | \`${tokens || '—'}\` | ${(r.why || '').replace(/\|/g, '/')} → ${r.mapped || '?'} |\n`;
  });
  if (!ranked.length) md += `_No fallbacks or opportunities in the new reports — the converter handled them all._\n`;

  // Agent got-vs-expected findings — ranked. These carry the CORRECT target (expected) and are the only
  // way a confident-but-WRONG mapping (no fallback flag) surfaces, so they lead the to-do list in practice.
  const rankedFindings = [...findings.entries()]
    .map(([key, r]) => ({ key, count: r.count, sites: r.sites.size, systematic: r.systematic, note: [...r.notes][0] || '', solutions: [...r.solutions] }))
    .sort((a, b) => b.systematic - a.systematic || b.sites - a.sites || b.count - a.count);
  if (rankedFindings.length) {
    md += `\n## Agent findings — got → expected (the fix target; catches confident-but-wrong maps)\n\n`;
    md += `| # | sites | hits | systematic | fix? | got → expected | example note |\n`;
    md += `|---|------:|-----:|:----------:|:----:|----------------|--------------|\n`;
    rankedFindings.forEach((r, i) => {
      md += `| ${i + 1} | ${r.sites} | ${r.count} | ${r.systematic ? '✔ ×' + r.systematic : '—'} | ${r.solutions.length ? '✎' : '—'} | ${r.key} | ${(r.note || '').replace(/\|/g, '/')} |\n`;
    });
    // Agent-supplied fix SKETCHES — REVIEW before promoting; never auto-apply. Reusable patterns only.
    const withSolutions = rankedFindings.filter((r) => r.solutions.length);
    if (withSolutions.length) {
      md += `\n### Proposed solutions (agent sketches — ✎ REVIEW, never auto-apply)\n\n`;
      withSolutions.forEach((r) => { md += `**${r.key}**\n\n\`\`\`\n${r.solutions[0]}\n\`\`\`\n\n`; });
    }
  }

  writeFileSync(join(DIR, 'reports-todo.md'), md);
  console.log('\n' + md);
  console.log(`→ wrote reports-todo.md`);

  if (COMMIT) {
    const merged = [...loadSeen(), ...fresh.map(fp)];
    writeFileSync(WATERMARK, JSON.stringify({ seen: [...new Set(merged)], updated: 'see git/file mtime' }, null, 2) + '\n');
    console.log(`→ marked ${fresh.length} reports processed (watermark updated). Next run shows only newer ones.`);
  } else {
    console.log(`(dry run — not committed. Re-run with --commit once you've acted on the list to mark these processed.)`);
  }
})().catch((e) => { console.error('aggregate-reports:', e.message); process.exit(1); });
