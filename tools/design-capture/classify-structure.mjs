// AI STRUCTURE CLASSIFIER (prototype) — the "AI as classifier, deterministic engine as builder" tier.
//
// The deterministic converter (PHP Stitch/Mapper) is great at extracting exact styles/text and emitting valid
// builder JSON, but it decides a few AMBIGUOUS structural calls with brittle class-name heuristics that break
// site-to-site (whack-a-mole): is a $-number a plan price or a STAT? is a <video> a section BACKGROUND or a
// framed CONTENT panel? So we let a small model reason about COMPACT, DOM-derived signals and emit a per-section
// verdict; PHP consumes it ADVISORY (heuristics remain the fallback + validator). The model never sees or emits
// styles/values it must reproduce — only signals in, verdicts out. Schema-constrained (valid JSON guaranteed).
//
// Flow:  PHP FW_Site_Converter_Stitch::structure_summary(rendered.html)  →  this classifier (Ollama/Claude)  →
//        ai-structure.json in the capture-out dir  →  PHP reads it on the build pass (behind FW_SC_AI_STRUCTURE).
//
// Usage:  node classify-structure.mjs <capture-out-dir> [--php <php>] [--wp <wp-load.php>]
//
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askModel, selectedLocalModel, aiBackend, microBackend } from './to-ai.mjs';

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          kind: { type: 'string' },                                   // hero/features/pricing/stats/cta/about/…
          pricing: { type: 'boolean' },                               // a REAL plan pricing table?
          video_role: { type: 'string', enum: ['background', 'content', 'none'] },
        },
        required: ['index', 'kind', 'pricing', 'video_role'],
      },
    },
  },
  required: ['sections'],
};

const SYSTEM = `You classify the sections of a web page for a website→WordPress converter. You are given, per section,
only COMPACT signals (never full HTML). Return ONE JSON object, no prose:
{ "sections": [ { "index": <int>, "kind": "<slug>", "pricing": <bool>, "video_role": "background"|"content"|"none" } ] }

Decide each field from the signals:
- kind: a short semantic slug — hero, features, pricing, stats, cta, about, testimonials, gallery, faq, contact, content, footer.
- pricing: TRUE only if this section is a real PLAN PRICING TABLE — multiple plan columns, each with a real price
  (small money like $9, $29, $99) AND typically a "/mo" or "/yr" period and/or a feature list. A big headline
  number with a magnitude suffix ($4.2B, $18M) or a huge value ($18,240,000) is a STAT/METRIC, NOT a price → false.
  No period and no feature list → almost certainly stats, not pricing → false.
- video_role: for a section's video(s), apply these rules IN ORDER: (1) no video → "none". (2) if ANY video has
  rounded=true → "content" (a rounded frame is a card/PIP panel, NEVER a full-bleed backdrop, even if it also
  covers/bleeds its box). (3) else if ANY video has bleed=true → "background" (a full-viewport inset-0/fullscreen
  backdrop layer). (4) else if ANY video has cover=true → "background" (a square-cornered cover video filling the
  section). (5) else → "content".
Keep the SAME index values you were given. Output only the JSON.`;

function summaryFromPhp(dir, php, wp) {
  const rendered = existsSync(join(dir, 'rendered.html')) ? dir : join(dir, 'openhero_art_api_preview');
  const code = `require getenv('WP_LOAD'); echo json_encode(FW_Site_Converter_Stitch::structure_summary(file_get_contents(getenv('RH'))));`;
  const out = execFileSync(php, ['-d', 'memory_limit=1024M', '-r', code],
    { encoding: 'utf8', maxBuffer: 1 << 24, timeout: 90000,
      env: { ...process.env, WP_LOAD: wp, RH: join(rendered, 'rendered.html') } });
  // strip any PHP notice noise before the JSON
  const j = out.slice(out.indexOf('{'));
  return JSON.parse(j);
}

