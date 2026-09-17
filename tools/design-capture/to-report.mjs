// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Conversion report (NO AI). Turns the deterministic converter's per-section/per-element
// decision trace (collected by to-pages.mjs's opts.trace) into:
//   • conversion-report.csv  — one row per source element, flat + denormalized, so a batch of
//                              these from many captured sites can be concatenated and analyzed
//                              to find systematic conversion failures and harden the heuristics.
//   • conversion-report.html — a self-contained, dependency-free page to eyeball one site;
//                              click any element row to expand its full text + source HTML.
//
// Signals that matter for "making the engine smarter":
//   1. fallback        — element became a verbatim `code_block` (the catch-all = engine gave up).
//   2. opportunity     — the extractor DETECTED a richer role (card / counter / testimonials) that
//                        to-pages didn't map to a dedicated shortcode yet.
//   3. styling drop    — section styles (border/shadow/radius/gradient) `computed` doesn't carry.
//   4. over-large / under-segmented — a section much taller than the viewport almost certainly
//                        contains multiple visual bands the detector merged into one (the
//                        classic SPA problem: the site uses few <section> tags). Across a batch
//                        this quantifies which sites need structural band-splitting.

const OVERLARGE_PX = 2200; // a section taller than ~2.5 viewports likely holds multiple bands

const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const htmlEsc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSV_HEADER = [
  'site', 'page', 's_index', 's_decision', 's_class', 's_height', 's_over_large',
  's_styling_drop', 's_dropped_styles',
  'role', 'detected', 'mapped', 'fallback', 'opportunity', 'why', 'src_tag', 'src_class', 'text',
];

export function toReport(input) {
  const site = (input && input.url) || '';
  const generated = (input && input.generated) || '';
  const rows = [CSV_HEADER];
  const stats = {
    sections: 0, elements: 0, fallbacks: 0, opportunities: 0, stylingDrops: 0, overLargeSections: 0,
    shortcodes: {}, roles: {}, decisions: {},
  };
  const pagesOut = [];
  const droppedOf = (s) => Object.entries((s && s.diag) || {}).map(([k, v]) => `${k}=${v}`);

  for (const pg of (input.pages || [])) {
    const trace = pg.trace || [];
    const secRecs = trace.filter((t) => t.kind === 'section');
    const elRecs = trace.filter((t) => t.kind === 'element');
    const secByIdx = {};
    secRecs.forEach((s) => {
      secByIdx[s.sIndex] = s;
      stats.decisions[s.decision] = (stats.decisions[s.decision] || 0) + 1;
      if (droppedOf(s).length) stats.stylingDrops++;
      if ((s.height || 0) > OVERLARGE_PX) stats.overLargeSections++;
    });
    stats.sections += secRecs.length;

    const pageEls = [];
    for (const e of elRecs) {
      const s = secByIdx[e.sIndex] || {};
      const dropped = droppedOf(s);
      const overLarge = (s.height || 0) > OVERLARGE_PX;
      stats.elements++;
      if (e.fallback) stats.fallbacks++;
      if (e.opportunity) stats.opportunities++;
      stats.shortcodes[e.shortcode] = (stats.shortcodes[e.shortcode] || 0) + 1;
      stats.roles[e.detected || e.role || '?'] = (stats.roles[e.detected || e.role || '?'] || 0) + 1;

      rows.push([
        site, pg.slug, e.sIndex, s.decision || '', s.sourceClass || '', s.height || 0, overLarge ? 'yes' : 'no',
        dropped.length ? 'yes' : 'no', dropped.join(' | '),
        e.role || '', e.detected || '', e.shortcode || '',
        e.fallback ? 'yes' : 'no', e.opportunity ? 'yes' : 'no',
        e.why || '', e.sourceTag || '', e.sourceClass || '', e.text || '',
      ]);
      pageEls.push({ ...e, sDecision: s.decision, sClass: s.sourceClass, sHeight: s.height || 0, overLarge, stylingDrop: dropped.length > 0 });
    }
    pagesOut.push({ slug: pg.slug, front: pg.front, sections: secRecs, elements: pageEls });
  }

  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const html = renderHtml({ site, generated, stats, pages: pagesOut });
  return { csv, html, stats };
}

const pill = (label, n, cls) => `<span class="pill ${cls || ''}">${htmlEsc(label)}<b>${n}</b></span>`;
const histo = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `<span class="chip">${htmlEsc(k)}<b>${v}</b></span>`).join('');

