// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// send-finding.mjs — STREAM one converter finding upstream immediately (ask-once → send-each-bug).
//
// The agent calls this ONCE PER systematic miss, AFTER a single upfront "yes" from the user (never
// ask-per-bug). Each call POSTs a LEAN `{ hostHash, converterVersion, one finding }` to the same Google
// Form as `--share` — a couple hundred bytes, so a bug-heavy site never approaches the 50k Sheets-cell
// limit — and prints a concise notification. Sends are throttled to >= 1s apart (burst safety). Send the
// once-per-site aggregate with `--summary --stats=<file>`.
//
//   node send-finding.mjs --url=<src-url> --finding='{"region":"s2","property":"font-weight","got":"400",
//                          "expected":"700","construct":"button.btn-amber .font-bold","path":"capture-out/<site>",
//                          "twin":"php","loss":"overridden","recurs":true,"ref":"s2:hero buttons",
//                          "note":"the preset carries 700; the static .btn rule wins"}'
//   node send-finding.mjs --url=<src-url> finding.json          # finding from a file
//
//   + OPTIONAL "fixture": "@capture-out/<site>/fixture.html"   (from make-fixture.mjs: the stamped construct, scrubbed to structure)
//   + OPTIONAL "solution": "a display:block span inside a heading is a line, not a split word → scrub keeps display:block"
//
// THE CONTRACT IS ENFORCED: a finding is refused unless it carries region · property · got · expected ·
// construct (the SOURCE construct: a class / rule / tag) · path (the capture-out folder or a file in it) ·
// twin (php | js | both) · loss (one of the loss kinds). A symptom without its construct and capture path
// cannot be reproduced — 528 free-text findings were filed and four of them stayed open for exactly that.
//   node send-finding.mjs --url=<src-url> --summary --stats=capture-out/<site>/share-stats.json
//
// MOTION GAPS use their own kind and their own tuple (fixture · surface · motion · tried · outcome ·
// fallback) — the Animation Engine could not express a motion, which is a capability gap, not a
// conversion loss, and has no twin to run:
//   node send-finding.mjs --url=<src-url> --motion-gap --gap='{"fixture":"fb_01","surface":"element",
//        "motion":"ribbon unfurls on scroll: clip-path 0->100% + 6deg skew, 700ms",
//        "tried":"scroll-reveal (no clip-path), motion-path (wrong axis)","outcome":"fallback-written",
//        "fallback":"upw-fb-01","region":"hero","path":"capture-out/<fixture-id>"}'
//
// --dry-run validates and PRINTS the payload without sending. Use it whenever you are testing the
// tool rather than reporting a real finding: the configured form is the maintainer's live ledger.
// Structural-only (sanitized in to-share.mjs): the note is auto-redacted of URLs/emails/quoted content.
// Consent is the AGENT's responsibility — it invokes this only after the one "yes"; the tool just sends.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { buildFindingPayload, buildStatsPayload, buildMotionGapPayload, postToForm, buildMailto, loadShareConfig, oneLineSummary, LOSS_KINDS, SEVERITIES, FIXTURE_MAX, MOTION_SURFACES, MOTION_OUTCOMES } from './to-share.mjs';
import { fixtureIsStamped } from './fixture.mjs';

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
  payload = buildStatsPayload({ url, converterVersion: VERSION, stats, positives: flag('positives') }); // --positives="one line of what was right" 
} else if (has('motion-gap')) {
  /* A MOTION GAP: "the Animation Engine cannot express this motion", not "the converter lost it".
     It takes its own tuple because the converter gates cannot apply - there is no twin to run and the
     repro is the motion plus the fallback, not a data-sc-cs fragment (see to-share.mjs for the why).
     The tuple still forces the loop: `tried` is what makes step 1 (reach for a native effect first)
     auditable rather than a claim, and `fixture` keys the row to a NEUTRAL id so the ledger can count
     how often a motion recurs without ever naming a source. */
  const inlineG = flag('gap');
  const fileG = args.find((a) => !a.startsWith('--'));
  let gap = null;
  try { gap = inlineG ? JSON.parse(inlineG) : JSON.parse(readFileSync(fileG, 'utf8')); }
  catch (e) { console.error("send-finding: pass a gap JSON via --gap='{…}' or a file path —", e.message); process.exit(1); }

  const REQ_G = ['fixture', 'surface', 'motion', 'tried', 'outcome', 'fallback'];
  const missG = REQ_G.filter((k) => !gap || gap[k] == null || String(gap[k]).trim() === '');
  const badSurface = gap && gap.surface && !MOTION_SURFACES.includes(String(gap.surface));
  const badOutcome = gap && gap.outcome && !MOTION_OUTCOMES.includes(String(gap.outcome));
  if (missG.length || badSurface || badOutcome) {
    console.error('send-finding: REFUSED — a motion gap needs every field of its own tuple.');
    if (missG.length) console.error('  missing: ' + missG.join(', '));
    if (badSurface) console.error('  surface must be one of: ' + MOTION_SURFACES.join(' | '));
    if (badOutcome) console.error('  outcome must be one of: ' + MOTION_OUTCOMES.join(' | '));
    console.error('  shape: {"fixture":"fb_01","surface":"element","motion":"ribbon unfurls on scroll: clip-path 0->100% + 6deg skew, 700ms","tried":"scroll-reveal (no clip-path), motion-path (wrong axis)","outcome":"fallback-written","fallback":"upw-fb-01","region":"hero","path":"capture-out/<fixture-id>","recurs":"3rd site"}');
    console.error('  tried = the native effects you consulted and why none fits — a gap reported without it cannot be told from "did not look".');
    process.exit(2);
  }
  // A NEUTRAL fixture id, never a word from the source: the no-brand rule is not satisfied by hashing
  // the host, because the id is free text that goes in the ledger exactly as written.
  if (/\.(com|net|org|io|art|co|shop|dev|app|site)\b|https?:/i.test(String(gap.fixture))) {
    console.error('send-finding: REFUSED — `fixture` must be a NEUTRAL id (fb_01, fixture-04), never a site name or domain.');
    process.exit(2);
  }
  if ('no-fallback' !== gap.outcome && !/[a-z0-9]/i.test(String(gap.fallback))) {
    console.error('send-finding: REFUSED — name the fallback you wrote (its key, e.g. upw-fb-01), or set outcome to no-fallback and say why in `fallback`.');
    process.exit(2);
  }
  if ('gallery' === gap.surface) {
    console.error('send-finding: note — a gallery design registers through THREE PHP filters (design_groups + render_designs + design_assets) plus window.upwGallery3d.registerDesign; miss the render whitelist and it silently falls back to carousel_ring. See docs/animation-engine/child-theme-fallback-effect.md.');
  }
  payload = buildMotionGapPayload({ url, converterVersion: VERSION, gap });
} else {
  const inline = flag('finding');
  const file = args.find((a) => !a.startsWith('--'));
  let finding = null;
  try { finding = inline ? JSON.parse(inline) : JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error("send-finding: pass a finding JSON via --finding='{…}' or a file path —", e.message); process.exit(1); }
  // `@file` values are inlined (a fixture from make-fixture.mjs, a solution written to a file) — JSON stays short.
  for (const k of ['fixture', 'solution']) {
    if (finding && typeof finding[k] === 'string' && finding[k].startsWith('@')) {
      try { finding[k] = readFileSync(finding[k].slice(1), 'utf8'); } catch (e) { console.error(`send-finding: cannot read ${k} file ${finding[k]} — ${e.message}`); process.exit(1); }
    }
  }
  // A fixture must be a STAMPED construct (data-sc-cs) — a bare DOM, a screenshot description or a CSS patch is not a repro.
  if (finding && finding.fixture && !fixtureIsStamped(finding.fixture)) {
    console.error('send-finding: REFUSED — `fixture` carries no data-sc-cs stamp. Cut it from rendered.html with make-fixture.mjs (node make-fixture.mjs capture-out/<site> "<selector>").');
    process.exit(2);
  }
  // A solution is the GENERAL rule (a recognizer / carrier / selector change in the converter), never a per-site patch:
  // a stylesheet aimed at this page's ids / classes fixes one site and teaches the converter nothing.
  if (finding && finding.solution && /(?:^|\s)#[a-z][\w-]*\s*\{/i.test(String(finding.solution)) && !/recogni[sz]er|stitch|mapper|to-pages|capture-extract|rule|general/i.test(String(finding.solution))) {
    console.error('send-finding: REFUSED — `solution` looks like a per-site CSS patch (an #id rule). Describe the GENERAL rule (which construct → which converter path) instead; site fixes stay in your child theme.');
    process.exit(2);
  }
  // A POSITIVE is not a finding: it names nothing a rule can use, and seven of them per site pad the feed. It goes in the
  // once-per-site summary (`--summary --positives="…"`).
  if (finding && /^\s*positive\b/i.test(String(finding.ref || '')) || (finding && /^\s*\(keep\)\s*$/i.test(String(finding.expected || '')))) {
    console.error('send-finding: REFUSED — a POSITIVE is not a finding. Put what the converter got right in the site summary: node send-finding.mjs --url=<src> --summary --stats=<share-stats.json> --positives="hero cover + 3 icon boxes + pricing 3 plans".');
    process.exit(2);
  }
  // "Fixed per-site in chrome.css" WITHOUT the rule is the sandbox working and the report failing: the patch the agent wrote
  // is the most valuable artefact. A finding that says it was fixed on the site must carry the GENERAL `solution`.
  const saysFixed = finding && /fixed\s+(?:per-site|on the site|natively|in chrome\.css|in the child theme)|per-site\s+(?:fix|layer|chrome)/i.test(String(finding.note || '') + ' ' + String(finding.got || ''));
  if (saysFixed && !(finding.solution && String(finding.solution).trim().length >= 24)) {
    console.error('send-finding: REFUSED — the note says the miss was fixed per-site, but `solution` is missing. State the GENERAL rule you applied (which source construct → which converter path / selector / option), not the site patch. The rule is what fixes the next site.');
    process.exit(2);
  }
  // A fixture must be PROVEN: `twin_shows` = what the PHP twin emitted for the fixture (the same wrong output as the page).
  // A fixture that was never run through the twin is a guess — two arrived without their text, one cut to a single tile
  // that reproduced a different construct.
  if (finding && finding.fixture && !(finding.twin_shows && String(finding.twin_shows).trim() !== '')) {
    console.error('send-finding: REFUSED — a `fixture` needs `twin_shows`: run it through the PHP twin (FW_Site_Converter_Sources::build_from_html) and state the output that reproduces the miss (e.g. "code_block ×4, 0 gallery"). If the twin output differs from the page, the fixture does not reproduce it — re-cut (a grid needs ≥ 3 repeats; make-fixture keeps 3 per run).');
    process.exit(2);
  }
  // A SYSTEMATIC finding ships a fixture: without one the maintainer cannot prove or golden the rule (contract item 19 —
  // the fixture-less rows of a batch are the ones that wait). a `no_fixture_reason` field states why one cannot be cut.
  if (finding && finding.systematic && !finding.fixture && !(finding.no_fixture_reason && String(finding.no_fixture_reason).trim() !== '')) {
    console.error('send-finding: REFUSED — a `systematic` finding needs a `fixture` (node make-fixture.mjs capture-out/<site> "<selector>"), or `no_fixture_reason` stating why the construct cannot be cut.');
    process.exit(2);
  }
  // `expected` names a property the fixture must CARRY (contract item 17): a fixture whose stamps lack it proves a capture gap, not a converter drop.
  if (finding && finding.fixture && finding.property) {
    const prop = String(finding.property).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp('(?:^|[;"\\s])' + prop + '\\s*:', 'i').test(String(finding.fixture))) {
      console.error('send-finding: WARNING — the fixture\'s stamps do not carry `' + finding.property + '`: if the source has it, this is a CAPTURE gap (loss: not-captured), not a converter drop.');
    }
  }
  if (finding && finding.severity && !SEVERITIES.includes(String(finding.severity))) {
    console.error('send-finding: REFUSED — `severity` must be one of: ' + SEVERITIES.join(' | '));
    process.exit(2);
  }
  const REQUIRED = ['region', 'property', 'got', 'expected', 'construct', 'path', 'twin', 'loss'];
  const missing = REQUIRED.filter((k) => !finding || finding[k] == null || String(finding[k]).trim() === '');
  const badTwin = finding && finding.twin && !/^(php|js|both)$/i.test(String(finding.twin));
  const badLoss = finding && finding.loss && !LOSS_KINDS.includes(String(finding.loss));
  if (missing.length || badTwin || badLoss) {
    console.error('send-finding: REFUSED — the reporting contract needs every tuple field.');
    if (missing.length) console.error('  missing: ' + missing.join(', '));
    if (badTwin) console.error('  twin must be php | js | both (which engine BUILT the page you measured; the WP import = php)');
    if (badLoss) console.error('  loss must be one of: ' + LOSS_KINDS.join(' | '));
    console.error('  shape: {"region":"s2","property":"font-weight","got":"400","expected":"700","construct":"button.btn-amber .font-bold","path":"capture-out/<site>","twin":"php","loss":"overridden","recurs":true,"note":"…"}');
    console.error('  region = hero | s<N> | chrome:header | chrome:footer | typography | import; construct = the SOURCE class / rule / tag that carries the value; path = the capture-out folder (rendered.html + pages.json live there).');
    process.exit(2);
  }
  payload = buildFindingPayload({ url, converterVersion: VERSION, finding });
  if (!payload.finding) { console.error('send-finding: the finding sanitized to empty (needs got / expected / note).'); process.exit(1); }
  if (finding.fixture && String(finding.fixture).length > FIXTURE_MAX) console.error(`send-finding: note — the fixture was cut to ${FIXTURE_MAX} chars (pick a tighter selector / --no-section for a whole repro).`);
  if (payload.finding.fixture) console.log(`  + repro fixture (${payload.finding.fixture.length} chars, structure only — text neutralised, targets dropped)`);
  if (!payload.finding.severity) console.error('send-finding: note — no `severity` (layout | content-loss | style | cosmetic); the maintainer orders a batch by it, an unranked finding waits.');
  if (/overridden/.test(String(payload.finding.loss)) && !payload.finding.computed) console.error('send-finding: note — an `overridden` loss without `computed` (what getComputedStyle returned on the built page, and which rule won) is a guess about the cascade; add it.');
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

