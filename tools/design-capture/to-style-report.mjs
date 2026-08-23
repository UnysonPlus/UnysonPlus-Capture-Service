// Style-coverage report (NO AI) — the CSS-fidelity training instrument.
//
// Content mapping asks "what shortcode does this element become" (discrete, measured by
// conversion-report). CSS fidelity asks "does the converted page LOOK like the source" — a
// different problem. This report measures the gap WITHOUT a WordPress import, using data the
// capture already collects:
//   • styleCensus  — per section, how many descendants use each fidelity-critical computed
//                    property (background-image, padding, max-width, position, shadow, …).
//   • sec.css      — the source CSS the converter actually carries (→ section custom_css).
// For each property a section USES, we check whether the carried CSS even declares it. A property
// that's used but never carried = DROPPED styling (the Tailwind/runtime-CSS fidelity loss).
//
//   • style-coverage.csv  — one row per (section, property): used count + carried? (batch-analyzable).
//   • style-coverage.html — per-property drop profile to eyeball one site.

const PROPS = [
  'background-image', 'background-color', 'backdrop-filter', 'box-shadow', 'border', 'border-radius', 'max-width',
  'padding', 'margin', 'gap', 'transform',
  'position-absolute', 'position-fixed', 'position-sticky', 'display-flex', 'display-grid',
];

// Fidelity-critical properties whose loss is almost always VISIBLE (a missing fill, frosted blur,
// border, shadow, or radius changes how an element reads). The coverage-verification pass weights
// these as significant by default; layout props (gap/margin/padding/display/position) are lower-signal.
const SIGNIFICANT = new Set([
  'background-image', 'background-color', 'backdrop-filter', 'box-shadow', 'border', 'border-radius',
]);

// Does the carried CSS declare this property at all? (coarse but telling — if the source uses
// background-image on 5 elements but sec.css never says "background-image:", it's dropped.)
function carries(css, prop) {
  css = String(css || '');
  if (!css.trim()) return false;
  if (prop.indexOf('position-') === 0) return /position\s*:/i.test(css);
  if (prop.indexOf('display-') === 0) return /display\s*:/i.test(css);
  if (prop === 'border') return /border(-(top|right|bottom|left))?(-width)?\s*:/i.test(css);
  if (prop === 'padding') return /padding(-(top|right|bottom|left))?\s*:/i.test(css);
  if (prop === 'margin') return /margin(-(top|right|bottom|left))?\s*:/i.test(css);
  // background-color is reproduced via the `background:` shorthand too; backdrop-filter via its -webkit- twin.
  if (prop === 'background-color') return /background(-color)?\s*:/i.test(css);
  if (prop === 'backdrop-filter') return /(-webkit-)?backdrop-filter\s*:/i.test(css);
  return new RegExp(prop.replace(/-/g, '\\-') + '\\s*:', 'i').test(css);
}

const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const htmlEsc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toStyleReport(input) {
  const site = (input && input.url) || '';
  const rows = [['site', 'page', 's_index', 's_class', 'property', 'src_uses', 'carried']];
  // per-property aggregate: { used: Σ element-uses, secUsing: #sections, secCarried: #sections-with-it-in-css }
  const agg = {};
  PROPS.forEach((p) => { agg[p] = { used: 0, secUsing: 0, secCarried: 0 }; });
  let sections = 0;
  // GAPS: (section, property) usages the carried CSS does NOT reproduce = dropped styling. The
  // coverage-verification pass (local AI) reviews these and flags the visually-significant ones.
  const gaps = [];

  for (const pg of (input.pages || [])) {
    for (const s of (pg.sections || [])) {
      sections++;
      const census = s.styleCensus || {};
      const css = s.css || '';
      for (const prop of PROPS) {
        const uses = census[prop] || 0;
        if (!uses) continue;
        const carried = carries(css, prop);
        agg[prop].used += uses;
        agg[prop].secUsing += 1;
        if (carried) agg[prop].secCarried += 1;
        else gaps.push({ page: pg.slug, s_index: s.index, s_class: s.sectionClass || '', property: prop, uses, significant: SIGNIFICANT.has(prop) });
        rows.push([site, pg.slug, s.index, s.sectionClass || '', prop, uses, carried ? 'yes' : 'no']);
      }
    }
  }

  // Fidelity score = % of (section,property) usages whose property is carried by the section's CSS.
  let usingTotal = 0, carriedTotal = 0;
  PROPS.forEach((p) => { usingTotal += agg[p].secUsing; carriedTotal += agg[p].secCarried; });
  const score = usingTotal ? Math.round((carriedTotal / usingTotal) * 100) : 100;

  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const html = renderHtml({ site, sections, agg, score });
  return { csv, html, gaps, stats: { sections, fidelityScore: score, props: agg } };
}

