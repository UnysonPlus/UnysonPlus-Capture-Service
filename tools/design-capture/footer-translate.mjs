// Footer translation — the MIRROR of header-translate.mjs for the site FOOTER.
//
// Turns a captured website <footer> (markup + per-element `data-sc-cs` computed styles) into a small
// UnysonPlus Footer Theme-Settings JSON object (top-level colors + the four stacked bars
// pre/main/post/copyright, each a list of columns of elements). The model does the mapping; the guide
// (guides/footer-translation-guide.md) is the system prompt + strict output schema.
//
// Kept small + reusable so the conversion pipeline (serve.mjs /translate-chrome) can call
// `translateFooter()`: it takes the footer HTML + a model id (an Ollama tag, or 'claude'/'claude-code'
// for Claude Code), runs the SAME prompt against that model, and returns the parsed JSON + timing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { askModel, extractJson } from './to-ai.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUIDE_PATH = join(HERE, 'guides', 'footer-translation-guide.md');

/**
 * Ollama structured-output JSON SCHEMA for the footer-mapping result. Passed as the `format` param so
 * the model is grammar-constrained to emit valid JSON with the guide's top-level keys of the right
 * types (three color strings + a `bars` object holding pre/main/post/copyright). We constrain the
 * TOP-LEVEL SHAPE only (not every nested column/element field) — the same conservative approach as
 * HEADER_JSON_SCHEMA (a fully-nested schema would be too brittle for small models to satisfy, and the
 * PHP applier tolerates missing/extra nested fields).
 */
export const FOOTER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    background: { type: 'string' },
    text_color: { type: 'string' },
    link_color: { type: 'string' },
    bars: {
      type: 'object',
      properties: {
        pre: { type: ['object', 'null'] },
        main: { type: ['object', 'null'] },
        post: { type: ['object', 'null'] },
        copyright: { type: ['object', 'null'] },
      },
      required: ['main', 'copyright'],
    },
  },
  required: ['bars'],
};

/** Load the footer-translation guide (the system prompt). Cached after first read. */
let _guide;
export function loadGuide() {
  if (_guide == null) _guide = readFileSync(GUIDE_PATH, 'utf8');
  return _guide;
}

/**
 * Build the full user turn: the captured footer HTML, trimmed so small local models can handle it.
 * The guide itself is the system prompt.
 */
export function buildFooterPrompt(footerHtml, { maxChars = 12000 } = {}) {
  const html = String(footerHtml || '').slice(0, maxChars);
  const user =
    `Here is the captured source <footer> (markup with per-element data-sc-cs computed styles).\n` +
    `Translate it into the Footer Theme-Settings JSON exactly as the guide specifies. Output ONLY the JSON object.\n\n` +
    `=== CAPTURED FOOTER ===\n${html}\n`;
  return { system: loadGuide(), user };
}

/**
 * Translate a captured footer into UnysonPlus Footer Theme-Settings JSON with a given model.
 * @param {{ footerHtml:string, model:string, maxChars?:number, timeoutMs?:number }} o
 * @returns {Promise<{ ok:boolean, json:object|null, raw:string, ms:number, error?:string }>}
 */
export async function translateFooter({ footerHtml, model, maxChars = 12000, timeoutMs } = {}) {
  if (!footerHtml) throw new Error('translateFooter: footerHtml is required.');
  if (!model) throw new Error('translateFooter: model is required.');
  const { system, user } = buildFooterPrompt(footerHtml, { maxChars });
  const t0 = Date.now();
  try {
    // Grammar-constrain to the footer-mapping JSON schema so even a small local model MUST emit valid
    // JSON of the right top-level shape (mirrors header-translate's fix for malformed small-model output).
    const raw = await askModel({ system, user, model, json: true, format: FOOTER_JSON_SCHEMA, timeoutMs });
    const json = extractJson(raw); // tolerates code fences / stray prose
    const ms = Date.now() - t0;
    return { ok: !!json, json, raw, ms };
  } catch (e) {
    return { ok: false, json: null, raw: '', ms: Date.now() - t0, error: e.message };
  }
}
