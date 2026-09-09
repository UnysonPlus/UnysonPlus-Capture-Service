/**
 * masthead.mjs — resolve the element that is REALLY the site masthead.
 *
 * Why this exists
 * ---------------
 * `document.querySelector('header')` is wrong often enough to corrupt a capture.
 * Measured across 180 live generated sites (UnysonPlus-AI-Dev-Kit/tools/chrome-survey):
 *
 *   • On the OpenHero corpus the masthead is a <nav> on 72% of pages, and <header>
 *     wraps the HERO (a min-h-screen band with a background video). So the naive
 *     selector returns the hero on 26% of pages and null on 48%.
 *   • ~15% of headers are DETACHED — floating 16-128px below the viewport top —
 *     so a `rect.top <= 8` test misses them too.
 *
 * Reading the wrong element is not merely "no data": capture.mjs stamps the
 * scrolled-state styles onto the element it finds as `data-sc-scrolled`, so a
 * mis-resolve paints the NAV BAR's scrolled background + backdrop-filter onto the
 * HERO, and the PHP build_from_html path then faithfully reproduces that mistake.
 *
 * The rule
 * --------
 * Score every candidate near the top of the viewport on tag (<header>/<nav>),
 * role=banner, class name, position (fixed/sticky), link density and node count,
 * and explicitly REJECT hero bands. Highest score wins.
 *
 * Sharing mechanism
 * -----------------
 * Playwright serializes an evaluated function's SOURCE, so a page function can
 * neither close over an import nor over a helper defined in an enclosing scope —
 * only what is inside its own body survives the trip. Each exported page function
 * is therefore built with the resolver INLINED at the top of its body, composed
 * with `new Function` in NODE (never in the page — `new Function`/`eval` in page
 * context is blocked by a strict Content-Security-Policy on some sites).
 */

/* The resolver body. Defines __scIsHero() + __scMasthead() in whatever function
   body it is spliced into. ES5-flavoured on purpose: it is stringified into
   arbitrary third-party pages. */
export const MASTHEAD_BODY = `
function __scIsHero(el) {
  if (!el) return false;
  var r = el.getBoundingClientRect();
  var vh = window.innerHeight || 800;
  if (r.height < vh * 0.6) return false;              // masthead-height -> not a hero
  if (!el.querySelector('h1, h2')) return false;      // a hero leads with a big heading
  var navLinks = [].slice.call(el.querySelectorAll('a, button')).filter(function (a) {
    var t = (a.textContent || '').trim(); return t && t.length < 30;
  });
  return !(r.height <= 200 && navLinks.length >= 3);  // a short dense link bar is a nav, not a hero
}
function __scMasthead() {
  var cs = function (el) { return getComputedStyle(el); };
  var clsOf = function (el) {
    return typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
  };
  var cands = [].slice.call(document.querySelectorAll('body *')).filter(function (el) {
    var r = el.getBoundingClientRect();
    if (r.height <= 0 || r.top > 200 || r.height > 260 || __scIsHero(el)) return false;
    // top <= 200 (not <= 8) so a DETACHED / floating header still qualifies.
    if (r.width >= window.innerWidth * 0.5) return true;
    // A FLOATING PILL hugs its content, so it can be well under half the viewport
    // (measured: a centred 555px bar on a 1440px page). Admit a narrow candidate only
    // when it is bar-shaped AND link-dense, which a logo cluster is not.
    return r.width >= 300 && r.height <= 160 && el.querySelectorAll('a, button').length >= 2;
  });
  var score = function (el) {
    var s = cs(el), v = 0;
    if (/nav|header|masthead|topbar|navbar/i.test(el.tagName + ' ' + clsOf(el) + ' ' + (el.id || ''))) v += 5;
    if (el.tagName === 'HEADER') v += 4;
    if (el.tagName === 'NAV') v += 4;
    if (s.position === 'fixed' || s.position === 'sticky') v += 4;
    if (el.getAttribute('role') === 'banner') v += 3;
    v += Math.min(el.querySelectorAll('a').length, 8) * 0.5;
    if (el.querySelector('img,svg')) v += 1;
    v -= el.querySelectorAll('*').length / 200;       // prefer the bar over a wrapper containing it
    return v;
  };
  var best = null, bestScore = -Infinity;
  for (var i = 0; i < cands.length; i++) {
    var sc = score(cands[i]);
    if (sc > bestScore) { bestScore = sc; best = cands[i]; }
  }
  if (best) return best;
  // GUARANTEED FLOOR: never resolve worse than the selector this replaced. Shapes the
  // scored pass rejects on purpose are still real mastheads on some sites - a VERTICAL
  // RAIL (measured: 88x860, fixed to a side edge) is the clear case. Fall back to the
  // tag, but never to a hero.
  var tagged = document.querySelector('header') || document.querySelector('[role=banner]');
  return (tagged && !__scIsHero(tagged)) ? tagged : null;
}
`;

