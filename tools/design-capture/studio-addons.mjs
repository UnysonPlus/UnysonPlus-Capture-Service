// Kinetic Scenes' add-ons: the extra tools the Studio can use through the kit. Two kinds:
//   - connectors, for apps the person installs themselves (Voicebox, Blender): found automatically where they usually
//     are, or at a location the person gives once (kept in addons.json beside the kit's other downloads);
//   - downloads, which the kit installs itself on request (speech recognition, voices, voice and music separation).
// The kit only ever talks to the apps it knows, at the address or program it has checked; never an arbitrary command.

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimGpu, killTree, listenerPid, registerGpuApp } from './studio-gpu.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function settingsFile() {
  const assembled = resolve(HERE, '../../..');
  const dir = basename(assembled) === 'assembled' ? assembled : join(homedir(), '.unysonplus');
  return join(dir, 'addons.json');
}
function readSettings() {
  try { return JSON.parse(readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  mkdirSync(dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

/* ------------------------------------------------------------------ Voicebox */

const VOICEBOX_DEFAULT = 'http://127.0.0.1:17493';
const voiceboxUrl = () => (readSettings().voicebox?.url || process.env.VOICEBOX_URL || VOICEBOX_DEFAULT).replace(/\/+$/, '');

/** Only an address on this computer: the kit sends scripts there, nowhere else. */
function localUrl(u) {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname) ? `${x.protocol}//${x.host}` : null;
  } catch { return null; }
}

async function vb(path, init = {}, timeout = 15000) {
  const r = await fetch(`${voiceboxUrl()}${path}`, { ...init, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`Voicebox answered ${r.status}${j.detail ? `: ${typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)}` : ''}.`);
  }
  return r;
}

/** Voicebox's program, when the person told the kit where it is: voicebox.exe (or a macOS Voicebox.app), not its server. */
function voiceboxApp(p) {
  const x = resolve(String(p || '').trim().replace(/^"|"$/g, ''));
  if (!p || !/^voicebox\.(exe|app)$/i.test(basename(x)) || !existsSync(x)) return null;
  if (/\.exe$/i.test(x) && statSync(x).isFile()) return x;
  if (/\.app$/i.test(x) && process.platform === 'darwin') return x;
  return null;
}

// The Voicebox the kit opened (its app and its server), remembered in a file so a restarted kit still closes it.
// One the person opened is never closed.
const VB_PID_FILE = join(tmpdir(), 'unysonplus-voicebox.pid');
let vbPids = (() => { try { return JSON.parse(readFileSync(VB_PID_FILE, 'utf8')); } catch { return null; } })();
let vbBusy = 0;
let vbIdle = null;
const VB_IDLE_MS = 10 * 60e3;

export async function stopVoicebox() {
  clearTimeout(vbIdle);
  const pids = [...new Set([...(vbPids || []), ...(vbPids ? [listenerPid(vbPort())] : [])].filter(Boolean))];
  vbPids = null;
  try { rmSync(VB_PID_FILE, { force: true }); } catch {}
  await Promise.all(pids.map(killTree));
  return pids.length > 0;
}
function vbArmIdle() {
  clearTimeout(vbIdle);
  if (!vbPids) return;
  vbIdle = setTimeout(() => { if (vbBusy) vbArmIdle(); else stopVoicebox(); }, VB_IDLE_MS);
  vbIdle.unref?.();
}
const vbPort = () => { try { return Number(new URL(voiceboxUrl()).port) || 80; } catch { return 17493; } };

/** Opens Voicebox from its known program when it is not running, and waits until it answers. */
export async function ensureVoicebox(onWait = () => {}) {
  if ((await voiceboxStatus()).connected) return true;
  const app = voiceboxApp(readSettings().voicebox?.app);
  if (!app) return false;
  const c = /\.app$/i.test(app) ? spawn('open', ['-a', app], { stdio: 'ignore', detached: true }) : spawn(app, [], { cwd: dirname(app), stdio: 'ignore', detached: true });
  c.unref();
  for (let i = 0; i < 90; i++) {
    await new Promise((ok) => setTimeout(ok, 2000));
    onWait(i * 2);
    if ((await voiceboxStatus()).connected) {
      vbPids = [c.pid, listenerPid(vbPort())].filter(Boolean);
      try { writeFileSync(VB_PID_FILE, JSON.stringify(vbPids)); } catch {}
      return true;
    }
  }
  return false;
}
registerGpuApp('Voicebox', { owned: () => !!vbPids, busy: () => vbBusy > 0, stop: stopVoicebox });
if (vbPids) voiceboxStatus().then((st) => { if (st.connected) vbArmIdle(); else { vbPids = null; try { rmSync(VB_PID_FILE, { force: true }); } catch {} } });

/** Is Voicebox running, and which voices does it have? */
export async function voiceboxStatus() {
  try {
    const health = await (await vb('/health', {}, 3000)).json();
    const profiles = await (await vb('/profiles', {}, 5000)).json();
    return {
      connected: true, url: voiceboxUrl(), gpu: health.gpu_type || null,
      profiles: (Array.isArray(profiles) ? profiles : []).map((p) => ({ id: p.id, name: p.name, language: p.language || 'en', engine: p.default_engine || null })),
    };
  } catch {
    return { connected: false, url: voiceboxUrl(), profiles: [] };
  }
}

/**
 * Speaks one line in a Voicebox voice and returns the WAV. Uses the profile's own engine when it has one (Voicebox
 * otherwise falls back to its default). The first line after Voicebox starts can take minutes (it loads its model).
 */
export async function voiceboxSpeak(profileId, text, opts = {}) {
  vbBusy++;
  try {
    await claimGpu('Voicebox');
    await ensureVoicebox(opts.onWait);
    return await speakOne(profileId, text, opts);
  } finally { vbBusy--; vbArmIdle(); }
}
async function speakOne(profileId, text, opts) {
  const profile = await (await vb(`/profiles/${encodeURIComponent(profileId)}`)).json();
  const body = { profile_id: profileId, text, language: opts.language || profile.language || 'en' };
  if (opts.engine || profile.default_engine) body.engine = opts.engine || profile.default_engine;
  const gen = await (await vb('/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 30000)).json();
  const started = Date.now();
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 1500));
    const h = await (await vb(`/history/${gen.id}`)).json();
    if (h.status === 'failed') throw new Error(`Voicebox could not speak the line: ${h.error || 'it failed'}.`);
    if (h.status === 'completed') break;
    opts.onWait?.(Math.round((Date.now() - started) / 1000));
    if (Date.now() - started > 15 * 60e3) throw new Error('Voicebox took too long to speak a line.');
  }
  return Buffer.from(await (await vb(`/audio/${gen.id}`, {}, 60000)).arrayBuffer());
}

