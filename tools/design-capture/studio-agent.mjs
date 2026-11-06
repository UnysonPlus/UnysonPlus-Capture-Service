// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// AI assist that works in steps: the Studio's request runs as an agent (Claude Code, the person's own subscription)
// inside the open project's folder, with the Kinetic Scenes tools. It reads the notes, edits scene.json (the Studio
// follows the file live), looks at frames, checks its work and writes what it did into the notes; each step is reported
// to the Studio as it happens. It never renders. Only when Claude Code is on this computer; otherwise AI assist answers
// in one go, as before. The Studio's Create button and the Kit Assistant both run it, so a request costs the person one
// approval: it is limited to this one folder, and scene.json is copied to snapshots/ first, so a run can be put back.

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMedia, projectDir } from './studio-workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const jobs = new Map();
const SNAPSHOTS = 'snapshots';
const KEEP_SNAPSHOTS = 10;
const SNAPSHOT_NAME = /^scene-[0-9-]+\.json$/;

/** Copies scene.json into the project's snapshots/ before a run (the last ten stay). Returns its file name. */
export function snapshotScene(project) {
  const dir = projectDir(project);
  const folder = join(dir, SNAPSHOTS);
  mkdirSync(folder, { recursive: true });
  const name = `scene-${new Date().toISOString().replace(/\D/g, '-').replace(/-$/, '')}.json`;
  copyFileSync(join(dir, 'scene.json'), join(folder, name));
  const all = readdirSync(folder).filter((f) => SNAPSHOT_NAME.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS))) rmSync(join(folder, old), { force: true });
  return name;
}

/** Puts a snapshot back as scene.json. A Studio with the project open follows the file. */
export function restoreSnapshot(project, name) {
  if (!SNAPSHOT_NAME.test(String(name))) throw Object.assign(new Error('Not a snapshot of this project.'), { code: 400 });
  const dir = projectDir(project);
  const from = join(dir, SNAPSHOTS, name);
  if (!existsSync(from)) throw Object.assign(new Error('That snapshot is no longer kept.'), { code: 404 });
  copyFileSync(from, join(dir, 'scene.json'));
  return { project, snapshot: name };
}

/** The claude program's full path (an .exe first on Windows), or null. */
function claudePath() {
  const cmd = process.env.CLAUDE_CLI || 'claude';
  const r = spawnSync(WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const all = r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return all.find((x) => /\.exe$/i.test(x)) || all[0] || null;
}
export const agentAvailable = () => !!claudePath();

// Friendly names for what the agent is doing.
const STEP = {
  Read: (i) => `Reading ${String(i.file_path || '').split(/[\\/]/).pop()}`,
  Edit: (i) => `Editing ${String(i.file_path || '').split(/[\\/]/).pop()}`,
  Write: (i) => `Writing ${String(i.file_path || '').split(/[\\/]/).pop()}`,
  Glob: () => 'Looking at the project files',
  mcp__kinetic_scenes__scene_guide: (i) => `Reading the guide (${i.topic || 'workflow'})`,
  mcp__kinetic_scenes__scene_check: () => 'Checking the scene',
  mcp__kinetic_scenes__scene_stills: (i) => `Looking at frames${Array.isArray(i.times) ? ` (${i.times.join(', ')} s)` : ''}`,
  mcp__kinetic_scenes__scene_timeline: () => 'Looking at the timeline (words, sound, subtitles)',
  mcp__kinetic_scenes__scene_inspect: () => 'Outlining the scene',
  mcp__kinetic_scenes__project_notes: (i) => (i.add ? 'Adding to the project notes' : 'Reading the project notes'),
  mcp__kinetic_scenes__audio_beats: () => 'Finding the beats',
  mcp__kinetic_scenes__audio_transcribe: () => 'Listening to the voice-over',
  mcp__kinetic_scenes__voice_over: () => 'Recording the voice-over',
  mcp__kinetic_scenes__scene_compose: () => 'Composing the music',
};
const stepOf = (name, input) => {
  const key = String(name).replace(/-/g, '_');
  return STEP[key] ? STEP[key](input || {}) : `Using ${String(name).replace(/^mcp__kinetic[-_]scenes__/, '').replace(/_/g, ' ')}`;
};

/** What a new scene adds to the brief: the request is the whole scene, and sound if the person asked for it. */
const newScene = ({ website, voice, music }) => `
This is a NEW scene: scene.json holds only its format and stage. Build the whole scene from the request. Keep "mode",
"video" and "stage" as they are; if scene.json has no stage yet, make a 9:16 video unless the request says otherwise.
Read scene_guide before you write it, and make it a finished scene, with its own title in "title".${website ? `
The request is about a website: website.md in this folder has its real words, colours and fonts, and names its
screenshots in media/. Use only those facts, and never invent numbers, names or claims.` : ''}${voice ? `
VOICE-OVER: write short lines to be spoken, make them with voice_over (out "media/voice.mp3"), add the file as a voice
audio clip, and land each reveal on the words it belongs to. Write brand names the way they should sound.` : ''}${music ? `
MUSIC: when the scene's timing is settled, write the music with scene_compose (scene_path "scene.json", out
"media/music.wav") and add it as an audio clip at volume 0.25, under any voice-over.` : ''}
`;

