#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
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
import { randomBytes } from 'node:crypto';
import { discoverPages } from './discover.mjs';
import { verifySite } from './verify-site.mjs';
import { runSiteFixAgent, AGENT_SITES, chatWithTools, kitDocsDir } from './to-ai.mjs';
import { captureSummaryForChat } from './chat-tools.mjs';
import { agentAvailable, agentJob, cancelAgent, restoreSnapshot, startAgent } from './studio-agent.mjs';
import { createProject, listProjects, projectDir, projectLink } from './studio-workspace.mjs';
import { ALL_CHAT_TOOL_DEFS, runChatToolGated, decideProposal, takeHandoff } from './chat-actions.mjs';
import { isLocalSite } from './local-site.mjs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { endpointConfig, setEndpointConfig, listEndpointModels, aiBackends, setPreferredBackend, ENDPOINT_PRESETS, probeEndpointModels, endpointProbe } from './to-ai.mjs';
import { aiReady, aiBackend, refineMapping, localAiStatus, setLocalModel, startPull, pullStatus, deleteModel, selectedLocalModel, ensureLocalModelReady, testLocalModel, instructTweak, chatLocalModel, toolChatLocalModel, runAssistantAgent, normalizeModelRef, importGguf, checkModel, microBackend, localSectionMicroTask, refineAnimations, synthesizePreloaderJs } from './to-ai.mjs';
import { translateHeader } from './header-translate.mjs';
import { studioOriginAllowed, studioAiStatus, studioScene } from './studio-ai.mjs';
import { renderStatus, startRender, jobInfo, jobFile, jobCover, cancelRender } from './studio-render.mjs';
import { transcribeStatus, startInstall, startTranscribe, transcribeJob } from './studio-transcribe.mjs';
import { createReadStream } from 'node:fs';
import { translateFooter } from './footer-translate.mjs';
import { ensureDashboard } from './dashboard/ensure-open.mjs';
import { verifyUrls, verifySections } from './verify.mjs';

/** Background AI Assistant agent runs: id → { rid, status, started, ended?, out?, error? } (kept 30 min). */
const AGENT_JOBS = new Map();
import { refineVisual } from './refine-visual.mjs';
import { refineChrome } from './refine-chrome.mjs';
import { generatePenShortcode } from './pen-shortcode.mjs';
import { namePenOptions } from './to-ai.mjs';
import { makeZip } from './minimal-zip.mjs';

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
const MIRROR = fileURLToPath(new URL('./mirror.mjs', import.meta.url));
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
/* ---- Attachments the person adds to a chat message ---- */
// An image is sent as base64 in the request, but base64 is NOT what gets stored: the bytes are written
// once to `<capture-out>/_chat/`, and the history keeps only a small `{ name, file, mime }` ref. Keeping
// the data inline would blow the 200-message history up to hundreds of megabytes, and the dashboard
// already serves that folder (`/artifact/_chat/<file>`), which is how a tool screenshot is shown too.
const CHAT_IMAGE_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const CHAT_IMAGE_MAX = 8 * 1024 * 1024;   // per image, decoded
const CHAT_IMAGES_PER_MSG = 4;

/**
 * Decode + store the images on one outgoing message. Returns { images, refs }: `images` carry the
 * base64 for the model (plus the on-disk `path`, which Claude Code opens itself), `refs` are what the
 * history keeps. An image that is malformed, too big or of an unsupported type is dropped with a note
 * rather than failing the whole message.
 */
function storeChatImages(list) {
  const images = [], refs = [], skipped = [];
  for (const im of (Array.isArray(list) ? list : []).slice(0, CHAT_IMAGES_PER_MSG)) {
    if (!im || typeof im !== 'object') continue;
    const name = String(im.name || 'image').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'image';
    const mime = String(im.mime || '').toLowerCase();
    const ext = CHAT_IMAGE_MIME[mime];
    if (!ext) { skipped.push(`${name} (${mime || 'unknown type'} is not a supported image)`); continue; }
    // Accept a data: URL as well as bare base64 — a paste gives the browser one of each.
    const b64 = String(im.b64 || im.data || '').replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { buf = null; }
    if (!buf || !buf.length) { skipped.push(`${name} (could not be read)`); continue; }
    if (buf.length > CHAT_IMAGE_MAX) { skipped.push(`${name} (over ${Math.round(CHAT_IMAGE_MAX / 1048576)} MB)`); continue; }
    const file = `upload-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}${ext}`;
    const dir = join(CAPTURE_OUT, '_chat');
    let path = '';
    try { mkdirSync(dir, { recursive: true }); path = join(dir, file); writeFileSync(path, buf); }
    catch { path = ''; }   // the model still gets the bytes; only the saved copy is lost
    images.push({ mime, b64: buf.toString('base64'), name, path });
    refs.push({ name, mime, file, bytes: buf.length });
  }
  return { images, refs, skipped };
}

