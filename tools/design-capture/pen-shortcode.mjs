// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// pen-shortcode.mjs — turn a pasted pen (HTML/CSS/JS) into an INSTALLABLE UnysonPlus shortcode package
// (a slug folder: config.php + options.php + views/view.php + static.php + static/css|js), zipped so it
// uploads at wp-admin → Site Converter → "Add a shortcode" → Upload a .zip. The shortcode renders the pen
// VERBATIM (all CSS/JS effects preserved) with its text turned into editable text options and its images
// into swappable Media uploads. Fully local — headless render for robust DOM extraction, then codegen.
//
// v1 scope: text + image options. Repeaters / colour presets / size options are a later pass.

import { chromium } from 'playwright-core';
import { makeZip } from './minimal-zip.mjs';

const slugify = (s) => String(s || 'pen').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pen';

// Strip a pasted full document down to its body markup (mirror of serve.mjs stripPenHtml).
const stripDocTags = (html) => {
  let s = String(html || '');
  const m = s.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (m) s = m[1];
  return s.replace(/<!doctype[^>]*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?(html|body|head)\b[^>]*>/gi, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<(meta|base)\b[^>]*>/gi, '')
    .trim();
};

/**
 * Scope a stylesheet under a root class so it can't touch the host theme. Prefixes every rule's selectors
 * with `.<root>`, rewrites `html`/`body`/`:root` to the root itself, and recurses into conditional at-rules
 * (@media/@supports/@container) while leaving @keyframes/@font-face bodies untouched. Regex-free brace walk;
 * good enough for typical pen CSS (not a full CSS parser — exotic selector-lists inside :is()/:not() with
 * commas can mis-split, an acceptable v1 limit).
 */
function scopeCss(css, root) {
  const scope = '.' + root;
  css = String(css || '').replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
  const scopeSelectors = (sel) => sel.split(',').map((raw) => {
    const s = raw.trim();
    if (!s) return '';
    if (/^(html|body|:root)$/i.test(s)) return scope;
    if (/^(html|body|:root)\b/i.test(s)) return s.replace(/^(html|body|:root)\b\s*/i, scope + ' ');
    if (s === '*') return scope + ' *';
    return scope + ' ' + s;
  }).filter(Boolean).join(', ');

  let out = '';
  let i = 0;
  const N = css.length;
  while (i < N) {
    let j = i;
    while (j < N && css[j] !== '{' && css[j] !== '}' && css[j] !== ';') j++;
    const prelude = css.slice(i, j).trim();
    const ch = css[j];
    if (ch === ';') { if (prelude) out += prelude + ';\n'; i = j + 1; continue; }
    if (ch !== '{') { i = j + 1; continue; }
    // read balanced block
    let depth = 1; let k = j + 1;
    while (k < N && depth > 0) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; k++; }
    const body = css.slice(j + 1, k - 1);
    if (/^@(media|supports|document|container)/i.test(prelude)) {
      out += prelude + ' {\n' + scopeCss(body, root) + '}\n';
    } else if (/^@/.test(prelude)) {
      out += prelude + ' {\n' + body.trim() + '\n}\n';           // @keyframes/@font-face/@page — verbatim
    } else if (prelude) {
      out += scopeSelectors(prelude) + ' {' + body + '}\n';
    }
    i = k;
  }
  return out;
}

// PHP single-quoted string escape.
const php = (s) => "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
// A short, human label from a text value.
const labelFrom = (s, fallback) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > 32 ? t.slice(0, 32) + '…' : t) : fallback;
};

