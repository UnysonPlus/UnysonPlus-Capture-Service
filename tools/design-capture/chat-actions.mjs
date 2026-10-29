/**
 * The Kit Assistant, Phase 3 — acting, behind a gate.
 *
 * A tool that CHANGES something never runs inside the model's turn. It returns a PROPOSAL (a dry run:
 * what would happen, where, what it replaces) parked under a random id. The dashboard shows Confirm /
 * Cancel under the message; only the person's click (POST /local-ai/chat-confirm) runs it — once. A
 * proposal expires after 30 minutes. That is the one approval path: a new write tool adds a `plan` (the
 * dry run) and a `run` to WRITE_TOOLS and is gated like the rest.
 *
 *   start_capture   a real capture into capture-out (the Convert tab's run), in the background
 *   capture_status  how that run is going (read-only)
 *   hand_to_studio  a scene request handed to Kinetic Scenes, which generates it with its own presets
 *
 * Plan: https://docs.unysonplus.com/ai-dev-kit/kit-assistant
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CHAT_TOOL_DEFS, runChatTool, findCapture, readJsonSafe } from './chat-tools.mjs';

const PENDING = new Map();
const PENDING_TTL = 30 * 60 * 1000;
const HANDOFF_TTL = 60 * 60 * 1000;

/** Scene requests waiting for Kinetic Scenes to pick them up (GET /studio/handoff?id=…). */
const HANDOFFS = new Map();

