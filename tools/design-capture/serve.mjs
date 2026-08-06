#!/usr/bin/env node
// Local capture service for the Site Converter's "Site Analyzer".
//
// Renders a URL in headless Chrome (by running capture.mjs) and returns a ready
// Convert bundle .zip, so the WordPress admin page can convert a site by URL in one
// click. The WP admin page runs in YOUR browser on YOUR machine, so it can reach this
// localhost service even though the (remote) WP server cannot — no hosting needed.
//
//   npm install         # once (playwright-core)
//   node serve.mjs      # listens on http://localhost:8787
//   PORT=9000 node serve.mjs
//
// Endpoints (CORS-open + Private-Network-Access friendly, so an https WP admin page
// can fetch from http://localhost):
//   GET  /health             → { ok, service, version, aiReady }
//   GET  /capture?url=<url>   → convert-bundle.zip (application/zip)
//   POST /ai-convert          → { ok, mapping, theme:{style_css,header_html,footer_html}, custom_css }  (Claude authors the child-theme design)
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { aiReady, aiBackend, refineMapping, localAiStatus, setLocalModel } from './to-ai.mjs';
import { ensureDashboard } from './dashboard/ensure-open.mjs';
import { verifyUrls } from './verify.mjs';

const PORT = Number(process.env.PORT) || 8787;
const SELF_DIR = fileURLToPath(new URL('.', import.meta.url));
const CAPTURE = fileURLToPath(new URL('./capture.mjs', import.meta.url));
const IS_WIN = process.platform === 'win32';
// Version = the single source of truth in package.json (no hard-coded duplicate to drift).
const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })();

// Shared capture-out dir the live dashboard (http://localhost:4600) watches. serve.mjs writes a
// top-level _active.json here whenever a capture runs, so the dashboard reflects service-driven
// conversions too (its own captures build in a throwaway temp dir). Matches the dashboard default.
const CAPTURE_OUT = process.env.CAPTURE_OUT || 'D:/Web Dev/capture-out';
function markActive(url, status) {
  try {
    mkdirSync(CAPTURE_OUT, { recursive: true });
    writeFileSync(join(CAPTURE_OUT, '_active.json'), JSON.stringify({ tool: 'capture-service', url: String(url || ''), status, at: Date.now() }));
  } catch { /* best-effort — never block a capture */ }
}
// AI activity for the dashboard: what Claude is doing during an /ai-convert refine (status + backend + elapsed).
function markAi(obj) {
  try { mkdirSync(CAPTURE_OUT, { recursive: true }); writeFileSync(join(CAPTURE_OUT, '_ai.json'), JSON.stringify({ ...obj, at: Date.now() })); } catch { /* best-effort */ }
}

/* ----------------------------------------------------------------------------
 * Update check — compare this copy against the package.json on GitHub.
 * Offline-safe: any failure leaves `latestVersion` null and is ignored, so a
 * localhost/offline user is never blocked. (Notify only — does NOT auto-update
 * unless AUTO_UPDATE=1; see maybeAutoUpdate.)
 * -------------------------------------------------------------------------- */
const RAW_PKG = 'https://raw.githubusercontent.com/UnysonPlus/UnysonPlus-Capture-Service/master/tools/design-capture/package.json';
let latestVersion = null;          // newest version seen on GitHub (null = unknown/offline)
let lastChecked = 0;
const CHECK_TTL = 60 * 60 * 1000;  // re-check at most hourly

function semverGt(a, b) {
  const pa = String(a || '').split('.').map(Number), pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}
function updateAvailable() { return latestVersion ? semverGt(latestVersion, VERSION) : false; }
async function checkLatest(force) {
  if (!force && Date.now() - lastChecked < CHECK_TTL) return latestVersion;
  lastChecked = Date.now();
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined;
    const r = await fetch(RAW_PKG, { signal, headers: { 'cache-control': 'no-cache' } });
    if (r.ok) { const j = await r.json(); if (j && j.version) { latestVersion = j.version; } }
  } catch { /* offline / blocked — keep the last known value */ }
  return latestVersion;
}

/* Opt-in self-update: AUTO_UPDATE=1 → `git pull --ff-only` + `npm install`, then re-exec a fresh
 * process. Skips silently if there's no git, no internet, or it isn't a clone. Default = OFF (notify). */
