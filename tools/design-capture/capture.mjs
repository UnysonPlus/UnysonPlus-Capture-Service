// Design-capture for the Site Converter.
// Renders source site(s) in the installed Chrome and produces the convert bundle + conversion
// report for each. QUEUE: pass one OR MANY URLs and they're captured sequentially (one at a time)
// in a single Chrome — so you don't re-type the command per site, and two runs never collide.
//
//   node capture.mjs <url> [url2 url3 …] [base-outdir] [--report-only] [--list=urls.txt]
//                     [--skip-header] [--skip-footer] [--skip-sections=0,2] [--only-sections=1,3]
//
// • Multiple URLs run one after another, each into its own capture-out/<site>/ folder.
// • --list=urls.txt reads more URLs from a file (one per line; blank lines / #comments ignored).
// • A non-URL positional arg is the base output dir (default: capture-out).
// • SKIP FLAGS preserve QA'd parts on a re-run: --skip-header / --skip-footer drop the chrome;
//   --skip-sections=<s_index list> drops those body bands; --only-sections=<list> keeps ONLY those.
//   (s_index = the section number shown in conversion-report.csv.) Re-importing then leaves the
//   parts you already accepted untouched.
// • If a site fails (e.g. a flaky network), it writes <site>/error.txt and the queue CONTINUES.
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { toDesignConfig } from './to-design-config.mjs';
import { toPages } from './to-pages.mjs';
import { toStyleGuide } from './to-styleguide.mjs';
import { toPresets } from './to-presets.mjs';
import { toThemeSettings } from './to-theme-settings.mjs';
import { toBlockBundle } from './to-block-bundle.mjs';
import { buildBorderPresets, boxpForFrom } from './box-presets.mjs';
import { makeZip } from './minimal-zip.mjs';
import { extractDesign } from './capture-extract.mjs';
import { toReport } from './to-report.mjs';
import { contrastReview, contrastReviewCsv } from './contrast.mjs';
import { toStyleReport } from './to-style-report.mjs';
import { sanitizeReport, postToForm, buildMailto, loadShareConfig } from './to-share.mjs';
import { traceAnimations, animationReport, extractStoryScenes, stageSectionNode, applyMotionToPage, extractBrandTokens } from './to-animations.mjs';
import { ensureDashboard } from './dashboard/ensure-open.mjs';
import { microBackend, selectedLocalModel, localSectionMicroTask, bgFxMicroTask, verifyCoverage, nameBoxPresets, nameSectionStyles, verifyAccordionDesign, localAiStatus } from './to-ai.mjs';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));

// Write the shared AI-activity record the dashboard polls (/api/ai → CAPTURE_OUT/_ai.json), so the
// "🧠 <model> working…" indicator lights up while the LOCAL micro layer runs during a capture too — not
// only during a manual /ai-convert. Best-effort; a write race never breaks the capture.
function writeAiActivity(obj) {
  try {
    const base = process.env.CAPTURE_OUT || 'capture-out';
    mkdirSync(base, { recursive: true });
    writeFileSync(`${base}/_ai.json`, JSON.stringify({ backend: 'ollama', model: selectedLocalModel(), tool: 'micro', at: Date.now(), ...obj }));
  } catch { /* dashboard indicator is best-effort */ }
}
const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || ''; } catch { return ''; } })();

// --- Args -------------------------------------------------------------------
const _args = process.argv.slice(2);
// Running a capture is "using the converter" → open the live dashboard (localhost:4600) if not already.
// Fire-and-forget + lockfile-guarded, so a service-spawned capture won't spam browser tabs.
ensureDashboard();
const _flags = _args.filter((a) => a.startsWith('--'));
const _pos = _args.filter((a) => !a.startsWith('--'));
const isUrl = (s) => /^(https?|file):\/\//i.test(s); // accept local file:// sources too
const REPORT_ONLY = _flags.includes('--report-only') || process.env.REPORT_ONLY === '1';
// --fidelity: prefer VERBATIM mirroring for every section (max design fidelity, less granular
// editing) instead of decomposing into shortcodes — for design-heavy / Tailwind / SPA sources.
const FIDELITY = _flags.includes('--fidelity') || process.env.FIDELITY === '1';
// Opt-in report sharing (default OFF). `--share-preview` builds the anonymized share-report.json so you
// can inspect exactly what WOULD be sent; `--share` also submits it (Google Form → Sheet → the project
// inbox), an explicit per-run consent. See docs/report-sharing.md. `--share` implies building the preview.
const SHARE = _flags.includes('--share') || process.env.UPW_SHARE === '1';
const SHARE_PREVIEW = SHARE || _flags.includes('--share-preview') || process.env.UPW_SHARE_PREVIEW === '1';
// Optional AGENT diagnosis attached to the share report: a JSON array of { ref, got, expected, note,
// systematic } (the got-vs-expected the converter's own trace can't carry). Read from --findings=<path>,
// else `share-findings.json` in the site's out-dir / base-outdir / cwd. Sanitized (structural only) in
// to-share.mjs; missing = no findings (fine). Collect the WHOLE site's misses into ONE file, share ONCE.
const _findingsFlag = _flags.find((f) => f.startsWith('--findings='));
const FINDINGS_PATH = _findingsFlag ? _findingsFlag.slice('--findings='.length) : '';
// Preserve QA'd parts on a RE-RUN: skip the header/footer chrome, or keep/drop specific body sections
// (by the s_index shown in the conversion report). e.g. `--skip-header --skip-sections=0,2` or
// `--only-sections=1,3` — so a re-convert only touches the parts you still want reconverted.
const SKIP_HEADER = _flags.includes('--skip-header') || process.env.UPW_SKIP_HEADER === '1';
const SKIP_FOOTER = _flags.includes('--skip-footer') || process.env.UPW_SKIP_FOOTER === '1';
// High-fidelity CSS faithful base — DEFAULT ON (parity with the PHP converter). Turn off with --no-hifi
// or UPW_HIFI_CSS=0 for leaner, purely-native output.
const HIFI_CSS = !( _flags.includes('--no-hifi') || process.env.UPW_HIFI_CSS === '0' );
const _intList = (name) => { const f = _flags.find((x) => x.startsWith(name + '=')); return f ? f.slice(name.length + 1).split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => !Number.isNaN(n)) : null; };
const SKIP_SECTIONS = _intList('--skip-sections'); // drop these s_index sections
const ONLY_SECTIONS = _intList('--only-sections'); // keep ONLY these s_index sections
// EXCLUSIVE region targeting: run the converter for ONE region and leave the rest of the live site
// untouched on re-import. --only-header / --only-footer reconvert just that chrome part; --only-sections
// reconverts just those body sections (merged into the existing page by index). These set a
// `convert_scope` on the bundle that the importer honours (gate phases + section-merge + chrome-preserve).
// Output TARGET: 'page-builder' (default, the classic UnysonPlus site) or 'block-theme' (additionally
// emit block-bundle.json — a portable FSE block theme the plugin installs via install_block_theme).
const TARGET = ( _flags.find((f) => f.startsWith('--target=')) || '' ).split('=')[1] || process.env.TARGET || 'page-builder';
// Block-theme VOCABULARY: 'core' (default, plugin-independent) or 'enriched' (emit UnysonPlus
// blocks where mapped — richer output that depends on the plugin's blocks extension). Tier C6.
const VOCAB = ( _flags.find((f) => f.startsWith('--vocab=')) || '' ).split('=')[1] || process.env.VOCAB || 'core';
const ONLY_HEADER = _flags.includes('--only-header') || process.env.UPW_ONLY_HEADER === '1';
const ONLY_FOOTER = _flags.includes('--only-footer') || process.env.UPW_ONLY_FOOTER === '1';
// The scope object: which regions are IN SCOPE for this run. null = full convert (back-compat).
const CONVERT_SCOPE = ( ONLY_HEADER || ONLY_FOOTER || ONLY_SECTIONS )
  ? { header: !!ONLY_HEADER, footer: !!ONLY_FOOTER, sections: ONLY_SECTIONS || [] }
  : null;
const baseOutdir = _pos.find((p) => !isUrl(p)) || 'capture-out';
let urls = _pos.filter(isUrl);
const listFlag = _flags.find((f) => f.startsWith('--list='));
if (listFlag) {
  const file = listFlag.slice('--list='.length);
  try {
    urls = urls.concat(readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')));
  } catch (e) { console.error('could not read --list file:', file, '-', e.message); }
}
// de-dupe, preserve order
urls = [...new Set(urls)];
if (!urls.length) {
  console.error('usage: node capture.mjs <url> [url2 …] [base-outdir] [--report-only] [--fidelity] [--list=urls.txt] [--share-preview] [--share] [--skip-header] [--skip-footer] [--skip-sections=0,2] [--only-header] [--only-footer] [--only-sections=1]');
  process.exit(1);
}

const MULTIPAGE = false; // TEMP: home-only while we perfect the homepage. Flip to true to crawl the nav.
const MAX_PAGES = 10;    // home + up to 9 nav pages (keeps the capture within a sane time budget)

// --- Per-capture mutable state (set by captureOne, used by the helpers below) ---
let origin = '';
let outdir = '';
let page = null;
let _t0 = 0;
// --- Live progress log (drives the dashboard front-end) --------------------------------
// Every step() appends to <outdir>/progress.jsonl and rewrites <outdir>/progress.json, and
// a <baseDir>/_active.json pointer names the site currently converting. The dashboard polls
// these so a human can watch each pipeline stage + the tool running it, in real time.
let _progress = null; // { slug, url, status, startedAt, steps: [...] }
let _baseDir = '';
let _heartbeat = null; // keeps updatedAt fresh during a LONG single stage, so the dashboard's stale-detector
                       // (which flags a `running` capture whose updatedAt went cold as a dead process) never
                       // false-positives on a slow-but-alive step. Cleared on done/error.
function progressInit(slug, url, baseDir) {
  _baseDir = baseDir;
  _progress = { slug, url, status: 'running', startedAt: Date.now(), updatedAt: Date.now(), steps: [], summary: null, error: '' };
  progressFlush();
  try { writeFileSync(`${baseDir}/_active.json`, JSON.stringify({ slug, url, status: 'running', startedAt: _progress.startedAt })); } catch { /* best-effort */ }
  if (_heartbeat) { clearInterval(_heartbeat); }
  _heartbeat = setInterval(() => { if (_progress && _progress.status === 'running') progressFlush(); }, 3000);
  if (_heartbeat && _heartbeat.unref) { _heartbeat.unref(); } // never keep the process alive just for the beat
}
function progressFlush() {
  if (!_progress || !outdir) return;
  try {
    _progress.updatedAt = Date.now();
    writeFileSync(`${outdir}/progress.json`, JSON.stringify(_progress));
  } catch { /* the dir may not exist yet on the very first step */ }
}
function progressDone(status, extra) {
  if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; }
  if (!_progress) return;
  _progress.status = status;
  if (extra && extra.summary) _progress.summary = extra.summary;
  if (extra && extra.error) _progress.error = extra.error;
  progressFlush();
  try { if (_baseDir) writeFileSync(`${_baseDir}/_active.json`, JSON.stringify({ slug: _progress.slug, url: _progress.url, status, startedAt: _progress.startedAt })); } catch { /* best-effort */ }
}
const step = (m) => {
  const elapsed = (Date.now() - _t0) / 1000;
  console.log(`  [${elapsed.toFixed(1)}s] ${m}`);
  if (_progress) {
    const entry = { t: Date.now(), elapsed: Math.round(elapsed * 10) / 10, msg: String(m) };
    _progress.steps.push(entry);
    try { if (outdir) appendFileSync(`${outdir}/progress.jsonl`, JSON.stringify(entry) + '\n'); } catch { /* dir race */ }
    progressFlush();
  }
};

