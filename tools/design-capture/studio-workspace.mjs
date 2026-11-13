// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Kinetic Scenes' workspace: projects as real folders on this computer, shared by the Studio and an AI agent.
//
//   <workspace>/<project>/scene.json   the scene (media referred to by paths relative to the folder)
//   <workspace>/<project>/media/       footage, voice, music, pictures
//   <workspace>/<project>/renders/     exported videos
//
// The workspace is KINETIC_WORKSPACE, or "Kinetic Scenes" in the person's Documents folder. The Studio reads and
// writes it through the kit (serve.mjs: /studio/workspace…); an agent edits the files directly, and the Studio
// sees the change at once (watch()).

import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const SCENE = 'scene.json';

let documents = null;
/**
 * The person's Documents folder where it really is: Windows lets it be moved (to another drive, to OneDrive), so ask
 * Windows; Linux has xdg-user-dir; a Mac's is always ~/Documents.
 */
function documentsDir() {
  if (documents) return documents;
  const ask = (cmd, args) => { try { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true }); return r.status === 0 ? r.stdout.trim() : ''; } catch { return ''; } };
  const found = process.platform === 'win32' ? ask('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"])
    : process.platform === 'linux' ? ask('xdg-user-dir', ['DOCUMENTS']) : '';
  documents = found && existsSync(found) ? found : join(homedir(), 'Documents');
  return documents;
}
export const defaultRoot = () => join(documentsDir(), 'Kinetic Scenes');
let chosenRoot; // the folder chosen in the Studio (kept in the kit's settings)

/** Where the workspace is: KINETIC_WORKSPACE, else the folder chosen in the Studio, else Documents/Kinetic Scenes. */
export function workspaceRoot() {
  if (chosenRoot === undefined) chosenRoot = null;
  const root = process.env.KINETIC_WORKSPACE ? resolve(process.env.KINETIC_WORKSPACE) : chosenRoot || defaultRoot();
  mkdirSync(root, { recursive: true });
  return root;
}

/** Where the workspace is and how it was set (for the Studio's Projects dialog). */
export async function rootInfo() {
  await loadChosenRoot();
  return { root: workspaceRoot(), byEnv: !!process.env.KINETIC_WORKSPACE, isDefault: !process.env.KINETIC_WORKSPACE && !chosenRoot, defaultRoot: defaultRoot() };
}

async function loadChosenRoot() {
  if (chosenRoot !== undefined && chosenRoot !== null) return;
  const v = (await import('./studio-addons.mjs')).kitSetting('kinetic-workspace');
  chosenRoot = typeof v === 'string' && v ? v : null;
}

/**
 * Changes the workspace folder: `choose` opens this computer's folder picker, `reset` goes back to the default.
 * Projects already made stay where they are (their folders can be moved by hand).
 */
export async function setRoot({ choose = false, reset = false } = {}) {
  const a = await import('./studio-addons.mjs');
  if (process.env.KINETIC_WORKSPACE) throw bad('The workspace is set by KINETIC_WORKSPACE when the kit starts; change it there.', 409);
  if (reset) { a.kitSetting('kinetic-workspace', undefined); chosenRoot = null; return { chosen: true, ...(await rootInfo()) }; }
  if (!choose) return { chosen: false, ...(await rootInfo()) };
  const picked = await a.pickFolder('Choose the folder for your Kinetic Scenes projects', workspaceRoot());
  if (!picked) return { chosen: false, ...(await rootInfo()) };
  a.kitSetting('kinetic-workspace', picked);
  chosenRoot = picked;
  return { chosen: true, ...(await rootInfo()) };
}

/** A project folder name from a title: letters, numbers, spaces and - _ only. */
export function projectId(name) {
  const id = String(name || '').replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return id || 'Untitled';
}

function bad(message, code = 400) { const e = new Error(message); e.code = code; return e; }

/** The folder of an existing project (never outside the workspace). */
export function projectDir(id, { create = false } = {}) {
  const root = workspaceRoot();
  const dir = resolve(root, String(id || ''));
  if (dir === root || !dir.startsWith(root + sep) || relative(root, dir).includes(sep)) throw bad('Not a project name.');
  if (!existsSync(join(dir, SCENE)) && !create) throw bad(`No project called "${id}".`, 404);
  return dir;
}

/** A file inside a project (never outside it). */
export function projectFile(id, rel) {
  const dir = projectDir(id);
  const f = resolve(dir, String(rel || ''));
  if (!f.startsWith(dir + sep)) throw bad('Not a file of this project.');
  return f;
}

export async function listProjects() {
  const info = await rootInfo();
  const root = info.root;
  const out = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const f = join(root, name.name, SCENE);
    if (!existsSync(f)) continue;
    let title = name.name, duration = 0;
    try { const s = JSON.parse(readFileSync(f, 'utf8')); title = s.title || title; duration = s.duration || 0; } catch { /* unreadable: still listed */ }
    out.push({ id: name.name, title, duration, updated: statSync(f).mtimeMs });
  }
  return { ...info, projects: out.sort((a, b) => b.updated - a.updated) };
}