function maybeAutoUpdate() {
  if (!/^(1|true|yes|on)$/i.test(process.env.AUTO_UPDATE || '')) return false;
  try {
    const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: SELF_DIR, encoding: 'utf8', timeout: 30000 });
    const out = (pull.stdout || '') + (pull.stderr || '');
    if (pull.status === 0 && /Fast-forward|Updating /.test(out)) {
      console.log('[update] new version pulled — reinstalling deps + restarting…');
      spawnSync(IS_WIN ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: SELF_DIR, stdio: 'inherit', timeout: 180000 });
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, AUTO_UPDATE: '0' } });
      child.on('exit', (c) => process.exit(c == null ? 0 : c));
      return true; // re-exec'd into a fresh process
    }
  } catch { /* no git / offline / not a clone — skip */ }
  return false;
}

const setCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true'); // Chrome PNA preflight
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

/**
 * Resolve an output file inside a capture's out dir. capture.mjs writes everything into a per-site
 * SUBFOLDER (`<out>/<siteSlug>/…`, see its `outdir = baseDir/siteSlug`), so a flat join(out, name)
 * misses it. Check the base first (legacy / --report-only), then one level of subdirectories.
 */
const findFile = (out, name) => {
  const direct = join(out, name);
  if (existsSync(direct)) return direct;
  try {
    for (const e of readdirSync(out, { withFileTypes: true })) {
      if (e.isDirectory()) { const p = join(out, e.name, name); if (existsSync(p)) return p; }
    }
  } catch { /* unreadable dir — no match */ }
  return '';
};

/**
 * Read the rendered HTML from a finished capture dir. Prefers the loose rendered.html; if that's
 * missing (older builds, or an edge where the page's context died before content() was grabbed),
 * recovers it from design-capture.json's embedded renderedHtml. Returns '' when neither has usable HTML.
 */
const readRenderedHtml = (out) => {
  const htmlOut = findFile(out, 'rendered.html');
  if (htmlOut) { const b = readFileSync(htmlOut); if (b && b.length >= 100) return b; }
  const jsonOut = findFile(out, 'design-capture.json');
  if (jsonOut) {
    try { const h = JSON.parse(readFileSync(jsonOut, 'utf8')).renderedHtml; if (h && h.length >= 100) return Buffer.from(h); } catch { /* unparsable — fall through */ }
  }
  return '';
};

/** Read + JSON-parse a request body (capped). */
const readJson = (req, cap = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
  let buf = '', n = 0;
  req.on('data', (c) => { n += c.length; if (n > cap) { reject(new Error('Body too large.')); req.destroy(); return; } buf += c; });
  req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error('Invalid JSON body.')); } });
  req.on('error', reject);
});

/** Read a raw binary request body (capped) into a Buffer. */
const readBuffer = (req, cap = 32 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > cap) { reject(new Error('Body too large.')); req.destroy(); return; } chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

