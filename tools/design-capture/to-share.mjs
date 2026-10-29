// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// to-share.mjs — OPT-IN, anonymized "share report".
//
// Turns a conversion report into a structural-only document a developer can CHOOSE to send upstream
// (Google Form → Sheet → unysonplus@gmail.com) to help improve the Site Converter. It carries the
// SHAPE of each mapping decision — roles, tag names, class TOKENS, computed-style property names, and
// the fallback/opportunity/styling-drop flags — and deliberately NOTHING that identifies or reproduces
// the source: no URL/host (only a salted hash), no content text, no images, no links/hrefs, no PII.
//
// Nothing here sends on its own. capture.mjs only builds this when `--share`/`--share-preview` is
// passed, and only POSTs on `--share` (an explicit per-run opt-in). See docs/report-sharing.md.
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const SCHEMA = 'upw-share/1';
const SALT = 'upw-share-v1'; // fixed salt: pseudonymizes the host so the same site dedupes without revealing it

const hostHash = (url) => {
  let host = '';
  try { host = new URL(url).host.replace(/^www\./, ''); } catch { host = ''; }
  return host ? createHash('sha256').update(SALT + host).digest('hex').slice(0, 16) : '';
};

// A class TOKEN is structural signal (py-32, grid, min-h-screen, bg-zinc-950) and safe to keep — EXCEPT
// an arbitrary bracket value that could embed content (a url/path/text). Dimensional/color arbitraries
// (min-h-[80vh], w-[1200px], bg-[#0d1117]) are structural and kept; content-bearing ones are redacted.
const SAFE_BRACKET = /^[#\d][\w#.%-]*$|^-?\d*\.?\d+(px|rem|em|vh|vw|dvh|svh|%|fr|deg|ms|s)?$/i;
const sanitizeClass = (cls) => String(cls || '').split(/\s+/).filter(Boolean).map((tok) => {
  const m = tok.match(/^(.*?)\[([^\]]*)\]([:/].*)?$/);            // [prefix]-[value](:variant tail)
  if (!m) return tok;                                             // plain utility token → keep
  return SAFE_BRACKET.test(m[2]) ? tok : `${m[1]}[…]${m[3] || ''}`; // redact content-bearing arbitrary value
}).filter((t) => t.length <= 40).slice(0, 24);                   // guard against absurd/huge tokens

// Redact anything content-bearing from an agent's free-text note, so a `findings` note stays STRUCTURAL
// (the whole point of the pipe): strip URLs, emails and long quoted strings, collapse whitespace, cap
// length. The agent is told to write structural notes only ("faq accordion mapped to plain columns"),
// this is the belt-and-suspenders on top of that.
const sanitizeNote = (s) => String(s || '')
  .replace(/https?:\/\/\S+/gi, '[url]')
  .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
  .replace(/["'“”‘’][^"'“”‘’]{16,}["'“”‘’]/g, '[…]')
  .replace(/\s+/g, ' ').trim().slice(0, 240);

// An OPTIONAL `solution` — the agent's own fix sketch for a REUSABLE pattern (a recognizer approach, or the
// child-theme shortcode it wrote), for the MAINTAINER to review and promote — NEVER auto-applied. It's the
// agent's OWN code, not source content, but capped + URL/email-redacted defensively. Keep it a *sketch*
// (the recognizer/shortcode approach), not a verbatim source dump.
const sanitizeSolution = (s) => String(s || '')
  .replace(/https?:\/\/\S+/gi, '[url]')
  .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
  .trim().slice(0, 2000);

// A REPRO FIXTURE (the stamped construct, structure only) — see fixture.mjs.
import { sanitizeFixture, FIXTURE_MAX } from './fixture.mjs';
export { sanitizeFixture, FIXTURE_MAX };

