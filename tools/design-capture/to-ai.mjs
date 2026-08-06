// AI refinement for the Site Converter (the optional "AI companion").
//
// The WordPress plugin deterministically parses an export into a draft MAPPING (sections → elements
// with roles). This module hands that draft + the original markup to Claude and gets back:
//   1. a refined mapping (corrected roles, dropped chrome/decorative blocks), and
//   2. a complete child-theme DESIGN — { style_css, header_html, footer_html } — that reproduces the
//      original's look (the stylesheet styles the rebuilt shortcode body + the authored chrome).
//
// The plugin then builds the WordPress page from the refined mapping (its own engine produces the
// correct page-builder nodes) and folds the CSS into the generated child theme. So the AI works at the
// MAPPING + CSS level — never hand-writing fragile page-builder JSON.
//
// TWO backends (auto-detected — both run LOCALLY; nothing about your site leaves your machine):
//   • "api"         — calls the Anthropic API with your ANTHROPIC_API_KEY (pay-per-use, billed by the
//                     Anthropic Console — separate from a Claude.ai subscription).
//   • "claude-code" — shells out to your installed **Claude Code** CLI (`claude`), which uses your
//                     Claude SUBSCRIPTION. No API key, no extra billing.
// Pick order: AI_BACKEND env override → ANTHROPIC_API_KEY (api) → `claude` on PATH (claude-code) → off.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_HTML = 90000; // cap the markup we send
const IS_WIN = process.platform === 'win32';

/* ---- Experimental local-AI tier (Ollama) ------------------------------ *
 * A THIRD backend between "deterministic (no AI)" and "cloud Claude": a small model the user runs locally
 * via Ollama. 100% local, no key. Opt-in — used only when the user PICKS a model (dashboard → Local AI),
 * and only as a fallback after the Claude backends (Claude is stronger). Same narrow job: refine the mapping. */
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
const LOCAL_AI_CONFIG = join(dirname(fileURLToPath(import.meta.url)), 'local-ai.json');

// Curated shortlist shown in the dashboard picker (the user chooses by hardware). `tag` is the Ollama
// model to `ollama pull`. Not exhaustive — the picker also accepts a custom tag.
export const LOCAL_AI_MODELS = [
  { tag: 'phi4-mini',     label: 'Phi-4-mini',    params: '3.8B', ram: '~3 GB',    recommended: true, note: 'Best small reasoning + JSON. Great default for most PCs.' },
  { tag: 'qwen2.5:3b',    label: 'Qwen2.5 3B',    params: '3B',   ram: '~2–3 GB',                     note: 'Fast, low memory — good on light hardware.' },
  { tag: 'llama3.2:3b',   label: 'Llama 3.2 3B',  params: '3B',   ram: '~2–3 GB',                     note: 'Solid general-purpose small model.' },
  { tag: 'gemma3:4b',     label: 'Gemma 3 4B',    params: '4B',   ram: '~4 GB',                       note: 'Strong all-rounder; also handles images.' },
  { tag: 'qwen2.5:7b',    label: 'Qwen2.5 7B',    params: '7B',   ram: '~5–6 GB',                     note: 'Stronger structured output — needs more RAM/VRAM.' },
  { tag: 'qwen2.5vl:7b',  label: 'Qwen2.5-VL 7B', params: '7B',   ram: '~6 GB',   vision: true,       note: 'Vision — can judge screenshots. Heaviest.' },
];

let _ollamaBin; // cache
/** Is the `ollama` binary installed? (sync, cached — mirrors claudeCliAvailable). */
function ollamaBinaryAvailable() {
  if (typeof _ollamaBin === 'boolean') return _ollamaBin;
  try {
    const cmd = process.env.OLLAMA_CLI || 'ollama';
    const r = IS_WIN
      ? spawnSync(`"${cmd}" --version`, { shell: true, timeout: 8000, encoding: 'utf8' })
      : spawnSync(cmd, ['--version'], { timeout: 8000, encoding: 'utf8' });
    // Require a SUCCESSFUL run — a "'ollama' is not recognized" shell error also contains the word
    // "ollama", so matching the output alone gives a false positive when it isn't installed.
    _ollamaBin = r.status === 0 && /ollama|version/i.test(String(r.stdout || ''));
  } catch { _ollamaBin = false; }
  return _ollamaBin;
}

