// Generic DOM-mirror mapper — the "clone any site" fallback. Maps a section's
// captured mirror subtree (see capture-extract.mjs) into UnysonPlus builder nodes
// (section → column → text_block / image / button), carrying each element's computed
// styles into a generated stylesheet keyed by a unique class. The hybrid (to-pages.mjs)
// uses this for sections no archetype recognized — so the structure stays editable
// while the look stays faithful, and the styles live in clean CSS, not inline soup.

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
const widthFor = (n) => ({ 1: '1_1', 2: '1_2', 3: '1_3', 4: '1_4', 5: '1_5', 6: '1_6' }[n] || '1_3');

const uid = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

// A mirror styles object → CSS declarations.
function stylesToCss(st) {
  if (!st) return '';
  const d = [];
  const p = (k, v) => { if (v) d.push(`${k}:${v}`); };
  p('color', st.color);
  p('background-color', st.bg);
  p('background-image', st.bgImage);
  if (st.bgImage) d.push('background-size:cover', 'background-position:center');
  p('padding', st.padding);
  p('border-radius', st.borderRadius);
  p('box-shadow', st.boxShadow);
  p('border', st.border);
  if (st.maxWidth) d.push(`max-width:${st.maxWidth}`, 'margin-left:auto', 'margin-right:auto');
  p('text-align', st.textAlign);
  p('font-family', st.fontFamily);
  p('font-size', st.fontSize);
  p('font-weight', st.fontWeight);
  p('letter-spacing', st.letterSpacing);
  p('line-height', st.lineHeight);
  p('text-transform', st.textTransform);
  // Full design properties (previously dropped): wavy underlines, keyframe animations,
  // one-off transforms, transitions — so nothing captured is lost on the emit.
  p('text-decoration', st.textDecoration);
  p('transform', st.transform);
  p('transition', st.transition);
  if (st.animation) d.push(`animation:${st.animation}`);
  return d.join(';');
}

// The element's :hover state (from its hover:* utilities) → a CSS declaration string.
function hoverToCss(h) {
  if (!h) return '';
  const d = [];
  if (h.backgroundColor) d.push(`background-color:${h.backgroundColor}`);
  if (h.color) d.push(`color:${h.color}`);
  if (h.borderColor) d.push(`border-color:${h.borderColor}`);
  return d.join(';');
}

// Ensure the @keyframes for a (known Tailwind) animation name is emitted once into ctx.css.
const TW_KEYFRAMES = {
  bounce: '@keyframes bounce{0%,100%{transform:translateY(-25%);animation-timing-function:cubic-bezier(.8,0,1,1)}50%{transform:none;animation-timing-function:cubic-bezier(0,0,.2,1)}}',
  pulse: '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}',
  spin: '@keyframes spin{to{transform:rotate(360deg)}}',
  ping: '@keyframes ping{75%,100%{transform:scale(2);opacity:0}}',
};
function ensureKeyframes(animation, ctx) {
  const name = (String(animation || '').trim().split(/\s+/)[0] || '');
  if (!TW_KEYFRAMES[name]) return; // custom keyframes not captured — safe no-op
  ctx._kf = ctx._kf || new Set();
  if (!ctx._kf.has(name)) { ctx._kf.add(name); ctx.css.push(TW_KEYFRAMES[name]); }
}

/**
 * Map one section's mirror subtree → a builder `section` node, pushing CSS rules into
 * ctx.css. ctx = { atoms, css: string[], seq: {n}, localize?: fn }.
 */
