/**
 * capture-residue.mjs — what the capture DID NOT record.
 *
 * Why this exists
 * ---------------
 * `data-sc-cs` stamps a fixed, hand-curated 30-property allow-list (capture.mjs). Anything outside it
 * is invisible to every downstream stage — the converter cannot map a value it never received, and the
 * theme option (even when one exists) never fires. Worse, the drop is SILENT: nothing in the bundle or
 * the conversion report says "this region carries a property I did not capture".
 *
 * That silence is expensive. Six separate chrome defects traced to it in one session — a meter bar with
 * no width/height, a fill element never stamped at all, an icon inside a shadow DOM — and each was found
 * by eye, one screenshot at a time, rather than reported once by the tool.
 *
 * This module makes the residue visible. For a region (header / footer) it walks the subtree and reports
 * every CANDIDATE property that is (a) outside the allow-list and (b) set to something other than its
 * boring default — i.e. a value the design is actually using and the bundle is throwing away.
 *
 * It is a LEDGER, not a gate: it does not fail a capture. Under-capture is normal (most pages use
 * `overflow` somewhere without it mattering); what matters is being able to SEE it when a region
 * converts wrong, and to count it across a corpus to decide what to add to the allow-list next.
 */

/** The 30 properties data-sc-cs already carries. Keep in sync with PROPS in capture.mjs. */
export const CAPTURED_PROPS = [
  'background-color', 'background-image', 'color', 'font-family', 'font-size', 'font-weight',
  'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration-line',
  'padding', 'margin', 'border-top-width', 'border-top-style', 'border-top-color', 'border-radius',
  'box-shadow', 'backdrop-filter', 'max-width', 'display', 'gap', 'grid-template-columns',
  'justify-content', 'align-items', 'flex-direction', 'transition', 'transform', 'position',
];

/**
 * Candidate properties that carry visual design but are NOT in the allow-list, each with the value
 * that means "not doing anything interesting". A property is residue when its computed value is
 * outside this boring set.
 */
export const CANDIDATES = {
  'width': ['auto'],
  'height': ['auto'],
  'min-height': ['0px', 'auto'],
  'min-width': ['0px', 'auto'],
  'overflow': ['visible'],
  'opacity': ['1'],
  'filter': ['none'],
  'aspect-ratio': ['auto'],
  'object-fit': ['fill'],
  'border-bottom-width': ['0px'],
  'border-left-width': ['0px'],
  'border-right-width': ['0px'],
  'background-size': ['auto'],
  'background-position': ['0% 0%'],
  'background-repeat': ['repeat'],
  'text-shadow': ['none'],
  'outline-width': ['0px'],
  'z-index': ['auto'],
  'flex-grow': ['0'],
  'flex-basis': ['auto'],
  'white-space': ['normal'],
  'mix-blend-mode': ['normal'],
  'clip-path': ['none'],
  'inset': ['auto'],
};

/**
 * Page function source: audit one region. Pass a CSS selector resolved in the page.
 * Returns { region, elements, props: [{prop, count, sample}], stampedEls, totalEls }.
 */
export const RESIDUE_FN = `(function (sel, candidatesJson, capturedJson) {
  var CAND = JSON.parse(candidatesJson);
  var CAPT = JSON.parse(capturedJson);
  var root = document.querySelector(sel);
  if (!root) return null;
  var els = [root].concat([].slice.call(root.querySelectorAll('*')));
  // Cap the walk: a header is small, but a footer on a long page can hold hundreds of nodes and the
  // point is a signal, not an exhaustive audit.
  if (els.length > 400) els = els.slice(0, 400);
  var counts = {}, samples = {}, stamped = 0;
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;          // invisible -> its styles are not the design
    if (el.hasAttribute('data-sc-cs')) stamped++;
    var s = getComputedStyle(el);
    for (var p in CAND) {
      if (CAPT.indexOf(p) !== -1) continue;                 // already carried
      var v = s.getPropertyValue(p);
      if (!v) continue;
      v = v.trim();
      if (CAND[p].indexOf(v) !== -1) continue;              // boring default
      // width/height are always concrete; only count them where they are load-bearing, i.e. on an
      // element with NO text (a bar, a rule, a tile) - that is the case that actually got dropped.
      if ((p === 'width' || p === 'height') && (el.textContent || '').trim() !== '') continue;
      counts[p] = (counts[p] || 0) + 1;
      if (!samples[p]) samples[p] = v.slice(0, 48);
    }
  }
  var props = Object.keys(counts).map(function (p) { return { prop: p, count: counts[p], sample: samples[p] }; });
  props.sort(function (a, b) { return b.count - a.count; });
  return { region: sel, totalEls: els.length, stampedEls: stamped, props: props };
})`;

/** Format one region's audit as CSV rows (no header). */
export function residueCsvRows(audit) {
  if (!audit || !audit.props) return [];
  return audit.props.map((p) => [audit.region, p.prop, p.count, JSON.stringify(p.sample)].join(','));
}

/** A one-line console summary — the bit that makes a silent drop visible during a capture. */
export function residueSummary(audit) {
  if (!audit) return '';
  if (!audit.props.length) return `${audit.region}: fully captured (${audit.stampedEls}/${audit.totalEls} els stamped)`;
  const top = audit.props.slice(0, 4).map((p) => `${p.prop}×${p.count}`).join(', ');
  return `${audit.region}: ${audit.props.length} uncaptured propert${audit.props.length === 1 ? 'y' : 'ies'} in use — ${top}`;
}
