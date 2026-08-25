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
// NOTE on quality: these LOCAL models are the free/private tier and are all well below Claude. For the
// BEST output, use Claude (Enable AI in wp-admin). Among these, bigger = better; the small ones are for
// modest hardware, not for best results. "recommended" here means "best QUALITY that most PCs can run".
export const LOCAL_AI_MODELS = [
  { tag: 'qwen3:4b',            label: 'Qwen3 4B',            params: '4B',            ram: '~3–4 GB',  recommended: true,               note: 'Best value: tiny (2.5 GB) yet 256K context + strong instruction-following. Great default for modest PCs. Apache-2.0. Thinking is auto-disabled for terse JSON.' },
  { tag: 'qwen3:8b',            label: 'Qwen3 8B',            params: '8B',            ram: '~6–7 GB',  recommended: true,               note: 'Best QUALITY that fits a typical PC. Strongest local HTML/CSS reasoning + clean JSON at this size. Apache-2.0.' },
  { tag: 'granite4:3b',         label: 'IBM Granite 4 3B',    params: '3B',            ram: '~2–3 GB',                                   note: 'Light structured-output specialist: tuned for instruction-following + function calling, so JSON stays tidy for its size. Apache-2.0.' },
  { tag: 'qwen3:14b',           label: 'Qwen3 14B',           params: '14B',           ram: '~11–13 GB',                                 note: 'Enthusiast top quality — the closest local model to "just works" on the mapping task. Needs a 12–16 GB GPU or big RAM. Apache-2.0.' },
  { tag: 'qwen3:30b',           label: 'Qwen3 30B (MoE A3B)', params: '30B/3B active', ram: '~20 GB',                                    note: 'MoE: ~14B-class quality at ~4B inference speed if you have the RAM. 256K context. Big rigs only. Apache-2.0.' },
  { tag: 'mistral-small3.2:24b', label: 'Mistral Small 3.2 24B', params: '24B',        ram: '~16 GB',                     vision: true, note: 'Best instruction-follower for big PCs AND multimodal — one model for text + visual passes. Apache-2.0.' },
  { tag: 'qwen3-vl:8b',         label: 'Qwen3-VL 8B',         params: '8B',            ram: '~7 GB',    recommended: true, vision: true, note: 'Best local VISION pick for the screenshot fix pass — built for "design mockup → code" + spatial grounding. Apache-2.0.' },
  { tag: 'qwen3-vl:4b',         label: 'Qwen3-VL 4B',         params: '4B',            ram: '~4 GB',                      vision: true, note: 'Lighter vision option for mainstream PCs — same capability family, smaller footprint. Apache-2.0.' },
  { tag: 'gemma3:4b',           label: 'Gemma 3 4B',          params: '4B',            ram: '~4 GB',                      vision: true, note: 'Multimodal all-rounder; one small model for text + images. Custom Gemma Terms (permissive, not OSI).' },
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

/** Read the whole local-ai.json config object (merged persistence — model + auto-setup markers). */
function readLocalAiConfig() {
  try { if (existsSync(LOCAL_AI_CONFIG)) return JSON.parse(readFileSync(LOCAL_AI_CONFIG, 'utf8')) || {}; } catch { /* no/blank config */ }
  return {};
}
/** Write the whole local-ai.json config object. */
function writeLocalAiConfig(obj) {
  writeFileSync(LOCAL_AI_CONFIG, JSON.stringify(obj || {}, null, 2) + '\n');
}

/** The model the user picked (OLLAMA_MODEL env wins, else local-ai.json), or '' if none. */
export function selectedLocalModel() {
  const env = (process.env.OLLAMA_MODEL || '').trim();
  if (env) return env;
  return String(readLocalAiConfig().model || '').trim();
}

/** Persist the picked model (dashboard writes this). Empty string clears the selection.
 *  MERGES into the existing config so auto-setup markers (e.g. autoPullTried) survive. */
export function setLocalModel(model) {
  const m = String(model || '').trim();
  const cfg = readLocalAiConfig();
  cfg.model = m;
  writeLocalAiConfig(cfg);
  return m;
}

/** Delete a pulled model from Ollama (frees the disk under assembled/ollama/models). Clears the selection
 *  if it pointed at the deleted model. */
export async function deleteModel(model) {
  const m = String(model || '').trim();
  if (!m) throw new Error('No model to delete.');
  // Ollama renamed the field `name` -> `model` across its API; older builds accept only `name`,
  // newer ones only `model` (and silently 200 on the other, deleting nothing — the "clicked OK but
  // nothing happened" bug). Send BOTH so it works on every version.
  const resp = await fetch(`${OLLAMA_HOST}/api/delete`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: m, model: m }),
  }).catch((e) => { throw new Error(`Could not reach Ollama at ${OLLAMA_HOST} (${e.message}).`); });
  if (!resp.ok && resp.status !== 404) { throw new Error('Ollama ' + resp.status + ': ' + (await resp.text().catch(() => '')).slice(0, 200)); }
  // Verify it's actually gone — if Ollama accepted the request but the model still lists, surface an
  // error instead of a false "Deleted" (so the dashboard doesn't claim success while the model remains).
  const still = await fetch(`${OLLAMA_HOST}/api/tags`).then((r) => r.json()).then((d) => (d.models || []).some((x) => x.name === m || x.model === m)).catch(() => false);
  if (still) { throw new Error(`Ollama reported success but "${m}" is still installed — your Ollama build may not support delete via API. Remove it with:  ollama rm ${m}`); }
  if (selectedLocalModel() === m) { setLocalModel(''); } // don't leave a deleted model selected
  return { deleted: m };
}

// Cached "the Ollama server answered a probe" flag. The bundled/portable ollama.exe the launcher starts
// is often NOT on PATH, so the sync binary check misses it — but the server being reachable is equally
// valid proof it's usable. localAiStatus() (run at boot + on every dashboard poll) keeps this fresh, so
// ollamaReady()/aiBackend() agree with the dashboard's "running" state instead of silently falling back.
let _ollamaUp = false;

/** Ollama is a usable backend when it's reachable (binary on PATH OR server answered) AND a model is picked. */
function ollamaReady() {
  return (ollamaBinaryAvailable() || _ollamaUp) && selectedLocalModel() !== '';
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
  _ollamaUp = up; // remember for the sync ollamaReady()/aiBackend() path
  const installed = up || ollamaBinaryAvailable();
  return { installed, up, host: OLLAMA_HOST, selected: selectedLocalModel(), pulled: models, shortlist: LOCAL_AI_MODELS };
}

/** The recommended default the auto-setup pulls/prefers (the shortlist's first `recommended` tag). */
const RECOMMENDED_TAG = (LOCAL_AI_MODELS.find((m) => m.recommended) || { tag: 'qwen3:4b' }).tag;

/** Does a pulled tag list contain `tag` (exact, or same base name before the ':')? */
function pulledHas(pulled, tag) {
  const base = String(tag).split(':')[0];
  return (pulled || []).some((p) => p === tag || String(p).split(':')[0] === base);
}

/* ---- Boot auto-enable ------------------------------------------------- *
 * Turn the local AI ON out of the box so the WP AI-Assist endpoints don't silently 503. Called once on
 * service boot. Best-effort + non-blocking: never throws, never hangs the service. Opt out with
 * LOCAL_AI_AUTOSETUP=0. Returns a small status object describing what it did (for the boot log). */
