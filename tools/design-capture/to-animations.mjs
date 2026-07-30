/**
 * to-animations.mjs — the ANIMATION TRACER.
 *
 * Detects a source page's motion design during the live Playwright session and maps what it finds
 * onto UnysonPlus Animation Engine effects, so a conversion carries the site's MOTION — not just
 * its structure. Four passes, cheapest first:
 *
 *   1. LIBRARY SNIFF   — window.gsap + ScrollTrigger.getAll() (a near-1:1 dump: element, start/end,
 *                        pin, scrub), Lenis, Swiper, Lottie, Three.js, AOS, Framer.
 *   2. CSS-DECLARED    — @keyframes + `animation:` rules (marquee/pulse/spin heuristics),
 *                        `:hover` rule diffs (lift / scale / color_shift / glow candidates),
 *                        `transition:` inventories.
 *   3. MOTION TRACES   — rAF-samples prominent elements while scrolling (real scroll, or synthetic
 *                        wheel on virtual-scroll pages): classifies reveal / parallax / pin / scrub.
 *   4. SCROLL-HIJACK   — body ≈ one viewport + fixed full-screen overlays + numbered frame
 *                        requests (…/N.webp) ⇒ a Scroll Story: stage scenes + sequence backdrop.
 *
 * Emits `animations.json` (machine-readable, consumed by to-pages) + `animation-report.csv/html`
 * (human review, same spirit as the conversion report). URL-path only by design — a static HTML
 * file has no runtime to trace (documented asymmetry with the PHP path).
 */

/* ---------------------------------------------------------------- helpers */

const csvCell = (s) => {
  const v = String(s == null ? '' : s);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ------------------------------------------------- pass 1+2: in-page scan */

function inPageScan() {
  const out = { libs: {}, scrollTriggers: [], keyframes: [], animated: [], hovers: [], transitions: [], hijack: null };
  const short = (el) => {
    if (!el || !el.tagName) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };

  // 1) libraries
  const w = window;
  out.libs = {
    gsap: w.gsap ? (w.gsap.version || true) : false,
    scrollTrigger: !!(w.ScrollTrigger || (w.gsap && w.gsap.plugins && w.gsap.plugins.ScrollTrigger)),
    lenis: !!(w.Lenis || w.lenis || w.__lenis || document.documentElement.classList.contains('lenis')),
    swiper: !!(w.Swiper || document.querySelector('.swiper, .swiper-container')),
    lottie: !!(w.lottie || w.bodymovin || document.querySelector('lottie-player, [data-lottie]')),
    three: !!(w.THREE || w.__THREE__),
    aos: !!(w.AOS || document.querySelector('[data-aos]')),
    framer: !!document.querySelector('[data-framer-name], [data-framer-component-type]'),
    canvases: document.querySelectorAll('canvas').length,
    videos: document.querySelectorAll('video').length,
  };

  // ScrollTrigger dump — the goldmine when present.
  try {
    const ST = w.ScrollTrigger;
    if (ST && typeof ST.getAll === 'function') {
      ST.getAll().slice(0, 80).forEach((t) => {
        try {
          out.scrollTriggers.push({
            target: short(t.trigger), pin: !!t.pin, scrub: t.vars ? (t.vars.scrub === undefined ? false : t.vars.scrub) : false,
            start: String(t.vars && t.vars.start || ''), end: String(t.vars && t.vars.end || ''),
            snap: !!(t.vars && t.vars.snap),
          });
        } catch (e) {}
      });
    }
  } catch (e) {}

  // 2) CSS-declared: keyframes + animation rules + :hover diffs + transitions.
  const kf = {}; // name -> summary of what it animates
  const animRules = [], hoverRules = {}, baseRules = {}, transRules = [];
  const sheets = Array.from(document.styleSheets);
  for (const sheet of sheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; } // cross-origin
    if (!rules) continue;
    const walk = (list) => {
      for (const r of Array.from(list)) {
        if (r.type === 7) { // KEYFRAMES_RULE
          const props = new Set(); let dx = false;
          for (const k of Array.from(r.cssRules || [])) {
            for (let i = 0; i < (k.style || []).length; i++) {
              const p = k.style[i]; props.add(p);
              if (p === 'transform' && /translateX\(\s*-/.test(k.style.transform || '')) dx = true;
            }
          }
          kf[r.name] = { props: [...props].slice(0, 6), slidesLeft: dx };
        } else if (r.type === 1) { // STYLE_RULE
          const st = r.style; if (!st) continue;
          const sel = r.selectorText || '';
          if (st.animationName && st.animationName !== 'none') {
            animRules.push({ selector: sel.slice(0, 120), name: st.animationName, duration: st.animationDuration || '', infinite: /infinite/.test(st.animationIterationCount || '') });
          }
          if (/:hover\b/.test(sel)) {
            const key = sel.replace(/:hover\b/g, '').trim().slice(0, 120);
            const props = {};
            for (let i = 0; i < st.length; i++) { props[st[i]] = st.getPropertyValue(st[i]); }
            if (Object.keys(props).length) hoverRules[key] = Object.assign(hoverRules[key] || {}, props);
          } else if (st.length && st.length < 40) {
            const key = sel.trim().slice(0, 120);
            if (!baseRules[key]) {
              const props = {};
              for (let i = 0; i < st.length; i++) { props[st[i]] = st.getPropertyValue(st[i]); }
              baseRules[key] = props;
            }
          }
          if (st.transitionProperty && st.transitionProperty !== 'all' && st.transitionProperty !== 'none') {
            transRules.push({ selector: sel.slice(0, 120), props: st.transitionProperty.slice(0, 80), duration: st.transitionDuration || '' });
          }
        } else if (r.cssRules) { walk(r.cssRules); } // media/supports
      }
    };
    walk(rules);
  }
  out.keyframes = Object.entries(kf).slice(0, 40).map(([name, v]) => ({ name, ...v }));
  // Only keep animation rules whose selector matches a real element — utility libraries
  // (FontAwesome, Animate.css) declare dozens of keyframe classes that nothing uses.
  out.animated = animRules.filter((a) => {
    try { return !!document.querySelector(a.selector); } catch (e) { return true; }
  }).slice(0, 60);
  out.transitions = transRules.slice(0, 40);
  out.hovers = Object.entries(hoverRules).slice(0, 60).map(([selector, props]) => {
    const base = baseRules[selector] || {};
    const changed = {};
    Object.keys(props).forEach((p) => { if (props[p] !== base[p]) changed[p] = props[p]; });
    return { selector, changed };
  }).filter((h) => Object.keys(h.changed).length);

  // 4) scroll-hijack shape (frame sequences come from the request log, outside the page).
  const vh = window.innerHeight || 900;
  const pageH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  const overlays = Array.from(document.querySelectorAll('body *')).filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width >= window.innerWidth * 0.9 && r.height >= vh * 0.9;
  });
  out.hijack = {
    bodyScrollHeight: pageH,
    viewport: vh,
    virtualScroll: pageH <= vh * 1.5,
    fixedFullscreenOverlays: overlays.length,
    fixedCanvas: overlays.some((el) => el.querySelector && el.querySelector('canvas')) || Array.from(document.querySelectorAll('canvas')).some((c) => {
      const p = c.parentElement; return p && getComputedStyle(p).position === 'fixed';
    }),
  };
  return out;
}

