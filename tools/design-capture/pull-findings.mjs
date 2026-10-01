// Pull the shared findings feed (the Form responses sheet, published as CSV — share-config.json → feed.publishedCsv) and
// print a triage: findings grouped by ref, newest first, with the tuple fields when the agent sent them.
//   node pull-findings.mjs [--since=YYYY-MM-DDTHH:MM] [--json=out.json] [--csv=out.csv]
//
// Every row is addressed by its SHEET ROW NUMBER (`r12`) -- the responses sheet is append-only, so a row
// number is a permanent address for a finding and the only way to report back WHICH rows were landed in the
// converter. The triage ledger (`--ledger`, default triage-ledger.json beside share-config.json) remembers
// that across runs, so an already-landed row is marked instead of being triaged a second time:
//   node pull-findings.mjs --fixtures=out/inbox/          # triage; every line carries its r<row> address
//   node pull-findings.mjs --landed=r12,r19-r21 --note="stacked pricing -> layout list; golden [BI]"
//   node pull-findings.mjs --landed=r30 --deferred=r31,r32 --note="r31/r32 carry no fixture"
// A range is written `r19-r21`. --landed / --deferred only RECORD a disposition; they never fetch less.
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
// row = the 1-based SHEET row (header is row 1), so `r12` addresses exactly one response forever.
for (let bi = 0; bi < body.length; bi++) { const r = body[bi]; if (!r[pi]) continue; let p; try { p = JSON.parse(r[pi]); } catch { continue; } const at = parse(r[ti]); if (since && at < since) continue; items.push({ row: bi + 2, at, ...p }); }
items.sort((a, b) => b.at - a.at);
// ---- the triage ledger: which sheet rows are already LANDED in the converter, or deliberately DEFERRED.
// Kept locally (the responses sheet is append-only and cannot be edited back), so "which rows are done" is a
// recorded fact across runs rather than something re-derived from memory each time.
const LEDGER = flag('ledger') || (here + 'triage-ledger.json');
let ledger = { landed: {}, deferred: {}, lastTriage: null };
try { ledger = { landed: {}, deferred: {}, lastTriage: null, ...JSON.parse(readFileSync(LEDGER, 'utf8')) }; } catch { /* first run */ }
// `r12`, `12`, and `r19-r21` (inclusive range) all parse; a bare range with no rows is a usage error, not 0 rows.
const parseRows = (spec) => {
  const out = new Set();
  for (const part of String(spec).split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^r?(\d+)\s*(?:-\s*r?(\d+))?$/i);
    if (!m) { console.error(`pull-findings: cannot read row spec "${part}" — use r12, 12, or r19-r21`); process.exit(1); }
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (b < a) { console.error(`pull-findings: range "${part}" runs backwards`); process.exit(1); }
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
};
// Collapse [12,19,20,21] -> "r12, r19-r21" so a report names a RANGE rather than forty addresses.
const fmtRows = (nums) => {
  const a = [...new Set(nums)].sort((x, y) => x - y); const parts = [];
  for (let i = 0; i < a.length;) { let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; parts.push(i === j ? 'r' + a[i] : `r${a[i]}-r${a[j]}`); i = j + 1; }
  return parts.join(', ') || '(none)';
};