export async function ensureLocalModelReady() {
  if (/^(0|false|no|off)$/i.test(process.env.LOCAL_AI_AUTOSETUP || '')) return { skipped: true };
  // Probe FIRST (even when a model is already selected) so the sync ollamaReady()/aiBackend() path knows the
  // server is up — otherwise, with a bundled ollama not on PATH, an already-selected model would still route
  // to Claude because _ollamaUp was never warmed.
  let status;
  try { status = await localAiStatus(); } catch { status = null; }

  // (a) already selected → nothing to do (the probe above already warmed _ollamaUp).
  const already = selectedLocalModel();
  if (already) return { selected: already, already: true };

  if (!status || !status.up) return { up: false }; // Ollama server not running — the launcher starts it; picker still works.

  const pulled = status.pulled || [];
  if (pulled.length) {
    // (b) auto-select what the RUNNING server actually reports: the recommended tag if pulled, else the first.
    const pick = pulled.find((p) => pulledHas([p], RECOMMENDED_TAG)) || pulled[0];
    setLocalModel(pick);
    console.log(`[local-ai] selected ${pick} (auto)`);
    return { selected: pick, auto: true };
  }

  // (c) no model pulled. Surface the store hint (the OLLAMA_MODELS mismatch bites here: a model pulled into
  //     the DEFAULT ~/.ollama store won't show when the active store is the kit's assembled/ollama/models).
  console.log(`[local-ai] no models in the active store (OLLAMA_MODELS=${process.env.OLLAMA_MODELS || 'default ~/.ollama/models'}). If you pulled one earlier it may be in the default ~/.ollama/models — set OLLAMA_MODELS or re-pull here.`);

  // First-run auto-pull, guarded so it fires at most once ever (marker in local-ai.json).
  const cfg = readLocalAiConfig();
  if (cfg.autoPullTried) return { up: true, pulled: [], autoPullTried: true };
  cfg.autoPullTried = true; writeLocalAiConfig(cfg);
  console.log(`[local-ai] first run: downloading ${RECOMMENDED_TAG} (~2.5 GB) in the background — AI turns on when it finishes; convert now, it stays deterministic until then.`);
  try { await startPull(RECOMMENDED_TAG); } catch { /* non-fatal */ }
  // Watch the background pull; auto-select on success. unref so it never keeps the process alive.
  const watch = setInterval(() => {
    const p = pullStatus();
    if (!p || !p.done) return;
    clearInterval(watch);
    if (p.status === 'success' && p.model && !selectedLocalModel()) {
      setLocalModel(p.model);
      console.log(`[local-ai] ${p.model} downloaded — local AI is now ON.`);
    }
  }, 4000);
  if (watch.unref) watch.unref();
  return { pulling: RECOMMENDED_TAG };
}

/* ---- "Test the model" surface (dashboard + /api/local-ai/test) --------- *
 * Run the SELECTED local model on an arbitrary short prompt so the user can PROVE it's alive and command
 * it directly. Minimal /api/chat call (think:false, temp 0). Errors carry `.code` (503 when off/unreachable). */
/** Strip a hybrid-reasoning model's chain-of-thought. Qwen3 etc. (even with think:false) may emit the
 * reasoning as plain text terminated by a stray `</think>` with NO opening tag — so keep only what follows
 * the LAST `</think>`, then remove any well-formed <think>…</think> blocks and stray tags, then trim. */
function stripReasoning(content) {
  let s = String(content || '');
  const ci = s.lastIndexOf('</think>');
  if (ci !== -1) s = s.slice(ci + '</think>'.length);
  return s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}

export async function testLocalModel(prompt) {
  const model = selectedLocalModel();
  if (!model) { const e = new Error('No local model selected — pick one in the dashboard (Local AI).'); e.code = 503; throw e; }
  const p = String(prompt || '').trim() || 'Reply with a short, friendly hello in one sentence.';
  const t0 = Date.now();
  const to = parseInt(process.env.AI_TEST_TIMEOUT_MS || '', 10) || 60000;
  // Keep the "is it alive?" reply CLEAN: a terse system rule + Qwen3's `/no_think` soft-switch suppress the
  // out-loud reasoning that `think:false` alone doesn't fully silence for hybrid-reasoning models.
  const sys = 'You are a concise assistant. Answer directly in one or two short sentences. Do NOT show your reasoning or any preamble.';
  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, think: false, options: { temperature: 0 }, messages: [{ role: 'system', content: sys }, { role: 'user', content: p }] }),
    signal: AbortSignal.timeout(to),
  }).catch((err) => { const e = new Error(`Could not reach Ollama at ${OLLAMA_HOST} (${err.message}) — is it running?`); e.code = 503; throw e; });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    const e = new Error(`Ollama ${resp.status}: ${t.slice(0, 200)} — is \`${model}\` pulled?`);
    e.code = resp.status === 404 ? 503 : 500; throw e;
  }
  const data = await resp.json();
  return { ok: true, model, reply: stripReasoning((data.message && data.message.content) || ''), ms: Date.now() - t0 };
}

/* ---- Multi-turn chat (dashboard Chat view + /local-ai/chat) ------------ *
 * A general chat surface that runs on whichever AI backend is active (a picked local Ollama model, or
 * Claude via the API / Claude Code CLI). Takes a messages array [{role:'user'|'assistant', content}] and
 * returns { ok, model, reply, ms }. Context is capped to the last ~12 turns so it stays fast; the caller
 * (serve.mjs) owns durable persistence. Throws with `.code = 503` when no AI backend is available. */
const CHAT_SYSTEM = 'You are a helpful, concise assistant embedded in the Unyson+ Site Converter dashboard. Answer directly and clearly. Use fenced ``` code blocks for code. Do not show hidden reasoning or preambles.';
const CHAT_CONTEXT_TURNS = 12;

export async function chatLocalModel({ messages } = {}) {
  const backend = aiBackend();
  if (!backend) { const e = new Error('AI is off — pick a local model in Settings, or enable Claude (Claude Code / an API key).'); e.code = 503; throw e; }
  // Keep only well-formed, non-empty user/assistant turns, then cap the context we send to the model.
  const all = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .map((m) => ({ role: m.role, content: String(m.content) }));
  if (!all.length) { const e = new Error('No message to send.'); e.code = 400; throw e; }
  const ctx = all.slice(-CHAT_CONTEXT_TURNS);
  const t0 = Date.now();

  if (backend === 'ollama') {
    const model = selectedLocalModel();
    const to = parseInt(process.env.AI_CHAT_TIMEOUT_MS || process.env.AI_TIMEOUT_MS || '', 10) || 120000;
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, think: false, options: { temperature: 0 }, messages: [{ role: 'system', content: CHAT_SYSTEM }, ...ctx] }),
      signal: AbortSignal.timeout(to),
    }).catch((err) => { const e = new Error(`Could not reach Ollama at ${OLLAMA_HOST} (${err.message}) — is it running?`); e.code = 503; throw e; });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      const e = new Error(`Ollama ${resp.status}: ${t.slice(0, 200)} — is \`${model}\` pulled?`);
      e.code = resp.status === 404 ? 503 : 500; throw e;
    }
    const data = await resp.json();
    return { ok: true, model, reply: stripReasoning((data.message && data.message.content) || ''), ms: Date.now() - t0 };
  }

  // api / claude-code are single-shot text backends → fold the prior turns into one user prompt.
  const model = backend === 'api' ? DEFAULT_MODEL : (process.env.ANTHROPIC_MODEL || 'claude-code');
  let user;
  if (ctx.length > 1) {
    const convo = ctx.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
    user = `Continue this conversation. Reply ONLY as the assistant to the LAST user message.\n\n${convo}\n\nAssistant:`;
  } else {
    user = ctx[ctx.length - 1].content;
  }
  const reply = stripReasoning(await askText({ system: CHAT_SYSTEM, user, maxTokens: 4000 }));
  return { ok: true, model, reply, ms: Date.now() - t0 };
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
  if (forced === 'ollama' || forced === 'local') return ollamaReady() ? 'ollama' : null;
  // HEAVY tasks (full mapping / chrome / visual refine — the opt-in "Use AI" path) want the STRONGEST
  // backend, so Claude comes FIRST. The small local model is only a last-resort fallback here: on a
  // whole-page judgement it can degrade a correct deterministic call. The local model instead earns its
  // keep on the always-on, low-stakes MICRO layer (see microBackend + the pipeline's section-naming pass),
  // where a wrong guess is cheap and it SAVES Claude tokens. (Was ollama-first, which sidelined Claude.)
  if ((process.env.ANTHROPIC_API_KEY || '').trim()) return 'api';
  if (claudeCliAvailable()) return 'claude-code';
  if (ollamaReady()) return 'ollama';
  return null;
}

/**
 * MICRO tasks (section slugs, alt text, labels) prefer the LOCAL model — cheap, low-stakes, offline, and
 * it saves Claude tokens; Claude is only the fallback when no local model is set up. An explicit
 * AI_BACKEND override still wins (it applies to everything, heavy + micro alike).
 */
