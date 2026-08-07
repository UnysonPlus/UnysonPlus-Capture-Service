// Header translation — the FIRST real use of guides/header-translation-guide.md.
//
// Turns a captured website <header> (markup + per-element `data-sc-cs` computed styles) into a small
// UnysonPlus Header Theme-Settings JSON object (zones left/center/right of elements, plus layout /
// identity / menu). The model does the mapping; the guide is the system prompt + strict output schema.
//
// This is deliberately small + reusable so the conversion pipeline can call `translateHeader()` later:
// it takes the header HTML and a model id (an Ollama tag, or 'claude'/'claude-code' for Claude Code),
// runs the SAME prompt against that model, and returns the parsed JSON + timing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { askModel, extractJson } from './to-ai.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUIDE_PATH = join(HERE, 'guides', 'header-translation-guide.md');

/**
 * Ollama structured-output JSON SCHEMA for the header-mapping result. Passed as the `format`
 * param so the model is grammar-constrained to emit valid JSON with the guide's 6 top-level keys
 * of the right types (the three zone arrays + the three settings objects). We constrain the
 * TOP-LEVEL SHAPE only (not every nested element field) — that's what the benchmark's structural
 * gate checks, and a fully-nested schema would be too brittle for small models to satisfy.
 */
export const HEADER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    left: { type: 'array' },
    center: { type: 'array' },
    right: { type: 'array' },
    layout: { type: 'object' },
    identity: { type: 'object' },
    menu: { type: 'object' },
  },
  required: ['left', 'center', 'right', 'layout', 'identity', 'menu'],
};

/** Load the header-translation guide (the system prompt). Cached after first read. */
let _guide;
export function loadGuide() {
  if (_guide == null) _guide = readFileSync(GUIDE_PATH, 'utf8');
  return _guide;
}

/**
 * Build the full user turn: the captured header HTML, trimmed so small local models can handle it.
 * The guide itself is the system prompt.
 */
export function buildHeaderPrompt(headerHtml, { maxChars = 12000 } = {}) {
  const html = String(headerHtml || '').slice(0, maxChars);
  const user =
    `Here is the captured source <header> (markup with per-element data-sc-cs computed styles).\n` +
    `Translate it into the Header Theme-Settings JSON exactly as the guide specifies. Output ONLY the JSON object.\n\n` +
    `=== CAPTURED HEADER ===\n${html}\n`;
  return { system: loadGuide(), user };
}

/**
 * Translate a captured header into UnysonPlus Header Theme-Settings JSON with a given model.
 * @param {{ headerHtml:string, model:string, maxChars?:number, timeoutMs?:number }} o
 * @returns {Promise<{ ok:boolean, json:object|null, raw:string, ms:number, error?:string }>}
 */
export async function translateHeader({ headerHtml, model, maxChars = 12000, timeoutMs } = {}) {
  if (!headerHtml) throw new Error('translateHeader: headerHtml is required.');
  if (!model) throw new Error('translateHeader: model is required.');
  const { system, user } = buildHeaderPrompt(headerHtml, { maxChars });
  const t0 = Date.now();
  try {
    // Grammar-constrain to the header-mapping JSON schema so even a small local model MUST emit
    // valid JSON of the right top-level shape (the fix for qwen2.5's 0/100 malformed output).
    const raw = await askModel({ system, user, model, json: true, format: HEADER_JSON_SCHEMA, timeoutMs });
    const json = extractJson(raw); // tolerates code fences / stray prose
    const ms = Date.now() - t0;
    return { ok: !!json, json, raw, ms };
  } catch (e) {
    return { ok: false, json: null, raw: '', ms: Date.now() - t0, error: e.message };
  }
}