const findings = items.filter((x) => x.kind === 'finding' && x.finding);
const byRef = new Map();
for (const f of findings) { const k = f.finding.ref || '(no ref)'; if (!byRef.has(k)) byRef.set(k, []); byRef.get(k).push(f); }
console.log(`${items.length} rows ${fmtRows(items.map((x) => x.row))} (${findings.length} findings, ${items.filter((x) => x.kind === 'summary').length} summaries)` + (since ? ` since ${since.toISOString()}` : '') + ` · tuple-format findings: ${findings.filter((f) => f.finding.region || f.finding.construct || f.finding.twin || f.finding.loss).length}`);
for (const [ref, list] of [...byRef.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const f = list[0].finding;
  const marks = (list.some((x) => x.finding.fixture) ? ' [fixture]' : '') + (list.some((x) => x.finding.solution) ? ' [solution]' : '') + (list.some((x) => x.finding.twin_shows) ? ' [proven]' : '') + (list.some((x) => x.finding.severity) ? ' [' + list.map((x) => x.finding.severity).filter(Boolean)[0] + ']' : '');
  const rws = list.map((x) => x.row), done = rws.filter((r) => ledger.landed[r]), dfr = rws.filter((r) => ledger.deferred[r]);
  const disp = done.length === rws.length ? ' ✔LANDED' : done.length ? ` ✔landed ${fmtRows(done)}` : dfr.length === rws.length ? ' ·DEFERRED' : '';
  console.log(`${fmtRows(rws).padEnd(14)} ${String(list.length).padStart(3)} ${f.systematic ? 'SYS' : '   '} [${ref.slice(0, 40)}] ${f.twin ? f.twin + '/' : ''}${f.loss || ''} got=${String(f.got || '').slice(0, 50)} → exp=${String(f.expected || '').slice(0, 45)} | ${String(f.note || '').slice(0, 130)}${marks}${disp}`);
}
if (flag('json')) writeFileSync(flag('json'), JSON.stringify(items, null, 2));
// --fixtures=<dir>: every finding's repro fixture + its tuple as files (fixture-<n>.html / fixture-<n>.json), ready for the harness.
if (flag('fixtures')) {
  const dir = flag('fixtures'); mkdirSync(dir, { recursive: true }); let n = 0;
  // Each fixture is named by its SHEET ROW, so a repro always traces back to the response it came from.
  for (const it of findings) { const f = it.finding; if (!f.fixture) continue; n++; const base = join(dir, 'fixture-r' + String(it.row).padStart(3, '0')); writeFileSync(base + '.html', f.fixture); const meta = { ...f }; delete meta.fixture; writeFileSync(base + '.json', JSON.stringify({ row: it.row, at: it.at, converterVersion: it.converterVersion, hostHash: it.hostHash, ...meta }, null, 2)); }
  console.log(`${n} fixture(s) → ${dir}`);
}

// ---- record a disposition, and print the REPORT-BACK block ------------------------------------------
// The protocol requires naming WHICH rows were landed in the converter, not just "checked the sheet". These
// flags write that into the ledger and echo it in the shape the report takes.
const landedNow = flag('landed') ? parseRows(flag('landed')) : [];
const deferredNow = flag('deferred') ? parseRows(flag('deferred')) : [];
if (landedNow.length || deferredNow.length) {
  const stamp = new Date().toISOString(), note = flag('note'), ver = flag('converter-version');
  const known = new Map(items.map((x) => [x.row, x]));
  for (const r of landedNow) {
    // A row absent from THIS window is still recorded -- the window is a --since filter, not the sheet.
    const it = known.get(r);
    ledger.landed[r] = { at: stamp, note, converterVersion: ver, ref: it && it.finding ? it.finding.ref : undefined, construct: it && it.finding ? it.finding.construct : undefined };
    delete ledger.deferred[r];
  }
  for (const r of deferredNow) { if (ledger.landed[r]) continue; const it = known.get(r); ledger.deferred[r] = { at: stamp, note, ref: it && it.finding ? it.finding.ref : undefined }; }
  ledger.lastTriage = stamp;
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  const unseen = [...landedNow, ...deferredNow].filter((r) => !known.has(r));
  if (unseen.length) console.log(`note: ${fmtRows(unseen)} not in this window (widen --since to see them) — recorded anyway`);
  console.log('');
  console.log('REPORT BACK — paste this into the turn summary:');
  if (landedNow.length) console.log(`  landed in the converter : ${fmtRows(landedNow)} (${landedNow.length} row${landedNow.length === 1 ? '' : 's'})${note ? ' — ' + note : ''}`);
  if (deferredNow.length) console.log(`  deferred                : ${fmtRows(deferredNow)} (${deferredNow.length})${note ? ' — ' + note : ''}`);
  console.log(`  ledger total            : ${fmtRows(Object.keys(ledger.landed).map(Number))} landed, ${fmtRows(Object.keys(ledger.deferred).map(Number))} deferred`);
  console.log(`  next run                : --since=${stamp.slice(0, 16)}`);
} else {
  // A plain triage run still states the standing position, so a report can name it without a second command.
  const L = Object.keys(ledger.landed).map(Number), D = Object.keys(ledger.deferred).map(Number);
  const open = findings.filter((x) => !ledger.landed[x.row] && !ledger.deferred[x.row]);
  const openFix = open.filter((x) => x.finding && x.finding.fixture);
  console.log('');
  console.log(`ledger: ${L.length} landed ${fmtRows(L)} · ${D.length} deferred ${fmtRows(D)} · ${open.length} open in this window (${openFix.length} fixture-backed, i.e. actionable)`);
  if (ledger.lastTriage) console.log(`last triage: ${ledger.lastTriage}`);
  console.log('record a disposition with: --landed=r12,r19-r21 --deferred=r31 --note="<the rule + its golden>"');
}