export function microBackend() {
  const forced = (process.env.AI_BACKEND || '').toLowerCase().replace(/[_\s]/g, '-');
  if (forced) return aiBackend();
  if (ollamaReady()) return 'ollama';
  if ((process.env.ANTHROPIC_API_KEY || '').trim()) return 'api';
  if (claudeCliAvailable()) return 'claude-code';
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
  if (backend === 'ollama') return refineViaOllamaLight(input);
  throw new Error('AI is off — set ANTHROPIC_API_KEY, install Claude Code (`claude`), or pick a local model (Ollama).');
}

/* ---- Scoped local job — a task a small model can WIN ------------------- *
 * Whole-page mapping is too hard for a 7B model (benchmarked ~15/100). So the LOCAL (Ollama) backend runs a
 * SMALL, schema-constrained job instead: given a COMPACT summary of each section, return only a short
 * semantic css_id slug + a decorative flag. Bounded output a small model handles reliably. The result is
 * applied NON-DESTRUCTIVELY (only valid slugs; only omit truly-empty decorative sections) — the model can
 * ONLY improve names + flag decoration, never rewrite or drop content. Claude/API keep the full refine. */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const SECTIONS_LIGHT_SYSTEM = `You label the sections of a web page for a website→WordPress converter.
For each section you get: its index, a short heading, the kinds of content blocks it has, and how much text it has.
Return ONE JSON object, no prose: { "sections": [ { "index": <int>, "css_id": "<slug>", "decorative": <bool> } ] }.
- css_id: a short semantic slug describing the section. Prefer this vocabulary when it fits: hero, features, pricing, faq, cta, about, testimonials, gallery, contact, stats, team, clients, services, content, header, footer. Lowercase, letters/digits/hyphens only ([a-z0-9-]).
- decorative: true ONLY for a section that is pure visual chrome with NO real content (a spacer, a divider, a decorative gradient band). If it has ANY heading or text, it is NOT decorative (false).
- Keep the SAME number of sections and the SAME index values you were given. Output only the JSON.`;
const SECTIONS_LIGHT_SCHEMA = {
  type: 'object',
  properties: { sections: { type: 'array', items: {
    type: 'object',
    properties: { index: { type: 'integer' }, css_id: { type: 'string' }, decorative: { type: 'boolean' } },
    required: ['index', 'css_id', 'decorative'],
  } } },
  required: ['sections'],
};

/** Does a section/block hold real (non-empty) content? */
function blockHasContent(b) {
  return !!(String((b && (b.text || b.html || b.label)) || '').trim() || (b && Array.isArray(b.cols) && b.cols.length));
}

/**
 * Flatten a draft mapping into COMPACT per-section summaries (index across all pages, in order), the input
 * to the scoped local job. Each: { index, css_id, heading, blockKinds, textLen }.
 */
export function summarizeSections(mapping) {
  const out = [];
  let i = 0;
  for (const page of ((mapping && mapping.pages) || [])) {
    for (const sec of ((page && page.sections) || [])) {
      const blocks = (sec && sec.blocks) || [];
      const head = blocks.find((b) => /^(title|heading|overline|subtitle)$/.test(b && b.role)) || {};
      const heading = String(head.text || head.label || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const blockKinds = [...new Set(blocks.map((b) => (b && (b.role || b.t)) || '').filter(Boolean))];
      const textLen = blocks.reduce((n, b) => n + String((b && (b.text || b.html)) || '').length, 0);
      out.push({ index: i, css_id: (sec && sec.css_id) || '', heading, blockKinds, textLen });
      i++;
    }
  }
  return out;
}

/**
 * Apply the local model's section labels back onto the draft mapping — NON-DESTRUCTIVELY (mutates in place).
 * Only overwrites a section css_id with a VALID [a-z0-9-] slug, and only sets omit when the model flagged the
 * section decorative AND it has no real content block. Never drops content. Pure/deterministic (unit-tested).
 * @returns {{renamed:number, decorative:number}}
 */
export function applySectionsLight(mapping, result) {
  const changes = { renamed: 0, decorative: 0 };
  const byIndex = new Map();
  for (const r of ((result && result.sections) || [])) { if (r && Number.isInteger(r.index)) byIndex.set(r.index, r); }
  let i = 0;
  for (const page of ((mapping && mapping.pages) || [])) {
    for (const sec of ((page && page.sections) || [])) {
      const r = byIndex.get(i); i++;
      if (!r) continue;
      if (typeof r.css_id === 'string') {
        const slug = r.css_id.trim().toLowerCase();
        if (SLUG_RE.test(slug) && slug !== sec.css_id) { sec.css_id = slug; changes.renamed++; }
      }
      if (r.decorative === true && !sec.omit) {
        const hasContent = ((sec.blocks) || []).some(blockHasContent);
        if (!hasContent) { sec.omit = true; changes.decorative++; }
      }
    }
  }
  return changes;
}

/**
 * Run the scoped local job: compact section summaries in → { sections:[{index,css_id,decorative}] } out.
 * Uses Ollama structured output (a strict JSON schema) so even a small model returns the exact shape.
 */
export async function refineSectionsLight({ sections }) {
  const model = selectedLocalModel();
  if (!model) throw new Error('No local model selected — pick one in the dashboard (Local AI).');
  const compact = (sections || []).map((s) => ({ index: s.index, css_id: s.css_id, heading: s.heading, blockKinds: s.blockKinds, textLen: s.textLen }));
  const user = `Sections (${compact.length}):\n${JSON.stringify(compact)}\n\nReturn the { "sections": [...] } JSON now.`;
  const to = parseInt(process.env.AI_TIMEOUT_MS || '', 10) || 120000;
  const text = await askModel({ system: SECTIONS_LIGHT_SYSTEM, user, model, format: SECTIONS_LIGHT_SCHEMA, timeoutMs: to });
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.sections)) throw new Error('The local model returned no sections.');
  return parsed;
}

/**
 * Backend 3 (Experimental): a local model via Ollama, running the SCOPED light job (not the full-page
 * rewrite). Best-effort: any model error falls through to the deterministic mapping unchanged.
 */
async function refineViaOllamaLight({ mapping }) {
  const model = selectedLocalModel();
  if (!model) throw new Error('No local model selected — pick one in the dashboard (Local AI).');
  const result = await refineSectionsLight({ sections: summarizeSections(mapping) })
    .catch((e) => { console.error('[ai-convert] local light refine failed:', e.message); return null; });
  if (result) {
    const changes = applySectionsLight(mapping, result);
    console.log(`[ai-convert] local model renamed ${changes.renamed} sections, flagged ${changes.decorative} decorative`);
  }
  return { mapping, theme: { style_css: '', header_html: '', footer_html: '' }, custom_css: '', model, backend: 'ollama' };
}

/**
 * ALWAYS-ON local micro layer (token-free): give sections semantic css_id slugs (+ flag pure-decoration
 * bands) using the scoped light job — run automatically in the capture pipeline whenever a LOCAL model is
 * set up. This is the "tiny bit on every step" the local model is good at: cheap, non-destructive (only
 * valid slugs; only omits truly-empty decorative bands), and it never touches structure. Mutates `mapping`
 * in place. Best-effort — returns null (and leaves the deterministic mapping unchanged) on any error, when
 * the preferred micro backend isn't the local model, or when there's nothing to name.
 *
 * @param {object} mapping review mapping ({ pages:[{ sections:[…] }] }).
 * @returns {Promise<null|{ model, renamed, decorative }>}
 */
export async function localSectionMicroTask(mapping) {
  if (microBackend() !== 'ollama' || !selectedLocalModel()) return null;
  if (!mapping || !Array.isArray(mapping.pages)) return null;
  try {
    const result = await refineSectionsLight({ sections: summarizeSections(mapping) });
    const changes = applySectionsLight(mapping, result);
    return { model: selectedLocalModel(), renamed: changes.renamed, decorative: changes.decorative };
  } catch (e) {
    console.error('[micro] local section-naming skipped:', e.message);
    return null;
  }
}