/* Compose page functions in NODE, INLINING the resolver into each function body so
   it survives Playwright's source serialization. */
const pageFn = (args, body) =>
  new Function(`return function (${args}) {\n${MASTHEAD_BODY}\n${body}\n};`)();

/**
 * Read the masthead's scroll-state-relevant computed styles. Null when unresolved.
 * @type {() => ({bg,backdrop,shadow,padTop,padBottom,borderBottom,position}|null)}
 */
export const readMastheadState = pageFn('', `
  var h = __scMasthead(); if (!h) return null;
  var s = getComputedStyle(h);
  var r = h.getBoundingClientRect();
  // height + link colour: the two-state model needs both to reproduce a header that RESIZES or whose
  // nav text darkens once stuck (theme 2.5.90's scroll_height / scroll_link_color). Padding alone
  // cannot express either. The link colour is read from a real nav link, not the bar, because the
  // bar's own colour is often inherited and unchanged while the links restyle.
  var lnk = (function () {
    var a = [].slice.call(h.querySelectorAll('a')).filter(function (x) {
      return (x.textContent || '').trim().length > 1 && x.getBoundingClientRect().width > 0;
    });
    return a.length ? getComputedStyle(a[Math.min(1, a.length - 1)]).color : '';
  })();
  return {
    height: Math.round(r.height),
    linkColor: lnk,
    bg: s.backgroundColor,
    backdrop: (s.backdropFilter && s.backdropFilter !== 'none') ? s.backdropFilter : '',
    shadow: (s.boxShadow && s.boxShadow !== 'none') ? s.boxShadow : '',
    padTop: s.paddingTop, padBottom: s.paddingBottom,
    borderBottom: (s.borderBottomWidth !== '0px' && s.borderBottomStyle !== 'none')
      ? (s.borderBottomWidth + ' ' + s.borderBottomStyle + ' ' + s.borderBottomColor) : '',
    position: s.position
  };`);

/**
 * Stamp the scrolled-state declarations onto the masthead as data-sc-scrolled, so the
 * serialized rendered.html carries them into the PHP build_from_html path.
 * @type {(attr: string) => boolean}
 */
export const stampMastheadScrolled = pageFn('attr', `
  var h = __scMasthead(); if (!h) return false;
  h.setAttribute('data-sc-scrolled', attr);
  return true;`);

/**
 * Diagnostic: which element did we resolve, and would the naive selector disagree?
 * @type {() => ({found,tag,cls,id,position,rect,naiveTag,naiveWasHero,agrees})}
 */
export const describeMasthead = pageFn('', `
  var h = __scMasthead();
  var naive = document.querySelector('header');
  if (!h) return { found: false, naiveTag: naive ? naive.tagName.toLowerCase() : null,
                   naiveWasHero: naive ? __scIsHero(naive) : false, agrees: !naive };
  var r = h.getBoundingClientRect(), s = getComputedStyle(h);
  return {
    found: true,
    tag: h.tagName.toLowerCase(),
    cls: (typeof h.className === 'string' ? h.className : '').slice(0, 120),
    id: h.id || null,
    position: s.position,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    naiveTag: naive ? naive.tagName.toLowerCase() : null,
    naiveWasHero: naive ? __scIsHero(naive) : false,
    agrees: naive === h
  };`);
