/**
 * UnysonPlus — Verbatim SITE MIRROR ("Duplicate as landing page").
 *
 * Loads a page in a real browser, RECORDS EVERY network response it fetches (scripts, ES modules,
 * three.js, textures, GLB models, fonts, XHR — the JS-loaded assets a static HTML copy misses),
 * saves them under <outdir>/assets/, rewrites every reference (HTML attrs, srcset, inline styles,
 * <style> blocks, and url()/import inside the downloaded CSS/JS) to a relative `assets/…` path,
 * and writes a fully self-contained <outdir>/index.html + a manifest.json (url → local path).
 *
 * The result runs identically to the source offline, and the WordPress importer
 * (class-fw-site-converter-landing.php) copies assets/ into uploads and rewrites to the site URLs.
 *
 * Usage: node mirror.mjs <url> <outdir> [--timeout=45000] [--scroll]
 */
import { chromium } from 'playwright-core';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const pos = args.filter((a) => !a.startsWith('--'));
const URL_IN = pos[0];
const OUT = pos[1] || 'mirror-out';
const TIMEOUT = Number((flags.find((f) => f.startsWith('--timeout=')) || '').split('=')[1]) || 45000;
if (!URL_IN || !/^https?:\/\//i.test(URL_IN)) {
  console.error('Usage: node mirror.mjs <http(s)-url> <outdir>');
  process.exit(1);
}

const ASSET_DIR = 'assets';
const CONTENT_EXT = {
  'text/html': '.html', 'text/css': '.css', 'application/javascript': '.js', 'text/javascript': '.js',
  'application/json': '.json', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/avif': '.avif', 'font/woff2': '.woff2',
  'font/woff': '.woff', 'font/ttf': '.ttf', 'application/font-woff': '.woff', 'video/mp4': '.mp4',
  'audio/mpeg': '.mp3', 'model/gltf-binary': '.glb', 'model/gltf+json': '.gltf', 'application/wasm': '.wasm',
};

// abs-url -> { local: 'assets/<name>', buffer, ctype }
const assets = new Map();
const seen = new Set();

