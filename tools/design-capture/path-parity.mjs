/**
 * PATH PARITY — does the PHP converter produce the same thing as the JS one, on the same input?
 *
 * WHY THIS EXISTS. The converter has two independent implementations of the same algorithm: the PHP
 * `Stitch`/`Mapper` (what a WordPress conversion actually runs) and the JS `capture-extract`/`to-pages`
 * (what the capture service writes into pages.json and grades in the conversion report). The house rule is
 * that they stay in sync. There are ~31 hand-written parity tests, each pinning ONE behaviour — and every
 * one of them was written after somebody noticed a divergence by hand.
 *
 * Nothing compared the two paths' output as a whole, and that gap has a cost beyond missed bugs: it lets
 * you "fix" a defect in one path that the OTHER path never had. That happened — a cell of icon-plus-label
 * fell back to verbatim HTML in JS, so the same rule was written into PHP for parity; a sweep then showed
 * PHP had always mapped that shape to a `feature_list`, better than the fix, and the PHP code was dead on
 * every real capture. The fix was right for JS and pure noise for PHP, and only measuring both said so.
 *
 * So this runs both paths over the stored captures and diffs their shortcode inventories. It is a coarse
 * instrument on purpose — it answers "do these two disagree, and where", which is the question you ask
 * before writing a rule, not after.
 *
 * BOTH SIDES MUST READ THE SAME INPUT. The PHP half parses `rendered.html`, which is the raw captured DOM
 * and therefore always current. The JS half originally read the stored `design-capture.json` — the
 * extractor's OUTPUT, frozen at capture time. Some stored captures here are months old, so the comparison
 * was partly measuring how stale a file was rather than how the two converters disagree: one section read
 * as a plain row in the stored JSON and as `testimonials` when the current extractor was re-run over the
 * same DOM. So the JS half now RE-EXTRACTS from `rendered.html` in a browser, exactly as a live capture
 * would, and the two halves finally see the same bytes.
 *
 * `rendered.html` must be loaded with JAVASCRIPT DISABLED. It is a serialized DOM, and the page's own
 * scripts re-run on load and wipe it — with JS on, the same file yields 38 elements and 34 characters of
 * text instead of 463 elements. A tool that reloads it with JS enabled measures an empty page and reports
 * whatever that implies, confidently.
 *
 * Usage:  node path-parity.mjs [capture-out]
 * Needs:  a local WP install with the plugin active (the PHP half runs through wp-cli), and Chrome.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { toPages } from './to-pages.mjs';
import { extractDesign } from './capture-extract.mjs';

const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const WP_CLI = process.env.WP_CLI || 'D:/xampp/wp-cli.phar';
const WP_PATH = process.env.WP_PATH || 'D:/xampp/htdocs';
const PHP = process.env.PHP_BIN || 'D:/xampp/php/php.exe';

/** Count shortcodes in a builder page tree — the comparable surface of both paths. */
export function inventory(nodes, into = {}) {
  if (!nodes || typeof nodes !== 'object') return into;
  if (Array.isArray(nodes)) { for (const n of nodes) inventory(n, into); return into; }
  if (typeof nodes.shortcode === 'string') into[nodes.shortcode] = (into[nodes.shortcode] || 0) + 1;
  for (const v of Object.values(nodes)) if (v && typeof v === 'object') inventory(v, into);
  return into;
}

/**
 * The per-shortcode disagreement between two inventories, and a single divergence figure.
 *
 * `divergence` is summed ABSOLUTE difference over the union of keys, divided by the SUM of both totals —
 * Bray-Curtis dissimilarity, bounded 0..1. Identical inventories score 0; a path emitting ten `text_block`
 * where the other emits ten `icon_box` scores 1.0, total disagreement, rather than 0 for "same count".
 * Dividing by the LARGER total instead lets the figure reach 2.0, which is what the first version did and
 * why its mean could not be read as a percentage of anything.
 */