// The AGENT's diagnosis of a miss: got vs. expected + a structural note (+ an optional solution sketch).
// This is the got-vs-expected signal the protocol asks for; the converter's own trace never carries it.
// Kept to a converter/vocab shape (shortcode / option / token names) + a redacted note — never source content.
// The finding carries the REPORTING CONTRACT tuple (kit docs: "How to report a discrepancy so the converter can be fixed"):
//   region · property · source value · converted value · the source CONSTRUCT (a class / rule / tag — structural, never
//   content) · the converter PATH that lost it · which TWIN (php / js / both) · the LOSS kind (not-captured /
//   dropped / overridden / wrong-mapping / wrong-value). Each field is a short structural string; the older
//   ref / got / expected / note still work and are widened (40 → 120 chars) so a measured pair is never cut mid-value.
// (selector punctuation survives — `[data-sc-anim*=marquee]`, `.max-w-[1600px]`, `:nth-of-type(3)` — a construct IS a selector)
const _val = (v, n) => String(v || '').replace(/[^\w :>/+.,%()#\[\]*=~^$|!"'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
export const LOSS_KINDS = ['not-captured', 'dropped', 'overridden', 'wrong-mapping', 'wrong-value', 'wrong-order', 'missing-option'];
const sanitizeFindings = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 40).map((f) => ({
  ref: _val(f && f.ref, 60),                 // structural ref (e.g. "s2:heading h2")
  got: _val(f && f.got, 120),                // what the converter produced (a measured value: "578x325 contain")
  expected: _val(f && f.expected, 120),      // what the source shows (a measured value: "692x728 cover")
  ...(f && f.region   ? { region:   _val(f.region, 40) } : {}),   // hero / s2 / footer / chrome:header
  ...(f && f.property ? { property: _val(f.property, 40) } : {}), // the CSS property / option / layout fact
  ...(f && f.construct ? { construct: _val(f.construct, 120) } : {}), // the SOURCE construct: `aspect-[.95] max-w-[880px]`, `body::before{position:fixed}`
  ...(f && f.path     ? { path:     _val(f.path, 80) } : {}),      // the capture-out/<site> folder the finding reproduces from
  ...(f && f.twin && /^(php|js|both)$/i.test(String(f.twin)) ? { twin: String(f.twin).toLowerCase() } : {}),
  ...(f && f.loss && LOSS_KINDS.includes(String(f.loss)) ? { loss: String(f.loss) } : {}),
  note: sanitizeNote(f && f.note),
  systematic: !!(f && f.systematic),
  ...(f && f.recurs ? { recurs: Math.min(99, f.recurs === true ? 1 : (parseInt(f.recurs, 10) || 0)) } : {}),   // how many sites this was seen on (true = 1)
  ...(f && f.solution ? { solution: sanitizeSolution(f.solution) } : {}),           // OPTIONAL maintainer-review fix sketch (the GENERAL rule, never a per-site patch)
  ...(f && f.fixture ? { fixture: sanitizeFixture(f.fixture) } : {}),               // OPTIONAL repro: the stamped construct, structure only (see sanitizeFixture)
  ...(f && f.severity && SEVERITIES.includes(String(f.severity)) ? { severity: String(f.severity) } : {}), // layout | content-loss | style | cosmetic — the maintainer orders a batch by it
  ...(f && f.computed ? { computed: _val(f.computed, 160) } : {}),                  // what getComputedStyle / the cascade returned on the BUILT page (settles "which layer won")
  ...(f && f.twin_shows ? { twin_shows: _val(f.twin_shows, 160) } : {}),            // the twin's output for the FIXTURE — proof the repro reproduces the miss
})).filter((f) => f.got || f.expected || f.note || f.solution);
export const SEVERITIES = ['layout', 'content-loss', 'style', 'cosmetic'];

/**
 * Build the anonymized share report from the same input toReport() consumes.
 * @param {{input?:{url?:string,pages?:Array}, stats?:object, converterVersion?:string, findings?:Array}} o
 * @returns {object} sanitized, structural-only report (schema upw-share/1)
 */
export function sanitizeReport({ input = {}, stats, converterVersion, findings } = {}) {
  const pages = input.pages || [];
  const sections = [];
  const elements = [];
  for (const pg of pages) {
    for (const t of (pg.trace || [])) {
      if (t.kind === 'section') {
        sections.push({
          i: t.sIndex,
          decision: t.decision || '',
          height: t.height || 0,
          overLarge: (t.height || 0) > 2200,
          classTokens: sanitizeClass(t.sourceClass),
          stylingDropped: Object.keys(t.diag || {}),             // property NAMES only (border/shadow/…), never their values
        });
      } else if (t.kind === 'element') {
        elements.push({
          s: t.sIndex,
          role: t.role || '',
          detected: t.detected || '',
          mapped: t.shortcode || '',
          fallback: !!t.fallback,
          opportunity: !!t.opportunity,
          why: String(t.why || '').slice(0, 80),                 // the reason is generated by the converter, not source content
          srcTag: t.sourceTag || '',
          classTokens: sanitizeClass(t.sourceClass),
        });
      }
    }
  }
  return {
    schema: SCHEMA,
    tool: 'unysonplus-site-capture',
    converterVersion: converterVersion || '',
    site: { hostHash: hostHash(input.url), pages: pages.length },
    stats: stats ? {
      sections: stats.sections, elements: stats.elements, fallbacks: stats.fallbacks,
      opportunities: stats.opportunities, stylingDrops: stats.stylingDrops, overLargeSections: stats.overLargeSections,
      shortcodes: stats.shortcodes || {}, roles: stats.roles || {},
    } : undefined,
    sections,
    elements,
    findings: sanitizeFindings(findings),          // AGENT-supplied got-vs-expected diagnosis ([] when none)
  };
}

/** One-line human summary of a FULL report (goes in the Form's summary column + the mailto body). */
export function shareSummary(s) {
  const st = (s && s.stats) || {};
  const nf = ((s && s.findings) || []).length;
  return `converter ${s.converterVersion || '?'} · ${st.sections || 0} sec · ${st.elements || 0} el · `
    + `${st.fallbacks || 0} fb · ${st.opportunities || 0} opp · `
    + (nf ? `${nf} agent-findings · ` : '')
    + `host ${(s.site && s.site.hostHash) || '?'}`;
}

// --- Streaming mode (ask-once → send each finding immediately, with a per-bug notification) -----------
// A LEAN single-finding payload (`kind:'finding'`) so a per-bug send stays a couple hundred bytes — never
// near the 50k Google-Sheets cell limit however many bugs a site has. Plus a once-per-site `kind:'summary'`
// (stats only) so the aggregate "what's commonly missed" signal survives without repeating the full report.
export function buildFindingPayload({ url, converterVersion, finding } = {}) {
  return {
    schema: SCHEMA, tool: 'unysonplus-site-capture', kind: 'finding',
    converterVersion: converterVersion || '',
    site: { hostHash: hostHash(url) },
    finding: sanitizeFindings([finding])[0] || null,
  };
}
/* ------------------------------------------------------------------ *
 * MOTION GAPS - a different kind of report, deliberately not a finding.
 *
 * A converter finding says "the source had X and we produced Y": it is a LOSS, it has a PHP/JS twin
 * that can be run, and its fixture is a stamped DOM construct the maintainer can replay. None of that
 * is true of a motion gap, which says "the Animation Engine cannot express this motion at all":
 *
 *   - there is no twin to run, so `twin` / `twin_shows` are meaningless;
 *   - nothing was dropped or overridden, so no LOSS_KIND fits - the engine simply has no such effect;
 *   - the repro is the MOTION (trigger, properties, timing) plus the fallback written for it, not a
 *     `data-sc-cs`-stamped fragment, so the stamped-fixture gate would refuse every one of them.
 *
 * Bending a motion gap into the finding tuple would have meant relaxing the very gates that exist
 * because fixture-less rows were the ones that sat open. So it gets its own kind and its own gates.
 * What carries over unchanged is the no-brand rule and the sanitiser: no source name, domain or copy.
 * ------------------------------------------------------------------ */
export const MOTION_SURFACES = ['element', 'gallery', 'page', 'cursor', 'background'];
export const MOTION_OUTCOMES = ['fallback-written', 'no-fallback', 'partial'];
const sanitizeMotionGap = (g) => ({
  fixture:  _val(g && g.fixture, 40),      // the NEUTRAL id - fb_01 / fixture-04; never a word from the source
  surface:  MOTION_SURFACES.includes(String(g && g.surface)) ? String(g.surface) : '',
  motion:   _val(g && g.motion, 240),      // what the source does: trigger + properties + timing
  tried:    _val(g && g.tried, 240),       // which native effects were consulted, and why none fits
  outcome:  MOTION_OUTCOMES.includes(String(g && g.outcome)) ? String(g.outcome) : '',
  fallback: _val(g && g.fallback, 240),    // the child-theme effect written (its key), or why none was
  ...(g && g.region ? { region: _val(g.region, 40) } : {}),
  ...(g && g.path   ? { path:   _val(g.path, 80) } : {}),
  ...(g && g.recurs ? { recurs: _val(g.recurs, 20) } : {}),   // how often this motion has been met
  note: sanitizeNote(g && g.note),
});
export function buildMotionGapPayload({ url, converterVersion, gap } = {}) {
  return {
    schema: SCHEMA, tool: 'unysonplus-site-capture', kind: 'motion-gap',
    converterVersion: converterVersion || '',
    site: { hostHash: hostHash(url) },
    gap: sanitizeMotionGap(gap || {}),
  };
}
export function buildStatsPayload({ url, converterVersion, stats, positives } = {}) {
  return {
    schema: SCHEMA, tool: 'unysonplus-site-capture', kind: 'summary',
    converterVersion: converterVersion || '',
    site: { hostHash: hostHash(url) },
    stats: stats ? {
      sections: stats.sections, elements: stats.elements, fallbacks: stats.fallbacks,
      opportunities: stats.opportunities, stylingDrops: stats.stylingDrops,
      shortcodes: stats.shortcodes || {}, roles: stats.roles || {},
    } : undefined,
    // what the converter got RIGHT on this site, as ONE line (structural: "hero cover + 3 icon boxes + pricing 3 plans") —
    // this is where a POSITIVE goes; a POSITIVE finding row carries nothing a rule can use and is refused by the sender
    ...(positives ? { positives: _val(positives, 240) } : {}),
  };
}

/** Kind-aware one-liner for the Form summary column / mailto / console — handles finding, summary, or a full report. */
export function oneLineSummary(p) {
  const v = (p && p.converterVersion) || '?';
  const h = (p && p.site && p.site.hostHash) || '?';
  if (p && p.kind === 'finding' && p.finding) {
    const f = p.finding;
    return `converter ${v} · finding${f.region ? ' [' + f.region + (f.property ? ':' + f.property : '') + ']' : ''}: ${f.got || '?'} → ${f.expected || '?'}${f.twin ? ' · ' + f.twin : ''}${f.loss ? ' · ' + f.loss : ''}${f.systematic ? ' (systematic' + (f.recurs ? ' ×' + f.recurs : '') + ')' : ''} · host ${h}`;
  }
  if (p && p.kind === 'motion-gap' && p.gap) {
    const g = p.gap;
    return `engine ${v} \u00b7 motion-gap${g.region ? ' [' + g.region + ']' : ''}${g.surface ? ' \u00b7 ' + g.surface : ''}: ${g.motion || '?'}${g.outcome ? ' \u00b7 ' + g.outcome : ''}${g.fixture ? ' \u00b7 ' + g.fixture : ''} \u00b7 host ${h}`;
  }
  if (p && p.kind === 'summary') {
    const st = p.stats || {};
    return `converter ${v} · summary · ${st.sections || 0} sec · ${st.elements || 0} el · ${st.fallbacks || 0} fb · host ${h}`;
  }
  return shareSummary(p);
}

/**
 * POST the sanitized report to a Google Form's formResponse endpoint (anonymous, no length limit).
 * cfg.form = { responseUrl, fields:{ payload, summary? } }. Returns { ok, status }.
 */
export async function postToForm(sanitized, cfg) {
  const form = cfg && cfg.form;
  if (!form || !form.responseUrl || !form.fields || !form.fields.payload) {
    return { ok: false, status: 0, error: 'no form configured' };
  }
  const body = new URLSearchParams();
  body.set(form.fields.payload, JSON.stringify(sanitized));
  if (form.fields.summary) body.set(form.fields.summary, oneLineSummary(sanitized));
  // Google Forms' formResponse accepts a urlencoded POST and answers 200 (or a 3xx redirect) on success.
  const res = await fetch(form.responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });
  const ok = res.status === 200 || (res.status >= 300 && res.status < 400);
  return { ok, status: res.status };
}

/** A mailto: fallback draft — the dev sends it from their OWN mail and attaches share-report.json. */
export function buildMailto(sanitized, cfg) {
  const to = (cfg && cfg.email) || 'unysonplus@gmail.com';
  const subject = 'UnysonPlus converter report — ' + ((sanitized.site && sanitized.site.hostHash) || '');
  const bodyText = [
    'Anonymized Site Converter report (structural only — no URLs / content / PII).',
    '',
    oneLineSummary(sanitized),
    '',
    'Please ATTACH the share-report.json file (it is too large for the email body).',
  ].join('\n');
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
}

/** Load share-config.json (UPW_SHARE_CONFIG env, else beside the tool). Missing config is fine. */
export function loadShareConfig(dir) {
  for (const p of [process.env.UPW_SHARE_CONFIG, dir && join(dir, 'share-config.json')].filter(Boolean)) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* try next */ }
  }
  return { email: 'unysonplus@gmail.com' };
}