function safeName(u, ctype) {
  let ext = '';
  try {
    const p = new URL(u).pathname;
    ext = path.extname(p).split('?')[0];
  } catch { /* ignore */ }
  if (!ext && ctype) ext = CONTENT_EXT[(ctype.split(';')[0] || '').trim().toLowerCase()] || '';
  const base = crypto.createHash('sha1').update(u).digest('hex').slice(0, 16);
  // keep a readable stem from the url path for debuggability
  let stem = '';
  try { stem = path.basename(new URL(u).pathname).replace(/[^\w.-]+/g, '-').slice(0, 40).replace(/\.[^.]*$/, ''); } catch {}
  return `${ASSET_DIR}/${stem ? stem + '-' : ''}${base}${ext || ''}`;
}

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  page.on('response', async (resp) => {
    try {
      const req = resp.request();
      const u = resp.url();
      if (!/^https?:/i.test(u)) return;               // skip data:/blob:
      if (req.resourceType() === 'document' && u.replace(/#.*$/, '') === URL_IN.replace(/#.*$/, '')) return; // the page itself
      if (seen.has(u)) return; seen.add(u);
      const status = resp.status();
      if (status >= 300 && status < 400) return;      // redirects: the final URL is recorded separately
      const buf = await resp.body().catch(() => null);
      if (!buf || !buf.length) return;
      const ctype = (resp.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
      assets.set(u, { local: safeName(u, ctype), buffer: buf, ctype });
    } catch { /* asset unreadable (opaque/CORS) — skip */ }
  });

  console.error(`[mirror] loading ${URL_IN} …`);
  await page.goto(URL_IN, { waitUntil: 'load', timeout: TIMEOUT }).catch((e) => console.error('[mirror] goto warn:', e.message));
  // Nudge lazy / scroll-loaded assets: scroll through the page, then settle.
  await page.evaluate(async () => {
    await new Promise((r) => {
      let y = 0; const step = () => {
        y += window.innerHeight * 0.9; window.scrollTo(0, y);
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: window.innerHeight * 0.9 }));
        if (y < document.documentElement.scrollHeight + window.innerHeight * 3) setTimeout(step, 120); else { window.scrollTo(0, 0); r(); }
      }; step();
    });
  }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Rewrite element references to ABSOLUTE urls in the live DOM (element.src/href already resolve
  // absolute), so the serialized HTML carries absolute urls we can map 1:1 to local paths.
  await page.evaluate(() => {
    const abs = (el, attr) => { try { const v = el.getAttribute(attr); if (v && !/^(data:|blob:|#|javascript:)/i.test(v)) el.setAttribute(attr, new URL(v, document.baseURI).href); } catch {} };
    document.querySelectorAll('[src]').forEach((el) => abs(el, 'src'));
    document.querySelectorAll('[href]').forEach((el) => abs(el, 'href'));
    document.querySelectorAll('[poster]').forEach((el) => abs(el, 'poster'));
    document.querySelectorAll('[data-src]').forEach((el) => abs(el, 'data-src'));
    document.querySelectorAll('source[srcset], img[srcset]').forEach((el) => {
      try { el.setAttribute('srcset', (el.getAttribute('srcset') || '').split(',').map((p) => { const s = p.trim().split(/\s+/); if (s[0] && !/^(data:|blob:)/i.test(s[0])) s[0] = new URL(s[0], document.baseURI).href; return s.join(' '); }).join(', ')); } catch {}
    });
    // strip capture-only attrs if present
    document.querySelectorAll('[data-sc-cs],[data-sc-col],[data-sc-hover]').forEach((el) => { el.removeAttribute('data-sc-cs'); el.removeAttribute('data-sc-col'); el.removeAttribute('data-sc-hover'); });
  }).catch(() => {});

  let html = await page.content();
  const pageUrl = page.url();
  await browser.close();

  // --- Write assets + build the url→local map. Rewrite url()/import inside CSS & JS text assets. ---
  await fs.mkdir(path.join(OUT, ASSET_DIR), { recursive: true });
  const map = {};                       // abs url -> local path
  for (const [u, a] of assets) map[u] = a.local;

  // Rewrite every known-asset reference in a blob of text (CSS url(), JS import/from '…', fetch('…')).
  // `toLocal(absUrl)` returns the correct path for the CONTEXT: for index.html (at the mirror root) that's
  // the full `assets/…` path; for a file that itself lives in assets/ it's a sibling `./name`.
  const rewriteText = (text, baseUrl, toLocal) => {
    let out = text;
    // (a) url(...) / import '…' / from '…' — the delimited content IS a URL; match it broadly (incl. BARE
    //     relative paths like `inner-green-assets/x.woff2` that have no ./ or / prefix).
    out = out.replace(/(url\(\s*['"]?|\bfrom\s+['"]|\bimport\s+['"])([^'")]+?)(['"]?\s*\)|['"])/g, (m, pre, ref, post) => {
      ref = ref.trim(); if (!ref || /^(data:|blob:|#|https?:\/\/fonts\.gstatic)/i.test(ref)) { /* keep */ }
      if (!ref || /^(data:|blob:|#)/i.test(ref)) return m;
      let abs; try { abs = new URL(ref, baseUrl).href; } catch { return m; }
      return map[abs] ? pre + toLocal(abs) + post : m;
    });
    // (b) generic quoted string literals (JS) — only scheme/slash/dot-slash refs, to avoid matching prose.
    out = out.replace(/(['"])((?:https?:)?\/\/[^'"]+|\.{1,2}\/[^'"]+|\/[^'"]+)(['"])/g, (m, q1, ref, q2) => {
      if (/^(data:|blob:|#)/i.test(ref)) return m;
      let abs; try { abs = new URL(ref, baseUrl).href; } catch { return m; }
      return map[abs] ? q1 + toLocal(abs) + q2 : m;
    });
    return out;
  };
  const toRoot  = (absUrl) => map[absUrl] || absUrl;                       // for index.html (mirror root)
  const toSibl  = (absUrl) => (map[absUrl] ? './' + path.basename(map[absUrl]) : absUrl); // within assets/

  for (const [u, a] of assets) {
    let buf = a.buffer;
    if (a.ctype === 'text/css' || a.ctype === 'application/javascript' || a.ctype === 'text/javascript') {
      buf = Buffer.from(rewriteText(buf.toString('utf8'), u, toSibl), 'utf8');
    }
    await fs.writeFile(path.join(OUT, a.local), buf);
  }

  // --- Rewrite the HTML: absolute asset urls → relative local; inline styles/<style> url() too. ---
  // 1) direct absolute-url replacements (longest first to avoid partial overlaps).
  const urls = Object.keys(map).sort((x, y) => y.length - x.length);
  for (const u of urls) {
    html = html.split(u).join(map[u]);
    // protocol-relative form
    const protoRel = u.replace(/^https?:/i, '');
    if (protoRel !== u) html = html.split(protoRel).join(map[u]);
  }
  // 2) BARE-relative refs left in inline styles / <style> / inline scripts (e.g. a @font-face
  //    url(inner-green-assets/x.woff2)) → resolve against the page url and map to the local asset.
  html = rewriteText(html, pageUrl, toRoot);

  await fs.writeFile(path.join(OUT, 'index.html'), html, 'utf8');
  await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify({ source: URL_IN, generated: Date.now(), assetDir: ASSET_DIR, assets: map }, null, 2), 'utf8');

  console.error(`[mirror] done → ${OUT}  (${assets.size} assets, index.html ${(html.length / 1024) | 0} KB)`);
  console.log(JSON.stringify({ ok: true, out: OUT, assets: assets.size, html: 'index.html' }));
})().catch((e) => { console.error('[mirror] ERROR', e && e.stack || e); process.exit(1); });