/* ---- Class-coverage VERIFICATION (local AI as QA, not author) ---------- *
 * The deterministic engine already records, per section, which fidelity-critical style properties the
 * source USES but the carried CSS did NOT reproduce (the style-coverage "gaps"). This pass has the LOCAL
 * model REVIEW those gaps and confirm which are VISUALLY SIGNIFICANT (a missing fill / frosted blur /
 * border / shadow / radius / bg image changes how the element reads) vs low-signal layout noise, with a
 * terse reason — so nothing visible is dropped SILENTLY. It never authors CSS (that stays deterministic);
 * it only flags, for the conversion report + Live progress. Best-effort: any error leaves the gaps as the
 * deterministic `significant` flag already marked them. */
const COVERAGE_VERIFY_SYSTEM = `You are a QA reviewer for a website→WordPress converter.
You are given a list of STYLE-COVERAGE GAPS. Each gap = a CSS property the SOURCE page uses on some
elements but the converted page's carried CSS did NOT reproduce — i.e. a dropped visual effect.
For each gap decide whether losing it is VISUALLY SIGNIFICANT (it changes how the page LOOKS and should be
reproduced) or not (low-signal layout detail a reader won't notice).
- SIGNIFICANT (true): a lost fill (background-color/background-image), frosted blur (backdrop-filter), border,
  box-shadow, or border-radius — anything that changes an element's visible surface.
- NOT significant (false): minor gap/margin/padding/display/position differences that don't change the look.
Return ONE JSON object, no prose: { "gaps": [ { "id": <int>, "significant": <bool>, "reason": "<≤8 words>" } ] }.
Keep the SAME id values you were given. Output only the JSON.`;
const COVERAGE_VERIFY_SCHEMA = {
  type: 'object',
  properties: { gaps: { type: 'array', items: {
    type: 'object',
    properties: { id: { type: 'integer' }, significant: { type: 'boolean' }, reason: { type: 'string' } },
    required: ['id', 'significant'],
  } } },
  required: ['gaps'],
};

/**
 * Verify style-coverage gaps with the local model. `gaps` is toStyleReport().gaps —
 * [{ page, s_index, s_class, property, uses, significant }]. Returns the same gaps enriched with an AI
 * verdict + reason, plus a flagged (significant) subset. Deterministic `significant` is the floor: the AI
 * can PROMOTE a gap to significant (or annotate), never silently clear a truly-visual property.
 */
export async function verifyCoverage(gaps, { max = 40 } = {}) {
  const list = Array.isArray(gaps) ? gaps.filter((g) => g && g.property) : [];
  if (!list.length) return { model: '', gaps: [], flagged: [], total: 0, significant: 0 };
  // Cap the payload: significant-looking gaps first, then by src-use count (biggest visual footprint).
  const VISUAL = new Set(['background-image', 'background-color', 'backdrop-filter', 'box-shadow', 'border', 'border-radius']);
  const ranked = list.slice().sort((a, b) => (Number(b.significant) - Number(a.significant)) || ((b.uses || 0) - (a.uses || 0)));
  const sent = ranked.slice(0, max).map((g, id) => ({ id, ...g }));
  let verdicts = {};
  if (microBackend() === 'ollama' && selectedLocalModel()) {
    try {
      const model = selectedLocalModel();
      const compact = sent.map((g) => ({ id: g.id, property: g.property, on_elements: g.uses, section: g.s_class || g.page }));
      const user = `Gaps (${compact.length}):\n${JSON.stringify(compact)}\n\nReturn the { "gaps": [...] } JSON now.`;
      const to = parseInt(process.env.AI_TIMEOUT_MS || '', 10) || 120000;
      const text = await askModel({ system: COVERAGE_VERIFY_SYSTEM, user, model, format: COVERAGE_VERIFY_SCHEMA, timeoutMs: to });
      const parsed = extractJson(text);
      if (parsed && Array.isArray(parsed.gaps)) { for (const v of parsed.gaps) { if (v && Number.isInteger(v.id)) verdicts[v.id] = v; } }
    } catch (e) { console.error('[coverage] local verification skipped:', e.message); }
  }
  const out = sent.map((g) => {
    const v = verdicts[g.id] || {};
    // Floor: a truly-visual property stays significant even if the model says otherwise (never lose a
    // visible effect silently); the model may PROMOTE a non-visual one it judges important.
    const significant = VISUAL.has(g.property) ? true : (typeof v.significant === 'boolean' ? v.significant : !!g.significant);
    return { page: g.page, s_index: g.s_index, s_class: g.s_class, property: g.property, uses: g.uses, significant, reason: String(v.reason || '').slice(0, 60) };
  });
  const flagged = out.filter((g) => g.significant);
  return { model: (microBackend() === 'ollama' ? selectedLocalModel() : '') || '', gaps: out, flagged, total: out.length, significant: flagged.length };
}

/* ---- Box-Preset NAMING (local AI as a design-system namer) ------------- *
 * The deterministic detector clusters the page's box skins into presets but can only auto-name them by
 * shape (Card / Tinted / Glass …). This pass has the LOCAL model give each a human, role-aware name
 * ("Feature Card", "Problem Card", "Glass Stat Box", "Icon Chip") from the fill hue + border + glass +
 * hover. It only RENAMES (never changes the skin); the caller recomputes the slug map after. Best-effort. */
const BOX_NAME_SYSTEM = `You name reusable CARD/BOX styles for a website builder's preset library.
Each box has: an id, a background fill (rgba/rgb or "none"), whether it has a border, its corner radius, whether it is frosted GLASS (backdrop blur), and whether it has a HOVER effect.
Give each a SHORT human design-system name (2-3 words) describing its role/look. Use the fill HUE as the biggest hint:
- red/orange tint → "Alert Card" or "Problem Card"; green tint → "Solution Card" or "Success Card";
- translucent white / glass → "Glass Panel" or "Glass Stat Box"; cream/off-white/light → "Feature Card";
- a very round (pill) small box → "Icon Chip" or "Pill Badge"; border-only (no fill) → "Outline Card".
Return ONE JSON object, no prose: { "names": [ { "id": "<id>", "name": "<2-3 words>" } ] }. Keep the SAME ids. Output only JSON.`;
const BOX_NAME_SCHEMA = {
  type: 'object',
  properties: { names: { type: 'array', items: {
    type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'],
  } } },
  required: ['names'],
};

/** Rename the DERIVED box presets in place via the local model. Returns { model, renamed }. No-op (renamed:0)
 *  when no local model is set up. The caller must recompute the slug map / boxpFor afterwards. */
export async function nameBoxPresets(derived) {
  if (microBackend() !== 'ollama' || !selectedLocalModel()) return { model: '', renamed: 0 };
  const list = (Array.isArray(derived) ? derived : []).filter((p) => p && p.id);
  if (!list.length) return { model: '', renamed: 0 };
  try {
    const model = selectedLocalModel();
    const compact = list.map((p) => {
      const d = (p.states && p.states.default) || {};
      const fill = (d.background && d.background.color && d.background.color.value && d.background.color.value.custom) || '';
      return { id: p.id, fill: fill || 'none', border: !!d.border_width, radius: ((p.border_radius && p.border_radius.value) || '') + ((p.border_radius && p.border_radius.unit) || ''), glass: /backdrop-filter/.test(String(p.custom_css || '')), hover: !!(p.states && p.states.hover) };
    });
    const user = `Boxes (${compact.length}):\n${JSON.stringify(compact)}\n\nReturn the { "names": [...] } JSON now.`;
    const to = parseInt(process.env.AI_TIMEOUT_MS || '', 10) || 120000;
    const text = await askModel({ system: BOX_NAME_SYSTEM, user, model, format: BOX_NAME_SCHEMA, timeoutMs: to });
    const parsed = extractJson(text);
    let renamed = 0;
    if (parsed && Array.isArray(parsed.names)) {
      const byId = new Map(list.map((p) => [p.id, p]));
      for (const nm of parsed.names) {
        if (nm && nm.id && byId.has(nm.id)) { const name = String(nm.name || '').trim().replace(/["\r\n]/g, '').slice(0, 32); if (name) { byId.get(nm.id).preset_name = name; renamed++; } }
      }
    }
    return { model, renamed };
  } catch (e) { console.error('[box-names] local naming skipped:', e.message); return { model: '', renamed: 0 }; }
}

/* ---- Section-Style NAMING (local AI) — the coloured section BANDS ------- *
 * Run as a PRE-pass (before to-pages derives each section's `variant` slug from style_name), so renaming
 * needs no reslug. Names each band by its fill: brand/green → "Brand Band", dark → "Dark Band", tint →
 * "Alt Section", etc. Renames style_name in place; best-effort. */
const SECTION_NAME_SYSTEM = `You name reusable SECTION BACKGROUND styles (full-width coloured bands) for a website builder.
Each band has an id and a background fill (rgb/rgba or "none"). Give each a SHORT human name (1-3 words) from its fill:
- the brand/primary hue → "Brand Band"; a dark fill → "Dark Band"; a light tint → "Alt Section"; near-white → "Light Section"; an accent/CTA hue → "CTA Band".
Return ONE JSON object, no prose: { "names": [ { "id": "<id>", "name": "<1-3 words>" } ] }. Keep the SAME ids. Output only JSON.`;
const SECTION_NAME_SCHEMA = {
  type: 'object',
  properties: { names: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] } } },
  required: ['names'],
};

