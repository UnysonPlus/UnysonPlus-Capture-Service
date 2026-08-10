/* UnysonPlus dashboard — SOURCE-side inspector.
 * Injected by the dashboard's /source-view?slug=… route into the captured SOURCE DOM
 * (rendered.html, where every element carries data-sc-cs="prop:val;…" + its original classes).
 * Mirrors the converted-side inspector protocol:
 *   - postMessage { type:'upw-inspect', height } to the parent so the dashboard sizes the iframe.
 *   - hover any element → outline overlay + tooltip showing tag, classes, and captured computed
 *     styles parsed from data-sc-cs (falling back to live getComputedStyle when absent).
 * Same-origin with the dashboard (served from localhost:4600), self-contained vanilla JS, no deps. */
(function () {
  if (window.__upwSrcInspector) return;
  window.__upwSrcInspector = true;

  var PROPS = ['font-size', 'font-weight', 'line-height', 'letter-spacing', 'color',
    'background-color', 'font-family', 'text-align', 'margin', 'padding',
    'border-radius', 'display', 'gap', 'justify-content', 'align-items', 'flex-direction'];

  /* ---- height reporting to the parent dashboard ---- */
  var lastH = 0;
  function postHeight() {
    try {
      // CONTENT height only — NOT documentElement.scrollHeight (for a short page that returns the iframe
      // VIEWPORT height, e.g. 5200, which re-inflated the box and left the big gap before the footer).
      var h = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.offsetHeight : 0
      );
      if (!h || Math.abs(h - lastH) < 2) return;
      lastH = h;
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'upw-inspect', height: h, side: 'source' }, '*');
      }
    } catch (e) { /* cross-origin parent — ignore */ }
  }

  /* ---- overlay + tooltip + style injection ---- */
  var overlay, tip, marker;
  function injectUI() {
    var st = document.createElement('style');
    st.id = 'upw-src-inspector-style';
    st.textContent =
      '#upw-src-overlay{position:fixed;pointer-events:none;z-index:2147483646;outline:2px solid #22d3a0;' +
      'background:rgba(34,211,160,.12);border-radius:2px;transition:all .04s linear;display:none}' +
      '#upw-src-tip{position:fixed;pointer-events:none;z-index:2147483647;max-width:340px;display:none;' +
      'background:#0f1720;color:#e7edf3;border:1px solid #2b3a47;border-radius:10px;padding:9px 11px;' +
      'font:12px/1.5 ui-monospace,"Cascadia Code",Menlo,Consolas,monospace;box-shadow:0 12px 40px rgba(0,0,0,.5)}' +
      '#upw-src-tip .t-tag{color:#22d3a0;font-weight:700;font-size:12.5px}' +
      '#upw-src-tip .t-h{color:#7f95a6;text-transform:uppercase;letter-spacing:.05em;font-size:10px;margin:7px 0 2px;font-weight:600}' +
      '#upw-src-tip .t-cls{color:#f0b866;word-break:break-word;white-space:normal}' +
      '#upw-src-tip .t-row{display:flex;gap:8px;line-height:1.45}' +
      '#upw-src-tip .t-k{color:#7f95a6;flex:0 0 auto;min-width:96px}' +
      '#upw-src-tip .t-v{color:#e7edf3;word-break:break-word}' +
      '#upw-src-tip .t-note{color:#7f95a6;font-style:italic;margin-top:6px;font-size:10.5px}' +
      // Neutralise the source's sticky-footer viewport-fill (min-height:100vh / flex column) so the footer
      // sits right after the content — otherwise, in the iframe, it floats to the bottom leaving a big gap.
      'html,body{min-height:0!important;height:auto!important}' +
      '#page,.site,#wrapper,.site-wrapper,#content,.site-content,#main,main,.site-main,.fw-page,' +
      '.content-area,.hfeed,#primary,.fw-main,.fw-body,.wrapper,.app,#app,#root,#__next{' +
      'min-height:0!important;height:auto!important;flex:0 1 auto!important}';
    (document.head || document.documentElement).appendChild(st);

    overlay = document.createElement('div'); overlay.id = 'upw-src-overlay';
    tip = document.createElement('div'); tip.id = 'upw-src-tip';
    (document.body || document.documentElement).appendChild(overlay);
    (document.body || document.documentElement).appendChild(tip);

    // Marker element so an automated harness can confirm the script ran.
    marker = document.createElement('div');
    marker.id = 'upw-src-inspector-marker';
    marker.setAttribute('data-ready', '1');
    marker.style.display = 'none';
    (document.body || document.documentElement).appendChild(marker);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  // Parse a data-sc-cs="prop:val;prop:val" attribute → ordered {prop,val} rows.
  function parseCs(cs) {
    var rows = [];
    String(cs).split(';').forEach(function (pair) {
      pair = pair.trim(); if (!pair) return;
      var i = pair.indexOf(':'); if (i < 0) return;
      var k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (!k || !v) return;
      if (k === 'background-color' && /transparent|rgba\(0,\s*0,\s*0,\s*0\)/i.test(v)) return; // skip transparent
      rows.push({ k: k, v: v });
    });
    return rows;
  }

  // Live fallback for elements without data-sc-cs.
  function liveCs(el) {
    var cs = getComputedStyle(el), rows = [];
    PROPS.forEach(function (p) {
      var v = cs.getPropertyValue(p); if (!v) return; v = v.trim(); if (!v) return;
      if (p === 'background-color' && /transparent|rgba\(0,\s*0,\s*0,\s*0\)/i.test(v)) return;
      rows.push({ k: p, v: v });
    });
    return rows;
  }

  function buildTip(el) {
    var rowsHtml = '';
    var raw = el.getAttribute && el.getAttribute('data-sc-cs');
    var note = '';
    var rows;
    if (raw) { rows = parseCs(raw); note = 'captured styles (data-sc-cs)'; }
    else { rows = liveCs(el); note = 'computed (live)'; }
    rows.forEach(function (r) {
      rowsHtml += '<div class="t-row"><span class="t-k">' + esc(r.k) + '</span><span class="t-v">' + esc(r.v) + '</span></div>';
    });
    var cls = (el.getAttribute && el.getAttribute('class')) || '';
    var html = '<div class="t-tag">&lt;' + esc((el.tagName || '').toLowerCase()) + '&gt;</div>';
    if (cls.trim()) { html += '<div class="t-h">Classes</div><div class="t-cls">' + esc(cls) + '</div>'; }
    html += '<div class="t-h">' + esc(note) + '</div>' + (rowsHtml || '<div class="t-row"><span class="t-v">(no style props)</span></div>');
    return html;
  }

  function positionTip(x, y) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = x + 16, top = y + 16;
    if (left + tw > vw - 8) left = x - tw - 16;
    if (left < 8) left = 8;
    if (top + th > vh - 8) top = y - th - 16;
    if (top < 8) top = 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function isInspectable(el) {
    if (!el || el.nodeType !== 1) return false;
    var id = el.id || '';
    if (id.indexOf('upw-src-') === 0) return false;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'html' || tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta') return false;
    return true;
  }

  var pending = null, rafId = 0;
  function onMove(e) {
    pending = { x: e.clientX, y: e.clientY, el: e.target };
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      var p = pending; if (!p) return;
      var el = p.el;
      // Walk to the nearest inspectable element (skip our own overlay/tip).
      while (el && !isInspectable(el)) el = el.parentElement;
      if (!el) { hide(); return; }
      var r = el.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = r.left + 'px';
      overlay.style.top = r.top + 'px';
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';
      tip.innerHTML = buildTip(el);
      tip.style.display = 'block';
      positionTip(p.x, p.y);
    });
  }
  function hide() {
    if (overlay) overlay.style.display = 'none';
    if (tip) tip.style.display = 'none';
  }

  // The static CSS above only covers WordPress-ish wrappers. A source site (arbitrary Tailwind/React SPA)
  // often puts the viewport-fill on a class we can't name (min-h-screen, h-screen, a custom wrapper). So
  // ALSO neutralise it generically in JS: any element whose COMPUTED min-height/height resolves to ~the
  // viewport height is collapsed to auto, so the footer sits right after the content (no giant gap).
  function neutralizeViewportFill() {
    try {
      var vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if (vh < 200) return;
      var els = document.querySelectorAll('body, body *');
      for (var i = 0; i < els.length && i < 6000; i++) {
        var el = els[i]; if (!el || !el.style) continue;
        var cs = window.getComputedStyle(el);
        var mh = parseFloat(cs.minHeight) || 0;
        var h = parseFloat(cs.height) || 0;
        if (mh >= vh * 0.85) el.style.setProperty('min-height', '0px', 'important');
        // height:100vh (resolved to ~viewport px) on a container whose content overflows → let it grow.
        if (h >= vh * 0.85 && cs.overflowY !== 'auto' && cs.overflowY !== 'scroll' && el.scrollHeight > h + 4) {
          el.style.setProperty('height', 'auto', 'important');
        }
      }
    } catch (e) { /* best-effort */ }
  }

  function wire() {
    injectUI();
    neutralizeViewportFill();
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseleave', hide, true);
    window.addEventListener('scroll', hide, true);
    // Height reporting — on load, after images, on resize, and a few delayed ticks. Re-neutralise each
    // tick because SPA content / lazy sections can re-introduce a viewport-fill wrapper after first paint.
    var report = function () { neutralizeViewportFill(); postHeight(); };
    report();
    window.addEventListener('load', report);
    window.addEventListener('resize', report);
    try { new ResizeObserver(report).observe(document.documentElement); } catch (e) { /* */ }
    if (document.body) { try { new ResizeObserver(report).observe(document.body); } catch (e) { /* */ } }
    [200, 600, 1200, 2500].forEach(function (ms) { setTimeout(report, ms); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