/* --dry-run: everything up to the POST, then stop. Added the hard way - the gates of a new report kind
   were exercised against the LIVE form and put two test rows in the shared ledger, because validating a
   sender had no way to stop short of sending. A tool whose only mode is "send for real" will be tested
   for real. */
if (has('dry-run')) {
  console.log('dry-run — nothing was sent. Payload that WOULD be posted:');
  console.log(JSON.stringify(payload, null, 1));
  console.log('summary: ' + oneLineSummary(payload));
  process.exit(0);
}

const cfg = loadShareConfig(DIR);
if (!cfg.form || !cfg.form.responseUrl) {
  console.log('share: no Google Form configured — email this instead:');
  console.log('   ', buildMailto(payload, cfg));
  process.exit(0);
}
try {
  const r = await postToForm(payload, cfg);
  try { writeFileSync(stampFile, String(Date.now())); } catch { /* best-effort */ }
  const what = payload.kind === 'motion-gap' ? '⚑ Motion gap reported — '
    : payload.kind === 'summary' ? '⚑ Site summary reported — ' : '⚑ Converter improvement reported — ';
  console.log(r.ok ? what + oneLineSummary(payload) : `share: POST failed (status ${r.status}); email instead:`);
  if (!r.ok) console.log('   ', buildMailto(payload, cfg));
} catch (e) {
  console.log('share: could not reach the Google Form (' + e.message + '); email instead:');
  console.log('   ', buildMailto(payload, cfg));
}
