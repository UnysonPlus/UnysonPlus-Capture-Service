// UnysonPlus Converter — live dashboard server.
// A dependency-free local front-end for the deterministic site converter: enter a URL, watch
// every pipeline stage run in real time (the tool writes progress.json / progress.jsonl as it
// goes), then inspect the captured design tokens, the per-section conversion report, and a
// source-vs-result comparison. Run:  node dashboard/server.mjs [--out <capture-out dir>] [--port 4600]
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE_MJS = join(HERE, '..', 'capture.mjs');
const BENCHMARK_MJS = join(HERE, '..', 'benchmark-models.mjs');

// Run log — mirror console output into the Dev Kit's per-run log (UPWK_LOG), so the dashboard's
// activity lands in the SAME single file as the capture service. No-op when UPWK_LOG is unset.
const UPWK_LOG = process.env.UPWK_LOG || '';
if (UPWK_LOG) {
  const fmt = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  const tee = (tag, orig) => (...args) => {
    orig(...args);
    try { appendFileSync(UPWK_LOG, `[${new Date().toISOString()}] [dashboard]${tag} ${args.map(fmt).join(' ')}\n`); } catch { /* never break on logging */ }
  };
  console.log = tee('', console.log.bind(console));
  console.error = tee(' ERROR', console.error.bind(console));
}

const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const OUT = arg('--out', process.env.CAPTURE_OUT || 'D:/Web Dev/capture-out');
const PORT = Number(arg('--port', process.env.PORT || 4600));

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript' };
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// STALE-RUNNING GUARD. capture.mjs heartbeats `updatedAt` every ~3s while a capture runs, so a `running`
// progress whose updatedAt has gone cold means the capture PROCESS died (crash / kill / power loss) without
// writing a terminal state. Without this the dashboard would poll `running` forever. If updatedAt is older
// than the threshold, report `stalled` so the UI stops polling and shows the failure instead of hanging.
const PROGRESS_STALE_MS = Math.max(15000, Number(process.env.PROGRESS_STALE_MS) || 30000);
function progressWithStaleGuard(prog) {
  if (!prog || typeof prog !== 'object') return { status: 'unknown', steps: [] };
  if (prog.status === 'running') {
    const last = Number(prog.updatedAt || prog.startedAt || 0);
    if (last && (Date.now() - last) > PROGRESS_STALE_MS) {
      return { ...prog, status: 'stalled', error: prog.error || 'The capture stopped responding (process ended without finishing).' };
    }
  }
  return prog;
}
// Version of the CODE THIS PROCESS is running — captured ONCE at startup (NOT re-read per request), so a
// stale running server reports the version it started with. ensure-open compares this against the shipped
// package.json to decide reuse-vs-restart; re-reading per request made a stale server always look current,
// so its old code (missing new routes like /source-view) never got restarted.
const DASH_CODE_VERSION = (() => { try { return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version || ''; } catch { return ''; } })();

// ── Destination WordPress target (install-into-WP feature) ─────────────────────────────
// The server OWNS the {url, token} for the destination WP the converted site is installed onto.
// Stored next to the dashboard as wp-target.json. The token is NEVER returned to the browser —
// the server relays convert/ping calls itself (browser stays off cross-origin), so only the url +
// a token_set boolean ever leave the server.
const WP_TARGET_FILE = join(HERE, 'wp-target.json');
function readWpTarget() { const t = readJson(WP_TARGET_FILE); return { url: (t && t.url) || '', token: (t && t.token) || '' }; }
function saveWpTarget(t) { try { writeFileSync(WP_TARGET_FILE, JSON.stringify({ url: t.url || '', token: t.token || '' }, null, 2)); return true; } catch { return false; } }
// Build the destination REST URL — trim trailing slashes, then append the ?rest_route= form (works on
// any install, pretty-permalinks or not).
// Keep the trailing slash before `?rest_route=` — a bare `…/scdrift?rest_route=…` 301-redirects to the
// slashed form, and fetch() downgrades a followed 301 POST to GET (dropping the body), so the POST-only
// convert route 404s ("no route matching URL and request method"). The slash avoids the redirect.
function wpRestUrl(base, route) { return String(base || '').replace(/\/+$/, '') + '/?rest_route=' + route; }