/** The model the user picked (OLLAMA_MODEL env wins, else local-ai.json), or '' if none. */
export function selectedLocalModel() {
  const env = (process.env.OLLAMA_MODEL || '').trim();
  if (env) return env;
  try { if (existsSync(LOCAL_AI_CONFIG)) return String(JSON.parse(readFileSync(LOCAL_AI_CONFIG, 'utf8')).model || '').trim(); } catch { /* no/blank config */ }
  return '';
}

/** Persist the picked model (dashboard writes this). Empty string clears the selection. */
export function setLocalModel(model) {
  const m = String(model || '').trim();
  writeFileSync(LOCAL_AI_CONFIG, JSON.stringify({ model: m }, null, 2) + '\n');
  return m;
}

/** Ollama is a usable backend when it's installed AND the user has picked a model. */
function ollamaReady() {
  return ollamaBinaryAvailable() && selectedLocalModel() !== '';
}

/** Async status for the dashboard: is the server up + which models are pulled. */
export async function localAiStatus() {
  // Probe the server FIRST — a reachable API means Ollama is present even if the binary isn't on PATH
  // (e.g. a portable/bundled ollama.exe started by the launcher). Fall back to the binary check otherwise.
  let up = false, models = [];
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) { up = true; models = ((await r.json()).models || []).map((m) => m.name); }
  } catch { /* server not running */ }
  const installed = up || ollamaBinaryAvailable();
  return { installed, up, host: OLLAMA_HOST, selected: selectedLocalModel(), pulled: models, shortlist: LOCAL_AI_MODELS };
}

/* ---- Model download (dashboard "Pull" button) ------------------------- *
 * Ollama's /api/pull streams NDJSON progress. We drive it in the background and expose the latest state
 * via pullStatus() so the dashboard can poll + show a progress bar (no terminal needed). One pull at a time. */
let _pull = { model: '', status: 'idle', percent: 0, done: true, error: '' };
export function pullStatus() { return _pull; }
export async function startPull(model) {
  const m = String(model || '').trim();
  if (!m) throw new Error('No model to pull.');
  if (_pull.model === m && !_pull.done) return _pull; // already pulling this one
  _pull = { model: m, status: 'starting', percent: 0, done: false, error: '', at: Date.now() };
  (async () => {
    try {
      const r = await fetch(`${OLLAMA_HOST}/api/pull`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: m, stream: true }),
      });
      if (!r.ok || !r.body) { _pull = { ..._pull, status: 'error', error: `Ollama ${r.status} — is \`ollama serve\` running?`, done: true }; return; }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.error) { _pull = { ..._pull, status: 'error', error: String(o.error), done: true }; return; }
          const pct = (o.total && o.completed) ? Math.round((o.completed / o.total) * 100) : _pull.percent;
          _pull = { ..._pull, status: o.status || _pull.status, percent: pct };
          if (o.status === 'success') { _pull = { ..._pull, status: 'success', percent: 100, done: true }; }
        }
      }
      if (!_pull.done) _pull = { ..._pull, status: 'success', percent: 100, done: true };
    } catch (e) {
      const msg = /fetch failed|ECONNREFUSED|network/i.test(e.message) ? `Could not reach Ollama at ${OLLAMA_HOST} — is it running? (the launcher starts it)` : e.message;
      _pull = { ..._pull, status: 'error', error: msg, done: true };
    }
  })();
  return _pull;
}

const ROLES = ['overline', 'title', 'subtitle', 'heading', 'text', 'button', 'image', 'columns', 'code', 'skip'];

