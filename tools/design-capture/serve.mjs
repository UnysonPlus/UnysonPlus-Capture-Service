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
//   GET  /capture-screenshot?url=<url>  → screenshot.png (image/png) for the newest matching capture
//   POST /ai-convert          → { ok, mapping, theme:{style_css,header_html,footer_html}, custom_css }  (Claude authors the child-theme design)
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { aiReady, aiBackend, refineMapping, localAiStatus, setLocalModel, startPull, pullStatus, deleteModel, selectedLocalModel, ensureLocalModelReady, testLocalModel, instructTweak, chatLocalModel } from './to-ai.mjs';
import { translateHeader } from './header-translate.mjs';
import { translateFooter } from './footer-translate.mjs';
import { ensureDashboard } from './dashboard/ensure-open.mjs';
import { verifyUrls } from './verify.mjs';
import { refineVisual } from './refine-visual.mjs';
import { refineChrome } from './refine-chrome.mjs';

// Run log — the Dev Kit launcher sets UPWK_LOG to one file per launch (kept: 5 newest). Mirror every
// console line into it so a whole run (capture service + conversions + AI + errors) lands in ONE file
// you can open and analyze after the fact. No-op when UPWK_LOG is unset (e.g. run standalone).
const UPWK_LOG = process.env.UPWK_LOG || '';
if (UPWK_LOG) {
  const fmt = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  const tee = (tag, orig) => (...args) => {
    orig(...args);
    try { appendFileSync(UPWK_LOG, `[${new Date().toISOString()}] [capture]${tag} ${args.map(fmt).join(' ')}\n`); } catch { /* logging must never break the service */ }
  };
  console.log = tee('', console.log.bind(console));
  console.error = tee(' ERROR', console.error.bind(console));
  console.warn = tee(' WARN', console.warn.bind(console));
}

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
// Durable chat history for the dashboard Chat view — one JSON file under CAPTURE_OUT so a multi-turn
// conversation survives service restarts. Capped so it can't grow unbounded (last CHAT_HISTORY_CAP msgs).
const CHAT_HISTORY_FILE = join(CAPTURE_OUT, 'chat-history.json');
const CHAT_HISTORY_CAP = 200;
function readChatHistory() {
  try { const d = JSON.parse(readFileSync(CHAT_HISTORY_FILE, 'utf8')); return Array.isArray(d.messages) ? d.messages : []; } catch { return []; }
}
function writeChatHistory(messages) {
  const arr = (Array.isArray(messages) ? messages : []).slice(-CHAT_HISTORY_CAP);
  try { mkdirSync(CAPTURE_OUT, { recursive: true }); writeFileSync(CHAT_HISTORY_FILE, JSON.stringify({ version: 1, messages: arr }, null, 2)); } catch { /* best-effort */ }
  return arr;
}
function markActive(url, status) {
  try {
    mkdirSync(CAPTURE_OUT, { recursive: true });
    writeFileSync(join(CAPTURE_OUT, '_active.json'), JSON.stringify({ tool: 'capture-service', url: String(url || ''), status, at: Date.now() }));
  } catch { /* best-effort — never block a capture */ }
}
// AI activity for the dashboard: what the AI is doing during an /ai-convert or /refine-visual pass
// (status + backend + model + elapsed). The dashboard renders this as a live, prominent indicator so
// the user actually SEES the local model working. A friendly label maps the backend to a name.
function aiModelLabel() {
  const be = aiBackend();
  if (be === 'ollama') { return selectedLocalModel() || 'local model'; }
  if (be === 'api') { return process.env.ANTHROPIC_MODEL || 'Claude (API)'; }
  if (be === 'claude-code') { return process.env.ANTHROPIC_MODEL || 'Claude Code'; }
  return 'AI';
}
function markAi(obj) {
  const rec = { backend: aiBackend(), model: aiModelLabel(), ...obj, at: Date.now() };
  // Single source of truth for the TERMINAL activity line too: every AI pass prints thinking → done/error
  // here, so the command window visibly shows the (local) model working. Concise — one line each.
  try {
    const be = rec.backend || 'ai';
    const mdl = rec.model || 'AI';
    if (rec.status === 'thinking') { console.log(`[ai] thinking… (${be}/${mdl})${rec.note ? ' — ' + rec.note : ''}`); }
    else if (rec.status === 'done') { console.log(`[ai] done via ${mdl}${rec.elapsed != null ? ' (' + rec.elapsed + 's)' : ''}${rec.note ? ' — ' + rec.note : ''}`); }
    else if (rec.status === 'error') { console.error(`[ai] error (${be}/${mdl}): ${rec.error || 'unknown'}`); }
  } catch { /* logging must never break the service */ }
  try {
    mkdirSync(CAPTURE_OUT, { recursive: true });
    writeFileSync(join(CAPTURE_OUT, '_ai.json'), JSON.stringify(rec));
  } catch { /* best-effort */ }
}