// Only the fields the model should reason on (keep the prompt tiny for a small local model).
function compact(sections) {
  return sections.map((s) => ({
    index: s.index, heading: (s.heading || '').slice(0, 60),
    dollars: s.dollars || [], hasPeriod: !!s.hasPeriod, hasFeatureList: !!s.hasFeatureList,
    videos: (s.videos || []).map((v) => ({ rounded: !!v.rounded, inColumn: !!v.inColumn, cover: !!v.cover, bleed: !!v.bleed })),
    bands: s.bands || 0,
  }));
}

// Resolve which model string to hand askModel(): a Claude sentinel routes to the `claude` CLI; an Ollama
// model name routes to the local server. Prefer an explicit override, else the active backend's default.
function resolveModel(model) {
  if (model) return model;
  const backend = aiBackend();                         // 'api' | 'claude-code' | null
  if (backend === 'claude-code') return 'claude-code';
  if (backend === 'api') return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  return selectedLocalModel();                          // Ollama (local) fallback
}

export async function classifyStructure(summary, { model } = {}) {
  const sections = (summary && summary.sections) || [];
  if (!sections.length) return { sections: [] };
  const m = resolveModel(model);
  if (!m) throw new Error('no AI model resolved — pick a local model or enable Claude');
  const user = `Sections (${sections.length}):\n${JSON.stringify(compact(sections))}\n\nReturn the { "sections":[...] } JSON now.`;
  const to = parseInt(process.env.AI_TIMEOUT_MS || '', 10) || 120000;
  const text = await askModel({ system: SYSTEM, user, model: m, format: VERDICT_SCHEMA, timeoutMs: to });
  let parsed; try { parsed = JSON.parse(text.slice(text.indexOf('{'))); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.sections)) throw new Error('classifier returned no sections');
  // Re-attach the stable sig from the summary (keyed by index) so PHP can align verdicts without trusting
  // the model to echo an opaque key. The model only reasons about signals; alignment stays deterministic.
  const bySig = new Map(sections.map((s) => [s.index, s.sig]));
  parsed.sections = parsed.sections
    .filter((v) => bySig.has(v.index))
    .map((v) => ({ sig: bySig.get(v.index), index: v.index, kind: String(v.kind || '').slice(0, 24),
                   pricing: v.pricing === true, video_role: ['background', 'content', 'none'].includes(v.video_role) ? v.video_role : 'none' }));
  return parsed;
}

// CLI (robust on Windows: compare resolved paths, not raw file:// URLs with encoded spaces)
const isMain = (() => { try { return process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]); } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const php = opt('--php', process.env.PHP || 'D:/xampp/php/php.exe');
  const wp = opt('--wp', process.env.WP_LOAD || 'D:/xampp/htdocs/wp-load.php');
  if (!dir) { console.error('usage: node classify-structure.mjs <capture-out-dir> [--php ..] [--wp ..]'); process.exit(2); }
  const backend = aiBackend() || (selectedLocalModel() ? 'ollama' : null);
  if (!backend) { console.error('no AI backend (pick a local model, or enable Claude/API)'); process.exit(3); }
  const modelOverride = opt('--model', '');            // e.g. --model qwen3:8b (force Ollama) or --model claude-code
  // Prefer a SELECTED LOCAL model by default: this task is schema-constrained, and Ollama's `format` grammar
  // GUARANTEES valid JSON, whereas the Claude CLI path returns free text that can miss the shape. --model
  // overrides; with no local model selected it falls back to the active backend (Claude/API).
  const chosen = modelOverride || selectedLocalModel() || '';
  const summary = summaryFromPhp(dir, php, wp);
  const engine = chosen || backend;
  console.error(`[classify-structure] ${summary.sections.length} section(s) via ${engine}`);
  const verdicts = await classifyStructure(summary, chosen ? { model: chosen } : {});
  const target = existsSync(join(dir, 'rendered.html')) ? dir : join(dir, 'openhero_art_api_preview');
  const outPath = join(target, 'ai-structure.json');
  const doc = { version: 1, engine, sections: verdicts.sections };
  writeFileSync(outPath, JSON.stringify(doc, null, 1));
  console.error(`[classify-structure] wrote ${outPath}`);
  console.log(JSON.stringify(doc, null, 1));
}