function renderHtml({ site, sections, agg, score }) {
  const ranked = PROPS.map((p) => ({ p, ...agg[p] }))
    .filter((r) => r.secUsing > 0)
    .map((r) => ({ ...r, dropped: r.secUsing - r.secCarried, cov: r.secUsing ? Math.round((r.secCarried / r.secUsing) * 100) : 100 }))
    .sort((a, b) => b.dropped - a.dropped || b.used - a.used);
  const rowsHtml = ranked.map((r) => `
    <tr class="${r.dropped > 0 ? 'drop' : ''}">
      <td class="mono">${htmlEsc(r.p)}</td>
      <td>${r.used}</td>
      <td>${r.secUsing}</td>
      <td>${r.secCarried}</td>
      <td><b>${r.dropped}</b></td>
      <td><span class="bar"><i style="width:${r.cov}%"></i></span> ${r.cov}%</td>
    </tr>`).join('');
  const scoreCls = score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Style coverage — ${htmlEsc(site)}</title>
<style>
  :root{--ink:#16323c;--muted:#5a727c;--line:#e3edf1;--accent:#01729c;--bad:#b32d2e;--mid:#b45309;--good:#1a7f37;}
  *{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:#f7fafb}
  header{padding:22px 28px;background:#fff;border-bottom:1px solid var(--line)}h1{margin:0 0 4px;font-size:20px}.src{color:var(--muted);word-break:break-all}
  .wrap{padding:22px 28px;max-width:980px;margin:0 auto}
  .score{display:inline-flex;align-items:center;gap:10px;font-size:13px;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:8px}
  .score b{font-size:22px}.score.good b{color:var(--good)}.score.mid b{color:var(--mid)}.score.bad b{color:var(--bad)}
  .note{color:var(--muted);font-size:12px;margin:6px 0 16px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th{text-align:left;color:var(--muted);font-weight:600;border-bottom:1px solid var(--line);padding:9px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
  td{border-bottom:1px solid #f0f4f6;padding:9px 12px}tr.drop td{background:#fdf6f2}
  .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
  tr.drop b{color:var(--bad)}
  .bar{display:inline-block;width:90px;height:8px;background:#eef3f5;border-radius:4px;vertical-align:middle;overflow:hidden}
  .bar i{display:block;height:100%;background:var(--accent)}
</style></head><body>
<header><h1>Style-coverage report</h1><div class="src">${htmlEsc(site)}</div></header>
<div class="wrap">
  <div class="score ${scoreCls}"><b>${score}%</b> CSS-fidelity coverage<span> · ${sections} sections</span></div>
  <p class="note">For each fidelity-critical property a section's source USES, is it declared in the CSS the converter carries (<code>sec.css</code>)? A high <b>dropped</b> count = styling that won't survive (typical of Tailwind/runtime-CSS sites). Coverage is a carried-vs-used proxy, not a pixel diff.</p>
  <table>
    <thead><tr><th>property</th><th>uses (elements)</th><th>sections using</th><th>sections carried</th><th>dropped</th><th>coverage</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="6"><em>no fidelity-critical styles detected</em></td></tr>'}</tbody>
  </table>
</div></body></html>`;
}