/** Rename section-style presets in place via the local model (id = index if none). Returns { model, renamed }. */
export async function nameSectionStyles(presets) {
  if (microBackend() !== 'ollama' || !selectedLocalModel()) return { model: '', renamed: 0 };
  const list = (Array.isArray(presets) ? presets : []).filter(Boolean);
  if (!list.length) return { model: '', renamed: 0 };
  try {
    const model = selectedLocalModel();
    const fillOf = (p) => {
      const bg = p.background || {};
      return (bg.color && bg.color.value && bg.color.value.custom) || (typeof bg.color === 'string' ? bg.color : '') || (typeof bg === 'string' ? bg : '') || '';
    };
    const compact = list.map((p, i) => ({ id: String(i), fill: fillOf(p) || 'none' }));
    const user = `Bands (${compact.length}):\n${JSON.stringify(compact)}\n\nReturn the { "names": [...] } JSON now.`;
    const to = parseInt(process.env.AI_TIMEOUT_MS || '', 10) || 120000;
    const text = await askModel({ system: SECTION_NAME_SYSTEM, user, model, format: SECTION_NAME_SCHEMA, timeoutMs: to });
    const parsed = extractJson(text);
    let renamed = 0;
    if (parsed && Array.isArray(parsed.names)) {
      for (const nm of parsed.names) { const i = parseInt(nm && nm.id, 10); if (Number.isInteger(i) && list[i]) { const name = String(nm.name || '').trim().replace(/["\r\n]/g, '').slice(0, 28); if (name) { list[i].style_name = name; renamed++; } } }
    }
    return { model, renamed };
  } catch (e) { console.error('[section-names] local naming skipped:', e.message); return { model: '', renamed: 0 }; }
}

/* ---- Accordion design VERIFY (local AI as a checker) ------------------- *
 * The deterministic detector (accordion_design) reads the source's computed styles to pick icon_style &
 * accordion_style. This pass has the LOCAL model CHECK that call against the real toggle-icon markup — it
 * only CORRECTS an obviously-wrong icon_style/accordion_style (never invents other keys), so nothing the
 * detector got right is dropped. Best-effort: a no-op when no local model is configured. */
const ACCORDION_VERIFY_SYSTEM = `You verify how a website ACCORDION/FAQ was mapped to a builder's options.
For each accordion you get: the toggle ICON markup (svg path / class / lucide name / or a literal glyph), item COUNT, the GAP between items (px), corner RADIUS (px), whether each item has its own background (hasBg), each item's border width (itemBw), and the mapper's current guess for icon_style and accordion_style.
Decide the BEST value for each, ONLY from this evidence:
- icon_style ∈ plus-minus | plus-x | chevron | arrow | none. A chevron/caret path (e.g. "m6 9 6 6 6-6", polyline pointing down, class/lucide "chevron"/"caret") → chevron. A +/− glyph or "plus"/"minus" → plus-minus. An × / "times"/"close" pairing → plus-x. A ▶/triangle/"arrow"/"caret-right" → arrow. No icon element and no glyph → none.
- accordion_style ∈ bordered | separated | flush | filled | ghost. gap>=4 with a per-item border or radius → separated; gap>=4 with a tinted fill but no border → filled; gap<4 with hairline dividers and no box → flush; gap<4 inside one bordered box → bordered; borderless with an accent underline → ghost.
Return ONE JSON object, no prose: { "items": [ { "id": <int>, "icon_style": "<value>", "accordion_style": "<value>" } ] }. Keep the SAME ids. Output only JSON.`;
const ACCORDION_VERIFY_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: {
    type: 'object', properties: { id: { type: 'integer' }, icon_style: { type: 'string' }, accordion_style: { type: 'string' } }, required: ['id'],
  } } },
  required: ['items'],
};
const _ICON_VALS = new Set(['plus-minus', 'plus-x', 'chevron', 'arrow', 'none']);
const _STYLE_VALS = new Set(['bordered', 'separated', 'flush', 'filled', 'ghost']);

/**
 * Verify/correct each accordion node's icon_style & accordion_style via the local model, from the stashed
 * `_accordion_hint`. Mutates the node's atts in place and deletes the hint. Returns { model, checked,
 * corrected }. No-op (corrected:0) when no local model — the deterministic guess stands.
 * @param {Array} nodes accordion builder nodes carrying atts._accordion_hint
 */
export async function verifyAccordionDesign(nodes) {
  const list = (Array.isArray(nodes) ? nodes : []).filter((n) => n && n.atts && n.atts._accordion_hint);
  if (!list.length) return { model: '', checked: 0, corrected: 0 };
  let verdicts = {};
  if (microBackend() === 'ollama' && selectedLocalModel()) {
    try {
      const model = selectedLocalModel();
      const compact = list.map((n, id) => {
        const h = n.atts._accordion_hint; const g = h.hint || {};
        return { id, icon: String(g.icon || '').slice(0, 160), count: g.count, gap: g.gap, radius: g.radius, hasBg: !!g.hasBg, itemBw: g.itemBw, guess_icon: h.icon_style, guess_style: h.accordion_style };
      });
      const user = `Accordions (${compact.length}):\n${JSON.stringify(compact)}\n\nReturn the { "items": [...] } JSON now.`;
      const to = parseInt(process.env.AI_TIMEOUT_MS || '', 10) || 120000;
      const text = await askModel({ system: ACCORDION_VERIFY_SYSTEM, user, model, format: ACCORDION_VERIFY_SCHEMA, timeoutMs: to });
      const parsed = extractJson(text);
      if (parsed && Array.isArray(parsed.items)) { for (const v of parsed.items) { if (v && Number.isInteger(v.id)) verdicts[v.id] = v; } }
    } catch (e) { console.error('[accordion] local verify skipped:', e.message); }
  }
  let corrected = 0;
  list.forEach((n, id) => {
    const v = verdicts[id] || {};
    const ic = String(v.icon_style || '').trim();
    const st = String(v.accordion_style || '').trim();
    if (ic && _ICON_VALS.has(ic) && ic !== n.atts.icon_style) { n.atts.icon_style = ic; if (ic === 'none') delete n.atts.icon_position; corrected++; }
    if (st && _STYLE_VALS.has(st) && st !== n.atts.accordion_style) { n.atts.accordion_style = st; corrected++; }
    delete n.atts._accordion_hint;
  });
  return { model: (microBackend() === 'ollama' ? selectedLocalModel() : '') || '', checked: list.length, corrected };
}

/* ---- Visual refinement (self-verify → AI-fix loop) --------------------- *
 * A raw text→text call to whichever backend is active (used to generate CSS that closes the source-vs-
 * converted visual gap). Unlike refineMapping, this returns the model's raw text (not a parsed mapping). */
async function askText({ system, user, maxTokens = 8000 }) {
  const backend = aiBackend();
  if (backend === 'api') {
    const key = (process.env.ANTHROPIC_API_KEY || '').trim();
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: DEFAULT_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!resp.ok) throw new Error('Anthropic API ' + resp.status + ': ' + (await resp.text().catch(() => '')).slice(0, 300));
    const data = await resp.json();
    return (data.content || []).map((c) => c.text || '').join('').trim();
  }
  if (backend === 'claude-code') {
    const cmd = process.env.CLAUDE_CLI || 'claude';
    const args = ['-p', '--output-format', 'json', '--max-turns', '1'];
    const model = (process.env.ANTHROPIC_MODEL || '').replace(/[^a-zA-Z0-9._-]/g, ''); if (model) { args.push('--model', model); }
    const stdout = await runClaude(cmd, args, system + '\n\n' + user);
    let text = stdout.trim();
    try { const j = JSON.parse(stdout); if (j && j.is_error) { throw new Error('Claude Code error: ' + String(j.result || '').slice(0, 200)); } if (j && typeof j.result === 'string') { text = j.result; } }
    catch (e) { if (e.message && e.message.startsWith('Claude Code error')) throw e; }
    return text;
  }
  if (backend === 'ollama') {
    const model = selectedLocalModel();
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, think: false, options: { temperature: 0 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(parseInt(process.env.AI_TIMEOUT_MS || '', 10) || 180000),
    });
    if (!resp.ok) throw new Error('Ollama ' + resp.status + ' — is the model pulled?');
    const data = await resp.json();
    // Strip any stray <think>…</think> (belt-and-suspenders for hybrid-reasoning models).
    return String((data.message && data.message.content) || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }
  throw new Error('AI is off — configure a backend (Claude Code, API key, or a local model).');
}

