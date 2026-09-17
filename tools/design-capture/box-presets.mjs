// EVERY captured state of an element → preset Custom CSS ({{SELECTOR}}-scoped): ::before / ::after layers, their hover state,
// :hover / :active / :focus* rules, a hover-revealed descendant (hover-child{rel}{decls}) and the @keyframes. PHP: state_css.
export function stateCss(hov, kf = '', skipPseudo = false, skipSelf = []) {
  hov = String(hov || ''); if (!hov.trim()) return '';
  const rules = []; let rel = false;
  const clean = (body, drop) => { const pd = {}; for (const decl of String(body).split(';')) { const cp = decl.indexOf(':'); if (cp < 0) continue; const k = decl.slice(0, cp).trim().toLowerCase(); let v = decl.slice(cp + 1).trim(); if (!v || v === 'initial' || k.startsWith('--') || drop.includes(k)) continue; if (!/^[a-z0-9()%.,\s#\/"'-]+$/i.test(v) || /expression\(|javascript:|url\(/i.test(v)) continue; if (k === 'content') v = '""'; pd[k] = v; } return pd; };
  const selOf = { before: '{{SELECTOR}}::before', after: '{{SELECTOR}}::after', 'hover-self': '{{SELECTOR}}:hover', 'hover-before': '{{SELECTOR}}:hover::before', 'hover-after': '{{SELECTOR}}:hover::after', active: '{{SELECTOR}}:active', focus: '{{SELECTOR}}:focus', 'focus-visible': '{{SELECTOR}}:focus-visible', 'focus-within': '{{SELECTOR}}:focus-within', 'active-before': '{{SELECTOR}}:active::before', 'active-after': '{{SELECTOR}}:active::after' };
  const trDrop = ['transition-property', 'transition-duration', 'transition-timing-function'];
  for (const chunk of hov.split('|')) {
    const m = chunk.trim().match(/^([a-z-]+)(?:\{([^{}]*)\})?\{([^{}]*)\}$/i); if (!m) continue;
    const state = m[1].toLowerCase(), desc = (m[2] || '').trim(), body = m[3];
    if (state === 'hover-child') { if (!desc || !/^[a-z0-9_.#>+~:\[\]="'\s,-]{1,120}$/i.test(desc)) continue; const pd = clean(body, trDrop); const ks = Object.keys(pd); if (!ks.length) continue; rules.push('{{SELECTOR}}:hover ' + desc + ' { ' + ks.map((k) => k + ':' + pd[k]).join('; ') + '; }'); continue; }
    if (!selOf[state]) continue;
    if (skipPseudo && /before|after/.test(state)) continue;
    const pd = clean(body, state === 'hover-self' ? trDrop.concat(skipSelf) : trDrop); const ks = Object.keys(pd); if (!ks.length) continue;
    if (state === 'before' || state === 'after') { if ((pd.position || '').toLowerCase() === 'absolute') rel = true; if (!pd['pointer-events']) { pd['pointer-events'] = 'none'; ks.push('pointer-events'); } }
    rules.push(selOf[state] + ' { ' + ks.map((k) => k + ':' + pd[k]).join('; ') + '; }');
  }
  if (!rules.length) return '';
  if (rel) rules.unshift('{{SELECTOR}} { position: relative; overflow: hidden; isolation: isolate; }');
  kf = String(kf || '').trim(); if (kf && /@keyframes/i.test(kf) && !/<\/|expression\(|javascript:|url\(/i.test(kf)) rules.push(kf);
  return rules.join('\n');
}
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Box Presets (Theme Settings → Components → Box Presets = the `border_presets` data model) for the
// URL/JS conversion path — the JS counterpart of PHP `FW_Site_Converter_Stitch::build_box_presets()`.
// It clusters the DISTINCT card/box SKINS captured from the page (border + corner radius + shadow +
// hover-lift), emits the top few as named presets (`boxp-{id}` card skins) on top of the plugin
// defaults, and hands back a lookup so each icon_box can point its `box_style` at the matching preset.
//
// Unlike the PHP path (which compiles Tailwind classes), the JS path already has each box's RESOLVED
// computed values (from `cardOf().box`), so it clusters those directly — source-framework-agnostic.

// The plugin's built-in Box Presets — mirror of unysonplus_default_border_presets() (border-presets.php).
// The theme-settings importer REPLACES the `border_presets` option, so the emitted value must be
// defaults + derived or the built-in library is lost.
const _u = (value, unit = 'px') => ({ value: String(value), unit });
const _col = (slug) => ({ predefined: String(slug), custom: '' });
const _empty = { predefined: '', custom: '' };

/**
 * Parse a CSS linear-gradient into the preset gradient shape { type:'linear', angle, stops:[{color,position}] } —
 * the SAME shape the button preset's Background Gradient (gradient-v2) and the box preset's Background-Pro
 * gradient.data consume. EXACT mirror of PHP FW_Site_Converter_Mapper::parse_linear_gradient(), shared by the
 * button (to-theme-settings.mjs) and box builders so both twins emit identical presets. Directionless default =
 * 180deg (to bottom); "to X" mapped; a stop's position defaults to its even spread. null unless >= 2 stops.
 */
export const parseLinearGradient = (css) => {
  css = String(css || '').trim();
  // A MULTI-LAYER stack (a radial glow OVER a linear wash) is not "a linear gradient": the native field holds one
  // layer, so the caller carries the whole value verbatim instead of keeping only the linear layer. PHP parity.
  if ((css.match(/[a-z-]*gradient\(/gi) || []).length > 1) return null;
  const gm = css.match(/linear-gradient\(\s*([\s\S]+)\)\s*$/i);
  if (!gm) return null;
  const parts = []; let buf = '', depth = 0;
  for (const ch of gm[1]) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf !== '') parts.push(buf.trim());
  let angle = 180; let am;
  if (parts[0] && (am = parts[0].match(/^(-?[0-9.]+)deg$/))) { angle = parseFloat(am[1]); parts.shift(); }
  else if (parts[0] && /^to\s/i.test(parts[0])) {
    const dir = parts[0].slice(3).trim().toLowerCase();
    const map = { top: 0, right: 90, bottom: 180, left: 270, 'top right': 45, 'bottom right': 135, 'bottom left': 225, 'top left': 315 };
    angle = (map[dir] != null) ? map[dir] : 90; parts.shift();
  }
  const stops = []; const count = parts.length;
  parts.forEach((part, idx) => {
    const pm = part.match(/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))\s*([0-9.]+)?%?/);
    if (!pm) return;
    const pos = (pm[2] !== undefined && pm[2] !== '') ? parseFloat(pm[2]) : (count > 1 ? Math.round(idx * 100 / (count - 1)) : 0);
    stops.push({ color: pm[1], position: pos });
  });
  return stops.length >= 2 ? { type: 'linear', angle, stops } : null;
};
// A box's linear-gradient fill (background-image), '' when none. A gradient card has a TRANSPARENT background-color,
// so without this it read as "no fill" and was dropped / never became a Box Preset. Parity with PHP box_slug().
const gradOf = (b) => { const g = String((b && b.gradient) || '').trim(); return /linear-gradient\(/i.test(g) ? g : ''; };
// A NON-LINEAR fill (a radial / conic gradient, or several layers): no native gradient field (Background-Pro is
// linear-only) → the preset CSS carries it verbatim (a radial ring keeps its fill). Parity with PHP $reg_grad.
const rawGradOf = (b) => { const g = String((b && b.gradient) || '').trim(); return (g && /gradient\(/i.test(g) && !parseLinearGradient(g) && /^[a-z0-9()%.,\s#-]+$/i.test(g)) ? g : ''; };
const _sh = (y, blur, alpha) => ({ x: 0, y, blur, spread: 0, color: 'rgba(0,0,0,' + alpha + ')', inset: false });
const _pad = (all) => ({
  margin: { all: '', top: '', right: '', bottom: '', left: '' },
  padding: { all: String(all || ''), top: '', right: '', bottom: '', left: '' },
});
// A COMPUTED padding string ("16px 24px" / "32px") → the padding option shape, so a captured card's inner
// padding is REPRODUCED on the Box Preset instead of dropped (the converted card kept the shortcode default
// padding). Uniform → `all`; asymmetric → per-side. Values ride as arbitrary spacing tokens (`[24px]`).
const _padFromCss = (p) => {
  const parts = String(p || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.every((x) => x === '0px' || x === '0')) return _pad('');
  const tok = (v) => (/^[0-9.]+(px|rem|em|%)$/.test(v) ? '[' + v + ']' : v);
  let t, r, b, l;
  if (parts.length === 1) { t = r = b = l = parts[0]; }
  else if (parts.length === 2) { t = b = parts[0]; r = l = parts[1]; }
  else if (parts.length === 3) { t = parts[0]; r = l = parts[1]; b = parts[2]; }
  else { [t, r, b, l] = parts; }
  const m = { all: '', top: '', right: '', bottom: '', left: '' };
  if (t === r && r === b && b === l) return { margin: m, padding: { all: tok(t), top: '', right: '', bottom: '', left: '' } };
  return { margin: m, padding: { all: '', top: tok(t), right: tok(r), bottom: tok(b), left: tok(l) } };
};

export const DEFAULT_BORDER_PRESETS = [
  { id: 'b000000001', preset_name: 'Card', border_sides: 'all', border_radius: _u(8), padding: _pad('p-4'), transition: '200', hover_fx: ['lift'], custom_css: '',
    states: { default: { border_style: 'solid', border_width: _u(1), border_color: _col('light-gray'), box_shadow: _sh(1, 3, '0.08') }, hover: { box_shadow: _sh(8, 20, '0.12') } } },
  { id: 'b000000002', preset_name: 'Outline', border_sides: 'all', border_radius: _u(6), padding: _pad('p-4'), transition: '200', custom_css: '',
    states: { default: { border_style: 'solid', border_width: _u(2), border_color: _col('primary') }, hover: { border_color: _col('indigo') } } },
  { id: 'b000000003', preset_name: 'Soft Shadow', border_sides: 'all', border_radius: _u(12), padding: _pad('p-4'), transition: '250', custom_css: '',
    states: { default: { border_style: '', border_color: _empty, box_shadow: _sh(4, 14, '0.08') }, hover: { box_shadow: _sh(12, 30, '0.16') } } },
  { id: 'b000000004', preset_name: 'Hover Lift', border_sides: 'all', border_radius: _u(8), padding: _pad('p-4'), transition: '200', hover_fx: ['lift', 'glow'], custom_css: '',
    states: { default: { border_style: 'solid', border_width: _u(1), border_color: _col('light-gray') }, hover: { border_color: _col('primary'), box_shadow: _sh(10, 24, '0.14') } } },
  // Hover Grow — grows on hover via the SHARED Hover Animations library (hover_animation = the built-in Grow).
  { id: 'b000000005', preset_name: 'Hover Grow', border_sides: 'all', border_radius: _u(12), padding: _pad('p-4'), transition: '200', hover_animation: 'btnfx-grow', custom_css: '',
    states: { default: { border_style: 'solid', border_width: _u(1), border_color: _col('light-gray'), box_shadow: _sh(2, 8, '0.06') }, hover: { border_color: _col('primary') } } },
];

// The plugin's built-in Icon Badge presets — mirror of unysonplus_default_icon_badge_presets()
// (framework/includes/presets/icon-badge-presets.php). The presets importer REPLACES the
// `icon_badge_presets` option, so the emitted value must be defaults + derived or the built-in
// library (Circle / Soft Tile / Outline Ring / Hexagon) is lost.
const _fill   = (hex) => ({ color: { value: { predefined: '', custom: String(hex) } } });
const _nofill = { color: { value: { predefined: '', custom: '' } } };

export const DEFAULT_ICON_BADGE_PRESETS = [
  { id: 'i000000001', preset_name: 'Circle', badge_shape: 'circle', badge_size: _u(48), icon_size: _u(24), border_radius: _u(''), transition: '200', hover_fx: ['lift', 'glow'], custom_css: '',
    states: { default: { background: _fill('#0d6efd'), icon_color: _col('white'), border_style: '', border_color: _empty, box_shadow: _sh(4, 12, '0.15') }, hover: { box_shadow: _sh(8, 20, '0.22') } } },
  { id: 'i000000002', preset_name: 'Soft Tile', badge_shape: 'rounded', badge_size: _u(52), icon_size: _u(26), border_radius: _u(14), transition: '200', hover_fx: ['pop'], custom_css: '',
    states: { default: { background: _fill('#eef2ff'), icon_color: _col('primary'), border_style: '', border_color: _empty }, hover: { background: _fill('#e0e7ff') } } },
  { id: 'i000000003', preset_name: 'Outline Ring', badge_shape: 'circle', badge_size: _u(48), icon_size: _u(22), border_radius: _u(''), transition: '200', hover_fx: [], custom_css: '',
    states: { default: { background: _nofill, icon_color: _col('primary'), border_style: 'solid', border_width: _u(2), border_color: _col('primary') }, hover: { background: _fill('#0d6efd'), icon_color: _col('white') } } },
  { id: 'i000000004', preset_name: 'Hexagon', badge_shape: 'hexagon', badge_size: _u(54), icon_size: _u(26), border_radius: _u(''), transition: '200', hover_fx: ['glow'], custom_css: '',
    states: { default: { background: _fill('#6610f2'), icon_color: _col('white'), border_style: '', border_color: _empty }, hover: {} } },
];

// capture-extract stamps badge shape as 'solid-circle' / 'solid-rounded' / 'solid-square'; the
// store wants the plugin token 'circle' / 'rounded' / 'square'. Mirror PHP's shape derivation.
const badgeShape = (s) => {
  s = String(s || '').toLowerCase();
  if (s.includes('circle')) return 'circle';
  if (s.includes('square')) return 'square';
  if (s.includes('round')) return 'rounded';
  return 'rounded';
};

/**
 * Derive Icon Badge presets (Theme Settings → Components → Icon Badges = `icon_badge_presets`) from
 * the captured icon-tile SKINS — the JS counterpart of PHP
 * `FW_Site_Converter_Stitch::build_icon_badge_presets()`. Where the PHP path walks the DOM and
 * compiles Tailwind, the JS path already has each badge's RESOLVED values (from capture-extract's
 * badge probe), so it clusters those directly. Clusters the DISTINCT tile designs (shape · fill ·
 * radius · border — NOT glyph colour, matching PHP), keeps the top few, and appends them (named by
 * shape) to the plugin defaults, yielding the same shape PHP emits. Only returns presets when the
 * source actually HAS icon tiles; otherwise [] (so the importer keeps the default library).
 *
 * @param {Array<{shape,fill,iconColor,size,radius,borderWidth,borderColor}>} skins
 * @returns {Array}  defaults + derived, or [] when no real icon tiles were found.
 */
export function buildIconBadgePresets(skins) {
  const tiles = [];
  for (const s of skins || []) {
    if (!s) continue;
    const bg = normColor(s.fill);
    const bwStr = String(s.borderWidth || '').trim();
    const bw = (unitOf(bwStr) && !['0', '0px', ''].includes(bwStr)) ? bwStr : '';
    // A badge tile needs a visible surface — a fill or a ring; a bare radius is not one.
    if (!bg && !bw) continue;
    const size = (s.size != null && isFinite(+s.size) && +s.size > 0) ? Math.round(+s.size) : 0;
    // Badge tiles are small squares — skip anything clearly a full card / section.
    if (size && (size < 24 || size > 120)) continue;
    const shape = badgeShape(s.shape);
    const radius = (shape === 'rounded' && unitOf(s.radius)) ? String(s.radius).trim() : '';
    tiles.push({ shape, size, radius, bg, bw, bdcol: normColor(s.borderColor), icol: normColor(s.iconColor) });
  }
  if (!tiles.length) return [];

  // Cluster the distinct tile designs; keep the most common few (PHP slices 4).
  const groups = new Map();
  for (const t of tiles) {
    const key = t.shape + '|' + t.bg + '|' + t.radius.replace(/\s+/g, '') + '|' + t.bw + t.bdcol;
    if (!groups.has(key)) groups.set(key, { ...t, count: 0 });
    groups.get(key).count++;
  }
  const ordered = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 4);

  const used = {}; const derived = []; let n = 0;
  for (const g of ordered) {
    let base = g.shape === 'circle' ? 'Circle' : (g.shape === 'rounded' ? 'Rounded Tile' : 'Square');
    if (!g.bg && g.bw) base = g.shape === 'circle' ? 'Outline Ring' : 'Outline Tile';
    used[base] = (used[base] || 0) + 1;
    const name = used[base] > 1 ? base + ' ' + used[base] : base;

    const size = g.size > 0 ? g.size : 48;
    const iconSize = Math.round(size * 0.5);
    const def = {
      background:   g.bg ? _fill(g.bg) : _nofill,
      icon_color:   g.icol ? { predefined: '', custom: g.icol } : _empty,
      border_style: g.bw ? 'solid' : '',
      border_color: (g.bw && g.bdcol) ? { predefined: '', custom: g.bdcol } : _empty,
    };
    if (g.bw) { const bwu = unitOf(g.bw); if (bwu) def.border_width = bwu; }

    derived.push({
      id: 'i' + String(100 + (++n)).padStart(9, '0'),
      preset_name: name,
      badge_shape: g.shape,
      badge_size: _u(size),
      icon_size: _u(iconSize),
      border_radius: (g.shape === 'rounded' && unitOf(g.radius)) ? unitOf(g.radius) : _u('', 'px'),
      transition: '200',
      hover_fx: [],
      custom_css: '',
      states: { default: def, hover: {} },
    });
  }
  if (!derived.length) return [];
  return DEFAULT_ICON_BADGE_PRESETS.concat(derived);
}

// "32px" → { value:'32', unit:'px' }; '' → null.
const unitOf = (v) => {
  const m = String(v || '').trim().match(/^(-?[0-9.]+)\s*(px|rem|em|%)?$/);
  return m ? { value: m[1], unit: m[2] || 'px' } : null;
};

// A computed color → a clean rgb()/rgba(), or '' for transparent.
const _csrgb = (c) => { const cm = String(c || '').trim().match(/^color\(\s*(srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020)\s+([0-9.]+%?)\s+([0-9.]+%?)\s+([0-9.]+%?)(?:\s*\/\s*([0-9.]+%?))?\s*\)$/i); if (!cm) return null; const ch = (v) => { const f = /%$/.test(v) ? parseFloat(v) / 100 : parseFloat(v); return Math.max(0, Math.min(1, f)); }; let r = ch(cm[2]), g = ch(cm[3]), b = ch(cm[4]); if (cm[1] === 'srgb-linear') { const gam = (x) => x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; r = gam(r); g = gam(g); b = gam(b); } const a = cm[5] == null ? 1 : (/%$/.test(cm[5]) ? parseFloat(cm[5]) / 100 : parseFloat(cm[5])); return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a]; };
const normColor = (c) => {
  c = String(c || '').trim().toLowerCase();
  let m;
  { const cs = _csrgb(c); if (cs) { if (cs[3] === 0) return ''; return cs[3] < 1 ? 'rgba(' + cs[0] + ', ' + cs[1] + ', ' + cs[2] + ', ' + cs[3] + ')' : 'rgb(' + cs[0] + ', ' + cs[1] + ', ' + cs[2] + ')'; } } // color(srgb …) (PHP: color_to_hex)
  if ((m = c.match(/rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)(?:[,\s/]+([0-9.]+))?/))) {
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (a === 0) return '';
    return a < 1 ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})` : `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
  }
  if ((m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/))) {
    let h = m[1]; if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
  }
  return '';
};

// Parse the FIRST layer of a computed box-shadow ("rgba(…) 0px 1px 3px 0px") → { x,y,blur,spread,color,inset }.
// The VISIBLE layers of a (possibly multi-layer) box-shadow, split on top-level commas — each
// { x, y, blur, spread, color, inset, raw }; transparent and all-zero layers are dropped. PHP: $shadow_layers.
const shadowLayersOf = (s) => {
  s = String(s || '').trim();
  if (!s || s.toLowerCase() === 'none') return [];
  let depth = 0, layer = '', layers = [];
  for (const ch of s) { if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === ',' && depth === 0) { layers.push(layer.trim()); layer = ''; continue; } layer += ch; }
  if (layer.trim()) layers.push(layer.trim());
  const out = [];
  for (const raw of layers) {
    const inset = /inset/i.test(raw);
    let rest = raw.replace(/inset/ig, '').trim();
    let color = '';
    const cm = rest.match(/(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})/);
    if (cm) { color = normColor(cm[1]); rest = rest.replace(cm[1], ''); }
    if (!color) continue; // transparent layer
    const nums = (rest.match(/-?[0-9.]+/g) || []).map(Number);
    if (!nums.some((n) => n !== 0)) continue; // a 0 0 0 0 layer is no shadow
    out.push({ x: Math.round(nums[0] || 0), y: Math.round(nums[1] || 0), blur: Math.round(nums[2] || 0), spread: Math.round(nums[3] || 0), color, inset, raw });
  }
  return out;
};
// The native Box Shadow field holds ONE layer: the MOST VISIBLE — a non-inset drop over an inset highlight,
// then the widest blur. (The first layer of `inset 0 1px 0 …, 0 22px 60px …` was only the 1px highlight.)
const parseShadow = (s) => {
  const c = shadowLayersOf(s);
  if (!c.length) return null;
  c.sort((p, q) => (p.inset !== q.inset) ? (p.inset ? 1 : -1) : ((q.blur + q.spread) - (p.blur + p.spread)));
  const { raw, ...best } = c[0];
  return best;
};
// The FULL multi-layer shadow (>= 2 visible layers) as a preset-CSS rule; '' for a single layer (the native
// field carries it exactly). Native first, the rest advanced — the button-preset rule. PHP: $shadow_css.
const shadowCss = (s) => {
  const c = shadowLayersOf(s);
  if (c.length < 2) return '';
  const full = c.map((l) => l.raw).join(', ');
  // !important: the preset's native state rule is !important too; this lands later in source order, so it wins.
  return /^[a-z0-9()%.,\s#-]+$/i.test(full) ? '{{SELECTOR}}{box-shadow:' + full + ' !important;}' : '';
};

// The most visible box-shadow layer's raw text (for the skin signature / the derived preset).
const firstRealShadow = (s) => {
  const c = shadowLayersOf(s);
  if (!c.length) return '';
  c.sort((p, q) => (p.inset !== q.inset) ? (p.inset ? 1 : -1) : ((q.blur + q.spread) - (p.blur + p.spread)));
  return c[0].raw;
};

// A box qualifies as a "skin" if it has ANY of fill / radius / shadow / border / backdrop. The full skin
// (FILL included) is the cluster key so a red-tint and a green-tint card don't merge. Mirror of PHP.
const realBw = (v) => { const s = String(v || '').trim(); return (unitOf(s) && !['0', '0px', '0.0px'].includes(s)) ? s : ''; };
const skinSig = (b) => {
  const fill = normColor(b.fill || b.bg);
  const radius = (unitOf(b.radius) || /^[0-9.]+(?:px|rem|em|%)?(?:\s+[0-9.]+(?:px|rem|em|%)?){1,3}$/.test(String(b.radius || '').trim())) ? String(b.radius).trim() : '';
  const shadow = firstRealShadow(b.shadow).replace(/\s+/g, '');
  const bw = realBw(b.borderWidth);
  const backdrop = (b.backdrop && String(b.backdrop).toLowerCase() !== 'none') ? String(b.backdrop).replace(/\s+/g, '') : '';
  const grad = (gradOf(b) || rawGradOf(b)).replace(/\s+/g, '');
  if (!fill && !radius && !shadow && !bw && !backdrop && !grad) return null;
  const bdcol = bw ? normColor(b.borderColor) : ''; // border colour only counts with a real border width
  const pad = String(b.padding || '').trim(); // the card's inner padding rides IN the preset, so it keys the skin too
  const clip = b.clip ? '|clip' : ''; // a media frame (clips to its radius) is a distinct preset from the same skin on a text card
  const sides = (b.sides && b.sides !== 'all') ? '|' + b.sides : ''; // a one-sided hairline (a footer row's top rule) is its own preset
  // The long-tail EXTRA props and a lift / border / shadow HOVER key the skin too (a card that only lifts on hover, or
  // carries an opacity / accent bar, is a DIFFERENT preset); only appended when set, so every existing key stays stable.
  const extra = String(b.extra || '').trim() ? '|x:' + String(b.extra).replace(/\s+/g, '') : '';
  const hv = (b.hover && typeof b.hover === 'object') ? b.hover : {};
  const hovKey = ((hv.lift || b.hoverLift) ? '|lift' : '') + (hv.scale ? '|sc:' + hv.scale : '') + (hv.fill ? '|hf:' + normColor(hv.fill) : '') + (hv.bdcol ? '|hbd:' + normColor(hv.bdcol) : '') + (hv.shadow ? '|hsh:' + String(hv.shadow).replace(/\s+/g, '') : '');
  const st = String(b.hov || '').trim() ? '|st:' + String(b.hov).length + ':' + String(b.hov).slice(0, 40).replace(/\s+/g, '') : ''; // distinct captured STATES → a distinct preset (PHP: box_slug st:)
  return fill + '|' + radius + '|' + shadow + '|' + bw + '|' + bdcol + '|' + backdrop + (grad ? '|' + grad : '') + (pad ? '|' + pad : '') + clip + sides + extra + hovKey + st;
};

/**
 * Cluster the page's box skins into Box Presets.
 * @param {Array<{radius,shadow,borderWidth,borderStyle,borderColor,hoverLift}>} skins
 * @returns {{ presets: Array, boxpFor: (box)=>string }}  presets = defaults + derived;
 *          boxpFor(box) → 'boxp-{id}' for a box whose skin matched a derived preset, else ''.
 */
export function buildBorderPresets(skins) {
  const groups = new Map();
  for (const b of skins || []) {
    const sig = skinSig(b || {});
    if (!sig) continue;
    if (!groups.has(sig)) groups.set(sig, { box: b, count: 0 });
    groups.get(sig).count++;
  }
  if (!groups.size) return { presets: DEFAULT_BORDER_PRESETS.slice(), boxpFor: () => '' };

  // Background-Pro fill: the solid colour, plus the gradient on gradient.data when the box paints a
  // linear-gradient (mirror of the PHP stitch $fill_val — a gradient card is a REAL Box Preset, never scoped CSS).
  const fillVal = (rgba, gradient = '') => {
    const bg = { color: { value: { predefined: '', custom: rgba || '' } } };
    const gv = gradient ? parseLinearGradient(gradient) : null;
    if (gv) bg.gradient = { data: gv };
    return bg;
  };
  const ordered = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 40); // PHP registers every distinct skin; 40 keeps a long showcase page whole
  const used = {}; const derived = []; const sigToId = new Map();
  let n = 0;
  for (const [sig, g] of ordered) {
    const b = g.box;
    const shadow = firstRealShadow(b.shadow);
    const hasShadow = !!shadow;
    const hasBorder = !!realBw(b.borderWidth);
    const hasFill = !!normColor(b.fill || b.bg) || !!gradOf(b);
    const hasGlass = !!(b.backdrop && String(b.backdrop).toLowerCase() !== 'none');
    const base = hasGlass ? 'Glass' : ((hasFill && hasBorder) ? 'Card' : (hasShadow ? 'Elevated' : (hasBorder ? 'Outline' : (hasFill ? 'Tinted' : 'Rounded'))));
    used[base] = (used[base] || 0) + 1;
    const name = used[base] > 1 ? base + ' ' + used[base] : base;

    // DEFAULT state: fill + border + shadow.
    const def = { background: fillVal(normColor(b.fill || b.bg), gradOf(b)) };
    if (hasBorder) {
      def.border_style = (b.borderStyle && b.borderStyle !== 'none') ? b.borderStyle : 'solid';
      def.border_width = unitOf(realBw(b.borderWidth));
      const bc = normColor(b.borderColor);
      def.border_color = bc ? { predefined: '', custom: bc } : _empty;
    }
    const sh = parseShadow(shadow);
    if (sh) def.box_shadow = sh;

    // HOVER state (no class dropped): fill / border / shadow / lift / scale.
    const hv = (b.hover && typeof b.hover === 'object') ? b.hover : {};
    const hover = {};
    if (normColor(hv.fill)) hover.background = fillVal(normColor(hv.fill));
    if (normColor(hv.bdcol)) hover.border_color = { predefined: '', custom: normColor(hv.bdcol) };
    const hsh = parseShadow(firstRealShadow(hv.shadow));
    if (hsh) hover.box_shadow = hsh;
    // The card's captured hover MOTION → the SHARED Hover Animations library (the same native effects a button
    // gets): a grow → Grow; a lift → Lift — with the buttons' FIDELITY GUARD: the cloned Lift forces a hover
    // drop-shadow, so a card that keeps its own resting shadow with no hover shadow change keeps the plain
    // hover_fx lift (bare translateY) instead. Parity with the PHP stitch.
    let hoverAnimation = '';
    if (hv.scale && parseFloat(hv.scale) > 1) hoverAnimation = 'btnfx-grow';
    else if (hv.lift || b.hoverLift) { const restSh = String(shadow || '').trim(); const hasRest = restSh && restSh.toLowerCase() !== 'none' && /[1-9]/.test(restSh); if (hsh || !hasRest) hoverAnimation = 'btnfx-lift'; }
    const hoverFx = [];
    if ((hv.lift || b.hoverLift) && hoverAnimation !== 'btnfx-lift') hoverFx.push('lift');
    if (hv.shadow || hsh) hoverFx.push('glow');

    let ccss = '';
    // The card's inner padding (1–4 value shorthand, e.g. a `22px 26px` callout) → the preset's own custom_css,
    // exact source px, no !important so a column's own Padding can still override it. Parity with PHP.
    const padPx = String(b.padding || '').trim();
    if (/^[0-9.]+px(?:\s+[0-9.]+px){0,3}$/.test(padPx)) ccss += `{{SELECTOR}}{padding:${padPx};box-sizing:border-box;}`;
    if (hasGlass) ccss += `{{SELECTOR}}{backdrop-filter:${b.backdrop};-webkit-backdrop-filter:${b.backdrop};}`;
    // MEDIA FRAME — a rounded box around an image / video clips its content to the radius (the source's
    // overflow:hidden); no native field, so it rides in the preset CSS. Parity with PHP build_box_presets.
    if (b.clip) ccss += '{{SELECTOR}}{overflow:hidden;}';
    // a PER-CORNER radius (`20px 20px 0px 0px`) has no single-value field → the preset CSS carries it (PHP: reg_rad)
    { const rr = String(b.radius || '').trim(); if (rr && !unitOf(rr) && /^[0-9.]+(?:px|rem|em|%)?(?:\s+[0-9.]+(?:px|rem|em|%)?){1,3}$/.test(rr)) ccss += '{{SELECTOR}}{border-radius:' + rr + ';}'; }
    // The long tail of box-level visual props (capture-extract boxExtraOf: opacity / filter / clip / mask / blend /
    // outline / side border / border-image / bg geometry / transforms / sticky) → the preset's own CSS. PHP parity.
    { const ex = String(b.extra || '').trim(); if (ex && /^[a-z0-9()%.,:;\s#\/+!-]+$/i.test(ex)) ccss += '{{SELECTOR}}{' + ex + ';}'; } // (`!important` allowed: a side colour must outrank the preset's own border rule)
    // MULTI-LAYER shadow (an inset highlight + a drop): the native field holds the most visible layer; the full
    // value rides in the preset CSS so the card keeps both. Parity with PHP $shadow_css.
    ccss += shadowCss(b.shadow);
    if (rawGradOf(b)) ccss += '{{SELECTOR}}{background-image:' + rawGradOf(b) + ';}';
    if (hv.scale && hoverAnimation !== 'btnfx-grow') ccss += `{{SELECTOR}}:hover{transform:scale(${hv.scale});}`;
    // EVERY captured state (::before / ::after, their hover state, :hover extras, :active, :focus*, a hover-revealed
    // descendant, the @keyframes) → the preset CSS; the native hover fields keep the fill / border / shadow (PHP parity)
    { const sc = stateCss(b.hov, b.kf, !!b.pseudoOwned, ['background-color', 'background', 'border-color', 'box-shadow']); if (sc) ccss += '\n' + sc; }

    const id = 'b' + String(100 + (++n)).padStart(9, '0');
    sigToId.set(sig, id);
    const states = { default: def };
    if (Object.keys(hover).length) states.hover = hover;
    derived.push({
      id, preset_name: name, border_sides: (b.sides && b.sides !== 'all') ? String(b.sides) : 'all', // a one-sided hairline keeps its side (PHP parity)
      border_radius: unitOf(b.radius) || _u('', 'px'),
      padding: _padFromCss(b.padding),
      transition: '200',
      hover_animation: hoverAnimation, // the shared library's native effect (Lift / Grow), when the source's hover is one
      hover_fx: [...new Set(hoverFx)],
      custom_css: ccss,
      states,
    });
  }

  // Site presets go ON TOP of the defaults (the converted design system is primary). css-tokens keys the
  // `.boxp-{slug}` rules — and box_style/border_preset — by a FRIENDLY slug from preset_name (deduped in
  // order across the whole list). Mirror unysonplus_border_preset_slug_map() so references point at a real rule.
  const presets = derived.concat(DEFAULT_BORDER_PRESETS);
  // sigToId + a slug rebuilder are returned so a caller (e.g. the local-AI naming pass) can RENAME the
  // presets and then recompute the box_style/border_preset references against the new slugs.
  return {
    presets,
    sigToId,
    derived,
    boxpFor: boxpForFrom(sigToId, presets),
  };
}

/** The friendly slug map (id → slug), deduped in order across the whole preset list — mirror of
 *  unysonplus_border_preset_slug_map(). Recompute after any rename so references stay valid. */
export function boxSlugMap(presets) {
  const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const seen = {}; const idToSlug = {};
  for (const p of (presets || [])) {
    let slug = slugify(p.preset_name) || p.id; const base = slug; let k = 1;
    while (seen[slug]) { k++; slug = base + '-' + k; }
    seen[slug] = true; idToSlug[p.id] = slug;
  }
  return idToSlug;
}

/** A `boxpFor(box) → 'boxp-<slug>'|''` closure over a sig→id map + the (possibly renamed) preset list. */
export function boxpForFrom(sigToId, presets) {
  const idToSlug = boxSlugMap(presets);
  return (box) => { const s = skinSig(box || {}); const id = s && sigToId.get(s); return (id && idToSlug[id]) ? 'boxp-' + idToSlug[id] : ''; };
}

export { skinSig };
