// Auto-open the converter dashboard (http://localhost:4600) whenever a converter tool is used, and
// start the dashboard server itself if it isn't already running. Called from serve.mjs (when the
// capture service boots) and capture.mjs (when a CLI capture runs) — i.e. any time the AI Dev Kit
// drives the converter, the live dashboard pops open in a browser tab.
//
// Opt out entirely with DASHBOARD_AUTO_OPEN=0. Override the port with DASHBOARD_PORT (default 4600).
// A short-lived lockfile stops a fresh tab from opening on every rapid tool start (30-min window).
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT || 4600);
const DASH_URL = `http://localhost:${PORT}`;
// The version of the dashboard CODE shipped here — used to detect a stale running dashboard.
function localVersion() {
  try { return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}
// Keep the lockfile inside the kit's output dir (CAPTURE_OUT) when set, so deleting the kit leaves
// nothing behind; fall back to the system temp dir only when it isn't configured.
const LOCK = join(process.env.CAPTURE_OUT || tmpdir(), 'upw-dashboard-opened.json');
const REOPEN_MS = 30 * 60 * 1000; // don't spam a new tab within 30 minutes of the last open

async function isUp(url, ms = 900) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return !!r;
  } catch { return false; }
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') { spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref(); }
    else if (process.platform === 'darwin') { spawn('open', [url], { detached: true, stdio: 'ignore' }).unref(); }
    else { spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref(); }
  } catch { /* best-effort; never block the tool */ }
}

function recentlyOpened() {
  try { const o = JSON.parse(readFileSync(LOCK, 'utf8')); return o && o.at && (Date.now() - o.at) < REOPEN_MS; } catch { return false; }
}
function markOpened() { try { writeFileSync(LOCK, JSON.stringify({ at: Date.now() })); } catch { /* */ } }

// Kill whatever process is LISTENING on `port` (used to restart a stale dashboard so new code loads).
function killPort(port) {
  try {
    if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'for /f "tokens=5" %a in (\'netstat -ano ^| findstr :' + port + ' ^| findstr LISTENING\') do taskkill /F /PID %a'], { stdio: 'ignore' });
    } else {
      spawnSync('sh', ['-c', 'lsof -ti tcp:' + port + ' | xargs kill 2>/dev/null'], { stdio: 'ignore' });
    }
  } catch { /* best-effort */ }
}

// Read the version of the CODE the running dashboard is serving. Returns null on 404/error (an older
// build without the endpoint) → the caller treats that as STALE so old dashboards self-heal on relaunch.
async function runningVersion(url, ms = 900) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    const r = await fetch(`${url}/api/dashboard-version`, { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.version) || null;
  } catch { return null; }
}

/**
 * Ensure the dashboard is running + open it in the browser (best-effort, non-blocking).
 * @param {{open?: boolean}} opts open=false to only START the dashboard (no browser tab).
 */
export async function ensureDashboard({ open = true } = {}) {
  if (process.env.DASHBOARD_AUTO_OPEN === '0') { return; }
  // Force a browser tab on this call regardless of reuse. The launchers (start-converter.*) set this so
  // starting the converter ALWAYS pops the dashboard open — better to get a fresh tab (even a duplicate)
  // than silently nothing when the previous tab was closed but the server is still up.
  const force = /^(1|true|yes)$/i.test(process.env.DASHBOARD_FORCE_OPEN || '');
  try {
    const local = localVersion();
    let up = await isUp(DASH_URL);
    let started = false;

    if (up) {
      // A dashboard is already running. Compare the CODE it serves against what we ship: same version →
      // REUSE the server (don't restart it). Different/older/no-endpoint (null) → it's STALE, so kill it
      // here and fall through to restart it below with the current code.
      const remote = await runningVersion(DASH_URL);
      if (remote !== null && remote === local) {
        // Server is current — don't restart it. But still open a tab when forced (launch), so the user
        // always lands on the dashboard; only a non-forced auto-open (e.g. mid-capture) stays quiet.
        if (open && force) { openBrowser(DASH_URL); markOpened(); }
        return;
      }
      killPort(PORT);
      await new Promise((r) => setTimeout(r, 400)); // let the port free up
      up = false;
    }

    if (!up) {
      // Start the dashboard server detached so it outlives this tool. Pass --port explicitly + override
      // PORT in the child env: the caller (serve.mjs) runs with PORT=8787, which server.mjs would
      // otherwise inherit and try to bind (collision). --port wins in server.mjs regardless.
      try { spawn(process.execPath, [join(HERE, 'server.mjs'), '--port', String(PORT)], { detached: true, stdio: 'ignore', cwd: join(HERE, '..'), env: { ...process.env, PORT: String(PORT) } }).unref(); } catch { /* */ }
      started = true;
      await new Promise((r) => setTimeout(r, 800)); // let it bind
    }

    // Open a tab when we (re)started the dashboard, or when a launch forces it. (The same-version reuse
    // path returns above, itself honoring force.) markOpened() is telemetry only — it no longer gates.
    if (open && (started || force)) { openBrowser(DASH_URL); markOpened(); }
  } catch { /* never let dashboard auto-open break a conversion */ }
}
