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
const normColor = (c) => {
  c = String(c || '').trim().toLowerCase();
  let m;
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
const parseShadow = (s) => {
  s = String(s || '').trim();
  if (!s || s.toLowerCase() === 'none') return null;
  let depth = 0, first = '';
  for (const ch of s) { if (ch === '(') depth++; else if (ch === ')') depth--; else if (ch === ',' && depth === 0) break; first += ch; }
  first = first.trim();
  const inset = /inset/i.test(first);
  first = first.replace(/inset/ig, '').trim();
  let color = 'rgba(0, 0, 0, 0.1)';
  const cm = first.match(/(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})/);
  if (cm) { const nc = normColor(cm[1]); if (nc) color = nc; first = first.replace(cm[1], ''); }
  const nums = (first.match(/-?[0-9.]+/g) || []).map(Number);
  return { x: Math.round(nums[0] || 0), y: Math.round(nums[1] || 0), blur: Math.round(nums[2] || 0), spread: Math.round(nums[3] || 0), color, inset };
};

// First non-transparent box-shadow layer (a computed shadow often starts with a transparent placeholder).
const firstRealShadow = (s) => {
  s = String(s || '').trim();
  if (!s || s.toLowerCase() === 'none') return '';
  let depth = 0, layer = '', layers = [];
  for (const ch of s) { if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === ',' && depth === 0) { layers.push(layer.trim()); layer = ''; continue; } layer += ch; }
  if (layer.trim()) layers.push(layer.trim());
  for (const L of layers) { if (!/rgba\([^)]*,\s*0\s*\)/.test(L) && /[1-9]/.test(L)) return L; }
  return '';
};

// A box qualifies as a "skin" if it has ANY of fill / radius / shadow / border / backdrop. The full skin
// (FILL included) is the cluster key so a red-tint and a green-tint card don't merge. Mirror of PHP.
const realBw = (v) => { const s = String(v || '').trim(); return (unitOf(s) && !['0', '0px', '0.0px'].includes(s)) ? s : ''; };
const skinSig = (b) => {
  const fill = normColor(b.fill || b.bg);
  const radius = unitOf(b.radius) ? String(b.radius).trim() : '';
  const shadow = firstRealShadow(b.shadow).replace(/\s+/g, '');
  const bw = realBw(b.borderWidth);
  const backdrop = (b.backdrop && String(b.backdrop).toLowerCase() !== 'none') ? String(b.backdrop).replace(/\s+/g, '') : '';
  if (!fill && !radius && !shadow && !bw && !backdrop) return null;
  const bdcol = bw ? normColor(b.borderColor) : ''; // border colour only counts with a real border width
  return fill + '|' + radius + '|' + shadow + '|' + bw + '|' + bdcol + '|' + backdrop;
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

  const fillVal = (rgba) => ({ color: { value: { predefined: '', custom: rgba || '' } } });
  const ordered = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12);
  const used = {}; const derived = []; const sigToId = new Map();
  let n = 0;
  for (const [sig, g] of ordered) {
    const b = g.box;
    const shadow = firstRealShadow(b.shadow);
    const hasShadow = !!shadow;
    const hasBorder = !!realBw(b.borderWidth);
    const hasFill = !!normColor(b.fill || b.bg);
    const hasGlass = !!(b.backdrop && String(b.backdrop).toLowerCase() !== 'none');
    const base = hasGlass ? 'Glass' : ((hasFill && hasBorder) ? 'Card' : (hasShadow ? 'Elevated' : (hasBorder ? 'Outline' : (hasFill ? 'Tinted' : 'Rounded'))));
    used[base] = (used[base] || 0) + 1;
    const name = used[base] > 1 ? base + ' ' + used[base] : base;

    // DEFAULT state: fill + border + shadow.
    const def = { background: fillVal(normColor(b.fill || b.bg)) };
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
    const hoverFx = [];
    if (hv.lift || b.hoverLift) hoverFx.push('lift');
    if (hv.shadow || hsh) hoverFx.push('glow');

    let ccss = '';
    if (hasGlass) ccss += `{{SELECTOR}}{backdrop-filter:${b.backdrop};-webkit-backdrop-filter:${b.backdrop};}`;
    if (hv.scale) ccss += `{{SELECTOR}}:hover{transform:scale(${hv.scale});}`;

    const id = 'b' + String(100 + (++n)).padStart(9, '0');
    sigToId.set(sig, id);
    const states = { default: def };
    if (Object.keys(hover).length) states.hover = hover;
    derived.push({
      id, preset_name: name, border_sides: 'all',
      border_radius: unitOf(b.radius) || _u('', 'px'),
      padding: _padFromCss(b.padding),
      transition: '200',
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