/* ---- Typed `/commands` in the chat ---- */
// Each one runs a single tool directly (see /local-ai/chat-command). `say` is the line shown above the
// tool's own result panel in the chat, so it states what was done, not what the result was — the panel
// already shows that. `/clear` and `/help` are handled in the dashboard and are not here.
const CHAT_COMMANDS = {
  look: {
    tool: 'look_at_url', needs: 'a URL', example: '/look https://example.com',
    args: (a) => ({ url: /^https?:\/\//i.test(a) ? a : 'https://' + a }),
    say: (a) => `Opened ${a} in the kit's browser.`,
  },
  report: {
    tool: 'conversion_report', needs: '', example: '/report latest',
    args: (a) => ({ site: a || 'latest' }),
    say: (a) => `Conversion report for ${a || 'the latest capture'}.`,
  },
  docs: {
    tool: 'search_docs', needs: 'something to search for', example: '/docs accordion options',
    args: (a) => ({ query: a }),
    say: (a) => `Searched the kit docs for "${a}".`,
  },
  doc: {
    tool: 'read_doc', needs: 'a doc path', example: '/doc shortcodes/accordion.md',
    args: (a) => ({ path: a }),
    say: (a) => `Read ${a}.`,
  },
  status: {
    tool: 'capture_status', needs: '', example: '/status latest',
    args: (a) => ({ site: a || 'latest' }),
    say: (a) => `Capture status for ${a || 'the latest capture'}.`,
  },
  capture: {
    tool: 'start_capture', needs: 'a URL', example: '/capture https://example.com',
    args: (a) => ({ url: /^https?:\/\//i.test(a) ? a : 'https://' + a }),
    say: (a) => `Capturing ${a} needs your Confirm — nothing has started yet.`,
  },
  studio: {
    tool: 'hand_to_studio', needs: 'a description of the scene', example: '/studio a slow logo reveal, 6 seconds',
    args: (a) => ({ request: a }),
    say: () => 'Handing this to Kinetic Scenes needs your Confirm — nothing has been sent yet.',
  },
  projects: {
    tool: 'list_projects', needs: '', example: '/projects',
    args: () => ({}),
    say: () => 'Your Kinetic Scenes projects.',
  },
  work: {
    tool: 'work_on_project', needs: 'a project and a request', example: '/work My reel: make the hook punchier',
    args: (a) => { const i = a.indexOf(':'); return i < 0 ? { project: a, request: '' } : { project: a.slice(0, i).trim(), request: a.slice(i + 1).trim() }; },
    say: (a, r) => (r && r.error ? `Not started: ${r.error}` : `Working on ${a.split(':')[0].trim()} needs your Confirm — nothing has started yet.`),
  },
};

/* ---- The Kit Assistant's environment (chat tools + Phase 3 actions) ---- */
const KINETIC_SCENES_URL = process.env.KINETIC_SCENES_URL || 'https://kinetic-scenes.unysonplus.com/';
const DASH_PORT = Number(process.env.DASHBOARD_PORT || 4600);
function chatOriginOk(req) {
  const o = String(req.headers.origin || '');
  return o === '' || o === `http://localhost:${DASH_PORT}` || o === `http://127.0.0.1:${DASH_PORT}`;
}
/** A capture started from the chat (after the person's Confirm): the Convert tab's run, in the background. */
function startChatCapture(url, o = {}) {
  mkdirSync(CAPTURE_OUT, { recursive: true });
  const args = [CAPTURE, url, CAPTURE_OUT];
  if (o.single_page) args.push('--single-page');
  if (o.max_pages) args.push('--max-pages=' + o.max_pages);
  markActive(url, 'running');
  console.log('[chat] capture confirmed:', url);
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  child.on('error', () => markActive(url, 'error'));
  child.on('exit', (code) => markActive(url, code === 0 ? 'done' : 'error'));
}
/** The Kinetic Scenes agent, for the chat. A finished run is written into the chat's history here, so it survives a closed tab. */
const chatAgent = {
  available: () => agentAvailable(),
  exists: (name) => { try { projectDir(name); return true; } catch { return false; } },
  list: async () => { const r = await listProjects(); return { projects: r.projects.map((p) => ({ name: p.id, title: p.title, seconds: p.duration, updated: new Date(p.updated).toISOString() })) }; },
  start(a) {
    const project = a.new_project ? createProject(a.project).id : a.project;
    const { id, snapshot } = startAgent({ project, prompt: a.request, create: !!a.new_project, url: a.website, voice: a.voice, music: a.music });
    const timer = setInterval(() => {
      const j = agentJob(id);
      if (j && j.state === 'running') return;
      clearInterval(timer);
      const hist = readChatHistory();
      const m = hist.find((x) => x.agentJob && x.agentJob.id === id);
      if (!m || !j) return;
      m.agentJob = { ...m.agentJob, state: j.state, seconds: j.seconds, steps: j.steps.length };
      m.content = j.state === 'done' ? (j.summary || 'Done.') : j.state === 'cancelled' ? 'Stopped. What was already saved stays.' : ('Not finished: ' + j.error);
      writeChatHistory(hist);
    }, 1500);
    return { id, project, snapshot, fresh: !!a.new_project, link: projectLink(project) };
  },
};

function chatEnv() {
  return { captureOut: CAPTURE_OUT, docsDir: kitDocsDir(), siteSlug, startCapture: startChatCapture, studioUrl: KINETIC_SCENES_URL, agent: chatAgent };
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
// (shared with capture.mjs — the ONE definition, so the query-aware slug never drifts between the writer and the reader)
import { siteSlug } from './site-slug.mjs';

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
/**
 * Every page a capture run produced: [{ slug, url, front, html }], newest run under `out`.
 *
 * A multi-page run writes one DOM snapshot per page (pages/<slug>/rendered.html) and lists them in
 * pages-manifest.json. Returning them all lets WordPress convert a SITE in one pass — one capture, one
 * design system, N pages — instead of one request per page, which would re-capture the home page and
 * re-derive the design every time.
 *
 * Returns [] when the run wrote no manifest (a single-page capture), so callers fall back to the
 * single-HTML response that has always been there.
 */
const readCapturedPages = (out) => {
  const manifest = findFile(out, 'pages-manifest.json');
  if (!manifest) return [];
  let list;
  try { list = JSON.parse(readFileSync(manifest, 'utf8')).pages; } catch { return []; }
  if (!Array.isArray(list) || !list.length) return [];
  const root = dirname(manifest);
  const pages = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const rel = String(p.rendered || '').replace(/\\/g, '/');
    // a manifest is data: never let a path in it escape the capture folder
    if (!rel || rel.startsWith('/') || rel.includes('..') || /^[a-z]:/i.test(rel)) continue;
    let html = '';
    try { html = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    if (!html || html.length < 100) continue;
    pages.push({ slug: String(p.slug || ''), url: String(p.url || ''), front: !!p.front, html });
  }
  return pages;
};

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

// ── Pen → template helpers ─────────────────────────────────────────────────────────────────────
// A "pen" is pasted HTML/CSS/JS (a CodePen-style snippet). We ALWAYS convert it into native page-builder
// shortcodes LOCALLY (render + toPages, no WordPress) and hand back a Template Library export envelope the
// user downloads and imports via the builder's Templates → My templates → Import. Native conversion is
// what turns the pen's text into editable text options and its images into swappable image options; any
// markup the recognizers don't map is preserved verbatim in a code_block so nothing is lost.
const penSlug = (title) => 'pen-' + (String(title || 'pen').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pen');
// Sanitize pasted markup: users often copy a WHOLE HTML document. Injecting its <html>/<head>/<body> into
// our own document nests those tags (corrupting the render) and leaks <head> noise (<title>, <meta>,
// stylesheet <link>s) into the page. Keep only the <body>'s inner markup and drop document-level tags.
const stripPenHtml = (html) => {
  let s = String(html || '');
  const bodyM = s.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyM) s = bodyM[1];                                             // full doc → body inner only
  s = s.replace(/<!doctype[^>]*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')                    // any surviving <head>…</head>
    .replace(/<\/?(html|body|head)\b[^>]*>/gi, '')                     // stray html/body/head tags
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<(meta|base)\b[^>]*>/gi, '');
  return s.trim();
};
const assemblePen = (title, html, css, externals) => {
  const links = (externals || []).filter((u) => /\.css($|\?)/i.test(u)).map((u) => `<link rel="stylesheet" href="${String(u).replace(/"/g, '&quot;')}">`).join('');
  // The section extractor keys off <section> elements under <main>. Pens are usually a single <div>
  // component with NO <section>, so the converter would see zero sections and report "no recognizable
  // content". Wrap the markup in a <main><section> band (unless the pen already ships its own sections)
  // so a plain-div component is treated as one convertible section.
  const inner = /<section\b/i.test(String(html)) ? String(html) : `<section class="upw-pen-root">${html}</section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${String(title).replace(/[<>]/g, '')}</title>${links}${String(css).trim() ? `<style>${css}</style>` : ''}</head><body><main>${inner}</main></body>`;
};

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

// THE HUB'S "LAST USED" RECORD. The kit serves three jobs (the Site Converter, the AI Assistant in
// WordPress, Kinetic Scenes); the dashboard's Home page shows each one's state. Being up says
// little on its own, so we note when each job last called in, and from where (a browser's Origin, or the
// site address WordPress puts in its User-Agent). Calls from the dashboard itself carry neither and are
// not counted. In memory only: it resets when the kit restarts.
const hubSeen = {};
function hubCaller(req) {
  const origin = String(req.headers.origin || '');
  if (origin && origin !== 'null') { try { return new URL(origin).host; } catch { return origin; } }
  const m = /^WordPress\/[^;]*;\s*(\S+)/.exec(String(req.headers['user-agent'] || ''));
  if (m) { try { const w = new URL(m[1]); return (w.host + w.pathname).replace(/\/$/, ''); } catch { return m[1]; } }
  return '';
}
function hubNote(req, path) {
  if (req.method === 'OPTIONS' || path === '/health' || path.startsWith('/hub/')) return;
  const from = hubCaller(req);
  let job;
  if (path.startsWith('/studio/')) { if (!studioOriginAllowed(req.headers.origin || '')) return; job = 'studio'; }
  else if (!from) return;
  else if (path === '/mcp-kit' || /^\/local-ai\/(chat|tool-chat|agent)$/.test(path) || path === '/local-ai') job = 'assistant';
  else if (path.startsWith('/local-ai/')) return;
  else job = 'converter';
  // A Studio tab polls its status; that means "open", a scene request means "used".
  const kind = path === '/studio/status' ? 'open' : 'used';
  hubSeen[job] = { ...(hubSeen[job] || {}), [kind]: Date.now(), from: from || (hubSeen[job] && hubSeen[job].from) || '' };
}

if (maybeAutoUpdate()) {
  // Updated and re-exec'd into a fresh process — leave this one idle until the child exits.
} else {
const __handler = (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, `http://localhost:${PORT}`);
  hubNote(req, u.pathname);

  // GET /hub/status: everything the dashboard's Home page shows in one call.
  if (u.pathname === '/hub/status') {
    const _be = aiBackend();
    json(res, 200, {
      ok: true, version: VERSION, latest: latestVersion, updateAvailable: updateAvailable(),
      ai: { ready: aiReady(), backend: _be, model: _be === 'ollama' ? selectedLocalModel() : (_be ? (process.env.ANTHROPIC_MODEL || 'claude') : '') },
      seen: hubSeen,
      now: Date.now(),
    });
    return;
  }

  // PAGE DISCOVERY — what pages does this site have?
  //
  // Answers the admin's "Check Pages" button. It is deliberately a SEPARATE, cheap call rather than part
  // of /capture: the point is to show the user the real list and let them choose BEFORE anything is
  // captured. It costs a robots.txt + sitemap fetch in the common case and never launches a browser.
  //
  // This exists because discovery used to be the header nav alone, so a site with 133 sitemap URLs
  // converted as 2 pages and said it had succeeded. Showing the list makes that failure impossible to
  // miss, but only because the list is now honest — the button is worthless on top of nav-only discovery.
  // THE SITE-FIX AGENT — hand one converted page to a tools-enabled agent.
  //
  // Unlike /refine-visual (one blind `--max-turns 1` completion with no tools, which can only guess from
  // markup and is then measured and usually discarded), this runs the agent WITH tools in the kit
  // directory, seeded with the project's own site-fixing prompt, so it can open both pages, measure them,
  // change things and measure again.
  if (u.pathname === '/refine-agent' && req.method === 'POST') {
    readJson(req).then((b) => {
      b = b || {};
      const src = String(b.source_url || '').trim();
      const conv = String(b.converted_url || '').trim();
      if (!/^https?:\/\//i.test(src) || !/^https?:\/\//i.test(conv)) {
        return json(res, 400, { error: 'source_url and converted_url are required' });
      }
      if (!isLocalSite(conv)) {
        return json(res, 403, {
          error: 'The site-fix agent only runs against a LOCAL site. It is given file and shell tools, '
            + 'which must never be pointed at a live site from a button. Copy the prompt and run it yourself '
            + 'against a staging copy instead.',
          code: 'not-local',
        });
      }
      runSiteFixAgent({
        sourceUrl: src,
        convertedUrl: conv,
        captureDir: String(b.capture_dir || ''),
        findings: String(b.findings || ''),
        timeoutMs: Math.min(1800000, Math.max(60000, parseInt(b.timeout_ms, 10) || 0)) || undefined,
        onLog: (m) => console.log('[refine-agent]', m),
      })
        .then((r) => json(res, 200, r))
        .catch((e) => json(res, 500, { error: String((e && e.message) || e) }));
    }).catch((e) => json(res, 400, { error: String((e && e.message) || e) }));
    return;
  }

  // SITE-WIDE VERIFICATION — run the section lens across every page, not just the home page.
  //
  // The single-page lenses were never looped, so every layout claim about a conversion was a claim about
  // its home page. On the first real site this ran against, the home page had 17 missing items and the
  // site had 158 — the home page was about a tenth of the problem, and the two worst pages were ones
  // nobody had opened. Each page is a pair of real renders, so `limit` is a budget, not a suggestion.
  if (u.pathname === '/verify-site') {
    const src = (u.searchParams.get('source') || '').trim();
    const conv = (u.searchParams.get('converted') || '').trim();
    if (!/^https?:\/\//i.test(src) || !/^https?:\/\//i.test(conv)) {
      return json(res, 400, { error: 'source and converted origins are required' });
    }
    const paths = (u.searchParams.get('paths') || '').split(',').map((x) => x.trim()).filter(Boolean);
    const limit = Math.min(24, Math.max(1, parseInt(u.searchParams.get('limit') || '', 10) || 8));
    const width = Math.min(2560, Math.max(320, parseInt(u.searchParams.get('width') || '', 10) || 1440));
    verifySite({
      sourceOrigin: src, convertedOrigin: conv,
      paths: paths.length ? paths : null, discover: !paths.length, limit, width,
    })
      .then((r) => json(res, 200, r))
      .catch((e) => json(res, 500, { error: String((e && e.message) || e) }));
    return;
  }

  if (u.pathname === '/pages') {
    const target = (u.searchParams.get('url') || '').trim();
    if (!/^https?:\/\//i.test(target)) { return json(res, 400, { error: 'url required' }); }
    // The request handler is synchronous (every other route is), so resolve the promise here rather than
    // making the whole handler async and changing how every route returns.
    discoverPages({ url: target })
      .then((d) => json(res, 200, d))
      .catch((e) => json(res, 500, { error: String((e && e.message) || e) }));
    return;
  }


  // Kinetic Scenes' video export (studio-render.mjs): start a render, follow it, download it.
  //   GET  /studio/render                 → { ffmpeg, busy }
  //   POST /studio/render                 { scene, playerBase, width, height, fps, format (mp4|webm|mov), transparent?, composite?, cover? } → { id }
  //   GET  /studio/render/<id>            → { state, done, total, error, name, bytes }
  //   GET  /studio/render/<id>/file       → the video
  //   GET  /studio/render/<id>/cover      → its cover image (PNG), when asked for
  //   POST /studio/render/<id>/cancel
  if (u.pathname === '/studio/render' || u.pathname.startsWith('/studio/render/')) {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const parts = u.pathname.split('/').filter(Boolean); // studio, render, id?, action?
    const id = parts[2];
    const action = parts[3];
    if (!id) {
      if (req.method === 'GET') { renderStatus().then((st) => json(res, 200, { ok: true, ...st })); return; }
      if (req.method !== 'POST') { json(res, 405, { error: 'GET or POST.' }); return; }
      readJson(req, 600 * 1024 * 1024)
        .then((body) => { const j = startRender(body); console.log('[studio-render]', j.id, `${j.width}x${j.height} ${j.fps}fps ${j.format}, ${j.total} frames`); json(res, 200, { ok: true, id: j.id, total: j.total }); })
        .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
      return;
    }
    if (action === 'cancel') { json(res, 200, { ok: cancelRender(id) }); return; }
    if (action === 'cover') {
      const f = jobCover(id);
      if (!f) { json(res, 404, { error: 'No cover for that render.' }); return; }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      createReadStream(f).pipe(res);
      return;
    }
    if (action === 'file') {
      const j = jobFile(id);
      if (!j) { json(res, 404, { error: 'No finished video with that id.' }); return; }
      res.writeHead(200, { 'content-type': j.format === 'webm' ? 'video/webm' : j.format === 'mov' ? 'video/quicktime' : 'video/mp4', 'content-length': j.bytes, 'content-disposition': `attachment; filename="${j.name}"`, 'cache-control': 'no-store' });
      createReadStream(j.file).pipe(res);
      return;
    }
    const info = jobInfo(id);
    if (!info) { json(res, 404, { error: 'No render with that id.' }); return; }
    json(res, 200, { ok: true, ...info });
    return;
  }

  // Kinetic Scenes' speech recognition (studio-transcribe.mjs): a voice-over's words, times and delivery.
  //   GET  /studio/transcribe              → { program, models, install, busy, ... }
  //   POST /studio/transcribe/install      { model } → install progress (poll GET /studio/transcribe)
  //   POST /studio/transcribe              { src, model?, language? } → { id }
  //   GET  /studio/transcribe/<id>         → { state, step, error, result }
  if (u.pathname === '/studio/transcribe' || u.pathname.startsWith('/studio/transcribe/')) {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const part = u.pathname.split('/').filter(Boolean)[2];
    if (!part) {
      if (req.method === 'GET') { transcribeStatus().then((st) => json(res, 200, { ok: true, ...st })); return; }
      if (req.method !== 'POST') { json(res, 405, { error: 'GET or POST.' }); return; }
      readJson(req, 32 * 1024 * 1024)
        .then((body) => json(res, 200, { ok: true, ...startTranscribe(body) }))
        .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
      return;
    }
    if (part === 'install') {
      if (req.method !== 'POST') { json(res, 405, { error: 'POST.' }); return; }
      readJson(req).then((body) => json(res, 200, { ok: true, install: startInstall(body) })).catch((e) => json(res, 500, { error: e.message }));
      return;
    }
    const info = transcribeJob(part);
    if (!info) { json(res, 404, { error: 'No transcription with that id.' }); return; }
    json(res, 200, { ok: true, ...info });
    return;
  }

  // Kinetic Scenes' add-ons (studio-addons.mjs): what is connected or installed, and where a connector is.
  //   GET  /studio/addons              → { addons: [{ id, kind, name, state, what, detail, location?, profiles? }] }
  //   POST /studio/addons/<id>         { location, field? } → sets (or, with "", resets) where it is, then checks it
  //   POST /studio/addons/<id>/find    → searches the usual install places, saves what it finds → { found }
  //   POST /studio/addons/<id>/browse  { field? } → this computer's own file or folder picker → { chosen }
  if (u.pathname === '/studio/doctor') {
    // Check this computer: the kit's report, as data and as text ready to paste into a bug report.
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    import('./studio-doctor.mjs').then(async (d) => { const r = await d.checkComputer(); json(res, 200, { ok: true, report: r, text: d.doctorText(r) }); })
      .catch((e) => json(res, 500, { error: e.message }));
    return;
  }
  if (u.pathname === '/studio/addons' || u.pathname.startsWith('/studio/addons/')) {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const part = u.pathname.split('/').filter(Boolean)[2];
    import('./studio-addons.mjs')
      .then(async (a) => {
        if (!part) return json(res, 200, { ok: true, addons: await a.listAddons() });
        if (req.method !== 'POST') return json(res, 405, { error: 'POST.' });
        const body = await readJson(req);
        const action = u.pathname.split('/').filter(Boolean)[3];
        if (action === 'find') return json(res, 200, { ok: true, ...(await a.findAddon(part)) });
        if (action === 'browse') return json(res, 200, { ok: true, ...(await a.browseAddon(part, body.field)) });
        return json(res, 200, { ok: true, status: await a.setAddonLocation(part, body.location ?? '', body.field) });
      })
      .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' workspace (studio-workspace.mjs): projects as folders on this computer, shared with AI agents.
  //   GET  /studio/workspace                          → { root, projects: [{ id, title, duration, updated }] }
  //   POST /studio/workspace                          { name, scene? } → { id, mtime }
  //   GET  /studio/workspace/<id>                     → { id, scene, mtime }
  //   POST /studio/workspace/<id>                     { scene, base } → { id, mtime }  (409 + { current } when it changed on disk)
  //   POST /studio/workspace/<id>/media?name=…        raw file → { path: "media/…" }
  //   GET  /studio/workspace/<id>/file/<path>         a project file (range requests)
  //   GET/POST /studio/workspace/<id>/notes           notes.md: { notes, mtime } / { notes } or { add, section? }
  //   GET  /studio/workspace/<id>/events              server-sent events: { kind: scene|notes|media, mtime? }
  //   POST /studio/workspace/<id>/reveal, /studio/workspace/reveal   open the folder
  // AI assist in steps (studio-agent.mjs): the request runs as an agent in the project's folder.
  //   POST /studio/agent                   { project, prompt } → { id }
  //   GET  /studio/agent/<id>              → { state: running|done|error|cancelled, steps: [{ t, text }], summary, error }
  //   POST /studio/agent/<id>/cancel
  if (u.pathname === '/studio/agent' || u.pathname.startsWith('/studio/agent/')) {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const [, , , id, what] = u.pathname.split('/');
    import('./studio-agent.mjs').then(async (g) => {
      if (!id) {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST.' });
        return json(res, 200, { ok: true, ...g.startAgent(await readJson(req)) });
      }
      if (what === 'cancel') return json(res, 200, { ok: g.cancelAgent(id) });
      const info = g.agentJob(id);
      return info ? json(res, 200, { ok: true, ...info }) : json(res, 404, { error: 'No such job.' });
    }).catch((e) => json(res, typeof e.code === 'number' ? e.code : 500, { error: e.message }));
    return;
  }
  //   GET  /studio/workspace-root                     → { root, byEnv, isDefault, defaultRoot }
  //   POST /studio/workspace-root                     { choose: true } opens the folder picker | { reset: true } → the same, plus { chosen }
  if (u.pathname === '/studio/workspace-root') {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    import('./studio-workspace.mjs')
      .then(async (w) => json(res, 200, { ok: true, ...(req.method === 'POST' ? await w.setRoot(await readJson(req)) : await w.rootInfo()) }))
      .catch((e) => json(res, typeof e.code === 'number' ? e.code : 500, { error: e.message }));
    return;
  }
  if (u.pathname === '/studio/workspace' || u.pathname.startsWith('/studio/workspace/')) {
    const parts = u.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent);
    const [id, what, ...rest] = parts;
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    import('./studio-workspace.mjs').then(async (w) => {
      try {
        if (!id) {
          if (req.method === 'POST') { const b = await readJson(req, 200 * 1024 * 1024); return json(res, 200, { ok: true, ...w.createProject(b.name || 'Untitled', b.scene) }); }
          return json(res, 200, { ok: true, ...(await w.listProjects()) });
        }
        if (id === 'reveal' && !what) return json(res, 200, { ok: true, ...w.reveal() });
        if (!what) {
          if (req.method === 'POST') { const b = await readJson(req, 200 * 1024 * 1024); return json(res, 200, { ok: true, ...w.writeProject(id, b.scene, { base: b.base }) }); }
          return json(res, 200, { ok: true, ...w.readProject(id) });
        }
        if (what === 'reveal') return json(res, 200, { ok: true, ...w.reveal(id) });
        if (what === 'notes') {
          if (req.method === 'POST') { const b = await readJson(req); return json(res, 200, { ok: true, ...(b.add ? w.addNote(id, b.add, b.section) : w.writeNotes(id, b.notes)) }); }
          return json(res, 200, { ok: true, ...w.readNotes(id) });
        }
        if (what === 'media' && req.method === 'POST') return json(res, 200, { ok: true, path: w.addMedia(id, u.searchParams.get('name') || 'media', await readBuffer(req, 2048 * 1024 * 1024)) });
        if (what === 'file') return w.sendFile(id, rest.join('/'), req, res);
        if (what === 'events') {
          w.projectDir(id);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          res.write(': connected\n\n');
          const stop = w.watch(id, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
          const ping = setInterval(() => res.write(': ping\n\n'), 25000);
          req.on('close', () => { stop(); clearInterval(ping); });
          return;
        }
        return json(res, 404, { error: 'Unknown workspace request.' });
      } catch (e) {
        if (res.headersSent) { res.end(); return; }
        return json(res, typeof e.code === 'number' ? e.code : 500, { error: e.message, ...(e.current ? { current: e.current } : {}) });
      }
    }).catch((e) => json(res, 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' background music (studio-music.mjs, the ACE-Step add-on): an instrumental made on this computer.
  //   POST /studio/music              { prompt, seconds, bpm? } → { id }   (starts ACE-Step from its folder if needed)
  //   GET  /studio/music/<id>         → { state, step, error, result: { src, bpm, seconds } }
  if (u.pathname === '/studio/music' || u.pathname.startsWith('/studio/music/')) {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const part = u.pathname.split('/').filter(Boolean)[2];
    Promise.all([import('./studio-music.mjs'), import('./studio-addons.mjs')])
      .then(async ([m, a]) => {
        if (!part) {
          if (req.method !== 'POST') return json(res, 405, { error: 'POST.' });
          return json(res, 200, { ok: true, ...m.startMusic(a.aceFolder(), await readJson(req)) });
        }
        const info = m.musicJob(part);
        return info ? json(res, 200, { ok: true, ...info }) : json(res, 404, { error: 'No music with that id.' });
      })
      .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' voice and music separation (studio-separate.mjs): a clip's sound as two tracks.
  //   GET  /studio/separate              → { runtime, model, mb, install, busy }
  //   POST /studio/separate/install      → install progress (poll GET /studio/separate)
  //   POST /studio/separate              { src } → { id }
  //   GET  /studio/separate/<id>         → { state, step, done, total, error, result: { voice, music, seconds } }
  if (u.pathname === '/studio/separate' || u.pathname.startsWith('/studio/separate/')) {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const part = u.pathname.split('/').filter(Boolean)[2];
    import('./studio-separate.mjs')
      .then(async (s) => {
        if (!part) {
          if (req.method === 'GET') return json(res, 200, { ok: true, ...(await s.separateStatus()) });
          if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST.' });
          return json(res, 200, { ok: true, ...s.startSeparate(await readJson(req, 256 * 1024 * 1024)) });
        }
        if (part === 'install') return json(res, 200, { ok: true, install: s.startSeparateInstall() });
        const info = s.separateJob(part);
        return info ? json(res, 200, { ok: true, ...info }) : json(res, 404, { error: 'No separation with that id.' });
      })
      .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' sound identification (studio-clap.mjs): the sounds in a clip and when each is heard.
  //   GET  /studio/clap              → { installed, mb, install, labels }
  //   POST /studio/clap/install      → install progress (poll GET /studio/clap)
  //   POST /studio/clap              { src, labels? } → { id }
  //   GET  /studio/clap/<id>         → { state, step, done, total, error, result: { seconds, overall, segments } }
  if (u.pathname === '/studio/clap' || u.pathname.startsWith('/studio/clap/')) {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const part = u.pathname.split('/').filter(Boolean)[2];
    import('./studio-clap.mjs')
      .then(async (c) => {
        if (!part) {
          if (req.method === 'GET') return json(res, 200, { ok: true, ...c.clapStatus() });
          if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST.' });
          return json(res, 200, { ok: true, ...c.startIdentify(await readJson(req, 256 * 1024 * 1024)) });
        }
        if (part === 'install') return json(res, 200, { ok: true, install: c.startClapInstall() });
        const info = c.identifyJob(part);
        return info ? json(res, 200, { ok: true, ...info }) : json(res, 404, { error: 'No identification with that id.' });
      })
      .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' voice-over from a script (studio-voice.mjs): Piper speaks it, the kit times every word.
  //   GET  /studio/voice              → { program, voices, transcription, install }
  //   POST /studio/voice/install      { voice } → install progress (poll GET /studio/voice)
  //   POST /studio/voice              { lines, voice?, gap? } → { id }
  //   GET  /studio/voice/<id>         → { state, step, error, result }
  if (u.pathname === '/studio/voice' || u.pathname.startsWith('/studio/voice/')) {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const part = u.pathname.split('/').filter(Boolean)[2];
    import('./studio-voice.mjs')
      .then(async (v) => {
        if (!part) {
          if (req.method === 'GET') return json(res, 200, { ok: true, ...(await v.voiceStatus()) });
          if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST.' });
          return json(res, 200, { ok: true, ...v.startVoice(await readJson(req)) });
        }
        if (part === 'install') return json(res, 200, { ok: true, install: v.startVoiceInstall(await readJson(req)) });
        const info = v.voiceJob(part);
        return info ? json(res, 200, { ok: true, ...info }) : json(res, 404, { error: 'No voice-over with that id.' });
      })
      .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' sound search and sound design (studio-sounds.mjs).
  //   GET  /studio/sounds                 → { key, cached }
  //   POST /studio/sounds/key             { key } → saves the person's Freesound key (checked first)
  //   POST /studio/sounds/search          { q, page?, maxSeconds? } → public-domain results with previews
  //   POST /studio/sounds/fetch           { id } → { src, name, seconds }
  //   POST /studio/sounds/design          { prompt, seconds? } → { design } (a recipe) or { src } (with an ElevenLabs key)
  if (u.pathname === '/studio/sounds' || u.pathname.startsWith('/studio/sounds/')) {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const part = u.pathname.split('/').filter(Boolean)[2];
    import('./studio-sounds.mjs')
      .then(async (m) => {
        if (!part) return json(res, 200, { ok: true, ...m.soundsStatus() });
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
        const body = await readJson(req);
        const fn = { key: m.saveSoundsKey, search: m.searchSounds, fetch: m.fetchSound, design: m.designSound }[part];
        if (!fn) return json(res, 404, { error: 'Unknown sounds action.' });
        return json(res, 200, { ok: true, ...(await fn(body)) });
      })
      .catch((e) => json(res, [400, 412, 503].includes(e.code) ? e.code : e.code === 502 ? 502 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' "3D objects from a description" (studio-object3d.mjs).
  //   POST /studio/object3d              { prompt, playerBase? } → { src (GLB data: URL), name, parts, problems, looked, notes }
  if (u.pathname === '/studio/object3d') {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    (async () => {
      const b = await readJson(req);
      const pb = typeof b.playerBase === 'string' && /^https?:\/\/[^\s"'<>]+\/$/.test(b.playerBase) ? b.playerBase : await (await import('./studio-tools.mjs')).playerBase();
      const r = await (await import('./studio-object3d.mjs')).objectFromDescription({ prompt: b.prompt, playerBase: pb, look: b.look !== false });
      return json(res, 200, { ok: true, src: `data:model/gltf-binary;base64,${r.glb.toString('base64')}`, name: r.name, parts: r.parts, problems: r.problems, looked: r.looked, notes: r.notes });
    })().catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' "Music composed to the scene" (studio-score.mjs): no add-on needed.
  //   POST /studio/score                 { scene, mood?: bright|calm|dark|driving } → { src (MP3 data: URL), bpm, key, reveal, accents, seconds }
  if (u.pathname === '/studio/score') {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    (async () => {
      const b = await readJson(req, 50 * 1024 * 1024);
      if (!b.scene || typeof b.scene.duration !== 'number') return json(res, 400, { error: 'Send the scene.' });
      const r = (await import('./studio-score.mjs')).composeScore(b.scene, { mood: b.mood });
      const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { spawnSync } = await import('node:child_process');
      const d = mkdtempSync(join(tmpdir(), 'upw-score-'));
      try {
        writeFileSync(join(d, 's.wav'), r.wav);
        const enc = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-i', join(d, 's.wav'), '-b:a', '192k', join(d, 's.mp3')]);
        const mp3 = enc.status === 0 ? readFileSync(join(d, 's.mp3')) : null;
        const src = mp3 ? `data:audio/mpeg;base64,${mp3.toString('base64')}` : `data:audio/wav;base64,${r.wav.toString('base64')}`;
        return json(res, 200, { ok: true, src, bpm: r.bpm, key: r.key, reveal: r.reveal, accents: r.accents, seconds: r.seconds });
      } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    })().catch((e) => json(res, 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' "Make one like this" (studio-likethis.mjs): a video the person likes, worked out into a brief.
  //   POST /studio/like-this             { src (video data: URL), seconds? } → { brief, context, summary, duration }
  if (u.pathname === '/studio/like-this') {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    (async () => {
      const b = await readJson(req, 600 * 1024 * 1024);
      if (typeof b.src !== 'string' || !/^data:video\//.test(b.src)) return json(res, 400, { error: 'Send the video (a data: URL).' });
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const d = mkdtempSync(join(tmpdir(), 'upw-likein-'));
      try {
        const f = join(d, 'ref.mp4');
        writeFileSync(f, Buffer.from(b.src.slice(b.src.indexOf(',') + 1), 'base64'));
        const r = await (await import('./studio-likethis.mjs')).likeThis({ file: f, seconds: Number(b.seconds) || undefined });
        return json(res, 200, { ok: true, brief: r.brief, context: r.context, summary: r.summary, duration: r.duration });
      } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    })().catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' "Finish in another editor" (studio-interchange.mjs): a workspace project's cut as FCPXML,
  // Premiere XML and SRT, written into the project's renders/edit/.
  //   POST /studio/interchange           { project } → { dir, files, skipped, graphics, clips }
  if (u.pathname === '/studio/interchange') {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    (async () => {
      const b = await readJson(req);
      const w = await import('./studio-workspace.mjs');
      const dir = w.projectDir(String(b.project || ''));
      const { scene } = w.readProject(String(b.project || ''));
      const m = await import('./studio-interchange.mjs');
      return json(res, 200, { ok: true, ...m.writeInterchange({ scene, baseDir: dir, out: join(dir, 'renders', 'edit') }) });
    })().catch((e) => json(res, e.code === 400 || e.code === 404 ? e.code : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' "Make a reel from this video" (studio-highlights.mjs).
  //   POST /studio/highlights            { src (video data: URL), length?, part?, words?, beats? } → { parts, cuts, seconds, spoken }
  if (u.pathname === '/studio/highlights') {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    import('./studio-highlights.mjs')
      .then(async (m) => json(res, 200, { ok: true, ...(await m.highlightsFromData(await readJson(req, 600 * 1024 * 1024))) }))
      .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' free stock search (studio-stock.mjs): Pexels, Pixabay (with the person's keys), NASA, Openverse.
  //   GET  /studio/stock                 → { sources: { pexels: { on, needsKey, hasKey }, … } }
  //   POST /studio/stock/sources         { off: [source…] } → the same, after saving which are switched off
  //   POST /studio/stock/key             { source: pexels|pixabay, key } → the same, after saving the key
  //   POST /studio/stock/search          { q, kind?: video|photo|audio, sources?, orient? } → { results, notes }
  //   POST /studio/stock/get             { project, result } → { path, note, credit } (into media/, noted)
  if (u.pathname === '/studio/stock' || u.pathname.startsWith('/studio/stock/')) {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const part = u.pathname.split('/').filter(Boolean)[2];
    import('./studio-stock.mjs')
      .then(async (m) => {
        if (!part) return json(res, 200, { ok: true, ...(await m.stockStatus()) });
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
        const b = await readJson(req);
        if (part === 'key') return json(res, 200, { ok: true, ...(await m.setStockKey(b.source, b.key)) });
        if (part === 'sources') return json(res, 200, { ok: true, ...(await m.setStockSources(b)) });
        if (part === 'search') return json(res, 200, { ok: true, ...(await m.stockSearch(b)) });
        if (part === 'get') return json(res, 200, { ok: true, ...(await m.stockGet(b.project, b.result)) });
        return json(res, 404, { error: 'Unknown stock action.' });
      })
      .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' footage tools (studio-matte.mjs): the person cut out, the face followed, the sound taken out.
  //   POST /studio/matte              { src, cutout?, faces?, quality?: fine|fast|rvm } → { id }
  //   GET  /studio/matte/methods      → { methods: { fast, fine, rvm, sam2: { ready, note, … } } }
  //   GET  /studio/matte/<id>         → { state, step, done, total, error, result: { src?, track?, width, height, fps, seconds } }
  //   POST /studio/footage-audio      { src } → { src (an MP3 data URL), seconds } (the footage's own sound)
  if (u.pathname === '/studio/matte' || u.pathname.startsWith('/studio/matte/') || u.pathname === '/studio/footage-audio') {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const part = u.pathname.split('/').filter(Boolean)[2];
    import('./studio-matte.mjs')
      .then(async (m) => {
        if (u.pathname === '/studio/footage-audio') return json(res, 200, { ok: true, ...(await m.footageAudio(await readJson(req, 600 * 1024 * 1024))) });
        if (!part) {
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
          return json(res, 200, { ok: true, ...m.startMatte(await readJson(req, 600 * 1024 * 1024)) });
        }
        if (part === 'methods') return json(res, 200, { ok: true, methods: m.matteMethods() });
        const info = m.matteJob(part);
        return info ? json(res, 200, { ok: true, ...info }) : json(res, 404, { error: 'No cut-out with that id.' });
      })
      .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes' AI director (studio-director.mjs): plan first, look-criticise-fix, quick scenes.
  //   POST /studio/plan    { prompt, kind: storyboard|explainer|tutorial, rules, catalog, stage, context? } → { title, plan, segments? }
  //   POST /studio/review  { scene, playerBase, rules, catalog, prompt?, times? } → { ok, notes } | { ok: false, scene, explanation }
  //   POST /studio/quick   { url? , folder? } → { brief, context, shots: [data URLs] }
  if (u.pathname === '/studio/plan' || u.pathname === '/studio/review' || u.pathname === '/studio/quick') {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    const which = u.pathname.split('/')[2];
    import('./studio-director.mjs')
      .then(async (d) => {
        const body = await readJson(req, 48 * 1024 * 1024);
        markAi({ status: 'thinking', backend: aiBackend(), note: `Kinetic Scenes: ${which === 'plan' ? 'planning…' : which === 'review' ? 'looking at the frames…' : 'reading the website…'}`, startedAt: Date.now() });
        const r = which === 'plan' ? await d.studioPlan(body) : which === 'review' ? await d.studioReview(body) : await d.studioQuick(body);
        markAi({ status: 'idle' });
        return json(res, 200, { ok: true, ...r });
      })
      .catch((e) => { markAi({ status: 'idle' }); json(res, e.code === 400 ? 400 : e.code === 503 ? 503 : 500, { error: e.message }); });
    return;
  }

  // Kinetic Scenes' "Split into layers" (studio-split.mjs): a picture into stacked transparent layers.
  //   GET  /studio/split  → { engine: 'fal' | 'local', fal, localModel }
  //   POST /studio/split  { src, layers?, prompt? } → { engine, layers: [{ name, src }] } (bottom to top)
  if (u.pathname === '/studio/split') {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    if (req.method !== 'GET' && req.method !== 'POST') { json(res, 405, { error: 'GET or POST.' }); return; }
    import('./studio-split.mjs')
      .then(async ({ splitImage, splitStatus }) => {
        if (req.method === 'GET') return json(res, 200, { ok: true, ...splitStatus() });
        const body = await readJson(req, 48 * 1024 * 1024);
        return json(res, 200, { ok: true, ...(await splitImage(body)) });
      })
      .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  // Kinetic Scenes (kinetic-scenes.unysonplus.com): "AI" tab → a scene file from a request, made
  // with this kit's AI. Only the Studio's own pages may call these (studio-ai.mjs → studioOriginAllowed).
  if (u.pathname === '/studio/status' || u.pathname === '/studio/ai') {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    if (u.pathname === '/studio/status') {
      Promise.all([import('./studio-workspace.mjs').then((w) => w.lastAgent()).catch(() => null), import('./studio-agent.mjs').then((g) => g.agentAvailable()).catch(() => false)])
        .then(([agent, steps]) => { const st = studioAiStatus(); json(res, 200, { ok: true, version: VERSION, ...st, features: steps ? [...st.features, 'agent', 'agent-create'] : st.features, agent }); });
      return;
    }
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    const _aiStart = Date.now();
    readJson(req)
      .then((body) => {
        markAi({ status: 'thinking', backend: aiBackend(), note: 'Kinetic Scenes: ' + (body.mode === 'create' ? 'making a scene…' : 'changing the scene…'), startedAt: _aiStart });
        return studioScene(body);
      })
      .then((out) => { markAi({ status: 'done', backend: aiBackend(), model: out.model, startedAt: _aiStart, elapsed: Math.round((Date.now() - _aiStart) / 1000), note: 'Kinetic scene' }); console.log('[studio-ai] scene via', out.model, 'in', Math.round((Date.now() - _aiStart) / 1000) + 's'); json(res, 200, { ok: true, ...out }); })
      .catch((e) => { const code = e.code === 400 ? 400 : (e.code === 503 ? 503 : 500); if (code === 500) markAi({ status: 'error', backend: aiBackend(), startedAt: _aiStart, error: e.message }); console.error('[studio-ai]', e.message); json(res, code, { error: e.message }); });
    return;
  }

  if (u.pathname === '/health') {
    checkLatest(false); // background refresh (cached, hourly); never blocks the response
    // aiModel names the ACTUAL model, so a caller can say "Local AI (qwen3:8b)" rather than the vaguer
    // "local model". `aiTools` says whether the chosen backend can be given tools — the difference between
    // an agent that measures its own work and a single blind completion, which is the difference a user
    // most needs to see before pressing a button.
    const _be = aiBackend();
    json(res, 200, {
      ok: true, service: 'unysonplus-design-capture', version: VERSION, latest: latestVersion,
      updateAvailable: updateAvailable(), aiReady: aiReady(), aiBackend: _be,
      aiModel: _be === 'ollama' ? selectedLocalModel() : ( _be ? ( process.env.ANTHROPIC_MODEL || 'claude' ) : '' ),
      aiTools: _be === 'claude-code',
    });
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

  // POST /ai-micro — ALWAYS-ON local micro pass (token-free): give the sections semantic css_id slugs on
  // the LOCAL model, applied NON-DESTRUCTIVELY to the review mapping so the wp-admin build uses them. This
  // runs automatically (not gated by "Use AI") and NEVER fails the conversion — returns the mapping
  // unchanged when no local model is set up or on any error. It's the "tiny bit on every step" the small
  // local model is good at, and it does NOT touch the high-stakes structural mapping (that stays Claude/
  // deterministic).
  if (u.pathname === '/ai-micro') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    const _aiStart = Date.now();
    let _mapping = null;
    readJson(req)
      .then(async (body) => {
        _mapping = body && body.mapping;
        if (!_mapping || !Array.isArray(_mapping.pages)) { json(res, 400, { error: 'No mapping.' }); return; }
        await localAiStatus().catch(() => {}); // warm the ollama up-probe so microBackend() is accurate
        if (microBackend() !== 'ollama' || !selectedLocalModel()) { json(res, 200, { ok: true, mapping: _mapping, changes: null, skipped: 'no-local-model' }); return; }
        markAi({ status: 'thinking', backend: 'ollama', model: selectedLocalModel(), note: 'naming sections', startedAt: _aiStart });
        const changes = await localSectionMicroTask(_mapping); // mutates _mapping in place
        markAi({ status: 'done', backend: 'ollama', model: selectedLocalModel(), startedAt: _aiStart, elapsed: Math.round((Date.now() - _aiStart) / 1000), note: changes ? `named ${changes.renamed} section(s)` : 'no change' });
        console.log('[ai-micro] local section-naming →', changes ? `${changes.renamed} renamed, ${changes.decorative} decorative` : 'no local model');
        json(res, 200, { ok: true, mapping: _mapping, changes });
      })
      .catch((e) => { markAi({ status: 'error', backend: 'ollama', model: selectedLocalModel(), startedAt: _aiStart, error: e.message }); console.error('[ai-micro]', e.message); json(res, 200, { ok: true, mapping: _mapping, error: e.message }); });
    return;
  }

  // POST /ai-animations — refine the converter's deterministic entrance-animation plan. Body:
  // { plan:[{ i, section, sc, text, effect, delay }] }. Returns { ok, items:[{i,effect,delay}] } with
  // effects validated to the Animate.css entrance set. Non-destructive like /ai-micro: NEVER hard-fails
  // the conversion — on any error (or no AI backend) it returns items:[] so the plugin keeps its
  // deterministic base. The "Refine with AI" entrance-animation sub-option (Site Converter) calls this.
  if (u.pathname === '/ai-animations') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    const _aiStart = Date.now();
    readJson(req)
      .then(async (body) => {
        const plan = body && Array.isArray(body.plan) ? body.plan : [];
        if (!plan.length) { json(res, 200, { ok: true, items: [], skipped: 'empty-plan' }); return; }
        if (!aiReady()) { json(res, 200, { ok: true, items: [], skipped: 'ai-off' }); return; }
        markAi({ status: 'thinking', backend: aiBackend(), note: `refining ${plan.length} entrance animation(s)…`, startedAt: _aiStart });
        const out = await refineAnimations({ plan });
        markAi({ status: 'done', backend: aiBackend(), model: out.model, startedAt: _aiStart, elapsed: Math.round((Date.now() - _aiStart) / 1000), note: `refined ${out.items.length} animation(s)` });
        console.log('[ai-animations] refined', out.items.length, 'of', plan.length, 'via', out.model);
        json(res, 200, { ok: true, items: out.items, model: out.model });
      })
      .catch((e) => { markAi({ status: 'error', backend: aiBackend(), startedAt: _aiStart, error: e.message }); console.error('[ai-animations]', e.message); json(res, 200, { ok: true, items: [], error: e.message }); });
    return;
  }

  // POST /ai-preloader-js — synthesize a cosmetic loader script for a detected preloader whose ORIGINAL JS
  // was intertwined with the app (so the converter couldn't extract it). Body { html, css }. Returns
  // { ok, js, model }. Non-destructive like /ai-animations: any error / no backend → { ok:true, js:'' } so
  // the converter keeps the (JS-less) overlay. The Site Converter calls this when it detects such a preloader.
  if (u.pathname === '/ai-preloader-js') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    const _aiStart = Date.now();
    readJson(req)
      .then(async (body) => {
        const html = body && typeof body.html === 'string' ? body.html : '';
        if (!html.trim()) { json(res, 200, { ok: true, js: '', skipped: 'empty' }); return; }
        if (!aiReady()) { json(res, 200, { ok: true, js: '', skipped: 'ai-off' }); return; }
        markAi({ status: 'thinking', backend: aiBackend(), note: 'writing a preloader script…', startedAt: _aiStart });
        const out = await synthesizePreloaderJs({ html, css: (body && body.css) || '' });
        markAi({ status: 'done', backend: aiBackend(), model: out.model, startedAt: _aiStart, elapsed: Math.round((Date.now() - _aiStart) / 1000) });
        console.log('[ai-preloader-js]', out.js ? `wrote ${out.js.length} chars via ${out.model}` : `no js (${out.skipped || 'empty'})`);
        json(res, 200, { ok: true, js: out.js, model: out.model });
      })
      .catch((e) => { markAi({ status: 'error', backend: aiBackend(), startedAt: _aiStart, error: e.message }); console.error('[ai-preloader-js]', e.message); json(res, 200, { ok: true, js: '', error: e.message }); });
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

  /* --- Which AI runs (the backend switch) ------------------------------------------------------ *
   * GET  /local-ai/backend → every backend with whether it can run, the saved choice, and the active one.
   * POST /local-ai/backend → { backend: '' | 'api' | 'claude-code' | 'endpoint' | 'ollama' | 'off' }.
   * The AI_BACKEND environment variable still wins over the saved choice (see preferredBackend()).
   */
  if (u.pathname === '/local-ai/backend' && req.method === 'GET') { json(res, 200, aiBackends()); return; }
  if (u.pathname === '/local-ai/backend' && req.method === 'POST') {
    readJson(req)
      .then((b) => { const v = setPreferredBackend(b && b.backend); console.log('[ai] backend →', v || 'automatic'); return aiBackends(); })
      .then((st) => json(res, 200, st))
      .catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }

  /* --- Bring your own endpoint (OpenAI-compatible) ------------------------------------------- *
   * GET  /local-ai/endpoint         → the saved config, WITHOUT the key (the UI never needs it back).
   * POST /local-ai/endpoint         → save { baseUrl, key?, model? }. Omitting `key` keeps the stored one,
   *                                   so re-picking a model does not wipe it. An empty baseUrl clears the tier.
   * GET  /local-ai/endpoint/models  → the provider's catalogue, split into usable / everything else.
   */
  if (u.pathname === '/local-ai/endpoint' && req.method === 'GET') {
    const c = endpointConfig();
    json(res, 200, { baseUrl: c.baseUrl, model: c.model, source: c.source, hasKey: !!c.key, presets: ENDPOINT_PRESETS, probe: endpointProbe() });
    return;
  }
  if (u.pathname === '/local-ai/endpoint' && req.method === 'POST') {
    readJson(req)
      .then((b) => {
        const c = setEndpointConfig(b || {});
        console.log('[endpoint]', c.baseUrl ? `${c.baseUrl} · ${c.model || '(no model)'}` : '(cleared)');
        return localAiStatus();
      })
      .then((st) => json(res, 200, st))
      .catch((e) => { console.error('[endpoint]', e.message); json(res, e.code === 400 ? 400 : 500, { error: e.message }); });
    return;
  }
  // POST /local-ai/endpoint/probe — ask the provider which listed models this key can actually call.
  if (u.pathname === '/local-ai/endpoint/probe' && req.method === 'POST') {
    readJson(req).catch(() => ({}))
      .then((b) => probeEndpointModels(b || {}))
      .then((out) => { console.log('[endpoint] probe:', out.ok.length, 'of', out.tested, 'usable'); json(res, 200, out); })
      .catch((e) => json(res, e.code === 400 ? 400 : 503, { error: e.message }));
    return;
  }
  if (u.pathname === '/local-ai/endpoint/models' && req.method === 'GET') {
    listEndpointModels()
      .then((r) => json(res, 200, r))
      .catch((e) => json(res, e.code === 400 ? 400 : 503, { error: e.message }));
    return;
  }

  // POST /local-ai/pull — download a model via Ollama (streamed in the background). GET .../pull-status polls it.
  if (u.pathname === '/local-ai/pull' && req.method === 'POST') {
    // Any model name / Hugging Face link is normalised + validated first (the dashboard's "Add a model").
    readJson(req).then((b) => startPull(normalizeModelRef(b.model))).then((s) => json(res, 200, s)).catch((e) => json(res, e.code === 400 ? 400 : 500, { error: e.message }));
    return;
  }
  // POST /local-ai/import — register a .gguf file on this computer with Ollama ({ path, name }). Progress via pull-status.
  if (u.pathname === '/local-ai/import' && req.method === 'POST') {
    readJson(req).then((b) => importGguf({ path: b.path, name: b.name })).then((s) => json(res, 200, s))
      .catch((e) => json(res, [400, 409, 503].includes(e.code) ? e.code : 500, { error: e.message }));
    return;
  }
  // POST /local-ai/check — is this model fit for the kit's JSON tasks? ({ model }) → { grade, ms, note, reply }
  if (u.pathname === '/local-ai/check' && req.method === 'POST') {
    readJson(req).then((b) => checkModel(b.model)).then((r) => json(res, 200, r))
      .catch((e) => json(res, [400, 503].includes(e.code) ? e.code : 500, { error: e.message }));
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

  // The Kit Assistant's endpoints answer the dashboard only. This service allows any origin (the converter
  // endpoints are called from WordPress), so without this a web page open in the same browser could drive
  // the chat's tools, or read a pending proposal's id from a reply and confirm it. The dashboard's server
  // calls these from Node (no Origin header); a browser always sends one on a cross-site POST.
  if (/^\/local-ai\/chat(-history|-clear|-confirm|-command|-job)?$/.test(u.pathname) && !chatOriginOk(req)) {
    json(res, 403, { error: 'The Kit Assistant answers the AI Dev Kit dashboard only.' });
    return;
  }
  // POST /local-ai/chat-confirm — the person's Confirm / Cancel on a proposal the chat made (Phase 3).
  // Body: { id, decision: 'confirm'|'cancel' }. Runs it at most once, and records the outcome in the chat.
  if (u.pathname === '/local-ai/chat-confirm' && req.method === 'POST') {
    readJson(req)
      .then((b) => decideProposal(chatEnv(), b && b.id, b && b.decision).then((out) => ({ out, id: b && b.id })))
      .then(({ out, id }) => {
        const hist = readChatHistory();
        for (const m of hist) {
          for (const t of (m.toolCalls || [])) {
            if (t.result && t.result.id === id) t.result.state = out.cancelled ? 'cancelled' : (out.ok ? 'confirmed' : 'failed');
          }
        }
        const text = out.ok ? (out.message + (out.link ? ' ' + out.link : '')) : ('Not done: ' + out.error);
        hist.push({ role: 'assistant', content: text, action: true, at: Date.now(), ...(out.job ? { agentJob: { ...out.job, state: 'running' } } : {}) });
        writeChatHistory(hist);
        console.log('[local-ai/chat-confirm]', out.cancelled ? 'cancelled' : (out.ok ? 'ran' : 'failed: ' + out.error));
        json(res, out.ok ? 200 : 409, { ...out, text });
      })
      .catch((e) => json(res, 500, { error: e.message }));
    return;
  }
  // The agent run a Confirm started: GET ?id= → its steps; POST { id, action: 'stop' } | { project, snapshot, action: 'restore' }.
  if (u.pathname === '/local-ai/chat-job') {
    if (req.method === 'GET') {
      const j = agentJob(u.searchParams.get('id'));
      json(res, j ? 200 : 404, j || { error: 'The kit restarted, so this run stopped.' });
      return;
    }
    readJson(req).then((b) => {
      if (b.action === 'stop') return json(res, 200, { ok: cancelAgent(b.id) });
      if (b.action !== 'restore') return json(res, 400, { error: 'stop or restore.' });
      const r = restoreSnapshot(b.project, b.snapshot);
      const hist = readChatHistory();
      for (const m of hist) if (m.agentJob && m.agentJob.snapshot === b.snapshot) m.agentJob.restored = true;
      hist.push({ role: 'assistant', content: `Put ${b.project} back as it was before that run.`, action: true, at: Date.now() });
      writeChatHistory(hist);
      return json(res, 200, { ok: true, ...r });
    }).catch((e) => json(res, typeof e.code === 'number' ? e.code : 500, { error: e.message }));
    return;
  }
  // GET /studio/handoff?id=… — Kinetic Scenes collects a scene request the chat handed over (once).
  if (u.pathname === '/studio/handoff' && req.method === 'GET') {
    if (!studioOriginAllowed(req.headers.origin || '')) { json(res, 403, { error: 'Only Unyson+ Kinetic Scenes may use this.' }); return; }
    const h = takeHandoff(u.searchParams.get('id'));
    if (!h) { json(res, 404, { error: 'This request was already opened, or has expired. Ask the Kit Assistant again.' }); return; }
    json(res, 200, { ok: true, ...h });
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
  // POST /local-ai/chat-command — run ONE tool straight from a typed `/command`, with no model in the
  // loop. Body: { command, arg }. The point is not typing speed: a command is deterministic and needs
  // no AI at all, so `/report` is instant and exact where asking an 8B local model to choose
  // `conversion_report` is neither. It goes through the SAME gate as a model's call, so a command that
  // changes something still returns a proposal and still waits for Confirm.
  if (u.pathname === '/local-ai/chat-command' && req.method === 'POST') {
    readJson(req, 64 * 1024)
      .then(async (b) => {
        const cmd = String((b && b.command) || '').trim().toLowerCase().replace(/^\//, '');
        const arg = String((b && b.arg) || '').trim();
        const spec = CHAT_COMMANDS[cmd];
        if (!spec) { const e = new Error('Unknown command /' + cmd + '. Type /help to see them.'); e.code = 400; throw e; }
        if (spec.needs && !arg) { const e = new Error(`/${cmd} needs ${spec.needs} — e.g. ${spec.example}`); e.code = 400; throw e; }
        const args = spec.args(arg);
        const out = await runChatToolGated(chatEnv(), spec.tool, args);
        const hist = readChatHistory();
        hist.push({ role: 'user', content: '/' + cmd + (arg ? ' ' + arg : ''), command: true, at: Date.now() });
        hist.push({
          role: 'assistant', content: spec.say(arg, out.result), command: true, at: Date.now(),
          toolCalls: [{ name: spec.tool, args, ok: out.ok, result: out.result }],
        });
        writeChatHistory(hist);
        console.log('[local-ai/chat-command] /' + cmd, out.ok ? 'ok' : 'failed');
        return { ok: out.ok, messages: readChatHistory() };
      })
      .then((o) => json(res, 200, o))
      .catch((e) => { console.error('[local-ai/chat-command]', e.message); json(res, e.code === 400 ? 400 : 500, { error: e.message }); });
    return;
  }
  // POST /local-ai/chat — multi-turn chat on the active AI backend. Body: { messages:[{role,content}] }.
  // Runs the model, persists the sent turns + the reply, returns { ok, model, reply, ms }. 503 when AI off.
  // POST /local-ai/tool-chat — one turn on the picked local model ({ messages, tools | format, num_ctx, model }).
  // Used by the WordPress AI Assistant (Beta) "Local AI on this computer" mode: the assistant panel runs in
  // the person's browser, which can reach this service on localhost even when the site is hosted elsewhere.
  // POST /local-ai/agent — run Claude Code (this machine's subscription) as the WordPress AI Assistant's
  // agent against the site's MCP endpoint ({ mcp: { url, headers }, prompt }). Used by the assistant panel
  // when the kit reports aiBackend "claude-code"; the panel then shows "Claude" rather than a local model.
  // POST /mcp-kit — a tiny MCP server (Streamable HTTP, JSON answers) the AI Assistant's agent gets NEXT TO the
  // site's own MCP server. One tool, measure_pages: the page comparison run HERE, on the editor's computer —
  // a live site's server cannot reach this machine, so its visual_check hands the request to the agent,
  // which measures with this tool and passes the (trimmed) result back to visual_check as `measured`.
  if (u.pathname === '/mcp-kit') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST JSON-RPC messages.' }); return; }
    readJson(req).then(async (m) => {
      const id = m && m.id;
      const ok = (result) => json(res, 200, { jsonrpc: '2.0', id, result });
      if (!m || typeof m.method !== 'string') { json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return; }
      if (m.method.startsWith('notifications/')) { res.writeHead(202); res.end(); return; }
      if (m.method === 'initialize') { ok({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'unysonplus-kit', version: VERSION } }); return; }
      if (m.method === 'ping') { ok({}); return; }
      const site = AGENT_SITES.get(String(u.searchParams.get('site') || ''));
      if (m.method === 'tools/list') {
        const convertTool = site ? [{
          name: 'convert_site',
          description: 'Convert a website into the WordPress site you are working on, with the page rendered HERE in a real browser (the AI Dev Kit) — the way to convert on a live site, whose server cannot reach this computer. Without confirm it changes nothing and returns what the conversion would replace: tell the person and ask; call again with confirm: true only after they agree. Same result as the site tool convert_url with a rendered page.',
          inputSchema: { type: 'object', properties: { url: { type: 'string' }, confirm: { type: 'boolean' }, dry_run: { type: 'boolean' } }, required: ['url'] },
        }] : [];
        ok({ tools: [...convertTool, {
          name: 'measure_pages',
          description: 'Compare two web pages in a real browser on this computer (the AI Dev Kit): how different they look per horizontal strip, and section by section what is missing, moved or restyled. Use it when visual_check (on the site) answers reason "service_unreachable": pass its verify_request.body fields, then call visual_check again with the same arguments plus measured = the result of this tool.',
          inputSchema: { type: 'object', properties: { source_url: { type: 'string' }, converted_url: { type: 'string' }, width: { type: 'integer' }, lens: { type: 'string', enum: ['bands', 'sections', 'both'] } }, required: ['source_url', 'converted_url'] },
          annotations: { readOnlyHint: true },
        }] });
        return;
      }
      if (m.method === 'tools/call' && m.params && m.params.name === 'convert_site') {
        const a = m.params.arguments || {};
        const target = String(a.url || '');
        if (!site) { ok({ content: [{ type: 'text', text: 'No site is attached to this session.' }], isError: true }); return; }
        if (!/^https?:\/\//i.test(target)) { ok({ content: [{ type: 'text', text: 'url must be an http(s) address.' }], isError: true }); return; }
        const callSite = (args) => fetch(site.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...site.headers },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'convert_url', arguments: args } }),
        }).then((r) => r.json());
        try {
          const base = { url: target, confirm: !!a.confirm, dry_run: !!a.dry_run };
          let rendered = '';
          // Only render once the person has agreed (or for a dry run): the first call is the site's own
          // "this is what it will replace" answer.
          if (a.confirm || a.dry_run) {
            const cap = await fetch(`http://127.0.0.1:${PORT}/capture?single=1&html=1&url=${encodeURIComponent(target)}`);
            if (!cap.ok) { throw new Error('the capture failed (HTTP ' + cap.status + ')'); }
            rendered = await cap.text();
          }
          const out = await callSite(rendered ? { ...base, rendered_html: rendered } : base);
          const r = (out && out.result) || {};
          ok({ content: r.content || [{ type: 'text', text: JSON.stringify(out && out.error ? out.error : out) }], structuredContent: r.structuredContent, isError: !!r.isError || !!(out && out.error) });
        } catch (e) {
          ok({ content: [{ type: 'text', text: 'Could not convert: ' + e.message }], isError: true });
        }
        return;
      }
      if (m.method === 'tools/call' && m.params && m.params.name === 'measure_pages') {
        const a = m.params.arguments || {};
        const o = { sourceUrl: String(a.source_url || ''), convertedUrl: String(a.converted_url || ''), width: Number(a.width) || 1440 };
        if (!/^https?:\/\//i.test(o.sourceUrl) || !/^https?:\/\//i.test(o.convertedUrl)) { ok({ content: [{ type: 'text', text: 'source_url and converted_url must be http(s) addresses.' }], isError: true }); return; }
        try {
          const bands = await verifyUrls({ ...o, bands: 8 });
          const secs = await verifySections(o);
          // Only what the site's summary reads — the full answer is large and the agent has to send it back.
          const trimmed = {
            ok: !!(bands.ok && secs.ok), lens: 'both',
            bands: bands.ok === false ? bands : { ok: bands.ok, overall_drift_pct: bands.overall_drift_pct, height_delta_pct: bands.height_delta_pct, source: { height: bands.source && bands.source.height }, converted: { height: bands.converted && bands.converted.height }, bands: bands.bands },
            sections: { ok: secs.ok, total: secs.total, byKind: secs.byKind, findings: [], sections: (secs.sections || []).map((x) => ({ id: x.id, srcH: x.srcH, convH: x.convH, missing: x.missing || undefined, findings: (x.findings || []).slice(0, 8).map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => ['kind', 'text', 'note', 'key', 'to', 'count', 'delta_pct'].includes(k)))) })) },
          };
          ok({ content: [{ type: 'text', text: JSON.stringify(trimmed) }], structuredContent: trimmed, isError: false });
        } catch (e) {
          ok({ content: [{ type: 'text', text: 'Could not compare the pages: ' + e.message }], isError: true });
        }
        return;
      }
      json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + m.method } });
    }).catch((e) => json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }));
    return;
  }

  // GET /local-ai/agent?job=<id> — the state of a background agent run (see the POST below).
  if (u.pathname === '/local-ai/agent' && req.method === 'GET') {
    const job = AGENT_JOBS.get(String(u.searchParams.get('job') || ''));
    if (!job) { json(res, 404, { error: 'No such agent job (it may have finished more than 30 minutes ago).' }); return; }
    json(res, 200, job.status === 'done' ? { status: 'done', ...job.out } : (job.status === 'error' ? { status: 'error', error: job.error } : { status: 'running', seconds: Math.round((Date.now() - job.started) / 1000) }));
    return;
  }

  // POST /local-ai/agent — run the AI Assistant's agent. With `async: true` it answers at once with a job id
  // the browser polls (GET above): a whole-page build takes minutes, and one HTTP request held open that long
  // gets dropped — the browser then RETRIED the POST and the agent ran twice (two copies of the page). A
  // `request_id` makes a retry return the same job instead of starting another. Without `async` it answers
  // when done, as before.
  if (u.pathname === '/local-ai/agent' && req.method === 'POST') {
    const _aiStart = Date.now();
    readJson(req)
      .then((body) => {
        const rid = String(body.request_id || '');
        if (body.async) {
          for (const [id, j] of AGENT_JOBS) { if (rid && j.rid === rid) { json(res, 200, { job: id, status: j.status }); return null; } }
          const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
          const job = { rid, status: 'running', started: _aiStart };
          AGENT_JOBS.set(id, job);
          markAi({ status: 'thinking', backend: 'claude-code', note: 'AI Assistant (WordPress) — Claude…', startedAt: _aiStart });
          runAssistantAgent({ mcp: body.mcp, prompt: body.prompt })
            .then((out) => { job.status = 'done'; job.out = out; markAi({ status: 'done', backend: 'claude-code', model: out.model, startedAt: _aiStart, elapsed: Math.round((Date.now() - _aiStart) / 1000), note: 'AI Assistant: Claude reply' }); })
            .catch((e) => { job.status = 'error'; job.error = e.message; markAi({ status: 'error', backend: 'claude-code', startedAt: _aiStart, error: e.message }); console.error('[local-ai/agent]', e.message); })
            .finally(() => { job.ended = Date.now(); for (const [k, v] of AGENT_JOBS) { if (v.ended && Date.now() - v.ended > 30 * 60000) AGENT_JOBS.delete(k); } });
          json(res, 202, { job: id, status: 'running' });
          return null;
        }
        markAi({ status: 'thinking', backend: 'claude-code', note: 'AI Assistant (WordPress) — Claude…', startedAt: _aiStart });
        return runAssistantAgent({ mcp: body.mcp, prompt: body.prompt }).then((out) => {
          markAi({ status: 'done', backend: 'claude-code', model: out.model, startedAt: _aiStart, elapsed: Math.round((Date.now() - _aiStart) / 1000), note: 'AI Assistant: Claude reply' });
          json(res, 200, out);
        });
      })
      .catch((e) => { const code = e.code === 503 ? 503 : (e.code === 400 ? 400 : 500); if (code === 500) markAi({ status: 'error', backend: 'claude-code', startedAt: _aiStart, error: e.message }); console.error('[local-ai/agent]', e.message); json(res, code, { error: e.message }); });
    return;
  }

  if (u.pathname === '/local-ai/tool-chat' && req.method === 'POST') {
    const _aiStart = Date.now();
    readJson(req)
      .then((body) => {
        markAi({ status: 'thinking', backend: 'ollama', note: 'AI Assistant (WordPress)…', startedAt: _aiStart });
        return toolChatLocalModel({ messages: body.messages, tools: body.tools, format: body.format, numCtx: body.num_ctx, model: body.model });
      })
      .then((out) => {
        markAi({ status: 'done', backend: 'ollama', model: out.model, startedAt: _aiStart, elapsed: Math.round((Date.now() - _aiStart) / 1000), note: out.message.tool_calls ? 'AI Assistant: tool call' : 'AI Assistant: reply' });
        json(res, 200, out);
      })
      .catch((e) => { const code = e.code === 503 ? 503 : (e.code === 400 ? 400 : 500); if (code === 500) markAi({ status: 'error', backend: 'ollama', startedAt: _aiStart, error: e.message }); console.error('[local-ai/tool-chat]', e.message); json(res, code, { error: e.message }); });
    return;
  }

  if (u.pathname === '/local-ai/chat' && req.method === 'POST') {
    if (!aiReady()) { json(res, 503, { error: 'AI is off — pick a local model in Settings, or enable Claude (Claude Code / an API key).' }); return; }
    const _aiStart = Date.now();
    // Images make a chat body far larger than a text one, so this route reads a bigger body than the
    // 8 MB default. The dashboard downscales before sending; this is the backstop, not the budget.
    readJson(req, 48 * 1024 * 1024)
      .then((body) => {
        // `sendMsgs` carry the base64 for the model; `msgs` (what the history keeps) carry only refs.
        const sendMsgs = [], msgs = [];
        let dropped = [];
        for (const m of (Array.isArray(body.messages) ? body.messages : [])) {
          if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
          const text = String(m.content == null ? '' : m.content);
          // An image already in the history arrives as a ref (no base64) — reload it from disk so an
          // earlier picture is still there on the next turn, instead of vanishing mid-conversation.
          const incoming = Array.isArray(m.images) ? m.images : [];
          const fresh = incoming.filter((im) => im && (im.b64 || im.data));
          const stored = incoming.filter((im) => im && !im.b64 && !im.data && im.file);
          const { images, refs, skipped } = storeChatImages(fresh);
          dropped = dropped.concat(skipped);
          for (const im of stored) {
            const p = join(CAPTURE_OUT, '_chat', String(im.file).replace(/[\\/]/g, ''));
            try { images.push({ mime: im.mime || 'image/png', b64: readFileSync(p).toString('base64'), name: im.name || 'image', path: p }); refs.push(im); }
            catch { /* the file is gone — the turn keeps its words */ }
          }
          if (!text.trim() && !images.length) continue;
          sendMsgs.push(images.length ? { role: m.role, content: text, images } : { role: m.role, content: text });
          msgs.push(refs.length ? { role: m.role, content: text, images: refs } : { role: m.role, content: text });
        }
        if (dropped.length) { const e = new Error('Could not attach ' + dropped.join('; ') + '.'); e.code = 400; throw e; }
        markAi({ status: 'thinking', backend: aiBackend(), note: 'chatting…', startedAt: _aiStart });
        // The Kit Assistant: the read-only tools (tool_look_at_url, tool_conversion_report,
        // tool_search_docs + read_doc) and a summary of the captures as context.
        const env = chatEnv();
        const chatCaptureContext = captureSummaryForChat(CAPTURE_OUT);
        return chatWithTools({
          messages: sendMsgs,
          tools: ALL_CHAT_TOOL_DEFS,
          context: chatCaptureContext,
          runTool: (name, args) => {
            markAi({ status: 'thinking', backend: aiBackend(), note: 'chat tool: ' + name, startedAt: _aiStart });
            return runChatToolGated(env, name, args);
          },
        }).then((out) => ({ out, msgs }));
      })
      .then(({ out, msgs }) => {
        // Tool results are kept short in history (the panel shows them; the model gets them fresh).
        const toolCalls = (out.toolCalls || []).map((t) => ({ name: t.name, args: t.args, ok: t.ok, result: JSON.parse(JSON.stringify(t.result || {}, (k, v) => (typeof v === 'string' && v.length > 1200 ? v.slice(0, 1200) + '…' : (Array.isArray(v) && v.length > 40 ? v.slice(0, 40) : v)))) }));
        writeChatHistory(msgs.concat([{ role: 'assistant', content: out.reply, model: out.model, toolCalls, at: Date.now() }]));
        markAi({ status: 'done', backend: aiBackend(), model: out.model, startedAt: _aiStart, elapsed: Math.round((Date.now() - _aiStart) / 1000), note: 'chat reply' });
        console.log('[local-ai/chat] reply via', out.model);
        json(res, 200, { ok: true, model: out.model, reply: out.reply, ms: out.ms, toolCalls });
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
        // lens: 'bands' (default — the original answer, unchanged), 'sections' (per-section findings), or
        // 'both' ({ bands, sections }). The AI Assistant's visual_check asks for 'both'.
        const lens = String(body.lens || 'bands');
        const o = { sourceUrl: body.source_url, convertedUrl: body.converted_url, width: body.width || 1440 };
        if (lens === 'sections') { return verifySections(o); }
        if (lens === 'both') {
          return verifyUrls({ ...o, bands: body.bands || 8 })
            .then((bands) => verifySections(o).then((sections) => ({ ok: !!(bands.ok && sections.ok), lens, bands, sections })));
        }
        return verifyUrls({ ...o, bands: body.bands || 8 });
      })
      .then((out) => { console.log('[verify] overall drift', (out.overall_drift_pct ?? (out.bands && out.bands.overall_drift_pct)) + '%', out.total != null ? out.total + ' findings' : ''); json(res, 200, out); })
      .catch((e) => { console.error('[verify]', e.message); json(res, 500, { error: e.message }); });
    return;
  }

  // POST /pen-shortcode — turn a pasted pen (HTML/CSS/JS) into an INSTALLABLE shortcode package (.zip),
  // ENTIRELY LOCALLY. The shortcode renders the pen VERBATIM (CSS/JS effects preserved) with its text +
  // images as editable options. Returns { ok, filename, zip_base64, texts, images }; the dashboard turns
  // the base64 into a download the user uploads at wp-admin → Site Converter → Add a shortcode.
  if (u.pathname === '/pen-shortcode') {
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
    readBuffer(req, 8 * 1024 * 1024).then(async (buf) => {
      let b; try { b = JSON.parse(buf.toString('utf8') || '{}'); } catch { json(res, 400, { error: 'Bad request body.' }); return; }
      const title = String(b.title || 'Snippet').trim() || 'Snippet';
      const html = stripPenHtml(b.html), css = String(b.css || ''), js = String(b.js || '');
      const externals = Array.isArray(b.externals) ? b.externals.map((x) => String(x).trim()).filter(Boolean) : [];
      if (html.trim() === '') { json(res, 400, { error: 'Paste the pen HTML first.' }); return; }
      markActive('pen: ' + title, 'running');
      try {
        // AI assist NAMES the options; the compiler still finds them and still writes every line of
        // code. It is injected as a callback so pen-shortcode.mjs has no idea AI exists, and so a
        // failure there costs the labels, never the package.
        let aiNamed = false;
        const useAi = !!b.ai_assist && aiReady();
        const nameSlots = useAi
          ? async (slots) => { const r = await namePenOptions(slots); aiNamed = !!r; return r; }
          : null;
        const out = await generatePenShortcode({ title, html, css, js, externals, nameSlots });
        markActive('pen: ' + title, 'done');
        json(res, 200, {
          ok: true,
          filename: out.filename,
          slug: out.slug,
          name: out.name,
          texts: out.texts,
          images: out.images,
          skipped: out.skipped,
          labels: out.labels,
          ai_named: aiNamed,
          ai_requested: useAi,
          zip_base64: out.zip.toString('base64'),
        });
      } catch (e) { markActive('pen', 'error'); json(res, 500, { error: e.message }); }
    }).catch((e) => { try { json(res, 500, { error: e.message }); } catch { /* */ } });
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

    // Output TARGET: 'block-theme' additionally emits block-bundle.json (a portable FSE block theme);
    // default 'page-builder' is unchanged. VOCAB (block-theme only): 'core' | 'enriched'.
    const outTarget = (u.searchParams.get('target') || 'page-builder').trim() === 'block-theme' ? 'block-theme' : 'page-builder';
    const vocab = (u.searchParams.get('vocab') || 'core').trim() === 'enriched' ? 'enriched' : 'core';

    // Write into CAPTURE_OUT (not a throwaway temp dir) so the run shows up LIVE in the dashboard
    // (progress + history). capture.mjs makes its own per-site subfolder under here.
    mkdirSync(CAPTURE_OUT, { recursive: true });
    const out = CAPTURE_OUT;
    console.log('[capture]', target, outTarget === 'block-theme' ? `(block-theme, vocab=${vocab})` : '');
    markActive(target, 'running'); // surface this service-driven run on the dashboard
    const args = [CAPTURE, target, out];
    if (outTarget === 'block-theme') { args.push('--target=block-theme', '--vocab=' + vocab); }
    // PAGE SCOPE (Convert panel -> PAGES box). `single=1` captures only the URL given; `max` caps the nav
    // crawl; `also` adds URLs the nav does not link to. Validated here rather than trusted — these become
    // process arguments.
    if (u.searchParams.get('single') === '1') { args.push('--single-page'); }
    const maxPages = parseInt(u.searchParams.get('max') || '', 10);
    if (Number.isFinite(maxPages) && maxPages >= 1 && maxPages <= 50) { args.push('--max-pages=' + maxPages); }
    const alsoPages = (u.searchParams.get('also') || '').split(',')
      .map((x) => x.trim()).filter((x) => /^https?:\/\//i.test(x)).slice(0, 25);
    if (alsoPages.length) { args.push('--also=' + alsoPages.join(',')); }
    // An explicit set chosen in the page picker. When present the capture skips discovery entirely — the
    // user has already reviewed this list, and re-deriving it could only disagree with what they saw.
    //
    // Named `only`, NOT `pages`: `pages=all` already means "return every captured page in the response",
    // so reusing that key for "capture exactly these URLs" would give one parameter two unrelated jobs.
    // It happens to survive today because `pages=all` fails the https:// filter below, but that is luck.
    const picked = (u.searchParams.get('only') || '').split(',')
      .map((x) => x.trim()).filter((x) => /^https?:\/\//i.test(x)).slice(0, 50);
    if (picked.length) { args.push('--pages=' + picked.join(',')); }
    const child = spawn(process.execPath, args, { stdio: 'inherit' });

    child.on('error', (e) => { markActive(target, 'error'); json(res, 500, { error: e.message }); });
    child.on('exit', () => {
      markActive(target, 'done');
      // Block-theme target → return the block-bundle.json the WordPress plugin installs as an FSE theme.
      if (outTarget === 'block-theme') {
        const bbPath = findFile(out, 'block-bundle.json');
        if (bbPath) {
          const buf = readFileSync(bbPath);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="block-bundle.json"',
            'Content-Length': buf.length,
          });
          res.end(buf);
        } else { json(res, 500, { error: 'Capture produced no block-bundle.json (the page may have failed to render).' }); }
        return;
      }
      // ?pages=all → return EVERY captured page as JSON so WordPress converts the whole site in one
      // pass. Falls back to the single-HTML response below when the run captured only one page, so an
      // older plugin (or a --single-page capture) is unaffected.
      if (u.searchParams.get('pages') === 'all') {
        const pages = readCapturedPages(out);
        if (pages.length) {
          json(res, 200, { pages });
        } else {
          const html = readRenderedHtml(out);
          if (html) { json(res, 200, { pages: [{ slug: '', url: target, front: true, html: html.toString('utf8') }] }); }
          else { json(res, 500, { error: 'Render produced no HTML.' }); }
        }
        return;
      }
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

  // GET /mirror?url=<url> — "Duplicate as landing page": browser-record a VERBATIM self-contained mirror
  // (index.html + assets/ where every JS-loaded asset was captured & re-linked) into CAPTURE_OUT/mirror-<slug>/.
  // Returns { ok, dir, assets } — the WordPress Landing importer (same machine) reads that dir and creates the
  // section→column→code_block iframe page. For a WebGL/three.js scroll-experience the deterministic converter
  // can't decompose, this grabs it as-is so it runs identically.
  if (u.pathname === '/mirror') {
    const target = (u.searchParams.get('url') || '').trim();
    if (!/^https?:\/\//i.test(target)) { json(res, 400, { error: 'Provide a valid http(s) URL.' }); return; }
    mkdirSync(CAPTURE_OUT, { recursive: true });
    const dir = join(CAPTURE_OUT, 'mirror-' + siteSlug(target));
    console.log('[mirror]', target, '→', dir);
    markActive(target, 'running');
    const child = spawn(process.execPath, [MIRROR, target, dir], { stdio: 'inherit' });
    child.on('error', (e) => { markActive(target, 'error'); json(res, 500, { error: e.message }); });
    child.on('exit', (code) => {
      markActive(target, 'done');
      if (code !== 0) { json(res, 500, { error: 'Mirror failed (the page may not have loaded).' }); return; }
      let assets = 0;
      try { assets = readdirSync(join(dir, 'assets')).length; } catch { /* none */ }
      // ?zip=1 — send the mirrored FILES (index.html + assets/ + manifest.json) as a .zip instead of a local
      // folder path. A WordPress site hosted elsewhere cannot read this machine's disk: the Site Converter's
      // browser fetches the zip and uploads it to the site.
      if (u.searchParams.get('zip') === '1') {
        try {
          const files = [];
          const walk = (d, rel) => {
            for (const name of readdirSync(d)) {
              const abs = join(d, name), r = rel ? rel + '/' + name : name;
              if (statSync(abs).isDirectory()) walk(abs, r); else files.push({ name: r, data: readFileSync(abs) });
            }
          };
          walk(dir, '');
          const zip = makeZip(files);
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="mirror.zip"', 'Content-Length': zip.length, 'X-Mirror-Assets': String(assets) });
          res.end(zip);
        } catch (e) { json(res, 500, { error: 'Could not zip the mirror: ' + e.message }); }
        return;
      }
      json(res, 200, { ok: true, dir, assets, index: join(dir, 'index.html') });
    });
    return;
  }

  json(res, 404, { error: 'not found' });
};
const __server = createServer(__handler);
// If an OLDER capture-service instance is still holding the port (the classic "I re-ran
// the launcher (start.bat) but the old window was still open, so the new process crashed on EADDRINUSE and the
// STALE routes kept serving" trap — which reads to the user as a feature that's "not found"), evict it and
// take over, so a restart ACTUALLY loads the new code.
let __evictTries = 0;
__server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE' && __evictTries < 1) {
    __evictTries++;
    console.log(`  ⚠ Port ${PORT} held by an older capture-service instance — evicting it so this (newer) one can take over…`);
    try {
      if (process.platform === 'win32') {
        spawnSync('cmd', ['/c', `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${PORT} ^| findstr LISTENING') do taskkill /F /PID %a`], { stdio: 'ignore' });
      } else {
        spawnSync('sh', ['-c', `lsof -ti tcp:${PORT} | xargs kill 2>/dev/null`], { stdio: 'ignore' });
      }
    } catch { /* best-effort */ }
    setTimeout(() => { try { __server.listen(PORT); } catch { /* */ } }, 700);
  } else {
    console.error('  capture-service server error:', (e && e.message) || e);
    process.exit(1);
  }
});
__server.listen(PORT, () => {
  // The same service on a secure local address, for Safari (studio-https.mjs).
  import('./studio-https.mjs').then((m) => m.startHttps(__handler)).catch(() => {});
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
