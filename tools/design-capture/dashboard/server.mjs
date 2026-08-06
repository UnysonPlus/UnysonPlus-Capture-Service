// UnysonPlus Converter — live dashboard server.
// A dependency-free local front-end for the deterministic site converter: enter a URL, watch
// every pipeline stage run in real time (the tool writes progress.json / progress.jsonl as it
// goes), then inspect the captured design tokens, the per-section conversion report, and a
// source-vs-result comparison. Run:  node dashboard/server.mjs [--out <capture-out dir>] [--port 4600]
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE_MJS = join(HERE, '..', 'capture.mjs');

const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const OUT = arg('--out', process.env.CAPTURE_OUT || 'D:/Web Dev/capture-out');
const PORT = Number(arg('--port', process.env.PORT || 4600));

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript' };
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

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

const running = new Map(); // slug -> child process

const server = createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(u.pathname);

  if (path === '/' || path === '/index.html') {
    try { res.writeHead(200, { 'content-type': MIME['.html'] }); res.end(readFileSync(join(HERE, 'index.html'))); }
    catch { res.writeHead(500); res.end('index.html missing'); }
    return;
  }
  if (path === '/api/sites') return json(res, { out: OUT, sites: listSites() });
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

  let m;
  if ((m = path.match(/^\/api\/site\/([^/]+)\/progress$/))) return json(res, readJson(join(OUT, m[1], 'progress.json')) || { status: 'unknown', steps: [] });
  if ((m = path.match(/^\/api\/site\/([^/]+)\/config$/)))   return json(res, readJson(join(OUT, m[1], 'design-config.json')) || {});
  if ((m = path.match(/^\/api\/site\/([^/]+)\/report$/)))   return json(res, { rows: parseReport(join(OUT, m[1])) || [] });
  if ((m = path.match(/^\/artifact\/([^/]+)\/(.+)$/))) {
    const f = join(OUT, m[1], m[2].replace(/\.\./g, ''));
    if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(readFileSync(f));
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

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  UnysonPlus Converter dashboard`);
  console.log(`  ▸ http://localhost:${PORT}`);
  console.log(`  ▸ watching: ${OUT}\n`);
});