/* -------------------------------------------- pass 3: motion trace (page) */

function collectTraceTargets() {
  // Prominent, traceable blocks: big enough to matter, not the page chrome roots.
  const vw = window.innerWidth, vh = window.innerHeight;
  const els = [];
  const seen = new Set();
  const all = document.querySelectorAll('section, article, [class]');
  for (let i = 0; i < all.length && els.length < 60; i++) {
    const el = all[i];
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!r || r.width < 120 || r.height < 80) continue;
    if (r.width >= vw * 0.98 && r.height >= document.body.scrollHeight * 0.9) continue; // page wrapper
    const key = Math.round(r.top + window.pageYOffset) + ':' + Math.round(r.left) + ':' + Math.round(r.width);
    if (seen.has(key)) continue;
    seen.add(key);
    el.setAttribute('data-upw-trace', String(els.length));
    els.push(0);
  }
  return els.length;
}

function sampleTraceTargets() {
  const out = [];
  const els = document.querySelectorAll('[data-upw-trace]');
  for (const el of els) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.push({
      i: parseInt(el.getAttribute('data-upw-trace'), 10),
      top: Math.round(r.top), op: parseFloat(cs.opacity),
      tf: cs.transform === 'none' ? '' : cs.transform,
    });
  }
  return { y: window.pageYOffset, samples: out };
}

// Parse a computed CSS transform (`matrix(a,b,c,d,e,f)` / `matrix3d(...)`) into
// the pieces a reveal cares about: translate (tx,ty) and uniform scale.
function parseMatrix(tf) {
  if (!tf) return null;
  const m = tf.match(/matrix(3d)?\(([^)]+)\)/);
  if (!m) return null;
  const v = m[2].split(',').map((n) => parseFloat(n));
  if (m[1]) return { tx: v[12] || 0, ty: v[13] || 0, sx: v[0] || 1, sy: v[5] || 1 };
  return { tx: v[4] || 0, ty: v[5] || 0, sx: v[0] || 1, sy: v[3] || 1 };
}

// Given the sampled rows (opacity + transform over scroll), reconstruct what the
// element DID: the direction/distance it travelled, whether it scaled, and the
// ease implied by the shape of its opacity curve. This is the raw material the
// converter turns into a tuned Reveal (or, when it's a multi-axis combo, a
// data-driven Motion Snippet).
function traceMotion(rows) {
  // The "from" state = the earliest frame where the element is still hidden.
  const startRow = rows.find((r) => r.op < 0.3) || rows[0];
  const s = parseMatrix(startRow.tf) || { tx: 0, ty: 0, sx: 1, sy: 1 };
  const tx = Math.round(s.tx), ty = Math.round(s.ty);
  const scaled = Math.abs(s.sx - 1) > 0.03 || Math.abs(s.sy - 1) > 0.03;
  let direction = 'up', distance = 60;
  if (Math.abs(ty) >= Math.abs(tx) && Math.abs(ty) > 4) {
    direction = ty > 0 ? 'up' : 'down';          // starts below → rises = 'up'
    distance = Math.abs(ty);
  } else if (Math.abs(tx) > 4) {
    direction = tx > 0 ? 'left' : 'right';       // starts right → slides left = 'left'
    distance = Math.abs(tx);
  }
  distance = Math.max(20, Math.min(200, Math.round(distance)));
  // Ease from the opacity curve: where the rise crosses its midpoint in SCROLL
  // terms vs where opacity is — opacity ahead of linear = ease-out (fast start).
  const rise = rows.filter((r) => r.op > 0.02 && r.op < 0.98);
  let ease = '';
  if (rise.length >= 3) {
    const y0 = rise[0].y, y1 = rise[rise.length - 1].y;
    if (y1 > y0) {
      const mid = rise.reduce((a, b) => (Math.abs((b.y - y0) / (y1 - y0) - 0.5) < Math.abs((a.y - y0) / (y1 - y0) - 0.5) ? b : a));
      const opAtMid = mid.op;
      if (opAtMid > 0.72) ease = 'expo.out';
      else if (opAtMid > 0.58) ease = 'power2.out';
      else if (opAtMid < 0.4) ease = 'power2.in';
      // 0.4–0.58 ≈ linear → leave '' (use the Style preset's ease)
    }
  }
  // Plausibility: a real entrance travels a modest distance and barely scales.
  // Huge translate / odd scale = a smooth-scroll (ScrollSmoother/Lenis) wrapper
  // transform bleeding into the element sample, not its own motion. Mark it noisy
  // so the emitter uses a safe generic Reveal instead of a garbage snippet.
  const noisy = Math.abs(ty) > 240 || Math.abs(tx) > 240 || s.sx < 0.5 || s.sx > 1.6;
  // Multi-axis (scale + translate) that we trust → a Motion Snippet candidate.
  const complex = !noisy && scaled && (Math.abs(tx) > 4 || Math.abs(ty) > 4);
  return { direction, distance, ease, scaled, sx: +s.sx.toFixed(3), tx, ty, complex, noisy };
}

function classifyTraces(frames, targetCount) {
  // frames: [{y, samples:[{i, top, op, tf}]}] over the scroll pass.
  const perEl = new Map();
  frames.forEach((f) => f.samples.forEach((s) => {
    if (!perEl.has(s.i)) perEl.set(s.i, []);
    perEl.get(s.i).push({ y: f.y, top: s.top, op: s.op, tf: s.tf });
  }));
  const findings = [];
  perEl.forEach((rows, i) => {
    if (rows.length < 4) return;
    const ops = rows.map((r) => r.op);
    const opRose = ops[0] < 0.15 && ops[ops.length - 1] > 0.85;
    // pin: viewport top stays ~constant while the page scrolls ≥ 1.2 viewports
    let pinnedRun = 0, maxPinned = 0;
    for (let k = 1; k < rows.length; k++) {
      const dTop = Math.abs(rows[k].top - rows[k - 1].top);
      const dY = Math.abs(rows[k].y - rows[k - 1].y);
      if (dY > 50 && dTop < 8 && rows[k].top > -40 && rows[k].top < 200) { pinnedRun += dY; } else { maxPinned = Math.max(maxPinned, pinnedRun); pinnedRun = 0; }
    }
    maxPinned = Math.max(maxPinned, pinnedRun);
    // parallax: element's document position drifts vs scroll (top+ y should be constant for static)
    const docTops = rows.map((r) => r.top + r.y);
    const drift = docTops[docTops.length - 1] - docTops[0];
    const scrolled = rows[rows.length - 1].y - rows[0].y;
    const hadTransform = rows.some((r) => r.tf);
    // scrub: opacity/position track scroll continuously (many in-between values)
    // rather than snapping 0→1 across a short window = a scrubbed reveal.
    const midOps = ops.filter((o) => o > 0.15 && o < 0.85).length;
    const scrub = midOps >= Math.max(3, rows.length * 0.4);
    if (maxPinned > 700) { findings.push({ i, kind: 'pin', evidence: `pinned for ~${Math.round(maxPinned)}px of scroll` }); return; }
    // Reveal/fade take priority over drift: an element that rises 0→1 in opacity is
    // an entrance, even if a smooth-scroll (ScrollSmoother/Lenis) wrapper makes its
    // document position look like it "drifts". (Genuine parallax layers hold opacity.)
    if (opRose && hadTransform) { findings.push({ i, kind: 'reveal', evidence: 'opacity 0→1 with a transform while entering the viewport', motion: { ...traceMotion(rows), scrub } }); return; }
    if (opRose) { findings.push({ i, kind: 'fade_in', evidence: 'opacity 0→1 while entering the viewport', motion: { direction: 'up', distance: 24, ease: '', scaled: false, complex: false, scrub } }); return; }
    // Parallax only when the element moves at a rate CLEARLY different from scroll.
    // A near-1:1 ratio (≈ tracks scroll) is a fixed element or a smooth-scroll
    // wrapper artifact — not a parallax layer — so require ratio off unity by ≥0.2.
    const ratio = scrolled ? drift / scrolled : 0;
    if (Math.abs(drift) > 60 && scrolled > 400 && hadTransform && Math.abs(Math.abs(ratio) - 1) > 0.2) {
      findings.push({ i, kind: 'parallax', evidence: `document position drifts ${Math.round(drift)}px over ${Math.round(scrolled)}px of scroll`, ratio: +ratio.toFixed(2) });
    }
  });
  return findings;
}

