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

// A box qualifies as a "skin" if it has ANY of radius / shadow / border-width.
const skinSig = (b) => {
  const radius = unitOf(b.radius) ? String(b.radius).trim() : '';
  const shadow = (b.shadow && String(b.shadow).toLowerCase() !== 'none') ? String(b.shadow).replace(/\s+/g, '') : '';
  const bw = unitOf(b.borderWidth) ? String(b.borderWidth).trim() : '';
  if (!radius && !shadow && !bw) return null;
  return radius + '|' + shadow + '|' + bw + '|' + normColor(b.borderColor);
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

  const ordered = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  const used = {}; const derived = []; const sigToId = new Map();
  let n = 0;
  for (const [sig, g] of ordered) {
    const b = g.box;
    const hasShadow = !!(b.shadow && String(b.shadow).toLowerCase() !== 'none');
    const hasBorder = !!unitOf(b.borderWidth);
    const base = (hasShadow && hasBorder) ? 'Card' : (hasShadow ? 'Elevated' : (hasBorder ? 'Outline' : 'Rounded'));
    used[base] = (used[base] || 0) + 1;
    const name = used[base] > 1 ? base + ' ' + used[base] : base;

    const def = {};
    if (hasBorder) {
      def.border_style = (b.borderStyle && b.borderStyle !== 'none') ? b.borderStyle : 'solid';
      def.border_width = unitOf(b.borderWidth);
      const bc = normColor(b.borderColor);
      def.border_color = bc ? { predefined: '', custom: bc } : _empty;
    }
    const sh = parseShadow(b.shadow);
    if (sh) def.box_shadow = sh;

    const id = 'b' + String(100 + (++n)).padStart(9, '0');
    sigToId.set(sig, id);
    derived.push({
      id, preset_name: name, border_sides: 'all',
      border_radius: unitOf(b.radius) || _u('', 'px'),
      padding: _pad(''),               // padding stays with the element (the plugin scale can't express 32px)
      transition: '200',
      hover_fx: b.hoverLift ? ['lift'] : [],
      custom_css: '',
      states: { default: def },
    });
  }

  // css-tokens keys the `.boxp-{slug}` rules — and the `box_style` value — by a FRIENDLY slug derived
  // from preset_name (deduped in order across the whole list), NOT the id. Mirror
  // unysonplus_border_preset_slug_map() so box_style points at the class css-tokens actually emits (else
  // the box gets `.boxp-b000000101` while the rule is `.boxp-outline-2` → no styling).
  const presets = DEFAULT_BORDER_PRESETS.concat(derived);
  const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const seenSlug = {}; const idToSlug = {};
  for (const p of presets) {
    let slug = slugify(p.preset_name) || p.id; const base = slug; let k = 1;
    while (seenSlug[slug]) { k++; slug = base + '-' + k; }
    seenSlug[slug] = true; idToSlug[p.id] = slug;
  }
  return {
    presets,
    boxpFor: (box) => { const s = skinSig(box || {}); const id = s && sigToId.get(s); return id && idToSlug[id] ? 'boxp-' + idToSlug[id] : ''; },
  };
}