/* ------------------------------------------------------------------ the list */

/** Every add-on with its state, for the Studio's Add-ons panel. */
export async function listAddons() {
  const settings = readSettings();
  const [voicebox, transcribe, voice, separate, ace] = await Promise.all([
    voiceboxStatus(),
    import('./studio-transcribe.mjs').then((m) => m.transcribeStatus()).catch(() => null),
    import('./studio-voice.mjs').then((m) => m.voiceStatus()).catch(() => null),
    import('./studio-separate.mjs').then((m) => m.separateStatus()).catch(() => null),
    import('./studio-music.mjs').then((m) => m.aceStatus(settings['ace-step']?.path)).catch(() => null),
  ]);
  return [
    {
      id: 'voicebox', kind: 'connector', name: 'Voicebox', state: voicebox.connected ? 'connected' : voiceboxApp(settings.voicebox?.app) ? 'ready' : 'not-found',
      what: 'Voice-overs in your own voice, or any voice you have the right to use, from your Voicebox profiles.',
      detail: voicebox.connected ? `${voicebox.profiles.length} voice${voicebox.profiles.length === 1 ? '' : 's'} at ${voicebox.url}${vbPids ? ' (opened by the kit; it closes after ten idle minutes, or when another AI add-on needs the graphics card)' : ''}`
        : voiceboxApp(settings.voicebox?.app) ? 'The kit opens it when a voice-over needs it, and closes it after ten idle minutes.'
        : `Not running at ${voicebox.url}. Find it, or set its program, and the kit opens it when needed.`,
      location: { kind: 'url', value: voicebox.url, default: VOICEBOX_DEFAULT }, profiles: voicebox.profiles,
      app: { kind: 'path', value: settings.voicebox?.app || '', placeholder: 'C:\\Program Files\\Voicebox\\Voicebox.exe', hint: 'Where the Voicebox program is, so the kit can open it when a voice-over needs it.' },
      link: 'https://github.com/jamiepine/voicebox',
    },
    {
      id: 'ace-step', kind: 'connector', name: 'ACE-Step music',
      state: ace?.api ? 'connected' : ace?.running ? 'no-api' : ace?.folderOk ? 'ready' : 'not-found',
      what: 'Background music made on this computer, free to use: an instrumental in the style, tempo and length you ask for.',
      detail: ace?.api ? `Running at ${ace.url}${ace.startedByKit ? ' (started by the kit; it stops after ten idle minutes)' : ''}.`
        : ace?.running ? 'Open without its API. Close it and the kit starts it with the API when music is needed.'
        : ace?.folderOk ? 'The kit starts it when music is needed, and stops it after ten idle minutes or when another AI add-on needs the graphics card.'
        : 'Install ACE-Step 1.5, then tell the kit its folder.',
      location: { kind: 'path', value: settings['ace-step']?.path || '', placeholder: 'D:\\AI\\ACE-Step-1.5', hint: 'The ACE-Step folder, the one with start_gradio_ui.bat.' },
      link: 'https://github.com/ace-step/ACE-Step-1.5',
    },
    {
      id: 'speech', kind: 'download', name: 'Speech recognition', state: transcribe?.program && Object.values(transcribe.models || {}).some((m) => m.installed) ? 'installed' : 'not-installed',
      what: 'Every word of a voice-over with its time: captions, scenes timed to the voice.', detail: 'Whisper, on this computer (148 MB or more).',
    },
    {
      id: 'voices', kind: 'download', name: 'Built-in voices', state: voice && voice.program && Object.values(voice.voices || {}).some((v) => v.installed) ? 'installed' : 'not-installed',
      what: 'Voice-overs from a script without recording, in a free synthetic voice.', detail: 'Piper, on this computer (about 63 MB a voice).',
    },
    {
      id: 'kokoro', kind: 'download', name: 'Kokoro voices', state: voice?.voices?.['kokoro:af_heart']?.installed ? 'installed' : 'not-installed',
      what: 'Six more natural voices for voice-overs from a script (American and British English).', detail: 'Kokoro, on this computer, no graphics card needed (about 500 MB).',
    },
    {
      id: 'separate', kind: 'download', name: 'Voice and music separation', state: separate?.runtime && separate?.model ? 'installed' : 'not-installed',
      what: 'Splits a clip\'s sound into the voice and the music.', detail: `Demucs, on this computer (about ${separate?.mb ?? 170} MB).`,
    },
    await (async () => {
      // Blender: found where it is usually installed (or at BLENDER); the kit runs it in the background, no add-on.
      const exe = await import('./studio-blender.mjs').then((m) => m.findBlender()).catch(() => 'blender');
      const found = exe !== 'blender' && existsSync(exe);
      return {
        id: 'blender', kind: 'connector', name: 'Blender', state: found ? 'ready' : 'not-found',
        what: 'An AI agent builds anything in Blender: a 3D model for a 3D layer, or an animated shot as a transparent video.',
        detail: found ? `Found at ${exe}. The kit runs it in the background when an agent asks; nothing to open.`
          : 'Install Blender 4.2 or later (free, blender.org). The kit finds it in the usual folder, or set BLENDER to its path.',
        link: 'https://www.blender.org/download/',
      };
    })(),
    await import('./studio-clap.mjs').then((c) => ({ id: 'clap', kind: 'download', name: 'Sound identification', state: c.clapInstalled() ? 'installed' : 'not-installed', what: 'Names the sounds in a clip and when each is heard (speech, music, a door slam, rain…).', detail: `CLAP, on this computer, no graphics card needed (about ${c.CLAP_MB} MB).` })),
  ];
}

