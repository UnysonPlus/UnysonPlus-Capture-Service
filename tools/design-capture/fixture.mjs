// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// fixture.mjs — a REPRO FIXTURE for a converter finding: the failing construct cut out of rendered.html WITH its
// capture stamps (data-sc-cs / -anim / -keyframes / -hover / -cs-sm / -cs-md — the geometry the converter reads), so
// the maintainer can run it through the twin (`build_from_html`) and lock the fix in a golden check.
//
// The fixture is STRUCTURE, never content: every text run is replaced by neutral words of the same length and
// capitalisation (a title's wrap must survive, its words must not); src / href / poster keep only their PRESENCE
// (`#`); alt / title / data-* payloads that are not stamps, inline styles, URLs and emails are dropped; scripts,
// styles and iframes go. Capped at FIXTURE_MAX (a Sheets cell holds 50 k; the note + tuple share it).
//
//   node make-fixture.mjs capture-out/<site> "<css selector>" [--out fixture.html]   # cut one by selector
//   sanitizeFixture(html)                                                          # what the sender applies

export const FIXTURE_MAX = 32768; // (was 8 K: a band with a 3-tile grid AND its stamps runs ~25 K — the stamps ARE the fixture; a Sheets cell holds 50 K, the tuple + note take ~3 K)

const STAMP_ATTRS = /^data-sc-(?:cs(?:-sm|-md|-xl)?|anim|keyframes|hover|reveal|col|pattern-extra|pattern-layer|decor-pseudo|logo-svg|content-width|content-gutter(?:-sm|-inside)?)$/i; // (+ the <html> site stamps: content width / gutter)
const KEEP_ATTRS = new Set(['class', 'id', 'role', 'type', 'for', 'aria-hidden', 'aria-expanded', 'aria-controls', 'aria-label', 'open', 'hidden', 'disabled', 'required', 'rows', 'autoplay', 'loop', 'muted', 'playsinline', 'colspan', 'rowspan']); // (+ the toggle / form states a recognizer reads — an accordion fixture arrived without its aria-expanded)
const NEUTRAL = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'orbit', 'lumen', 'delta', 'vector', 'quanta', 'stratum', 'cadence', 'solace', 'meridian', 'harbor'];

const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
const TAG_RE = /<([a-z][a-z0-9-]*)((?:\s+[^\s=>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/gi;
const ATTR_RE = /([^\s=>/]+)(?:=("[^"]*"|'[^']*'|[^\s>]+))?/g;
const GLYPH_RE = /^[\d.,%+\-–—:/x×$€£°]+$/;

/** Neutral word of the same length + capitalisation as `w`. */
const neutralWord = (w, state) => {
  if (GLYPH_RE.test(w)) return w; // a number / unit / glyph keeps its shape (a stat value, a price)
  let n = NEUTRAL[state.i++ % NEUTRAL.length];
  while (n.length < w.length) n += NEUTRAL[state.i++ % NEUTRAL.length];
  n = n.slice(0, Math.max(1, w.length));
  if (w.length > 1 && /^[A-Z]+$/.test(w)) return n.toUpperCase();
  if (/^[A-Z]/.test(w)) return n[0].toUpperCase() + n.slice(1);
  return n;
};

/** The scrub WITHOUT the cap — make-fixture measures it to decide how much of a wall of repeats to prune. */
export const scrubFixture = (html) => {
  let h = String(html || '').replace(/<(script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(TAG_RE, (m, tag, attrs, slash) => {
    const keep = [];
    let a;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(attrs))) {
      const n = a[1].toLowerCase();
      const v = a[2] || '';
      if (KEEP_ATTRS.has(n) || STAMP_ATTRS.test(n)) keep.push(v ? `${n}=${v.replace(URL_RE, '[url]')}` : n);
      else if (n === 'src' || n === 'href' || n === 'poster') keep.push(`${n}="#"`); // presence is structural, the target is not
    }
    return `<${tag}${keep.length ? ' ' + keep.join(' ') : ''}${slash ? ' /' : ''}>`;
  });
  const state = { i: 0 };
  h = h.replace(/>([^<]+)</g, (m, t) => '>' + t.replace(/[^\s]+/g, (w) => neutralWord(w, state)) + '<');
  h = h.replace(URL_RE, '[url]').replace(EMAIL_RE, '[email]');
  h = h.replace(/[ \t]+$/gm, '').replace(/\n{2,}/g, '\n').trim();
  return h;
};

export const sanitizeFixture = (html) => scrubFixture(html).slice(0, FIXTURE_MAX);

/** True when a fixture carries at least one capture stamp (otherwise it proves nothing about the converter's input). */
export const fixtureIsStamped = (html) => /\sdata-sc-cs=/.test(String(html || ''));