export const CHAT_WRITE_TOOL_DEFS = [
  { type: 'function', function: { name: 'start_capture', description: 'Capture a site into the capture-out folder — the same run as the Convert tab: a real browser render, the pages, design tokens and a conversion report. It CHANGES files, so you do not run it: it returns a proposal and the person presses Confirm. Tell them what will happen and that it waits for their Confirm; never say it has started. single_page: only this URL; max_pages: cap the crawl (1–50).', parameters: { type: 'object', properties: { url: { type: 'string' }, single_page: { type: 'boolean' }, max_pages: { type: 'integer' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'capture_status', description: 'How a capture is going, or how it ended: status, step, and the result once finished. site = folder name, URL or "latest". Read-only.', parameters: { type: 'object', properties: { site: { type: 'string' } }, required: ['site'] } } },
  { type: 'function', function: { name: 'hand_to_studio', description: 'Hand a scene request to Kinetic Scenes (the Studio): it generates the scene with its own preset catalogue and the person edits it there. Write a complete, specific request — what moves, the mood, the length, any text on screen. Returns a proposal the person confirms; then they get a link that opens the Studio with the request ready.', parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] } } },
];

export const ALL_CHAT_TOOL_DEFS = [...CHAT_TOOL_DEFS, ...CHAT_WRITE_TOOL_DEFS];

/**
 * @param {{captureOut:string, siteSlug:(u:string)=>string, startCapture:(url:string, o:object)=>Promise<void>|void, studioUrl:string}} env
 */
function writeTools(env) {
  return {
    start_capture: {
      plan(a) {
        const url = String(a.url || '').trim();
        if (!/^https?:\/\/[^\s]+$/i.test(url)) return { error: 'url must be an http(s) address.' };
        const dir = join(env.captureOut, env.siteSlug(url));
        const exists = existsSync(join(dir, 'pages.json'));
        const max = Number.isFinite(+a.max_pages) && +a.max_pages > 0 ? Math.max(1, Math.min(50, Math.round(+a.max_pages))) : null;
        return {
          action: 'Capture ' + url,
          details: [
            'Opens ' + url + ' in the kit\'s browser and captures ' + (a.single_page ? 'this page only' : (max ? 'up to ' + max + ' pages from its menu' : 'the pages its menu links to')) + '.',
            'Writes to ' + dir + (exists ? ' — this site was captured before, and that capture is REPLACED.' : ' (a new folder).'),
            'Nothing is sent to any WordPress site; converting is a separate step.',
          ],
          args: { url, single_page: !!a.single_page, max_pages: max },
        };
      },
      async run(args) {
        await env.startCapture(args.url, args);
        return { ok: true, message: 'Capture of ' + args.url + ' started. It runs in the background: ask "how is the capture going?", or watch it on the Home tab.', site: env.siteSlug(args.url) };
      },
    },
    hand_to_studio: {
      plan(a) {
        const request = String(a.request || '').trim();
        if (request.length < 10) return { error: 'request needs a description of the scene.' };
        if (request.length > 4000) return { error: 'request is longer than 4,000 characters.' };
        return {
          action: 'Hand a scene request to Kinetic Scenes',
          details: [
            'Request: “' + request.slice(0, 400) + (request.length > 400 ? '…' : '') + '”',
            'The Studio generates the scene with its own presets, and you edit it there. Nothing on this computer or any site changes.',
          ],
          args: { request },
        };
      },
      async run(args) {
        for (const [k, v] of HANDOFFS) if (Date.now() - v.at > HANDOFF_TTL) HANDOFFS.delete(k);
        const id = randomBytes(9).toString('base64url');
        HANDOFFS.set(id, { request: args.request, at: Date.now() });
        return { ok: true, message: 'The request is ready for Kinetic Scenes. Open the link; it waits in the Studio\'s AI panel (for an hour).', link: env.studioUrl + '?handoff=' + id, handoff: id };
      },
    },
  };
}

/** GET /studio/handoff?id=… — the Studio collects a request once. */
export function takeHandoff(id) {
  const key = String(id || '');
  const h = HANDOFFS.get(key);
  HANDOFFS.delete(key);
  if (!h || Date.now() - h.at > HANDOFF_TTL) return null;
  return { request: h.request };
}

/** capture_status — what the capture's own progress.json says. */
export function captureStatus(captureOut, { site } = {}) {
  let c = findCapture(captureOut, site);
  if (!c) {
    // A run that has only just started has a progress.json but no pages.json yet: match the folder by name.
    let names = [];
    try { names = readdirSync(captureOut); } catch { /* none */ }
    const q = String(site || '').toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const n = names
      .filter((x) => !/^[_.]/.test(x) && existsSync(join(captureOut, x, 'progress.json')))
      .sort((a, b) => statSync(join(captureOut, b)).mtimeMs - statSync(join(captureOut, a)).mtimeMs)
      .find((x) => !q || q === 'latest' || q === 'last' || x.toLowerCase().includes(q));
    c = n ? { dir: join(captureOut, n), slug: n } : null;
  }
  if (!c) return { error: 'No capture matches "' + site + '".' };
  const p = readJsonSafe(join(c.dir, 'progress.json')) || {};
  const stats = (readJsonSafe(join(c.dir, 'share-stats.json')) || {}).stats || null;
  return {
    capture: c.slug,
    status: p.status || (stats ? 'done' : 'unknown'),
    step: p.step || p.phase || p.stage || p.message || '',
    updated: p.updatedAt ? new Date(p.updatedAt).toISOString() : undefined,
    progress: p,
    result: stats,
  };
}

function propose(env, name, args) {
  const plan = writeTools(env)[name].plan(args);
  if (plan.error) return { error: plan.error };
  for (const [k, v] of PENDING) if (Date.now() - v.at > PENDING_TTL) PENDING.delete(k);
  const id = randomBytes(12).toString('base64url');
  PENDING.set(id, { name, args: plan.args, at: Date.now() });
  return {
    proposal: true, id, tool: name, action: plan.action, details: plan.details,
    note: 'NOT done. The person sees Confirm and Cancel under your message, and it runs only if they press Confirm. Tell them what will happen.',
  };
}

/** POST /local-ai/chat-confirm — the person's decision. A proposal runs at most once. */
export async function decideProposal(env, id, decision) {
  const key = String(id || '');
  const p = PENDING.get(key);
  PENDING.delete(key);
  if (!p) return { ok: false, error: 'This request was already handled, or has expired. Ask again.' };
  if (Date.now() - p.at > PENDING_TTL) return { ok: false, error: 'This request expired (after 30 minutes). Ask again.' };
  if (decision !== 'confirm') return { ok: true, cancelled: true, message: 'Cancelled. Nothing was changed.' };
  try {
    return await writeTools(env)[p.name].run(p.args);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Every chat tool, read and write, through one entry point: writes become proposals here. */
export async function runChatToolGated(env, name, args) {
  const a = args && typeof args === 'object' ? args : {};
  let result;
  if (name === 'start_capture' || name === 'hand_to_studio') result = propose(env, name, a);
  else if (name === 'capture_status') result = captureStatus(env.captureOut, a);
  else return runChatTool(env, name, a);
  return { ok: !result.error, result, text: JSON.stringify(result) };
}
