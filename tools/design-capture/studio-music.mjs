// Kinetic Scenes' background music (the ACE-Step add-on): an instrumental made on this computer, free to use.
// ACE-Step is an app the person installs themselves; they tell the kit its folder once (addons.json). When music is
// needed and ACE-Step is not running, the kit starts it with its own launcher (start_gradio_ui.bat, the only program it
// will run there) with the API on and the update check off, waits until it answers, and stops it again after ten idle
// minutes to give the graphics card back. An ACE-Step the person started themselves is used as it is, never stopped.

import { spawn, execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { claimGpu, registerGpuApp } from './studio-gpu.mjs';

const PORT = Number(process.env.ACE_STEP_PORT) || 7860;
const URL_ = `http://127.0.0.1:${PORT}`;
const LAUNCHER = 'start_gradio_ui.bat';
const IDLE_MS = 10 * 60e3;

let child = null;      // the launcher the kit is running while ACE-Step starts
// The ACE-Step program the kit started (the one listening), remembered in a file so a restarted kit still stops it.
const PID_FILE = join(tmpdir(), `unysonplus-ace-step-${PORT}.pid`);
let ownPid = (() => { try { return Number(readFileSync(PID_FILE, 'utf8')) || null; } catch { return null; } })();
let idleTimer = null;
let starting = null;
const jobs = new Map();

/** A folder is ACE-Step 1.5 when it has its launcher and its package. */
export function checkAceFolder(path) {
  const dir = resolve(String(path || '').trim().replace(/^"|"$/g, ''));
  if (!path || !existsSync(join(dir, LAUNCHER)) || !existsSync(join(dir, 'acestep', 'acestep_v15_pipeline.py'))) return null;
  return dir;
}

async function get(path, timeout = 3000) {
  try { const r = await fetch(URL_ + path, { signal: AbortSignal.timeout(timeout) }); return r.status; } catch { return 0; }
}

/** Running with the API (200), running without it (the page answers, the API does not), or not running. */
export async function aceStatus(folder) {
  const [api, page] = await Promise.all([get('/health'), get('/')]);
  return {
    folder: folder || null, folderOk: !!checkAceFolder(folder), url: URL_,
    running: api === 200 || page === 200, api: api === 200, startedByKit: !!(ownPid || child),
    busy: [...jobs.values()].some((j) => j.state === 'working'),
  };
}

/** The process listening on ACE-Step's port (Windows), so the kit stops the program itself, not just its launcher. */
function listenerPid() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    const m = out.split(/\r?\n/).find((l) => new RegExp(`:${PORT}\\s.*LISTENING`).test(l));
    return m ? Number(m.trim().split(/\s+/).pop()) || null : null;
  } catch { return null; }
}
const killTree = (pid) => new Promise((ok) => execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => ok()));

function armIdle() {
  clearTimeout(idleTimer);
  if (!ownPid && !child) return;
  idleTimer = setTimeout(() => { if (![...jobs.values()].some((j) => j.state === 'working')) stopAce(); else armIdle(); }, IDLE_MS);
  idleTimer.unref?.();
}

export async function stopAce() {
  clearTimeout(idleTimer);
  const pids = [ownPid, child?.pid].filter(Boolean);
  child = null; ownPid = null;
  try { rmSync(PID_FILE, { force: true }); } catch {}
  if (!pids.length) return false;
  if (process.platform !== 'win32') { for (const p of pids) try { process.kill(p); } catch {} return true; }
  await Promise.all(pids.map(killTree));
  return true;
}