export function compare(a, b) {
  // An EMPTY side is the absence of a measurement, not total disagreement. Two stored captures held zero
  // sections — a capture that had failed — and scoring them made both read as 1.0, the worst divergence on
  // the board, which is how a broken input gets mistaken for a broken converter. Same rule as gradeSections
  // in verify-site.mjs: refuse to grade rather than grade a blank.
  const nA = Object.values(a).reduce((n, v) => n + v, 0);
  const nB = Object.values(b).reduce((n, v) => n + v, 0);
  if (!nA || !nB) {
    return { ok: false, error: `one side produced no shortcodes (js=${nA}, php=${nB}) — the capture is empty or failed (not graded)` };
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const rows = keys.map((k) => ({ shortcode: k, php: b[k] || 0, js: a[k] || 0, delta: (a[k] || 0) - (b[k] || 0) }))
    .filter((r) => r.delta !== 0);
  const spread = keys.reduce((n, k) => n + Math.abs((a[k] || 0) - (b[k] || 0)), 0);
  const total = nA + nB;
  return { ok: true, divergence: total ? +(spread / total).toFixed(3) : 0, rows };
}

function phpInventories(dir) {
  const script = `${dir}/_parity.php`;
  writeFileSync(script, `<?php
$base = getenv('CAP_DIR'); $out = array();
foreach ( (array) glob( $base . '/*/rendered.html' ) as $f ) {
  $html = @file_get_contents( $f ); if ( ! $html ) { continue; }
  $slug = basename( dirname( $f ) );
  try { $r = FW_Site_Converter_Sources::build_from_html( $html, 'fixture', array( 'hifi_css' => true ) ); }
  catch ( Throwable $e ) { $out[ $slug ] = array( 'error' => $e->getMessage() ); continue; }
  $j = (string) wp_json_encode( $r['files']['pages.json'] ?? array() );
  preg_match_all( '/"shortcode":"([a-z_]+)"/', $j, $m );
  $out[ $slug ] = array_count_values( $m[1] );
}
echo json_encode( $out );`);
  const raw = execFileSync(PHP, [WP_CLI, `--path=${WP_PATH}`, '--allow-root', 'eval-file', script],
    { env: { ...process.env, CAP_DIR: dir }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const i = raw.indexOf('{');
  return JSON.parse(raw.slice(i, raw.lastIndexOf('}') + 1));
}

export async function sweep(dir = 'capture-out') {
  const php = phpInventories(dir);
  const out = [];
  const b = await chromium.launch({ executablePath: CHROME });
  // JS disabled: rendered.html is a serialized DOM and its own scripts would wipe it on load.
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  for (const slug of readdirSync(dir)) {
    if (slug.startsWith('_')) continue;
    const f = `${dir}/${slug}/rendered.html`;
    if (!existsSync(f) || !php[slug]) continue;
    let jsInv;
    try {
      const p = await ctx.newPage();
      await p.goto(pathToFileURL(f).href, { waitUntil: 'load' });
      const cap = await p.evaluate(extractDesign);
      await p.close();
      jsInv = inventory(toPages(cap, {}).pages);
    }
    catch (e) { out.push({ slug, error: 'js: ' + e.message }); continue; }
    if (php[slug].error) { out.push({ slug, error: 'php: ' + php[slug].error }); continue; }
    const c = compare(jsInv, php[slug]);
    out.push(c.ok ? { slug, ...c } : { slug, error: c.error });
  }
  await b.close();
  // Worst disagreement first: the point is to say which shape to look at next.
  return out.sort((a, b) => (b.divergence || 0) - (a.divergence || 0));
}

if (import.meta.url.endsWith(String(process.argv[1]).split(/[\\/]/).pop())) {
  const rows = await sweep(process.argv[2] || 'capture-out');
  for (const r of rows) {
    if (r.error) { console.log(`${r.slug.slice(0, 30).padEnd(32)} ${r.error}`); continue; }
    console.log(`${r.slug.slice(0, 30).padEnd(32)} divergence ${String(r.divergence).padStart(5)}  ` +
      (r.rows.length ? r.rows.map((x) => `${x.shortcode} js${x.js}/php${x.php}`).join('  ') : 'identical'));
  }
  const graded = rows.filter((r) => !r.error);
  const skipped = rows.length - graded.length;
  if (skipped) console.log(`
${skipped} capture${skipped === 1 ? '' : 's'} not graded (see above) — excluded from the mean`);
  console.log(`\n${graded.length} captures compared; mean divergence ` +
    (graded.length ? (graded.reduce((n, r) => n + r.divergence, 0) / graded.length).toFixed(3) : 'n/a'));
}
