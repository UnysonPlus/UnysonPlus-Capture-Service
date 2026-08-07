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
import { buildBorderPresets } from './box-presets.mjs';
import { makeZip } from './minimal-zip.mjs';
import { extractDesign } from './capture-extract.mjs';
import { toReport } from './to-report.mjs';
import { contrastReview, contrastReviewCsv } from './contrast.mjs';
import { toStyleReport } from './to-style-report.mjs';
import { sanitizeReport, postToForm, buildMailto, loadShareConfig } from './to-share.mjs';
import { traceAnimations, animationReport, extractStoryScenes, stageSectionNode, applyMotionToPage, extractBrandTokens } from './to-animations.mjs';
import { ensureDashboard } from './dashboard/ensure-open.mjs';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
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
const _intList = (name) => { const f = _flags.find((x) => x.startsWith(name + '=')); return f ? f.slice(name.length + 1).split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => !Number.isNaN(n)) : null; };
const SKIP_SECTIONS = _intList('--skip-sections'); // drop these s_index sections
const ONLY_SECTIONS = _intList('--only-sections'); // keep ONLY these s_index sections
// EXCLUSIVE region targeting: run the converter for ONE region and leave the rest of the live site
// untouched on re-import. --only-header / --only-footer reconvert just that chrome part; --only-sections
// reconverts just those body sections (merged into the existing page by index). These set a
// `convert_scope` on the bundle that the importer honours (gate phases + section-merge + chrome-preserve).
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
function progressInit(slug, url, baseDir) {
  _baseDir = baseDir;
  _progress = { slug, url, status: 'running', startedAt: Date.now(), updatedAt: Date.now(), steps: [], summary: null, error: '' };
  progressFlush();
  try { writeFileSync(`${baseDir}/_active.json`, JSON.stringify({ slug, url, status: 'running', startedAt: _progress.startedAt })); } catch { /* best-effort */ }
}
function progressFlush() {
  if (!_progress || !outdir) return;
  try {
    _progress.updatedAt = Date.now();
    writeFileSync(`${outdir}/progress.json`, JSON.stringify(_progress));
  } catch { /* the dir may not exist yet on the very first step */ }
}
function progressDone(status, extra) {
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
    const PROPS = ['background-color','background-image','color','font-family','font-size','font-weight','line-height','letter-spacing','text-align','text-transform','text-decoration-line','padding','margin','border-top-width','border-top-style','border-top-color','border-radius','box-shadow','max-width','display','gap','justify-content','align-items','flex-direction'];
    const skip = { 'background-color':v=>v==='rgba(0, 0, 0, 0)'||v==='transparent', 'background-image':v=>v==='none', 'box-shadow':v=>v==='none', 'max-width':v=>v==='none', 'text-decoration-line':v=>v==='none', 'text-transform':v=>v==='none', 'gap':v=>v==='normal'||v==='0px', 'padding':v=>v==='0px', 'margin':v=>v==='0px', 'border-top-width':v=>v==='0px', 'letter-spacing':v=>v==='normal' };
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
      if (add.length) el.setAttribute('data-sc-cs', add.join(';'));
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
  return { url: target, renderedHtml, ...data };
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
    const reportPages = [];
    const builderPages = captures.map((c) => {
      const trace = [];
      const pg = toPages(c.capture, { trace, fidelity: FIDELITY, buttonPresets: { button_colors: themeSettings.values.button_colors, button_sizes: themeSettings.values.button_sizes } }).pages[0];
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
      const collect = (n) => {
        if (Array.isArray(n)) { n.forEach(collect); return; }
        if (n && typeof n === 'object') {
          if (n.shortcode === 'icon_box' && n.atts && n.atts._box) iconBoxes.push(n);
          // Harvest every icon_box's badge skin (stashed on `_badge`) for the icon_badge_presets
          // clustering below — collect it independently of `_box` so a badge on a card with no box
          // skin is still counted, then drop it.
          if (n.shortcode === 'icon_box' && n.atts && n.atts._badge) { iconBadgeSkins.push(n.atts._badge); delete n.atts._badge; }
          if (n._items) collect(n._items);
        }
      };
      builderPages.forEach((pg) => collect(pg.builder));
      if (iconBoxes.length) {
        const { presets, boxpFor } = buildBorderPresets(iconBoxes.map((n) => n.atts._box));
        let assigned = 0;
        for (const n of iconBoxes) {
          const boxp = boxpFor(n.atts._box);
          if (boxp) { n.atts.box_style = boxp; assigned++; }
          delete n.atts._box;
        }
        // Merge into the theme-settings values so the importer writes the `border_presets` option (the
        // importer REPLACES the option, so this carries the plugin defaults + the derived presets).
        if (themeSettings && themeSettings.values) { themeSettings.values.border_presets = presets; }
        const derivedCount = presets.length - 4; // 4 built-in defaults
        step(`box presets → ${derivedCount} derived skin(s) from ${iconBoxes.length} card(s); box_style set on ${assigned}`);
      }
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

      const bundleFiles = [
        { name: 'bundle.json', data: JSON.stringify({ name: config.theme.name, source: srcUrl, generated: 'design-capture', pages: builderPages.length }, null, 2) },
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
      ];
      if (screenshotBuf) { bundleFiles.push({ name: 'screenshot.png', data: screenshotBuf }); }
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
for (let i = 0; i < urls.length; i++) {
  const u = urls[i];
  console.log(`\n========== [${i + 1}/${urls.length}] ${u} ==========`);
  try {
    const stats = await captureOne(browser, u, baseOutdir, REPORT_ONLY);
    results.push({ url: u, ok: true, stats });
  } catch (e) {
    const od = `${baseOutdir}/${siteSlug(u)}`;
    try { mkdirSync(od, { recursive: true }); writeFileSync(`${od}/error.txt`, `Capture failed for ${u}\n\n${(e && e.stack) || e}\n`); } catch { /* ignore */ }
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