const SYSTEM = `You IMPROVE a draft element mapping for a website-to-WordPress converter. You do NOT write CSS or HTML.

A DETERMINISTIC engine already reads the original page's real classes and reproduces the exact look (colors,
sizes, spacing, layout, header/footer) faithfully and repeatably. Your ONLY job is to make that engine
SMARTER by correcting the MAPPING: which element each block is, what is decorative, and what is a custom
widget. You NEVER author a stylesheet or header/footer markup -- the engine does that.

You are given (a) the original page's full HTML and (b) the DRAFT mapping (pages -> sections -> blocks, each
block has a "role"). Return ONE JSON object, no markdown fences, no commentary:
{ "mapping": { ...improved mapping... } }

== rules ==
- Keep the shape EXACTLY: { "pages":[ { "title","slug","front_page","sections":[ { "css_id","omit":false,"blocks":[ { "t","role", ... } ] } ] } ] }.
- Roles: ${ROLES.join(', ')}. overline=eyebrow/pill label; title=section heading (h1/h2); subtitle=line under a title; heading=sub-heading; text=paragraph; button=CTA; image=real <img>; columns=row of cards (keep "cols"); code=a CUSTOM element kept VERBATIM; skip=drop.
- You may ONLY change a block's "role", a section's "css_id", or "omit"/"skip". KEEP every block's
  "text"/"html"/"label"/"cols" EXACTLY as given -- do NOT rewrite content, do NOT add or change classes,
  do NOT rebuild markup. PRESERVE block + section ORDER.
- Fix mis-detected roles. Set role "skip" (or a section "omit":true) ONLY for genuinely chrome/decorative
  blocks: nav bars, marquees, gradient-only spacer divs. Do NOT skip real content.
- CUSTOM / UNIQUE WIDGETS -- the fidelity escape hatch. For anything that does NOT cleanly map to a
  heading/text/button/image/card (an audio/video player, an image with an OVERLAID UI, a bespoke
  interactive or stat/pricing widget): set its role to "code". You MAY merge the cluster of blocks for that
  ONE widget into a single { "t":"html", "role":"code", "html":"..." }, but "html" MUST be the original
  markup VERBATIM (keep the real <img> src and EVERY sub-part) -- the engine reproduces it. Do NOT rebuild
  it with your own classes; you are not writing CSS.
- Give each section a short semantic "css_id" (hero, features, pricing, cta, ...).

== layout judgments the engine relies on you for ==
- An inline BADGE / PILL (e.g. "NEW - v2 is now live") is a real element -> role "overline" (the engine
  styles it as a pill), never "skip".
- A logo / "trusted by" strip is ONE horizontal row -> keep its single "columns"/"code" block intact; do
  NOT split the logos back into separate stacked blocks.
- SECTION ORDER: keep a section's heading + subtitle as SEPARATE blocks BEFORE its "columns" row (a
  full-width heading, then the cards below). NEVER merge the heading into the cards row or move it into a
  side column. Preserve the source's block order exactly.`;

/* ---------------------------------------------------------------------- *
 * Backend detection
 * ---------------------------------------------------------------------- */

let _cliChecked = false;
let _cliCmd = false; // false = not found, string = the command to run

/** Is the Claude Code CLI installed? (cached; checked once with `claude --version`.) */
function claudeCliAvailable() {
  if (_cliChecked) return _cliCmd !== false;
  _cliChecked = true;
  const cmd = process.env.CLAUDE_CLI || 'claude';
  try {
    // On Windows `claude` is a .cmd shim, so it needs a shell; pass a quoted command STRING (not an
    // args array) to avoid the Node shell+args deprecation warning. On POSIX, spawn it directly.
    const r = IS_WIN
      ? spawnSync(`"${cmd}" --version`, { shell: true, timeout: 12000, encoding: 'utf8' })
      : spawnSync(cmd, ['--version'], { timeout: 12000, encoding: 'utf8' });
    _cliCmd = r.status === 0 ? cmd : false;
  } catch {
    _cliCmd = false;
  }
  return _cliCmd !== false;
}