// A report folder name from the site URL: host (minus leading "www."), dots/punct → "_".
// e.g. https://www.mintlify.com → "mintlify_com", https://docs.stripe.com/x → "docs_stripe_com_x".
function siteSlug(u) {
  try {
    const url = new URL(u);
    let s = url.hostname.replace(/^www\./i, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (path) s += '_' + path.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
    return s || 'site';
  } catch { return 'site'; }
}

// A WP-friendly slug from a URL path's last segment (drops extension). '' / index → home.
function slugFromUrl(u) {
  try {
    const path = new URL(u, origin).pathname.replace(/\/+$/, '');
    let seg = (path.split('/').filter(Boolean).pop() || 'home').replace(/\.(html?|php|aspx?)$/i, '');
    seg = seg.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return seg === '' || seg === 'index' ? 'home' : seg;
  } catch { return 'home'; }
}

// Run a page.evaluate, retrying if a late client re-render destroys the execution context.
async function evalSafe(p, fn, arg) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await p.evaluate(fn, arg); }
    catch (e) {
      lastErr = e;
      if (!/context was destroyed|Execution context|navigation/i.test(String(e && e.message))) { throw e; }
      await p.waitForTimeout(700);
    }
  }
  throw lastErr;
}

// Record an emitted Scroll Story in the conversion report using the report's OWN row kinds
// (`section` + one `element` per scene leaf) — otherwise a fully-converted scroll-hijacked page
// reads as "0 elements / 0 sections", which is both wrong and hides the emit from the
// report-driven improvement workflow.
function traceStory(trace, sIndex, node, scenes, story) {
  const frames = story && story.seq ? story.seq.count : 0;
  trace.push({
    kind: 'section', sIndex,
    decision: 'scroll-story (scrollytelling stage)',
    sourceClass: 'fixed-overlay story',
    height: 0,
    note: frames ? `${frames} backdrop frames → Media Library (user-replaceable)` : 'no backdrop',
  });
  (node._items || []).forEach((col, ci) => {
    const sc = scenes[ci] || {};
    (col._items || []).forEach((leaf) => {
      const atts = leaf.atts || {};
      const text = String(atts.title || atts.label || atts.text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      trace.push({
        kind: 'element', sIndex,
        role: 'scene-' + (ci + 1),
        detected: sc.headings && sc.headings.length ? 'story scene (heading)' : 'story scene',
        shortcode: leaf.shortcode,
        fallback: false,
        opportunity: false,
        why: `scene ${ci + 1} of ${scenes.length} · ${story && story.sceneLen ? story.sceneLen : '?'} screens`,
        sourceTag: 'div', sourceClass: 'fixed overlay',
        text: text.slice(0, 160),
      });
    });
  });
}

// Render a URL: navigate, let late CDN runtimes settle, scroll to trigger lazy assets, extract.
async function renderPage(p, target) {
  step(`navigating ${target} … (can take up to ~60s on heavy SPAs)`);
  await p.goto(target, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await p.waitForLoadState('load').catch(() => {});
  await p.waitForFunction(() => {
    let rules = 0;
    for (const s of Array.from(document.styleSheets)) {
      try { rules += (s.cssRules || []).length; } catch { /* cross-origin */ }
    }
    const ff = getComputedStyle(document.body).fontFamily || '';
    return rules >= 40 || ff.toLowerCase().includes('inter');
  }, { timeout: 8000 }).catch(() => {});
  // CLIENT-RENDERED SPA guard: a React/Vue/Svelte app mounts its content into #root/#app AFTER networkidle,
  // so a snapshot taken now can catch an EMPTY shell (`<div id="root"></div>` → 0 sections, a blank
  // screenshot). Wait until the app root actually holds real content — a landmark/section, or substantial
  // text/children — before extracting. Generous timeout (heavy SPAs), and .catch so a genuinely-empty page
  // (or one needing interaction) still proceeds instead of hanging.
  await p.waitForFunction(() => {
    const root = document.querySelector('#root, #app, [data-reactroot], main') || document.body;
    if (!root) { return false; }
    if (root.querySelector('section, main, header, article, footer, [class*="section"], [data-sc-col]')) { return true; }
    return (root.innerText || '').trim().length > 200 && root.children.length >= 2;
  }, { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(1200);
  step('rendered — scrolling to trigger lazy assets…');
  await evalSafe(p, async () => {
    await new Promise((res) => {
      let y = 0; const stepY = 600;
      const t = setInterval(() => {
        window.scrollBy(0, stepY); y += stepY;
        if (y >= document.body.scrollHeight) { clearInterval(t); res(); }
      }, 100);
    });
  });
  await p.waitForTimeout(900);
  await evalSafe(p, () => window.scrollTo(0, 0));
  await p.waitForTimeout(250);
  // MEGA-MENU / dropdown EXPANSION. Nav dropdown panels are JS-mounted on open (Radix/shadcn: a <button>
  // with aria-controls + data-state="open", panel often portaled to <body>), so a static snapshot misses
  // the whole panel. Open each header nav trigger, let its panel mount, grab its HTML, then serialize all
  // panels into a <script id="sc-mega-menus"> the deterministic converter reads to detect + rebuild a mega
  // menu. Best-effort and self-closing; never blocks the capture.
  let megaMenus = []; // structured { trigger, cols, columns:[[{label,url,desc}]] } for the bundle's mega-menus.json (JS-path parity with PHP detect_mega_menus)
  try {
    const triggers = await p.$$('header button[aria-controls], header button[aria-expanded], header [aria-haspopup="menu"], nav button[aria-controls]');
    // Read the currently-open panel for a trigger (by its aria-controls id, else any open Radix/menu
    // content) — once it has mounted ≥3 links, return BOTH its outerHTML (for the sc-mega-menus stamp the
    // PHP path reads) AND the STRUCTURED items (label/url/desc) + column count, parsed in-page with the real
    // DOM. Colons in Radix ids (`radix-:r0:-content…`) are fine for getElementById.
    const readPanel = (id) => p.evaluate((cid) => {
      let panel = cid ? document.getElementById(cid) : null;
      if (!panel || panel.querySelectorAll('a').length < 3) {
        const open = document.querySelectorAll('[data-radix-menu-content],[data-radix-navigation-menu-viewport],[data-state="open"] [role="menu"],[role="menu"],[data-state="open"]');
        for (const el of open) { if (el.querySelectorAll('a').length >= 3) { panel = el; break; } }
      }
      if (!panel || panel.querySelectorAll('a').length < 3) return null;
      const outer = panel.outerHTML.slice(0, 24000);
      let cols = 1; const gm = outer.match(/grid-cols-(\d+)/); if (gm) cols = Math.max(1, Math.min(6, parseInt(gm[1], 10)));
      const items = [];
      for (const a of panel.querySelectorAll('a')) {
        const href = (a.getAttribute('href') || '').trim();
        let label = '';
        for (const lt of ['h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'span', 'div']) { const el = a.querySelector(lt); if (el && el.textContent.trim()) { label = el.textContent.replace(/\s+/g, ' ').trim(); break; } }
        const ps = a.querySelectorAll('p'); let desc = ps.length ? ps[ps.length - 1].textContent.replace(/\s+/g, ' ').trim() : '';
        if (!label) label = a.textContent.replace(/\s+/g, ' ').trim();
        if (desc && desc === label) desc = '';
        if (!label) continue;
        items.push({ label, url: href || '#', desc });
      }
      return { html: outer, cols, items };
    }, id).catch(() => null);
    const megaData = [];
    for (const t of triggers) {
      try {
        const label = ((await t.evaluate((el) => (el.textContent || '').trim()).catch(() => '')) || '').slice(0, 40);
        if (!label) continue;
        const cid = await t.getAttribute('aria-controls').catch(() => null);
        // Radix menus open on a pointer sequence with a delay, then React MOUNTS the panel — so a single
        // fixed wait is flaky. Try three OPEN strategies (real hover · synthetic pointer events · click),
        // and after each POLL up to ~1.6s for the panel to actually mount. Robust across the timing jitter
        // that made the panel intermittently miss (→ no sc-mega-menus → mega menu silently not converted).
        let panel = null;
        for (let attempt = 0; attempt < 3 && !panel; attempt++) {
          if (attempt === 0) {
            await t.scrollIntoViewIfNeeded().catch(() => {});
            await t.hover({ timeout: 1500 }).catch(() => {});
          } else if (attempt === 1) {
            await t.evaluate((el) => { for (const type of ['pointerover', 'pointerenter', 'pointermove', 'mouseover', 'mouseenter']) { try { el.dispatchEvent(new MouseEvent(type, { bubbles: true })); } catch {} } }).catch(() => {});
          } else {
            await t.click({ timeout: 1500 }).catch(() => {});
          }
          for (let w = 0; w < 6 && !panel; w++) {
            await p.waitForTimeout(260);
            panel = await readPanel(cid);
          }
        }
        if (panel && Array.isArray(panel.items) && panel.items.length >= 2) {
          megaData.push({ label, html: panel.html }); // raw stamp (PHP path)
          // Distribute items row-major into columns (column j = items j, j+cols, …) — mirrors PHP detect_mega_menus.
          const columns = Array.from({ length: panel.cols }, () => []);
          panel.items.forEach((it, i) => columns[i % panel.cols].push(it));
          megaMenus.push({ trigger: label, cols: panel.cols, columns });
        }
        // Close before the next one so panels don't overlap in the final snapshot.
        await p.keyboard.press('Escape').catch(() => {});
        await p.mouse.move(3, 3).catch(() => {});
        await p.waitForTimeout(160);
      } catch { /* per-trigger best-effort */ }
    }
    if (megaData.length) {
      await p.evaluate((data) => {
        const s = document.createElement('script');
        s.type = 'application/json'; s.id = 'sc-mega-menus';
        s.textContent = JSON.stringify(data);
        document.body.appendChild(s);
      }, megaData).catch(() => {});
    }
  } catch { /* dropdown expansion is best-effort */ }
  // INLINE cross-origin stylesheets before extraction. A CDN-served bundle (e.g. an SPA that swaps
  // its critical CSS for a hashed cdn.* bundle after hydration) is loaded WITHOUT a `crossorigin`
  // attr, so `sheet.cssRules` throws SecurityError → the extractor can't read it and every rule it
  // holds (crucially the RESPONSIVE `md:`/`lg:` utilities that un-hide the desktop nav) is dropped →
  // the mirrored chrome renders as a permanent hamburger. Re-fetch each blocked/linked sheet (the CDN
  // serves CORS headers, so `fetch` works) and inline it as a same-origin <style> so ALL rules become
  // readable. matchesPage() still trims to used selectors, so the theme carries only what's needed.
  await evalSafe(p, async () => {
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'));
    for (const link of links) {
      const href = link.href || '';
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(href)) continue; // keep webfonts linked
      let readable = false;
      try { readable = !!(link.sheet && link.sheet.cssRules); } catch { readable = false; }
      if (readable) continue; // same-origin / CORS-readable already — leave it
      try {
        const res = await fetch(href, { mode: 'cors' });
        if (!res.ok) continue;
        const css = await res.text();
        const style = document.createElement('style');
        style.textContent = css;
        style.setAttribute('data-inlined-from', href);
        link.parentNode.insertBefore(style, link.nextSibling);
        link.remove();
      } catch { /* leave the link; it becomes linked_css */ }
    }
  });
  await p.waitForTimeout(150);
  const data = await evalSafe(p, extractDesign);
  step(`extracted ${(data.sections || []).length} sections`);
  // EMPTY-RENDER DIAGNOSTIC: 0 sections + an unmounted client-side app shell (`<div id="root"></div>`) /
  // near-empty body means the SOURCE page never rendered — almost always its JS bundle / CDN failed to load
  // (a temporary preview whose CDN is down, an SPA blocked in headless, an offline dependency). There is
  // literally nothing to map; make that explicit so it isn't mistaken for a converter/kit bug.
  if ((data.sections || []).length === 0) {
    const diag = await evalSafe(p, () => {
      const root = document.querySelector('#root, #app, [data-reactroot], [data-server-rendered]');
      return { spaShell: !!(root && root.children.length === 0), textLen: (document.body.innerText || '').trim().length };
    });
    if (diag && (diag.spaShell || diag.textLen < 120)) {
      step('  ⚠ the source rendered BLANK — an empty client-side app shell (its JavaScript / CDN likely failed to load), so there is nothing to map. This is a SOURCE-side problem, NOT a converter bug: open the URL in a normal browser to confirm it renders, retry when its CDN is reachable, or convert a server-rendered page / an uploaded HTML export instead.');
    }
  }
  // Per-section breakdown → the dashboard shows exactly WHICH parts were detected (header, each body
  // section named by its heading, footer). The mapping itself is one fast pass, so this is the
  // section-level record rather than a slow live ticker.
  try {
    const ch = data.chrome || {};
    if (ch.header_html) { const n = (ch.nav_tree || []).length; step(`  chrome · header → nav (${n} menu item${n === 1 ? '' : 's'})`); }
    (data.sections || []).forEach((s, i) => {
      const h = String(s.heading || '').replace(/\s+/g, ' ').trim().slice(0, 46);
      const n = (s.mirror && Array.isArray(s.mirror.children)) ? s.mirror.children.length : 0;
      const kind = (i === 0 && h) ? 'hero' : 'section';
      step(`  §${i + 1} ${kind}${h ? ` · “${h}”` : ''}${n ? ` (${n} element${n === 1 ? '' : 's'})` : ''}`);
    });
    if (ch.footer_html) { const n = (ch.footer_cols || []).length; step(`  chrome · footer → ${n} column${n === 1 ? '' : 's'}`); }
  } catch { /* best-effort breakdown — never block the capture */ }
  // Stamp each meaningful element's RESOLVED computed styles onto a `data-sc-cs` attribute so the
  // deterministic PHP engine can reproduce the look of ANY site. Kept in a data-attr (not `style`).
  await evalSafe(p, () => {
    const PROPS = ['background-color','background-image','color','font-family','font-size','font-weight','line-height','letter-spacing','text-align','text-transform','text-decoration-line','padding','margin','border-top-width','border-top-style','border-top-color','border-radius','box-shadow','backdrop-filter','max-width','display','gap','justify-content','align-items','flex-direction','transition','transform'];
    const skip = { 'background-color':v=>v==='rgba(0, 0, 0, 0)'||v==='transparent', 'background-image':v=>v==='none', 'box-shadow':v=>v==='none', 'backdrop-filter':v=>v==='none', 'max-width':v=>v==='none', 'text-decoration-line':v=>v==='none', 'text-transform':v=>v==='none', 'gap':v=>v==='normal'||v==='0px', 'padding':v=>v==='0px', 'margin':v=>v==='0px', 'border-top-width':v=>v==='0px', 'letter-spacing':v=>v==='normal',
      // Drop the CSS initial values so only elements that actually declare a transition/transform carry one.
      'transition':v=>v===''||v==='all 0s ease 0s'||v==='none 0s ease 0s'||/(^|,)\s*all 0s /.test(v), 'transform':v=>v==='none' };
    const els = document.querySelectorAll('body *');
    for (let i = 0; i < els.length; i++) {
      const el = els[i], tag = el.tagName.toLowerCase();
      if (['script','style','noscript','svg','path','br','head','link','meta'].includes(tag)) continue;
      const cs = getComputedStyle(el), add = [];
      for (const pr of PROPS) {
        const v = cs.getPropertyValue(pr);
        if (!v || (skip[pr] && skip[pr](v))) continue;
        add.push(pr + ':' + v);
      }
      // Gradient TEXT (background-clip:text) — harvest the clip + transparent fill ONLY when the
      // element actually paints gradient text (a gradient background-image + clip:text), so the
      // faithful base can reproduce it. Otherwise the gradient would fill a block behind un-clipped
      // text (the "two-tone-heading-black" bug). Guarded so a normal element carries none of these.
      if (/gradient/i.test(cs.getPropertyValue('background-image') || '')) {
        const clip = String(cs.getPropertyValue('-webkit-background-clip') || cs.getPropertyValue('background-clip') || '').trim();
        if (clip === 'text') {
          add.push('-webkit-background-clip:text');
          add.push('background-clip:text');
          const fill = String(cs.getPropertyValue('-webkit-text-fill-color') || '').trim();
          if (fill === 'transparent' || fill === 'rgba(0, 0, 0, 0)') add.push('-webkit-text-fill-color:transparent');
        }
      }
      if (add.length) el.setAttribute('data-sc-cs', add.join(';'));
    }
    // SITE CONTENT WIDTH — the rendered width the MAIN content column occupies, stamped on <html> so the
    // deterministic PHP engine can set the theme's Container Width correctly. Robust across frameworks:
    // a Bootstrap `.container` / Tailwind `max-w-*` capped container AND a FULL-WIDTH layout (sections span
    // the viewport, content inset only by px gutters — which carries NO max-width, so the old max-width-only
    // detection collapsed it to the theme's narrow default). Method: bucket every horizontally-CENTERED,
    // INSET (narrower than the viewport = not a full-bleed band) wide block by rounded width, weight by the
    // content AREA it wraps, and take the heaviest bucket = the shared main-content width.
    try {
      const vw = window.innerWidth;
      const buckets = new Map();
      for (const el of document.querySelectorAll('div,section,header,footer,main,article,nav,ul')) {
        const r = el.getBoundingClientRect();
        if (r.width < 600 || r.width > vw - 24) continue; // ≥600 = a real container; < vw-24 = inset, not full-bleed
        const leftGap = r.left, rightGap = vw - r.right;
        if (Math.abs(leftGap - rightGap) > Math.max(8, r.width * 0.06)) continue; // horizontally centered
        const key = Math.round(r.width / 8) * 8;
        buckets.set(key, (buckets.get(key) || 0) + r.width * Math.max(1, r.height));
      }
      let best = 0, bestW = 0;
      for (const [px, w] of buckets) { if (w > bestW) { bestW = w; best = px; } }
      if (best >= 600) document.documentElement.setAttribute('data-sc-content-width', String(best));
    } catch (e) { /* best-effort */ }
  });
  // HOVER / PSEUDO-ELEMENT rule harvest for BUTTONS. Hover animations live on `:hover` and
  // `::before`/`::after` rules that getComputedStyle(el) can NEVER see, so the deterministic converter's
  // hover-animation classifier (→ a `.btnfx-*` preset like fill-up / grow / lift / sweep) needs the raw
  // source rules. For each button-ish element we collect the declarations of stylesheet rules whose
  // selector matches it AND targets a state/pseudo, stamped as `data-sc-hover` (bounded). Best-effort:
  // cross-origin sheets throw on cssRules and are skipped.
  await evalSafe(p, () => {
    const rules = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let cr; try { cr = sheet.cssRules; } catch { continue; }
      if (!cr) continue;
      for (const rule of Array.from(cr)) { if (rule.type === 1 && rule.selectorText) rules.push(rule); }
    }
    const PSEUDO = /::?(hover|before|after|focus-visible)\b/i;
    const KEEP = ['content','position','top','right','bottom','left','inset','transform','transform-origin',
      '--tw-translate-x','--tw-translate-y','--tw-scale-x','--tw-scale-y','--tw-rotate','transition','transition-property',
      'transition-duration','transition-timing-function','background-color','background-image','opacity','box-shadow',
      'filter','width','height','clip-path','animation','animation-name','letter-spacing','color','border-color','text-decoration'];
    const strip = (s) => s.replace(/::?(hover|before|after|focus-visible|focus|active)\b(\([^)]*\))?/gi, '').trim() || '*';
    const btns = document.querySelectorAll('a,button,[role="button"]');
    for (const el of btns) {
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 40) continue;
      const found = [];
      for (const rule of rules) {
        const sel = rule.selectorText;
        if (!PSEUDO.test(sel)) continue;
        for (let part of sel.split(',')) {
          part = part.trim();
          if (!PSEUDO.test(part)) continue;
          const base = strip(part);
          // Skip the framework PREFLIGHT reset (`*`, `::before`, `:where(*)`) — it sets --tw-* vars on every
          // pseudo and is pure noise, not the element's own animation. Require a SPECIFIC base selector.
          if (base === '*' || base === '' || /^:where\(\s*\*?\s*\)$/.test(base) || base === ':root') continue;
          let m = false; try { m = el.matches(base); } catch { m = false; }
          if (!m) continue;
          const decls = [];
          for (const pr of KEEP) { const v = rule.style.getPropertyValue(pr); if (v) decls.push(pr + ':' + v.trim()); }
          if (decls.length) {
            const hov = /:hover/i.test(part), ps = /::?(before|after)/i.test(part);
            const which = ps ? (/::?after/i.test(part) ? 'after' : 'before') : 'self';
            const state = hov ? (ps ? 'hover-' + which : 'hover-self') : (ps ? which : 'self');
            found.push(state + '{' + decls.join(';') + '}');
          }
          break;
        }
        if (found.join('|').length > 1600) break;
      }
      if (found.length) el.setAttribute('data-sc-hover', found.join('|').slice(0, 1600));
    }
  });
  // Grab the fully-rendered HTML robustly. `p.content()` can reject with "Execution context was
  // destroyed…" on SPA / preview routes (e.g. an /api/preview endpoint that re-navigates), which used
  // to leave renderedHtml empty → no rendered.html written → the ?html=1 URL path 500'd even though the
  // bundle wrote fine. Retry, and fall back to serializing the live DOM via evaluate (survives cases
  // content() doesn't). The data-sc-cs / data-sc-col tags set just above are included either way.
  let renderedHtml = '';
  for (let attempt = 0; attempt < 3 && (!renderedHtml || renderedHtml.length < 200); attempt++) {
    renderedHtml = await p.content().catch(() => '');
    if (renderedHtml && renderedHtml.length >= 200) break;
    renderedHtml = await p.evaluate(() => (document.documentElement ? '<!doctype html>\n' + document.documentElement.outerHTML : '')).catch(() => '');
    if (renderedHtml && renderedHtml.length >= 200) break;
    await p.waitForTimeout(400);
  }
  return { url: target, renderedHtml, megaMenus, ...data };
}

// Responsive column widths — re-measure each tagged grid cell at tablet + phone viewports.
async function measureColWidths(vw) {
  try {
    await page.setViewportSize({ width: vw, height: 900 });
    await page.waitForTimeout(350);
    return await page.evaluate(() => {
      const o = {};
      document.querySelectorAll('[data-sc-col]').forEach((c) => {
        const row = c.parentElement;
        const rw = row ? row.getBoundingClientRect().width : 0;
        const cw = c.getBoundingClientRect().width;
        o[c.getAttribute('data-sc-col')] = (rw > 0 && cw > 0) ? Math.max(1, Math.min(12, Math.round((cw / rw) * 12))) : 12;
      });
      return o;
    });
  } catch { return {}; }
}

// Internal page URLs from the home nav (same-origin, real paths).
function navPageUrls(homeCapture, srcUrl) {
  const nav = (homeCapture.header && homeCapture.header.nav) || [];
  const homeSlug = slugFromUrl(srcUrl);
  const seen = new Set([homeSlug, 'home', 'index']);
  const out = [];
  for (const item of nav) {
    const href = (item.href || '').trim();
    if (!href) continue;
    let abs;
    try { abs = new URL(href, origin); } catch { continue; }
    if (!/^https?:$/.test(abs.protocol) || abs.origin !== origin) continue;
    abs.hash = '';
    const path = abs.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || path === '') continue;
    const slug = slugFromUrl(abs.href);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(abs.href);
    if (out.length >= MAX_PAGES - 1) break;
  }
  return out;
}

// Rewrite internal links to the converted site's root-relative WP path.
function relinkInternal(html, pageMap) {
  if (!html) return html;
  for (const { abs, local } of pageMap) {
    for (const form of [abs, abs.replace(/\/$/, ''), abs.endsWith('/') ? abs : abs + '/']) {
      html = html.split(`href="${form}"`).join(`href="${local}"`);
    }
  }
  if (origin) {
    ['', '/', '/index.html', '/index.htm', '/index.php', '/home'].forEach((suf) => {
      html = html.split(`href="${origin}${suf}"`).join('href="/"');
    });
  }
  return html;
}

// --- Capture ONE site (returns report stats; throws on fatal error) ---------
async function captureOne(browser, srcUrl, baseDir, reportOnly) {
  origin = (() => { try { return new URL(srcUrl).origin; } catch { return ''; } })();
  outdir = `${baseDir}/${siteSlug(srcUrl)}`;
  mkdirSync(outdir, { recursive: true });
  _t0 = Date.now();
  progressInit(siteSlug(srcUrl), srcUrl, baseDir);
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Log image requests from the very first navigation — frame sequences often preload during
  // initial render, long before the animation tracer runs its own passes.
  const _imgReqs = new Set();
  page.on('request', (r) => { try { const u = r.url().split('?')[0]; if (/\.(webp|avif|jpe?g|png)$/i.test(u)) _imgReqs.add(u); } catch (e) {} });
  // Delivered JS, kept for BUNDLED library detection: Nuxt/Next/Vite keep libs module-scoped, so
  // `window.gsap` is undefined even when GSAP drives the page. Scanning the script bodies is the
  // only reliable read of a modern site's animation stack. Capped so a huge app can't blow memory.
  const _scriptBodies = [];
  let _scriptBytes = 0;
  page.on('response', async (r) => {
    try {
      const u = r.url();
      if (!/\.m?js(\?|$)/i.test(u) || _scriptBytes > 12e6) { return; }
      const t = await r.text();
      _scriptBytes += t.length;
      _scriptBodies.push(t);
    } catch (e) { /* body unavailable (redirect/abort) — ignore */ }
  });
  try {
    // 1) Home.
    const home = await renderPage(page, srcUrl);

    // 1a) Sticky-header SCROLL STATE. A fixed header commonly swaps its look on scroll (transparent →
    // a solid/blurred bar, often with a shadow + tighter padding) via a JS scroll listener toggling a
    // class. The mirror captures only the TOP state, so capture the SCROLLED state too — the generated
    // theme reproduces the transition with a tiny scroll toggle + a `.sc-scrolled` rule.
    step('capturing sticky-header scroll state…');
    try {
      const readHdr = () => evalSafe(page, () => {
        const h = document.querySelector('header'); if (!h) return null;
        const s = getComputedStyle(h);
        return { bg: s.backgroundColor, backdrop: (s.backdropFilter && s.backdropFilter !== 'none') ? s.backdropFilter : '',
          shadow: (s.boxShadow && s.boxShadow !== 'none') ? s.boxShadow : '', padTop: s.paddingTop, padBottom: s.paddingBottom,
          borderBottom: (s.borderBottomWidth !== '0px' && s.borderBottomStyle !== 'none') ? `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}` : '',
          position: s.position };
      });
      await evalSafe(page, () => window.scrollTo(0, 0)); await page.waitForTimeout(140);
      const topState = await readHdr();
      await evalSafe(page, () => window.scrollTo(0, Math.max(720, window.innerHeight))); await page.waitForTimeout(480);
      const scrolledState = await readHdr();
      await evalSafe(page, () => window.scrollTo(0, 0)); await page.waitForTimeout(200);
      if (topState && scrolledState && /fixed|sticky/.test(topState.position || '')) {
        const changed = ['bg', 'backdrop', 'shadow', 'padTop', 'padBottom', 'borderBottom'].some((k) => (topState[k] || '') !== (scrolledState[k] || ''));
        if (changed && home.chrome) {
          home.chrome.header_scroll = { top: topState, scrolled: scrolledState };
          // Also STAMP the scrolled state onto the <header> as `data-sc-scrolled` (mirror of data-sc-cs) so the
          // bundled rendered.html carries it into the PHP build_from_html path — which sees only the static
          // top-state snapshot and otherwise can't detect the scroll-revealed backdrop-blur / bg / border.
          const scParts = [];
          if (scrolledState.bg) scParts.push('background-color:' + scrolledState.bg);
          if (scrolledState.backdrop) scParts.push('backdrop-filter:' + scrolledState.backdrop);
          if (scrolledState.shadow) scParts.push('box-shadow:' + scrolledState.shadow);
          if (scrolledState.borderBottom) scParts.push('border-bottom:' + scrolledState.borderBottom);
          if (scrolledState.padTop) scParts.push('padding-top:' + scrolledState.padTop);
          if (scrolledState.padBottom) scParts.push('padding-bottom:' + scrolledState.padBottom);
          const scAttr = scParts.join(';');
          if (scAttr) {
            await evalSafe(page, (a) => { const h = document.querySelector('header'); if (h) h.setAttribute('data-sc-scrolled', a); }, scAttr);
            const rh = await page.content().catch(() => '');
            if (rh && rh.length >= 200) home.renderedHtml = rh; // re-serialize so the attribute rides along
          }
          step(`  header changes on scroll → bg ${topState.bg} → ${scrolledState.bg}`);
        }
      }
    } catch (e) { step('header scroll-state skipped: ' + e.message); }

    // 1b) Responsive column widths (tablet + phone).
    step('measuring responsive column widths (tablet + phone)…');
    const wTablet = await measureColWidths(768);
    const wPhone = await measureColWidths(375);
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    (home.sections || []).forEach((s) => {
      (s.mapBlocks || []).forEach((b) => {
        (b.cols || []).forEach((c) => {
          if (!c || !c.colId) return;
          c.wResp = { phone: wPhone[c.colId] || c.cw || 12, tablet: wTablet[c.colId] || c.cw || 12, desktop: c.cw || 12 };
        });
      });
    });

    // 1c) ANIMATION TRACER — detect the source's motion design (libraries, ScrollTrigger dump,
    // CSS keyframes/hover diffs, scroll motion traces, frame sequences / scroll-hijack) and map it
    // onto Animation Engine fx suggestions. URL-path only (needs the live runtime).
    // 1b2) BRAND TOKENS from the rendered page. The normal extractors read in-flow `sections[]` +
    // body styles; a scroll-hijacked page has neither, so its brand would fall back to seeded
    // defaults. This samples what's actually painted (text runs + button fills incl. GRADIENTS) and
    // backfills only the tokens that came up empty — so it never overrides a good extraction.
    try {
      const bt = await evalSafe(page, extractBrandTokens);
      if (bt) {
        home.tokens = home.tokens || {};
        home.tokens.body = home.tokens.body || {};
        const blankish = (v) => !v || /rgba?\(\s*0,\s*0,\s*0(,\s*0)?\s*\)/.test(String(v)) || String(v) === 'transparent';
        if (blankish(home.tokens.brandColor) && bt.brandColor) { home.tokens.brandColor = bt.brandColor; }
        if (blankish(home.tokens.body.color) && bt.bodyColor) { home.tokens.body.color = bt.bodyColor; }
        if (!home.tokens.body.fontFamily && bt.bodyFont) { home.tokens.body.fontFamily = bt.bodyFont; }
        if (blankish(home.tokens.body.backgroundColor) && bt.surface) { home.tokens.body.backgroundColor = bt.surface; }
        home.baseHeading = home.baseHeading || {};
        if (!home.baseHeading.fontFamily && bt.headingFont) { home.baseHeading.fontFamily = bt.headingFont; }
        if (!home.baseHeading.color && bt.headingColor) { home.baseHeading.color = bt.headingColor; }
        if (!home.baseHeading.weight && bt.headingWeight) { home.baseHeading.weight = bt.headingWeight; }
        step(`brand tokens → heading=${bt.headingFont || '?'} · body=${bt.bodyFont || '?'} · brand=${bt.brandColor || '?'}`);
      }
    } catch (e) { step('brand-token sampling skipped: ' + e.message); }

    step('tracing animations (libraries, hover, scroll motion)…');
    let anim = null;
    try {
      anim = await traceAnimations(page, { log: (m) => step('  ' + m), knownImageUrls: _imgReqs, scriptBodies: _scriptBodies });
      step(`animations → ${((anim && anim.suggestions) || []).length} finding(s)` +
        (anim && anim.hijack && anim.hijack.virtualScroll ? ' · scroll-hijacked page detected' : ''));
    } catch (e) { step('animation tracer skipped: ' + e.message); }
    home.animations = anim;

    // Scroll-hijacked page → extract the fixed full-screen overlays as STORY SCENES, so the emit
    // phase can produce one editable scrollytelling STAGE section instead of an empty page.
    if (anim && anim.hijack && anim.hijack.virtualScroll && anim.hijack.fixedFullscreenOverlays >= 2) {
      try {
        anim.scenes = await page.evaluate(extractStoryScenes);
        step(`scroll story → ${(anim.scenes || []).length} scene(s) extracted from fixed overlays`);
      } catch (e) { step('scene extraction skipped: ' + e.message); }
    }

    // 2) Optional nav crawl (disabled).
    const extraUrls = MULTIPAGE ? navPageUrls(home, srcUrl) : [];
    const captures = [{ capture: home, slug: 'home', front: true }];
    for (const u of extraUrls) {
      try { captures.push({ capture: await renderPage(page, u), slug: slugFromUrl(u), front: false }); }
      catch (e) { console.log('  ! skipped', u, '-', e.message); }
    }

    // 3) Link map + relink chrome + bodies.
    const pageMap = captures.map((c) => ({ abs: c.capture.url, local: c.front ? '/' : '/' + c.slug + '/' }));
    if (home.chrome) {
      home.chrome.header_html = relinkInternal(home.chrome.header_html, pageMap);
      home.chrome.footer_html = relinkInternal(home.chrome.footer_html, pageMap);
      const relinkTree = (items) => (Array.isArray(items) ? items.map((it) => ({
        ...it, href: typeof it.href === 'string' ? relinkInternal(it.href, pageMap) : it.href, children: relinkTree(it.children),
      })) : []);
      if (Array.isArray(home.chrome.nav_tree)) { home.chrome.nav_tree = relinkTree(home.chrome.nav_tree); }
      if (Array.isArray(home.chrome.footer_cols)) { home.chrome.footer_cols = home.chrome.footer_cols.map((h) => relinkInternal(h, pageMap)); }
      if (typeof home.chrome.footer_copyright === 'string') { home.chrome.footer_copyright = relinkInternal(home.chrome.footer_copyright, pageMap); }
    }
    captures.forEach((c) => { (c.capture.sections || []).forEach((s) => { if (s.rawHtml) s.rawHtml = relinkInternal(s.rawHtml, pageMap); }); });

    // 3b) SKIP FLAGS — preserve QA'd parts on a re-run. Drop skipped body sections (by s_index) and
    // blank skipped header/footer chrome, so the emitted bundle + report carry only what you asked to
    // reconvert. (Re-import then leaves the parts you already accepted untouched.)
    if (SKIP_SECTIONS || ONLY_SECTIONS || SKIP_HEADER || SKIP_FOOTER || CONVERT_SCOPE) {
      captures.forEach((c) => {
        const orig = c.capture.sections || [];
        // Original s_index of every SURVIVING section, so the importer can MERGE them back into the
        // existing page by position (targeted re-import) rather than replacing the whole page.
        const keepIdx = orig.map((_, i) => i).filter((i) =>
          CONVERT_SCOPE ? CONVERT_SCOPE.sections.includes(i)                       // exclusive scope: only these
          : ONLY_SECTIONS ? ONLY_SECTIONS.includes(i)
          : SKIP_SECTIONS ? !SKIP_SECTIONS.includes(i)
          : true);
        c._scopeSections = keepIdx;
        c.capture.sections = keepIdx.map((i) => orig[i]);
      });
      // Legacy --skip-header/--skip-footer BLANK the chrome (drop it from the bundle). The new
      // --only-* scope does NOT blank the chrome — the theme still needs the full chrome CSS for a
      // correct style.css; the scope instead tells the importer which chrome part is in scope (so the
      // OUT-of-scope part's template file is preserved, not overwritten).
      if (home.chrome && SKIP_HEADER) { home.chrome.header_html = ''; home.chrome.nav_tree = []; home.chrome.logo = null; home.chrome.header_skipped = true; }
      if (home.chrome && SKIP_FOOTER) { home.chrome.footer_html = ''; home.chrome.footer_cols = []; home.chrome.footer_copyright = ''; home.chrome.footer_skipped = true; }
      const parts = [];
      if (CONVERT_SCOPE) { parts.push('scope: ' + [CONVERT_SCOPE.header && 'header', CONVERT_SCOPE.footer && 'footer', CONVERT_SCOPE.sections.length && ('sections ' + CONVERT_SCOPE.sections.join(','))].filter(Boolean).join(' + ')); }
      else if (ONLY_SECTIONS) parts.push('only sections ' + ONLY_SECTIONS.join(','));
      else if (SKIP_SECTIONS) parts.push('skip sections ' + SKIP_SECTIONS.join(','));
      if (SKIP_HEADER) parts.push('skip header');
      if (SKIP_FOOTER) parts.push('skip footer');
      step('region targeting → ' + parts.join(' · '));
    }

    // 4) Theme + style guide + builder pages.
    step('building theme, pages & conversion report…');
    const config = toDesignConfig(home);
    if (home.chrome) config.raw_chrome = home.chrome;
    // Region-targeting scope → carried in the bundle so the importer gates its phases (chrome vs. body),
    // merges the scoped sections into the existing page, and preserves the out-of-scope chrome part.
    if (CONVERT_SCOPE) { config.convert_scope = CONVERT_SCOPE; }
    // CHROME → parent-theme Theme Settings (playbook: chrome = theme, not page content). Emit the
    // header/footer as native Header/Footer Theme-Settings values + flag the theme-generator to
    // ship a NEAR-EMPTY child theme (no header.php/footer.php) so the parent renders this chrome.
    // MIRROR of the PHP tokens_to_theme_settings_chrome() + chrome_via_settings flag.
    const themeSettings = toThemeSettings(config, home);
    // Make EVERY Theme-Settings preset build EXPLICIT + GRANULAR in Live progress (colors / buttons /
    // section styles / text styles are all derived from the source here; box & icon-badge presets follow
    // in the box pass below). One step per preset kind so nothing is silent.
    {
      const v = themeSettings.values || {};
      const cnt = (k) => (Array.isArray(v[k]) ? v[k].length : 0);
      step(`🎛️ Theme Settings presets → deriving the design system from the source…`);
      // Reported in DESIGN-SYSTEM order (tokens → type → spacing → components → sections), the order the
      // deterministic converter derives them inside toThemeSettings().
      if (cnt('theme_colors')) step(`  🎨 Color Presets → ${cnt('theme_colors')} brand color(s)`);
      if (v.typography && Object.keys(v.typography).length) step(`  🔡 Typography → heading + body scale set`);
      if (cnt('font_sizes')) step(`  🔤 Text Styles → ${cnt('font_sizes')} size(s)`);
      if (cnt('spacing_scale')) step(`  📏 Spacing Scale → ${cnt('spacing_scale')} step(s)`);
      if (cnt('button_colors') || cnt('button_sizes')) step(`  🔘 Button Presets → ${cnt('button_colors')} style(s)${cnt('button_sizes') ? `, ${cnt('button_sizes')} size(s)` : ''}`);
      if (cnt('section_style_presets')) step(`  🎞️ Section Styles → ${cnt('section_style_presets')} band(s)`);
    }
    // LOCAL-AI SECTION-STYLE NAMING (pre-pass, best-effort): name the coloured bands BEFORE to-pages derives
    // each section's `variant` slug from style_name, so no reslug is needed. Same pattern as the box presets.
    try {
      const ssp = themeSettings.values && themeSettings.values.section_style_presets;
      if (microBackend() === 'ollama' && selectedLocalModel() && Array.isArray(ssp) && ssp.length) {
        step(`🧠 local AI (${selectedLocalModel()}) → naming section styles…`);
        const sn = await nameSectionStyles(ssp);
        if (sn.renamed) step(`  🧠 local AI → named ${sn.renamed} section style(s): ${ssp.slice(0, 5).map((p) => p.style_name).filter(Boolean).join(', ')}`);
      }
    } catch (e) { step('section-style naming skipped: ' + e.message); }
    // FIDELITY FIRST (Rule 0.1 — header/footer MUST match the source). The Theme-Settings chrome path
    // is editable but LOSSY — it can't reproduce a custom logo lockup (icon + multi-tone text), a
    // multi-column footer, or social icons, so a rich source (e.g. FreshPaws) converts to a bare
    // text-logo header with no nav + a one-column footer. When we captured the source's REAL chrome
    // markup (raw_chrome header/footer HTML + its CSS), render THAT verbatim (the faithful mirror —
    // theme-generator bakes header.php/footer.php) instead. Fall back to Theme-Settings chrome only
    // when no faithful mirror is available (e.g. a partial HTML upload).
    const hasFaithfulChrome = !!( home.chrome && ( home.chrome.header_html || home.chrome.footer_html ) );
    if ( ! hasFaithfulChrome && themeSettings && themeSettings.values && Object.keys(themeSettings.values).length ) {
      config.chrome_via_settings = true;
    }
    const titleFor = (cap, slug) => {
      const t = (cap.title || '').split(/\s+[|–—·-]\s+/)[0].trim();
      return t || slug.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
    };
    // AI-TIER AMBIENT BACKGROUNDS (pre-pass, best-effort): for sections with an UNNAMED animated backdrop
    // (a WebGL/particle canvas the deterministic keyword pass couldn't identify), let the local model / Claude
    // pick the closest built-in Background Effect. Runs BEFORE to-pages so the added bgEffects flow through the
    // same stacked-bg_effect apply as the deterministic ones. Non-destructive; skipped when no backend/candidates.
    try {
      for (const c of captures) {
        const bfx = await bgFxMicroTask((c.capture && c.capture.sections) || []);
        if (bfx && bfx.sections) {
          step(`  🧠 ${bfx.backend} → suggested backgrounds for ${bfx.sections} section${bfx.sections === 1 ? '' : 's'} (${bfx.layers} layer${bfx.layers === 1 ? '' : 's'})`);
        }
      }
    } catch (e) { step('ambient-background suggestion skipped: ' + e.message); }
    const reportPages = [];
    let patternsAppliedTotal = 0;
    let dividersAppliedTotal = 0;
    const builderPages = captures.map((c) => {
      const trace = [];
      const _tp = toPages(c.capture, { trace, fidelity: FIDELITY, hifiCss: HIFI_CSS, buttonPresets: { button_colors: themeSettings.values.button_colors, button_sizes: themeSettings.values.button_sizes } });
      patternsAppliedTotal += (_tp.patternsApplied || 0);
      dividersAppliedTotal += (_tp.dividersApplied || 0);
      const pg = _tp.pages[0];
      pg.title = titleFor(c.capture, c.slug);
      pg.slug = c.slug; pg.status = 'publish'; pg.front_page = c.front;
      // Targeted re-import: mark the page PARTIAL and list the original s_index of each builder section
      // (same order), so the importer merges these into the existing page instead of replacing it.
      if (CONVERT_SCOPE && Array.isArray(c._scopeSections)) { pg.partial = true; pg.scope_sections = c._scopeSections; }
      if (c.front && anim) {
        // Scroll-hijacked source: emit editable Scroll Story stage section(s). With a sampled
        // TIMELINE, each story stretch (scene run + its ride's backdrop + real pacing) becomes its
        // own section — matching the source's choreography. Without one, fall back to a single
        // section with the longest sequence as backdrop.
        if ((anim.scenes || []).length && pg.builder.length === 0) {
          const byOv = new Map(anim.scenes.filter((s) => s.ov != null).map((s) => [s.ov, s]));
          if (anim.timeline && anim.timeline.stories.length && byOv.size) {
            let emitted = 0;
            anim.timeline.stories.forEach((story) => {
              const scs = story.scenes.map((s) => byOv.get(s.ov)).filter(Boolean);
              if (!scs.length) return;
              const node = stageSectionNode(scs, story.seq, story.sceneLen);
              pg.builder.push(node);
              traceStory(trace, emitted, node, scs, story);
              emitted++;
            });
            if (emitted) { step(`scroll story → emitted ${emitted} timed stage section(s) from the sampled timeline`); }
          }
          if (pg.builder.length === 0) {
            const seq = (anim.sequences || []).slice().sort((a, b) => b.count - a.count)[0] || null;
            const node = stageSectionNode(anim.scenes, seq);
            pg.builder.push(node);
            traceStory(trace, 0, node, anim.scenes, { seq, sceneLen: 1.5 });
            step(`scroll story → emitted 1 stage section (${anim.scenes.length} scenes${seq ? ' + sequence backdrop' : ''})`);
          }
        }
        // Motion profile: stamp detected reveal/hover/smooth-scroll fx onto the emitted nodes.
        const applied = applyMotionToPage(pg, anim);
        if (applied && (applied.reveal || applied.button || applied.card)) {
          step(`motion profile → reveal×${applied.reveal} · button-hover×${applied.button} · card-hover×${applied.card}`);
        }
      }
      reportPages.push({ slug: c.slug, front: c.front, trace });
      return pg;
    });
    const pages = { pages: builderPages };

    // BOX PRESETS (Theme Settings → Components → Box Presets). Every icon_box stashed its captured card
    // SKIN on `_box` during mapping; cluster the DISTINCT skins across all pages into `border_presets`
    // (defaults + derived), point each icon_box's `box_style` at its matching preset, then drop `_box`.
    // This is the URL/JS counterpart of the PHP `build_box_presets()` (which only ran on file uploads).
    const iconBadgeSkins = [];
    {
      const iconBoxes = [];
      const boxStyleNodes = []; // other shortcodes that carry a stashed card skin on `_box` (e.g. steps cards)
      const collect = (n) => {
        if (Array.isArray(n)) { n.forEach(collect); return; }
        if (n && typeof n === 'object') {
          if (n.shortcode === 'icon_box' && n.atts && n.atts._box) iconBoxes.push(n);
          else if (n.shortcode !== 'icon_box' && n.atts && n.atts._box) boxStyleNodes.push(n);
          // Harvest every icon_box's badge skin (stashed on `_badge`) for the icon_badge_presets
          // clustering below — collect it independently of `_box` so a badge on a card with no box
          // skin is still counted, then drop it.
          if (n.shortcode === 'icon_box' && n.atts && n.atts._badge) { iconBadgeSkins.push(n.atts._badge); delete n.atts._badge; }
          if (n._items) collect(n._items);
        }
      };
      builderPages.forEach((pg) => collect(pg.builder));
      // FULL BOX CENSUS — cluster EVERY box skin on the page (glass panels, stat boxes, tinted cards, chips,
      // pills), not just icon-box cards, so the Box Presets library is complete. Fall back to the icon-box
      // skins if the census came back empty.
      const censusSkins = captures.flatMap((c) => (c.capture && Array.isArray(c.capture.boxCensus)) ? c.capture.boxCensus : []);
      // ALWAYS fold the stashed card skins (icon-box `_box`, steps Cards `_box`, …) into the clustering source
      // — not just as a fallback. The full-page census can miss a widget's own card (a steps grid card isn't a
      // census "box"), which left `boxpFor()` with no matching preset and box_style unassigned. Adding the exact
      // skin objects the assignment loop will query guarantees a preset exists and matches by identity.
      const stashedSkins = [...iconBoxes, ...boxStyleNodes].map((n) => n.atts._box).filter(Boolean);
      const skinSource = [...censusSkins, ...stashedSkins];
      if (skinSource.length || iconBoxes.length || boxStyleNodes.length) {
        step(`🎨 Box Presets → detecting box skins (fill · border · radius · shadow · hover)…`);
        const { presets, sigToId, derived: derivedBoxes, boxpFor: boxpFor0 } = buildBorderPresets(skinSource);
        let boxpFor = boxpFor0;
        // LOCAL-AI NAMING (best-effort): give each detected preset a human, role-aware name; then recompute
        // the slug map so box_style/border_preset references point at the renamed `.boxp-<slug>` rules.
        try {
          if (microBackend() === 'ollama' && selectedLocalModel() && derivedBoxes && derivedBoxes.length) {
            step(`🧠 local AI (${selectedLocalModel()}) → naming box presets…`);
            const nm = await nameBoxPresets(derivedBoxes);
            if (nm.renamed) { boxpFor = boxpForFrom(sigToId, presets); step(`  🧠 local AI → named ${nm.renamed} box preset(s): ${derivedBoxes.slice(0, 6).map((p) => p.preset_name).join(', ')}${derivedBoxes.length > 6 ? '…' : ''}`); }
          }
        } catch (e) { step('box-preset naming skipped: ' + e.message); }
        let assigned = 0;
        for (const n of iconBoxes) {
          const boxp = boxpFor(n.atts._box);
          if (boxp) { n.atts.box_style = boxp; assigned++; }
          delete n.atts._box;
        }
        // Same Box-Preset assignment for other shortcodes that stashed a card skin (steps Cards design, …)
        // AND for a decomposed card's COLUMN — a column carries the box on `border_preset` (it wraps the
        // icon_box + feature_list), every other node on `box_style`.
        for (const n of boxStyleNodes) {
          const boxp = boxpFor(n.atts._box);
          if (boxp) { if (n.type === 'column') { n.atts.border_preset = boxp; } else { n.atts.box_style = boxp; } assigned++; }
          delete n.atts._box;
        }
        // Merge into the theme-settings values so the importer writes the `border_presets` option (the
        // importer REPLACES the option, so this carries the plugin defaults + the derived presets).
        if (themeSettings && themeSettings.values) { themeSettings.values.border_presets = presets; }
        const derived = presets.slice(0, Math.max(0, presets.length - 4)); // derived sit ON TOP of the 4 defaults
        const kinds = [...new Set(derived.map((p) => String(p.preset_name || '').replace(/\s+\d+$/, '')))].filter(Boolean).join(', ');
        const withHover = derived.filter((p) => p.states && p.states.hover).length;
        const glass = derived.filter((p) => /backdrop-filter/.test(String(p.custom_css || ''))).length;
        step(`  🎨 Box Presets → ${derived.length} kind(s)${kinds ? ' [' + kinds + ']' : ''} from ${skinSource.length} box(es); ${withHover} with hover${glass ? `, ${glass} glass` : ''}; box_style assigned to ${assigned} icon-box(es)`);
      }
    }

    // ACCORDION DESIGN — the deterministic detector already matched each accordion's style/icon/position/
    // spacing/colors from the source's computed styles (accordion_design → n_accordion); here the LOCAL AI
    // CHECKS that mapping against the real toggle-icon markup and corrects an obviously-wrong icon_style /
    // accordion_style. The hint is stashed on `_accordion_hint`; this always runs so the hint is stripped
    // from the saved page JSON even when no model is configured.
    {
      const accordions = [];
      const walk = (n) => {
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n && typeof n === 'object') {
          if (n.shortcode === 'accordion' && n.atts && n.atts._accordion_hint) accordions.push(n);
          if (n._items) walk(n._items);
        }
      };
      builderPages.forEach((pg) => walk(pg.builder));
      if (accordions.length) {
        const styles = [...new Set(accordions.map((n) => n.atts.accordion_style || 'bordered'))].join(', ');
        const icons = [...new Set(accordions.map((n) => n.atts.icon_style || 'plus-minus'))].join(', ');
        step(`📂 Accordions → matched ${accordions.length} to source [style: ${styles}; icon: ${icons}]`);
        try {
          if (microBackend() === 'ollama' && selectedLocalModel()) {
            step(`🧠 local AI (${selectedLocalModel()}) → verifying accordion icon / style mapping…`);
          }
          const av = await verifyAccordionDesign(accordions);
          if (av.corrected) step(`  🧠 local AI → corrected ${av.corrected} accordion field(s) (icon/style)`);
        } catch (e) { step('accordion verify skipped: ' + e.message); accordions.forEach((n) => { delete n.atts._accordion_hint; }); }
      }
    }

    // SELF-CONTAINMENT GUARD — "never drop a class". A converted element carries the SOURCE's raw Tailwind
    // classes (text-sm / h-11 / rounded-md / font-medium) in css_class, but those class NAMES don't exist on
    // WordPress, so their effect is silently dropped unless the element also reproduces the computed value in
    // its Advanced Custom CSS. buttons, box presets, text/overline and icon-boxes now self-contain; this pass
    // AUDITS the whole tree and flags any element that still carries a sizing/typography class WITHOUT a
    // matching custom_css decl, so a regression is visible in Live Progress instead of a silently-dropped class.
    {
      const RAW = /\b(?:text-(?:xs|sm|base|lg|xl|[2-9]xl)|h-\d|leading-|tracking-|font-(?:light|normal|medium|semibold|bold|extrabold)|rounded(?:-\w+)?)\b/;
      const NEED = { 'text-': 'font-size', 'h-': 'min-height', 'leading-': 'line-height', 'tracking-': 'letter-spacing', 'font-': 'font-weight', 'rounded': 'border-radius' };
      let selfContained = 0, flagged = 0; const flags = [];
      const walk = (n) => {
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n && typeof n === 'object') {
          if (n.shortcode && n.atts) {
            const cls = String(n.atts.css_class || '');
            const css = String(n.atts.custom_css || '');
            if (css) selfContained++;
            if (RAW.test(cls)) {
              // Which computed properties do the carried raw classes imply, and are they reproduced?
              const missing = Object.entries(NEED).filter(([k, prop]) => cls.includes(k) && !css.includes(prop + ':'));
              if (missing.length) { flagged++; if (flags.length < 6) flags.push(n.shortcode + '(' + missing.map((m) => m[1]).join(',') + ')'); }
            }
          }
          if (n._items) walk(n._items);
        }
      };
      builderPages.forEach((pg) => walk(pg.builder));
      step(`🛡️ Self-containment guard → ${selfContained} element(s) carry their full computed box in custom_css` + (flagged ? `; ⚠️ ${flagged} still rely on a carried class [${flags.join(', ')}${flagged > flags.length ? '…' : ''}]` : `; no dropped classes`));
    }

    const report = toReport({ url: srcUrl, generated: 'design-capture', pages: reportPages });
    // Style-coverage report (CSS-fidelity): which source styles the carried CSS reproduces vs drops.
    const styleReport = toStyleReport({
      url: srcUrl,
      pages: captures.map((c) => ({
        slug: c.slug,
        sections: (c.capture.sections || []).map((s, i) => ({ index: i, sectionClass: s.sectionClass || '', css: s.css || '', styleCensus: s.styleCensus || {} })),
      })),
    });

    // 5) Media + style guide + presets + mapping.
    const mediaSet = new Set();
    captures.forEach((c) => (c.capture.assets.images || []).forEach((u) => mediaSet.add(u)));
    // Harvest EVERY http(s) url the emitted builder trees reference (scroll-story backdrop frames,
    // slide media_image, …) so the media phase sideloads them and the pages phase rewrites each to
    // its local attachment — nothing the converted page needs stays hotlinked to the source.
    const harvestUrls = (n) => {
      if (Array.isArray(n)) { n.forEach(harvestUrls); return; }
      if (n && typeof n === 'object') {
        for (const [k, v] of Object.entries(n)) {
          if (k === 'url' && typeof v === 'string' && /^https?:\/\//i.test(v)) mediaSet.add(v);
          else harvestUrls(v);
        }
      }
    };
    builderPages.forEach((pg) => harvestUrls(pg.builder));
    const media = { urls: [...mediaSet] };
    const styleguide = { pages: [toStyleGuide(home, config)] };
    const presets = toPresets(config, home, iconBadgeSkins);
    // Make the remaining COMPONENT presets EXPLICIT in Live progress — they were built silently. Background
    // patterns (captured SVG/gradient tiles), icon-badge tile skins, and image styles each get a step; each
    // is emitted ONLY when the source actually has that component (so an absent one just doesn't print).
    {
      const pv = (presets && presets.values) || {};
      const pc = (k) => (Array.isArray(pv[k]) ? pv[k].length : 0);
      if (pc('background_patterns')) step(`  🌐 Background Patterns → ${pc('background_patterns')} pattern(s) captured${patternsAppliedTotal ? `, applied to ${patternsAppliedTotal} section(s)` : ''}`);
      if (pc('icon_badge_presets')) step(`  🔷 Icon Badge Presets → ${pc('icon_badge_presets')} badge tile style(s)`);
      if (pc('image_styles')) step(`  🖼️ Image Styles → ${pc('image_styles')} style(s)`);
      if (dividersAppliedTotal) step(`  〰️ Shape Dividers → applied to ${dividersAppliedTotal} section edge(s)`);
    }
    const mapping = {
      pages: captures.map((c) => ({
        slug: c.slug, front_page: c.front,
        sections: (c.capture.sections || []).map((s, i) => ({
          index: i, sectionClass: s.sectionClass || '', colClass: s.colClass || '', innerWrapClass: s.innerWrapClass || '',
          css: s.css || '', computed: s.computed || {}, assets: s.assets || [],
          raw: s.rawInner || s.rawHtml || '', blocks: s.mapBlocks || [],
        })),
      })),
    };

    // ALWAYS-ON local micro layer (token-free): if a LOCAL model is set up, let it give the sections
    // semantic css_id slugs (+ flag pure-decoration bands) — the "tiny bit on every step" a small model is
    // good at. Non-destructive (only valid slugs; only omits truly-empty bands) and best-effort: any error
    // leaves the deterministic mapping unchanged. Visible in Live progress + the dashboard AI indicator.
    try {
      // `ollama` often isn't on PATH (it runs as a background server), so warm the up-probe first — else
      // ollamaReady()/microBackend() can't tell the local server is live in this fresh CLI process.
      await localAiStatus().catch(() => {});
      if (microBackend() === 'ollama' && selectedLocalModel()) {
        step(`🧠 local AI (${selectedLocalModel()}) → naming sections…`);
        writeAiActivity({ status: 'thinking', note: 'naming sections', startedAt: Date.now() });
        const t0 = Date.now();
        const micro = await localSectionMicroTask(mapping);
        const secs = Math.round((Date.now() - t0) / 1000);
        if (micro && (micro.renamed || micro.decorative)) {
          step(`  local AI → named ${micro.renamed} section${micro.renamed === 1 ? '' : 's'}${micro.decorative ? `, flagged ${micro.decorative} decorative` : ''} (${secs}s)`);
        } else {
          step(`  local AI → sections already well-named (${secs}s)`);
        }
        writeAiActivity({ status: 'done', note: micro ? `named ${micro.renamed} section(s)` : 'no change', elapsed: secs });
      }
    } catch (e) { step('local AI micro pass skipped: ' + e.message); }

    // Report (always written first).
    writeFileSync(`${outdir}/conversion-report.csv`, report.csv);
    writeFileSync(`${outdir}/conversion-report.html`, report.html);
    writeFileSync(`${outdir}/style-coverage.csv`, styleReport.csv);
    writeFileSync(`${outdir}/style-coverage.html`, styleReport.html);
    if (anim) {
      const animRep = animationReport(anim, srcUrl);
      writeFileSync(`${outdir}/animations.json`, JSON.stringify(anim, null, 2));
      writeFileSync(`${outdir}/animation-report.csv`, animRep.csv);
      writeFileSync(`${outdir}/animation-report.html`, animRep.html);
    }
    step('reports → conversion-report + style-coverage + animation-report (csv/html)');

    // CLASS-COVERAGE VERIFICATION (local AI as QA, not author): review the style-coverage GAPS — source
    // styles the carried CSS did NOT reproduce — and flag the visually-significant ones, so a dropped fill /
    // blur / border / shadow is surfaced, never lost silently. Deterministic floor (a truly-visual property
    // is always flagged) + local-AI triage with a terse reason. Best-effort; visible in Live progress.
    let coverageVerifyCsv = '';
    try {
      const covGaps = styleReport.gaps || [];
      if (covGaps.length) {
        const covAi = microBackend() === 'ollama' && !!selectedLocalModel();
        if (covAi) { step(`🔎 local AI (${selectedLocalModel()}) → verifying class coverage…`); writeAiActivity({ status: 'thinking', note: 'verifying class coverage', startedAt: Date.now() }); }
        const ct0 = Date.now();
        const cov = await verifyCoverage(covGaps, {});
        const csecs = Math.round((Date.now() - ct0) / 1000);
        const covHead = 'page,s_index,s_class,property,src_uses,significant,reason';
        const covCsv = [covHead].concat((cov.gaps || []).map((g) =>
          [g.page, g.s_index, g.s_class, g.property, g.uses, g.significant ? 'yes' : 'no', g.reason || '']
            .map((v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(','))).join('\r\n');
        writeFileSync(`${outdir}/coverage-verification.csv`, covCsv);
        coverageVerifyCsv = covCsv;
        if (cov.significant) {
          const secCount = new Set(cov.flagged.map((f) => f.s_index)).size;
          step(`  class coverage → ${cov.significant} significant gap(s) flagged across ${secCount} section(s) (see coverage-verification.csv)${covAi ? ` (${csecs}s)` : ''}`);
          cov.flagged.slice(0, 8).forEach((f) => console.log(`    ⚠ ${f.s_class || f.page} — ${f.property} dropped on ${f.uses} el${f.uses === 1 ? '' : 's'}${f.reason ? ` — ${f.reason}` : ''}`));
        } else {
          step(`  class coverage → no significant gaps (all source styles reproduced)${covAi ? ` (${csecs}s)` : ''}`);
        }
        if (covAi) writeAiActivity({ status: 'done', note: `coverage: ${cov.significant} flagged`, elapsed: csecs });
      }
    } catch (e) { step('class-coverage verification skipped: ' + e.message); }

    // WCAG contrast review of the extracted BRAND palette. We flag low-contrast text/bg
    // pairs + suggest a nearest-AA shade, but NEVER change the user's colors (their brand).
    const contrastFindings = contrastReview(config, presets);
    writeFileSync(`${outdir}/contrast-review.csv`, contrastReviewCsv(contrastFindings));
    if (contrastFindings.length) {
      step(`contrast → ${contrastFindings.length} low-contrast brand pair(s) flagged (see contrast-review.csv — colors NOT changed)`);
      contrastFindings.forEach((f) =>
        console.log(`    ⚠ ${f.label}: ${f.fg} on ${f.bg} = ${f.ratio}:1 (below AA)${f.suggestion ? ' — try ' + f.suggestion : ''}`));
    } else {
      step('contrast → brand palette passes AA (no low-contrast pairs)');
    }

    // Opt-in, anonymized report sharing (structural only — no URL/content/PII). Default OFF: nothing is
    // built or sent unless the developer explicitly passes --share-preview / --share.
    if (SHARE_PREVIEW) {
      const findings = (() => {
        for (const p of [FINDINGS_PATH, `${outdir}/share-findings.json`, `${baseOutdir}/share-findings.json`, 'share-findings.json'].filter(Boolean)) {
          try { const j = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(j) ? j : (j.findings || []); } catch { /* try next */ }
        }
        return [];
      })();
      const sanitized = sanitizeReport({ input: { url: srcUrl, pages: reportPages }, stats: report.stats, converterVersion: PKG_VERSION, findings });
      writeFileSync(`${outdir}/share-report.json`, JSON.stringify(sanitized, null, 2));
      step(`share: wrote anonymized share-report.json (structural only — no URLs/content${sanitized.findings.length ? `; ${sanitized.findings.length} agent-finding(s)` : ''}) — inspect before sending`);
      if (SHARE) {
        const cfg = loadShareConfig(SCRIPT_DIR);
        if (cfg.form && cfg.form.responseUrl) {
          try {
            const r = await postToForm(sanitized, cfg);
            step(r.ok ? 'share: submitted upstream via Google Form ✓ — thank you' : `share: Form POST failed (status ${r.status}); use the mailto draft instead:`);
            if (!r.ok) console.log('   ', buildMailto(sanitized, cfg));
          } catch (e) {
            step('share: could not reach the Google Form (' + e.message + '); use the mailto draft instead:');
            console.log('   ', buildMailto(sanitized, cfg));
          }
        } else {
          step('share: no Google Form configured yet (copy share-config.example.json → share-config.json). Email it instead:');
          console.log('   ', buildMailto(sanitized, cfg));
        }
      }
    }

    if (reportOnly) {
      step('--report-only: skipped bundle, intermediate JSONs & screenshot');
    } else {
      step('writing files & bundle…');
      writeFileSync(`${outdir}/design-capture.json`, JSON.stringify(home, null, 2));
      if (home.renderedHtml) { writeFileSync(`${outdir}/rendered.html`, home.renderedHtml); }
      // BLOCK-THEME target — additionally emit a portable FSE block-theme bundle the plugin installs
      // via FW_Site_Converter_Blocks::install_block_theme(). Additive: never affects the classic bundle.
      if (TARGET === 'block-theme') {
        try {
          const bundle = toBlockBundle(home, { name: home.title || (home.header && home.header.logo && home.header.logo.text) || 'Converted Site', vocabulary: VOCAB });
          writeFileSync(`${outdir}/block-bundle.json`, JSON.stringify(bundle, null, 2));
          step(`block-theme target: wrote block-bundle.json (${Object.keys(bundle.theme.files).length} theme files, vocab=${VOCAB})`);
        } catch (e) { step('block-bundle.json skipped: ' + (e && e.message)); }
      }
      writeFileSync(`${outdir}/mapping.json`, JSON.stringify(mapping, null, 2));
      const specSlug = (cls, idx) => {
        const first = (cls || '').split(/\s+/).find((c) => c && !/^(sc-mirror|section|wrapper|block|area|inner|content|main|elementor|d-|align-|justify-|text-|p[xytrbl]?-|m[xytrbl]?-|g-|container|row|col|w-|h-|bg-|position-|overflow-|order-)/.test(c));
        return ((first || ('section-' + (idx + 1))).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')) || ('section-' + (idx + 1));
      };
      let spec = `# Conversion spec — ${srcUrl}\n`;
      mapping.pages.forEach((pg) => {
        spec += `\n## Page: ${pg.slug}${pg.front_page ? ' (home)' : ''} — ${pg.sections.length} section(s)\n`;
        pg.sections.forEach((sc, i) => {
          spec += `\n### Section ${i + 1} — \`${sc.sectionClass || '(no class)'}\`  ·  id: \`${specSlug(sc.sectionClass, i)}\`\n`;
          const look = Object.keys(sc.computed || {}).map((k) => `${k}: ${sc.computed[k]}`).join('; ');
          if (look) spec += `- **Look:** ${look}\n`;
          if ((sc.assets || []).length) spec += `- **Assets (${sc.assets.length}):** ${sc.assets.slice(0, 12).join(', ')}${sc.assets.length > 12 ? ', …' : ''}\n`;
          spec += `- **Elements (${(sc.blocks || []).length}):**\n`;
          (sc.blocks || []).forEach((b) => {
            const label = b.t === 'row'
              ? `row — ${(b.cols || []).length} columns [${(b.cols || []).map((c) => c.width).join(', ')}]`
              : (b.tag ? `<${b.tag}> ` : '') + (b.text || b.label || (b.html || '').replace(/\s+/g, ' ')).slice(0, 80);
            spec += `  - \`${b.t}\` ${label}\n`;
          });
          if (sc.css) spec += `- **Matched CSS:** ${Math.round((sc.css.length / 1024) * 10) / 10} KB\n`;
        });
      });
      writeFileSync(`${outdir}/spec.md`, spec);
      writeFileSync(`${outdir}/design-config.json`, JSON.stringify(config, null, 2));
      writeFileSync(`${outdir}/pages.json`, JSON.stringify(pages, null, 2));
      writeFileSync(`${outdir}/styleguide.json`, JSON.stringify(styleguide, null, 2));
      writeFileSync(`${outdir}/media.json`, JSON.stringify(media, null, 2));
      writeFileSync(`${outdir}/presets.json`, JSON.stringify(presets, null, 2));
      writeFileSync(`${outdir}/theme-settings.json`, JSON.stringify(themeSettings, null, 2));
      // WordPress theme screenshot (1200×900, the WP-standard 4:3): the source's above-the-fold at the
      // exact WP dimension, carried in the bundle so the generated child theme gets a REAL thumbnail in
      // Appearance → Themes instead of a blank tile. Viewport-only screenshot at 1200×900 = no resize/crop.
      let screenshotBuf = null;
      try {
        await page.setViewportSize({ width: 1200, height: 900 });
        await page.goto(srcUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(400);
        screenshotBuf = await page.screenshot({ type: 'png' }); // viewport-only → exactly 1200×900
        writeFileSync(`${outdir}/screenshot.png`, screenshotBuf);
        step('saved WordPress theme screenshot (1200×900) → screenshot.png');
      } catch { screenshotBuf = null; }

      // MEGA MENUS (JS-path parity) — carry the detected mega structure in the bundle so the importer
      // creates the WP menu hierarchy + activates the Mega Menu extension. Previously only the PHP converter
      // emitted mega-menus.json, so capture-service conversions silently dropped the mega menu on import.
      if (Array.isArray(home.megaMenus) && home.megaMenus.length) {
        config.mega_menus = home.megaMenus; // theme-design.json (theme-download bootstrap reads this)
        writeFileSync(`${outdir}/mega-menus.json`, JSON.stringify({ menus: home.megaMenus }, null, 2));
      }
      const bundleFiles = [
        // `converter:'deterministic'` + the bundled rendered.html let WP RE-RUN the (better, maintained)
        // PHP build_from_html on the captured DOM instead of importing this JS pages.json — closing the
        // JS↔PHP divergence so a deterministic conversion never loses elements the PHP engine would keep.
        { name: 'bundle.json', data: JSON.stringify({ name: config.theme.name, source: srcUrl, generated: 'design-capture', converter: 'deterministic', pages: builderPages.length }, null, 2) },
        { name: 'media.json', data: JSON.stringify(media, null, 2) },
        { name: 'theme-design.json', data: JSON.stringify(config, null, 2) },
        { name: 'theme-settings.json', data: JSON.stringify(themeSettings, null, 2) },
        { name: 'styleguide.json', data: JSON.stringify(styleguide, null, 2) },
        { name: 'presets.json', data: JSON.stringify(presets, null, 2) },
        { name: 'mapping.json', data: JSON.stringify(mapping, null, 2) },
        { name: 'pages.json', data: JSON.stringify(pages, null, 2) },
        { name: 'conversion-report.csv', data: report.csv },
        { name: 'conversion-report.html', data: report.html },
        { name: 'style-coverage.csv', data: styleReport.csv },
        { name: 'style-coverage.html', data: styleReport.html },
        ...(coverageVerifyCsv ? [{ name: 'coverage-verification.csv', data: coverageVerifyCsv }] : []),
      ];
      // The captured DOM with computed styles (data-sc-cs) — so WP can re-run the PHP build_from_html
      // deterministic converter on it (see bundle.json converter:'deterministic' above).
      if (home.renderedHtml) { bundleFiles.push({ name: 'rendered.html', data: home.renderedHtml }); }
      if (screenshotBuf) { bundleFiles.push({ name: 'screenshot.png', data: screenshotBuf }); }
      if (Array.isArray(home.megaMenus) && home.megaMenus.length) { bundleFiles.push({ name: 'mega-menus.json', data: JSON.stringify({ menus: home.megaMenus }, null, 2) }); }
      const bundleZip = makeZip(bundleFiles);
      writeFileSync(`${outdir}/convert-bundle.zip`, bundleZip);
      step('saving full-page screenshot…');
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(srcUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await page.screenshot({ path: `${outdir}/full.png`, fullPage: true }).catch(() => {});
    }

    console.log('  captured →', outdir);
    console.log('  ', `theme: heading=${config.fonts.heading || '?'} | body=${config.fonts.body || '?'} | accent=${config.colors.accent || '?'}`);
    console.log('  ', `report: ${report.stats.elements} elements | ${report.stats.fallbacks} code_block fallbacks | ${report.stats.opportunities} opportunities | ${report.stats.stylingDrops} styling-drops | ${report.stats.overLargeSections} over-large`);
    console.log('  ', `style-coverage: ${styleReport.stats.fidelityScore}% (carried/used across ${styleReport.stats.sections} sections)`);
    progressDone('done', { summary: { ...report.stats, fidelityScore: styleReport.stats.fidelityScore, headingFont: config.fonts.heading, bodyFont: config.fonts.body } });
    return report.stats;
  } finally {
    await page.close().catch(() => {});
  }
}

// --- Queue: run each URL sequentially in one Chrome -------------------------
console.log(`▶ capturing ${urls.length} site(s) → ${baseOutdir}/${REPORT_ONLY ? '  (--report-only)' : ''}`);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
// HARD CAP per capture. The queue's catch handles a stage that THROWS, but not one that HANGS (an await
// that never resolves) — that would freeze `await captureOne` and leave the live progress stuck on its last
// step forever. This watchdog guarantees every capture terminates: on timeout the race rejects, the catch
// marks progress `error`, and the queue moves on. Generous so a legitimately slow real site still finishes;
// overridable via CAPTURE_TIMEOUT_MS. As rules are added this is the single guarantee that a new stage can
// never permanently break the live progress.
const CAPTURE_TIMEOUT_MS = Math.max(60000, Number(process.env.CAPTURE_TIMEOUT_MS) || 300000);
for (let i = 0; i < urls.length; i++) {
  const u = urls[i];
  console.log(`\n========== [${i + 1}/${urls.length}] ${u} ==========`);
  try {
    let watchdog;
    const timeout = new Promise((_, rej) => { watchdog = setTimeout(() => rej(new Error(`capture exceeded ${Math.round(CAPTURE_TIMEOUT_MS / 1000)}s watchdog — aborted so the live progress never hangs`)), CAPTURE_TIMEOUT_MS); if (watchdog && watchdog.unref) watchdog.unref(); });
    let stats;
    try { stats = await Promise.race([captureOne(browser, u, baseOutdir, REPORT_ONLY), timeout]); }
    finally { clearTimeout(watchdog); }
    results.push({ url: u, ok: true, stats });
  } catch (e) {
    const od = `${baseOutdir}/${siteSlug(u)}`;
    try { mkdirSync(od, { recursive: true }); writeFileSync(`${od}/error.txt`, `Capture failed for ${u}\n\n${(e && e.stack) || e}\n`); } catch { /* ignore */ }
    // Ensure a progress object exists even if the failure happened before progressInit, so the dashboard
    // always transitions off `running` (never polls a stale state) rather than being left with no update.
    if (!_progress) { try { progressInit(siteSlug(u), u, baseOutdir); } catch { /* best-effort */ } }
    progressDone('error', { error: (e && e.message) || String(e) });
    console.error(`  ✖ FAILED: ${(e && e.message) || e}  → wrote ${od}/error.txt`);
    results.push({ url: u, ok: false, err: (e && e.message) || String(e) });
  }
}
await browser.close();

const okCount = results.filter((r) => r.ok).length;
console.log(`\n========== queue done: ${okCount}/${results.length} ok ==========`);
for (const r of results) {
  console.log(r.ok
    ? `  ✓ ${r.url}  (${r.stats.elements} el, ${r.stats.fallbacks} fb, ${r.stats.opportunities} opp)`
    : `  ✖ ${r.url}  — ${r.err}`);
}
if (okCount < results.length) { process.exitCode = 1; }
