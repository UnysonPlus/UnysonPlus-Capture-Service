// send-finding.mjs — STREAM one converter finding upstream immediately (ask-once → send-each-bug).
//
// The agent calls this ONCE PER systematic miss, AFTER a single upfront "yes" from the user (never
// ask-per-bug). Each call POSTs a LEAN `{ hostHash, converterVersion, one finding }` to the same Google
// Form as `--share` — a couple hundred bytes, so a bug-heavy site never approaches the 50k Sheets-cell
// limit — and prints a concise notification. Sends are throttled to >= 1s apart (burst safety). Send the
// once-per-site aggregate with `--summary --stats=<file>`.
//
//   node send-finding.mjs --url=<src-url> --finding='{"ref":"s2:heading h2","got":"code_block",
//                          "expected":"special_heading","note":"faq accordion mapped to plain cols",
//                          "systematic":true}'
//   node send-finding.mjs --url=<src-url> finding.json          # finding from a file
//   node send-finding.mjs --url=<src-url> --summary --stats=capture-out/<site>/design-config.json
//
// Structural-only (sanitized in to-share.mjs): the note is auto-redacted of URLs/emails/quoted content.
// Consent is the AGENT's responsibility — it invokes this only after the one "yes"; the tool just sends.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { buildFindingPayload, buildStatsPayload, postToForm, buildMailto, loadShareConfig, oneLineSummary } from './to-share.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => { const f = args.find((a) => a.startsWith('--' + n + '=')); return f ? f.slice(n.length + 3) : ''; };
const has = (n) => args.includes('--' + n);
const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || ''; } catch { return ''; } })();

const url = flag('url');

let payload;
if (has('summary')) {
  let stats = {};
  try { stats = JSON.parse(readFileSync(flag('stats'), 'utf8')); } catch { /* empty summary is still valid */ }
  if (stats && stats.stats) stats = stats.stats;            // accept a full report/config or a bare stats object
  payload = buildStatsPayload({ url, converterVersion: VERSION, stats });
} else {
  const inline = flag('finding');
  const file = args.find((a) => !a.startsWith('--'));
  let finding = null;
  try { finding = inline ? JSON.parse(inline) : JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error("send-finding: pass a finding JSON via --finding='{…}' or a file path —", e.message); process.exit(1); }
  payload = buildFindingPayload({ url, converterVersion: VERSION, finding });
  if (!payload.finding) { console.error('send-finding: the finding sanitized to empty (needs got / expected / note).'); process.exit(1); }
}

// Throttle: keep sends >= 1s apart so a burst can't look like abuse to Google Forms. The last-send stamp
// persists across the separate per-bug processes in a file beside the tool.
const THROTTLE_MS = 1000;
const stampFile = join(DIR, '.share-last-send');
try {
  const last = parseInt(readFileSync(stampFile, 'utf8'), 10) || 0;
  const wait = last + THROTTLE_MS - Date.now();
  if (wait > 0) { await new Promise((r) => setTimeout(r, wait)); }
} catch { /* no prior send */ }

const cfg = loadShareConfig(DIR);
if (!cfg.form || !cfg.form.responseUrl) {
  console.log('share: no Google Form configured — email this instead:');
  console.log('   ', buildMailto(payload, cfg));
  process.exit(0);
}
try {
  const r = await postToForm(payload, cfg);
  try { writeFileSync(stampFile, String(Date.now())); } catch { /* best-effort */ }
  console.log(r.ok ? '⚑ Converter improvement reported — ' + oneLineSummary(payload) : `share: POST failed (status ${r.status}); email instead:`);
  if (!r.ok) console.log('   ', buildMailto(payload, cfg));
} catch (e) {
  console.log('share: could not reach the Google Form (' + e.message + '); email instead:');
  console.log('   ', buildMailto(payload, cfg));
}