const VISUAL_CSS_SYSTEM = `You improve a WordPress site conversion by writing CSS. You are given the SOURCE page HTML (the look to match) and the CONVERTED WordPress page HTML (a page-builder rebuild that should look like the source but has visual gaps — most often MISSING section background colours/gradients, wrong text colours, or wrong spacing).

Output ONLY CSS that, when added to the CONVERTED page, makes it look closer to the SOURCE.
RULES:
- Use ONLY selectors that exist in the CONVERTED HTML (its real ids/classes — e.g. #section-3, #hero, .fw-container). NEVER invent selectors and NEVER target the source's classes.
- Prefer full-width section band fills: e.g. #section-3 { background: <the source's colour/gradient> !important; }. Take colours/gradients from the SOURCE.
- Also correct obviously-wrong text colours and clearly-missing band backgrounds. Keep every change small, additive and safe. Do NOT restructure layout, change fonts, or set widths.
- Return ONLY a CSS block. No prose, no markdown fences.`;

/**
 * Generate CSS that closes the source-vs-converted visual gap, scoped to the CONVERTED page's real selectors.
 * The caller injects this into a fresh render and re-measures drift, keeping it only if drift drops.
 * @param {{ sourceHtml:string, convertedHtml:string, drift:number }} o
 * @returns {Promise<string>} css (empty string if no AI backend)
 */