/* --------------------------------------------------- suggestions mapping */

function buildSuggestions(anim) {
  const S = [];
  const push = (kind, target, evidence, suggest, confidence) => S.push({ kind, target, evidence, suggest, confidence });

  // scroll-hijack / sequences → Scroll Story
  if (anim.hijack && anim.hijack.virtualScroll && anim.hijack.fixedFullscreenOverlays >= 2) {
    push('scroll-hijack', 'page', `virtual scroll (body ${anim.hijack.bodyScrollHeight}px ≈ viewport) + ${anim.hijack.fixedFullscreenOverlays} fixed full-screen overlays`,
      "scrollytelling stage: one Section, layout:'stage', one column per overlay scene", 'high');
  }
  (anim.sequences || []).forEach((q) => {
    push('frame-sequence', q.pattern, `${q.count} numbered frames (${q.min}–${q.max})`,
      anim.hijack && anim.hijack.virtualScroll
        ? `scrollytelling stage backdrop: {source:'sequence', url_pattern:'${q.pattern}', count:${q.count}, start:${q.min}}`
        : `[image_sequence] pattern branch: url_pattern:'${q.pattern}', count:${q.count}, start:${q.min}`, 'high');
  });

  // ScrollTrigger dump
  (anim.scrollTriggers || []).forEach((t) => {
    if (t.pin && t.scrub !== false) { push('scrolltrigger', t.target, `pin + scrub (${t.start}→${t.end})`, "gsap_motion pin/scrub, or scrollytelling for multi-step", 'high'); }
    else if (t.pin) { push('scrolltrigger', t.target, `pin (${t.start}→${t.end})`, "gsap_motion: {effect:'pin'}", 'high'); }
    else if (t.scrub !== false) { push('scrolltrigger', t.target, `scrub (${t.start}→${t.end})`, "gsap_motion: {effect:'scrub'}", 'high'); }
    else { push('scrolltrigger', t.target, `trigger at ${t.start}`, "gsap_motion: {effect:'reveal'}", 'medium'); }
  });

  // Motion traces
  (anim.traces || []).forEach((f) => {
    if (f.kind === 'pin') push('trace', 'trace#' + f.i, f.evidence, "gsap_motion: {effect:'pin'} or a scrollytelling Section", 'medium');
    if (f.kind === 'parallax') push('trace', 'trace#' + f.i, f.evidence, `gsap_motion: {effect:'parallax'} (ratio ≈ ${f.ratio})`, 'medium');
    if (f.kind === 'reveal') push('trace', 'trace#' + f.i, f.evidence, "gsap_motion: {effect:'reveal', reveal:{direction:'up'}}", 'medium');
    if (f.kind === 'fade_in') push('trace', 'trace#' + f.i, f.evidence, "animation (entrance): animate__fadeIn", 'medium');
  });

  // CSS keyframe loops
  (anim.animated || []).forEach((a) => {
    const k = (anim.keyframes || []).find((x) => a.name.split(',')[0].trim() === x.name);
    if (a.infinite && k && k.slidesLeft) { push('css-animation', a.selector, `infinite keyframes '${a.name}' translating X`, "marquee fx: {mode:'left'}", 'high'); }
    else if (a.infinite) { push('css-animation', a.selector, `infinite keyframes '${a.name}' (${(k && k.props || []).join(',')})`, "physics float/pulse or backgrounds module", 'low'); }
    else { push('css-animation', a.selector, `keyframes '${a.name}' ${a.duration}`, 'entrance animation (Animate.css picker)', 'low'); }
  });

  // Hover diffs
  (anim.hovers || []).forEach((h) => {
    const c = h.changed; const props = Object.keys(c);
    const has = (re) => props.some((p) => re.test(p));
    let sug = '';
    if (has(/^transform$/) && /translateY\(-/.test(c.transform || '')) sug = "interaction: {effect:'lift'}";
    else if (has(/^transform$/) && /scale\(1\.[0-9]/.test(c.transform || '')) sug = "interaction: {effect:'scale', scale:{style:'in'}}";
    else if (has(/box-shadow/)) sug = "interaction: {effect:'lift'} or glow_border";
    else if (has(/background|color|border/)) sug = "interaction: {effect:'color_shift'}";
    else if (has(/filter/)) sug = "interaction: {effect:'grayscale'|'brightness'}";
    if (sug) push('hover', h.selector, props.slice(0, 4).join(', ') + ' change on hover', sug, 'medium');
  });

  // Libraries → site-wide. `(bundled)` = found by scanning the delivered JS, not a window global.
  if (anim.libs) {
    const B = anim.libsBundled || {};
    const via = (k) => (B[k] ? ' (bundled)' : '');
    if (anim.libs.gsap) push('library', 'page', 'GSAP' + via('gsap') + (anim.libs.scrollTrigger ? ' + ScrollTrigger' : ''), 'scroll-motion module (gsap_motion fx) covers this natively', 'high');
    if (anim.libs.splitText) push('library', 'page', 'SplitText/SplitType' + via('splitText'), "gsap_motion: {effect:'splittext'} or text_effect split_reveal", 'high');
    if (anim.libs.lenis) push('library', 'page', 'Lenis smooth scroll' + via('lenis'), "per-page smooth_scroll:'yes'", 'high');
    if (anim.libs.lottie) push('library', 'page', 'Lottie player present', '[lottie] element for those animations', 'high');
    if (anim.libs.three) push('library', 'page', 'Three.js present', '[webgl_object] / [model_viewer] candidates', 'medium');
    if (anim.libs.swiper) push('library', 'page', 'Swiper carousel present', 'carousel / gallery_3d element', 'medium');
    if (anim.libs.aos) push('library', 'page', 'AOS scroll-reveal present', "gsap_motion reveal on [data-aos] elements", 'high');
  }
  return S;
}

/* ------------------------------------------------------------ public API */

/**
 * Run the tracer against the live page. Installs a request logger, scans, scrolls (real or
 * synthetic wheel), samples traces, hover-diffs a few interactive elements.
 */
/**
 * Library detection from SCRIPT BODIES. Modern bundlers (Nuxt/Next/Vite) keep libraries
 * module-scoped, so `window.gsap` is undefined even when GSAP drives the whole page — checking
 * globals alone reports "no libraries" on most real sites. Scanning the delivered JS for
 * signatures is what actually tells you the stack.
 */
export function detectBundledLibs(scriptBodies) {
  const SIGS = {
    gsap: /\bgsap\b|GreenSock|TweenMax|_gsScope/,
    scrollTrigger: /ScrollTrigger/,
    lenis: /\blenis\b/i,
    three: /THREE\.|WebGLRenderer|PerspectiveCamera/,
    lottie: /lottie|bodymovin/i,
    swiper: /\bswiper\b/i,
    framerMotion: /framer-motion/i,
    aos: /\bAOS\b|data-aos/,
    splitText: /SplitText|SplitType/,
  };
  const out = {};
  for (const [k, re] of Object.entries(SIGS)) {
    out[k] = (scriptBodies || []).some((b) => re.test(b));
  }
  return out;
}

export async function traceAnimations(page, { log = () => {}, knownImageUrls = null, scriptBodies = null } = {}) {
  const reqUrls = new Set(knownImageUrls || []);
  const onReq = (r) => { try { const u = r.url().split('?')[0]; if (/\.(webp|avif|jpe?g|png)$/i.test(u)) reqUrls.add(u); } catch (e) {} };
  page.on('request', onReq);

  const anim = await page.evaluate(inPageScan).catch(() => ({ libs: {}, hijack: null }));

  // Merge BUNDLED library detection over the globals scan — a bundled lib is still the site's
  // stack even though it never touches `window`, and it's usually the more truthful answer.
  if (scriptBodies && scriptBodies.length) {
    const bundled = detectBundledLibs(scriptBodies);
    anim.libs = anim.libs || {};
    anim.libsBundled = bundled;
    if (bundled.gsap && !anim.libs.gsap) { anim.libs.gsap = 'bundled'; }
    if (bundled.scrollTrigger && !anim.libs.scrollTrigger) { anim.libs.scrollTrigger = true; }
    if (bundled.lenis && !anim.libs.lenis) { anim.libs.lenis = true; }
    if (bundled.three && !anim.libs.three) { anim.libs.three = true; }
    if (bundled.lottie && !anim.libs.lottie) { anim.libs.lottie = true; }
    if (bundled.swiper && !anim.libs.swiper) { anim.libs.swiper = true; }
    if (bundled.aos && !anim.libs.aos) { anim.libs.aos = true; }
    if (bundled.splitText) { anim.libs.splitText = true; }
  }

  // Motion traces — tag targets, then scroll through sampling.
  let traces = [];
  try {
    const n = await page.evaluate(collectTraceTargets);
    if (n > 0) {
      const frames = [];
      const virtual = !!(anim.hijack && anim.hijack.virtualScroll);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(700, 400).catch(() => {});
      const steps = virtual ? 60 : 28;
      for (let i = 0; i < steps; i++) {
        if (virtual) { await page.mouse.wheel(0, 550).catch(() => {}); }
        else { await page.evaluate((k) => window.scrollTo(0, Math.round(document.body.scrollHeight * k)), i / (steps - 1)); }
        await page.waitForTimeout(virtual ? 120 : 220);
        const f = await page.evaluate(sampleTraceTargets).catch(() => null);
        if (f) frames.push(f);
      }
      traces = classifyTraces(frames, n);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    }
  } catch (e) { log('trace pass skipped: ' + e.message); }
  anim.traces = traces;

  // Hover-diff a handful of interactive elements (buttons, cards, links with class).
  try {
    const targets = await page.evaluate(() => {
      const sel = 'a[class], button, [class*="card" i], [class*="btn" i]';
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20 || r.width > 700) continue;
        const key = (el.className || '').toString().slice(0, 60);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        el.setAttribute('data-upw-hov', String(out.length));
        out.push(key);
        if (out.length >= 10) break;
      }
      return out;
    });
    const hoverLive = [];
    for (let i = 0; i < targets.length; i++) {
      const snap = (idx) => page.evaluate((j) => {
        const el = document.querySelector('[data-upw-hov="' + j + '"]');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { transform: cs.transform, boxShadow: cs.boxShadow, background: cs.backgroundColor, color: cs.color, filter: cs.filter, borderColor: cs.borderTopColor };
      }, idx);
      const before = await snap(i);
      if (!before) continue;
      const h = page.locator('[data-upw-hov="' + i + '"]').first();
      const vis = await h.isVisible().catch(() => false);
      if (!vis) continue;
      await h.hover({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(280);
      const after = await snap(i);
      await page.mouse.move(4, 4).catch(() => {});
      if (!after) continue;
      const changed = {};
      Object.keys(before).forEach((k) => { if (before[k] !== after[k]) changed[k] = after[k]; });
      if (Object.keys(changed).length) hoverLive.push({ selector: targets[i], changed, live: true });
    }
    // live hovers are higher-signal than CSS-rule hovers; merge (live wins per selector).
    const bySel = new Map((anim.hovers || []).map((h) => [h.selector, h]));
    hoverLive.forEach((h) => bySel.set(h.selector, h));
    anim.hovers = [...bySel.values()];
  } catch (e) { log('hover pass skipped: ' + e.message); }

  page.off('request', onReq);

  // Numbered frame sequences from the request log.
  const groups = new Map();
  for (const u of reqUrls) {
    const m = u.match(/^(.*?)(\d+)(\.\w+)$/);
    if (!m) continue;
    const key = m[1] + '%d' + m[3];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(parseInt(m[2], 10));
  }
  anim.sequences = [...groups.entries()]
    .filter(([, nums]) => nums.length >= 20)
    .map(([pattern, nums]) => ({ pattern, count: nums.length, min: Math.min(...nums), max: Math.max(...nums) }))
    .slice(0, 6);

  // Scroll TIMELINE (virtual-scroll pages): wheel-drive from the top, recording which overlays
  // are visible per step and which sequences load — the choreography, not just the parts. Runs
  // LAST (it reloads the page; the overlay tags it leaves behind feed extractStoryScenes).
  if (anim.hijack && anim.hijack.virtualScroll && anim.hijack.fixedFullscreenOverlays >= 2) {
    try {
      const raw = await sampleTimeline(page, log);
      anim.timeline = buildTimeline(raw, anim.sequences, 900);
      if (anim.timeline) {
        log(`timeline → ${anim.timeline.stories.length} story stretch(es): ` +
          anim.timeline.stories.map((s) => `${s.scenes.length} scene(s)${s.seq ? ' + ' + s.seq.count + '-frame ride' : ''} @${s.sceneLen}scr`).join(' · '));
      }
    } catch (e) { log('timeline pass skipped: ' + e.message); }
  }

  // De-dupe (nested @media walks can register the same rule twice).
  const seen = new Set();
  anim.suggestions = buildSuggestions(anim).filter((s) => {
    const k = s.kind + '|' + s.target + '|' + s.evidence;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return anim;
}

/* ------------------------------ brand tokens from a position:fixed page ---
 * On a scroll-hijacked page the in-flow DOM is empty, so the normal token extractors (which read
 * `sections[]` + the body's computed styles) fall through to seeded defaults — the converted site
 * would ship Bootstrap blue instead of the source's brand. This samples the RENDERED page directly
 * (every visible text run + every button/link fill, wherever it lives) and returns the design
 * tokens. Gradient fills are parsed too, so a gradient CTA still yields a brand colour — a win for
 * ANY source, not just hijacked ones. */
export function extractBrandTokens() {
  const isNeutral = (c) => {
    const m = String(c || '').match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return true;
    const r = m.slice(0, 3).map(Number);
    return (Math.max(...r) - Math.min(...r)) <= 24;
  };
  const firstRgb = (s) => {
    const out = [];
    const re = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/g;
    let m;
    while ((m = re.exec(String(s || '')))) { out.push(`rgb(${Math.round(+m[1])}, ${Math.round(+m[2])}, ${Math.round(+m[3])})`); }
    return out;
  };
  const texts = [], fills = [], surfaces = [];
  const els = document.querySelectorAll('body *');
  for (let i = 0; i < els.length && i < 4000; i++) {
    const el = els[i];
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (['script', 'style', 'noscript', 'svg', 'path', 'canvas'].includes(tag)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;

    // Text runs (element owns a direct, non-trivial text node).
    let txtLen = 0;
    for (const n of el.childNodes) { if (n.nodeType === 3) { txtLen += n.nodeValue.trim().length; } }
    if (txtLen > 1) {
      texts.push({ size: parseFloat(cs.fontSize) || 0, family: cs.fontFamily || '', color: cs.color || '', weight: cs.fontWeight || '', len: txtLen });
    }
    // Brand fills — a button/link with a real background colour OR a gradient.
    if (tag === 'a' || tag === 'button' || /(^|\s)(btn|button|cta)/i.test(el.className || '')) {
      const bg = cs.backgroundColor || '';
      const bgi = cs.backgroundImage || '';
      let cand = '';
      if (bg && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/i.test(bg)) { cand = bg; }
      else if (/gradient/i.test(bgi)) { cand = firstRgb(bgi).find((c) => !isNeutral(c)) || ''; }
      if (cand && !isNeutral(cand)) { fills.push(cand); }
    }
    // Large opaque surfaces → candidate page background.
    if (r.width * r.height > (window.innerWidth * window.innerHeight) * 0.25) {
      const bg = cs.backgroundColor || '';
      if (bg && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/i.test(bg)) { surfaces.push(bg); }
    }
  }
  if (!texts.length) return null;

  const famOf = (f) => String(f || '').split(',')[0].replace(/['"]/g, '').trim();
  const mode = (arr) => {
    const c = new Map();
    arr.forEach((v) => c.set(v, (c.get(v) || 0) + 1));
    let best = '', n = 0;
    c.forEach((v, k) => { if (v > n) { n = v; best = k; } });
    return best;
  };
  // Heading = the largest text run (tie-break: the longer one).
  const heading = texts.slice().sort((a, b) => (b.size - a.size) || (b.len - a.len))[0];
  // Body = the most-used family/colour among ordinary-sized runs, weighted by text length.
  const bodyRuns = texts.filter((t) => t.size > 0 && t.size <= 22);
  const weighted = [];
  bodyRuns.forEach((t) => { const w = Math.min(20, Math.ceil(t.len / 20)); for (let k = 0; k < w; k++) { weighted.push(t); } });
  const bodyFamily = mode((weighted.length ? weighted : texts).map((t) => famOf(t.family)));
  const bodyColor = mode((weighted.length ? weighted : texts).map((t) => t.color));

  return {
    headingFont: famOf(heading && heading.family),
    headingColor: (heading && heading.color) || '',
    headingWeight: (heading && heading.weight) || '',
    bodyFont: bodyFamily,
    bodyColor,
    brandColor: mode(fills),
    surface: mode(surfaces),
  };
}

/* --------------------------------------- pass 5: scroll TIMELINE sampler */

/** In-page: tag every fixed full-screen overlay with a stable id (data-upw-ov). Canvas-bearing
 * overlays are the sequence BACKDROP containers — their visible spans segment the stories. */
function tagOverlays() {
  const vw = window.innerWidth, vh = window.innerHeight;
  let n = 0;
  const canvas = [];
  Array.from(document.querySelectorAll('body *')).forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed') return;
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.9 || r.height < vh * 0.9) return;
    el.setAttribute('data-upw-ov', String(n));
    if (el.querySelector('canvas')) canvas.push(n);
    n++;
  });
  return { count: n, canvas };
}

/** In-page: sample which tagged overlays are currently visible (visibility + opacity). */
function sampleOverlays() {
  const out = [];
  document.querySelectorAll('[data-upw-ov]').forEach((el) => {
    const cs = getComputedStyle(el);
    const vis = cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05 && cs.display !== 'none';
    out.push({ i: parseInt(el.getAttribute('data-upw-ov'), 10), vis });
  });
  return out;
}

/**
 * Wheel-drive the virtual-scroll page from the top and record, per step, which overlays are
 * visible and which frame-sequence patterns are loading. Returns the raw timeline.
 * The page is RELOADED first so the timeline starts at 0 (wheel timelines can't be scrollTo'd).
 */
async function sampleTimeline(page, log) {
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const tags = await page.evaluate(tagOverlays).catch(() => null);
  if (!tags || !tags.count) return null;
  await page.mouse.move(700, 420).catch(() => {});

  const STEP_PX = 500, MAX_STEPS = 140, QUIET_LIMIT = 22;
  const steps = [];
  let quiet = 0, lastVisKey = '';
  for (let s = 0; s < MAX_STEPS; s++) {
    await page.mouse.wheel(0, STEP_PX).catch(() => {});
    await page.waitForTimeout(95);
    const vis = await page.evaluate(sampleOverlays).catch(() => []);
    const visSet = vis.filter((v) => v.vis).map((v) => v.i);
    steps.push({ vis: visSet });
    const key = visSet.join(',');
    if (key === lastVisKey) { quiet++; if (quiet >= QUIET_LIMIT) break; } else { quiet = 0; }
    lastVisKey = key;
  }
  log && log(`timeline: ${steps.length} wheel steps · ${tags.count} overlays (${tags.canvas.length} canvas backdrops)`);
  return { steps, stepPx: STEP_PX, ovCount: tags.count, canvas: tags.canvas };
}

/**
 * Segment a sampled timeline into STORIES: per-overlay visible spans ordered by first appearance,
 * split wherever a NEW frame sequence starts loading; each story carries the sequence active in
 * its stretch and per-scene lengths in screens (span × stepPx / viewport).
 */
function buildTimeline(raw, sequences, viewportH) {
  if (!raw || !raw.steps || raw.steps.length < 4) return null;
  const { steps, stepPx } = raw;
  const canvasIds = new Set(raw.canvas || []);
  const spans = new Map(); // ov id -> {first, last}
  steps.forEach((st, k) => st.vis.forEach((i) => {
    if (!spans.has(i)) spans.set(i, { first: k, last: k });
    else spans.get(i).last = k;
  }));
  if (!spans.size) return null;

  // Story stretches = the canvas backdrop containers' visible spans (frame requests preload
  // upfront on real sites, so request TIMING can't segment — the backdrop's visibility can).
  const stretches = [...spans.entries()]
    .filter(([i]) => canvasIds.has(i))
    .map(([i, s]) => ({ ov: i, first: s.first, last: s.last }))
    .sort((a, b) => a.first - b.first);
  // Long sequences in request order map onto the stretches by index (ride #1 = sequence #1 …);
  // fall back count-descending when there are more stretches than long sequences.
  const rides = (sequences || []).filter((q) => q.count >= 40);
  stretches.forEach((st, k) => { st.seq = rides[k] || null; });

  // Content scenes (non-canvas overlays) ordered by first appearance. Pacing comes from the gap
  // to the NEXT scene's entrance (containers often stay technically visible while their children
  // animate, so raw spans over-count).
  const scenes = [...spans.entries()]
    .filter(([i]) => !canvasIds.has(i))
    .map(([i, s]) => ({ ov: i, first: s.first, last: s.last }))
    .sort((a, b) => a.first - b.first);
  if (!scenes.length) return null;
  scenes.forEach((sc, k) => {
    const until = (k + 1 < scenes.length) ? scenes[k + 1].first : Math.min(sc.last + 1, steps.length);
    const stepsOwned = Math.max(1, until - sc.first);
    sc.screens = Math.max(0.5, Math.min(3, Math.round((stepsOwned * stepPx / (viewportH || 900)) * 4) / 4));
  });

  // Assign each scene the stretch whose span it overlaps most (or none).
  const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1) + 1);
  scenes.forEach((sc) => {
    let best = null, bestOv = 0;
    stretches.forEach((st, idx) => {
      const o = overlap(sc.first, sc.last, st.first, st.last);
      if (o > bestOv) { bestOv = o; best = idx; }
    });
    sc.stretch = best; // index into stretches, or null
  });

  // Group consecutive scenes sharing a stretch into stories (null-stretch runs group together too).
  const stories = [];
  scenes.forEach((sc) => {
    const cur = stories[stories.length - 1];
    if (cur && cur.stretch === sc.stretch) { cur.scenes.push(sc); }
    else { stories.push({ stretch: sc.stretch, scenes: [sc] }); }
  });
  stories.forEach((st) => { st.seq = st.stretch != null ? stretches[st.stretch].seq : null; });

  // De-fragment: a canvas backdrop's visibility can flicker near hand-offs, splitting one ride
  // into slivers. Merge a story into its predecessor when they share a sequence, or when a
  // 1-scene no-backdrop sliver sits between two stories of the same sequence.
  let merged = true;
  while (merged) {
    merged = false;
    for (let k = stories.length - 1; k > 0; k--) {
      const a = stories[k - 1], b = stories[k];
      const samePat = a.seq && b.seq && a.seq.pattern === b.seq.pattern;
      const sliver = !b.seq && b.scenes.length <= 1 && stories[k + 1] && a.seq && stories[k + 1].seq && a.seq.pattern === stories[k + 1].seq.pattern;
      if (samePat || sliver) { a.scenes = a.scenes.concat(b.scenes); stories.splice(k, 1); merged = true; }
    }
  }
  stories.forEach((st) => {
    const avg = st.scenes.reduce((a, s) => a + s.screens, 0) / st.scenes.length;
    st.sceneLen = Math.max(0.5, Math.min(3, Math.round(avg * 4) / 4));
  });
  return { stories, sceneOrder: scenes.map((s) => s.ov) };
}

/* ------------------------------------------- EMIT: motion onto the pages */

/**
 * In-page pass (page.evaluate) — extract STORY SCENES from a scroll-hijacked page: each fixed
 * full-screen overlay that carries real text becomes a scene {headings, paragraphs, ctas}.
 */
export function extractStoryScenes() {
  const vw = window.innerWidth, vh = window.innerHeight;
  // Hidden-at-rest slides (visibility:hidden until their scroll segment) still have layout +
  // computed styles, but innerText returns '' — so read TEXT NODES directly, joining word-split
  // spans with spaces (SPA text-reveal effects shatter copy into per-word elements).
  const textOf = (el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const parts = [];
    while (w.nextNode()) { const t = w.currentNode.nodeValue.trim(); if (t) parts.push(t); }
    let s = parts.join(' ').replace(/\s+([.,!?…])/g, '$1').replace(/\s+/g, ' ').trim();
    // Per-LETTER split effects ("U r b a n") — collapse runs of 3+ spaced single characters.
    s = s.replace(/(?:\b\S\s){3,}\S\b/g, (m) => m.replace(/\s/g, ''));
    return s;
  };
  // Effective font-size: the LARGEST size among text-bearing descendants (slide titles often sit
  // in per-word spans whose wrapper has a small base size).
  const effFs = (el) => {
    let max = parseFloat(getComputedStyle(el).fontSize) || 16;
    const els = el.querySelectorAll('*');
    for (let i = 0; i < els.length && i < 60; i++) {
      const k = els[i];
      if (!k.childNodes || !Array.from(k.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue;
      const f = parseFloat(getComputedStyle(k).fontSize) || 0;
      if (f > max) max = f;
    }
    return max;
  };
  const scenes = [];
  // Prefer the overlays the timeline sampler tagged (stable ids align scenes ↔ timeline);
  // fall back to a fresh find when the sampler didn't run.
  let overlays = Array.from(document.querySelectorAll('[data-upw-ov]'));
  if (!overlays.length) {
    overlays = Array.from(document.querySelectorAll('body *')).filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') return false;
      const r = el.getBoundingClientRect();
      return r.width >= vw * 0.9 && r.height >= vh * 0.9;
    });
  }
  // Largest raster/inline image inside a node (the slide's hero visual) — skip 1px trackers,
  // icons and the tiny UI chrome; return the biggest by rendered area.
  const bigImage = (root) => {
    let best = null, bestA = 0;
    root.querySelectorAll('img, [style*="background-image"]').forEach((m) => {
      const r = m.getBoundingClientRect();
      const a = r.width * r.height;
      if (a < 90 * 90 || a > vw * vh * 1.2) return; // too small / full-bleed backdrop
      let url = '';
      if (m.tagName === 'IMG') { url = m.currentSrc || m.src || ''; }
      else { const bg = getComputedStyle(m).backgroundImage || ''; const mm = bg.match(/url\(["']?([^"')]+)["']?\)/); url = mm ? mm[1] : ''; }
      if (!url || /^data:/.test(url)) return;
      if (a > bestA) { bestA = a; best = { url, alt: (m.getAttribute && m.getAttribute('alt')) || '', w: Math.round(r.width), h: Math.round(r.height) }; }
    });
    return best;
  };
  // Word-reveal heuristic: a heading shattered into many single-word (or single-letter) inline
  // spans is a scroll/scrub text reveal (poly, GSAP SplitText, etc.) → scroll_text_highlight.
  const isWordReveal = (node) => {
    const spans = node.querySelectorAll('span, i, em, b');
    if (spans.length < 4) return false;
    let single = 0;
    for (const s of spans) {
      if (s.children.length) continue;
      const t = (s.textContent || '').trim();
      if (t && t.split(/\s+/).length <= 1) single++;
    }
    return single >= 4 && single >= spans.length * 0.5;
  };

  for (const el of overlays) {
    if (el.querySelector('canvas') && textOf(el).length < 8) continue;
    const scene = { headings: [], paragraphs: [], ctas: [], images: [], word_reveal: false, ov: el.hasAttribute('data-upw-ov') ? parseInt(el.getAttribute('data-upw-ov'), 10) : null };
    const seen = new Set();
    const grab = (node, depth) => {
      if (depth > 8) return;
      for (const child of Array.from(node.children || [])) {
        const tag = child.tagName ? child.tagName.toLowerCase() : '';
        if (['script', 'style', 'svg', 'canvas', 'video', 'img', 'noscript'].includes(tag)) continue;
        const txt = textOf(child);
        if (!txt) continue;
        if (tag === 'a' || tag === 'button') {
          if (txt.length <= 40 && !seen.has('cta:' + txt)) { seen.add('cta:' + txt); scene.ctas.push({ label: txt, href: (child.getAttribute && child.getAttribute('href')) || '#' }); }
          continue;
        }
        const fs = effFs(child);
        // Mixed container (holds sub-blocks of different roles) → descend instead of capturing.
        const kids = Array.from(child.children).filter((k) => textOf(k).length > 2);
        const kidSizes = kids.map((k) => effFs(k));
        const mixed = kids.length > 1 && (Math.max(...kidSizes) - Math.min(...kidSizes) > 6 || kids.some((k) => /^(a|button)$/i.test(k.tagName)));
        if (mixed || (kids.length && txt.length > 200)) { grab(child, depth + 1); continue; }
        if (seen.has(txt)) continue;
        seen.add(txt);
        if (tag && /^h[1-6]$/.test(tag)) { scene.headings.push({ level: parseInt(tag[1], 10), text: txt.slice(0, 200) }); if (isWordReveal(child)) scene.word_reveal = true; }
        else if (fs >= 26 && txt.length <= 160) { scene.headings.push({ level: fs >= 44 ? 1 : 2, text: txt.slice(0, 200) }); if (isWordReveal(child)) scene.word_reveal = true; }
        else if (txt.length > 2) { scene.paragraphs.push(txt.slice(0, 400)); }
      }
    };
    grab(el, 0);
    // Carry the slide's hero image (media_image) — so a picture-led slide isn't lost, and a
    // text+image slide keeps both. The full-bleed sequence backdrop is excluded by bigImage().
    const bi = bigImage(el);
    if (bi) scene.images.push(bi);
    // A slide with ONLY imagery (no text) is still a real scene — keep it (quiet scene) so the
    // pacing and the source's visual rhythm survive.
    if (!scene.headings.length && !scene.paragraphs.length && !scene.ctas.length && !scene.images.length) continue;
    scene.headings = scene.headings.slice(0, 2);
    scene.paragraphs = scene.paragraphs.slice(0, 3);
    scene.ctas = scene.ctas.slice(0, 3);
    scene.images = scene.images.slice(0, 1);
    scenes.push(scene);
  }
  // Demote duplicate H1s — only the first scene keeps one (heading-order a11y).
  let sawH1 = false;
  scenes.forEach((s) => s.headings.forEach((h) => {
    if (h.level === 1) { if (sawH1) h.level = 2; sawH1 = true; }
  }));
  return scenes.slice(0, 10);
}

const _uid = () => {
  let s = '';
  for (let i = 0; i < 32; i++) s += '0123456789abcdef'[(Math.random() * 16) | 0];
  return s;
};

/** Build ONE scrollytelling STAGE section from extracted scenes + a detected frame sequence. */
export function stageSectionNode(scenes, seq, sceneLen = 1.5) {
  // A word-reveal heading rides the scroll_text_highlight fx (word-by-word fill on scroll) —
  // reproducing the source's SplitText-style reveal instead of a plain crossfade.
  const heading = (h, reveal) => ({ type: 'simple', shortcode: 'special_heading', _items: [], atts: {
    title: h.text, heading: 'h' + Math.min(6, Math.max(1, h.level || 2)), alignment: 'center', unique_id: _uid(),
    ...(reveal ? { scroll_text_highlight: { mode: 'fill', fill: { split: 'word', active_color: { predefined: '', custom: '' }, duration: 0.5, once: 'yes' } } } : {}),
  } });
  const para = (t) => ({ type: 'simple', shortcode: 'text_block', _items: [], atts: { text: '<p>' + t + '</p>', unique_id: _uid() } });
  const btn = (c) => ({ type: 'simple', shortcode: 'button', _items: [], atts: { label: c.label, link: c.href || '#', unique_id: _uid() } });
  // Match the converter's proven media_image shape (importer sideloads the src).
  const image = (im) => ({ type: 'simple', shortcode: 'media_image', _items: [], atts: {
    image: { attachment_id: '', url: im.url, alt: im.alt || '' },
    width: { value: 480, unit: 'px' }, height: { value: '', unit: 'px' },
    fetchpriority: 'auto', link: '', target: '_self', unique_id: _uid(),
  } });
  const column = (items) => ({ type: 'column', width: '1_1', _items: items, atts: { unique_id: _uid() } });

  const cols = scenes.map((sc) => column([
    ...sc.headings.slice(0, 2).map((h) => heading(h, sc.word_reveal)),
    ...(sc.images || []).map(image),
    ...sc.paragraphs.map(para),
    ...sc.ctas.map(btn),
  ]));

  // A detected ride is emitted as the user-replaceable `frames` source (each frame a
  // Media-Library slot the importer sideloads + a user can swap), NOT a hotlinked pattern.
  // The frame URLs are enumerated from the pattern; the importer's media phase downloads them
  // and the pages phase rewrites each to its local attachment URL — the turnkey path.
  let backdrop = { source: 'none' };
  if (seq) {
    const frames = [];
    for (let i = 0; i < seq.count; i++) {
      frames.push({ attachment_id: '', url: seq.pattern.replace('%d', String(seq.min + i)) });
    }
    // Multi-picker: the active branch's values nest UNDER the source key (like `sequence` does),
    // so the render reads backdrop.frames.frames / backdrop.frames.fit.
    backdrop = { source: 'frames', frames: { frames, fit: 'cover' } };
  }

  return { type: 'section', _items: cols, atts: {
    unique_id: _uid(), css_class: 'sc-story',
    scrollytelling: { mode: 'crossfade', crossfade: {
      layout: 'stage', scene_length: sceneLen, backdrop,
      pin_side: 'left', media_height: 100, pin_offset: 0, activate_at: 50, transition: 0.6, intensity: 0.5, progress: 'dots',
    } },
  } };
}

/**
 * Derive a MOTION PROFILE from the tracer result — the site-wide signals worth reproducing.
 */
export function buildMotionProfile(anim) {
  if (!anim) return null;
  const p = { reveal: false, smooth: false, hoverButton: '', hoverCard: '', complexCount: 0 };
  const revealTraces = (anim.traces || []).filter((t) => t.kind === 'reveal' || t.kind === 'fade_in');
  const reveals =
    (anim.scrollTriggers || []).filter((t) => !t.pin && t.scrub === false).length +
    revealTraces.length +
    (anim.libs && anim.libs.aos ? 3 : 0);
  if (reveals >= 2) {
    // Tune the reveal from the traces: dominant direction, median distance,
    // most-common ease, and whether the reveals scrub with scroll. Falls back to
    // the old up/60/standard when the traces don't carry motion detail.
    // Drop noisy samples (smooth-scroll contamination) from the tuning — if that
    // leaves nothing, the reveal stays generic (up / 60 / preset ease), which is
    // the safe default. Noisy sites still get reveals, just not mis-tuned ones.
    const motions = revealTraces.map((t) => t.motion).filter((m) => m && !m.noisy);
    const tally = (key) => {
      const c = {};
      motions.forEach((m) => { const v = m[key]; if (v) c[v] = (c[v] || 0) + 1; });
      const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
      return top ? top[0] : '';
    };
    const dists = motions.map((m) => m.distance).filter((n) => n > 0).sort((a, b) => a - b);
    const median = dists.length ? dists[Math.floor(dists.length / 2)] : 60;
    const scrubVotes = motions.filter((m) => m.scrub).length;
    const complex = motions.filter((m) => m.complex);
    p.complexCount = complex.length;
    p.complexMotion = complex[0] || null;
    p.reveal = {
      direction: tally('direction') || 'up',
      distance: median || 60,
      ease: tally('ease') || '',
      scrub: motions.length > 0 && scrubVotes > motions.length / 2,
    };
  }
  p.smooth = !!(anim.libs && anim.libs.lenis);
  for (const h of anim.hovers || []) {
    const sel = h.selector || '';
    const c = h.changed || {};
    let fx = '';
    if (/translateY\(-/.test(c.transform || '')) fx = 'lift';
    else if (/scale\(1\.[0-9]/.test(c.transform || '')) fx = 'scale';
    else if (c.boxShadow || /box-shadow/.test(Object.keys(c).join(','))) fx = 'lift';
    else if (c.background || c.color || c.borderColor || /background|color|border/.test(Object.keys(c).join(','))) fx = 'color_shift';
    if (!fx) continue;
    if (/btn|button|cta/i.test(sel) && !p.hoverButton) p.hoverButton = fx;
    else if (/card|item|tile|thumb|image|img|box/i.test(sel) && !p.hoverCard) p.hoverCard = fx;
  }
  return (p.reveal || p.smooth || p.hoverButton || p.hoverCard) ? p : null;
}

const FX = {
  // Tier 1 (map) + Tier 2 (tune): a Reveal built from the traced direction/
  // distance, with the Advanced tier carrying the traced ease/scrub so the
  // conversion matches the source curve instead of the generic preset.
  reveal: (m) => {
    m = m || {};
    const reveal = {
      direction: m.direction || 'up', style: 'standard',
      distance: m.distance || 60, delay: 0, start: 'top 85%',
      once: m.scrub ? 'no' : 'yes', run_on_mobile: 'yes',
    };
    const custom = {};
    if (m.ease) custom.ease = m.ease;
    if (m.scrub) custom.scrub_smooth = 0.6;
    if (Object.keys(custom).length) {
      reveal.advanced = { mode: 'custom', custom: { ease: custom.ease || '', ease_custom: '', scrub_smooth: custom.scrub_smooth || 0, markers: 'no' } };
    }
    return { effect: 'reveal', reveal };
  },
  hover: (fx) => (fx === 'scale' ? { effect: 'scale', scale: { style: 'in' } } : { effect: fx, [fx]: {} }),
  // Tier 3 (fallback): motion that doesn't fit a preset (scale + translate combo)
  // is reconstructed verbatim as a data-driven Motion Snippet — the same "put the
  // un-mappable thing in the advanced escape hatch" move as Custom CSS for styling.
  // The code only ever RUNS if the page author has `unfiltered_html`.
  snippet: (m) => {
    const from = [];
    if (m.ty) from.push(`y: ${m.ty}`);
    if (m.tx) from.push(`x: ${m.tx}`);
    if (m.scaled) from.push(`scale: ${m.sx}`);
    from.push('opacity: 0');
    const ease = m.ease || 'power2.out';
    const code =
      `// Reconstructed from the captured motion (scale + move).\n` +
      `gsap.from(el, {\n  ${from.join(',\n  ')},\n  ease: '${ease}',\n  scrollTrigger: { trigger: el, start: 'top 85%' }\n});`;
    return { effect: 'custom', custom: { code } };
  },
};

/**
 * Apply the motion profile to an emitted builder page (pages.json entry) — fx blocks stamped onto
 * the nodes the converter produced, so the converted site MOVES like the source.
 */
export function applyMotionToPage(pg, anim, rec = () => {}) {
  const profile = buildMotionProfile(anim);
  if (!profile || !pg || !Array.isArray(pg.builder)) return;
  let counts = { reveal: 0, tuned: 0, snippet: 0, button: 0, card: 0 };
  // Tier 3: spend the ONE representative reconstructed snippet on the first
  // reveal target, so the captured signature scale-in survives; everything else
  // gets the tuned preset Reveal. `complexBudget` caps it at one auto-emitted
  // snippet (auto-generated executable code stays deliberately scarce).
  let complexBudget = profile.complexMotion ? 1 : 0;
  const revealTarget = /^(special_heading|text_block|media_image|image_box|icon_box)$/;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n && n.type === 'simple' && n.atts) {
        if (profile.reveal && revealTarget.test(n.shortcode) && !n.atts.gsap_motion) {
          if (complexBudget > 0 && n.shortcode === 'special_heading') {
            n.atts.gsap_motion = FX.snippet(profile.complexMotion); complexBudget--; counts.snippet++;
          } else {
            n.atts.gsap_motion = FX.reveal(profile.reveal); counts.reveal++;
            if (profile.reveal.ease || profile.reveal.scrub) counts.tuned++;
          }
        }
        if (profile.hoverButton && n.shortcode === 'button' && !n.atts.interaction) {
          n.atts.interaction = FX.hover(profile.hoverButton); counts.button++;
        }
        if (profile.hoverCard && /^(media_image|image_box|icon_box)$/.test(n.shortcode) && !n.atts.interaction) {
          n.atts.interaction = FX.hover(profile.hoverCard); counts.card++;
        }
      }
      if (n && n._items) walk(n._items);
    }
  };
  walk(pg.builder);
  if (profile.smooth) pg.smooth_scroll = 'yes';
  rec({ profile, applied: counts });
  return counts;
}

/** CSV + HTML report from a traceAnimations() result. */
export function animationReport(anim, url) {
  const rows = anim.suggestions || [];
  const csv = ['kind,target,evidence,suggested_fx,confidence']
    .concat(rows.map((r) => [r.kind, r.target, r.evidence, r.suggest, r.confidence].map(csvCell).join(',')))
    .join('\n');

  const libs = Object.entries(anim.libs || {}).filter(([, v]) => v).map(([k, v]) => k + (typeof v === 'string' ? ' ' + v : '')).join(' · ') || 'none detected';
  const html = `<!doctype html><meta charset="utf-8"><title>Animation report — ${esc(url)}</title>
<style>body{font:14px/1.5 system-ui;margin:2rem;color:#1a1a1a}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:.45rem .6rem;text-align:left;vertical-align:top}th{background:#f5f5f5}
.high{color:#0a7d38;font-weight:600}.medium{color:#a06a00}.low{color:#888}
code{background:#f4f4f4;padding:0 .3em;border-radius:4px}</style>
<h1>Animation report</h1>
<p><b>${esc(url)}</b> — libraries: ${esc(libs)}${anim.hijack && anim.hijack.virtualScroll ? ' · <b>scroll-hijacked page</b>' : ''}</p>
<table><tr><th>kind</th><th>target</th><th>evidence</th><th>suggested UnysonPlus fx</th><th>conf.</th></tr>
${rows.map((r) => `<tr><td>${esc(r.kind)}</td><td><code>${esc(r.target)}</code></td><td>${esc(r.evidence)}</td><td><code>${esc(r.suggest)}</code></td><td class="${esc(r.confidence)}">${esc(r.confidence)}</td></tr>`).join('\n')}
</table>
<p>${rows.length} finding(s). Machine-readable copy: <code>animations.json</code>.</p>`;
  return { csv, html };
}