/** Extract editable slots from the rendered pen: replace text/images with {{TOKENS}}, return the template. */
async function extractSlots(html, css) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent(doc, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    return await page.evaluate(() => {
      const texts = []; const images = [];
      const body = document.body;
      // IMAGES → swappable uploads. Placeholder in the src; keep original as the fallback/default.
      Array.from(body.querySelectorAll('img')).forEach((img, i) => {
        const key = 'IMG_' + (i + 1);
        images.push({ key, src: img.getAttribute('src') || '', alt: img.getAttribute('alt') || '' });
        img.setAttribute('src', '{{' + key + '}}');
      });
      // TEXT → editable options. Only PURE-TEXT leaf elements (no child elements) so we never destroy
      // nested markup; covers headings, paragraphs, link/button labels, list items, captions, cells.
      const SEL = 'h1,h2,h3,h4,h5,h6,p,a,button,span,li,figcaption,blockquote,td,th,dt,dd,label,strong,em,div';
      let n = 0;
      Array.from(body.querySelectorAll(SEL)).forEach((el) => {
        if (el.children.length !== 0) return;                 // has element children → not a pure text leaf
        const t = (el.textContent || '').trim();
        if (!t) return;
        if (/^\s*[{}]{2}/.test(el.textContent)) return;       // already a token
        n++; const key = 'TEXT_' + n;
        texts.push({ key, tag: el.tagName.toLowerCase(), value: t });
        el.textContent = '{{' + key + '}}';
      });
      return { template: body.innerHTML, texts, images };
    });
  } finally { await browser.close(); }
}

const PAGE_BUILDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>';

/**
 * Build the whole shortcode package from a pen. Returns { zip: Buffer, slug, filename, texts, images }.
 */