export async function refineVisualCss({ sourceHtml, convertedHtml, drift }) {
  if (!aiBackend()) return '';
  const user =
    `Overall visual drift (source vs converted): ${drift}%.\n\n` +
    `=== SOURCE HTML (the look to match) ===\n${String(sourceHtml || '').slice(0, 45000)}\n\n` +
    `=== CONVERTED HTML (target THESE real selectors) ===\n${String(convertedHtml || '').slice(0, 45000)}\n\n` +
    `Return CSS (scoped to the converted page's real selectors) that closes the gap.`;
  const text = await askText({ system: VISUAL_CSS_SYSTEM, user });
  // Strip code fences / any stray prose before the first rule.
  return String(text || '').replace(/```(?:css)?/gi, '').trim();
}

/* ---- Chrome (header/footer) refinement ------------------------------- *
 * A narrower sibling of refineVisualCss: it fixes ONLY the header/footer, scoped to the converted page's
 * real chrome selectors. HEADER-FIRST — the caller runs the header region first (primary) and the footer
 * second (secondary). Local 7B models have small context, so the caller trims the HTML to the header/footer
 * regions before calling. NOTE: Claude gives noticeably better results than the local models here. */
const CHROME_CSS_SYSTEM = `You are improving ONLY the header/footer CSS of a converted WordPress site to match a source design.
Output ONLY a CSS block (no prose, no markdown fences), scoped to the GIVEN selectors.
Fix background color, text/link color, layout (flex/grid columns), spacing (padding/margins/gap), height, alignment, and CONTENT WIDTH of the header/footer.
RULES:
- Use ONLY the selectors you are given (the converted page's real header/footer ids/classes). You MAY use descendant selectors under them (e.g. ".sc-header a", "#masthead .menu"). NEVER invent unrelated selectors and NEVER target the source's classes.
- CONTAINER WIDTH: if the source's header/footer content is capped at a max-width and horizontally centered (a content container / inner wrapper — often \`.container\` or a \`max-w-*\` wrapper in the source markup, with a computed max-width in its style), reproduce that: set the matching converted inner wrapper to \`max-width: <the source's px value>; margin-left:auto; margin-right:auto; width:100%\` so the columns don't span full-bleed. Read the target width from the source markup's computed styles — do not guess.
- Do NOT touch the page body or content sections — only the header/footer chrome.
- Prefer the SOURCE's colors, spacing, and layout. Keep every rule small, additive and safe; use !important sparingly where the base theme would otherwise win.
- Return ONLY a CSS block.`;

/**
 * Generate CSS that closes the header/footer visual gap, scoped to the converted page's real chrome selectors.
 * The caller injects this into a fresh render and re-measures chrome drift, keeping it ONLY if drift drops.
 * @param {{ sourceHtml:string, convertedHtml:string, selectors:string[], region:string }} o
 * @returns {Promise<string>} css (empty string if no AI backend)
 */
export async function refineChromeCss({ sourceHtml, convertedHtml, selectors, region }) {
  if (!aiBackend()) return '';
  const allowed = (Array.isArray(selectors) ? selectors : []).filter(Boolean);
  const user =
    `Region to fix: ${region || 'header'} (this is the PRIMARY target).\n\n` +
    `Allowed selectors (scope ALL rules to these): ${allowed.length ? allowed.join(', ') : region}\n\n` +
    `=== SOURCE ${String(region || 'header').toUpperCase()} HTML (the look to match) ===\n${String(sourceHtml || '').slice(0, 18000)}\n\n` +
    `=== CONVERTED ${String(region || 'header').toUpperCase()} HTML (target THESE real selectors) ===\n${String(convertedHtml || '').slice(0, 18000)}\n\n` +
    `Return CSS (scoped to the allowed selectors) that makes the converted ${region || 'header'} match the source.`;
  const text = await askText({ system: CHROME_CSS_SYSTEM, user, maxTokens: 4000 });
  // Strip code fences / any stray prose before the first rule (same as refineVisualCss).
  return String(text || '').replace(/```(?:css)?/gi, '').trim();
}

/* ---------------------------------------------------------------------- *
 * User-directed "prompt the AI to change my site" (POST /ai-instruct).
 *
 * Unlike the automatic conversion refiners above, this is DRIVEN BY THE USER: they type an
 * instruction ("make the hero darker", "bigger rounder buttons", "turn this into a real pricing
 * table") and the model CLASSIFIES the intent per prompt:
 *   • Visual/style change → it writes SCOPED CSS overrides (applied + shown, keep/discard).
 *   • Structural change (re-map / add / remove / convert a section) → a small local model is NOT
 *     trusted to auto-rewrite the page, so it only DESCRIBES the change in a note. Never auto-applied.
 * Returns strict JSON { kind:'css'|'structural'|'both', css, structural_note, explanation }.
 * The returned CSS is run through sanitizeTweakCss() (the trust boundary) before it ever leaves here.
 * ---------------------------------------------------------------------- */

const INSTRUCT_SYSTEM = `You improve an already-converted WordPress page. You are given the CONVERTED page's rendered HTML (with its real classes/ids), the CSS already applied to it, and optionally the ORIGINAL source page for reference. A user gives you ONE instruction. Your job is to DECIDE whether the instruction is a CSS/visual change or a STRUCTURAL change, and return ONE JSON object — no prose, no markdown fences:
{ "kind": "css" | "structural" | "both", "css": "<css rules>", "structural_note": "<plain English>", "explanation": "<one sentence>" }

Classify:
- "css" — a visual/style change achievable with CSS overrides (colors, backgrounds, spacing, sizes, borders, radius, typography, alignment, shadows). MOST requests are this.
- "structural" — the request needs the page's structure/markup changed: re-mapping a section to a different component, converting a block into a real table/accordion/pricing table, adding or removing a section, reordering content. You CANNOT do this with CSS.
- "both" — only when a request clearly needs a structural change AND a helpful CSS tweak.

Rules for CSS (kind "css" or "both"):
- Output ONLY valid CSS rules (selector { prop: value; } ...). No <style> tags, no @import, no external url(), no javascript.
- Target ONLY selectors that actually appear in the CONVERTED page HTML (its real ids/classes — e.g. #section-3, .fw-container, .sc-button). NEVER invent selectors and NEVER target the source page's classes.
- Prefer minimal, reversible overrides. Use !important sparingly, only where the base theme would otherwise win. Do not rewrite page content.

Rules for STRUCTURAL (kind "structural" or "both"):
- DO NOT write CSS or markup for the structural part — only DESCRIBE the change in structural_note (what to change and where), in plain English. Leave "css" empty when kind is "structural".

Keep "explanation" to ONE short sentence summarizing what you did/decided. Never rewrite the page's text content.`;

const INSTRUCT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['css', 'structural', 'both'] },
    css: { type: 'string' },
    structural_note: { type: 'string' },
    explanation: { type: 'string' },
  },
  required: ['kind', 'css', 'structural_note', 'explanation'],
};

/**
 * Sanitize model-authored CSS before it is applied to a live page. THE TRUST BOUNDARY — never inject
 * unsanitized model output. Rules:
 *   - drop code fences and any HTML tags (esp. <script>/<style>, whose contents are removed too),
 *   - drop @import rules,
 *   - drop `javascript:` and neutralize `expression(` (legacy IE CSS-JS),
 *   - neutralize url(...) that points OFF-ORIGIN: allow only `data:` and same-origin relative/root-
 *     relative/hash refs; any scheme (http:, https:, //, file:, etc.) → the url() becomes `none`,
 *   - cap the result length (20 KB).
 * Pure + deterministic (unit-tested).
 * @param {string} input
 * @returns {string} sanitized CSS (may be '')
 */
export function sanitizeTweakCss(input) {
  let css = String(input == null ? '' : input);
  // 1) code fences a model might wrap the block in.
  css = css.replace(/```(?:css)?/gi, '');
  // 2) <script>/<style> blocks (with their contents), then any remaining HTML tags.
  css = css.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  css = css.replace(/<\/?[a-z][\s\S]*?>/gi, '');
  // 3) @import (can pull remote stylesheets).
  css = css.replace(/@import[^;]*;?/gi, '');
  // 4) javascript: URLs and IE expression().
  css = css.replace(/javascript\s*:/gi, '');
  css = css.replace(/expression\s*\(/gi, '(');
  // 5) neutralize off-origin url(...). Allow data: and same-origin relative/root-relative/hash refs.
  css = css.replace(/url\(\s*(['"]?)\s*([^)'"]*?)\s*\1\s*\)/gi, (_m, q, ref) => {
    const r = String(ref || '').trim();
    if (!r) return 'none';
    if (/^data:/i.test(r)) return `url(${q}${r}${q})`;            // inline data URIs are safe
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(r)) return 'none';   // any scheme or protocol-relative → off-origin, drop
    return `url(${q}${r}${q})`;                                    // relative / root-relative / #frag → same-origin, keep
  });
  // 6) cap length.
  if (css.length > 20000) css = css.slice(0, 20000);
  return css.trim();
}

/**
 * Normalize + validate a model's raw instruct result into the strict response shape. Pure + testable.
 * Enforces the contract: css-kind clears the note; structural-kind clears (and never emits) css; an
 * unknown/missing kind is INFERRED from what's present. Always returns a well-formed object.
 * @param {any} parsed
 * @returns {{ kind:'css'|'structural'|'both', css:string, structural_note:string, explanation:string }}
 */
export function normalizeInstructResult(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  let kind = String(p.kind || '').trim().toLowerCase();
  let css = sanitizeTweakCss(p.css);
  let note = String(p.structural_note || '').replace(/\s+/g, ' ').trim();
  let explanation = String(p.explanation || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!['css', 'structural', 'both'].includes(kind)) {
    // Infer from what the model actually produced.
    if (css && note) kind = 'both';
    else if (note && !css) kind = 'structural';
    else kind = 'css';
  }
  if (kind === 'css') note = '';           // CSS change carries no structural note
  if (kind === 'structural') css = '';     // structural change is NEVER auto-CSS'd
  if (!explanation) {
    explanation = kind === 'structural'
      ? 'Described a structural change to make in the builder.'
      : (css ? 'Wrote CSS overrides for your request.' : 'No change was produced for that request.');
  }
  return { kind, css, structural_note: note, explanation };
}

/** Build the user-turn for an instruct request (shared by every backend). */
function buildInstructUser({ prompt, pageHtml, customCss, sourceHtml }) {
  const page = String(pageHtml || '').slice(0, MAX_HTML);
  const cur = String(customCss || '').slice(0, 20000);
  const src = String(sourceHtml || '').slice(0, 30000);
  let u = `USER INSTRUCTION:\n${String(prompt || '').trim()}\n\n`;
  u += `=== CONVERTED PAGE HTML (target THESE real selectors) ===\n${page || '(none provided)'}\n\n`;
  if (cur) u += `=== CSS ALREADY APPLIED ===\n${cur}\n\n`;
  if (src) u += `=== ORIGINAL SOURCE HTML (reference only — do NOT target its classes) ===\n${src}\n\n`;
  u += `Return the { "kind", "css", "structural_note", "explanation" } JSON object now.`;
  return u;
}

/**
 * User-directed tweak: classify a typed instruction and return scoped CSS overrides and/or a structural
 * note. Routes by the active backend (api / claude-code / ollama), just like refineMapping. The returned
 * css is ALWAYS run through sanitizeTweakCss() before it leaves this function.
 * @param {{ prompt:string, pageHtml?:string, customCss?:string, sourceHtml?:string }} o
 * @returns {Promise<{ ok:true, kind, css, structural_note, explanation, model, backend }>}
 */
export async function instructTweak({ prompt, pageHtml, customCss, sourceHtml } = {}) {
  const p = String(prompt || '').trim();
  if (!p) { const e = new Error('Provide a prompt (what should the AI change?).'); e.code = 400; throw e; }
  const backend = aiBackend();
  if (!backend) { const e = new Error('AI is off — pick a local model, or enable Claude (Claude Code / an API key).'); e.code = 503; throw e; }
  const user = buildInstructUser({ prompt: p, pageHtml, customCss, sourceHtml });

  let raw, model;
  if (backend === 'ollama') {
    model = selectedLocalModel();
    // Direct Ollama /api/chat with a strict JSON schema (format) + think:false + temp 0 — via askModel.
    raw = await askModel({ system: INSTRUCT_SYSTEM, user, model, format: INSTRUCT_SCHEMA });
  } else {
    model = backend === 'api' ? DEFAULT_MODEL : (process.env.ANTHROPIC_MODEL || 'claude-code');
    raw = await askText({ system: INSTRUCT_SYSTEM, user, maxTokens: 4000 });
  }
  const parsed = extractJson(stripReasoning(raw));
  if (!parsed || typeof parsed !== 'object') throw new Error('The AI did not return a usable answer. Try rephrasing.');
  const norm = normalizeInstructResult(parsed);
  return { ok: true, ...norm, model, backend };
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

/* ---------------------------------------------------------------------- *
 * Per-model call helper (used by the benchmark + the header translator).
 * Runs an arbitrary named model — an Ollama tag OR Claude Code — with the
 * SAME prompt, independent of the user's selected backend. This is the
 * building block that lets header-translate.mjs / benchmark-models.mjs run
 * one prompt across many models to compare them.
 * ---------------------------------------------------------------------- */

/* ---------------------------------------------------------------------- *
 * Entrance-animation REFINEMENT — re-pick a tasteful effect + timing per
 * element on TOP of the converter's deterministic sequential-reveal base.
 * The deterministic pass (PHP mapper) already set every element to a safe
 * fade-up / fade with a per-section stagger; this only ADJUSTS the effect
 * and delay per element using the element's role + text. Constrained to the
 * Animate.css entrance vocabulary so nothing invalid can be written; any
 * failure leaves the deterministic base untouched (caller falls back).
 * ---------------------------------------------------------------------- */

/** The ONLY effects the refinement may choose from — Animate.css *entrances* (one-shot reveals). No
 *  attention-seekers (pulse/shake) — those loop and don't read as an entrance. Kept in sync with the
 *  PHP allowlist (Mapper::anim_effect_allowlist). */
export const ANIM_ENTRANCE_EFFECTS = [
  'animate__fadeIn', 'animate__fadeInUp', 'animate__fadeInDown', 'animate__fadeInLeft', 'animate__fadeInRight',
  'animate__zoomIn', 'animate__slideInUp', 'animate__slideInLeft', 'animate__slideInRight',
  'animate__backInUp', 'animate__backInDown', 'animate__bounceIn', 'animate__flipInX', 'animate__rotateIn',
];

const ANIM_SYSTEM = `You are a motion designer polishing the entrance animations of a converted web page.
You are given, as JSON, an ordered list of the page's animatable elements — each with its section index,
its shortcode (role), a short text label, and the DEFAULT effect + delay a deterministic pass already assigned.
Re-pick a TASTEFUL entrance effect and delay for each element. Rules:
- Choose "effect" ONLY from this exact set: ${ANIM_ENTRANCE_EFFECTS.join(', ')}. Never invent one.
- Keep it calm and coherent — most content reads best as fadeInUp; media (images/galleries/video) as fadeIn or zoomIn.
  Use directional slides/backs sparingly for emphasis (e.g. a hero CTA, a single feature). Never make a page a circus.
- "delay" is SECONDS before the element reveals, relative to its section entering view. Preserve a gentle
  SEQUENTIAL cascade WITHIN each section (delays increase down the section, ~0.08–0.16s apart) and RESET to a
  small value at the start of each new section. Keep every delay between 0 and 1.2.
- Return EVERY input element exactly once, keyed by its "i". Output ONE JSON object, no prose, no markdown fences:
{"items":[{"i":0,"effect":"animate__fadeInUp","delay":0},{"i":1,"effect":"animate__fadeIn","delay":0.12}]}`;

const ANIM_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:      { type: 'integer' },
          effect: { type: 'string', enum: ANIM_ENTRANCE_EFFECTS },
          delay:  { type: 'number' },
        },
        required: ['i', 'effect', 'delay'],
      },
    },
  },
  required: ['items'],
};

/**
 * Refine an entrance-animation plan. `plan` is an array of { i, section, sc, text, effect, delay } —
 * the deterministic base. Returns { ok, items:[{i,effect,delay}], model, backend }, where items is
 * validated down to the allowed effect set and sane delays. Throws (503) when no AI backend is active.
 */
export async function refineAnimations({ plan } = {}) {
  const items = Array.isArray(plan) ? plan : [];
  if (!items.length) { return { ok: true, items: [], model: null, backend: aiBackend() || null }; }
  const backend = aiBackend();
  if (!backend) { const e = new Error('AI is off — pick a local model, or enable Claude (Claude Code / an API key).'); e.code = 503; throw e; }

  const user = 'Here are the page elements to refine (JSON):\n' + JSON.stringify(items);
  let raw, model;
  if (backend === 'ollama') {
    model = selectedLocalModel();
    raw = await askModel({ system: ANIM_SYSTEM, user, model, format: ANIM_SCHEMA });
  } else {
    model = backend === 'api' ? DEFAULT_MODEL : (process.env.ANTHROPIC_MODEL || 'claude-code');
    raw = await askModel({ system: ANIM_SYSTEM, user, model });
  }
  const parsed = extractJson(stripReasoning(raw));
  const list = parsed && Array.isArray(parsed.items) ? parsed.items : [];
  const allow = new Set(ANIM_ENTRANCE_EFFECTS);
  const seen = new Set();
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const i = Number.isInteger(it.i) ? it.i : parseInt(it.i, 10);
    if (!Number.isInteger(i) || i < 0 || i >= items.length || seen.has(i)) continue;
    const effect = String(it.effect || '');
    if (!allow.has(effect)) continue;
    let delay = Number(it.delay);
    if (!Number.isFinite(delay)) delay = 0;
    delay = Math.max(0, Math.min(1.2, delay));
    seen.add(i);
    out.push({ i, effect, delay });
  }
  return { ok: true, items: out, model, backend };
}

/** True if a model id means "Claude via the Claude Code CLI". */
export function isClaudeModel(model) {
  const m = String(model || '').trim().toLowerCase();
  return m === 'claude' || m === 'claude-code' || m === 'cli';
}

/** List the Ollama tags currently PULLED on this machine (never pulls). Empty array if unreachable. */
export async function listPulledModels() {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return [];
    return ((await r.json()).models || []).map((m) => m.name || m.model).filter(Boolean);
  } catch { return []; }
}

/** Is the `claude` CLI available on PATH? (public wrapper around the cached check). */
export function claudeAvailable() { return claudeCliAvailable(); }

/**
 * Run ONE prompt against a SPECIFIC named model, independent of the selected backend.
 * @param {{ system:string, user:string, model:string, json?:boolean, format?:(string|object), timeoutMs?:number }} o
 *   model  = an Ollama tag (e.g. "qwen3:8b") OR "claude"/"claude-code" for Claude Code.
 *   json   = ask for JSON output (Ollama `format`); default true.
 *   format = Ollama structured-output constraint: a JSON-schema OBJECT (grammar-constrains the
 *            output to that exact shape) or the string "json" (any valid JSON). When omitted and
 *            `json` is true, defaults to "json". Ignored for the Claude Code backend.
 * @returns {Promise<string>} the model's raw text.
 */
export async function askModel({ system, user, model, json = true, format, timeoutMs }) {
  const to = timeoutMs || parseInt(process.env.AI_TIMEOUT_MS || '', 10) || 180000;
  if (isClaudeModel(model)) {
    const cmd = process.env.CLAUDE_CLI || 'claude';
    const args = ['-p', '--output-format', 'json', '--max-turns', '1'];
    const stdout = await runClaude(cmd, args, system + '\n\n' + user);
    let text = stdout.trim();
    try { const j = JSON.parse(stdout); if (j && j.is_error) { throw new Error('Claude Code error: ' + String(j.result || '').slice(0, 200)); } if (j && typeof j.result === 'string') { text = j.result; } }
    catch (e) { if (e.message && e.message.startsWith('Claude Code error')) throw e; }
    return text;
  }
  // Otherwise: a specific Ollama model via /api/chat.
  // `think: false` suppresses hybrid-reasoning `<think>` blocks on Qwen3 (harmless/ignored on
  // non-thinking models like qwen2.5) so the response is terse JSON, not a chain-of-thought.
  const body = { model, stream: false, think: false, options: { temperature: 0 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  // Grammar-constrain the output: a JSON-schema object forces the exact shape; "json" forces any
  // valid JSON. `format` (a schema, ideally) wins; else fall back to plain "json" when json is wanted.
  if (format) body.format = format;
  else if (json) body.format = 'json';
  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(to),
  }).catch((e) => { throw new Error(`Could not reach Ollama at ${OLLAMA_HOST} (${e.message}) — is \`ollama serve\` running?`); });
  if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`Ollama ${resp.status}: ${t.slice(0, 300)} — is \`${model}\` pulled?`); }
  const data = await resp.json();
  return String((data.message && data.message.content) || '').trim();
}

/** Pull the first balanced JSON object out of a model response (tolerates stray prose / fences). */
export function extractJson(text) {
  if (!text) return null;
  // Strip hybrid-reasoning <think>…</think> blocks first (Qwen3 etc.), then code fences.
  let s = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
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
