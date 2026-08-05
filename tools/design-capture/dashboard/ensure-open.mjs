// Auto-open the converter dashboard (http://localhost:4600) whenever a converter tool is used, and
// start the dashboard server itself if it isn't already running. Called from serve.mjs (when the
// capture service boots) and capture.mjs (when a CLI capture runs) — i.e. any time the AI Dev Kit
// drives the converter, the live dashboard pops open in a browser tab.
//
// Opt out entirely with DASHBOARD_AUTO_OPEN=0. Override the port with DASHBOARD_PORT (default 4600).
// A short-lived lockfile stops a fresh tab from opening on every rapid tool start (30-min window).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT || 4600);
const DASH_URL = `http://localhost:${PORT}`;
const LOCK = join(tmpdir(), 'upw-dashboard-opened.json');
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

/**
 * Ensure the dashboard is running + open it in the browser (best-effort, non-blocking).
 * @param {{open?: boolean}} opts open=false to only START the dashboard (no browser tab).
 */
export async function ensureDashboard({ open = true } = {}) {
  if (process.env.DASHBOARD_AUTO_OPEN === '0') { return; }
  try {
    const up = await isUp(DASH_URL);
    if (!up) {
      // Start the dashboard server detached so it outlives this tool. Pass --port explicitly + override
      // PORT in the child env: the caller (serve.mjs) runs with PORT=8787, which server.mjs would
      // otherwise inherit and try to bind (collision). --port wins in server.mjs regardless.
      try { spawn(process.execPath, [join(HERE, 'server.mjs'), '--port', String(PORT)], { detached: true, stdio: 'ignore', cwd: join(HERE, '..'), env: { ...process.env, PORT: String(PORT) } }).unref(); } catch { /* */ }
      await new Promise((r) => setTimeout(r, 800)); // let it bind
    }
    if (open && !recentlyOpened()) { openBrowser(DASH_URL); markOpened(); }
  } catch { /* never let dashboard auto-open break a conversion */ }
}