/**
 * Minimal ZIP reader (STORED + DEFLATE) — enough to pull an exported HTML out of a Stitch / design-tool
 * .zip without a dependency. Walks the End-Of-Central-Directory → central directory → each local entry.
 * Returns { '<name>': Buffer }. Mirrors the writer in minimal-zip.mjs.
 */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('Not a .zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    if (!name.endsWith('/')) {
      try { files[name] = method === 0 ? Buffer.from(comp) : inflateRawSync(comp); } catch { /* skip unreadable entry */ }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

if (maybeAutoUpdate()) {
  // Updated and re-exec'd into a fresh process — leave this one idle until the child exits.
} else {
createServer((req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (u.pathname === '/health') {
    checkLatest(false); // background refresh (cached, hourly); never blocks the response
    json(res, 200, { ok: true, service: 'unysonplus-design-capture', version: VERSION, latest: latestVersion, updateAvailable: updateAvailable(), aiReady: aiReady(), aiBackend: aiBackend() });
    return;
  }

  // POST /ai-convert — refine a draft mapping with Claude (returns a better mapping + custom CSS).
  if (u.pathname === '/ai-convert') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    if (!aiReady()) { json(res, 503, { error: 'AI is off — set ANTHROPIC_API_KEY, or install Claude Code (claude) and sign in, then restart.' }); return; }
    const _aiStart = Date.now();
    markAi({ status: 'thinking', backend: aiBackend(), note: 'refining the section mapping…', startedAt: _aiStart });
    readJson(req)
      .then((body) => refineMapping({ html: body.html, mapping: body.mapping, source: body.source }))
      .then((out) => { markAi({ status: 'done', backend: aiBackend(), model: out.model, startedAt: _aiStart, elapsed: Math.round((Date.now() - _aiStart) / 1000) }); console.log('[ai-convert] refined via', out.model); json(res, 200, { ok: true, mapping: out.mapping, theme: out.theme, custom_css: out.custom_css, model: out.model }); })
      .catch((e) => { markAi({ status: 'error', backend: aiBackend(), startedAt: _aiStart, error: e.message }); console.error('[ai-convert]', e.message); json(res, 500, { error: e.message }); });
    return;
  }

  // GET /local-ai — Experimental local-AI (Ollama) status for the dashboard picker: installed? server up?
  // which models are pulled, the curated shortlist, and the current selection.
  if (u.pathname === '/local-ai' && req.method === 'GET') {
    localAiStatus().then((s) => json(res, 200, s)).catch((e) => json(res, 500, { error: e.message }));
    return;
  }

  // POST /local-ai/select — pick the local model ({ model }). Empty string clears it (back to Claude/off).
  if (u.pathname === '/local-ai/select') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    readJson(req)
      .then((b) => { const m = setLocalModel(b.model); console.log('[local-ai] selected', m || '(none)'); return localAiStatus(); })
      .then((s) => json(res, 200, s))
      .catch((e) => { console.error('[local-ai]', e.message); json(res, 500, { error: e.message }); });
    return;
  }

  // POST /verify — self-verification. Renders source_url + converted_url and pixel-diffs them,
  // returning overall + per-band drift %. The measurement the eventual auto-fallback builds on.
  if (u.pathname === '/verify') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    readJson(req)
      .then((body) => {
        if (!body.source_url || !body.converted_url) { throw new Error('Provide source_url and converted_url.'); }
        console.log('[verify]', body.source_url, 'vs', body.converted_url);
        return verifyUrls({ sourceUrl: body.source_url, convertedUrl: body.converted_url, width: body.width || 1440, bands: body.bands || 8 });
      })
      .then((out) => { console.log('[verify] overall drift', out.overall_drift_pct + '%'); json(res, 200, out); })
      .catch((e) => { console.error('[verify]', e.message); json(res, 500, { error: e.message }); });
    return;
  }

  // POST /capture-file — render an UPLOADED design export (a Stitch .zip or raw HTML) through the SAME
  // engine as /capture, so a file upload gets the full URL-path quality. Body = the raw file bytes; we
  // detect .zip (PK signature) vs HTML, lay the files out in a temp dir (so any relative assets resolve),
  // then point capture.mjs at the local code.html via a proper file:// URL (pathToFileURL handles the
  // Windows drive letter + spaces). The deterministic engine then runs exactly as for a live URL.
  if (u.pathname === '/capture-file') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    readBuffer(req).then((body) => {
      if (!body || !body.length) { throw new Error('Empty upload.'); }
      const srcDir = mkdtempSync(join(tmpdir(), 'sc-src-'));
      const isZip = body.length > 4 && body[0] === 0x50 && body[1] === 0x4b && (body[2] === 0x03 || body[2] === 0x05);
      let htmlPath = '';
      if (isZip) {
        const files = unzip(body);
        let bestScore = Infinity;
        for (const [name, data] of Object.entries(files)) {
          const dest = join(srcDir, name.replace(/\\/g, '/'));
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, data);
          if (/\.html?$/i.test(name)) {
            const score = /(^|\/)(code|index)\.html?$/i.test(name) ? -1 : name.split('/').length; // prefer code/index.html, then shallowest
            if (score < bestScore) { bestScore = score; htmlPath = dest; }
          }
        }
      } else {
        htmlPath = join(srcDir, 'code.html');
        writeFileSync(htmlPath, body);
      }
      if (!htmlPath) { rmSync(srcDir, { recursive: true, force: true }); throw new Error('No HTML file found in the upload.'); }

      const target = pathToFileURL(htmlPath).href;
      const out = mkdtempSync(join(tmpdir(), 'sc-capture-'));
      console.log('[capture-file]', isZip ? '(zip)' : '(html)', '→', htmlPath);
      markActive('file: ' + (isZip ? 'Stitch .zip' : 'HTML'), 'running'); // surface on the dashboard
      const child = spawn(process.execPath, [CAPTURE, target, out], { stdio: 'inherit' });
      const cleanup = () => { rmSync(out, { recursive: true, force: true }); rmSync(srcDir, { recursive: true, force: true }); };
      child.on('error', (e) => { markActive('file', 'error'); json(res, 500, { error: e.message }); cleanup(); });
      child.on('exit', () => {
        markActive('file: ' + (isZip ? 'Stitch .zip' : 'HTML'), 'done');
        // ?html=1 → return the RENDERED HTML so WordPress can run it through the PHP styling engine.
        if (u.searchParams.get('html') === '1') {
          const html = readRenderedHtml(out);
          if (html) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
            res.end(html);
          } else { json(res, 500, { error: 'Render produced no HTML.' }); }
          cleanup();
          return;
        }
        const zipPath = findFile(out, 'convert-bundle.zip');
        if (zipPath) {
          const zip = readFileSync(zipPath);
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="convert-bundle.zip"', 'Content-Length': zip.length });
          res.end(zip);
        } else {
          json(res, 500, { error: 'Capture produced no bundle (the file may have failed to render).' });
        }
        cleanup();
      });
    }).catch((e) => { console.error('[capture-file]', e.message); json(res, 500, { error: e.message }); });
    return;
  }

  if (u.pathname === '/capture') {
    const target = (u.searchParams.get('url') || '').trim();
    if (!/^https?:\/\//i.test(target)) { json(res, 400, { error: 'Provide a valid http(s) URL.' }); return; }

    const out = mkdtempSync(join(tmpdir(), 'sc-capture-'));
    console.log('[capture]', target);
    markActive(target, 'running'); // surface this service-driven run on the dashboard
    const child = spawn(process.execPath, [CAPTURE, target, out], { stdio: 'inherit' });

    child.on('error', (e) => { markActive(target, 'error'); json(res, 500, { error: e.message }); rmSync(out, { recursive: true, force: true }); });
    child.on('exit', () => {
      markActive(target, 'done');
      // ?html=1 → return the RENDERED HTML so WordPress can run it through the PHP styling engine.
      if (u.searchParams.get('html') === '1') {
        const html = readRenderedHtml(out);
        if (html) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
          res.end(html);
        } else { json(res, 500, { error: 'Render produced no HTML.' }); }
        rmSync(out, { recursive: true, force: true });
        return;
      }
      const zipPath = findFile(out, 'convert-bundle.zip');
      if (zipPath) {
        const zip = readFileSync(zipPath);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="convert-bundle.zip"',
          'Content-Length': zip.length,
        });
        res.end(zip);
      } else {
        json(res, 500, { error: 'Capture produced no bundle (the page may have failed to render).' });
      }
      rmSync(out, { recursive: true, force: true });
    });
    return;
  }

  json(res, 404, { error: 'not found' });
}).listen(PORT, () => {
  ensureDashboard(); // starting the capture service is "using the converter" → open the live dashboard (localhost:4600)
  console.log(`UnysonPlus capture service v${VERSION} → http://localhost:${PORT}`);
  console.log('  GET  /health');
  console.log('  GET  /capture?url=https://example.com  → convert-bundle.zip');
  console.log('  POST /capture-file  (Stitch .zip / HTML body)  → convert-bundle.zip');
  const be = aiBackend();
  console.log('  POST /ai-convert  → AI refine  (' + ( be === 'api' ? 'AI ON — Anthropic API key' : be === 'claude-code' ? 'AI ON — Claude Code subscription' : 'AI OFF — set ANTHROPIC_API_KEY, or install + sign in to Claude Code' ) + ')');
  // One-time update check on startup (offline-safe); print a hint if a newer version is on GitHub.
  checkLatest(true).then(() => {
    if (updateAvailable()) { console.log(`  ⬆ Update available: v${latestVersion} (you have v${VERSION}). Run:  git pull && npm install`); }
  });
});
}