/**
 * Slice the outermost <header>…</header> (first) or <footer>…</footer> (last) region out of a rendered
 * page, matching balanced open/close tags of the same name so a nested <header> inside doesn't cut it
 * short. Returns '' when the tag isn't present. Used by /translate-chrome to feed each region to its
 * translator, so the model sees only the chrome markup (+ its data-sc-cs computed styles), not the body.
 */
function sliceChromeRegion(html, tag, last) {
  const src = String(html || '');
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
  // Collect every open + close position, then walk them as a balanced stack to find full regions.
  const events = [];
  let m;
  while ((m = openRe.exec(src))) events.push({ i: m.index, end: openRe.lastIndex, open: true });
  while ((m = closeRe.exec(src))) events.push({ i: m.index, end: closeRe.lastIndex, open: false });
  events.sort((a, b) => a.i - b.i);
  const regions = [];
  let depth = 0, start = -1;
  for (const e of events) {
    if (e.open) { if (depth === 0) start = e.i; depth++; }
    else if (depth > 0) { depth--; if (depth === 0 && start >= 0) { regions.push(src.slice(start, e.end)); start = -1; } }
  }
  if (!regions.length) return '';
  return last ? regions[regions.length - 1] : regions[0];
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
/**
 * Slug for a URL's capture subfolder — MUST match capture.mjs's siteSlug() so /capture-screenshot
 * finds the dir that /capture wrote. hostname (sans www) + path, non-alphanumerics → '_'.
 */
const siteSlug = (u) => {
  try {
    const url = new URL(u);
    let s = url.hostname.replace(/^www\./i, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (path) s += '_' + path.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
    return s || 'site';
  } catch { return 'site'; }
};

const findFile = (out, name) => {
  const direct = join(out, name);
  if (existsSync(direct)) return direct;
  // Newest matching subfolder — since captures now share CAPTURE_OUT, pick the most-recently-written run.
  let best = '', bestT = -1;
  try {
    for (const e of readdirSync(out, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(out, e.name, name);
      if (existsSync(p)) { const t = statSync(p).mtimeMs; if (t > bestT) { bestT = t; best = p; } }
    }
  } catch { /* unreadable dir — no match */ }
  return best;
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

  // POST /ai-instruct — USER-DIRECTED tweak. The user types an instruction ("make the hero darker",
  // "bigger rounder buttons", "turn this into a real pricing table"); the model classifies it and returns
  // { kind:'css'|'structural'|'both', css, structural_note, explanation, model }. CSS is sanitized in
  // to-ai.mjs (the trust boundary) before it leaves. Structural changes are NEVER auto-applied — only
  // described. Body: { prompt (required), page_html?, custom_css?, source_html? }.
  if (u.pathname === '/ai-instruct') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    if (!aiReady()) { json(res, 503, { error: 'AI is off — pick a local model, or enable Claude (Claude Code / an API key).' }); return; }
    const _aiStart = Date.now();
    readJson(req)
      .then((body) => {
        if (!String(body.prompt || '').trim()) { const e = new Error('Provide a prompt.'); e.code = 400; throw e; }
        markAi({ status: 'thinking', backend: aiBackend(), note: 'working on your request…', startedAt: _aiStart });
        return instructTweak({ prompt: body.prompt, pageHtml: body.page_html, customCss: body.custom_css, sourceHtml: body.source_html });
      })
      .then((out) => { markAi({ status: 'done', backend: aiBackend(), model: out.model, startedAt: _aiStart, elapsed: Math.round((Date.now() - _aiStart) / 1000), note: `instruct → ${out.kind}` }); console.log('[ai-instruct]', out.kind, 'via', out.model); json(res, 200, { ok: true, kind: out.kind, css: out.css, structural_note: out.structural_note, explanation: out.explanation, model: out.model }); })
      .catch((e) => { const code = e.code === 400 ? 400 : (e.code === 503 ? 503 : 500); if (code === 500) markAi({ status: 'error', backend: aiBackend(), startedAt: _aiStart, error: e.message }); console.error('[ai-instruct]', e.message); json(res, code, { error: e.message }); });
    return;
  }

  // POST /translate-chrome — the NATIVE-chrome path. Given the rendered page HTML, slice out the
  // <header> + <footer> regions and translate EACH into UnysonPlus Header/Footer Theme-Settings JSON
  // (translateHeader / translateFooter). The WordPress Site Converter's applier turns this into native,
  // editable Theme Settings (no baked header.php/footer.php). Header is primary; footer is best-effort.
  // Returns { ok, header:{ok,json,ms}, footer:{ok,json,ms}, model }.
  if (u.pathname === '/translate-chrome') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    if (!aiReady()) { json(res, 503, { error: 'AI is off — configure Claude Code / an API key, or pick a local model.' }); return; }
    const model = selectedLocalModel() || 'claude-code'; // Ollama tag if picked, else the Claude Code CLI
    const _tcStart = Date.now();
    markAi({ status: 'thinking', backend: aiBackend(), note: 'mapping header & footer into native Theme Settings…', startedAt: _tcStart });
    readJson(req)
      .then(async (body) => {
        const html = String(body.html || '');
        if (html.trim() === '') { throw new Error('Provide the rendered page `html`.'); }
        const headerHtml = sliceChromeRegion(html, 'header', false);
        const footerHtml = sliceChromeRegion(html, 'footer', true);
        // Header first (primary), then footer (best-effort). Both share the one AI model.
        const header = headerHtml ? await translateHeader({ headerHtml, model }) : { ok: false, json: null, ms: 0, error: 'No <header> found.' };
        const footer = footerHtml ? await translateFooter({ footerHtml, model }) : { ok: false, json: null, ms: 0, error: 'No <footer> found.' };
        return { header, footer, model };
      })
      .then((out) => { markAi({ status: 'done', backend: aiBackend(), model: out.model, startedAt: _tcStart, elapsed: Math.round((Date.now() - _tcStart) / 1000), note: `chrome mapped — header ${out.header.ok ? 'ok' : 'skip'}, footer ${out.footer.ok ? 'ok' : 'skip'}` }); console.log('[translate-chrome] header', out.header.ok ? 'ok' : 'skip', '| footer', out.footer.ok ? 'ok' : 'skip', 'via', out.model); json(res, 200, { ok: true, ...out }); })
      .catch((e) => { markAi({ status: 'error', backend: aiBackend(), startedAt: _tcStart, error: e.message }); console.error('[translate-chrome]', e.message); json(res, 500, { error: e.message }); });
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

  // POST /local-ai/pull — download a model via Ollama (streamed in the background). GET .../pull-status polls it.
  if (u.pathname === '/local-ai/pull' && req.method === 'POST') {
    readJson(req).then((b) => startPull(b.model)).then((s) => json(res, 200, s)).catch((e) => json(res, 500, { error: e.message }));
    return;
  }
  if (u.pathname === '/local-ai/pull-status' && req.method === 'GET') {
    json(res, 200, pullStatus());
    return;
  }
  // POST /local-ai/delete — remove a pulled model (frees disk).
  if (u.pathname === '/local-ai/delete' && req.method === 'POST') {
    readJson(req)
      .then((b) => deleteModel(b.model))
      .then(() => localAiStatus())
      .then((s) => json(res, 200, s))
      .catch((e) => { console.error('[local-ai/delete]', e.message); json(res, 500, { error: e.message }); });
    return;
  }

  // POST /local-ai/test — run the SELECTED local model on a short prompt (prove it's alive + a command
  // surface). { prompt } → { ok, model, reply, ms }. 503 when no model / Ollama down.
  if (u.pathname === '/local-ai/test' && req.method === 'POST') {
    readJson(req)
      .then((b) => testLocalModel(b.prompt))
      .then((o) => json(res, 200, o))
      .catch((e) => { console.error('[local-ai/test]', e.message); json(res, e.code === 503 ? 503 : 500, { error: e.message }); });
    return;
  }

  // GET /local-ai/chat-history — the persisted multi-turn chat (survives restarts). { messages }.
  if (u.pathname === '/local-ai/chat-history' && req.method === 'GET') {
    json(res, 200, { ok: true, messages: readChatHistory() });
    return;
  }
  // POST /local-ai/chat-clear — wipe the persisted chat. { ok, messages:[] }.
  if (u.pathname === '/local-ai/chat-clear' && req.method === 'POST') {
    writeChatHistory([]);
    json(res, 200, { ok: true, messages: [] });
    return;
  }
  // POST /local-ai/chat — multi-turn chat on the active AI backend. Body: { messages:[{role,content}] }.
  // Runs the model, persists the sent turns + the reply, returns { ok, model, reply, ms }. 503 when AI off.
  if (u.pathname === '/local-ai/chat' && req.method === 'POST') {
    if (!aiReady()) { json(res, 503, { error: 'AI is off — pick a local model in Settings, or enable Claude (Claude Code / an API key).' }); return; }
    const _aiStart = Date.now();
    readJson(req)
      .then((body) => {
        const msgs = (Array.isArray(body.messages) ? body.messages : [])
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
          .map((m) => ({ role: m.role, content: String(m.content) }));
        markAi({ status: 'thinking', backend: aiBackend(), note: 'chatting…', startedAt: _aiStart });
        return chatLocalModel({ messages: msgs }).then((out) => ({ out, msgs }));
      })
      .then(({ out, msgs }) => {
        writeChatHistory(msgs.concat([{ role: 'assistant', content: out.reply, model: out.model, at: Date.now() }]));
        markAi({ status: 'done', backend: aiBackend(), model: out.model, startedAt: _aiStart, elapsed: Math.round((Date.now() - _aiStart) / 1000), note: 'chat reply' });
        console.log('[local-ai/chat] reply via', out.model);
        json(res, 200, { ok: true, model: out.model, reply: out.reply, ms: out.ms });
      })
      .catch((e) => { const code = e.code === 503 ? 503 : (e.code === 400 ? 400 : 500); if (code === 500) markAi({ status: 'error', backend: aiBackend(), startedAt: _aiStart, error: e.message }); console.error('[local-ai/chat]', e.message); json(res, code, { error: e.message }); });
    return;
  }

  // POST /refine-visual — self-verify → AI-fix loop. Measures source-vs-converted drift, asks the AI for
  // CSS to close the gap, re-measures with the CSS injected, and returns it ONLY if drift dropped.
  if (u.pathname === '/refine-visual') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    if (!aiReady()) { json(res, 503, { error: 'AI is off — configure Claude Code / an API key, or pick a local model.' }); return; }
    const _rvStart = Date.now();
    markAi({ status: 'thinking', note: 'improving the look — writing CSS to close the visual gap…', startedAt: _rvStart });
    readJson(req)
      .then((b) => { if (!b.source_url || !b.converted_url) { throw new Error('Provide source_url and converted_url.'); } console.log('[refine-visual]', b.source_url, 'vs', b.converted_url); return refineVisual({ sourceUrl: b.source_url, convertedUrl: b.converted_url, width: b.width || 1440 }); })
      .then((out) => { markAi({ status: 'done', startedAt: _rvStart, elapsed: Math.round((Date.now() - _rvStart) / 1000), note: `visual fix ${out.improved ? 'kept' : 'no gain'} — drift ${out.before_drift_pct}% → ${out.after_drift_pct}%` }); console.log('[refine-visual] drift', out.before_drift_pct + '% ->', out.after_drift_pct + '%', out.improved ? '(kept)' : '(rejected)'); json(res, 200, out); })
      .catch((e) => { markAi({ status: 'error', startedAt: _rvStart, error: e.message }); console.error('[refine-visual]', e.message); json(res, 500, { error: e.message }); });
    return;
  }

  // POST /refine-chrome — the HEADER-FIRST (footer secondary) chrome fidelity pass. Measures header/footer
  // drift between source + converted, asks the AI for CSS scoped to the converted page's REAL chrome
  // selectors, re-measures with it injected, and returns it ONLY if chrome drift dropped.
  if (u.pathname === '/refine-chrome') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    if (!aiReady()) { json(res, 503, { error: 'AI is off — configure Claude Code / an API key, or pick a local model.' }); return; }
    const _rcStart = Date.now();
    markAi({ status: 'thinking', note: 'refining header & footer…', startedAt: _rcStart });
    readJson(req)
      .then((b) => { if (!b.source_url || !b.converted_url) { throw new Error('Provide source_url and converted_url.'); } console.log('[refine-chrome]', b.source_url, 'vs', b.converted_url); return refineChrome({ sourceUrl: b.source_url, convertedUrl: b.converted_url, width: b.width || 1440 }); })
      .then((out) => { markAi({ status: 'done', startedAt: _rcStart, elapsed: Math.round((Date.now() - _rcStart) / 1000), note: `chrome fix ${out.improved ? 'kept' : 'no gain'} — drift ${out.before_chrome_drift_pct}% → ${out.after_chrome_drift_pct}%` }); console.log('[refine-chrome] chrome drift', out.before_chrome_drift_pct + '% ->', out.after_chrome_drift_pct + '%', out.improved ? '(kept)' : '(rejected)'); json(res, 200, out); })
      .catch((e) => { markAi({ status: 'error', startedAt: _rcStart, error: e.message }); console.error('[refine-chrome]', e.message); json(res, 500, { error: e.message }); });
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
      // Capture output into CAPTURE_OUT so it shows LIVE in the dashboard; only the uploaded-file temp is cleaned.
      mkdirSync(CAPTURE_OUT, { recursive: true });
      const out = CAPTURE_OUT;
      console.log('[capture-file]', isZip ? '(zip)' : '(html)', '→', htmlPath);
      markActive('file: ' + (isZip ? 'Stitch .zip' : 'HTML'), 'running'); // surface on the dashboard
      const child = spawn(process.execPath, [CAPTURE, target, out], { stdio: 'inherit' });
      const cleanup = () => { rmSync(srcDir, { recursive: true, force: true }); };
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

  // GET /capture-screenshot?url=<url> — return the PNG thumbnail (1200×900) the newest matching capture
  // saved, so the WordPress admin (URL flow) can attach it to the generated child theme as its
  // Appearance → Themes screenshot. Prefers <CAPTURE_OUT>/<slug>/screenshot.png (falls back to full.png);
  // if the exact slug dir has none, falls back to the newest screenshot.png anywhere under CAPTURE_OUT.
  if (u.pathname === '/capture-screenshot') {
    const target = (u.searchParams.get('url') || '').trim();
    if (!/^https?:\/\//i.test(target)) { json(res, 400, { error: 'Provide a valid http(s) URL.' }); return; }
    const slug = siteSlug(target);
    let shot = '';
    for (const name of ['screenshot.png', 'full.png']) {
      const p = join(CAPTURE_OUT, slug, name);
      if (existsSync(p)) { shot = p; break; }
    }
    if (!shot) { shot = findFile(CAPTURE_OUT, 'screenshot.png') || findFile(CAPTURE_OUT, 'full.png'); }
    if (!shot || !existsSync(shot)) { json(res, 404, { error: 'No screenshot found for that URL. Run a capture first.' }); return; }
    try {
      const png = readFileSync(shot);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
      res.end(png);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (u.pathname === '/capture') {
    const target = (u.searchParams.get('url') || '').trim();
    if (!/^https?:\/\//i.test(target)) { json(res, 400, { error: 'Provide a valid http(s) URL.' }); return; }

    // Write into CAPTURE_OUT (not a throwaway temp dir) so the run shows up LIVE in the dashboard
    // (progress + history). capture.mjs makes its own per-site subfolder under here.
    mkdirSync(CAPTURE_OUT, { recursive: true });
    const out = CAPTURE_OUT;
    console.log('[capture]', target);
    markActive(target, 'running'); // surface this service-driven run on the dashboard
    const child = spawn(process.execPath, [CAPTURE, target, out], { stdio: 'inherit' });

    child.on('error', (e) => { markActive(target, 'error'); json(res, 500, { error: e.message }); });
    child.on('exit', () => {
      markActive(target, 'done');
      // ?html=1 → return the RENDERED HTML so WordPress can run it through the PHP styling engine.
      if (u.searchParams.get('html') === '1') {
        const html = readRenderedHtml(out);
        if (html) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
          res.end(html);
        } else { json(res, 500, { error: 'Render produced no HTML.' }); }
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
    });
    return;
  }

  json(res, 404, { error: 'not found' });
}).listen(PORT, () => {
  ensureDashboard(); // starting the capture service is "using the converter" → open the live dashboard (localhost:4600)
  console.log(`UnysonPlus capture service v${VERSION} → http://localhost:${PORT}`);
  console.log('  GET  /health');
  console.log('  GET  /capture?url=https://example.com  → convert-bundle.zip');
  console.log('  GET  /capture-screenshot?url=https://example.com  → screenshot.png');
  console.log('  POST /capture-file  (Stitch .zip / HTML body)  → convert-bundle.zip');
  // Resolved-AI line — prints the backend + model actually in play. Runs AFTER the local-AI auto-setup
  // (auto-select a pulled model / kick off a first-run pull) so it reflects the post-setup state.
  const printAiLine = () => {
    const be = aiBackend();
    const line = be === 'ollama' ? `AI: local (${selectedLocalModel()})`
      : be === 'api' ? 'AI: Anthropic API'
      : be === 'claude-code' ? 'AI: Claude Code'
      : 'AI: OFF — open the dashboard → Local AI to enable';
    console.log('  ' + line);
  };
  const autoOff = /^(0|false|no|off)$/i.test(process.env.LOCAL_AI_AUTOSETUP || '');
  (autoOff ? Promise.resolve() : ensureLocalModelReady().catch(() => {})).then(printAiLine).catch(() => {});
  // One-time update check on startup (offline-safe); print a hint if a newer version is on GitHub.
  checkLatest(true).then(() => {
    if (updateAvailable()) { console.log(`  ⬆ Update available: v${latestVersion} (you have v${VERSION}). Run:  git pull && npm install`); }
  });
});
}