function renderHtml({ site, generated, stats, pages }) {
  const flagCell = (e) => {
    const f = [];
    if (e.fallback) f.push('<span class="tag t-fb">code_block</span>');
    if (e.opportunity) f.push('<span class="tag t-op">opportunity</span>');
    if (e.stylingDrop) f.push('<span class="tag t-sd">styling drop</span>');
    return f.join(' ') || '<span class="tag t-ok">ok</span>';
  };

  let rowId = 0;
  const sectionTables = pages.map((pg) => {
    const bySec = {};
    pg.elements.forEach((e) => { (bySec[e.sIndex] = bySec[e.sIndex] || []).push(e); });
    const secs = pg.sections.map((s) => {
      const els = bySec[s.sIndex] || [];
      const over = (s.height || 0) > OVERLARGE_PX;
      const dropped = Object.entries(s.diag || {}).map(([k, v]) => `${htmlEsc(k)}: ${htmlEsc(v)}`).join('<br>');
      const rowsHtml = els.map((e) => {
        const id = 'd' + (rowId++);
        const detail = `
          <tr class="det" id="${id}" hidden><td colspan="6"><div class="detbox">
            <div class="kv"><span>why</span>${htmlEsc(e.why || '')}</div>
            ${e.sourceClass ? `<div class="kv"><span>src class</span><code>${htmlEsc(e.sourceClass)}</code></div>` : ''}
            ${e.textFull ? `<div class="kv"><span>text</span>${htmlEsc(e.textFull)}</div>` : ''}
            ${e.html ? `<div class="kv"><span>source HTML</span></div><pre>${htmlEsc(e.html)}${e.html.length >= 1600 ? ' …(truncated)' : ''}</pre>` : ''}
          </div></td></tr>`;
        return `
          <tr class="el ${e.fallback ? 'r-fb' : ''}${e.opportunity ? ' r-op' : ''}">
            <td class="exp">▸</td>
            <td class="mono">${htmlEsc(e.role)}</td>
            <td class="mono">${htmlEsc(e.detected || '')}</td>
            <td class="mono">${htmlEsc(e.shortcode)}</td>
            <td>${flagCell(e)}</td>
            <td class="snip">${htmlEsc(e.text || '')}</td>
          </tr>${detail}`;
      }).join('');
      return `
        <div class="sec${over ? ' sec-over' : ''}">
          <h3>§${s.sIndex} <span class="dec dec-${htmlEsc(s.decision)}">${htmlEsc(s.decision)}</span>
            <span class="h">${s.height || 0}px</span>${over ? '<span class="tag t-ol">over-large</span>' : ''}
            <code>${htmlEsc(s.sourceClass || '(no class)')}</code></h3>
          ${over ? '<div class="warn">⚠ This section is taller than ~2.5 viewports — it likely contains several visual bands the detector merged into one (site uses few &lt;section&gt; tags).</div>' : ''}
          ${dropped ? `<div class="drop">⚠ Source styling not carried in <code>computed</code>:<br>${dropped}</div>` : ''}
          <table>
            <thead><tr><th></th><th>role</th><th>detected</th><th>mapped</th><th>flags</th><th>text (click row to expand)</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`;
    }).join('');
    return `<section class="page"><h2>Page: ${htmlEsc(pg.slug)}${pg.front ? ' (home)' : ''}</h2>${secs}</section>`;
  }).join('');

  const underSeg = stats.overLargeSections > 0
    ? `<div class="banner">⚠ <b>Likely under-segmentation:</b> ${stats.overLargeSections} section(s) are over-large (&gt; ${OVERLARGE_PX}px). The detector keys off <code>&lt;section&gt;</code> tags, so an SPA that wraps many visual bands in a few sections collapses them into giant sections. Each is currently treated as ONE section.</div>`
    : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conversion report — ${htmlEsc(site)}</title>
<style>
  :root { --ink:#16323c; --muted:#5a727c; --line:#e3edf1; --accent:#01729c; --fb:#b45309; --op:#2563eb; --sd:#b32d2e; --ol:#9333ea; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:#f7fafb; }
  header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 4px; font-size:20px; } header .src { color:var(--muted); word-break:break-all; }
  .gen { color:var(--muted); font-size:12px; margin-top:6px; }
  .wrap { padding:22px 28px; max-width:1180px; margin:0 auto; }
  .banner { background:#faf5ff; border:1px solid #e4d3f7; color:var(--ol); border-radius:10px; padding:12px 14px; margin-bottom:14px; font-size:13px; }
  .banner code, .warn code, .drop code { background:#0000000d; padding:1px 5px; border-radius:4px; }
  .cards { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:14px; }
  .pill { background:#fff; border:1px solid var(--line); border-radius:8px; padding:8px 12px; font-size:13px; color:var(--muted); }
  .pill b { margin-left:8px; color:var(--ink); font-size:16px; }
  .pill.fb b { color:var(--fb); } .pill.op b { color:var(--op); } .pill.sd b { color:var(--sd); } .pill.ol b { color:var(--ol); }
  .group { background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:16px; }
  .group h4 { margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .chip { display:inline-block; background:#eef5f8; border-radius:6px; padding:3px 9px; margin:0 6px 6px 0; font-size:12px; }
  .chip b { margin-left:6px; color:var(--accent); }
  .page h2 { font-size:16px; margin:18px 0 8px; }
  .sec { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:12px; }
  .sec-over { border-color:#e4d3f7; }
  .sec h3 { margin:0 0 8px; font-size:14px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .sec h3 .h { font-size:12px; color:var(--muted); font-family:ui-monospace,monospace; }
  .sec h3 code, .drop code { background:#f1f3f5; padding:1px 6px; border-radius:4px; font-size:12px; }
  .dec { font-size:11px; padding:1px 7px; border-radius:5px; border:1px solid currentColor; text-transform:uppercase; letter-spacing:.03em; }
  .dec-decomposed { color:var(--op); } .dec-verbatim { color:var(--fb); } .dec-carousel { color:var(--accent); } .dec-plain { color:var(--muted); }
  .warn { background:#faf5ff; border:1px solid #e4d3f7; color:var(--ol); border-radius:6px; padding:7px 10px; margin-bottom:8px; font-size:12px; }
  .drop { background:#fdf2f2; border:1px solid #f3c9c9; color:var(--sd); border-radius:6px; padding:7px 10px; margin-bottom:8px; font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--muted); font-weight:600; border-bottom:1px solid var(--line); padding:6px 8px; }
  td { border-bottom:1px solid #f0f4f6; padding:6px 8px; vertical-align:top; }
  tr.el { cursor:pointer; } tr.el:hover td { background:#f4fafc; }
  tr.r-fb td { background:#fffaf3; } tr.r-op td { background:#f5f9ff; }
  tr.el.open .exp { transform:rotate(90deg); }
  .exp { color:var(--muted); width:16px; transition:transform .12s; display:inline-block; }
  .mono { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; }
  .snip { color:var(--muted); max-width:420px; }
  .detbox { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:2px 0 8px; }
  .kv { font-size:12px; margin-bottom:6px; color:var(--ink); }
  .kv span { display:inline-block; min-width:84px; color:var(--muted); text-transform:uppercase; font-size:10px; letter-spacing:.04em; vertical-align:top; }
  .detbox pre { background:#0f2730; color:#d7e7ee; border-radius:6px; padding:10px; overflow:auto; max-height:320px; font-size:11.5px; white-space:pre-wrap; word-break:break-word; }
  .tag { font-size:11px; padding:1px 7px; border-radius:5px; white-space:nowrap; }
  .t-fb { background:#fef3e2; color:var(--fb); } .t-op { background:#e8f0ff; color:var(--op); }
  .t-sd { background:#fdeaea; color:var(--sd); } .t-ok { background:#eef5f8; color:var(--muted); }
  .t-ol { background:#f3e8ff; color:var(--ol); }
</style></head><body>
<header>
  <h1>Conversion report</h1>
  <div class="src">${htmlEsc(site)}</div>
  <div class="gen">${generated ? htmlEsc(generated) + ' · ' : ''}deterministic (no AI)</div>
</header>
<div class="wrap">
  ${underSeg}
  <div class="cards">
    ${pill('Sections', stats.sections)}
    ${pill('Elements', stats.elements)}
    ${pill('Fallback (code_block)', stats.fallbacks, 'fb')}
    ${pill('Opportunities', stats.opportunities, 'op')}
    ${pill('Styling drops', stats.stylingDrops, 'sd')}
    ${pill('Over-large sections', stats.overLargeSections, 'ol')}
  </div>
  <div class="group"><h4>Mapped shortcodes</h4>${histo(stats.shortcodes) || '<em>none</em>'}</div>
  <div class="group"><h4>Detected source roles</h4>${histo(stats.roles) || '<em>none</em>'}</div>
  <div class="group"><h4>Section decisions</h4>${histo(stats.decisions) || '<em>none</em>'}</div>
  ${sectionTables}
</div>
<script>
  document.addEventListener('click', function (e) {
    var tr = e.target.closest('tr.el'); if (!tr) return;
    var det = tr.nextElementSibling;
    if (det && det.classList.contains('det')) { det.hidden = !det.hidden; tr.classList.toggle('open'); }
  });
</script>
</body></html>`;
}