const lastWrite = new Map(); // project → mtime of the kit's own last write (so the Studio is not told about its own save)

export function readProject(id) {
  const f = join(projectDir(id), SCENE);
  return { id, scene: JSON.parse(readFileSync(f, 'utf8')), mtime: statSync(f).mtimeMs };
}

/**
 * Writes a project's scene. `base` is the mtime the writer last read: if the file changed since (an agent edited
 * it), nothing is written and the current version comes back (code 409) so the writer can merge.
 */
export function writeProject(id, scene, { base, create = false } = {}) {
  if (!scene || typeof scene !== 'object') throw bad('No scene.');
  const dir = projectDir(id, { create });
  const f = join(dir, SCENE);
  if (existsSync(f) && base != null && Math.abs(statSync(f).mtimeMs - base) > 1) {
    const e = bad('The project changed on disk since you opened it.', 409);
    e.current = readProject(id);
    throw e;
  }
  for (const d of ['media', 'renders']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(f, `${JSON.stringify(scene, null, 2)}\n`);
  const mtime = statSync(f).mtimeMs;
  lastWrite.set(id, mtime);
  return { id, mtime };
}

/** A new project (a free name is found when the name is taken). */
export function createProject(name, scene) {
  const base = projectId(name);
  let id = base;
  for (let n = 2; existsSync(join(workspaceRoot(), id)); n++) id = `${base} ${n}`;
  const s = scene && typeof scene === 'object' ? { ...scene, title: scene.title || name } : { format: 'unysonplus-scene', version: 1, title: name, duration: 10, layers: [] };
  const r = writeProject(id, s, { create: true });
  ensureNotes(id, s.title);
  return r;
}

/*
 * Project notes: notes.md beside scene.json, the plan, what was decided and what is left, kept by the person and their
 * agent together, so a later session (or another agent) carries on from it. The Studio shows them and follows edits.
 */
const NOTES = 'notes.md';
const lastNotesWrite = new Map();
const notesTemplate = (title) => `# ${title}\n\nNotes for this project, kept by you and your AI agent. An agent reads them before working on the project and adds to them when something is decided or done.\n\n## Plan\n\n## Decided\n\n## Still to do\n`;

export function readNotes(id) {
  const f = join(projectDir(id), NOTES);
  return existsSync(f) ? { id, notes: readFileSync(f, 'utf8'), mtime: statSync(f).mtimeMs } : { id, notes: '', mtime: 0 };
}

export function writeNotes(id, text) {
  const f = join(projectDir(id), NOTES);
  writeFileSync(f, String(text ?? ''));
  const mtime = statSync(f).mtimeMs;
  lastNotesWrite.set(id, mtime);
  return { id, mtime };
}

/** Adds a dated line under a section ("Decided", "Still to do"…), made if missing. */
export function addNote(id, line, section = 'Decided') {
  let notes = readNotes(id).notes || notesTemplate(id);
  const entry = `- ${new Date().toISOString().slice(0, 10)}: ${String(line).trim()}`;
  const head = new RegExp(`^## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi');
  const m = head.exec(notes);
  if (!m) notes = `${notes.trimEnd()}\n\n## ${section}\n${entry}\n`;
  else {
    const after = m.index + m[0].length;
    const next = notes.slice(after).search(/^## /m);
    const end = next < 0 ? notes.length : after + next;
    notes = `${notes.slice(0, end).trimEnd()}\n${entry}\n${next < 0 ? '' : `\n${notes.slice(end)}`}`;
  }
  return writeNotes(id, notes);
}

function ensureNotes(id, title) {
  const f = join(projectDir(id), NOTES);
  if (!existsSync(f)) writeFileSync(f, notesTemplate(title || id));
}

/** Adds a media file; returns its path relative to the project ("media/…"). A file with the same name and size is reused. */
export function addMedia(id, name, buf) {
  const dir = join(projectDir(id), 'media');
  mkdirSync(dir, { recursive: true });
  const ext = extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
  const stem = String(name).slice(0, name.length - extname(name).length).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'media';
  let file = `${stem}${ext}`;
  for (let n = 2; existsSync(join(dir, file)); n++) {
    if (statSync(join(dir, file)).size === buf.length) return `media/${file}`;
    file = `${stem}-${n}${ext}`;
  }
  writeFileSync(join(dir, file), buf);
  return `media/${file}`;
}

const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.riv': 'application/octet-stream', '.lottie': 'application/zip' };

/** Sends a project file, with range requests (video must be able to seek). */
export function sendFile(id, rel, req, res) {
  const f = projectFile(id, rel);
  if (!existsSync(f) || !statSync(f).isFile()) throw bad('No such file.', 404);
  const size = statSync(f).size;
  const type = TYPES[extname(f).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
    const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    createReadStream(f, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    createReadStream(f).pipe(res);
  }
}

/** Tells `onChange({ kind: 'scene' | 'notes', mtime } | { kind: 'media' })` when someone else changes the project. Returns a stop function. */
export function watch(id, onChange) {
  const dir = projectDir(id);
  let t = null, mediaT = null, notesT = null;
  const w = fsWatch(dir, { recursive: true }, (_ev, name) => {
    const n = String(name || '').split(sep).join('/');
    if (n === SCENE) {
      clearTimeout(t);
      t = setTimeout(() => {
        try {
          const mtime = statSync(join(dir, SCENE)).mtimeMs;
          if (Math.abs((lastWrite.get(id) ?? -1) - mtime) <= 1) return; // the kit's own write
          onChange({ kind: 'scene', mtime });
        } catch { /* mid-write: the next event reports it */ }
      }, 250);
    } else if (n === NOTES) {
      clearTimeout(notesT);
      notesT = setTimeout(() => {
        try {
          const mtime = statSync(join(dir, NOTES)).mtimeMs;
          if (Math.abs((lastNotesWrite.get(id) ?? -1) - mtime) <= 1) return;
          onChange({ kind: 'notes', mtime });
        } catch { /* mid-write */ }
      }, 250);
    } else if (n.startsWith('media/')) {
      clearTimeout(mediaT);
      mediaT = setTimeout(() => onChange({ kind: 'media' }), 400);
    }
  });
  return () => { clearTimeout(t); clearTimeout(mediaT); clearTimeout(notesT); w.close(); };
}

/** Opens the project's folder in the file manager. */
export function reveal(id, sub) {
  let dir = id ? projectDir(id) : workspaceRoot();
  // A folder inside the project (web/, the web export), when it is there.
  if (id && sub && /^[\w-]+$/.test(sub) && existsSync(join(dir, sub))) dir = join(dir, sub);
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
  return { dir };
}

/** The Studio address that opens a project. */
export const projectLink = (id) => `https://kinetic-scenes.unysonplus.com/?project=${encodeURIComponent(id)}`;

/**
 * Puts a scene file into a project (created when there is none of that name): every local file it uses (footage,
 * pictures, sound, given as paths relative to the scene file) is copied into media/ and the scene points there.
 * This is how an agent hands work to the Studio: the open project updates at once.
 */
export function sceneIntoProject(sceneFile, name) {
  const from = resolve(sceneFile);
  const base = dirname(from);
  const scene = JSON.parse(readFileSync(from, 'utf8'));
  const id = projectId(name || scene.title || basename(from, '.json'));
  if (!existsSync(join(workspaceRoot(), id, SCENE))) createProject(id);
  const target = join(workspaceRoot(), id);
  // A local file: any path that is not an address. "media/…" counts too unless it is already this project's own file
  // (a scene copied from another project points at that project's media).
  const local = (src) => typeof src === 'string' && !!src && !/^(https?:|data:|blob:|sfx:|brand:|local:)/i.test(src)
    && !(/^media\//i.test(src) && resolve(base, src).startsWith(target + sep));
  const copied = new Map();
  const map = (src) => {
    const file = resolve(base, src);
    if (!existsSync(file)) throw bad(`The scene uses ${src}, which is not there (${file}).`);
    if (!copied.has(file)) copied.set(file, addMedia(id, basename(file), readFileSync(file)));
    return copied.get(file);
  };
  const walk = (list) => (list || []).forEach((l) => {
    if (local(l.src)) l.src = map(l.src);
    if (l.model && local(l.model.src)) l.model.src = map(l.model.src);
    for (const k of l.clips || []) if (k.params && local(k.params.src)) k.params.src = map(k.params.src);
    if (l.layers) walk(l.layers);
    if (l.item) walk([l.item]);
  });
  walk(scene.layers);
  (scene.audio || []).forEach((a) => { if (local(a.src)) a.src = map(a.src); });
  const r = writeProject(id, scene);
  ensureNotes(id, scene.title);
  lastWrite.delete(id); // written for the Studio to see: let the watcher report it
  return { id, dir: join(workspaceRoot(), id), files: copied.size, link: projectLink(id), mtime: r.mtime };
}

/**
 * The last AI agent that used the Kinetic Scenes tools (the command line or the MCP tools), so the Studio can show
 * "Connected: Claude Code" instead of asking the person to connect one. Kept in the kit's settings.
 */
export async function noteAgent(name) {
  try { (await import('./studio-addons.mjs')).kitSetting('kinetic-agent', { name: String(name || 'An AI agent').slice(0, 60), at: Date.now() }); } catch { /* settings not writable: nothing lost */ }
}
export async function lastAgent() {
  try { const v = (await import('./studio-addons.mjs')).kitSetting('kinetic-agent'); return v && v.name ? v : null; } catch { return null; }
}
/** The agent running this process, as far as its environment tells. */
export const agentFromEnv = () => (process.env.CLAUDECODE ? 'Claude Code' : process.env.CODEX_SANDBOX || process.env.CODEX_HOME ? 'Codex' : process.env.CURSOR_AGENT ? 'Cursor' : 'An AI agent');
