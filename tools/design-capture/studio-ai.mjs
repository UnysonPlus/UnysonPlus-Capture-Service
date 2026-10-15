// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Animation Studio AI: turns a request into a scene file, using whichever AI this kit is set up with
 * (a Claude subscription, an API key, or a local model).
 *
 * The Studio sends the preset catalogue with each request, so this file never needs updating when
 * presets change. The AI writes DATA (a scene file built from those presets), never code, so whatever
 * it makes lands on the Studio's timeline as ordinary, editable clips. The Studio validates the result
 * and, if it is invalid, asks once more in "repair" mode with the validation errors.
 *
 * Only the Studio's own pages may call this (see studioOriginAllowed): the kit runs on the user's
 * computer, and other websites must not be able to spend their AI.
 */
import { aiBackend, aiReady, askModel, askText, extractJson, selectedLocalModel, stripReasoning } from './to-ai.mjs';

const ORIGINS = [
  'https://animation-studio.unysonplus.com',
  'http://localhost:4317', // the Studio's local preview build
  'http://localhost:5173', // the Studio's dev server
];

/** True for the Studio's pages (plus any listed in STUDIO_ORIGINS, comma-separated). */
export function studioOriginAllowed(origin) {
  if (!origin) return true; // not a browser page (a local script): nothing to protect against
  const extra = String(process.env.STUDIO_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return ORIGINS.includes(origin) || extra.includes(origin);
}

export function studioAiStatus() {
  const backend = aiBackend();
  return {
    ready: aiReady(),
    backend,
    model: backend === 'ollama' ? selectedLocalModel() : backend ? (process.env.ANTHROPIC_MODEL || 'claude') : '',
  };
}

const SYSTEM = `You design motion-graphics scenes for the Unyson+ Animation Studio: animated hero sections and
banners for websites, made of text, shapes and (only when the request gives image addresses) images, animated by
presets on a timeline. You answer with ONE JSON object and nothing else:

{ "scene": <the scene file>, "explanation": "<one or two plain sentences: what you made or changed>" }

THE SCENE FILE (format "unysonplus-scene", version 1)
{
  "format": "unysonplus-scene", "version": 1, "title": "<short title>", "duration": <seconds, usually 5 to 10>,
  "stage": {
    "breakpoints": [ { "id", "label", "minWidth": <px>, "aspect": [w, h] }, ... ]   (widest first; keep the ones given),
    "heightMode": "ratio" | "ratio-capped" | "fill"   (keep the one given),
    "background": "<any CSS background: a colour or gradient>",
    "safeArea": 0.06,
    "fonts": [ { "family": "<Google Fonts family>", "href": "https://fonts.googleapis.com/css2?family=...&display=swap" } ]
  },
  "playback": { "trigger": "view" | "load" | "scroll", "loop": true|false, "repeatDelay": <s>, "posterTime": <s>, "scroll": { "pin": true|false, "length": <window heights>, "smooth": <s> } (scroll only) },
  "layers": [ ...drawn bottom to top... ]
}

Every layer: "id" (unique short id, letters/digits/-/_), "name", "type", "box", "clips": [], and optionally
"start"/"end" (seconds the layer is visible), "opacity", "overrides": { "<breakpoint id>": { "box": {...}, "style": {...}, "text": "..." } }.
- box: "x", "y" = where the anchor point sits, in % of the stage width / height; "anchor" (default "center";
  also "top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right");
  "w" = width in % of stage width (omit for text that should stay on one line); "h" = height in % of stage
  height, or "ratio" = width/height (keeps circles round); "rotate" in degrees.
- type "text": "text" (\\n for a new line), "style": { "fontFamily", "fontSize" (STAGE UNITS: 10 = 10% of the
  stage width), "fontWeight", "lineHeight", "letterSpacing" (em), "color", "align", "uppercase", "italic" }.
- type "shape": "shape": "rect" | "ellipse", "fill" (colour or gradient), "stroke", "strokeWidth", "radius" (stage units).
- type "image": "src" (an https address the request gave you), "alt", "fit": "cover" | "contain", "radius".
- type "group": "layers": [...] — layers kept together. Children keep stage coordinates; their clips run on the
  group's own clock, which starts at the group's "start". Presets on the group animate the whole group.
- clips: { "id" (unique across the whole scene), "preset" (an id from PRESETS), "start", "duration" (seconds),
  "ease" (optional, e.g. "power3.out"), "params" (optional, only keys the preset lists) }.
  A preset only works on the layer types in its "appliesTo".

HOW TO MAKE IT GOOD
- Lead with one big idea: a short, bold headline (fontSize 8 to 20 on desktop) with a supporting line (1.5 to 2.5).
- Stagger entrances over the first 2 to 3 seconds (durations 0.5 to 1.2 s), let it hold, then (when it loops)
  add exits ("direction": "out" in params) in the last second so the loop restarts cleanly.
- Keep everything that matters inside the safe area: x between about 8 and 92, y between about 10 and 90.
  With heightMode "ratio-capped" or "fill" the stage can be trimmed top and bottom on short windows, so never
  put text closer than 10% to the top or bottom edge.
- Text without "w" must fit on one line at every breakpoint: width is roughly characters x fontSize x 0.55 (% of
  stage width) and must stay under 88. Give long lines a "w" so they wrap.
- Give every text layer overrides for the narrower breakpoints so it stays readable: tablet about 1.2x the desktop
  fontSize, mobile (a tall 4:5 stage) about 1.8 to 2.2x, with y positions spread out to use the taller space.
- Strong contrast between text and background. One accent colour is usually enough.
- "posterTime" = a moment when everything is on screen (shown to visitors who turn animation off).
- Use only presets from PRESETS, only params they list, and no image layers unless addresses were given.

WHEN CHANGING AN EXISTING SCENE
Return the WHOLE scene with the change applied. Keep everything the request does not ask to change exactly as it
is, including ids. If "selected" lists layer ids, change those layers unless the request clearly means more.
A change must still leave a clean layout at EVERY breakpoint. After making text bigger or longer, re-check each
breakpoint: estimate every text layer's height (lines x fontSize x lineHeight, in % of the stage WIDTH, then convert
to % of the stage height using the breakpoint's aspect) and its width (see above); nothing may overlap another text
layer, and everything must stay inside the safe area. If it no longer fits, move the neighbouring layers apart, add a
"w" so long text wraps, or reduce the size to the largest that fits, and say so in the explanation.

WHEN REPAIRING
"errors" lists what the validator rejected. Return the corrected whole scene.`;

function buildUser({ mode, prompt, scene, selection, catalog, errors, context }) {
  const payload = { mode, request: prompt };
  // Data the Studio adds to a request (a voice-over's timed words, for example); the rules say how to use it.
  if (typeof context === 'string' && context.trim()) payload.context = context.slice(0, 30000);
  if (mode === 'create') {
    // Keep the author's stage set-up (breakpoints, height mode) so the new scene drops into their layout.
    payload.stage = scene && scene.stage
      ? { breakpoints: scene.stage.breakpoints, heightMode: scene.stage.heightMode, safeArea: scene.stage.safeArea }
      : undefined;
  } else {
    payload.scene = scene;
    if (selection && selection.length) payload.selected = selection;
    if (errors && errors.length) payload.errors = errors.slice(0, 30);
  }
  payload.PRESETS = catalog;
  return JSON.stringify(payload);
}

/**
 * @param {{ mode: 'create'|'edit'|'repair', prompt: string, scene?: object, selection?: string[], catalog: object[], errors?: string[] }} input
 * @returns {Promise<{ scene: object, explanation: string, model: string }>}
 */
export async function studioScene(input) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) { const e = new Error('Describe the animation you want.'); e.code = 400; throw e; }
  if (prompt.length > 4000) { const e = new Error('That request is too long (4,000 characters at most).'); e.code = 400; throw e; }
  if (!Array.isArray(input.catalog) || !input.catalog.length) { const e = new Error('The preset catalogue is missing.'); e.code = 400; throw e; }
  const mode = ['create', 'edit', 'repair'].includes(input.mode) ? input.mode : 'create';
  const backend = aiBackend();
  if (!backend) { const e = new Error('AI is off in the AI Dev Kit. Pick a local model, or connect Claude, then try again.'); e.code = 503; throw e; }

  const user = buildUser({ ...input, mode, prompt });
  // The Studio sends its own motion rules and named eases with each request (they ship with the Studio,
  // so the kit never holds a stale copy). Plain text, capped, appended to the instructions.
  const rules = typeof input.rules === 'string' ? input.rules.slice(0, 24000).trim() : '';
  const system = rules ? `${SYSTEM}\n\nMOTION RULES FROM THE STUDIO (follow them; they override any default above)\n${rules}` : SYSTEM;
  let raw;
  let model;
  if (backend === 'ollama') {
    model = selectedLocalModel();
    raw = await askModel({ system, user, model, json: true, timeoutMs: 300000 });
  } else {
    model = backend === 'api' ? (process.env.ANTHROPIC_MODEL || 'claude') : (process.env.ANTHROPIC_MODEL || 'claude-code');
    raw = await askText({ system, user, maxTokens: 16000 });
  }
  const parsed = extractJson(stripReasoning(raw));
  const scene = parsed && (parsed.scene || (parsed.format === 'unysonplus-scene' ? parsed : null));
  if (!scene || typeof scene !== 'object') throw new Error('The AI did not return a scene. Try rephrasing the request.');
  return { scene, explanation: String((parsed && parsed.explanation) || ''), model };
}