const brief = (project, prompt, extra = '') => `You are working on the Kinetic Scenes project "${project}" for the person, in its folder (your working
directory): scene.json is the scene (format "unysonplus-scene"), media/ holds its files (refer to them as "media/…"),
notes.md holds the plan and what was decided.

Their request: ${prompt}
${extra}
How to work:
- Read notes.md first. If you are unsure of the scene format or a preset, use scene_guide.
- Make the change by editing scene.json (keep it valid JSON; change only what the request needs). The person may be
  watching the Studio, which reloads the file each time you save it.
- Check your work: scene_check with scene_path "scene.json", then scene_stills (and scene_timeline where there is a
  voice-over) for the moments you changed. Look at the frames and fix what is wrong.
- Do not render a video, and do not touch files outside this folder. Do not use project_save, scene_save or
  scene_render: you are already in the project, and your edits to scene.json are the whole hand-over.
- Media paths in scene.json ("media/…") are files in this folder: scene_check and scene_stills read them with
  scene_path "scene.json". If a check still cannot load a file, say so in your summary rather than working around it.
- When done, add one dated line to the notes (project_notes with add, section "Decided") saying what you changed.
- End with two or three plain sentences for the person: what you changed, and anything they should decide.`;

/** A website's facts and screenshots, into the project for the agent to read. */
async function readWebsite(project, url) {
  const q = await (await import('./studio-director.mjs')).studioQuick({ url });
  const shots = q.shots.map((src, i) => addMedia(project, `site-${i + 1}.jpg`, Buffer.from(src.split(',')[1], 'base64')));
  const list = shots.length ? `\n\nSCREENSHOTS OF THE SITE: ${shots.join(', ')}` : '';
  writeFileSync(join(projectDir(project), 'website.md'), `# ${url}\n\n${q.context}${list}\n`);
}

/**
 * Starts a job: { id, snapshot }. Progress with agentJob(id).
 * create: a new scene from the request; url: read this website first; voice, music: add them to a new scene.
 */
export function startAgent({ project, prompt, create = false, url = '', voice = false, music = false }) {
  if (!project || !prompt) throw Object.assign(new Error('Give a project and a request.'), { code: 400 });
  const exe = claudePath();
  if (!exe) throw Object.assign(new Error('Working in steps needs Claude Code (the claude command) on this computer.'), { code: 409 });
  const dir = projectDir(project);
  if (url && !/^https?:\/\//i.test(url)) throw Object.assign(new Error('The address must start with http:// or https://.'), { code: 400 });
  const snapshot = snapshotScene(project);
  const tmp = mkdtempSync(join(tmpdir(), 'upw-agent-'));
  const mcp = join(tmp, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { 'kinetic-scenes': { command: process.execPath, args: [resolve(HERE, 'studio-mcp.mjs')] } } }));
  const extra = create ? newScene({ website: !!url, voice, music }) : '';
  const args = ['-p', brief(project, String(prompt).slice(0, 4000), extra), '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcp, '--strict-mcp-config', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'mcp__kinetic-scenes', 'Read', 'Edit', 'Write', 'Glob', 'ToolSearch',
    // Nothing that runs commands, reaches the web or starts other agents: it works on its own folder and nothing else.
    '--disallowedTools', 'Bash', 'PowerShell', 'Monitor', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'NotebookEdit',
    'mcp__kinetic-scenes__project_save', 'mcp__kinetic-scenes__scene_render', 'mcp__kinetic-scenes__scene_save'];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = { id, project, state: 'running', steps: [], summary: '', error: '', snapshot, startedAt: Date.now(), child: null };
  jobs.set(id, job);
  const step = (text) => job.steps.push({ t: +((Date.now() - job.startedAt) / 1000).toFixed(1), text: String(text).trim().slice(0, 240) });
  const finish = (error) => { rmSync(tmp, { recursive: true, force: true }); if (job.state === 'running') { job.error = error; job.state = 'error'; } };
  const begin = () => {
    if (job.state !== 'running') { rmSync(tmp, { recursive: true, force: true }); return; }
    run(job, { exe, args, dir, tmp, step });
  };
  if (url) {
    step('Reading the website');
    readWebsite(project, url).then(begin).catch((e) => finish(`The website could not be read: ${e.message}`));
  } else begin();
  return { id, snapshot };
}

/** The Claude Code process of a job, reporting each step. */
function run(job, { exe, args, dir, tmp, step }) {
  const child = spawn(exe, args, { cwd: dir, windowsHide: true, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'kinetic-scenes' } });
  job.child = child;
  let buf = '', err = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
        for (const c of m.message.content) {
          if (c.type === 'tool_use') step(stepOf(c.name, c.input));
          else if (c.type === 'text' && c.text.trim()) step(c.text.split('\n')[0]);
        }
      } else if (m.type === 'result') {
        job.summary = String(m.result || '').trim();
        if (m.is_error) job.error = job.summary || 'The agent stopped with an error.';
      }
    }
  });
  child.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => { job.error = 'Stopped after 20 minutes.'; try { child.kill(); } catch { /* gone */ } }, 20 * 60e3);
  child.on('exit', (code) => {
    clearTimeout(timer);
    rmSync(tmp, { recursive: true, force: true });
    if (job.state === 'cancelled') return;
    if (code !== 0 && !job.error) job.error = err.trim().split('\n').slice(-3).join(' ').slice(0, 400) || `Claude Code stopped (${code}).`;
    job.state = job.error ? 'error' : 'done';
  });
}

export function agentJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { id: j.id, project: j.project, state: j.state, steps: j.steps, summary: j.summary, error: j.error, snapshot: j.snapshot, seconds: Math.round((Date.now() - j.startedAt) / 1000) };
}

export function cancelAgent(id) {
  const j = jobs.get(id);
  if (!j || j.state !== 'running') return false;
  j.state = 'cancelled';
  if (WIN && j.child?.pid) spawnSync('taskkill', ['/PID', String(j.child.pid), '/T', '/F'], { windowsHide: true });
  else j.child?.kill();
  return true;
}