/** Makes sure ACE-Step answers with its API, starting it from the given folder when it is not running. */
export async function ensureAce(folder, onStep = () => {}) {
  const st = await aceStatus(folder);
  if (st.api) return;
  if (st.running) throw new Error('ACE-Step is open without its API. Close it and the kit will start it with the API on (or set ENABLE_API=--enable-api in its launcher).');
  const dir = checkAceFolder(folder);
  if (!dir) throw new Error('Tell the kit where ACE-Step is first (Add-ons, ACE-Step, Location): the folder with start_gradio_ui.bat.');
  if (process.platform !== 'win32') throw new Error('Starting ACE-Step automatically works on Windows for now. Start it yourself with the API on (--enable-api).');
  if (!starting) {
    starting = (async () => {
      onStep('Starting ACE-Step');
      child = spawn('cmd.exe', ['/d', '/c', join(dir, LAUNCHER)], {
        cwd: dir, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, ENABLE_API: '--enable-api', CHECK_UPDATE: 'false', PORT: String(PORT), SERVER_NAME: '127.0.0.1' },
      });
      const me = child;
      me.on('exit', () => { if (child === me) child = null; });
      const t0 = Date.now();
      while (Date.now() - t0 < 6 * 60e3) {
        await new Promise((ok) => setTimeout(ok, 2000));
        if (!child) throw new Error('ACE-Step stopped while starting. Run its start_gradio_ui.bat once yourself to see why.');
        if (await get('/health') === 200) {
          ownPid = listenerPid();
          if (ownPid) try { writeFileSync(PID_FILE, String(ownPid)); } catch {}
          return;
        }
        onStep(`Starting ACE-Step (${Math.round((Date.now() - t0) / 1000)} s)`);
      }
      stopAce();
      throw new Error('ACE-Step did not answer within six minutes.');
    })().finally(() => { starting = null; });
  }
  await starting;
}

async function post(path, body, timeout) {
  const r = await fetch(URL_ + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code && j.code !== 200)) throw new Error(`ACE-Step could not make the music: ${j.error || j.detail || r.status}.`);
  return j.data;
}

/**
 * Makes one instrumental and returns it as an mp3 Buffer. Uses the quick settings (8 steps, no language model
 * planning), which take well under a minute for half a minute of music on a 6 GB card.
 */
export async function makeMusic(folder, { prompt, seconds = 30, bpm } = {}, onStep = () => {}) {
  await claimGpu('ACE-Step', onStep);
  await ensureAce(folder, onStep);
  clearTimeout(idleTimer);
  try {
    onStep('Making the music');
    const body = {
      prompt: String(prompt || 'upbeat modern instrumental, light drums, warm synths').slice(0, 500),
      lyrics: '[Instrumental]', audio_duration: Math.max(10, Math.min(240, Math.round(seconds))),
      batch_size: 1, audio_format: 'mp3', inference_steps: 8, use_cot_caption: false, thinking: false,
    };
    if (bpm) body.bpm = Math.max(40, Math.min(220, Math.round(bpm)));
    const { task_id } = await post('/release_task', body, 20 * 60e3);
    const [res] = await post('/query_result', { task_id_list: [task_id] }, 30000);
    const item = JSON.parse(res?.result || '[]')[0];
    if (!item?.url) throw new Error('ACE-Step finished without a file.');
    const a = await fetch(URL_ + item.url, { signal: AbortSignal.timeout(60000) });
    if (!a.ok) throw new Error(`ACE-Step's file could not be read (${a.status}).`);
    return { mp3: Buffer.from(await a.arrayBuffer()), bpm: item.bpm || body.bpm || null, seconds: item.duration || body.audio_duration };
  } finally { armIdle(); }
}

/** The same as a job the Studio polls: POST starts it, GET reads it. */
export function startMusic(folder, opts) {
  const id = randomUUID();
  const job = { id, state: 'working', step: 'Waiting', error: null, result: null };
  jobs.set(id, job);
  makeMusic(folder, opts, (s) => { job.step = s; })
    .then((r) => { job.state = 'done'; job.step = 'Done'; job.result = { src: `data:audio/mpeg;base64,${r.mp3.toString('base64')}`, bpm: r.bpm, seconds: r.seconds }; })
    .catch((e) => { job.state = 'failed'; job.error = e.message; })
    .finally(() => setTimeout(() => jobs.delete(id), 30 * 60e3).unref?.());
  return { id };
}
export const musicJob = (id) => jobs.get(id) || null;

// A kit restarted while its ACE-Step is still running takes it back (and its idle stop); a stale id is dropped.
if (ownPid) get('/health').then((st) => { if (st === 200 && listenerPid() === ownPid) armIdle(); else { ownPid = null; try { rmSync(PID_FILE, { force: true }); } catch {} } });
process.on('exit', () => { for (const p of [ownPid, child?.pid].filter(Boolean)) try { execFileSync('taskkill', ['/pid', String(p), '/t', '/f'], { stdio: 'ignore', windowsHide: true }); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(0));

registerGpuApp('ACE-Step', { owned: () => !!(ownPid || child), busy: () => [...jobs.values()].some((j) => j.state === 'working') || !!starting, stop: stopAce });