/** Where ACE-Step is (its folder), or null. */
export const aceFolder = () => readSettings()['ace-step']?.path || null;

/** Sets where a connector is (Voicebox: its address, or with field "app" its program; ACE-Step: its folder), then checks it. */
export async function setAddonLocation(id, value, field) {
  const s = readSettings();
  const bad = (m) => Object.assign(new Error(m), { code: 400 });
  if (id === 'ace-step') {
    const { checkAceFolder, aceStatus } = await import('./studio-music.mjs');
    if (value === null || value === '') delete s['ace-step'];
    else {
      const dir = checkAceFolder(value);
      if (!dir) throw bad('That folder is not ACE-Step 1.5: it needs start_gradio_ui.bat and the acestep folder.');
      s['ace-step'] = { path: dir };
    }
    writeSettings(s);
    return aceStatus(s['ace-step']?.path);
  }
  if (id !== 'voicebox') throw bad('That add-on has nothing to set.');
  if (field === 'app') {
    if (value === null || value === '') { if (s.voicebox) delete s.voicebox.app; }
    else {
      const app = voiceboxApp(value);
      if (!app) throw bad('Give the Voicebox program itself, like C:\\Program Files\\Voicebox\\Voicebox.exe.');
      s.voicebox = { ...(s.voicebox || {}), app };
    }
    writeSettings(s);
    return voiceboxStatus();
  }
  if (value === null || value === '') { if (s.voicebox) delete s.voicebox.url; }
  else {
    const url = localUrl(String(value).trim());
    if (!url) throw Object.assign(new Error('Give Voicebox\'s address on this computer, like http://127.0.0.1:17493.'), { code: 400 });
    s.voicebox = { ...(s.voicebox || {}), url };
  }
  writeSettings(s);
  return voiceboxStatus();
}


