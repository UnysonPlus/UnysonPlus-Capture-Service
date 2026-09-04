// to-block-theme.mjs — generate a minimal, valid WordPress BLOCK THEME (FSE) from a capture.
//
// Tier C1 of the block-theme output roadmap. Pairs with to-blocks.mjs (which emits the page
// BODY as core block markup): this emits the theme SHELL the body renders inside —
// `style.css` + `theme.json` (design system) + `templates/*.html` + `parts/*.html`. Portable:
// core blocks + theme.json only, no plugin dependency.
//
// It never touches the parent theme `unysonplus-theme` — this is a NEW generated theme, an
// output of the conversion.

import { toDesignConfig } from './to-design-config.mjs';
import { toBlocks } from './to-blocks.mjs';

/* ------------------------------------------------------------------ *
 * Value helpers
 * ------------------------------------------------------------------ */

const s = (v) => (v == null ? '' : String(v));
const slugify = (name) => s(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'converted-theme';
const titleCase = (k) => s(k).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const quoteFamily = (fam) => {
  const first = s(fam).split(',')[0].trim().replace(/^["']|["']$/g, '');
  if (!first) return 'system-ui, sans-serif';
  return `"${first}", system-ui, sans-serif`;
};

const escAttr = (v) => s(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escHtml = (v) => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const jstr = (v) => JSON.stringify(s(v));

// Map a captured social network hint → a WordPress core/social-link service slug.
function netToService(net) {
  const n = s(net).toLowerCase();
  const map = {
    facebook: 'facebook', fb: 'facebook', instagram: 'instagram', ig: 'instagram',
    twitter: 'x', x: 'x', youtube: 'youtube', yt: 'youtube', tiktok: 'tiktok',
    linkedin: 'linkedin', pinterest: 'pinterest', whatsapp: 'whatsapp', telegram: 'telegram',
    github: 'github', discord: 'discord', spotify: 'spotify', vimeo: 'vimeo',
    threads: 'threads', snapchat: 'snapchat', reddit: 'reddit', twitch: 'twitch',
  };
  return map[n] || 'chain';
}

// A captured design token → a CSS colour, or '' if it isn't one. Handles bare HSL triplets
// (`0 0% 5%` → `hsl(0 0% 5%)`, the shadcn/Tailwind convention) and literal colours.
function tokenToColor(v) {
  const val = s(v).trim();
  if (!val) return '';
  if (/^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/.test(val)) return val;
  if (/^-?\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/.test(val)) return `hsl(${val})`;
  return '';
}

/* ------------------------------------------------------------------ *
 * theme.json — the design system
 * ------------------------------------------------------------------ */

function buildThemeJson(dc) {
  const colors = dc.colors || {};
  const palette = [];
  const seen = new Set();
  const add = (slug, name, color) => {
    if (!color || seen.has(slug)) return;
    seen.add(slug);
    palette.push({ slug, name, color });
  };

  add('primary', 'Primary', colors.accent);
  add('background', 'Background', colors.bg || '#ffffff');
  add('foreground', 'Foreground', colors.ink || '#1a1a1a');
  if (colors.heading) add('heading', 'Heading', colors.heading);

  // Brand tokens the source defined (--brand-red, --primary, --dark …) that resolve to a colour.
  for (const [k, v] of Object.entries(dc.css_vars || {})) {
    const name = k.replace(/^--/, '');
    if (!/^(brand[-_]|primary|secondary|accent|dark|background|foreground|muted|surface|card)/i.test(name)) continue;
    const color = tokenToColor(v);
    if (color) add(slugify(name), titleCase(name), color);
  }

  const fontFamilies = [];
  if (dc.fonts && dc.fonts.body) fontFamilies.push({ slug: 'body', name: 'Body', fontFamily: quoteFamily(dc.fonts.body) });
  if (dc.fonts && dc.fonts.heading) fontFamilies.push({ slug: 'heading', name: 'Heading', fontFamily: quoteFamily(dc.fonts.heading) });

  const contentSize = (dc.layout && /^\d/.test(s(dc.layout.container_max)) && dc.layout.container_max) || '1140px';

  const settings = {
    appearanceTools: true,
    layout: { contentSize, wideSize: '1280px' },
    color: { palette, defaultPalette: false },
    spacing: {
      units: [ 'px', 'rem', 'em', '%', 'vw', 'vh' ],
      spacingSizes: [
        { slug: '30', name: 'Small', size: '1rem' },
        { slug: '40', name: 'Medium', size: '1.5rem' },
        { slug: '50', name: 'Large', size: '2.5rem' },
        { slug: '60', name: 'X-Large', size: '4rem' },
        { slug: '70', name: '2X-Large', size: '6rem' },
      ],
    },
  };
  settings.typography = {
    fluid: true,
    fontSizes: [
      { slug: 'small', name: 'Small', size: '0.875rem' },
      { slug: 'medium', name: 'Medium', size: '1rem' },
      { slug: 'large', name: 'Large', size: '1.5rem', fluid: { min: '1.25rem', max: '1.5rem' } },
      { slug: 'x-large', name: 'Extra Large', size: '2.25rem', fluid: { min: '1.75rem', max: '2.25rem' } },
      { slug: 'xx-large', name: 'Huge', size: '3.5rem', fluid: { min: '2.5rem', max: '3.5rem' } },
    ],
  };
  if (fontFamilies.length) settings.typography.fontFamilies = fontFamilies;

  const styles = {
    color: {
      background: 'var(--wp--preset--color--background)',
      text: 'var(--wp--preset--color--foreground)',
    },
    elements: {
      button: {
        color: { background: 'var(--wp--preset--color--primary)', text: 'var(--wp--preset--color--background)' },
      },
    },
  };
  if (dc.fonts && dc.fonts.body) styles.typography = { fontFamily: 'var(--wp--preset--font-family--body)' };
  if (dc.fonts && dc.fonts.heading) {
    styles.elements = styles.elements || {};
    styles.elements.heading = { typography: { fontFamily: 'var(--wp--preset--font-family--heading)' } };
  }

  return {
    $schema: 'https://schemas.wp.org/trunk/theme.json',
    version: 3,
    settings,
    styles,
    templateParts: [
      { name: 'header', title: 'Header', area: 'header' },
      { name: 'footer', title: 'Footer', area: 'footer' },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Templates + parts (block markup)
 * ------------------------------------------------------------------ */

// HEADER — site title + the CAPTURED nav (as inline core/navigation-link) + the captured CTA button.
function headerPart(cap) {
  const header = (cap && cap.header) || {};
  const navSeen = new Set();
  const nav = (header.nav || []).filter((n) => {
    const label = s(n && n.label).trim();
    if (!label) return false;
    const key = label.toLowerCase() + '|' + s(n.href);
    if (navSeen.has(key)) return false; // drop duplicate links (e.g. a repeated language switcher)
    navSeen.add(key);
    return true;
  });
  const links = nav
    .map((n) => `<!-- wp:navigation-link {"label":${jstr(s(n.label).trim())},"url":${jstr(escAttr(n.href || '#'))},"kind":"custom"} /-->`)
    .join('\n');
  const navBlock = links
    ? `<!-- wp:navigation {"overlayMenu":"mobile","layout":{"type":"flex","justifyContent":"right"}} -->\n${links}\n<!-- /wp:navigation -->`
    : '<!-- wp:navigation {"overlayMenu":"mobile"} /-->';
  // Brand: a captured image logo → core/site-logo (renders from the custom_logo theme mod the
  // installer sets); otherwise the site title stands in.
  const logo = header.logo || {};
  const brandBlock = logo.type === 'image' && s(logo.src).trim()
    ? '<!-- wp:site-logo {"width":120} /-->'
    : '<!-- wp:site-title {"level":0} /-->';
  const cta = header.cta && s(header.cta.label).trim()
    ? `<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="${escAttr(header.cta.href || '#')}">${escHtml(s(header.cta.label).trim())}</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons -->`
    : '';
  return `<!-- wp:group {"align":"full","layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull">
<!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","flexWrap":"wrap"}} -->
<div class="wp-block-group">
${brandBlock}
<!-- wp:group {"layout":{"type":"flex","flexWrap":"nowrap"}} -->
<div class="wp-block-group">
${navBlock}
${cta}
</div>
<!-- /wp:group -->
</div>
<!-- /wp:group -->
</div>
<!-- /wp:group -->`;
}

// FOOTER — captured link columns + social icons + copyright.
function footerPart(cap) {
  const footer = (cap && cap.footer) || {};
  const groups = (footer.groups || []).filter((g) => Array.isArray(g.links) && g.links.length);
  const cols = groups.slice(0, 4).map((g) => {
    const heading = s(g.title).trim()
      ? `<!-- wp:heading {"level":3,"fontSize":"medium"} -->\n<h3 class="wp-block-heading has-medium-font-size">${escHtml(g.title.trim())}</h3>\n<!-- /wp:heading -->`
      : '';
    const list = g.links
      .map((l) => `<!-- wp:paragraph {"fontSize":"small"} -->\n<p class="has-small-font-size"><a href="${escAttr(l.href || '#')}">${escHtml(s(l.label).trim())}</a></p>\n<!-- /wp:paragraph -->`)
      .join('\n');
    return `<!-- wp:column -->\n<div class="wp-block-column">\n${heading}\n${list}\n</div>\n<!-- /wp:column -->`;
  }).join('\n\n');
  const colsBlock = cols ? `<!-- wp:columns {"align":"wide"} -->\n<div class="wp-block-columns alignwide">\n${cols}\n</div>\n<!-- /wp:columns -->` : '';

  const social = (footer.social || []).filter((s2) => /^https?:/i.test(s(s2.href)));
  const socialBlock = social.length
    ? `<!-- wp:social-links {"className":"is-style-logos-only"} -->\n<ul class="wp-block-social-links is-style-logos-only">\n${social.map((s2) => `<!-- wp:social-link {"url":${jstr(escAttr(s2.href))},"service":${jstr(netToService(s2.net))}} /-->`).join('\n')}\n</ul>\n<!-- /wp:social-links -->`
    : '';

  let copy = s(footer.copyright).trim();
  // Trailing legal links (Privacy/Terms/…) often run straight into the copyright text — cut at the
  // natural end so the line reads as a copyright, not a run-on.
  const rr = copy.match(/^(.*?rights reserved\.?)/i);
  if (rr) copy = rr[1].trim();
  const copyBlock = `<!-- wp:paragraph {"align":"center","fontSize":"small"} -->\n<p class="has-text-align-center has-small-font-size">${copy ? escHtml(copy) : '&copy; '}</p>\n<!-- /wp:paragraph -->`;

  const inner = [colsBlock, socialBlock, copyBlock].filter(Boolean).join('\n\n');
  return `<!-- wp:group {"align":"full","layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull">
${inner}
</div>
<!-- /wp:group -->`;
}

const withChrome = (main) => `<!-- wp:template-part {"slug":"header","tagName":"header"} /-->

<!-- wp:group {"tagName":"main","layout":{"type":"constrained"}} -->
<main class="wp-block-group">
${main}
</main>
<!-- /wp:group -->

<!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->`;

const indexTemplate = () => withChrome(`<!-- wp:query {"query":{"perPage":10,"postType":"post"},"layout":{"type":"constrained"}} -->
<div class="wp-block-query">
<!-- wp:post-template -->
<!-- wp:post-title {"isLink":true} /-->
<!-- wp:post-excerpt /-->
<!-- /wp:post-template -->
</div>
<!-- /wp:query -->`);

const pageTemplate = () => withChrome(`<!-- wp:post-content {"layout":{"type":"constrained"}} /-->`);

const singleTemplate = () => withChrome(`<!-- wp:post-title {"level":1} /-->
<!-- wp:post-content {"layout":{"type":"constrained"}} /-->`);

const notFoundTemplate = () => withChrome(`<!-- wp:heading {"level":1} -->
<h1 class="wp-block-heading">Page not found</h1>
<!-- /wp:heading -->
<!-- wp:paragraph -->
<p>The page you were looking for isn't here.</p>
<!-- /wp:paragraph -->`);

/* ------------------------------------------------------------------ *
 * style.css — the block-theme header
 * ------------------------------------------------------------------ */

function styleCss(dc, name, slug) {
  const theme = (dc.theme && dc.theme.name) || name || 'Converted Site';
  return `/*
Theme Name: ${theme}
Author: UnysonPlus Site Converter
Description: A portable WordPress block theme generated from a captured site. Design system in theme.json; no plugin required.
Version: 1.0.0
Requires at least: 6.5
Tested up to: 6.7
Requires PHP: 7.4
Text Domain: ${slug}
*/
`;
}

/* ------------------------------------------------------------------ *
 * Block patterns — each converted section as a reusable, insertable pattern
 * ------------------------------------------------------------------ */

const stripTags = (h) => s(h)
  .replace(/<[^>]+>/g, ' ') // tags → space so `<br>`-joined words don't fuse
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();
const clip = (str, n) => (str.length > n ? str.slice(0, n - 1).trim() + '…' : str);

// A human title for a section pattern: its first heading, else an ordinal.
function sectionPatternTitle(sec, n) {
  const blocks = (sec && sec.blocks) || [];
  const h = blocks.find((b) => b && b.t === 'heading');
  const txt = h ? stripTags(h.html || h.text || '') : '';
  return txt ? clip(txt, 42) : `Section ${n}`;
}

// One pattern file. WordPress auto-registers every PHP file in a block theme's `patterns/` dir.
function patternFile(slug, title, category, markup) {
  return `<?php
/**
 * Title: ${title.replace(/\*\//g, '* /')}
 * Slug: ${slug}
 * Categories: ${category}
 * Inserter: true
 */
?>
${markup}
`;
}

// functions.php — register the pattern CATEGORY so the converted patterns group under the theme.
function functionsPhp(slug, name) {
  return `<?php
// Register a pattern category so this theme's converted-section patterns group together in the inserter.
add_action( 'init', function () {
\tif ( function_exists( 'register_block_pattern_category' ) ) {
\t\tregister_block_pattern_category( '${slug}', array( 'label' => ${JSON.stringify(name)} ) );
\t}
} );
`;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * @param {object} capture design-capture
 * @param {object} [opts]  { name }
 * @returns {{ slug:string, files: Record<string,string> }}
 */
export function toBlockTheme(capture, opts = {}) {
  const dc = toDesignConfig(capture) || {};
  const name = opts.name || (dc.theme && dc.theme.name) || 'Converted Site';
  const slug = (dc.theme && dc.theme.slug) || slugify(name);

  const files = {
    'style.css': styleCss(dc, name, slug),
    'theme.json': JSON.stringify(buildThemeJson(dc), null, '\t') + '\n',
    'templates/index.html': indexTemplate(),
    'templates/page.html': pageTemplate(),
    'templates/single.html': singleTemplate(),
    'templates/404.html': notFoundTemplate(),
    'parts/header.html': headerPart(capture),
    'parts/footer.html': footerPart(capture),
    'functions.php': functionsPhp(slug, name),
  };

  // Each converted section → a reusable, insertable block pattern.
  ((capture && capture.sections) || []).forEach((sec, i) => {
    const markup = toBlocks({ sections: [sec] }, { vocabulary: opts.vocabulary });
    if (!s(markup).trim()) return;
    const n = i + 1;
    files[`patterns/section-${n}.php`] = patternFile(`${slug}/section-${n}`, sectionPatternTitle(sec, n), slug, markup);
  });

  return { slug, files };
}

export default { toBlockTheme };