/** Which backend will run: 'api' | 'claude-code' | null. */
export function aiBackend() {
  const forced = (process.env.AI_BACKEND || '').toLowerCase().replace(/[_\s]/g, '-');
  if (forced === 'api') return (process.env.ANTHROPIC_API_KEY || '').trim() ? 'api' : null;
  if (forced === 'claude-code' || forced === 'cli') return claudeCliAvailable() ? 'claude-code' : null;
  if (forced === 'ollama' || forced === 'local') return ollamaBinaryAvailable() && selectedLocalModel() ? 'ollama' : null;
  if ((process.env.ANTHROPIC_API_KEY || '').trim()) return 'api';
  if (claudeCliAvailable()) return 'claude-code';
  if (ollamaReady()) return 'ollama'; // Experimental local fallback — only when a model is picked
  return null;
}

/** Is any AI backend available? */
export function aiReady() {
  return aiBackend() !== null;
}

/* ---------------------------------------------------------------------- *
 * Refinement
 * ---------------------------------------------------------------------- */

/** Build the user-turn content (shared by both backends). */
function buildUser({ html, mapping, source }) {
  const markup = String(html || '').slice(0, MAX_HTML);
  return (
    `Source builder: ${source || 'unknown'}\n\n` +
    `=== ORIGINAL HTML (truncated) ===\n${markup}\n\n` +
    `=== DRAFT MAPPING (JSON) ===\n${JSON.stringify(mapping)}\n\n` +
    `Return the { "mapping", "theme": { "style_css", "header_html", "footer_html" } } JSON object now.`
  );
}

/**
 * Refine a draft mapping with whichever backend is available.
 * @param {{ html:string, mapping:object, source?:string }} input
 * @returns {Promise<{ mapping:object, custom_css:string, model:string, backend:string }>}
 */
export async function refineMapping(input) {
  if (!input || !input.mapping || !Array.isArray(input.mapping.pages)) {
    throw new Error('No draft mapping to refine.');
  }
  const backend = aiBackend();
  if (backend === 'api') return refineViaApi(input);
  if (backend === 'claude-code') return refineViaClaudeCode(input);
  if (backend === 'ollama') return refineViaOllama(input);
  throw new Error('AI is off — set ANTHROPIC_API_KEY, install Claude Code (`claude`), or pick a local model (Ollama).');
}

/**
 * Backend 3 (Experimental): a local model via Ollama. Same refine-only job. Uses Ollama's structured-output
 * (`format: 'json'`) so even a small model returns valid JSON. Falls through to the deterministic result if
 * the model errors (the WordPress flow already treats AI as best-effort).
 */
async function refineViaOllama({ html, mapping, source }) {
  const model = selectedLocalModel();
  if (!model) throw new Error('No local model selected — pick one in the dashboard (Local AI).');
  const timeout = parseInt(process.env.AI_TIMEOUT_MS || '', 10) || 180000;
  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUser({ html, mapping, source }) },
      ],
    }),
    signal: AbortSignal.timeout(timeout),
  }).catch((e) => { throw new Error(`Could not reach Ollama at ${OLLAMA_HOST} (${e.message}) — is \`ollama serve\` running?`); });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Ollama ${resp.status}: ${t.slice(0, 300)} — is the model \`${model}\` pulled? (\`ollama pull ${model}\`)`);
  }
  const data = await resp.json();
  const text = String((data.message && data.message.content) || '').trim();
  return finishParse(text, model, 'ollama');
}