// A capture-out subdir is a "site" if it has any of our artifacts.
function listSites() {
  if (!existsSync(OUT)) return [];
  return readdirSync(OUT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = join(OUT, d.name);
      const prog = readJson(join(dir, 'progress.json'));
      const cfg = readJson(join(dir, 'design-config.json'));
      let mtime = 0; try { mtime = statSync(dir).mtimeMs; } catch { /* */ }
      return {
        slug: d.name,
        url: (prog && prog.url) || '',
        status: (prog && prog.status) || (existsSync(join(dir, 'design-config.json')) ? 'done' : 'unknown'),
        updatedAt: (prog && prog.updatedAt) || mtime,
        title: (cfg && cfg.theme && cfg.theme.name) || d.name,
        hasScreenshot: existsSync(join(dir, 'full.png')),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Parse the conversion-report CSV → rows of {section, decision, role, mapped, fallback, opportunity, why, text}.
function parseReport(dir) {
  const p = join(dir, 'conversion-report.csv');
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const parseLine = (line) => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') { q = false; } else cur += c; } else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } } out.push(cur); return out; };
  const head = parseLine(lines[0]);
  const idx = (k) => head.indexOf(k);
  return lines.slice(1).map((l) => { const c = parseLine(l); return {
    section: c[idx('s_index')], decision: c[idx('s_decision')], s_class: c[idx('s_class')],
    role: c[idx('role')], detected: c[idx('detected')], mapped: c[idx('mapped')],
    fallback: c[idx('fallback')] === 'yes', opportunity: c[idx('opportunity')] === 'yes',
    styling_drop: c[idx('s_styling_drop')] === 'yes', why: c[idx('why')], text: c[idx('text')],
  }; });
}

// Benchmark history reader + leaderboard aggregation — a small LOCAL reimplementation so importing
// benchmark-models.mjs (which would run the benchmark on load / pull in the AI deps) is avoided.
// Reads <OUT>/benchmark-history.json = { version, runs:[ {ts,iso,model,score,valid,seconds,…} ] }.
function benchmarkHistory() {
  const db = readJson(join(OUT, 'benchmark-history.json'));
  return db && Array.isArray(db.runs) ? db.runs : [];
}
function benchmarkLeaderboard() {
  const runs = benchmarkHistory();
  const by = new Map();
  for (const r of runs) {
    if (!r || !r.model) continue;
    let a = by.get(r.model);
    if (!a) { a = { model: r.model, runs: 0, sumScore: 0, sumSeconds: 0, best_score: 0, latest_score: 0, last_ts: 0, last_iso: '', ever_valid: false, service_version: '' }; by.set(r.model, a); }
    a.runs++; a.sumScore += Number(r.score) || 0; a.sumSeconds += Number(r.seconds) || 0;
    if ((Number(r.score) || 0) > a.best_score) a.best_score = Number(r.score) || 0;
    if ((r.ts || 0) >= a.last_ts) { a.last_ts = r.ts || 0; a.latest_score = Number(r.score) || 0; a.last_iso = r.iso || ''; a.service_version = r.service_version || a.service_version; }
    if (r.valid) a.ever_valid = true;
  }
  return [...by.values()].map((a) => ({
    model: a.model, best_score: a.best_score, latest_score: a.latest_score,
    avg_score: a.runs ? Math.round(a.sumScore / a.runs) : 0, runs: a.runs,
    avg_seconds: a.runs ? +(a.sumSeconds / a.runs).toFixed(1) : 0, last_iso: a.last_iso, ever_valid: a.ever_valid, service_version: a.service_version,
  })).sort((x, y) => y.best_score - x.best_score || x.avg_seconds - y.avg_seconds);
}

const running = new Map(); // slug -> child process

// Dashboard-driven benchmark run — mirrors the /api/convert spawn+track pattern, but for
// `node benchmark-models.mjs --models <csv>`. Only ONE run at a time; stdout/stderr lines are
// captured into `benchRun.log` (capped) so the UI can show a live log + poll for completion.
let benchRun = { running: false, models: [], startedAt: 0, endedAt: 0, code: null, log: [] };
const BENCH_LOG_CAP = 200;
function benchPushLog(chunk) {
  const lines = String(chunk).split(/\r?\n/).filter((l) => l.length);
  for (const l of lines) benchRun.log.push(l);
  if (benchRun.log.length > BENCH_LOG_CAP) benchRun.log = benchRun.log.slice(-BENCH_LOG_CAP);
}
// Community-submitted benchmark scores (curated from the Google Form), shipped in guides/.
function communityBenchmarks() {
  const data = readJson(join(HERE, '..', 'guides', 'community-benchmarks.json'));
  return data && Array.isArray(data.results) ? data : { version: 1, updated: '', note: '', results: [] };
}

// Run-log access for the dashboard "View log" link. Prefers the file the launcher set via UPWK_LOG;
// else probes for the kit's logs/ dir at a few candidate depths. Returns the TAIL of a basename-guarded
// run-*.log so a failed conversion can be diagnosed from the browser, without the terminal window.
function resolveLogsDir() {
  const env = (process.env.UPWK_LOG || '').trim();
  if (env) { try { const d = dirname(env); if (existsSync(d)) return d; } catch { /* */ } }
  for (const rel of ['../../../../../logs', '../../../../logs', '../../../logs', '../../logs']) {
    const d = join(HERE, rel);
    try { if (existsSync(d) && statSync(d).isDirectory()) return d; } catch { /* */ }
  }
  return '';
}
function listLogFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => /^run-[\w-]+\.log$/i.test(f))
      .map((f) => { const s = statSync(join(dir, f)); return { name: f, mtime: s.mtimeMs, size: s.size }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
const LOG_TAIL_BYTES = 256 * 1024;

const server = createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(u.pathname);

  if (path === '/' || path === '/index.html') {
    try { res.writeHead(200, { 'content-type': MIME['.html'] }); res.end(readFileSync(join(HERE, 'index.html'))); }
    catch { res.writeHead(500); res.end('index.html missing'); }
    return;
  }
  if (path === '/api/sites') return json(res, { out: OUT, sites: listSites() });
  // Run log — list the recent run-*.log files + return the tail of the active (or requested) one.
  if (path === '/api/logs') {
    const dir = resolveLogsDir();
    if (!dir) return json(res, { ok: false, error: 'No run-log directory found. Launch via start-converter (the Dev Kit launcher records each run to logs/).', files: [] });
    const files = listLogFiles(dir);
    let name = (u.searchParams.get('file') || '').replace(/[^\w.-]/g, '');
    if (!/^run-[\w-]+\.log$/i.test(name) || !files.some((f) => f.name === name)) {
      const envName = (process.env.UPWK_LOG || '').split(/[\\/]/).pop();
      name = (envName && files.some((f) => f.name === envName)) ? envName : (files[0] && files[0].name) || '';
    }
    let content = '';
    if (name) {
      try {
        const p = join(dir, name); const s = statSync(p);
        const start = Math.max(0, s.size - LOG_TAIL_BYTES);
        content = readFileSync(p).slice(start).toString('utf8');
        if (start > 0) content = '…(truncated to last 256 KB)…\n' + content;
      } catch (e) { content = 'Could not read log: ' + e.message; }
    }
    return json(res, { ok: true, dir, active: name, files: files.map((f) => f.name), content });
  }
  // Version of the dashboard CODE currently running — ensure-open.mjs compares this against the local
  // shipped package.json to decide reuse (same) vs. kill+restart (older/stale) vs. start (absent).
  if (path === '/api/dashboard-version') {
    // Expose OUT too: a running dashboard bound to a DIFFERENT capture-out than the current launcher must be
    // restarted (else it reads a dir nothing is written to → live progress never updates). ensure-open compares.
    return json(res, { version: DASH_CODE_VERSION, out: OUT }); // startup-captured, so a stale server is detectable
  }
  // Accumulated model-benchmark leaderboard + recent runs (from benchmark-history.json).
  if (path === '/api/benchmarks') return json(res, { leaderboard: benchmarkLeaderboard(), recent: benchmarkHistory().slice(-20).reverse() });
  // Community-submitted benchmark results (curated from the Google Form) — shipped seed JSON.
  if (path === '/api/community-benchmarks') return json(res, communityBenchmarks());
  // Live status of a dashboard-driven benchmark run.
  if (path === '/api/benchmark/run-status' && req.method === 'GET') {
    return json(res, { running: benchRun.running, models: benchRun.models, startedAt: benchRun.startedAt, endedAt: benchRun.endedAt, code: benchRun.code, log: benchRun.log.slice(-40) });
  }
  // Start a benchmark run (no terminal). Body: { models: ["qwen3:8b","claude-code"] } (empty = all).
  if (path === '/api/benchmark/run' && req.method === 'POST') {
    if (benchRun.running) return json(res, { error: 'A benchmark is already running.' }, 409);
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let models = []; try { const b = JSON.parse(body || '{}'); if (Array.isArray(b.models)) models = b.models.map((m) => String(m).trim()).filter(Boolean); } catch { /* */ }
      const args = [BENCHMARK_MJS];
      if (models.length) args.push('--models', models.join(','));
      benchRun = { running: true, models, startedAt: Date.now(), endedAt: 0, code: null, log: [] };
      // Pass CAPTURE_OUT: OUT so history lands where /api/benchmarks reads.
      const child = spawn(process.execPath, args, { cwd: join(HERE, '..'), env: { ...process.env, CAPTURE_OUT: OUT }, detached: false });
      child.stdout.on('data', (d) => benchPushLog(d));
      child.stderr.on('data', (d) => benchPushLog(d));
      child.on('error', (e) => { benchPushLog('spawn error: ' + e.message); benchRun.running = false; benchRun.code = -1; benchRun.endedAt = Date.now(); });
      child.on('exit', (code) => { benchRun.running = false; benchRun.code = code; benchRun.endedAt = Date.now(); });
      return json(res, { started: true, models });
    });
    return;
  }
  // The full model-research report (ships in guides/); rendered readably in the browser.
  if (path === '/report/model-research') {
    const f = join(HERE, '..', 'guides', 'local-ai-model-research.md');
    if (!existsSync(f)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Model research report not found.'); }
    const md = readFileSync(f, 'utf8');
    const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Model research report</title>
<style>body{margin:0;background:oklch(0.165 0.014 245);color:oklch(0.95 0.004 245);font:15px/1.65 "Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:44px 26px 90px}pre{white-space:pre-wrap;word-wrap:break-word;font:13px/1.6 ui-monospace,"Cascadia Code",Menlo,Consolas,monospace;background:oklch(0.205 0.014 245);border:1px solid oklch(0.31 0.015 245);border-radius:12px;padding:22px 24px}a{color:oklch(0.74 0.17 158)}</style>
<div class="wrap"><p><a href="/">← Back to dashboard</a></p><pre id="md"></pre></div>
<script>document.getElementById('md').textContent=${JSON.stringify(md)};</script>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page);
  }
  if (path === '/api/active') return json(res, readJson(join(OUT, '_active.json')) || {});
  if (path === '/api/ai') return json(res, readJson(join(OUT, '_ai.json')) || {}); // what Claude is doing during an AI refine
  // Is the capture SERVICE (the converter tool WordPress talks to) up right now?
  if (path === '/api/service-health') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    fetch(`http://localhost:${svcPort}/health`, { signal: AbortSignal.timeout(900) })
      .then((r) => r.json())
      .then((h) => json(res, { up: true, port: svcPort, version: h && h.version, aiReady: !!(h && h.aiReady), aiBackend: h && h.aiBackend }))
      .catch(() => json(res, { up: false, port: svcPort }));
    return;
  }

  // Experimental local-AI (Ollama) picker — proxied to the capture service.
  if (path === '/api/local-ai' && req.method === 'GET') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    fetch(`http://localhost:${svcPort}/local-ai`, { signal: AbortSignal.timeout(3500) })
      .then((r) => r.json()).then((s) => json(res, s))
      .catch(() => json(res, { installed: false, up: false, selected: '', pulled: [], shortlist: [], serviceDown: true }));
    return;
  }
  if (path === '/api/local-ai/select' && req.method === 'POST') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      fetch(`http://localhost:${svcPort}/local-ai/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body || '{}', signal: AbortSignal.timeout(3500) })
        .then((r) => r.json()).then((s) => json(res, s))
        .catch((e) => json(res, { error: 'Capture service not reachable: ' + e.message }, 502));
    });
    return;
  }
  if (path === '/api/local-ai/pull' && req.method === 'POST') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      fetch(`http://localhost:${svcPort}/local-ai/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body || '{}', signal: AbortSignal.timeout(4000) })
        .then((r) => r.json()).then((s) => json(res, s))
        .catch((e) => json(res, { error: 'Capture service not reachable: ' + e.message }, 502));
    });
    return;
  }
  if (path === '/api/local-ai/pull-status' && req.method === 'GET') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    fetch(`http://localhost:${svcPort}/local-ai/pull-status`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.json()).then((s) => json(res, s))
      .catch(() => json(res, { model: '', status: 'idle', percent: 0, done: true }));
    return;
  }
  if (path === '/api/local-ai/delete' && req.method === 'POST') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      fetch(`http://localhost:${svcPort}/local-ai/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body || '{}', signal: AbortSignal.timeout(15000) })
        .then((r) => r.json()).then((s) => json(res, s))
        .catch((e) => json(res, { error: 'Capture service not reachable: ' + e.message }, 502));
    });
    return;
  }
  // "Test the model" — proxied to the capture service. Runs the selected local model on a short prompt.
  if (path === '/api/local-ai/test' && req.method === 'POST') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      fetch(`http://localhost:${svcPort}/local-ai/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body || '{}', signal: AbortSignal.timeout(70000) })
        .then(async (r) => { const j = await r.json().catch(() => ({})); json(res, j, r.status); })
        .catch((e) => json(res, { error: 'Capture service not reachable: ' + e.message }, 502));
    });
    return;
  }

  // Chat view — proxied to the capture service. Persistent multi-turn chat on the active AI backend.
  if (path === '/api/local-ai/chat-history' && req.method === 'GET') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    fetch(`http://localhost:${svcPort}/local-ai/chat-history`, { signal: AbortSignal.timeout(3500) })
      .then((r) => r.json()).then((s) => json(res, s))
      .catch(() => json(res, { ok: true, messages: [] }));
    return;
  }
  if (path === '/api/local-ai/chat-clear' && req.method === 'POST') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    fetch(`http://localhost:${svcPort}/local-ai/chat-clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3500) })
      .then((r) => r.json()).then((s) => json(res, s))
      .catch((e) => json(res, { error: 'Capture service not reachable: ' + e.message }, 502));
    return;
  }
  if (path === '/api/local-ai/chat' && req.method === 'POST') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      fetch(`http://localhost:${svcPort}/local-ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body || '{}', signal: AbortSignal.timeout(180000) })
        .then(async (r) => { const j = await r.json().catch(() => ({})); json(res, j, r.status); })
        .catch((e) => json(res, { error: 'Capture service not reachable: ' + e.message }, 502));
    });
    return;
  }

  // User-directed "prompt the AI to change something" — proxied to the capture service (/ai-instruct).
  // Body: { prompt, page_html?, custom_css?, source_html? } → { ok, kind, css, structural_note, explanation, model }.
  if (path === '/api/ai-instruct' && req.method === 'POST') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 4e6) req.destroy(); });
    req.on('end', () => {
      fetch(`http://localhost:${svcPort}/ai-instruct`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body || '{}', signal: AbortSignal.timeout(360000) })
        .then(async (r) => { const j = await r.json().catch(() => ({})); json(res, j, r.status); })
        .catch((e) => json(res, { error: 'Capture service not reachable: ' + e.message }, 502));
    });
    return;
  }
  // Persist the accumulated AI tweak CSS for a conversion → <capture-out>/<slug>/ai-tweak.css (the "Keep"
  // action). Body: { slug, css }. The dashboard owns OUT, so it writes the file directly.
  if (path === '/api/ai-tweak-css' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let slug = '', css = ''; try { const b = JSON.parse(body || '{}'); slug = String(b.slug || '').trim(); css = String(b.css || ''); } catch { /* */ }
      // Guard the slug so it can't escape the capture-out dir.
      if (!slug || /[\\/]|\.\./.test(slug)) return json(res, { error: 'Invalid slug.' }, 400);
      const dir = join(OUT, slug);
      if (!existsSync(dir)) return json(res, { error: 'Unknown conversion.' }, 404);
      try {
        if (css.trim()) { writeFileSync(join(dir, 'ai-tweak.css'), css); }
        else { try { writeFileSync(join(dir, 'ai-tweak.css'), ''); } catch { /* */ } }
        return json(res, { ok: true, slug, bytes: Buffer.byteLength(css) });
      } catch (e) { return json(res, { error: 'Could not save: ' + e.message }, 500); }
    });
    return;
  }

  // Self-verify (drift %) + AI-fix loop — proxied to the capture service (these can take a while).
  if ((path === '/api/verify' || path === '/api/refine-visual' || path === '/api/refine-chrome') && req.method === 'POST') {
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    const upstream = path === '/api/verify' ? '/verify' : (path === '/api/refine-chrome' ? '/refine-chrome' : '/refine-visual');
    const ms = path === '/api/verify' ? 90000 : 360000; // refine iterates + calls the model
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      fetch(`http://localhost:${svcPort}${upstream}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body || '{}', signal: AbortSignal.timeout(ms) })
        .then((r) => r.json()).then((s) => json(res, s))
        .catch((e) => json(res, { error: 'Capture service: ' + e.message }, 502));
    });
    return;
  }

  let m;
  if ((m = path.match(/^\/api\/site\/([^/]+)\/progress$/))) return json(res, progressWithStaleGuard(readJson(join(OUT, m[1], 'progress.json'))));
  if ((m = path.match(/^\/api\/site\/([^/]+)\/config$/)))   return json(res, readJson(join(OUT, m[1], 'design-config.json')) || {});
  if ((m = path.match(/^\/api\/site\/([^/]+)\/report$/)))   return json(res, { rows: parseReport(join(OUT, m[1])) || [] });
  if ((m = path.match(/^\/artifact\/([^/]+)\/(.+)$/))) {
    const f = join(OUT, m[1], m[2].replace(/\.\./g, ''));
    if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(readFileSync(f));
  }

  // ── Destination WordPress target + relay routes ──────────────────────────────────────
  // Return the saved target — url + whether a token is set (NEVER the token itself).
  if (path === '/api/wp-target' && req.method === 'GET') {
    const t = readWpTarget();
    return json(res, { url: t.url, token_set: !!t.token });
  }
  // Save the target. { url, token } — url must be http(s); token '' keeps the existing one.
  if (path === '/api/wp-target' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let url = '', token = ''; try { const b = JSON.parse(body || '{}'); url = String(b.url || '').trim(); token = String(b.token || ''); } catch { /* */ }
      if (!/^https?:\/\//i.test(url)) return json(res, { error: 'Enter a valid http(s) WordPress URL.' }, 400);
      const cur = readWpTarget();
      const next = { url, token: token.trim() ? token.trim() : cur.token }; // empty token = keep existing
      if (!saveWpTarget(next)) return json(res, { error: 'Could not save the target.' }, 500);
      return json(res, { ok: true, url: next.url, token_set: !!next.token });
    });
    return;
  }
  // Test the connection to the destination WP — ping the plugin's REST route with the token header.
  // Optional body { url, token } tests unsaved values; else use the saved target.
  if (path === '/api/wp-ping' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      const saved = readWpTarget();
      let url = saved.url, token = saved.token;
      try { const b = JSON.parse(body || '{}'); if (b.url && String(b.url).trim()) url = String(b.url).trim(); if (b.token && String(b.token).trim()) token = String(b.token).trim(); } catch { /* */ }
      if (!/^https?:\/\//i.test(url)) return json(res, { ok: false, error: 'Set a valid http(s) WordPress URL first.' }, 400);
      if (!token) return json(res, { ok: false, error: 'No token — paste it from wp-admin → Site Converter.' }, 400);
      fetch(wpRestUrl(url, '/fw-sc/v1/ping'), { headers: { 'X-FW-SC-Token': token }, signal: AbortSignal.timeout(15000) })
        .then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (r.status === 401) return json(res, { ok: false, status: 401, error: 'Wrong or missing token — copy it from wp-admin → Site Converter.' });
          if (!r.ok) return json(res, { ok: false, status: r.status, error: (j && j.message) || ('WordPress returned HTTP ' + r.status) });
          return json(res, { ok: true, site: j.site, theme: j.theme, version: j.version });
        })
        .catch((e) => json(res, { ok: false, error: 'Could not reach ' + url + ' — is that WordPress running? (' + e.message + ')' }));
    });
    return;
  }
  // Convert a source URL + install it onto the SAVED destination WP. Server-side relay so the browser
  // never makes the cross-origin call. Body { source_url, dry_run? } → pass through the plugin result.
  if (path === '/api/install-to-wp' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let source_url = '', dry_run = false, hifi_css = true;
      try { const b = JSON.parse(body || '{}'); source_url = String(b.source_url || '').trim(); dry_run = !!b.dry_run; hifi_css = (b.hifi_css === undefined) ? true : !!b.hifi_css; } catch { /* */ }
      if (!/^https?:\/\//i.test(source_url)) return json(res, { error: 'Enter a valid http(s) source URL.' }, 400);
      const t = readWpTarget();
      if (!/^https?:\/\//i.test(t.url) || !t.token) return json(res, { error: 'Set the destination WordPress + token in Settings first.' }, 400);

      // RENDER FIRST: ask the local capture service to render the source in headless Chrome and hand
      // back the FULLY RENDERED HTML, so client-rendered / SPA sites (wegic, etc.) convert from their
      // real DOM instead of the empty SPA shell a raw wp_remote_get would return. If the render fails
      // or comes back too small, fall back to letting WordPress raw-fetch the URL (current behavior).
      const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
      const captureUrl = `http://localhost:${svcPort}/capture?url=${encodeURIComponent(source_url)}&html=1`;
      const postToWp = (rendered_html, render_note) => {
        fetch(wpRestUrl(t.url, '/fw-sc/v1/convert'), {
          method: 'POST',
          headers: { 'X-FW-SC-Token': t.token, 'content-type': 'application/json' },
          body: JSON.stringify({ source_url, dry_run, hifi_css, rendered_html: rendered_html || '' }),
          signal: AbortSignal.timeout(180000),
        })
          .then(async (r) => {
            const j = await r.json().catch(() => ({}));
            if (r.status === 401) return json(res, { error: 'Wrong or missing token — copy it from wp-admin → Site Converter.' }, 401);
            if (j && typeof j === 'object') {
              j.rendered = !!(rendered_html && rendered_html.length);
              j.rendered_bytes = rendered_html ? rendered_html.length : 0;
              if (render_note) j.render_note = render_note;
            }
            return json(res, j, r.status);
          })
          .catch((e) => json(res, { error: 'Could not reach ' + t.url + ' — is that WordPress running? (' + e.message + ')' }, 502));
      };
      // SPA render can take ~30–60s; give it 90s.
      fetch(captureUrl, { signal: AbortSignal.timeout(90000) })
        .then(async (r) => {
          const html = r.ok ? await r.text() : '';
          if (html && html.length >= 500) return postToWp(html, null);
          return postToWp('', 'Capture render returned too little HTML — used a raw fetch (may be incomplete for JavaScript sites).');
        })
        .catch((e) => postToWp('', 'Could not reach the capture renderer (' + e.message + ') — used a raw fetch (may be incomplete for JavaScript sites).'));
    });
    return;
  }

  // POST /api/pen-convert — turn a pasted pen (HTML/CSS/JS) into an INSTALLABLE shortcode package (.zip),
  // ENTIRELY LOCALLY. No WordPress destination / token: the capture service renders the pen, generates a
  // shortcode folder (config/options/view/static + scoped css/js) and returns it base64-zipped for the
  // browser to download. A thin pass-through to the capture service's /pen-shortcode.
  if (path === '/api/pen-convert' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8e6) { try { req.destroy(); } catch { /* */ } } });
    req.on('error', () => { try { json(res, { error: 'Request stream error.' }, 400); } catch { /* */ } });
    req.on('end', () => {
      const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
      fetch(`http://localhost:${svcPort}/pen-shortcode`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: body || '{}', signal: AbortSignal.timeout(180000),
      })
        .then(async (r) => {
          const j = await r.json().catch(() => ({ error: 'The converter returned an unreadable response.' }));
          // A 404 "not found" means the RUNNING capture service predates the /pen-shortcode route — the
          // dashboard HTML hot-reloads from disk but the Node process keeps its old routes until restarted.
          if (r.status === 404 && j && /not found/i.test(String(j.error || ''))) {
            return json(res, { error: 'The capture service is running an older version. Close and re-run start-converter.bat (restart the service), then try again — this feature needs the restarted process.' }, 409);
          }
          return json(res, j, r.status);
        })
        .catch((e) => json(res, { error: 'Could not reach the capture service (' + e.message + '). Is it running?' }, 502));
    });
    return;
  }

  if (path === '/api/convert' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let url = ''; try { url = (JSON.parse(body || '{}').url || '').trim(); } catch { /* */ }
      if (!/^https?:\/\//i.test(url)) return json(res, { error: 'Enter a valid http(s) URL.' }, 400);
      const child = spawn(process.execPath, [CAPTURE_MJS, url, OUT], { cwd: join(HERE, '..'), detached: false });
      child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
      const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
      running.set(slug, child);
      child.on('exit', () => running.delete(slug));
      return json(res, { started: true, url });
    });
    return;
  }

  // Serve the source-side inspector script (injected into /source-view pages).
  if (path === '/source-inspector.js') {
    try {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      return res.end(readFileSync(join(HERE, 'source-inspector.js')));
    } catch { res.writeHead(404); return res.end('source-inspector.js missing'); }
  }

  // ── SOURCE inspector view ────────────────────────────────────────────────────────────
  // Serve the captured SOURCE DOM (<OUT>/<slug>/rendered.html) same-origin so the injected
  // inspector can read it. Inject a <base> (source origin) so relative asset URLs still load,
  // a charset meta, and the source-inspector.js tag. Path-traversal-guarded: slug must be a
  // bare direct child dir name (alphanumerics / _ / - only).
  if (path === '/source-view') {
    const slug = (u.searchParams.get('slug') || '').trim();
    if (!slug || !/^[A-Za-z0-9_-]+$/.test(slug)) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Invalid slug.'); }
    const dir = join(OUT, slug);
    const file = join(dir, 'rendered.html');
    if (!existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('No rendered.html captured for this slug.'); }
    let html = '';
    try { html = readFileSync(file, 'utf8'); } catch (e) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Could not read rendered.html: ' + e.message); }
    // Strip the source's OWN <script> tags. rendered.html is a POST-RENDER snapshot (the content is
    // already baked into the DOM), but re-running the source's JS makes its SPA/client router re-hydrate
    // against the dashboard URL, not find a matching route, and REPLACE the content with the source's own
    // 404 page (header/footer stay, middle becomes "404"). We only want the static snapshot (+ its CSS +
    // data-sc-cs) plus our inspector — so remove all source scripts. Stylesheets/links/styles are kept.
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<script\b[^>]*\/>/gi, '');
    // Determine the source base URL (for the <base href>). Prefer progress.json .url, then the
    // design config .url — so the source's relative images/fonts resolve against its real origin.
    const srcUrl = (readJson(join(dir, 'progress.json')) || {}).url
      || (readJson(join(dir, 'design-capture.json')) || {}).url
      || (readJson(join(dir, 'design-config.json')) || {}).url || '';
    let baseOrigin = '';
    try { if (srcUrl) baseOrigin = new URL(srcUrl).origin; } catch { /* */ }
    // Only add a charset meta if the doc lacks one (avoid double-declaring, harmless but tidy).
    // IMPORTANT: the inspector <script> is injected BEFORE the <base> so its root-relative
    // src="/source-inspector.js" resolves against the DASHBOARD origin (localhost:4600), not the
    // source origin the <base> points at — otherwise it 404s cross-origin and never runs.
    const injectHead = (/<meta[^>]+charset/i.test(html) ? '' : '<meta charset="utf-8">')
      + `<script src="/source-inspector.js"></script>`
      + (baseOrigin ? `<base href="${baseOrigin}/">` : '');
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, (m) => m + injectHead);
    } else if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, injectHead + '</head>');
    } else if (/<html[^>]*>/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, (m) => m + '<head>' + injectHead + '</head>');
    } else {
      html = '<head>' + injectHead + '</head>' + html;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  // ── DIAGNOSTICS ──────────────────────────────────────────────────────────────────────
  // One-click health check: surfaces the exact problems that silently bite conversions —
  // a stale dashboard server, a down capture service, missing capture artifacts, an
  // unreachable/misconfigured destination WordPress, a missing conversion-map. Best-effort:
  // every check is guarded so one failure never throws the whole route.
  if (path === '/api/diagnostics' && req.method === 'GET') {
    const slug = (u.searchParams.get('slug') || '').trim();
    const svcPort = Number(process.env.CAPTURE_SERVICE_PORT || 8787);
    const checks = [];
    const push = (id, label, status, detail, hint) => checks.push({ id, label, status, detail: detail || '', hint: hint || '' });
    const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');

    // a. dashboard_code — THE HEADLINE CHECK. Startup-captured version vs. the CURRENT shipped package.json.
    try {
      const shipped = (readJson(join(HERE, '..', 'package.json')) || {}).version || '';
      if (DASH_CODE_VERSION && shipped && DASH_CODE_VERSION === shipped) {
        push('dashboard_code', 'Dashboard server', 'ok', `Running latest: v${DASH_CODE_VERSION}.`);
      } else if (DASH_CODE_VERSION && shipped && DASH_CODE_VERSION !== shipped) {
        push('dashboard_code', 'Dashboard server', 'fail',
          `Dashboard server is STALE (running v${DASH_CODE_VERSION}, shipped v${shipped}).`,
          'Restart it: kill the process on port 4600 and re-run start-converter.bat.');
      } else {
        push('dashboard_code', 'Dashboard server', 'warn',
          `Could not compare versions (running v${DASH_CODE_VERSION || '?'}, shipped v${shipped || '?'}).`,
          'If features look missing, restart the dashboard (kill port 4600, re-run start-converter.bat).');
      }
    } catch (e) { push('dashboard_code', 'Dashboard server', 'warn', 'Version check failed: ' + e.message); }

    // b. capture_service — is the converter tool WordPress talks to up on 8787?
    let svcCheck;
    try {
      svcCheck = fetch(`http://localhost:${svcPort}/health`, { signal: AbortSignal.timeout(1200) })
        .then((r) => { if (r.status === 200) { return r.json().catch(() => ({})).then((h) => push('capture_service', 'Capture service', 'ok', `Responding on :${svcPort}${h && h.version ? ' (v' + h.version + ')' : ''}.`)); }
          return push('capture_service', 'Capture service', 'warn', `Capture service returned HTTP ${r.status} on :${svcPort}.`, 'Restart start-converter.bat — new captures need it.'); })
        .catch(() => push('capture_service', 'Capture service', 'warn', `Capture service not responding on :${svcPort} — needed for new captures.`, 'Re-run start-converter.bat to bring it up.'));
    } catch (e) { push('capture_service', 'Capture service', 'warn', 'Health check failed: ' + e.message); svcCheck = Promise.resolve(); }

    // c. out_dir — the capture-out directory exists and is readable.
    try {
      if (existsSync(OUT)) push('out_dir', 'Capture-out directory', 'ok', OUT);
      else push('out_dir', 'Capture-out directory', 'fail', `Not found: ${OUT}`, 'Run a capture first, or pass --out <dir> when launching the dashboard.');
    } catch (e) { push('out_dir', 'Capture-out directory', 'fail', 'Check failed: ' + e.message); }

    // d. capture_artifacts — the per-slug files the inspectors depend on.
    try {
      const dir = slug ? join(OUT, slug) : '';
      if (!slug || !dir || !existsSync(dir)) {
        push('capture_artifacts', 'Capture artifacts', 'info', slug ? `No captured folder for "${slug}".` : 'No conversion selected.', slug ? 'Run Convert & install for this URL.' : 'Pick a conversion to check its artifacts.');
      } else {
        const stat = (name) => { try { const p = join(dir, name); if (!existsSync(p)) return null; return statSync(p).size; } catch { return null; } };
        const rh = stat('rendered.html'), pj = stat('pages.json'), cm = stat('conversion-map.json'), dc = stat('design-config.json');
        const parts = [];
        parts.push('rendered.html ' + (rh !== null ? fmtBytes(rh) : 'MISSING'));
        parts.push('pages.json ' + (pj !== null ? fmtBytes(pj) : 'MISSING'));
        let mapEntries = null;
        if (cm !== null) { const map = readJson(join(dir, 'conversion-map.json')); if (map) { mapEntries = Array.isArray(map) ? map.length : (Array.isArray(map.entries) ? map.entries.length : (map.map && Array.isArray(map.map) ? map.map.length : Object.keys(map).length)); } }
        parts.push('conversion-map.json ' + (cm !== null ? fmtBytes(cm) + (mapEntries !== null ? ` (${mapEntries} entries)` : '') : 'MISSING'));
        parts.push('design-config.json ' + (dc !== null ? fmtBytes(dc) : 'MISSING'));
        let status = 'ok', hint = '';
        if (rh === null) { status = 'warn'; hint = 'Source inspector unavailable — no rendered.html for this run. Re-run Convert & install.'; }
        if (cm === null) { status = 'warn'; hint = (hint ? hint + ' ' : '') + 'Converted inspector has no map — re-run Convert & install.'; }
        push('capture_artifacts', 'Capture artifacts', status,
          `${slug}: ` + parts.join(' · ') + (rh === null ? ' — Source inspector unavailable (no rendered.html).' : '') + (cm === null ? ' — Converted inspector has no map.' : ''),
          hint);
      }
    } catch (e) { push('capture_artifacts', 'Capture artifacts', 'warn', 'Check failed: ' + e.message); }

    // e. wp_target — destination WordPress reachability + conversion-map link presence.
    let wpCheck;
    try {
      const t = readWpTarget();
      if (!t.url) {
        push('wp_target', 'Destination WordPress', 'warn', 'Destination WordPress not set.', 'Set it in Settings (URL + token from wp-admin → Site Converter).');
        wpCheck = Promise.resolve();
      } else {
        const tokenNote = t.token ? '' : ' Token not set.';
        wpCheck = fetch(t.url, { redirect: 'follow', signal: AbortSignal.timeout(2500) })
          .then(async (r) => {
            const reach = `HTTP ${r.status}`;
            let html = ''; try { html = await r.text(); } catch { /* */ }
            const hasMap = /rel=["']unysonplus-conversion-map["']/i.test(html);
            let status = r.ok ? 'ok' : 'warn', hint = '';
            let detail = `${t.url} — reachable (${reach}).`;
            if (hasMap) detail += ' Conversion-map link present (inspector map ok).';
            else { status = (status === 'ok') ? 'warn' : status; detail += ' No conversion-map link found in the page.'; hint = 'Converted site has no conversion-map link — do a fresh Convert & install so the inspector works.'; }
            if (!t.token) { if (status === 'ok') status = 'warn'; detail += tokenNote; hint = (hint ? hint + ' ' : '') + 'Paste the token from wp-admin → Site Converter in Settings.'; }
            push('wp_target', 'Destination WordPress', status, detail, hint);
          })
          .catch((e) => push('wp_target', 'Destination WordPress', 'warn', `${t.url} — not reachable (${e.message}).${tokenNote}`, 'Is that WordPress running? Check the URL in Settings.'));
      }
    } catch (e) { push('wp_target', 'Destination WordPress', 'warn', 'Check failed: ' + e.message); wpCheck = Promise.resolve(); }

    // f. ports_note — informational: dashboard vs. WP-target origin (cross-origin iframe is expected).
    try {
      const t = readWpTarget();
      let wpOrigin = ''; try { if (t.url) wpOrigin = new URL(t.url).origin; } catch { /* */ }
      const dashOrigin = `http://localhost:${PORT}`;
      if (wpOrigin && wpOrigin !== dashOrigin) {
        push('ports_note', 'Ports / origins', 'info', `Dashboard on :${PORT}; WP target origin ${wpOrigin}.`, 'iframe is cross-origin; the inspector runs in-page via ?upw-inspect (this is expected).');
      } else {
        push('ports_note', 'Ports / origins', 'info', `Dashboard on :${PORT}. Capture service on :${svcPort}.`);
      }
    } catch (e) { push('ports_note', 'Ports / origins', 'info', 'note failed: ' + e.message); }

    // Wait on the two async network checks, then respond (best-effort — never throws).
    Promise.all([svcCheck, wpCheck]).then(() => {
      // Keep a stable order (checks may resolve out of order).
      const order = ['dashboard_code', 'capture_service', 'out_dir', 'capture_artifacts', 'wp_target', 'ports_note'];
      checks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      json(res, { generated: new Date().toISOString(), checks });
    }).catch(() => json(res, { generated: new Date().toISOString(), checks }));
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  UnysonPlus Converter dashboard`);
  console.log(`  ▸ http://localhost:${PORT}`);
  console.log(`  ▸ watching: ${OUT}\n`);
});