/* ------------------------------------------------------------------ finding and choosing */

const SKIP = /^(\$recycle\.bin|system volume information|windows|node_modules|\.git|programdata|recovery|perflogs)$/i;
function children(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP.test(d.name)).map((d) => join(dir, d.name)); } catch { return []; }
}
/** The places apps like these usually end up: the program folders, every drive's top two levels, the home folders. */
function searchRoots() {
  const env = process.env;
  const roots = [];
  if (process.platform === 'win32') {
    for (const l of 'CDEFGHIJ') { const r = `${l}:\\`; if (existsSync(r)) roots.push(r); }
  } else roots.push('/Applications', '/opt');
  roots.push(homedir(), join(homedir(), 'Desktop'), join(homedir(), 'Documents'), join(homedir(), 'Downloads'));
  const programs = [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  return { roots, programs };
}
function* candidateDirs() {
  const { roots, programs } = searchRoots();
  const seen = new Set();
  const out = function* (d) { const k = d.toLowerCase(); if (!seen.has(k)) { seen.add(k); yield d; } };
  for (const p of programs) for (const d of [p, ...children(p)]) yield* out(d);
  for (const r of roots) for (const a of children(r)) { yield* out(a); for (const b of children(a)) yield* out(b); }
}

/** Looks for a connector's app on this computer; saves and returns its location when found. */
export async function findAddon(id) {
  const s = readSettings();
  if (id === 'voicebox') {
    if ((await voiceboxStatus()).connected && voiceboxApp(s.voicebox?.app)) return { found: s.voicebox.app };
    for (const d of candidateDirs()) {
      for (const name of ['voicebox.exe', 'Voicebox.exe', 'Voicebox.app']) {
        const app = voiceboxApp(join(d, name));
        if (app) { s.voicebox = { ...(s.voicebox || {}), app }; writeSettings(s); return { found: app }; }
      }
    }
    return { found: null };
  }
  if (id === 'ace-step') {
    const { checkAceFolder } = await import('./studio-music.mjs');
    if (checkAceFolder(s['ace-step']?.path)) return { found: s['ace-step'].path };
    for (const d of candidateDirs()) {
      if (!/ace-?step/i.test(basename(d))) continue;
      const dir = checkAceFolder(d);
      if (dir) { s['ace-step'] = { path: dir }; writeSettings(s); return { found: dir }; }
    }
    return { found: null };
  }
  throw Object.assign(new Error('That add-on cannot be searched for.'), { code: 400 });
}

/**
 * Opens this computer's own file or folder picker (the browser cannot hand the Studio a real path), then sets what
 * the person chose. Returns { chosen: null } when they cancel.
 */
export async function browseAddon(id, field) {
  const folder = id === 'ace-step';
  const title = folder ? 'Choose the ACE-Step folder (the one with start_gradio_ui.bat)' : 'Choose the Voicebox program (voicebox.exe)';
  const current = id === 'ace-step' ? readSettings()['ace-step']?.path : readSettings().voicebox?.app;
  const chosen = await pick({ folder, title, start: current ? (folder ? current : dirname(current)) : '' });
  if (!chosen) return { chosen: null };
  await setAddonLocation(id, chosen, folder ? 'location' : field || 'app');
  return { chosen };
}

/** The kit's own settings (kept beside the add-on settings): read one, or set it (undefined removes it). */
export function kitSetting(key, ...value) {
  const s = readSettings();
  if (!value.length) return s[key];
  if (value[0] === undefined) delete s[key]; else s[key] = value[0];
  writeSettings(s);
  return value[0];
}

/** This computer's folder picker (with "New folder"). Null when cancelled or when there is no picker here. */
export const pickFolder = (title, start) => pick({ folder: true, title, start, newFolder: true });

function pick({ folder, title, start, newFolder = false }) {
  const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
  if (process.platform === 'win32') {
    // A 1-pixel top-most window owns the dialog, so it opens in front of the browser (an invisible one makes it close at once).
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; FormBorderStyle = "None"; Size = New-Object System.Drawing.Size(1, 1); StartPosition = "CenterScreen" }',
      '$o.Show(); $o.Activate()',
      folder
        ? `$d = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = ${q(title)}; ShowNewFolderButton = $${newFolder ? 'true' : 'false'} }; if (${q(start)}) { $d.SelectedPath = ${q(start)} }; if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`
        : `$d = New-Object System.Windows.Forms.OpenFileDialog -Property @{ Title = ${q(title)}; Filter = 'Voicebox (voicebox.exe)|voicebox.exe|Programs (*.exe)|*.exe' }; if (${q(start)}) { $d.InitialDirectory = ${q(start)} }; if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.FileName) }`,
      '$o.Close()',
    ].join('; ');
    return new Promise((ok) => execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, timeout: 10 * 60e3 }, (e, out) => ok(e ? null : String(out).trim() || null)));
  }
  if (process.platform === 'darwin') {
    const script = folder ? `POSIX path of (choose folder with prompt ${JSON.stringify(title)})` : `POSIX path of (choose file with prompt ${JSON.stringify(title)})`;
    return new Promise((ok) => execFile('osascript', ['-e', script], { timeout: 10 * 60e3 }, (e, out) => ok(e ? null : String(out).trim().replace(/\/$/, '') || null)));
  }
  return Promise.resolve(null);
}
