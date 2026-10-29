// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Connect your AI agents in one step: finds Claude Code, Cursor and Codex on this computer and registers the Kinetic
// Scenes tools (studio-mcp.mjs) with each, plus the Kinetic Scenes skill for Claude Code. Nothing changes without a yes:
// `studio-cli connect` shows the plan, `--yes` applies it, and the kit's start script asks once (`--ask`).

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP = resolve(HERE, 'studio-mcp.mjs');
const NAME = 'kinetic-scenes';
const SITE = process.env.KINETIC_SCENES_URL || 'https://kinetic-scenes.unysonplus.com/';
const SKILL_FILES = ['SKILL.md', 'reference/scene-format.md', 'reference/presets.md', 'reference/motion-rules.md', 'reference/sounds.md', 'reference/styles.md'];
const WIN = process.platform === 'win32';

/** A program's full path on PATH (Windows: an .exe first), or null. */
const which = (cmd) => {
  const r = spawnSync(WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const all = r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return all.find((x) => /\.exe$/i.test(x)) || all[0] || null;
};
const has = (cmd) => !!which(cmd);
// Run by full path, no shell (arguments with spaces stay whole); a .cmd/.bat launcher goes through cmd.exe as one quoted line.
const run = (cmd, args) => {
  const exe = which(cmd) || cmd;
  if (WIN && /\.(cmd|bat)$/i.test(exe)) return spawnSync('cmd.exe', ['/d', '/s', '/c', `"${[exe, ...args].map((x) => `"${x}"`).join(' ')}"`], { encoding: 'utf8', windowsHide: true, timeout: 60000, windowsVerbatimArguments: true });
  return spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
};
const q = (s) => s;

/** What would be done: [{ agent, what, done: bool, apply() }]. */
export function connectPlan() {
  const plan = [];
  // Claude Code: the tools (user scope, every project) and the skill.
  if (has('claude')) {
    const there = run('claude', ['mcp', 'get', NAME]).status === 0;
    plan.push({ agent: 'Claude Code', what: 'the Kinetic Scenes tools (claude mcp add)', done: there,
      apply: () => { const r = run('claude', ['mcp', 'add', '--scope', 'user', NAME, '--', 'node', q(MCP)]); if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim().slice(0, 300)); } });
    const skillDir = join(homedir(), '.claude', 'skills', NAME);
    plan.push({ agent: 'Claude Code', what: `the Kinetic Scenes skill (${skillDir})`, done: existsSync(join(skillDir, 'SKILL.md')),
      apply: async () => {
        for (const f of SKILL_FILES) {
          const r = await fetch(`${SITE}skill/${f}`, { signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new Error(`Could not fetch the skill (${f}: HTTP ${r.status}).`);
          mkdirSync(dirname(join(skillDir, f)), { recursive: true });
          writeFileSync(join(skillDir, f), await r.text());
        }
      } });
  }
  // Cursor: ~/.cursor/mcp.json.
  const cursorDir = join(homedir(), '.cursor');
  if (existsSync(cursorDir) || has('cursor')) {
    const file = join(cursorDir, 'mcp.json');
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
    plan.push({ agent: 'Cursor', what: `the Kinetic Scenes tools (${file})`, done: !!cfg.mcpServers?.[NAME],
      apply: () => {
        let now = {};
        try { now = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
        now.mcpServers = { ...(now.mcpServers || {}), [NAME]: { command: 'node', args: [MCP] } };
        mkdirSync(cursorDir, { recursive: true });
        writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
      } });
  }
  // Codex: ~/.codex/config.toml.
  const codexDir = join(homedir(), '.codex');
  if (existsSync(codexDir) || has('codex')) {
    const file = join(codexDir, 'config.toml');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    plan.push({ agent: 'Codex', what: `the Kinetic Scenes tools (${file})`, done: text.includes(`[mcp_servers.${NAME}]`),
      apply: () => {
        mkdirSync(codexDir, { recursive: true });
        appendFileSync(file, `\n[mcp_servers.${NAME}]\ncommand = "node"\nargs = [${JSON.stringify(MCP)}]\n`);
      } });
  }
  return plan;
}

/**
 * Connects the agents found. apply: make the changes; ask: ask once (the kit's start script), remember the answer, and
 * afterwards only add what is new (another agent installed since) when the answer was yes.
 */
export async function connectAgents({ apply = false, ask = false } = {}) {
  const plan = connectPlan();
  const todo = plan.filter((p) => !p.done);
  if (ask) {
    const { kitSetting } = await import('./studio-addons.mjs');
    const answer = kitSetting('agent-connect');
    if (answer === 'no' || !todo.length) return { plan, applied: [], asked: false };
    if (answer !== 'yes') {
      if (!process.stdin.isTTY) return { plan, applied: [], asked: false };
      const agents = [...new Set(todo.map((p) => p.agent))].join(' and ');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const reply = await new Promise((ok) => rl.question(`\n  Connect Kinetic Scenes to ${agents}, so your AI agent can make videos with you? [Y/n] `, ok));
      rl.close();
      const yes = !/^\s*n/i.test(reply);
      kitSetting('agent-connect', yes ? 'yes' : 'no');
      if (!yes) { console.log('  Skipped. Connect later with: node studio-cli.mjs connect --yes'); return { plan, applied: [], asked: true }; }
    }
    apply = true;
  }
  const applied = [];
  if (apply) {
    for (const p of todo) {
      try { await p.apply(); applied.push({ agent: p.agent, what: p.what, ok: true }); } catch (e) { applied.push({ agent: p.agent, what: p.what, ok: false, error: e.message }); }
    }
  }
  return { plan, applied, asked: ask };
}
