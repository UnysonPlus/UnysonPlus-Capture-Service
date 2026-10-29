// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// AI assist that works in steps: the Studio's request runs as an agent (Claude Code, the person's own subscription)
// inside the open project's folder, with the Kinetic Scenes tools. It reads the notes, edits scene.json (the Studio
// follows the file live), looks at frames, checks its work and writes what it did into the notes; each step is reported
// to the Studio as it happens. It never renders. Only when the kit's AI is Claude Code; otherwise AI assist answers in
// one go, as before.

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDir } from './studio-workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const jobs = new Map();

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
};
const stepOf = (name, input) => {
  const key = String(name).replace(/-/g, '_');
  return STEP[key] ? STEP[key](input || {}) : `Using ${String(name).replace(/^mcp__kinetic[-_]scenes__/, '').replace(/_/g, ' ')}`;
};

const brief = (project, prompt) => `You are working on the Kinetic Scenes project "${project}" for the person, in its folder (your working
directory): scene.json is the scene (format "unysonplus-scene"), media/ holds its files (refer to them as "media/…"),
notes.md holds the plan and what was decided.

Their request: ${prompt}

How to work:
- Read notes.md first. If you are unsure of the scene format or a preset, use scene_guide.
- Make the change by editing scene.json (keep it valid JSON; change only what the request needs). The person watches the
  Studio, which reloads the file each time you save it.
- Check your work: scene_check with scene_path "scene.json", then scene_stills (and scene_timeline where there is a
  voice-over) for the moments you changed. Look at the frames and fix what is wrong.
- Do not render a video, and do not touch files outside this folder. Do not use project_save, scene_save or
  scene_render: you are already in the project, and your edits to scene.json are the whole hand-over.
- Media paths in scene.json ("media/…") are files in this folder: scene_check and scene_stills read them with
  scene_path "scene.json". If a check still cannot load a file, say so in your summary rather than working around it.
- When done, add one dated line to the notes (project_notes with add, section "Decided") saying what you changed.
- End with two or three plain sentences for the person: what you changed, and anything they should decide.`;

/** Starts a job: { id }. Progress with agentJob(id). */
export function startAgent({ project, prompt }) {
  if (!project || !prompt) throw Object.assign(new Error('Give a project and a request.'), { code: 400 });
  const exe = claudePath();
  if (!exe) throw Object.assign(new Error('Working in steps needs Claude Code (the claude command) on this computer.'), { code: 409 });
  const dir = projectDir(project);
  const tmp = mkdtempSync(join(tmpdir(), 'upw-agent-'));
  const mcp = join(tmp, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { 'kinetic-scenes': { command: process.execPath, args: [resolve(HERE, 'studio-mcp.mjs')] } } }));
  const args = ['-p', brief(project, String(prompt).slice(0, 4000)), '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcp, '--strict-mcp-config', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'mcp__kinetic-scenes', 'Read', 'Edit', 'Write', 'Glob', 'ToolSearch',
    // Nothing that runs commands, reaches the web or starts other agents: it works on its own folder and nothing else.
    '--disallowedTools', 'Bash', 'PowerShell', 'Monitor', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'NotebookEdit',
    'mcp__kinetic-scenes__project_save', 'mcp__kinetic-scenes__scene_render', 'mcp__kinetic-scenes__scene_save'];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = { id, project, state: 'running', steps: [], summary: '', error: '', startedAt: Date.now(), child: null };
  jobs.set(id, job);
  const child = spawn(exe, args, { cwd: dir, windowsHide: true, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'kinetic-scenes' } });
  job.child = child;
  let buf = '', err = '';
  const step = (text) => job.steps.push({ t: +((Date.now() - job.startedAt) / 1000).toFixed(1), text: String(text).trim().slice(0, 240) });
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
  return { id };
}

export function agentJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { id: j.id, project: j.project, state: j.state, steps: j.steps, summary: j.summary, error: j.error, seconds: Math.round((Date.now() - j.startedAt) / 1000) };
}

export function cancelAgent(id) {
  const j = jobs.get(id);
  if (!j || j.state !== 'running') return false;
  j.state = 'cancelled';
  if (WIN && j.child?.pid) spawnSync('taskkill', ['/PID', String(j.child.pid), '/T', '/F'], { windowsHide: true });
  else j.child?.kill();
  return true;
}