/** Backend 1: the Anthropic API (pay-per-use). */
async function refineViaApi({ html, mapping, source }) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  const model = DEFAULT_MODEL;
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 32000, system: SYSTEM, messages: [{ role: 'user', content: buildUser({ html, mapping, source }) }] }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Anthropic API ${resp.status}: ${t.slice(0, 400)}`);
  }
  const data = await resp.json();
  const text = (data.content || []).map((c) => c.text || '').join('').trim();
  return finishParse(text, model, 'api');
}

/**
 * Backend 2: the Claude Code CLI (uses the user's subscription). Runs `claude -p --output-format json`
 * with the full prompt on stdin; the CLI must be installed and signed in (`claude` once, interactively).
 */
async function refineViaClaudeCode({ html, mapping, source }) {
  const cmd = process.env.CLAUDE_CLI || 'claude';
  const prompt = SYSTEM + '\n\n' + buildUser({ html, mapping, source });
  const args = ['-p', '--output-format', 'json', '--max-turns', '1'];
  const model = (process.env.ANTHROPIC_MODEL || '').replace(/[^a-zA-Z0-9._-]/g, ''); // sanitize (shell arg)
  if (model) { args.push('--model', model); }

  const stdout = await runClaude(cmd, args, prompt);
  // `--output-format json` wraps the answer: { type, subtype, result, is_error, ... }. Pull `.result`.
  let text = stdout.trim();
  try {
    const j = JSON.parse(stdout);
    if (j && j.is_error) { throw new Error('Claude Code reported an error: ' + String(j.result || j.subtype || '').slice(0, 300)); }
    if (j && typeof j.result === 'string') { text = j.result; }
  } catch (e) {
    if (e.message && e.message.startsWith('Claude Code reported')) throw e; // real error, not a parse miss
    // else: not JSON-wrapped (older CLI / text mode) — use stdout as-is.
  }
  return finishParse(text, process.env.ANTHROPIC_MODEL || 'claude-code', 'claude-code');
}

/** Spawn the Claude Code CLI, feed the prompt on stdin, resolve its stdout. */
function runClaude(cmd, args, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Windows: quoted command STRING under a shell (resolves the .cmd shim, no deprecation warning).
      // POSIX: spawn the binary directly with the args array.
      child = IS_WIN
        ? spawn(`"${cmd}" ${args.join(' ')}`, { shell: true })
        : spawn(cmd, args, { shell: false });
    } catch (e) {
      reject(new Error('Could not run Claude Code (`claude`): ' + e.message));
      return;
    }
    let out = '';
    let err = '';
    // Authoring a full stylesheet + a refined mapping in one turn (Opus, up to 32k output tokens) can
    // run many minutes, so there is NO time limit by default — we simply wait for Claude Code to finish
    // (the earlier 3-minute cap timed out on design-heavy pages). Set AI_TIMEOUT_MS (milliseconds) to a
    // positive value only if you'd rather impose a cap, e.g. AI_TIMEOUT_MS=600000 for 10 minutes.
    const timeoutMs = parseInt(process.env.AI_TIMEOUT_MS || '', 10);
    const timer = timeoutMs > 0
      ? setTimeout(() => { try { child.kill(); } catch {} reject(new Error('Claude Code timed out (over ' + Math.round(timeoutMs / 60000) + ' minutes). Unset AI_TIMEOUT_MS to remove the cap.')); }, timeoutMs)
      : null;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('Could not run Claude Code (`claude`): ' + e.message + ' — is it installed and on PATH?')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve(out); }
      else { reject(new Error('Claude Code exited (' + code + '). ' + (err || out).slice(0, 400) + ' — make sure you have run `claude` once to sign in.')); }
    });
    try { child.stdin.write(input); child.stdin.end(); } catch (e) { /* close handler reports */ }
  });
}

/** Parse the model's text into the { mapping, custom_css } result. */
function finishParse(text, model, backend) {
  const parsed = extractJson(text);
  if (!parsed || !parsed.mapping || !Array.isArray(parsed.mapping.pages)) {
    throw new Error('The AI response did not contain a valid mapping.');
  }
  // REFINE-ONLY: the AI returns just a corrected mapping. The deterministic engine produces the stylesheet
  // and the header/footer chrome, so we deliberately DROP any theme/style_css an older model might emit --
  // the two engines must not both author CSS (that's what made them conflict).
  return {
    mapping: parsed.mapping,
    theme: { style_css: '', header_html: '', footer_html: '' },
    custom_css: '',
    model,
    backend,
  };
}

/** Pull the first balanced JSON object out of a model response (tolerates stray prose / fences). */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; }
    else if (ch === '{') { depth++; }
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
