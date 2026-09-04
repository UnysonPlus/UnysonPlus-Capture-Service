// to-blocks.mjs — emit WordPress CORE block markup from the capture intermediate.
//
// Tier C1 of the block-theme output roadmap (see the AI Dev Kit "Block Theme Roadmap").
// It consumes the SAME intermediate as to-pages.mjs — `capture.sections[]`, each either
// decomposed (`sec.blocks[]`) or verbatim (`sec.html`) — but emits portable Gutenberg
// **core** block markup instead of page-builder shortcode nodes. Anything not yet mapped
// to a core block degrades to a scoped `core/html` block (the block-world twin of the
// page builder's verbatim `code_block`), so nothing is dropped.
//
// Vocabulary: CORE-FIRST (plugin-independent). A later tier adds an "enriched" mode that
// swaps the richer fallbacks for UnysonPlus blocks.

/* ------------------------------------------------------------------ *
 * Serialization helpers
 * ------------------------------------------------------------------ */

const s = (v) => (v == null ? '' : String(v));
// Escape a value used inside an HTML attribute (src/href/alt).
const escAttr = (v) => s(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// A block-comment attribute suffix, dropping empty values.
const attrSuffix = (attrs) => {
  const clean = {};
  for (const k in attrs) {
    const v = attrs[k];
    if (v === '' || v == null) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
    clean[k] = v;
  }
  return Object.keys(clean).length ? ' ' + JSON.stringify(clean) : '';
};

// One block. `inner` is the saved HTML (may itself contain nested block comments).
const wpBlock = (name, attrs, inner) => {
  const a = attrSuffix(attrs || {});
  if (inner == null || inner === '') return `<!-- wp:${name}${a} /-->`;
  return `<!-- wp:${name}${a} -->\n${inner}\n<!-- /wp:${name} -->`;
};

/* ------------------------------------------------------------------ *
 * Leaf block mappers
 * ------------------------------------------------------------------ */

const textAlignAttr = (b) => {
  const a = b.align || b.textAlign || '';
  return a === 'center' || a === 'right' ? a : '';
};

function headingBlock(b) {
  const level = b.level >= 1 && b.level <= 6 ? b.level : 2;
  const content = s(b.html) || s(b.text);
  if (!content.trim()) return '';
  const ta = textAlignAttr(b);
  const cls = 'wp-block-heading' + (ta ? ` has-text-align-${ta}` : '');
  return wpBlock('heading', { level, textAlign: ta || undefined }, `<h${level} class="${cls}">${content}</h${level}>`);
}

function paragraphBlock(b) {
  let inner = s(b.html);
  const m = inner.match(/^\s*<p[^>]*>([\s\S]*?)<\/p>\s*$/i);
  const content = (m ? m[1] : inner || s(b.text)).trim();
  if (!content) return '';
  const ta = textAlignAttr(b);
  if (ta) return wpBlock('paragraph', { align: ta }, `<p class="has-text-align-${ta}">${content}</p>`);
  return wpBlock('paragraph', {}, `<p>${content}</p>`);
}

function overlineBlock(b) {
  const content = (s(b.html) || s(b.text)).trim();
  if (!content) return '';
  return wpBlock('paragraph', { fontSize: 'small' }, `<p class="has-small-font-size">${content}</p>`);
}

function buttonsBlock(b) {
  const label = (s(b.label) || s(b.text) || s(b.html)).trim();
  if (!label) return '';
  const href = escAttr(b.href || b.url || '');
  const hrefAttr = href ? ` href="${href}"` : '';
  const button = wpBlock(
    'button',
    {},
    `<div class="wp-block-button"><a class="wp-block-button__link wp-element-button"${hrefAttr}>${label}</a></div>`
  );
  return wpBlock('buttons', {}, `<div class="wp-block-buttons">\n${button}\n</div>`);
}

function imageBlock(b) {
  const src = escAttr(b.src || b.url || '');
  if (!src) return '';
  const alt = escAttr(b.alt || '');
  return wpBlock('image', { sizeSlug: 'large' }, `<figure class="wp-block-image size-large"><img src="${src}" alt="${alt}"/></figure>`);
}

function videoBlock(b) {
  if (b.mode === 'embed' || b.embedUrl) {
    const url = s(b.embedUrl || b.src || '').trim();
    if (!url) return '';
    return wpBlock(
      'embed',
      { url, type: 'video', responsive: true },
      `<figure class="wp-block-embed is-type-video"><div class="wp-block-embed__wrapper">\n${url}\n</div></figure>`
    );
  }
  const src = escAttr(b.src || '');
  if (!src) return '';
  const poster = b.poster ? ` poster="${escAttr(b.poster)}"` : '';
  return wpBlock('video', {}, `<figure class="wp-block-video"><video controls src="${src}"${poster}></video></figure>`);
}

function htmlBlock(html) {
  const h = s(html).trim();
  if (!h) return '';
  return wpBlock('html', {}, h);
}

/* ------------------------------------------------------------------ *
 * Containers
 * ------------------------------------------------------------------ */

function columnsBlock(b, ctx) {
  const cols = (b.cols || [])
    .map((c) => {
      const inner = blocksToBlocks(c.blocks || [], ctx);
      if (!inner) return '';
      return wpBlock('column', {}, `<div class="wp-block-column">\n${inner}\n</div>`);
    })
    .filter(Boolean)
    .join('\n\n');
  if (!cols) return '';
  return wpBlock('columns', {}, `<div class="wp-block-columns">\n${cols}\n</div>`);
}

const LEAF = {
  heading: headingBlock,
  overline: overlineBlock,
  text: paragraphBlock,
  button: buttonsBlock,
  image: imageBlock,
  video: videoBlock,
};

/* ------------------------------------------------------------------ *
 * Enriched vocabulary (Tier C6) — opt-in UnysonPlus blocks
 * ------------------------------------------------------------------ *
 * When opts.vocabulary === 'enriched', an intermediate block is emitted as the
 * matching `unysonplus/*` block instead of the core block, giving the framework's
 * own controls at the cost of a plugin dependency. Each UnysonPlus block is a
 * dynamic (server-rendered) block that delegates to the same shortcode, so its
 * markup is a self-closing comment carrying `upOptions` = the shortcode's atts.
 * Anything without an enricher (or an enricher that returns '') falls back to the
 * CORE mapper — never core/html — so enriched output degrades faithfully.
 */

// Alignment shared by the enrichers — one of '', 'left', 'center', 'right'.
const alignOf = (b) => {
  const a = s(b.align || b.textAlign || '').trim();
  return a === 'left' || a === 'center' || a === 'right' ? a : '';
};

// unysonplus/button → the `button` shortcode: { label, link, target }.
function enrichedButton(b) {
  const label = (s(b.label) || s(b.text) || s(b.html)).trim();
  if (!label) return '';
  const link = s(b.href || b.url || '#').trim() || '#';
  return wpBlock('unysonplus/button', { upOptions: { label, link, target: '_self' } }, '');
}

// unysonplus/special-heading → the `special_heading` shortcode: { title, heading, [alignment] }.
// Uses the plain-text heading (the option is a text field); if absent, degrade to core/heading.
function enrichedHeading(b) {
  const title = s(b.text).trim();
  if (!title) return '';
  const level = Math.min(6, Math.max(1, parseInt(b.level, 10) || 2));
  const up = { title, heading: 'h' + level };
  const align = alignOf(b);
  if (align) up.alignment = align;
  return wpBlock('unysonplus/special-heading', { upOptions: up }, '');
}

// unysonplus/text-block → the `text_block` shortcode: { text, [text_align] }. The `text` option is a
// wp-editor (HTML), so the captured rich HTML carries over.
function enrichedText(b) {
  const text = s(b.html).trim();
  if (!text) return '';
  const up = { text };
  const align = alignOf(b);
  if (align) up.text_align = align;
  return wpBlock('unysonplus/text-block', { upOptions: up }, '');
}

const ENRICH = {
  button: enrichedButton,
  heading: enrichedHeading,
  text: enrichedText,
};

// One intermediate block → core block markup (or, in enriched mode, a UnysonPlus block
// where one is mapped). Unmapped rich types (testimonials, table, accordion, pricing, …)
// fall back to a verbatim core/html block for now (Tier C1 scope); later tiers map them
// to core compositions or, in enriched mode, UnysonPlus blocks.
function blockToBlock(b, ctx) {
  if (!b || !b.t) return '';
  if (ctx && ctx.opts && ctx.opts.vocabulary === 'enriched' && ENRICH[b.t]) {
    const out = ENRICH[b.t](b, ctx);
    if (out) return out; // else fall through to the core mapper (faithful degradation)
  }
  if (b.t === 'row') return columnsBlock(b, ctx);
  const fn = LEAF[b.t];
  if (fn) return fn(b);
  return htmlBlock(b.html || '');
}

function blocksToBlocks(blocks, ctx) {
  return (blocks || [])
    .map((b) => blockToBlock(b, ctx))
    .filter(Boolean)
    .join('\n\n');
}

/* ------------------------------------------------------------------ *
 * Section → core/group
 * ------------------------------------------------------------------ */

function sectionBlock(sec, ctx) {
  let inner = '';
  if (sec.blocks && sec.blocks.length) {
    inner = blocksToBlocks(sec.blocks, ctx);
  } else if (sec.html) {
    inner = htmlBlock(sec.html);
  }
  if (!inner) return '';
  // Enriched: wrap the band in the UnysonPlus `section` block (a dynamic block that delegates to the
  // `section` shortcode and renders its inner blocks as the shortcode's $content) — the framework's
  // own section, with its controls, instead of a core/group. The inner blocks are already emitted in
  // the enriched vocabulary by blocksToBlocks(…, ctx).
  if (ctx && ctx.opts && ctx.opts.vocabulary === 'enriched') {
    return wpBlock('unysonplus/section', { align: 'full' }, inner);
  }
  // Core: a full-bleed band whose inner content is constrained to the site content width — the
  // block-theme idiom for a "section" (a Group with alignfull + a constrained layout).
  return wpBlock(
    'group',
    { align: 'full', layout: { type: 'constrained' } },
    `<div class="wp-block-group alignfull">\n${inner}\n</div>`
  );
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * @param {object} capture  the design-capture (uses `capture.sections`)
 * @param {object} [opts]
 * @returns {string} WordPress block markup for the page body
 */
export function toBlocks(capture, opts = {}) {
  const ctx = { opts };
  return (capture && capture.sections ? capture.sections : [])
    .map((sec) => sectionBlock(sec, ctx))
    .filter(Boolean)
    .join('\n\n');
}

export default { toBlocks };