export async function generatePenShortcode({ title, html, css, js, externals, nameSlots = null }) {
  const cleanHtml = stripDocTags(html);
  const extracted = await extractSlots(cleanHtml, String(css || ''));
  const { template } = extracted;
  let { texts, images } = extracted;

  // `nameSlots` is the OPTIONAL judgement layer, injected by the caller (serve.mjs passes the AI one).
  // It is handed the slots this render found and may return better labels, a better shortcode name, and
  // slots marked as decoration. It only renames and hides; it never writes code, and every slot keeps its
  // original text as the rendered fallback. Without it, behaviour is exactly as before — which is also
  // what happens when it throws or returns nothing, so the package is always produced.
  let named = null;
  if (typeof nameSlots === 'function') {
    try {
      const r = await nameSlots({ name: String(title || '').trim(), texts, images });
      if (r && typeof r === 'object') named = r;
    } catch { named = null; }
  }
  // A skipped slot stops being an option but still renders its original text — `skipped` keeps it in the
  // substitution table, so the markup is identical either way.
  const skipped = [];
  if (named) {
    texts = texts.filter((t) => {
      if (named.texts && named.texts[t.key] && named.texts[t.key].skip) { skipped.push(t); return false; }
      return true;
    });
    texts = texts.map((t) => ({ ...t, label: (named.texts && named.texts[t.key] && named.texts[t.key].label) || '' }));
    images = images.map((x) => ({ ...x, label: (named.images && named.images[x.key] && named.images[x.key].label) || '' }));
  }

  const name = String((named && named.title) || title || 'Pen').trim() || 'Pen';
  const slug = slugify(name);                    // folder + base class + shortcode tag, from the name as-is
  const root = slug;                             // CSS root class
  const label = name;
  const scopedCss = scopeCss(String(css || ''), root);

  // ---- options.php ------------------------------------------------------------------------------------
  const optLines = [];
  texts.forEach((t, i) => {
    const id = 'text_' + (i + 1);
    const big = t.value.length > 60 || /\n/.test(t.value);
    optLines.push(
      `\t\t\t\t'${id}' => array(\n` +
      `\t\t\t\t\t'type'  => '${big ? 'textarea' : 'text'}',\n` +
      `\t\t\t\t\t'label' => __( ${php(t.label || labelFrom(t.value, 'Text ' + (i + 1)))}, 'fw' ),\n` +
      `\t\t\t\t\t'value' => ${php(t.value)},\n` +
      `\t\t\t\t),`
    );
  });
  images.forEach((im, i) => {
    const id = 'image_' + (i + 1);
    optLines.push(
      `\t\t\t\t'${id}' => array(\n` +
      `\t\t\t\t\t'type'        => 'upload',\n` +
      `\t\t\t\t\t'label'       => __( ${php(im.label || ('Image ' + (i + 1)))}, 'fw' ),\n` +
      `\t\t\t\t\t'desc'        => __( 'Swap in your own image (defaults to the original).', 'fw' ),\n` +
      `\t\t\t\t\t'images_only' => true,\n` +
      `\t\t\t\t),`
    );
  });
  const contentGroup = optLines.length
    ? optLines.join('\n')
    : `\t\t\t\t'_note' => array( 'type' => 'html', 'label' => false, 'html' => __( 'This element has no editable content.', 'fw' ) ),`;

  const optionsPhp =
`<?php if ( ! defined( 'FW' ) ) { die( 'Forbidden' ); }
/**
 * options.php — auto-generated from a pen by the UnysonPlus Pen → Shortcode tool.
 * Content tab exposes the pen's text + images as editable options; Style/Animations/Advanced are the
 * shared framework tabs. Regenerate rather than hand-edit if the pen changes.
 */
$options = array(
	'tab_content' => array(
		'title'   => __( 'Content', 'fw' ),
		'type'    => 'tab',
		'options' => array(
			'group_main' => array(
				'type'    => 'group',
				'options' => array(
${contentGroup}
				),
			),
		),
	),
	'tab_style' => array(
		'title'   => __( 'Style', 'fw' ),
		'type'    => 'tab',
		'options' => array(
			'group_spacing' => array(
				'type'    => 'group',
				'options' => array(
					'spacing' => array(
						'type'  => 'spacing',
						'label' => __( 'Margin & Padding', 'fw' ),
						'desc'  => __( 'Outer spacing around the element.', 'fw' ),
					),
				),
			),
		),
	),
	'tab_animation' => array(
		'title'   => __( 'Animations', 'fw' ),
		'type'    => 'tab',
		'options' => function_exists( 'sc_get_animation_fields' ) ? sc_get_animation_fields() : array(),
	),
	'tab_advanced' => array(
		'title'   => __( 'Advanced', 'fw' ),
		'type'    => 'tab',
		'options' => array(
			'advanced_settings' => array(
				'type'    => 'group',
				'options' => function_exists( 'sc_get_advanced_tab' ) ? sc_get_advanced_tab() : array(),
			),
		),
	),
);
`;

  // ---- config.php -------------------------------------------------------------------------------------
  const configPhp =
`<?php if ( ! defined( 'FW' ) ) { die( 'Forbidden' ); }
/** config.php — how this pen element presents itself in the builder. Auto-generated. */
$cfg = array();
$cfg['page_builder'] = array(
	'title'          => __( ${php(label)}, 'fw' ),
	'description'    => __( 'Ported from a pen (HTML/CSS/JS) — text & images are editable.', 'fw' ),
	'tab'            => __( 'Content Elements', 'fw' ),
	'popup_size'     => 'large',
	'title_template' => '{{ if ( o ) { }}<h3><strong>${label.replace(/'/g, "\\'").replace(/</g, '&lt;')}</strong></h3>{{ } }}',
);
`;

  // ---- views/view.php ---------------------------------------------------------------------------------
  // Placeholder → escaped-value substitution. Images fall back to the original URL until the user swaps.
  const subLines = [];
  texts.forEach((t, i) => {
    const id = 'text_' + (i + 1);
    subLines.push(`\t'{{${t.key}}}' => esc_html( isset( $atts['${id}'] ) ? (string) $atts['${id}'] : ${php(t.value)} ),`);
  });
  images.forEach((im, i) => {
    const id = 'image_' + (i + 1);
    subLines.push(`\t'{{${im.key}}}' => esc_url( ( isset( $atts['${id}']['url'] ) && $atts['${id}']['url'] !== '' ) ? $atts['${id}']['url'] : ${php(im.src)} ),`);
  });
  // Slots judged to be decoration get no option, but their token still resolves to the original text —
  // so the rendered markup is identical whether or not the naming pass ran.
  skipped.forEach((t) => {
    subLines.push(`\t'{{${t.key}}}' => esc_html( ${php(t.value)} ), // fixed: decoration, not an option`);
  });
  const subsBlock = subLines.length ? subLines.join('\n') : "\t// no dynamic slots";

  const viewPhp =
`<?php if ( ! defined( 'FW' ) ) { die( 'Forbidden' ); }
/**
 * views/view.php — renders the ported pen. Auto-generated. The markup is the pen's own (verbatim, so its
 * CSS/JS effects work); only the {{TOKENS}} are replaced with the escaped option values.
 *
 * @var array  $atts
 * @var string $content
 */

// The pen markup with {{TOKENS}} for the editable text + images (nowdoc = no PHP interpolation).
$tpl = <<<'PEN_TPL'
${template}
PEN_TPL;

$subs = array(
${subsBlock}
);
$markup = strtr( $tpl, $subs );

// First-class builder wrapper: base class + per-instance class + Advanced/Style/Animation wiring.
$atts['base_class']       = ${php(root)};
$atts['unique_id_prefix'] = ${php(root + '-')};
if ( function_exists( 'sc_build_wrapper_attr' ) ) {
	$attr = sc_build_wrapper_attr( $atts );
	echo '<div ' . fw_attr_to_html( $attr ) . '>' . $markup . '</div>';
} else {
	echo '<div class="' . esc_attr( ${php(root)} ) . '">' . $markup . '</div>';
}
`;

  // ---- static.php -------------------------------------------------------------------------------------
  const hasJs = String(js || '').trim() !== '';
  const staticPhp =
`<?php if ( ! defined( 'FW' ) ) { die( 'Forbidden' ); }
/**
 * static.php — enqueue the scoped CSS/JS for this pen element. Auto-generated.
 *
 * A user-installed shortcode lives under wp-content/uploads/unysonplus/shortcodes/ (or the theme's
 * customization tree), NOT inside the plugin — so we resolve THIS folder's own public URL from its
 * filesystem path (works wherever it was installed) instead of the plugin's shortcodes URI. filemtime
 * busts the browser cache whenever the pen is re-generated + re-uploaded.
 */
$dir     = wp_normalize_path( dirname( __FILE__ ) );
$content = wp_normalize_path( WP_CONTENT_DIR );
$base    = ( strpos( $dir, $content ) === 0 )
	? content_url( substr( $dir, strlen( $content ) ) )
	: plugins_url( '', __FILE__ );
$css_path = $dir . '/static/css/styles.css';
$ver = file_exists( $css_path ) ? (string) filemtime( $css_path ) : '1.0.0';
wp_enqueue_style( 'fw-shortcode-${slug}', $base . '/static/css/styles.css', array(), $ver );
${hasJs ? `$js_path = $dir . '/static/js/scripts.js';\n$jver = file_exists( $js_path ) ? (string) filemtime( $js_path ) : '1.0.0';\nwp_enqueue_script( 'fw-shortcode-${slug}', $base . '/static/js/scripts.js', array(), $jver, true );\n` : ''}`;

  // ---- static/js/scripts.js ---------------------------------------------------------------------------
  const scriptsJs = hasJs
    ? `/* Ported pen behaviour. Runs on DOM ready. (v1: not multi-instance scoped — see the Pen tool.) */
(function () {
  function __penReady(fn){ if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  __penReady(function () {
${String(js)}
  });
})();
`
    : '';

  const files = [
    { name: `${slug}/config.php`, data: configPhp },
    { name: `${slug}/options.php`, data: optionsPhp },
    { name: `${slug}/views/view.php`, data: viewPhp },
    { name: `${slug}/static.php`, data: staticPhp },
    { name: `${slug}/static/css/styles.css`, data: scopedCss || `/* ${label} */\n` },
    { name: `${slug}/static/img/page_builder.svg`, data: PAGE_BUILDER_SVG },
  ];
  if (hasJs) files.push({ name: `${slug}/static/js/scripts.js`, data: scriptsJs });

  const zip = makeZip(files);
  return {
    zip, slug, filename: slug + '.zip', name,
    texts: texts.length, images: images.length, skipped: skipped.length,
    // What the options ended up called — the dashboard shows this so the naming is reviewable, not a
    // black box the person only discovers after installing the shortcode.
    labels: texts.map((t, i) => ({ id: 'text_' + (i + 1), label: t.label || labelFrom(t.value, 'Text ' + (i + 1)), sample: String(t.value).slice(0, 60) }))
      .concat(images.map((im, i) => ({ id: 'image_' + (i + 1), label: im.label || ('Image ' + (i + 1)), sample: im.alt || im.src.slice(0, 60) }))),
  };
}
