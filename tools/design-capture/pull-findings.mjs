// Pull the shared findings feed (the Form responses sheet, published as CSV — share-config.json → feed.publishedCsv) and
// print a triage: findings grouped by ref, newest first, with the tuple fields when the agent sent them.
//   node pull-findings.mjs [--since=YYYY-MM-DDTHH:MM] [--json=out.json] [--csv=out.csv]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const cfg = JSON.parse(readFileSync(here + 'share-config.json', 'utf8'));
const url = cfg.feed && cfg.feed.publishedCsv;
if (!url) { console.error('share-config.json has no feed.publishedCsv (publish the responses sheet to the web as CSV and add its link)'); process.exit(1); }
const flag = (n) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : ''; };
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) { console.error('fetch failed: ' + res.status); process.exit(1); }
const text = await res.text();
if (flag('csv')) writeFileSync(flag('csv'), text);
// a small RFC-4180 parser (quoted cells with embedded commas / newlines / doubled quotes)
const rows = []; let row = [], cell = '', q = false;
for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c; }
if (cell || row.length) { row.push(cell); rows.push(row); }
const [head, ...body] = rows; const ti = head.indexOf('Timestamp'), pi = head.indexOf('Payload');
const since = flag('since') ? new Date(flag('since')) : null;
const parse = (t) => { const m = String(t).match(/^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)$/); return m ? new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]) : new Date(0); };
const items = [];
for (const r of body) { if (!r[pi]) continue; let p; try { p = JSON.parse(r[pi]); } catch { continue; } const at = parse(r[ti]); if (since && at < since) continue; items.push({ at, ...p }); }
items.sort((a, b) => b.at - a.at);
const findings = items.filter((x) => x.kind === 'finding' && x.finding);
const byRef = new Map();
for (const f of findings) { const k = f.finding.ref || '(no ref)'; if (!byRef.has(k)) byRef.set(k, []); byRef.get(k).push(f); }
console.log(`${items.length} rows (${findings.length} findings, ${items.filter((x) => x.kind === 'summary').length} summaries)` + (since ? ` since ${since.toISOString()}` : '') + ` · tuple-format findings: ${findings.filter((f) => f.finding.region || f.finding.construct || f.finding.twin || f.finding.loss).length}`);
for (const [ref, list] of [...byRef.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const f = list[0].finding;
  const marks = (list.some((x) => x.finding.fixture) ? ' [fixture]' : '') + (list.some((x) => x.finding.solution) ? ' [solution]' : '') + (list.some((x) => x.finding.twin_shows) ? ' [proven]' : '') + (list.some((x) => x.finding.severity) ? ' [' + list.map((x) => x.finding.severity).filter(Boolean)[0] + ']' : '');
  console.log(`${String(list.length).padStart(3)} ${f.systematic ? 'SYS' : '   '} [${ref.slice(0, 40)}] ${f.twin ? f.twin + '/' : ''}${f.loss || ''} got=${String(f.got || '').slice(0, 50)} → exp=${String(f.expected || '').slice(0, 45)} | ${String(f.note || '').slice(0, 130)}${marks}`);
}
if (flag('json')) writeFileSync(flag('json'), JSON.stringify(items, null, 2));
// --fixtures=<dir>: every finding's repro fixture + its tuple as files (fixture-<n>.html / fixture-<n>.json), ready for the harness.
if (flag('fixtures')) {
  const dir = flag('fixtures'); mkdirSync(dir, { recursive: true }); let n = 0;
  for (const it of findings) { const f = it.finding; if (!f.fixture) continue; n++; const base = join(dir, 'fixture-' + String(n).padStart(3, '0')); writeFileSync(base + '.html', f.fixture); const meta = { ...f }; delete meta.fixture; writeFileSync(base + '.json', JSON.stringify({ at: it.at, converterVersion: it.converterVersion, hostHash: it.hostHash, ...meta }, null, 2)); }
  console.log(`${n} fixture(s) → ${dir}`);
}