export function mirrorSection(secMirror, ctx) {
  const clone = (k) => structuredClone(ctx.atoms[k]);
  const stamp = (n) => { if (n.atts) { n.atts.unique_id = uid(); n.atts.css_id = ''; } return n; };

  // Register a style object → a unique class (layout-only objects emit nothing).
  const klass = (st) => {
    const css = stylesToCss(st);
    const hoverCss = st && st.hover ? hoverToCss(st.hover) : '';
    if (!css && !hoverCss) return '';
    const c = 'scm-' + (ctx.seq.n++).toString(36);
    if (css) ctx.css.push(`.${c}{${css}}`);
    if (hoverCss) ctx.css.push(`.${c}:hover{${hoverCss}}`);
    if (st && st.animation) ensureKeyframes(st.animation, ctx); // emit the @keyframes once
    return c;
  };

  const textBlock = (html) => {
    const n = stamp(clone('text_block'));
    n.atts.text = html;
    n.atts.css_class = '';
    return n;
  };

  // A leaf mirror node → a builder item (text_block holding the styled element).
  const leaf = (node) => {
    const c = klass(node.styles);
    const cl = c ? ` class="${c}"` : '';
    if (node.role === 'heading') {
      const lvl = node.level >= 1 && node.level <= 6 ? node.level : 2;
      return textBlock(`<h${lvl}${cl}>${node.html || esc(node.text)}</h${lvl}>`);
    }
    if (node.role === 'text') {
      // A bare "NN%" reads as a progress value — synthesize the bar the source draws (its
      // fill width / colour aren't captured, so derive width from the % and paint it accent).
      const pm = String(node.text || node.html || '').trim().match(/^(\d{1,3})%$/);
      if (pm) {
        const w = Math.max(0, Math.min(100, parseInt(pm[1], 10)));
        if (!ctx._progCss) {
          ctx._progCss = true;
          ctx.css.push(
            `.scm-progress{height:8px;background:rgba(17,21,29,.08);border-radius:9999px;overflow:hidden;margin:.55rem 0 .25rem;}`,
            `.scm-progress__fill{display:block;height:100%;border-radius:9999px;background:${ctx.accent || '#2563eb'};}`,
            `.scm-progress__label{margin:0;font-size:.8rem;opacity:.7;}`
          );
        }
        const labelCls = c ? `scm-progress__label ${c}` : 'scm-progress__label';
        return textBlock(`<div class="scm-progress" role="progressbar" aria-valuenow="${w}" aria-valuemin="0" aria-valuemax="100"><span class="scm-progress__fill" style="width:${w}%"></span></div><p class="${labelCls}">${node.html || esc(node.text)}</p>`);
      }
      return textBlock(`<p${cl}>${node.html || ''}</p>`);
    }
    if (node.role === 'image') return textBlock(`<figure class="scm-figure"><img${cl} src="${escAttr(node.src)}" alt="${escAttr(node.alt)}" loading="lazy"></figure>`);
    if (node.role === 'button') {
      const href = ctx.localize ? ctx.localize(node.href) : node.href;
      return textBlock(`<p class="scm-btnrow"><a${cl} href="${escAttr(href)}">${esc(node.label)}</a></p>`);
    }
    return null;
  };

  // Collect leaf items from a subtree, stacked in document order (v1 flattens nesting
  // below the primary row — the archetypes own the structured sections anyway).
  const stack = (node) => {
    const out = [];
    const walk = (n) => {
      if (n.role !== 'container') { const it = leaf(n); if (it) out.push(it); return; }
      for (const c of (n.children || [])) walk(c);
    };
    for (const c of (node.children || [])) walk(c);
    return out;
  };

  const column = (node, width, items) => {
    const c = stamp(clone('column'));
    c.width = width;
    c.atts.css_class = klass(node && node.styles);
    c._items = items;
    return c;
  };

  // The first flex-row / grid container with >1 container children → the section's row.
  const findRow = (node) => {
    for (const ch of (node.children || [])) {
      const isRow = ch.role === 'container' && ((ch.styles.flex && (ch.styles.flex.dir || '').startsWith('row')) || ch.styles.grid);
      if (isRow && (ch.children || []).filter((x) => x.role === 'container').length > 1) return ch;
      const deeper = findRow(ch);
      if (deeper) return deeper;
    }
    return null;
  };

  const cols = [];
  const row = findRow(secMirror);
  if (row) {
    const parts = (row.children || []).filter(Boolean);
    const w = widthFor(parts.length);
    for (const part of parts) {
      const items = part.role === 'container' ? stack(part) : [leaf(part)].filter(Boolean);
      if (items.length) cols.push(column(part, w, items));
    }
  }
  if (!cols.length) {
    const items = stack(secMirror);
    if (items.length) cols.push(column(null, '1_1', items));
  }

  if (!cols.length) return null;
  const s = stamp(clone('section'));
  s.atts.css_class = klass(secMirror.styles);
  s._items = cols;
  return s;
}
