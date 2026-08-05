// Shared in-page extraction for the design-capture pipeline.
// Runs INSIDE the rendered page (headless Chrome) via page.evaluate() — used by both
// the local CLI (capture.mjs) and the hosted Cloudflare Worker. Must be fully
// self-contained: every helper is defined inline; only browser globals are referenced.
export function extractDesign() {
  const pick = (s, keys) => { const o = {}; if (s) keys.forEach((k) => (o[k] = s[k])); return o; };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const hasBg = (c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';

  // --- structured-content helpers (for the body/footer "copy the whole thing" path) ---
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n).trim() : (s || ''));
  const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Capture a heading's *formatting* (bold / italic / line-breaks) as safe semantic
  // HTML, so the converter reproduces e.g. "<strong>Routing with a</strong><br>
  // <em>Pulse.</em>" instead of flattening it to plain text. Returns '' if there's
  // no inline formatting (caller falls back to plain text).
  const richHeading = (el) => {
    const base = getComputedStyle(el);
    const baseColor = base.color;                       // the heading's own color; a child in a DIFFERENT color is a highlight
    const baseWeight = parseInt(base.fontWeight, 10) || 400;
    let html = '', sawTag = false;
    const walk = (node, pWeight) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { html += escHtml(n.textContent); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        if (tag === 'br') { html += '<br>'; sawTag = true; continue; }
        // An inline <svg> in a heading is a DECORATIVE graphic — a hand-drawn underline / highlight
        // squiggle (FreshPaws: a `<path d="M0 5 Q 50 10 100 5">` under "Second Home"). Keep it VERBATIM;
        // the default accent-span reconstruction below only rebuilds TEXT, so it drops the <path> and the
        // graphic vanishes. The svg's own classes (absolute / w-full / text-secondary) ride along.
        if (tag === 'svg') { html += n.outerHTML.replace(/\s+/g, ' ').trim(); sawTag = true; continue; }
        const s = getComputedStyle(n);
        const w = parseInt(s.fontWeight, 10) || pWeight;
        // Bold only when this child is genuinely BOLDER than its surroundings (or a real <b>/<strong>),
        // so a <span> that merely inherits a heading's weight isn't wrongly wrapped in <strong>.
        const bold = tag === 'b' || tag === 'strong' || w > pWeight;
        const ital = tag === 'em' || tag === 'i' || s.fontStyle === 'italic';
        // A coloured highlight (source `<span class="text-color-primary">`, Tailwind `text-primary`,
        // inline color, …) — detected by COMPUTED color, not the class name, so it's framework-agnostic.
        // Keep the SOURCE class verbatim (the child theme paints it); fall back to inline color if classless.
        const accent = s.color && baseColor && s.color !== baseColor && !/^rgba?\(0,\s*0,\s*0,\s*0\)$/.test(s.color.replace(/\s+/g, ''));
        const before = html.length;
        walk(n, w);
        let inner = html.slice(before);
        if (inner === '') { inner = escHtml(n.textContent); }
        html = html.slice(0, before);
        if (bold && ital) { inner = `<strong><em>${inner}</em></strong>`; }
        else if (bold) { inner = `<strong>${inner}</strong>`; }
        else if (ital) { inner = `<em>${inner}</em>`; }
        if (accent) {
          const acls = ((n.getAttribute && n.getAttribute('class')) || '').replace(/["<>]/g, '').trim();
          // A Tailwind color class is DEAD in the builder (no Tailwind runtime) — an arbitrary
          // `text-[#hex]` or a palette `text-pink-600`. Convert those to an inline color from the
          // COMPUTED value so the accent survives. A semantic/theme class (`text-primary`,
          // `text-color-primary`) is kept verbatim so the theme still paints (and can re-theme) it.
          const deadColorClass = /(^|\s)text-\[/.test(acls)
            || /(^|\s)text-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(\s|$)/.test(acls);
          inner = (acls && !deadColorClass)
            ? `<span class="${acls}">${inner}</span>`
            : `<span style="color:${s.color}">${inner}</span>`;
        }
        if (bold || ital || accent) { sawTag = true; }
        html += inner;
      }
    };
    walk(el, baseWeight);
    return sawTag ? html.replace(/\s+/g, ' ').trim() : '';
  };
  const cls = (el) => (el && el.className && el.className.toString ? el.className.toString().toLowerCase() : '');
  const looksButton = (el) => {
    if (!el) return false;
    if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return true;
    if (/\b(btn|button|cta)\b/.test(cls(el))) return true;
    return el.tagName === 'A' && hasBg(getComputedStyle(el).backgroundColor);
  };
  // Interaction state (:hover) — the capture used to DROP hover, so a source's button/link
  // hover color was never translated. Resolve it from the element's `hover:*` utilities:
  // arbitrary values (`hover:bg-[#ff85a1]`) are parsed directly; named ones (`hover:bg-pink-400`)
  // are resolved by probing the page's own compiled CSS. Returns {backgroundColor,color,borderColor}.
  let _hoverProbe = null;
  const hoverStyle = (el) => {
    if (!el || !el.getAttribute) return null;
    const hoverCls = (el.getAttribute('class') || '').split(/\s+/).filter((c) => c.startsWith('hover:'));
    if (!hoverCls.length) return null;
    if (!_hoverProbe) { _hoverProbe = document.createElement('div'); _hoverProbe.style.cssText = 'position:absolute;left:-99999px;top:-99999px;'; document.body.appendChild(_hoverProbe); }
    const arb = /^(bg|text|border)-\[(.+)\]$/;
    const out = {};
    for (const hc of hoverCls) {
      const base = hc.slice(6);
      let prop;
      if (base.startsWith('bg-')) prop = 'backgroundColor';
      else if (base.startsWith('text-')) prop = 'color';
      else if (base.startsWith('border-')) prop = 'borderColor';
      else continue;
      const m = arb.exec(base);
      let val;
      if (m) { val = m[2].replace(/_/g, ' '); }
      else { _hoverProbe.className = base; const cs = getComputedStyle(_hoverProbe); val = prop === 'backgroundColor' ? cs.backgroundColor : prop === 'color' ? cs.color : (cs.borderTopColor || cs.borderColor); }
      if (val && val !== 'rgba(0, 0, 0, 0)' && val !== 'transparent') out[prop] = val;
    }
    return Object.keys(out).length ? out : null;
  };
  // A leading icon: a Material-symbol ligature span, an [class*=icon] glyph, or an <svg> aria-label.
  const iconOf = (el) => {
    const ic = el.querySelector('.material-symbols-outlined, .material-icons, [class*="icon"]');
    if (ic) { const t = txt(ic); if (t && t.length <= 24 && !/\s/.test(t)) return t; }
    const svg = el.querySelector('svg');
    if (svg) return svg.getAttribute('aria-label') || 'svg';
    return '';
  };
  const imgIn = (el) => {
    const im = el.querySelector('img');
    if (im && (im.currentSrc || im.src)) return abs(im.currentSrc || im.src);
    for (const n of [el, ...el.querySelectorAll('*')]) {
      const b = getComputedStyle(n).backgroundImage;
      const m = b && b.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1] && !m[1].startsWith('data:')) return abs(m[1]);
    }
    return '';
  };
  const collectButtons = (root) => {
    const out = [];
    const seen = new Set();
    root.querySelectorAll('a, button').forEach((el) => {
      if (!looksButton(el)) return;
      const label = txt(el);
      if (!label || label.length > 40 || seen.has(label)) return;
      seen.add(label);
      out.push({ label, href: abs(el.getAttribute('href') || ''), primary: hasBg(getComputedStyle(el).backgroundColor) });
    });
    return out.slice(0, 6);
  };
  // The best uniform set of sibling "cards" in a section (features / steps / logos).
  // Prefer grids whose children each carry a heading (the strong signal of a real
  // card list) over incidental uniform rows (stats, logos, showcase blocks).
  const collectCards = (sec) => {
    let best = null;
    let bestScore = 0;
    sec.querySelectorAll('*').forEach((container) => {
      const kids = [...container.children].filter((k) => k.tagName !== 'STYLE' && k.tagName !== 'SCRIPT');
      if (kids.length < 3) return;
      const tag0 = kids[0].tagName;
      if (!kids.every((k) => k.tagName === tag0)) return;
      const withHeading = kids.filter((k) => k.querySelector('h2,h3,h4,h5,h6')).length;
      const withText = kids.filter((k) => k.querySelector('p')).length;
      const rich = Math.max(withHeading, withText);
      if (rich < Math.ceil(kids.length * 0.6)) return;
      // Heading-bearing grids win decisively; then text coverage; then count.
      const score = withHeading * 1000 + rich * 10 + kids.length;
      if (score > bestScore) { bestScore = score; best = kids; }
    });
    if (!best) return [];
    return best.slice(0, 12).map((k) => {
      const h = k.querySelector('h3,h4,h5,h6') || k.querySelector('strong,b');
      const p = k.querySelector('p');
      const title = clip(txt(h), 120);
      const body = p ? txt(p) : (h ? txt(k).replace(txt(h), '').trim() : txt(k));
      // Leading step number (01 / 1 / 12 …) if the card is a numbered step.
      const numEl = [...k.querySelectorAll('*')].find((e) => e.children.length === 0 && /^(0[1-9]|[1-9]|1[0-2])$/.test(txt(e)));
      return { number: numEl ? txt(numEl) : '', icon: iconOf(k), title, text: clip(body, 300), image: imgIn(k) };
    }).filter((c) => c.title || c.text || c.image);
  };
  const overlineOf = (heading) => {
    if (!heading) return '';
    const prev = heading.previousElementSibling;
    if (prev) {
      const t = txt(prev);
      // Skip Material-symbol ligatures (e.g. "rocket_launch") that sit above headings.
      if (t && t.length > 1 && t.length < 40 && !/^[a-z]+(_[a-z]+)+$/.test(t)) return t;
    }
    return '';
  };
  // Find a section's decorative background pattern — an SVG data-URI or repeating
  // gradient overlay (e.g. the hero's faint "+" grid). Self-contained values only
  // (data-URI / gradient), so the generator can reproduce them verbatim in CSS.
  const findPattern = (sec) => {
    const els = [sec, ...sec.querySelectorAll('div')].slice(0, 60);
    for (const el of els) {
      for (const s of [getComputedStyle(el), getComputedStyle(el, '::before'), getComputedStyle(el, '::after')]) {
        const bg = s.backgroundImage;
        if (!bg || bg === 'none' || bg.length > 2000) continue;
        if (!/data:image\/svg|repeating-(linear|radial)-gradient/i.test(bg)) continue;
        return { image: bg, repeat: s.backgroundRepeat, size: s.backgroundSize, opacity: Math.min(1, parseFloat(s.opacity) || 1) };
      }
    }
    return null;
  };
  // Classify a bento tile by what it carries: showcase (image), stat (a number +
  // label, no heading), feature (heading + text), else plain.
  const tileKind = (el) => {
    if (el.querySelector('img')) return 'showcase';
    const h = el.querySelector('h3,h4,h5,strong');
    const t = txt(el);
    if (!h && /\d/.test(t) && t.length < 40 && /^[\s\d.,%h$+kKmM]+/.test(t)) return 'stat';
    return h ? 'feature' : 'plain';
  };
  // Capture EVERY grid of tiles in a section (a bento is several stacked grids:
  // showcase + features, a stat band, a feature row …). The generic single-grid
  // card scan misses all but one — this returns them all, each row's tiles typed.
    // A grid-like container's tile children: a real CSS `display:grid`, OR a Bootstrap-style
    // flex row whose children carry a `col-*` class (Bootstrap is flexbox, not CSS grid — the
    // plugin itself is Bootstrap, so source Bootstrap grids map cleanly to columns).
    const gridTiles = (el) => {
      const d = getComputedStyle(el).display;
      if (d === 'grid') return [...el.children].filter((k) => txt(k));
      if (d === 'flex' || d === 'inline-flex') {
        const cols = [...el.children].filter((k) =>
          / col(-|\s|$)/.test(' ' + (k.className || '').toString() + ' ') && txt(k));
        if (cols.length >= 2) return cols;
      }
      return null;
    };
  const findGrids = (sec) => {
    const out = [];
    const seen = new Set();
    sec.querySelectorAll('*').forEach((el) => {
      const kids = gridTiles(el);
      if (!kids) return;
      if (kids.length < 2 || kids.length > 12) return;
      if (kids.some((k) => gridTiles(k))) return; // a wrapper of grids/rows
      const tiles = kids.map((k) => {
        const kind = tileKind(k);
        if (kind === 'stat') {
          // Capture an optional leading currency/sign ($ € £ ₱ +) WITH the number so it
          // becomes the counter's prefix — otherwise it gets stranded on the caption
          // (e.g. "$45,280Total Raised" → stat "$45,280", label "Total Raised").
          const m = txt(k).match(/[$€£₱+]?\s*[\d.,]+\s*[%hKkMm+]*/);
          const stat = m ? m[0].trim() : txt(k);
          return { kind, stat, label: clip(txt(k).replace(m ? m[0] : '', '').trim(), 40) };
        }
        const h = k.querySelector('h3,h4,h5,strong');
        const p = k.querySelector('p');
        const body = p ? txt(p) : (h ? txt(k).replace(txt(h), '').trim() : '');
        return { kind, title: clip(txt(h), 80), text: clip(body, 220), icon: iconOf(k), image: imgIn(k) };
      }).filter((t) => t.title || t.text || t.stat || t.image);
      if (!tiles.length) return;
      const sig = tiles.map((t) => t.title || t.stat || '').join('|');
      if (seen.has(sig)) return;
      seen.add(sig);
      out.push({ cols: kids.length, tiles });
    });
    return out.slice(0, 5);
  };

  // --- tokens ---
  const rootCS = getComputedStyle(document.documentElement);
  const vars = {};
  for (const name of rootCS) { if (name.startsWith('--')) { const v = rootCS.getPropertyValue(name).trim(); if (v && v.length < 60) vars[name] = v; } }
  const bodyCS = getComputedStyle(document.body);

  // --- header chrome ---
  // A full-viewport <header> that holds the H1 + CTA (openhero-style: `<header class="min-h-screen">`,
  // with the real nav in a SEPARATE <nav>) is a HERO band, not the site masthead. Tell them apart:
  // a masthead is short and nav-like; a hero is tall (~min-h-screen) with a big heading and is not a
  // dense link bar. Used both to pick the right chrome element AND to let a hero header become a body
  // section below (so its H1/subtitle/CTA aren't lost as "chrome").
  const _vh = window.innerHeight || 800;
  const isHeroHeader = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.height < _vh * 0.6) return false;                       // masthead-height → not a hero
    if (!el.querySelector('h1, h2')) return false;                // a hero leads with a big heading
    const navLinks = [...el.querySelectorAll('a, button')].filter((a) => { const t = a.textContent.trim(); return t && t.length < 30; });
    return !(r.height <= 200 && navLinks.length >= 3);            // a short dense link bar is a nav, not a hero
  };
  let headerEl = document.querySelector('header') || document.querySelector('[role=banner]');
  const _heroAsHeader = isHeroHeader(headerEl);
  if (!headerEl || _heroAsHeader) {
    // SPA sites (Lovable / v0 / React) often skip <header> — the nav is a top-pinned bar. Also used
    // when the first <header> is really a hero: find the SEPARATE top nav bar and use IT as the
    // masthead. Topmost <nav>/navbar-classed element at the very top, full-ish width, ≥2 links/buttons.
    const cands = [...document.querySelectorAll('nav, [class*="navbar" i], [class*="header" i]')];
    const navBar = cands
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el, r }) => r.top <= 8 && r.height > 0 && r.height <= 130 && r.width >= 300
        && el.querySelectorAll('a, button').length >= 2)
      .sort((a, b) => a.r.top - b.r.top)
      .map(({ el }) => el)[0] || null;
    // Only swap away from a hero header when a DISTINCT masthead nav exists (not one nested inside the
    // hero). Otherwise keep the original (a header that bundles its own nav stays chrome, as before).
    if (navBar && (!headerEl || !headerEl.contains(navBar))) headerEl = navBar;
  }
  let header = null;
  if (headerEl) {
    // <a> AND <button>: SPA logos / CTAs are often buttons that route via JS.
    const links = [...headerEl.querySelectorAll('a, button')];
    const logoImg = headerEl.querySelector('img');
    // The header CTA is the button-styled action link — detected by a filled background OR a
    // button class (so OUTLINE buttons like `.btn.btn-solid-border` count too), excluding the
    // mobile-menu toggle. Last match wins (the CTA usually sits at the end of the bar).
    const cta = [...links].reverse().find((a) => {
      const c = (a.className && a.className.toString) ? a.className.toString() : '';
      if (/\b(toggle|toggler|hamburger|menu-?icon|navbar-toggler|search)\b/i.test(c)) return false;
      if (!a.textContent.trim()) return false;
      return hasBg(getComputedStyle(a).backgroundColor) || /\b(btn|button|cta)\b/i.test(c);
    });
    const logoLink = links.find((a) => a !== cta && (a.querySelector('img') || a.textContent.trim()));
    // Nav items may be <a> OR <button> (SPAs route via JS) — pull both from <nav> if present.
    const navEl = headerEl.querySelector('nav');
    const navLinks = [...(navEl || headerEl).querySelectorAll('a, button')]
      .filter((el) => el !== cta && el !== logoLink && !el.querySelector('img'))
      .filter((el) => { const t = el.textContent.trim(); return t && t.length < 30; });
    const hcs = getComputedStyle(headerEl);
    const inner = headerEl.firstElementChild ? getComputedStyle(headerEl.firstElementChild) : null;
    // Brand-mark icon → a Lucide id, so the plugin reproduces the native Logo Icon (icon + wordmark)
    // instead of baking the mark into an image. Sniffs data-lucide / lucide-<name> class /
    // iconify <… icon="lucide:<name>">. Mirrors the PHP detect_lucide_in().
    const logoIcon = (scope) => {
      if (!scope) return '';
      const i = scope.querySelector('[data-lucide], i[class*="lucide-"], [icon^="lucide:"]');
      if (!i) return '';
      const dl = i.getAttribute('data-lucide');
      if (dl) return 'lucide/' + dl.trim().toLowerCase();
      const ic = i.getAttribute('icon') || '';
      const m = ic.match(/^lucide:([a-z0-9-]+)$/i);
      if (m) return 'lucide/' + m[1].toLowerCase();
      const cls = (i.className && i.className.baseVal !== undefined ? i.className.baseVal : i.className) || '';
      const cm = String(cls).match(/\blucide-([a-z0-9-]+)/);
      return cm ? 'lucide/' + cm[1] : '';
    };
    header = {
      element: pick(hcs, ['display', 'justifyContent', 'alignItems', 'backgroundColor', 'position', 'padding']),
      bar: pick(inner, ['display', 'justifyContent', 'backgroundColor', 'borderRadius', 'border', 'padding', 'maxWidth', 'backdropFilter']),
      logo: logoImg ? { type: 'image', src: abs(logoImg.currentSrc || logoImg.src) }
        : (logoLink ? { type: 'text', text: logoLink.textContent.trim(), icon: logoIcon(logoLink), computed: pick(getComputedStyle(logoLink), ['fontFamily', 'fontSize', 'fontWeight', 'color', 'letterSpacing']) } : null),
      nav: navLinks.map((a) => ({ label: a.textContent.trim(), href: abs(a.getAttribute('href') || ''), computed: pick(getComputedStyle(a), ['fontFamily', 'fontSize', 'fontWeight', 'color']) })),
      cta: cta ? { label: cta.textContent.trim(), href: abs(cta.getAttribute('href') || ''), computed: pick(getComputedStyle(cta), ['backgroundColor', 'color', 'borderRadius', 'padding', 'fontFamily', 'fontWeight']), hover: hoverStyle(cta) } : null,
    };
  }

  // --- footer (chrome + full content for the "copy the whole thing" path) ---
  const footerEl = document.querySelector('footer') || document.querySelector('[role=contentinfo]');
  let footer = null;
  if (footerEl) {
    const allText = txt(footerEl);
    const footerLinks = [...footerEl.querySelectorAll('a')];
    // Social = icon-only links (no text but an svg/img/aria-label).
    const social = footerLinks
      .filter((a) => !txt(a) && (a.querySelector('svg,img') || a.getAttribute('aria-label')))
      .map((a) => ({ label: a.getAttribute('aria-label') || '', href: abs(a.getAttribute('href') || '') }))
      .slice(0, 12);
    const textLinks = footerLinks.filter((a) => txt(a)).map((a) => ({ label: txt(a), href: abs(a.getAttribute('href') || '') }));
    // Column groups — a <ul>/<nav> of ≥2 links, with its heading if any. Deduped by link-set.
    const groups = [];
    const gseen = new Set();
    [...footerEl.querySelectorAll('ul, nav')].forEach((col) => {
      const ls = [...col.querySelectorAll('a')].filter((a) => txt(a));
      if (ls.length < 2) return;
      const h = col.querySelector('h2,h3,h4,h5,h6,strong,b')
        || (col.previousElementSibling && /^(H[2-6]|STRONG|B)$/.test(col.previousElementSibling.tagName) ? col.previousElementSibling : null);
      const links = ls.map((a) => ({ label: txt(a), href: abs(a.getAttribute('href') || '') })).slice(0, 12);
      const key = links.map((l) => l.label).join('|');
      if (gseen.has(key)) return;
      gseen.add(key);
      groups.push({ title: clip(h ? txt(h) : '', 60), links });
    });
    const brandEl = footerEl.querySelector('.logo, [class*="brand"], h1, h2, h3, strong');
    const ci = allText.search(/©|\(c\)\s|copyright/i);
    footer = {
      computed: pick(getComputedStyle(footerEl), ['backgroundColor', 'color', 'padding']),
      brand: brandEl ? clip(txt(brandEl), 60) : '',
      groups: groups.slice(0, 6),
      social,
      copyright: ci >= 0 ? clip(allText.slice(ci), 200) : '',
      links: textLinks.slice(0, 40), // flat fallback
      text: clip(allText, 500),
    };
  }

  // --- body sections (full block model for the "copy the whole thing" path) ---
  const main = document.querySelector('main') || document.body;
  // Body bands = the OUTERMOST <section>s anywhere under main, at any nesting depth. (This used to
  // be a hardcoded 3-level selector — `:scope > section, :scope > div > section,
  // :scope > div > div > section` — which silently matched NOTHING on the very common WordPress
  // wrapper chain `main > article > div.entry-content > div > section`, converting such pages to an
  // empty page. Depth-agnostic + outermost-only keeps nested sections from double-counting.)
  const allSections = [...main.querySelectorAll('section')];
  const sectionEls = allSections
    .filter((s) => !allSections.some((o) => o !== s && o.contains(s)))
    .slice(0, 40);
  // A hero rendered as a top-level <header> (not the chosen masthead) is real body content, not chrome
  // — fold it into the section list in DOM order so its H1/subtitle/CTA convert like any other band.
  const heroEls = [...document.querySelectorAll('header')].filter((el) => el !== headerEl && isHeroHeader(el));
  for (const h of heroEls) {
    if (!sectionEls.includes(h)) {
      const at = sectionEls.findIndex((s) => (h.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      if (at === -1) sectionEls.push(h); else sectionEls.splice(at, 0, h);   // keep document order
    }
  }
  const sections = sectionEls.map((sec) => {
    const heading = sec.querySelector('h1,h2,h3');
    const cards = collectCards(sec);
    const paragraphs = [...sec.querySelectorAll('p')].map(txt).filter((t) => t.length > 1).slice(0, 8).map((t) => clip(t, 600));
    const images = [];
    sec.querySelectorAll('img').forEach((im) => { const s = abs(im.currentSrc || im.src || ''); if (s && /^https?:/.test(s)) images.push(s); });
    const bgImg = imgIn(sec);
    if (bgImg && /^https?:/.test(bgImg)) images.push(bgImg);
    const overlineText = overlineOf(heading);
    const overlineEl = (overlineText && heading) ? heading.previousElementSibling : null;
    return {
      heading: heading ? txt(heading) : '',
      headingHtml: heading ? richHeading(heading) : '',
      level: heading ? Number(heading.tagName.slice(1)) : 0,
      headingComputed: heading ? pick(getComputedStyle(heading), ['fontFamily', 'fontSize', 'fontWeight', 'color']) : null,
      overline: overlineText,
      overlineComputed: overlineEl ? pick(getComputedStyle(overlineEl), ['backgroundColor', 'color', 'textTransform', 'letterSpacing', 'borderRadius', 'fontSize']) : null,
      lead: paragraphs[0] || '',
      paragraphs,
      buttons: collectButtons(sec),
      cards,
      images: [...new Set(images)].slice(0, 8),
      grids: findGrids(sec),
      bgPattern: findPattern(sec),
      computed: pick(getComputedStyle(sec), ['backgroundColor', 'padding', 'textAlign', 'color']),
      text: clip(txt(sec), 1500),
    };
  });

  // --- generic DOM mirror (the "clone any site" foundation) -------------------
  // Walk the rendered body into a FLATTENED, typed tree carrying the computed styles
  // that matter, so the mapper can rebuild a faithful + editable UnysonPlus page for
  // ANY site (the archetype recognizers refine the sections we know on top of this).
  const visibleEl = (el) => {
    const s = getComputedStyle(el);
    // NOTE: don't treat opacity:0 as hidden — scroll-reveal animations leave
    // below-the-fold content at opacity 0 when we're scrolled to the top, and that
    // content is real (just animated in). Filtering it would collapse whole sections.
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEADER', 'FOOTER', 'NAV', 'SVG', 'PATH', 'IFRAME']);

  // --- Tailwind class-name → design-token translation -------------------------
  // Tailwind class names ARE the design-token source of truth (`shadow-lg` is the
  // "large shadow" TOKEN, not an anonymous pixel value). getComputedStyle resolves
  // them to final values, but the token name is what maps cleanly onto our preset
  // SCALES (shadow / radius / spacing). We parse the SCALE utilities here — colours
  // stay resolved-hex from getComputedStyle — so the mapper can pick a Button Size/
  // Colour Preset deterministically instead of guessing. Default Tailwind config.
  const TW_SP = { '0':'0px','0.5':'2px','1':'4px','1.5':'6px','2':'8px','2.5':'10px','3':'12px','3.5':'14px','4':'16px','5':'20px','6':'24px','7':'28px','8':'32px','9':'36px','10':'40px','11':'44px','12':'48px','14':'56px','16':'64px','20':'80px','24':'96px' };
  const TW_SHADOW = { sm:'0 1px 2px 0 rgba(0,0,0,0.05)', DEFAULT:'0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1)', md:'0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)', lg:'0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)', xl:'0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)', '2xl':'0 25px 50px -12px rgba(0,0,0,0.25)' };
  const TW_RADIUS = { none:'0px', sm:'2px', DEFAULT:'4px', md:'6px', lg:'8px', xl:'12px', '2xl':'16px', '3xl':'24px', full:'9999px' };
  const TW_FW = { thin:'100', extralight:'200', light:'300', normal:'400', medium:'500', semibold:'600', bold:'700', extrabold:'800', black:'900' };
  const TW_FS = { xs:['12px','16px'], sm:['14px','20px'], base:['16px','24px'], lg:['18px','28px'], xl:['20px','28px'], '2xl':['24px','32px'], '3xl':['30px','36px'], '4xl':['36px','40px'], '5xl':['48px','1'], '6xl':['60px','1'], '7xl':['72px','1'] };
  const twTokens = (cls) => {
    cls = (cls || '').toString(); if (!cls) return null;
    const c = ' ' + cls.replace(/\s+/g, ' ') + ' ';
    const grab = (re) => { const m = c.match(re); return m ? m[1] : null; };
    const t = {};
    // shadow  (shadow-lg / bare shadow; ignore shadow-{color} & shadow-none/inner via the whitelist)
    const sh = grab(/ shadow-(sm|md|lg|xl|2xl) /) || (/ shadow / .test(c) ? 'DEFAULT' : null);
    if (sh) { t.shadow = sh; t.shadowCss = TW_SHADOW[sh]; }
    // radius (arbitrary [40px] wins, then scale, then bare `rounded`)
    const radArb = grab(/ rounded-\[([^\]]+)\] /);
    const radScale = grab(/ rounded-(none|sm|md|lg|xl|2xl|3xl|full) /);
    if (radArb) t.radius = radArb; else if (radScale) t.radius = TW_RADIUS[radScale]; else if (/ rounded /.test(c)) t.radius = TW_RADIUS.DEFAULT;
    // border width
    const bw = grab(/ border-(0|2|4|8) /); if (bw) t.borderWidth = bw + 'px'; else if (/ border /.test(c)) t.borderWidth = '1px';
    // padding / gap (scale)
    const px = grab(/ px-(\d+(?:\.5)?) /); if (px && TW_SP[px]) t.px = TW_SP[px];
    const py = grab(/ py-(\d+(?:\.5)?) /); if (py && TW_SP[py]) t.py = TW_SP[py];
    const gp = grab(/ gap-(\d+(?:\.5)?) /); if (gp && TW_SP[gp]) t.gap = TW_SP[gp];
    // font weight + size(+lh)
    const fw = grab(/ font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black) /); if (fw) t.fontWeight = TW_FW[fw];
    const fs = grab(/ text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl) /); if (fs && TW_FS[fs]) { t.fontSize = TW_FS[fs][0]; t.lineHeight = TW_FS[fs][1]; }
    return Object.keys(t).length ? t : null;
  };
  // Site-level: is this source built with Tailwind? (utility-class density + signatures)
  const detectTailwind = () => {
    let hits = 0, n = 0;
    const sig = /(^| )(flex|grid|px-\d|py-\d|gap-\d|rounded-(full|lg|xl)|shadow-(sm|md|lg|xl)|text-(xs|sm|lg|xl|\dxl)|font-(bold|semibold|medium)|bg-\[|text-\[|w-\[|items-center|justify-center)( |$)/;
    for (const el of document.querySelectorAll('div,a,button,section,span,p')) {
      const cl = (el.className && el.className.toString) ? el.className.toString() : '';
      if (!cl) continue; n++; if (sig.test(' ' + cl + ' ')) hits++;
      if (n > 400) break;
    }
    return n > 0 && hits / n > 0.25;
  };

  const styleOf = (el, role) => {
    const s = getComputedStyle(el);
    const o = {};
    const set = (k, v, ...defs) => { v = (v || '').toString().trim(); if (v && !defs.includes(v)) o[k] = v; };
    set('textAlign', s.textAlign, 'start', 'left');
    if (hasBg(s.backgroundColor)) o.bg = s.backgroundColor;
    if (s.backgroundImage !== 'none' && s.backgroundImage.length < 2000) o.bgImage = s.backgroundImage;
    set('padding', s.padding, '0px');
    set('borderRadius', s.borderRadius, '0px');
    set('boxShadow', s.boxShadow, 'none');
    if (s.borderTopWidth !== '0px' && s.borderTopStyle !== 'none') o.border = `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`;
    if (role === 'container') {
      if (s.display === 'flex' || s.display === 'inline-flex') o.flex = { dir: s.flexDirection, justify: s.justifyContent, align: s.alignItems, gap: s.gap, wrap: s.flexWrap };
      else if (s.display === 'grid') o.grid = { cols: s.gridTemplateColumns, gap: s.gap };
      if (s.maxWidth !== 'none') o.maxWidth = s.maxWidth;
    } else {
      set('color', s.color);
      set('fontFamily', s.fontFamily);
      set('fontSize', s.fontSize);
      set('fontWeight', s.fontWeight, '400', 'normal');
      set('letterSpacing', s.letterSpacing, 'normal');
      set('lineHeight', s.lineHeight, 'normal');
      set('textTransform', s.textTransform, 'none');
    }
    // Full design properties the curated capture used to DROP — so wavy underlines,
    // keyframe animations, one-off transforms and interaction states are preserved.
    if (s.textDecorationLine && s.textDecorationLine !== 'none') {
      o.textDecoration = `${s.textDecorationLine} ${s.textDecorationStyle} ${s.textDecorationColor} ${s.textDecorationThickness}`.replace(/\s+/g, ' ').trim();
    }
    if (s.animationName && s.animationName !== 'none') {
      o.animation = `${s.animationName} ${s.animationDuration} ${s.animationTimingFunction} ${s.animationIterationCount}`.replace(/\s+/g, ' ').trim();
    }
    if (s.transform && s.transform !== 'none') o.transform = s.transform;
    if (s.transition && s.transition !== 'all 0s ease 0s' && s.transition !== 'none 0s ease 0s') o.transition = s.transition;
    const hv = hoverStyle(el); // {backgroundColor?,color?,borderColor?} from hover:* utilities
    if (hv) o.hover = hv;
    // Tailwind token intent (shadow/radius/spacing SCALE names) so the mapper can pick
    // a preset-scale value deterministically instead of guessing from raw px. Colours
    // stay resolved-hex above. Only attaches when the class list carries scale tokens.
    const tw = twTokens((el.className && el.className.toString) ? el.className.toString() : '');
    if (tw) o.tw = tw;
    return o;
  };
  let mirrorCount = 0;
  const mirrorNode = (el, depth) => {
    if (depth > 14 || mirrorCount > 600 || !el || el.nodeType !== 1 || SKIP_TAGS.has(el.tagName) || !visibleEl(el)) return null;
    const tag = el.tagName;
    if (tag === 'IMG') { const src = abs(el.currentSrc || el.src || ''); if (!/^https?:/.test(src)) return null; mirrorCount++; return { role: 'image', src, alt: el.alt || '', styles: styleOf(el, 'image') }; }
    if (/^H[1-6]$/.test(tag)) { mirrorCount++; return { role: 'heading', level: Number(tag[1]), html: richHeading(el) || escHtml(txt(el)), text: txt(el), styles: styleOf(el, 'heading') }; }
    if ((tag === 'A' || tag === 'BUTTON') && looksButton(el)) { mirrorCount++; return { role: 'button', label: txt(el), href: abs(el.getAttribute('href') || ''), styles: styleOf(el, 'button') }; }
    const kids = [...el.children].filter((c) => !SKIP_TAGS.has(c.tagName) && visibleEl(c));
    if (tag === 'P' || kids.length === 0) {
      const t = txt(el); if (!t) return null;
      if (/^[a-z]+(_[a-z]+)+$/.test(t)) return null; // a Material-symbol ligature, not content
      mirrorCount++;
      return { role: 'text', html: richHeading(el) || escHtml(t), text: t, styles: styleOf(el, 'text') };
    }
    const children = [];
    for (const c of kids) { const m = mirrorNode(c, depth + 1); if (m) children.push(m); }
    if (!children.length) { const t = txt(el); if (!t) return null; mirrorCount++; return { role: 'text', html: escHtml(t), text: t, styles: styleOf(el, 'text') }; }
    const styles = styleOf(el, 'container');
    const ownStyle = styles.bg || styles.bgImage || styles.padding || styles.border || styles.boxShadow || styles.borderRadius || styles.maxWidth || styles.flex || styles.grid;
    // Flatten: unwrap a styleless single-child wrapper (keeps the tree clean).
    if (children.length === 1 && children[0].role === 'container' && !ownStyle) return children[0];
    return { role: 'container', tag: tag.toLowerCase(), styles, children };
  };
  // Attach each section's own mirror subtree — the hybrid uses it as the faithful
  // fallback when no archetype recognizes the section (per-section node budget).
  sectionEls.forEach((el, i) => {
    if (!sections[i]) return;
    mirrorCount = 0;
    const m = mirrorNode(el, 0);
    sections[i].mirror = m && m.children ? m : (m ? { role: 'container', children: [m], styles: {} } : null);
  });

  // --- assets ---
  const imgs = new Set();
  document.querySelectorAll('img').forEach((i) => {
    if (i.currentSrc) imgs.add(abs(i.currentSrc)); else if (i.src) imgs.add(abs(i.src));
    if (i.srcset) i.srcset.split(',').forEach((s) => { const u = s.trim().split(' ')[0]; if (u) imgs.add(abs(u)); });
  });
  document.querySelectorAll('*').forEach((el) => {
    const b = getComputedStyle(el).backgroundImage;
    if (b && b !== 'none') { const m = b.match(/url\(["']?(.*?)["']?\)/); if (m && m[1] && !m[1].startsWith('data:')) imgs.add(abs(m[1])); }
  });
  const fonts = [...new Set([...document.querySelectorAll('link[href*="font"]')].map((l) => l.href))];

  // --- brand color ---
  // The site's true brand color is usually the fill of its action buttons (e.g. a gold
  // `.btn`), NOT the `--primary` CSS var — sites that bundle Bootstrap keep `--primary`
  // at the framework default (#007bff) and brand only via custom button classes. Scan
  // every button-ish element, tally non-neutral background colors, and return the most
  // common one as `tokens.brandColor` so the theme/style-guide can prefer it.
  const toRGB = (c) => {
    const m = /^rgba?\(([^)]+)\)/i.exec(String(c || '').trim());
    if (m) { const p = m[1].split(',').map((s) => parseFloat(s)); return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]]; }
    return null;
  };
  const isNeutralRGB = (rgb) => !rgb || rgb[3] < 0.1 || (Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2])) <= 24;
  const brandTally = {};
  const brandHoverByKey = {}; // the :hover state of the brand-filled button (used to be dropped)
  document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"]').forEach((el) => {
    if (!looksButton(el)) return;
    const bg = getComputedStyle(el).backgroundColor;
    const rgb = toRGB(bg);
    if (isNeutralRGB(rgb)) return;
    const key = `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`;
    brandTally[key] = (brandTally[key] || 0) + 1;
    if (!brandHoverByKey[key]) { const h = hoverStyle(el); if (h) brandHoverByKey[key] = h; }
  });
  const brandColor = Object.keys(brandTally).sort((a, b) => brandTally[b] - brandTally[a])[0] || '';
  const brandHover = brandHoverByKey[brandColor] || null; // {backgroundColor?,color?,borderColor?}

  // --- raw mirror (literal HTML + CSS for header, footer AND body sections) ---
  // The "grab the static HTML + CSS" path. Clone subtrees verbatim (URLs absolutized,
  // scripts stripped) and collect the page's USED CSS — every rule whose selector matches
  // something on the page, plus :root / html / body globals, @font-face and @keyframes — so
  // the markup renders pixel-identical to the source (hover, media queries, webfonts, forms,
  // sliders, icons included). Cross-origin sheets we can't read (CDN Bootstrap / FontAwesome
  // / Google Fonts) are returned as `linked_css` hrefs to re-link in the theme. The verbatim
  // HTML rides in `chrome` (header/footer) and per-section `rawHtml` (body); the CSS is shared.
  const absUrlsIn = (val, base) => String(val || '').replace(
    /url\((['"]?)([^'")]+)\1\)/gi,
    (m, q, u) => { if (/^(data:|#)/i.test(u)) return m; try { return `url(${q}${new URL(u, base).href}${q})`; } catch { return m; } },
  );
  const rawHtmlOf = (el, stripChrome, inner) => {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,noscript').forEach((n) => n.remove());
    // Body sections strip any nested header/footer/nav — the theme renders those separately
    // (a hero often lives in a wrapper that ALSO contains the <header>, see bgWrapperOf).
    if (stripChrome) clone.querySelectorAll('header,[role="banner"],footer,[role="contentinfo"],nav').forEach((n) => n.remove());
    clone.querySelectorAll('[href]').forEach((n) => { const v = n.getAttribute('href'); if (v && !/^(#|javascript:|mailto:|tel:|data:)/i.test(v)) n.setAttribute('href', abs(v)); });
    clone.querySelectorAll('[src]').forEach((n) => { const v = n.getAttribute('src'); if (v && !v.startsWith('data:')) n.setAttribute('src', abs(v)); });
    clone.querySelectorAll('[srcset]').forEach((n) => n.setAttribute('srcset', n.getAttribute('srcset').split(',').map((s) => { const p = s.trim().split(/\s+/); return p[0] ? abs(p[0]) + (p[1] ? ' ' + p[1] : '') : ''; }).filter(Boolean).join(', ')));
    clone.querySelectorAll('[style*="url("]').forEach((n) => n.setAttribute('style', absUrlsIn(n.getAttribute('style'), location.href)));
    // Collapse source newlines to spaces. The builder stores a code-block's HTML where WP's
    // wpautop runs before the shortcode expands, turning every source line break into a stray
    // <br>. Whitespace between block tags is insignificant, so flattening it kills the <br>s
    // (one space is kept, preserving spacing between inline elements). <pre>/<textarea> are
    // rare in captured chrome/marketing bodies; their literal newlines aren't preserved.
    // `inner` returns the element's CONTENT (used for grid cells, where a builder column
    // replaces the source col wrapper — emitting the wrapper too would double the grid).
    return ( inner ? clone.innerHTML : clone.outerHTML ).replace(/[\t\r\n]+/g, ' ');
  };

  // A section's visual background sometimes lives in a SEPARATE absolutely-positioned layer
  // that's a sibling of the section, inside a shared wrapper — feane's hero is
  // `div.hero_area > (div.bg-box[absolute] + header + section.slider_section)`. The section we
  // detect (slider_section) doesn't contain bg-box, so the background is lost. Detect that
  // pattern and capture the WRAPPER instead (header/footer stripped), so the bg layer rides along.
  const isAbsBgLayer = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const s = getComputedStyle(el);
    if (s.position !== 'absolute' && s.position !== 'fixed') return false;
    const hasImg = !!el.querySelector('img');
    const hasBgImg = s.backgroundImage && s.backgroundImage !== 'none';
    return (hasImg || hasBgImg) && txt(el).length < 20; // a background, not content
  };
  const bgWrapperOf = (sectionEl) => {
    let el = sectionEl;
    for (let up = 0; up < 2 && el && el.parentElement && el.parentElement !== document.body; up++) {
      const parent = el.parentElement;
      const sibs = [...parent.children].filter((c) => c !== el);
      if (sibs.some(isAbsBgLayer)) {
        // Don't merge if the wrapper would swallow another detected section (avoid duplicates).
        if (!sectionEls.some((o) => o !== sectionEl && parent.contains(o))) return parent;
      }
      el = parent;
    }
    return null;
  };

  // --- slider detection (a section that IS a Swiper / Owl / Slick / Splide / BS carousel) ---
  // The page's JS HAS run by capture time, so sliders are initialized — read the real slide
  // elements (excluding the loop CLONES the libraries inject) and pull each slide's content,
  // so the converter can emit the editable `carousel` shortcode instead of frozen markup.
  const bgUrlOf = (el) => {
    for (const n of [el, ...el.querySelectorAll('*')].slice(0, 12)) {
      const m = (getComputedStyle(n).backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1] && !m[1].startsWith('data:')) return abs(m[1]);
    }
    return '';
  };
  const SLIDE_VARIANTS = ['.swiper-slide:not(.swiper-slide-duplicate)', '.splide__slide:not(.splide__slide--clone)', '.slick-slide:not(.slick-cloned)', '.carousel-item', '.owl-item:not(.cloned)'];
  const sliderSlideEls = (sec) => {
    for (const sel of SLIDE_VARIANTS) {
      const els = [...sec.querySelectorAll(sel)].filter(visibleEl);
      if (els.length >= 2) return els;
    }
    const owl = sec.querySelector('.owl-carousel');
    if (owl) { const kids = [...owl.children].filter((c) => c.nodeType === 1 && visibleEl(c)); if (kids.length >= 2) return kids; }
    return null;
  };
  const slideData = (el) => {
    const img = el.querySelector('img');
    const image = img ? abs(img.currentSrc || img.src || '') : bgUrlOf(el);
    const h = el.querySelector('h1,h2,h3,h4,h5,h6');
    const p = el.querySelector('p');
    const a = [...el.querySelectorAll('a, button')].find((x) => looksButton(x) && txt(x));
    return {
      image: /^https?:/.test(image) ? image : '',
      heading: h ? clip(txt(h), 120) : '',
      text: p ? clip(txt(p), 300) : '',
      button: a ? { label: clip(txt(a), 40), href: abs(a.getAttribute('href') || '') } : null,
    };
  };
  const detectSlider = (sec) => {
    const els = sliderSlideEls(sec);
    if (!els) return null;
    const slides = els.map(slideData).filter((s) => s.image || s.heading || s.text);
    if (slides.length < 2) return null;
    const cont = els[0].closest('.swiper,.swiper-container,.splide,.slick-slider,.owl-carousel,.carousel') || els[0].parentElement;
    const heads = [...sec.querySelectorAll('h1,h2,h3')].filter((h) => cont && !cont.contains(h));
    return { slides, heading: heads[0] ? (richHeading(heads[0]) || escHtml(txt(heads[0]))) : '' };
  };

  // --- gallery slider → clean static grid -----------------------------------
  // A "gallery" carousel (Slick/Swiper/Owl whose slides are image CARDS, e.g. a portfolio
  // strip) is captured NOT as a live slider but as a plain grid of its REAL slides (loop
  // CLONES dropped) with all slider chrome stripped — so it lands in a code-block the dev can
  // later swap for a gallery/portfolio shortcode. JS is intentionally ignored; only the markup
  // (+ its carried CSS) matters, and `rawHtmlOf` absolutizes the image src so the media phase
  // re-points them to the imported attachments.
  const SLIDER_CLASS_RE = /\b(slick-slider|slick-initialized|swiper|swiper-container|splide|owl-carousel)\b/;
  const isSliderContainer = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const c = (el.className && el.className.toString) ? el.className.toString() : '';
    if (SLIDER_CLASS_RE.test(c)) return true;
    return !!el.querySelector(':scope > .slick-list, :scope > .swiper-wrapper, :scope > .splide__track, :scope > .owl-stage-outer');
  };
  const SLIDE_CHROME_RE = /^(slick-|swiper-|splide__|owl-)/;
  const cleanSlide = (sl) => {
    const c = sl.cloneNode(true);
    const scrub = (n) => {
      if (n.nodeType !== 1) return;
      ['style', 'tabindex', 'aria-hidden', 'aria-label', 'role', 'data-slick-index'].forEach((a) => n.removeAttribute(a));
      if (n.className && n.className.toString) {
        const kept = n.className.toString().split(/\s+/).filter((x) => x && !SLIDE_CHROME_RE.test(x));
        if (kept.length) { n.setAttribute('class', kept.join(' ')); } else { n.removeAttribute('class'); }
      }
      for (const k of [...n.children]) scrub(k);
    };
    scrub(c);
    return c;
  };
  // Real (de-cloned) slides as one chrome-free `<div class="row">…</div>`, or '' if not a gallery.
  const galleryGridHtml = (container) => {
    const slides = sliderSlideEls(container);
    if (!slides || slides.length < 2) return '';
    // Treat as a gallery only when the slides are image cards (≥ half carry an <img>).
    if (slides.filter((s) => s.querySelector('img')).length < Math.ceil(slides.length / 2)) return '';
    const wrap = document.createElement('div');
    wrap.className = 'row';
    slides.forEach((sl) => wrap.appendChild(cleanSlide(sl)));
    return rawHtmlOf(wrap, true);
  };

  // --- block decomposition (intro-only) -------------------------------------
  // Route a section's STANDALONE heading / intro text / CTA buttons to dedicated shortcodes,
  // while keeping multi-column rows and media/grid bodies as ONE verbatim code-block (so the
  // source layout is preserved). We recurse through single-column wrappers (.container, a
  // 1-col .row) to reach a section-level intro, but stop at a horizontal multi-column row.
  const INLINE = new Set(['A', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'BR', 'SMALL', 'U', 'MARK', 'SUB', 'SUP', 'CODE', 'ABBR', 'TIME', 'LABEL', 'BDI', 'WBR', 'Q', 'CITE', 'FONT']);
  const isTextLeaf = (el) => {
    for (const d of el.children) { if (!INLINE.has(d.tagName)) return false; }
    return txt(el).length > 0;
  };
  const rowKids = (el) => [...el.children].filter((c) => c.nodeType === 1 && !SKIP_TAGS.has(c.tagName) && visibleEl(c));
  const isRow = (el) => {
    const kids = rowKids(el);
    if (kids.length < 2) return false;
    const s = getComputedStyle(el);
    if (s.display === 'flex' || s.display === 'inline-flex') return !(s.flexDirection || '').startsWith('column');
    if (s.display === 'grid') return true;
    return kids.filter((c) => /\bcol(-\w|s?\b)/i.test(c.className || '')).length >= 2;
  };
  // A column's builder width from its Bootstrap col-* span (prefer the largest breakpoint),
  // else an even split by the column count.
  const W12 = { 12: '1_1', 8: '2_3', 6: '1_2', 4: '1_3', 3: '1_4', 2: '1_6' };
  const WN = { 1: '1_1', 2: '1_2', 3: '1_3', 4: '1_4', 5: '1_5', 6: '1_6' };
  const colWidth = (el, count) => {
    // getAttribute('class') is robust for BOTH HTML and SVG elements — an <svg>'s `.className`
    // is an SVGAnimatedString (not a string), so `cls.match(...)` would throw and crash the whole
    // capture (hit on Lovable/React markup that puts inline <svg> as a flex/grid child).
    const cls = (el.getAttribute && el.getAttribute('class')) || '';
    for (const bp of ['xxl', 'xl', 'lg', 'md', 'sm', 'xs']) {
      const m = cls.match(new RegExp('\\bcol-' + bp + '-(\\d{1,2})\\b', 'i'));
      if (m) { const n = +m[1]; return W12[n] || (n >= 12 ? '1_1' : '1_3'); }
    }
    const m = cls.match(/\bcol-(\d{1,2})\b/i);
    if (m) { const n = +m[1]; return W12[n] || (n >= 12 ? '1_1' : '1_3'); }
    return WN[Math.min(count, 6)] || '1_3';
  };
  // A multi-column row → builder columns; each cell's CONTENT becomes a code-block ("the
  // speaker-item can still be a code block"), so the source grid renders as real, editable
  // builder columns at the captured widths.
  // A column's `col-*` classes (so the builder column can carry them, fw-prefixed).
  const colClasses = (el) => String(el.className || '').split(/\s+/).filter((c) => /^col(-|$)/.test(c)).join(' ');
  // Per-grid-cell id + desktop width fraction. Cells get a `data-sc-col` tag so capture.mjs can
  // re-measure their width at tablet/phone viewports (framework-agnostic responsive widths — works
  // for Tailwind `grid-cols-*` / `w-1/3`, custom flex, etc., not just Bootstrap col-*).
  let colCounter = 0;
  const colFrac = (cell, rowW) => {
    const w = cell.getBoundingClientRect().width;
    return ( rowW > 0 && w > 0 ) ? Math.max( 1, Math.min( 12, Math.round( ( w / rowW ) * 12 ) ) ) : 12;
  };
  // A standalone image's own SKIN so a decomposed media_image reproduces it (a hero image often
  // carries an ORGANIC blob `border-radius: 60% 40% 30% 70% / …`, or a plain rounded corner + a
  // shadow) instead of shipping a bare rectangle. Captured off the rendered <img>; only non-trivial
  // values are kept, so a square photo stays square.
  const imgSkin = (el) => {
    const cs = getComputedStyle(el);
    const o = {};
    const r = cs.borderRadius;
    if ( r && !/^(0px)( 0px)*$/.test(r.trim()) ) o.radius = r;
    if ( cs.objectFit && cs.objectFit !== 'fill' ) o.objectFit = cs.objectFit;
    if ( cs.boxShadow && cs.boxShadow !== 'none' ) o.shadow = cs.boxShadow;
    if ( cs.maxWidth && cs.maxWidth !== 'none' ) o.maxWidth = cs.maxWidth;
    return o;
  };
  // A RATING / social-proof cluster — a star rating (+ optional overlapping avatar stack + a caption
  // like "4.9/5 from 500+ happy pet parents"). Maps to a `star-rating` shortcode (+ an `avatar` group
  // for the faces) instead of a verbatim code_block. Detected by a `4.9/5` / `4.9 out of 5` score OR
  // ≥3 star icons in a SHORT cluster (not a long testimonial). Returns null when it isn't one.
  const ratingClusterOf = (el) => {
    const t = txt(el).replace(/\s+/g, ' ').trim();
    if (t.length > 120) return null; // a rating summary is short; longer = prose/testimonial
    const score = t.match(/(\d+(?:\.\d+)?)\s*(?:\/|out\s+of\s+)\s*(\d+(?:\.\d+)?)/i);
    const stars = [...el.querySelectorAll('svg, i, span')].filter((e) => {
      const c = ((e.className && (e.className.baseVal || e.className.toString())) || '');
      return /(^|[\s-])star([\s-]|$)|fa-star|lucide-star/i.test(c);
    });
    if (!score && stars.length < 3) return null;
    const value = score ? score[1] : String(Math.min(5, stars.length));
    const max = score ? score[2] : '5';
    // Caption = the text AFTER the score (e.g. "from 500+ happy pet parents"); else the whole short text.
    let count = score ? t.slice(t.indexOf(score[0]) + score[0].length).replace(/^[\s,·–—-]+/, '').trim() : t;
    // A "+N / 500+ / 2K+" social-proof counter for the avatar stack, pulled from the caption.
    const cm = count.match(/(\d[\d,.]*\s*[kKmM]?\s*\+)/);
    const extraCount = cm ? cm[1].replace(/\s+/g, '') : '';
    const avatars = [...el.querySelectorAll('img')].map((i) => abs(i.currentSrc || i.src || '')).filter((u) => /^https?:/.test(u));
    // The STARS + SCORE TEXT as verbatim HTML, with the avatar stack stripped out (those become the
    // `avatar` shortcode). Kept verbatim so the source's own star glyphs + exact wording render as a
    // small code_block (more faithful than re-drawing stars via the star-rating shortcode).
    let html = '';
    try {
      const c2 = el.cloneNode(true);
      c2.querySelectorAll('img').forEach((im) => { let n = im; while (n.parentElement && n.parentElement !== c2 && !txt(n.parentElement).trim()) n = n.parentElement; n.remove(); });
      c2.querySelectorAll('script,style').forEach((s) => s.remove());
      html = c2.outerHTML.replace(/\s+/g, ' ').trim();
    } catch { html = ''; }
    return { value, max, count, extraCount, avatars, html };
  };
  // An "icon card" inside a grid cell (icon + heading + text [+ link]) → maps to an icon_box.
  // Returns null when the cell isn't a card, so the cell falls back to a verbatim code-block.
  const cardOf = (cell) => {
    // The card body is EITHER a single inner wrapper holding everything (e.g. <div class="about-item">),
    // OR the cell itself with the icon-chip / heading / text as SIBLING direct children (the common
    // Tailwind pattern: <div class="card"><div>[icon]</div><h3>…</h3><p>…</p></div>). Use the inner
    // wrapper only when it actually contains the heading; otherwise fall back to the cell — else
    // `firstElementChild` grabs just the icon-chip (no heading) and the card is missed → code_block.
    const inner = cell.firstElementChild;
    const wrap = (inner && inner.querySelector('h1,h2,h3,h4,h5,h6')) ? inner : cell;
    // Icon = a font-icon <i>, an inline <svg>, an iconify web component (<iconify-icon icon="lucide:zap">),
    // a material-symbol span, or any [class*=icon] glyph.
    const iconEl = wrap.querySelector('svg, iconify-icon, i[class], [class*="icon" i], .material-symbols-outlined, .material-icons');
    const h = wrap.querySelector('h1,h2,h3,h4,h5,h6');
    if (!iconEl || !h) return null;                          // needs at least an icon + a heading
    // A rich CONTENT column (a hero body) is NOT a card: an <h1> means "decompose into real shortcodes",
    // not collapse the whole column into one icon_box (the false-positive where a hero's overline sparkle
    // read as a card icon). Product/feature cards use h2–h6, so they still map to icon_box as before.
    if (cell.querySelector('h1')) return null;
    const p = wrap.querySelector('p');
    const link = wrap.querySelector('a[href]');
    let icon = '', customIcon = '', lucide = '';
    const iconTag = (iconEl.tagName || '').toLowerCase();
    const iconAttr = String((iconEl.getAttribute && iconEl.getAttribute('icon')) || '');   // iconify's icon="pack:name"
    if (/^lucide:/i.test(iconAttr)) {
      lucide = iconAttr.replace(/^lucide:/i, '').trim();     // native Lucide → icon_box library icon (icon-v2)
    } else if (iconTag === 'i') {
      icon = String(iconEl.className || '').split(/\s+/).filter(
        (c) => /^(ti-|fa[bsrl]?$|fa-|bi$|bi-|icon-|dashicons|glyphicon|material-icons)/i.test(c)
      ).join(' ');
    } else if (iconTag === 'svg') {
      customIcon = iconEl.outerHTML;                          // icon_box custom_icon accepts inline SVG
    }
    // Detect the icon's position GEOMETRICALLY (no need for the source to "know" about icon
    // boxes) — and against the actual TITLE / TEXT boxes, not the content wrapper: source cards
    // often float the icon and pad the content (the content box still spans full width, so a
    // wrapper-vs-wrapper test misreads it). Icon beside the text → stack-left/right (or
    // inline-left/right when only the title sits beside it); otherwise the icon is above → top-title.
    const iconWrap = (iconEl.parentElement && iconEl.parentElement !== wrap) ? iconEl.parentElement : iconEl;
    let iconLayout = 'top-title';
    try {
      const a = iconWrap.getBoundingClientRect();   // the icon
      const t = h.getBoundingClientRect();          // the title text
      const pr = p ? p.getBoundingClientRect() : t; // the body text
      const titleBeside = t.top < a.bottom - 4 && t.bottom > a.top + 4; // shares the icon's vertical band
      if (titleBeside && t.left >= a.right - 4) {
        iconLayout = (pr.left >= a.right - 8) ? 'stack-left' : 'inline-left';   // body beside icon → stack
      } else if (titleBeside && t.right <= a.left + 4) {
        iconLayout = (pr.right <= a.left + 8) ? 'stack-right' : 'inline-right';
      }
    } catch { /* keep top-title */ }
    // The icon's rendered color (resolves inheritance) → the icon_box Icon Color, so it matches
    // the source instead of the shortcode's default. '' when it can't be read.
    let iconColor = '';
    try {
      const rc = getComputedStyle(iconEl).color || '';
      const m = rc.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (m) { const hx = (n) => ('0' + (+n).toString(16)).slice(-2); iconColor = '#' + hx(m[1]) + hx(m[2]) + hx(m[3]); }
      else if (/^#[0-9a-f]{3,8}$/i.test(rc.trim())) { iconColor = rc.trim(); }
    } catch { /* no color */ }
    // The icon's BADGE/chip — a filled container around the icon (e.g. `bg-pink-100 rounded-lg`) →
    // icon_box icon_badge (shape from its radius) + icon_badge_color (fill). Checks the icon element
    // and its immediate wrapper; a transparent background = no badge.
    let iconBadge = '', iconBadgeColor = '';
    try {
      for (const el of [iconEl, iconEl.parentElement].filter(Boolean)) {
        const cs = getComputedStyle(el);
        const m = (cs.backgroundColor || '').match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/i);
        const alpha = m ? (m[4] === undefined ? 1 : parseFloat(m[4])) : 0;
        if (m && alpha > 0.05) {
          const hx = (n) => ('0' + (+n).toString(16)).slice(-2);
          iconBadgeColor = '#' + hx(m[1]) + hx(m[2]) + hx(m[3]);
          const r = parseFloat(cs.borderTopLeftRadius) || 0;
          const w = el.getBoundingClientRect().width || 0;
          iconBadge = (r > 12 && r >= w / 2 - 2) ? 'solid-circle' : (r > 0 ? 'solid-rounded' : 'solid-square');
          break;
        }
      }
    } catch { /* no badge */ }
    // The card BOX's own presentation → so the icon_box reproduces the source instead of its centred
    // default: text alignment (source feature cards are often LEFT, the shortcode default is centred),
    // the box padding (the `p-8` class collides with the plugin's own `.p-8` = 72px utility, so carry the
    // COMPUTED value), and the box skin (bg / border / radius / shadow) for the native box options.
    const boxCs = getComputedStyle(wrap);
    const _al = (boxCs.textAlign || 'left').replace(/^(start|justify)$/, 'left').replace(/^end$/, 'right');
    const okc = (v) => v && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(v);
    return {
      icon, customIcon, lucide, iconLayout, iconColor, iconBadge, iconBadgeColor,
      title: clip(txt(h), 160),
      titleTag: h.tagName.toLowerCase(),
      text: p ? rawHtmlOf(p, true) : '',
      link: link ? { label: clip(txt(link), 60), href: abs(link.getAttribute('href') || '') } : null,
      cls: String(wrap.className || ''),                      // the card wrapper class (.about-item …) → icon_box css_class
      align: /^(left|center|right)$/.test(_al) ? _al : 'left',
      pad: boxCs.padding,
      box: {
        bg: okc(boxCs.backgroundColor) ? boxCs.backgroundColor : '',
        radius: (parseFloat(boxCs.borderTopLeftRadius) || 0) > 0 ? boxCs.borderTopLeftRadius : '',
        borderWidth: (parseFloat(boxCs.borderTopWidth) || 0) > 0 ? boxCs.borderTopWidth : '',
        borderStyle: boxCs.borderTopStyle, borderColor: okc(boxCs.borderTopColor) ? boxCs.borderTopColor : '',
        shadow: (boxCs.boxShadow && boxCs.boxShadow !== 'none') ? boxCs.boxShadow : '',
        hoverLift: /hover:-?translate-y-/.test(String(wrap.className || '')),
      },
    };
  };
  // A single <a>/<button> styled as a button → the `button` block shape (same fields the block-level
  // scan emits at line ~976), so the button-group cell detector and the block scan stay consistent.
  const buttonInfo = (child) => {
    const label = clip(txt(child), 80);
    if (!label) return null;
    const bcs = getComputedStyle(child);
    const iconEl = child.querySelector('i, svg, [class*="fa-"], [class*="icon-"]');
    let icon = '', iconPos = 'after';
    if (iconEl && iconEl.className && iconEl.className.toString) {
      icon = iconEl.className.toString().split(/\s+/).filter(
        (c) => /^(fa[bsrl]?$|fa-|bi$|bi-|icon$|icon-|ti$|ti-|ion$|ion-|dashicons|glyphicon|material-icons)/i.test(c)
      ).join(' ');
      iconPos = (child.lastElementChild === iconEl) ? 'after' : 'before';
    }
    return { t: 'button', label, href: abs(child.getAttribute('href') || ''), tag: child.tagName.toLowerCase(),
      cls: String(child.className || ''), align: (bcs.textAlign || 'left'), icon, iconPos,
      bs: { bg: bcs.backgroundColor, fg: bcs.color, bd: bcs.borderTopColor, bds: bcs.borderTopStyle },
      // Full skin + dimensions so the mapper can build a faithful Button Preset. `tw`
      // carries the design-token intent (shadow-lg / rounded-full / border-2) that maps
      // onto the preset SCALES; the raw computed values are the fallback when not Tailwind.
      sh: (bcs.boxShadow && bcs.boxShadow !== 'none') ? bcs.boxShadow : '',
      rad: bcs.borderRadius, bw: bcs.borderTopWidth, bwStyle: bcs.borderTopStyle,
      pad: bcs.padding, fw: bcs.fontWeight, fs: bcs.fontSize, lh: bcs.lineHeight,
      tw: twTokens(String(child.className || '')),
      hover: hoverStyle(child) };
  };
  // A grid cell that is ONLY call-to-action buttons (no heading/prose) → an array of button blocks
  // (a CTA button group), so it maps to real button shortcodes instead of a verbatim code_block.
  const buttonsOf = (cell) => {
    if (cell.querySelector('h1,h2,h3,h4,h5,h6')) return null;      // a heading → it's a card, not a button group
    const btns = [...cell.querySelectorAll('a,button,[role="button"]')].filter((b) => looksButton(b) && txt(b).trim());
    const outer = btns.filter((b) => !btns.some((o) => o !== b && o.contains(b))); // drop nested (a wrapping a span)
    if (!outer.length) return null;
    const prose = txt(cell).replace(/\s+/g, ' ').trim().length;    // require the cell be dominated by button labels
    const btnLen = outer.map((b) => txt(b).trim().length).reduce((a, n) => a + n, 0);
    if (prose > btnLen + 24) return null;
    return outer.map(buttonInfo).filter(Boolean);
  };
  // Find a nested row within a cell (the page-builder can't nest a builder row in a column, so a
  // grid-inside-a-column is mapped to a single column whose cards lay out as a CSS grid).
  const findRow = (el, depth = 0) => {
    if (depth > 3 || !el) return null;
    for (const ch of el.children) {
      if (SKIP_TAGS.has(ch.tagName) || !visibleEl(ch)) continue;
      if (isRow(ch)) return ch;
      const r = findRow(ch, depth + 1);
      if (r) return r;
    }
    return null;
  };
  // A text cell (overline span + heading + paragraph(s), NO icon) → special_heading + text.
  // Each part's own classes are captured separately so they land in the Overline/Title/Subtitle
  // Class fields (NOT inlined into the text). Subtitle = the paragraph's INNER content (no <p>).
  const textBlockOf = (cell) => {
    // Anchor the wrap on the HEADING'S OWN GROUP (its parent), not cell.firstElementChild — the
    // latter grabs the first child (e.g. an overline pill), finds no heading inside it, and returns
    // null, so a `[pill, h, p]` heading group gets shattered into separate cells (pill→code_block,
    // h→heading-only, subtitle dropped). Climbing to h.parentElement keeps the overline + subtitle
    // that are SIBLINGS of the heading in view. (pinky-bites "Creative Lab" was the regression case.)
    const h = cell.querySelector('h1,h2,h3,h4,h5,h6');
    if (!h) return null;
    const wrap = (h.parentElement && cell.contains(h.parentElement)) ? h.parentElement : cell;
    if (wrap.querySelector('.icon i, .icon svg')) return null; // that's a card, not a text cell
    const sp = [...wrap.querySelectorAll('span,small,p,div')].find((e) =>
      e !== h && txt(e) && txt(e).length <= 50 && e.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING
      && (/uppercase|overline|eyebrow|kicker|subtitle|sub-?title|label/i.test(e.className || '') || txt(e) === txt(e).toUpperCase()));
    const ps = [...wrap.querySelectorAll('p')].filter((p) => txt(p));
    const p0 = ps[0] || null;
    return {
      overline: sp ? clip(txt(sp), 60) : '',
      overlineClass: sp ? String(sp.className || '') : '',
      title: richHeading(h) || escHtml(txt(h)), // inner HTML — keep coloured <span> etc., no <hN> wrapper
      titleTag: h.tagName.toLowerCase(),
      titleClass: String(h.className || ''),
      subtitle: p0 ? ( richHeading(p0) || escHtml(txt(p0)) ) : '', // inner content, no <p> wrapper
      subtitleClass: p0 ? String(p0.className || '') : '',
      wrapClass: headingWrapClass(h), // a semantic <div class="heading"> wrapper → special_heading css_class
      paras: ps.slice(1).map((p) => rawHtmlOf(p, true)).filter((x) => x && x.trim()),
    };
  };
  // An animated-counter cell (source `<div class="counter-item text-center"><h2><span class=
  // "counter-stat">1730</span> +</h2><p>Project Done</p>`). Detected by a counter-ish CLASS or a
  // data-count-style attribute on a numeric element — NOT just "a number", so ordinary numeric
  // headings stay headings. Returns the count target + prefix/suffix + label + computed color/font,
  // so the converter can emit a real `counter` shortcode instead of a heading/text.
  const COUNTER_CLASS_RE = /\b(counter-stat|counterup|countup|count-up|counter|count|odometer|milestone)\b/i;
  const COUNTER_DATA_ATTRS = ['data-count', 'data-target', 'data-to', 'data-number', 'data-value', 'data-counter', 'data-stop', 'data-from'];
  const toHexColor = (rc) => {
    const m = String(rc || '').match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!m) return /^#[0-9a-f]{3,8}$/i.test(String(rc).trim()) ? String(rc).trim() : '';
    const h = (n) => ('0' + (+n).toString(16)).slice(-2);
    return '#' + h(m[1]) + h(m[2]) + h(m[3]);
  };
  const counterOf = (cell) => {
    const wrap = cell.firstElementChild || cell;
    const stat = [...wrap.querySelectorAll('span,strong,b,h1,h2,h3,h4,h5,h6,div,p')].find((e) => {
      const t = txt(e);
      if (!/\d/.test(t) || t.length > 24) return false;
      if (!/^[^0-9]{0,3}[0-9][0-9.,\s]*[^0-9]{0,3}$/.test(t.trim())) return false; // a number (+ small symbols), not a sentence
      return COUNTER_CLASS_RE.test(String(e.className || '')) || COUNTER_DATA_ATTRS.some((a) => e.hasAttribute(a));
    });
    if (!stat) return null;
    const dataVal = COUNTER_DATA_ATTRS.map((a) => stat.getAttribute(a)).find((v) => v != null && String(v).trim() !== '') || '';
    const nm = String(dataVal || txt(stat)).replace(/[,\s]/g, '').match(/-?\d*\.?\d+/);
    if (!nm) return null;
    const number = nm[0];
    const decimals = number.includes('.') ? String((number.split('.')[1] || '').length) : '0';
    // prefix / suffix = the text around the number inside its host (e.g. the <h2> wrapping the span)
    const host = stat.parentElement || wrap;
    const ht = txt(host), st = txt(stat), i = ht.indexOf(st);
    let prefix = '', suffix = '';
    if (i >= 0) { prefix = ht.slice(0, i).replace(/\s+/g, ' ').trim(); suffix = ht.slice(i + st.length).replace(/\s+/g, ' ').trim(); }
    if (suffix) suffix = ' ' + suffix;   // match the export style (" +", " M")
    const label = [...wrap.querySelectorAll('p')].map((p) => txt(p)).find((t) => t && t.trim()) || '';
    const ncs = getComputedStyle(stat), hcs = getComputedStyle(host);
    return {
      number, start: '0', prefix, suffix, decimals, label,
      numberColor: toHexColor(ncs.color), suffixColor: toHexColor(hcs.color),
      numberSize: String(parseInt(ncs.fontSize, 10) || ''), numberWeight: String(parseInt(ncs.fontWeight, 10) || ''),
      suffixSize: String(parseInt(hcs.fontSize, 10) || ''), suffixWeight: String(parseInt(hcs.fontWeight, 10) || ''),
    };
  };
  const rowCols = (el) => {
    const cols = rowKids(el);
    const rowW = el.getBoundingClientRect().width || el.offsetWidth || 0;
    return cols.map((c) => {
      const colId = 'sccol-' + (colCounter++);
      const cw = colFrac(c, rowW);              // desktop fraction (1–12) from the rendered width
      try { c.setAttribute('data-sc-col', colId); } catch { /* read-only DOM, skip */ }
      // `html` is the cell's INNER markup, so the data-sc-col tag on the cell never leaks into it.
      // `cls` = only the Bootstrap col-* classes (for width mapping); `fullCls` = the cell's COMPLETE
      // class list, so a verbatim composite (image + overlay) can rebuild the cell's own positioning /
      // flex-centring wrapper (`relative flex items-center justify-center lg:h-[600px]`) — dropping it
      // left the wrapper class-less, so the image wasn't centred and the `inset-0` blob wasn't full-size.
      const cell = { width: colWidth(c, cols.length), cls: colClasses(c), fullCls: String(c.className || ''), colId, cw, html: rawHtmlOf(c, true, true) };
      // The cell's OWN flex layout → so the column can replay it via native content_direction / gap
      // (a flex-ROW cell lays its children side-by-side; a stacked column is the default). Captured
      // for every flex cell; the mapper only acts on `row` (+ the gap).
      const ccs = getComputedStyle(c);
      if ((ccs.display === 'flex' || ccs.display === 'inline-flex') && [...c.children].filter((k) => visibleEl(k)).length >= 2) {
        cell.flex = { dir: ccs.flexDirection, justify: ccs.justifyContent, align: ccs.alignItems, gap: ccs.columnGap || ccs.gap };
      }
      // PRODUCT-CARD wrapper skin + hover + ribbon (only on image-bearing cells → product cards). The
      // wc_products mapper reproduces the card look via scoped section CSS (no shortcode-option bloat):
      // the REST skin comes from the wrapper's computed style; the HOVER (shadow / lift) is read from
      // its `hover:*` utility classes (getComputedStyle can't see a resting element's :hover). Was the
      // gap that dropped the source card's `hover:shadow-xl hover:-translate-y-2` + its badge entirely.
      if (c.querySelector && c.querySelector('img')) {
        const wcls = (c.getAttribute && c.getAttribute('class')) || '';
        if (/border|shadow|rounded/i.test(wcls) || parseFloat(ccs.borderTopLeftRadius) > 0 || (ccs.boxShadow && ccs.boxShadow !== 'none')) {
          const hs = /(?:^|\s)hover:shadow-(2xl|xl|lg|md|sm)(?:\s|$)/.exec(wcls);
          const hl = /(?:^|\s)hover:-translate-y-([0-9.]+)(?:\s|$)/.exec(wcls);
          cell.wrap = {
            bg: ccs.backgroundColor, radius: ccs.borderTopLeftRadius,
            borderW: ccs.borderTopWidth, borderColor: ccs.borderTopColor, borderStyle: ccs.borderTopStyle,
            shadow: (ccs.boxShadow && ccs.boxShadow !== 'none') ? ccs.boxShadow : '',
            hoverShadow: hs ? hs[1] : '', hoverLift: hl ? hl[1] : '',
          };
        }
        // A small uppercase pill inside the card → the product ribbon/badge (e.g. "Best Seller").
        for (const sp of c.querySelectorAll('span, div')) {
          const t = (sp.textContent || '').trim();
          if (!t || t.length > 24) continue;
          const scs = getComputedStyle(sp);
          if (scs.textTransform === 'uppercase' && parseFloat(scs.borderTopLeftRadius) >= 8 && scs.display !== 'none' && sp.children.length === 0) {
            cell.ribbon = { text: t, bg: scs.backgroundColor, color: scs.color, radius: scs.borderTopLeftRadius,
              padding: scs.padding, fontSize: scs.fontSize, fontWeight: scs.fontWeight,
              letterSpacing: scs.letterSpacing, borderW: scs.borderTopWidth, borderColor: scs.borderTopColor };
            break;
          }
        }
      }
      // Order matters: a NESTED ROW of cards must be detected BEFORE single-card detection —
      // otherwise cardOf greedily matches the first icon+heading inside the nested row and the
      // cell collapses to one card (the bug where col-lg-7 became a single icon_box).
      const nested = findRow(c);
      if (nested) {
        const inner = rowCols(nested);
        const cards = inner.filter((x) => x.card).length;
        if (inner.length >= 2 && cards >= Math.ceil(inner.length * 0.6)) {
          const cw0 = inner[0].cw || 6;
          cell.grid = { cells: inner, gridCols: Math.max(1, Math.min(6, Math.round(12 / cw0))) };
        }
      }
      if (!cell.grid) {
        cell.counter = counterOf(c);                            // animated stat counter
        if (!cell.counter) {
          cell.card = cardOf(c);                                // single icon card
          if (!cell.card) {
            const b = buttonsOf(c);                             // a CTA button group?
            if (b && b.length) { cell.buttons = b; }
            else {
              // Content in an ABSOLUTELY-positioned overlay (a floating badge, a decorative blob) is out
              // of flow: it must neither disqualify an image-dominant column nor pull a rich column into
              // textBlockOf. Classify on FLOW content only.
              const inFlow = (el) => { let x = el; while (x && x !== c) { const s = getComputedStyle(x); if (s.position === 'absolute' || s.position === 'fixed') return false; x = x.parentElement; } return true; };
              const flowHeading = [...c.querySelectorAll('h1,h2,h3,h4,h5,h6')].some(inFlow);
              const flowPara    = [...c.querySelectorAll('p')].some(inFlow);
              const img = c.querySelector('img');
              const hasBtn = [...c.querySelectorAll('a,button')].some((x) => looksButton(x) && txt(x).trim());
              // A rich hero CONTENT column = heading + CTA button(s) (+ often a rating / social-proof row).
              // textBlockOf would collapse it to overline/title/subtitle and DROP the buttons + rating, so
              // decompose into real blocks. A pure heading group (no buttons) still uses textBlockOf → one
              // clean special_heading (unchanged).
              if (flowHeading && hasBtn) {
                const inner = []; decompose(c, inner);
                if (inner.filter((x) => x.t !== 'html').length >= 2) { cell.blocks = inner; }
              }
              if (!cell.blocks) {
                const t = (flowHeading || flowPara) ? textBlockOf(c) : null;
                if (t) { cell.text = t; }                       // a plain text cell
                // An image-dominant cell whose only text sits in absolute overlays (a floating badge).
                // NOTHING DROPPED: if such an overlay carries real content (text or an icon/image), keep
                // the WHOLE cell VERBATIM (image + blob + badge, with their positioning) by NOT collapsing
                // it to a bare media_image — the cell falls back to its verbatim html leaf. Only a clean
                // image with no meaningful overlay becomes the native media_image.
                else if (img && !flowHeading && !flowPara) {
                  const hasOverlayContent = [...c.querySelectorAll('*')].some((el) => {
                    const s = getComputedStyle(el);
                    if (s.position !== 'absolute' && s.position !== 'fixed') return false;
                    return txt(el).trim() !== '' || !!el.querySelector('img,svg');
                  });
                  if (!hasOverlayContent) {
                    cell.image = { src: abs(img.currentSrc || img.src || ''), alt: img.alt || '', ...imgSkin(img) };
                  } else {
                    // Image + a content-bearing overlay (a floating badge) → kept VERBATIM (its own html
                    // leaf). Flag it a CONTAINED composite so the clean-hero gate still lets the REST of the
                    // section (a clean text column) decompose — only this one cell stays verbatim.
                    cell.imgComposite = true;
                  }
                } else if (flowHeading) {
                  // A rich CONTENT column with no buttons but a non-heading-group body → decompose.
                  const inner = []; decompose(c, inner);
                  const real = inner.filter((x) => x.t !== 'html');
                  if (real.length >= 1 && inner.length >= 2) { cell.blocks = inner; }
                }
              }
            }
          }
        }
      }
      return cell;
    }).filter((c) => c.html.trim());
  };
  // A SEMANTIC heading-group wrapper around a heading (source `<div class="heading"> h + p`) →
  // its class, so the special_heading can replay it on its own wrapper div. Structural wrappers
  // (column / row / container / section) are ignored; the group must hold only heading/text leaves.
  const headingWrapClass = (h) => {
    const p = h.parentElement;
    if (!p) return '';
    const wc = String(p.className || '').trim();
    if (!wc) return '';
    if (/(^|\s)(col(-|\b)|row\b|container|fw-|section\b|wrapper\b|elementor)/i.test(wc)) return '';
    const kids = [...p.children];
    if (!kids.length || !kids.every((k) => /^(H[1-6]|P|SPAN|SMALL|DIV)$/.test(k.tagName))) return '';
    return wc;
  };

  // --- testimonials: grab CONTENT, map to the testimonials shortcode (design is not preserved) ---
  // A testimonials collection = ≥2 repeated review blocks (class ~ testimonial/review/feedback)
  // each holding a quote. We extract quote / image / name / position / website / rating per block.
  const snap5 = (v) => Math.max(0, Math.min(5, Math.round(v * 2) / 2)); // → 0–5 in 0.5 steps
  // Rating, normalized to our 5-star / 0.5-step scale. Reads star icons, aria/data, or a text
  // score ("9/10", "4.2 out of 5", "80%") — converting any max to 5 (9/10→4.5, 80/100→4.0).
  const ratingOf = (b) => {
    const icons = [...b.querySelectorAll('i,span,svg')].filter((e) => /\b(fa-star|star|rating|rate)\b/i.test(String(e.className || '')));
    if (icons.length) {
      let filled = 0, any = false;
      icons.forEach((s) => {
        const c = String(s.className || '');
        if (!/\bstar\b|fa-star/i.test(c)) return;
        any = true;
        if (/half/i.test(c)) filled += 0.5;
        else if (/(fa-star-o|far\b|empty|outline|-o\b)/i.test(c)) { /* empty star */ }
        else filled += 1;
      });
      if (any && filled > 0) return snap5(filled);
    }
    const rEl = b.querySelector('[data-rating],[data-stars],[data-score],[aria-label*="out of"],[aria-label*="star"]');
    if (rEl) {
      const dv = rEl.getAttribute('data-rating') || rEl.getAttribute('data-stars') || rEl.getAttribute('data-score') || '';
      if (dv && /\d/.test(dv)) { const n = parseFloat(dv); if (!isNaN(n)) return snap5(n > 5 ? (n / (n <= 10 ? 10 : 100)) * 5 : n); }
      const al = rEl.getAttribute('aria-label') || '';
      const mm = al.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+)/i);
      if (mm) return snap5((+mm[1] / +mm[2]) * 5);
    }
    const t = txt(b);
    let m;
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+)/i))) return snap5((+m[1] / +m[2]) * 5);
    if ((m = t.match(/\b(\d{1,3}(?:\.\d+)?)\s*%/))) return snap5((+m[1] / 100) * 5);
    return null; // no rating found
  };
  const testimonialItem = (b) => {
    const q = b.querySelector('blockquote') || [...b.querySelectorAll('p')].filter((p) => txt(p)).sort((a, c) => txt(c).length - txt(a).length)[0] || null;
    const quote = q ? rawHtmlOf(q, true, true).replace(/\s+/g, ' ').trim() : '';
    const img = b.querySelector('img');
    const image = img ? abs(img.currentSrc || img.src || '') : '';
    const nameEl = b.querySelector('h3,h4,h5,h6,.name,.author-name,.client-name,.author,cite')
      || [...b.querySelectorAll('strong,b')].find((e) => (q ? !q.contains(e) : true)) || null;
    const name = nameEl ? clip(txt(nameEl), 80) : '';
    let position = '';
    if (nameEl && nameEl.parentElement) {
      const sib = [...nameEl.parentElement.children].find((e) => e !== nameEl && /^(SPAN|SMALL|P)$/.test(e.tagName) && txt(e));
      if (sib) position = clip(txt(sib), 80);
    }
    if (!position) {
      const pe = [...b.querySelectorAll('span,small,.designation,.role,.position,.job')].find((e) => txt(e) && e !== nameEl && (!q || !q.contains(e)));
      if (pe) position = clip(txt(pe), 80);
    }
    const a = [...b.querySelectorAll('a[href]')].find((x) => { const h = x.getAttribute('href') || ''; return h && !/^#/.test(h); });
    const siteUrl = a ? abs(a.getAttribute('href') || '') : '';
    const siteName = a ? clip(txt(a), 60) : '';
    return { quote, image, name, position, siteName, siteUrl, rating: ratingOf(b) };
  };
  const TESTI_BLOCK_RE = /\b(testimonial|review|feedback|client[-_]?(say|review|quote)|quote[-_]?(item|block|card))\b/i;
  const testimonialsOf = (scope) => {
    if (!scope || scope.nodeType !== 1) return null;
    let blocks = [...scope.querySelectorAll('[class]')].filter((e) =>
      TESTI_BLOCK_RE.test(String(e.className || ''))
      && !/\b(slick-cloned|swiper-slide-duplicate|splide__slide--clone|cloned)\b/i.test(String(e.className || ''))
      && e.querySelector('p,blockquote') && visibleEl(e));
    blocks = blocks.filter((b) => !blocks.some((o) => o !== b && o.contains(b))); // outermost only
    // STRUCTURAL fallback for utility-class (Tailwind) sites with no `testimonial`/`review` class name:
    // a grid whose ≥2 sibling cards each read like a quote — quote marks, a star rating, or a "— Name"
    // attribution. Quote/rating signals keep it from matching plain feature/pricing card grids.
    if (blocks.length < 2) {
      const QUOTE_RE = /["“”«»‘’“”]/;
      const looksQuote = (el) => {
        if (!el.querySelector('p,blockquote')) return false;
        const t = txt(el);
        if (t.length < 30) return false;
        return QUOTE_RE.test(t) || !!ratingOf(el) || /(^|\s)[—–-]\s*[A-Z][a-z]+/.test(t);
      };
      for (const cont of [scope, ...scope.querySelectorAll('*')]) {
        const kids = [...cont.children].filter((k) => k.nodeType === 1 && visibleEl(k));
        if (kids.length < 2) continue;
        const cards = kids.filter(looksQuote);
        if (cards.length >= 2 && cards.length >= kids.length - 1) { blocks = cards; break; }
      }
    }
    if (blocks.length < 2) return null;
    const items = blocks.map(testimonialItem).filter((it) => it && (it.quote || it.name));
    if (items.length < 2) return null;
    return { items };
  };
  // A native <video> OR a provider <iframe> → a `video` block (→ media_video). Mirrors the PHP
  // stitch 'video' recognizer. Provider iframes are matched by host (a general IFRAME stays SKIPPED
  // to avoid capturing tracking/ad frames). A self-hosted <video> is the only way to reproduce a
  // muted/looping/autoplaying background clip, so its playback flags are carried through.
  const VIDEO_PROVIDER_RE = /(youtube\.com|youtu\.be|youtube-nocookie\.com|player\.vimeo\.com|vimeo\.com\/\d|dailymotion\.com\/embed|wistia\.(net|com)|player\.twitch\.tv)/i;
  const videoBlockOf = (el) => {
    const tag = el.tagName;
    if (tag === 'IFRAME') {
      const src = el.getAttribute('src') || '';
      if (!VIDEO_PROVIDER_RE.test(src)) return null;
      return { t: 'video', mode: 'embed', embedUrl: abs(src) };
    }
    if (tag !== 'VIDEO') return null;
    let src = el.getAttribute('src') || '', webm = '';
    for (const s of el.querySelectorAll('source')) {
      const ss = s.getAttribute('src') || '', stype = (s.getAttribute('type') || '').toLowerCase();
      if (!ss) continue;
      if (!webm && (stype === 'video/webm' || /\.webm(\?|$)/i.test(ss))) webm = ss;
      if (!src && (stype === 'video/mp4' || /\.mp4(\?|$)/i.test(ss))) src = ss;
    }
    if (!src && !webm) return null;
    // A full-screen BACKGROUND <video> (absolutely/fixed positioned + object-cover, i.e. the hero clip
    // that sits BEHIND the content) is flagged `bg` so the mapper wires it into the SECTION background
    // instead of emitting a content media_video block. (The class check catches Tailwind object-cover /
    // inset-0 even when computed objectFit is unavailable.)
    const vcs = getComputedStyle(el);
    const bgVideo = (vcs.position === 'absolute' || vcs.position === 'fixed')
      && (vcs.objectFit === 'cover' || /\b(object-cover|inset-0)\b/.test(el.getAttribute('class') || ''));
    return {
      t: 'video', mode: 'self_hosted', src: abs(src), webm: abs(webm), poster: abs(el.getAttribute('poster') || ''),
      bg: bgVideo,
      autoplay: el.hasAttribute('autoplay') ? 'yes' : 'no', muted: el.hasAttribute('muted') ? 'yes' : 'no',
      loop: el.hasAttribute('loop') ? 'yes' : 'no', controls: el.hasAttribute('controls') ? 'yes' : 'no',
      playsinline: el.hasAttribute('playsinline') ? 'yes' : 'no',
    };
  };
  // An eyebrow / kicker / pill that sits above a heading (short text, uppercase-or-pill styling, with
  // a heading later in the SAME parent) → a clean `overline` block, kept INTACT (not dived into) so
  // the mapper can fold it into the heading's special_heading overline. Without this the pill is
  // shattered into svg + text sub-blocks and the overline is lost (the pinky-bites "Creative Lab" bug).
  const isOverline = (node, parent) => {
    const t = txt(node); if (!t || t.length > 48) return false;
    const c = String((node.className && node.className.toString) ? node.className.toString() : '');
    const eyebrow = /rounded-full|uppercase|eyebrow|kicker|overline|tracking/i.test(c) || t === t.toUpperCase();
    if (!eyebrow) return false;
    return [...parent.children].some((k) => /^H[1-6]$/.test(k.tagName) && (node.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING));
  };
  const decompose = (el, out) => {
    let _rat;
    for (const child of [...el.children]) {
      const vblk = videoBlockOf(child);          // before SKIP: provider IFRAMEs are otherwise skipped
      if (vblk) { out.push(vblk); continue; }
      if (!visibleEl(child)) continue;
      if (SKIP_TAGS.has(child.tagName)) {
        // NOTHING DROPPED: a content-bearing tag that used to be skipped now falls back to a verbatim
        // code block — a standalone <svg> illustration, or a non-provider <iframe> (maps / booking /
        // form / social embeds; provider videos were already rescued above via videoBlockOf). Truly
        // non-content tags (script/style/noscript/template/header/footer/nav) stay skipped.
        if (child.tagName === 'SVG' || child.tagName === 'IFRAME') { out.push({ t: 'html', html: rawHtmlOf(child, true) }); }
        continue;
      }
      // DECORATIVE chrome (a glow blob / gradient overlay): no text, no media/interactive descendants,
      // and out of flow (absolute/fixed) or non-interactive (pointer-events:none / aria-hidden). It used
      // to be DROPPED; NOTHING DROPPED now preserves it VERBATIM as a code block so its visual (bg /
      // gradient / clip-path / border-radius) survives — unless it is genuinely styleless (no class and
      // no inline style), which would render nothing.
      if (!txt(child).trim() && !child.querySelector('img,svg,video,iframe,picture,canvas,input,button,a[href]')) {
        const dcs = getComputedStyle(child);
        if (dcs.position === 'absolute' || dcs.position === 'fixed' || dcs.pointerEvents === 'none' || child.getAttribute('aria-hidden') === 'true') {
          const dcls = (child.className && child.className.toString) ? child.className.toString().trim() : '';
          const dsty = (child.getAttribute('style') || '').trim();
          // `decor:true` marks a full-bleed section DECORATION (an absolute bg / glow layer). It's kept
          // verbatim (nothing dropped) but must NOT count against the clean-hero gate — a decorative
          // backdrop shouldn't force an otherwise-decomposable section to stay wholly verbatim.
          if (dcls !== '' || dsty !== '') { out.push({ t: 'html', html: rawHtmlOf(child, true), decor: true }); }
          continue;
        }
      }
      const tag = child.tagName;
      const cls = (child.className && child.className.toString) ? child.className.toString() : '';
      // A testimonials collection → one `testimonials` block (content only; design not preserved).
      // Checked before the gallery/slider branch because a testimonial carousel also has images.
      const tst = testimonialsOf(child);
      if (tst) { out.push({ t: 'testimonials', items: tst.items }); continue; }
      // A gallery carousel (image-card slider) → one clean static grid code-block (real slides
      // only, slider chrome + loop clones stripped). Checked first so we never dive into the
      // slick/swiper track (which would emit the loop clones as extra columns).
      if (isSliderContainer(child)) {
        const gh = galleryGridHtml(child);
        if (gh) { out.push({ t: 'html', html: gh, gallery: true }); continue; }
      }
      if (/^H[1-6]$/.test(tag)) {
        const html = richHeading(child) || escHtml(txt(child));
        if (html) { const _hcs = getComputedStyle(child); out.push({ t: 'heading', level: +tag[1], html, text: clip(txt(child), 200), tag: tag.toLowerCase(), cls, wrapCls: headingWrapClass(child), fontSize: _hcs.fontSize, fontWeight: _hcs.fontWeight, color: _hcs.color, marginBottom: _hcs.marginBottom, marginTop: _hcs.marginTop, lineHeight: _hcs.lineHeight, letterSpacing: _hcs.letterSpacing, align: (_hcs.textAlign || 'left').replace(/^(start|justify)$/, 'left').replace('end', 'right') }); }
      } else if ((tag === 'A' || tag === 'BUTTON') && looksButton(child)) {
        const label = clip(txt(child), 80);
        const bcs = getComputedStyle(child);
        // Capture an icon element inside the button (e.g. <i class="fa fa-angle-right ml-2">) so
        // the plugin can populate the button's icon field. Keep only icon-font tokens (drop
        // spacing utilities like ml-2); position = after when the icon is the last child.
        const iconEl = child.querySelector('i, svg, [class*="fa-"], [class*="icon-"]');
        let icon = '', iconSvg = '', iconPos = 'after';
        if (iconEl) {
          if ((iconEl.tagName || '').toLowerCase() === 'svg') { iconSvg = iconEl.outerHTML; }
          else if (iconEl.className && iconEl.className.toString) {
            icon = iconEl.className.toString().split(/\s+/).filter(
              (c) => /^(fa[bsrl]?$|fa-|bi$|bi-|icon$|icon-|ti$|ti-|ion$|ion-|dashicons|glyphicon|material-icons)/i.test(c)
            ).join(' ');
          }
          iconPos = (child.lastElementChild === iconEl) ? 'after' : 'before';
        }
        // Capture the SAME skin fields as the button-GROUP branch (pad / fontSize / fontWeight / inline
        // SVG icon / border width) — otherwise a STANDALONE button (a CTA under a heading) loses its
        // padding (px-10 py-4 → the shortcode's .btn default 10px/24px) and its inline arrow icon.
        if (label) out.push({ t: 'button', label, href: abs(child.getAttribute('href') || ''), tag: tag.toLowerCase(), cls, align: (bcs.textAlign || 'left'), icon, iconSvg, iconPos,
          pad: bcs.padding, fontSize: bcs.fontSize, fontWeight: bcs.fontWeight,
          bs: { bg: bcs.backgroundColor, fg: bcs.color, bd: bcs.borderTopColor, bds: bcs.borderTopStyle, bw: bcs.borderTopWidth } });
      } else if (isOverline(child, el)) {
        const ocs = getComputedStyle(child);
        // A leading/trailing icon SVG in the overline → captured separately so it maps to the native
        // overline_icon option (kept OUT of the overline text, or the icon would double up).
        const ovSvg = child.querySelector('svg');
        let ovIcon = '', ovIconPos = 'before', ovHtml = richHeading(child) || escHtml(txt(child));
        if (ovSvg) {
          ovIcon = ovSvg.outerHTML;
          ovIconPos = (child.lastElementChild === ovSvg) ? 'after' : 'before';
          const c2 = child.cloneNode(true); c2.querySelectorAll('svg').forEach((s) => s.remove());
          ovHtml = escHtml((c2.textContent || '').replace(/\s+/g, ' ').trim());
        }
        out.push({ t: 'overline', html: ovHtml, text: clip(txt(child), 60), cls, pill: /rounded-full|inline-flex|inline-block|pill/i.test(cls), color: ocs.color, bg: ocs.backgroundColor, textTransform: ocs.textTransform, iconSvg: ovIcon, iconPos: ovIconPos });
      } else if ((_rat = ratingClusterOf(child))) {
        // A star-rating / social-proof cluster (avatars + stars + "4.9/5 from 500+ …") → a `rating`
        // block (→ star-rating shortcode + an avatar group), NOT a verbatim code_block.
        out.push({ t: 'rating', value: _rat.value, max: _rat.max, count: _rat.count, extraCount: _rat.extraCount, avatars: _rat.avatars, html: _rat.html });
      } else if ((() => { const vk = [...child.children].filter((k) => visibleEl(k)); return vk.length >= 1 && vk.every((k) => looksButton(k) || (k.children.length === 1 && looksButton(k.firstElementChild))); })()) {
        // A button GROUP wrapper (`<div class="flex gap-4"><a class="btn">…</a><a>…</a></div>`): each
        // <a> is INLINE, so isTextLeaf below would swallow the group into ONE text block and drop the
        // CTAs (the hero "Book a Stay / Take a Tour" bug). Emit each child as its own button block.
        const gcs = getComputedStyle(child);
        // Row-vs-stack must reflect the DESKTOP layout regardless of which viewport the extractor
        // happens to run at (the responsive re-measure pass can leave the page at a phone width, where
        // `sm:flex-row` hasn't kicked in and the live flexDirection reads `column`). A `flex-row` class
        // — including responsive `sm:/md:/lg:flex-row` — is the reliable desktop-intent signal; the live
        // flexDirection is only a fallback when no flex-direction class is present.
        const _gcls = (child.className || '').toString();
        const groupRow = /(?:^|[\s:])flex-row\b/.test(_gcls)
          || (!/(?:^|[\s:])flex-col\b/.test(_gcls) && /row/i.test(gcs.flexDirection || ''));
        const kids = [...child.children].filter((k) => visibleEl(k));
        kids.forEach((kid, ki) => {
          const bel = looksButton(kid) ? kid : kid.firstElementChild;
          const label = clip(txt(bel), 80);
          if (!label) return;
          const bcs = getComputedStyle(bel);
          // Icon: prefer a captured INLINE SVG (lucide arrow etc.) — carried verbatim to the button's
          // svg icon — else a font-icon class token. The SVG is the FreshPaws "Book a Stay →" arrow that
          // was being dropped (the class filter kept only fa-/bi-/… tokens, not lucide/inline SVG).
          const svgEl = bel.querySelector('svg');
          const iel = bel.querySelector('i, [class*="fa-"], [class*="icon-"]');
          let icon = '', iconSvg = '', iconPos = 'after';
          if (svgEl) { iconSvg = svgEl.outerHTML; iconPos = (bel.lastElementChild === svgEl) ? 'after' : 'before'; }
          else if (iel && iel.className && iel.className.toString) {
            icon = iel.className.toString().split(/\s+/).filter((x) => /^(fa[bsrl]?$|fa-|bi$|bi-|icon$|icon-|ti$|ti-|ion$|ion-|dashicons|glyphicon|material-icons)/i.test(x)).join(' ');
            iconPos = (bel.lastElementChild === iel) ? 'after' : 'before';
          }
          out.push({ t: 'button', label, href: abs(bel.getAttribute('href') || ''), tag: bel.tagName.toLowerCase(),
            cls: (bel.className || '').toString(), align: (bcs.textAlign || 'left'), icon, iconSvg, iconPos,
            pad: bcs.padding, fontSize: bcs.fontSize, fontWeight: bcs.fontWeight,
            groupRow, groupFirst: ki === 0, groupLast: ki === kids.length - 1,
            bs: { bg: bcs.backgroundColor, fg: bcs.color, bd: bcs.borderTopColor, bds: bcs.borderTopStyle, bw: bcs.borderTopWidth } });
        });
      } else if (isTextLeaf(child)) {
        if (txt(child)) { const _tcs = getComputedStyle(child); out.push({ t: 'text', html: rawHtmlOf(child, true), text: clip(txt(child), 200), tag: tag.toLowerCase(), cls,
          // Full computed style so the decomposed text_block reproduces EVERY class effect (font-size /
          // colour / line-height / letter-spacing / alignment / bottom margin) — nothing dropped.
          fontSize: _tcs.fontSize, color: _tcs.color, lineHeight: _tcs.lineHeight, letterSpacing: _tcs.letterSpacing, marginBottom: _tcs.marginBottom, textAlign: _tcs.textAlign, fontWeight: _tcs.fontWeight }); }
      } else if (isRow(child)) {
        const cols = rowCols(child);
        if (cols.length) {
          // The row's vertical alignment of its columns (source `.row.align-items-center` etc.) →
          // the builder columns' Content Vertical Align. Read computed (works for classes or CSS).
          const ai = (getComputedStyle(child).alignItems || '').toLowerCase();
          const valign = ai === 'center' ? 'center'
            : ( ( ai === 'flex-end' || ai === 'end' ) ? 'end'
            : ( ( ai === 'flex-start' || ai === 'start' ) ? 'start' : '' ) );
          // Carry the raw HTML so a NESTED row that reaches blockToNode (e.g. a bespoke rating /
          // social-proof cluster inside a decomposed hero column) renders verbatim as a CONTAINED
          // code_block instead of an EMPTY one. (A top-level layout row is still built into columns.)
          out.push({ t: 'row', cols, valign, html: rawHtmlOf(child, true) });
        }
      } else if (tag === 'IMG' || (/^(FIGURE|PICTURE)$/.test(tag) && child.querySelector('img') && !txt(child))) {
        // A standalone <img> (or a figure/picture wrapping a lone image) → a clean `image` block →
        // media_image. NOTHING DROPPED: if the image carries a visual SKIN media_image can't express
        // (a non-zero border-radius / blob, a box-shadow, or a border / ring / outline class or inline
        // style), preserve it VERBATIM as a code block instead, so the skin + every class survive.
        const im = tag === 'IMG' ? child : child.querySelector('img');
        const src = abs(im.currentSrc || im.src || '');
        const sk  = imgSkin(im);
        const imCls = (im.className && im.className.toString) ? im.className.toString() : '';
        const skinClass = /(^|\s)(border|shadow|drop-shadow|ring\b|ring-|rounded-(?!none)|rounded\b|outline\b|outline-|blob)/i.test(imCls)
          || /(border|box-shadow|outline|border-radius|clip-path)/i.test(im.getAttribute('style') || '');
        const hasSkin = !!sk.radius || !!sk.shadow || skinClass;
        if (!/^https?:/.test(src)) { out.push({ t: 'html', html: rawHtmlOf(child, true) }); }
        else if (hasSkin) { out.push({ t: 'html', html: rawHtmlOf(child, true) }); }
        else { out.push({ t: 'image', src, alt: im.alt || '', ...sk }); }
      } else if (child.children.length && !child.matches('table,figure,ul,ol,dl')) {
        decompose(child, out); // single-column wrapper → dive to reach the intro / the grid row
      } else {
        out.push({ t: 'html', html: rawHtmlOf(child, true) }); // media / list / table leaf → verbatim
      }
    }
  };

  // A curated "how it looks" summary of a section's computed style (the spec's appearance data).
  const sectionComputed = (el) => {
    const s = getComputedStyle(el);
    const o = {};
    const set = (k, v, ...skip) => { v = (v || '').toString().trim(); if ( v && !skip.includes(v) ) o[k] = v; };
    set('background', s.backgroundColor, 'rgba(0, 0, 0, 0)', 'transparent');
    // A full-bleed absolute bg layer (`<div class="absolute inset-0 bg-primary">`) paints the
    // section even though the section's OWN bg is transparent — capture its colour as the section
    // background, else a solid CTA band silently converts to no background (the FreshPaws CTA bug).
    if (!o.background) {
      const er = el.getBoundingClientRect();
      const layer = [...el.querySelectorAll(':scope > div, :scope > span')].find((c) => {
        const cs = getComputedStyle(c); const bg = cs.backgroundColor;
        if (cs.position !== 'absolute' && cs.position !== 'fixed') return false;
        if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return false;
        const r = c.getBoundingClientRect();
        return r.width >= er.width * 0.9 && r.height >= er.height * 0.9; // covers the section
      });
      if (layer) set('background', getComputedStyle(layer).backgroundColor, 'rgba(0, 0, 0, 0)', 'transparent');
    }
    if (s.backgroundImage && s.backgroundImage !== 'none') o.backgroundImage = absUrlsIn(s.backgroundImage, location.href);
    set('color', s.color);
    set('padding', s.padding, '0px');
    // Sections often express their vertical separation as MARGIN (mt-24 / mb-16), not padding.
    // The section shortcode has no margin lever, so the converter folds this into padding_top/bottom
    // — capture it here or that whole top/bottom gap is silently dropped (looks like "no padding").
    set('margin', s.margin, '0px');
    set('fontFamily', s.fontFamily);
    set('fontSize', s.fontSize);
    set('textAlign', s.textAlign, 'start', 'left');
    set('minHeight', s.minHeight, '0px', 'auto');
    set('maxWidth', s.maxWidth, 'none');
    return o;
  };
  // Diagnostic-only style snapshot for the conversion report: the visually-significant
  // properties the converter's `computed` summary does NOT carry (border, shadow, radius,
  // gradient). The report compares this against `computed` to flag dropped styling — e.g. a
  // "trust strip" whose top/bottom border never reaches the rebuilt section. Capture-only;
  // it does NOT change conversion output.
  const sectionDiag = (el) => {
    const s = getComputedStyle(el);
    const o = {};
    const has = (w) => w && w !== '0px';
    if (has(s.borderTopWidth)    && s.borderTopStyle    !== 'none') o.borderTop    = `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`;
    if (has(s.borderBottomWidth) && s.borderBottomStyle !== 'none') o.borderBottom = `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}`;
    if (has(s.borderLeftWidth)   && s.borderLeftStyle   !== 'none') o.borderLeft   = `${s.borderLeftWidth} ${s.borderLeftStyle} ${s.borderLeftColor}`;
    if (has(s.borderRightWidth)  && s.borderRightStyle  !== 'none') o.borderRight  = `${s.borderRightWidth} ${s.borderRightStyle} ${s.borderRightColor}`;
    if (s.boxShadow && s.boxShadow !== 'none') o.boxShadow = s.boxShadow;
    if (s.borderRadius && s.borderRadius !== '0px') o.borderRadius = s.borderRadius;
    if (/gradient/i.test(s.backgroundImage || '')) o.gradient = absUrlsIn(s.backgroundImage, location.href);
    return o;
  };
  // Census of fidelity-critical computed properties used by a section's descendants — the
  // visually-significant CSS the converted output must reproduce (background-image, padding,
  // max-width, position, shadow, etc.). The style-coverage report compares this against what the
  // carried CSS (sec.css) actually declares, to flag dropped styling (the Tailwind/runtime-CSS gap).
  const censusStyles = (el) => {
    const c = {};
    const bump = (k) => { c[k] = (c[k] || 0) + 1; };
    const els = [el].concat([].slice.call(el.querySelectorAll('*'), 0, 600));
    for (const n of els) {
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'PATH' || tag === 'path') continue;
      const s = getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== 'none') bump('background-image');
      if (s.boxShadow && s.boxShadow !== 'none') bump('box-shadow');
      if (s.borderTopWidth !== '0px' || s.borderRightWidth !== '0px' || s.borderBottomWidth !== '0px' || s.borderLeftWidth !== '0px') bump('border');
      if (s.borderRadius && s.borderRadius !== '0px') bump('border-radius');
      if (s.maxWidth && s.maxWidth !== 'none') bump('max-width');
      if (s.transform && s.transform !== 'none') bump('transform');
      if (s.position === 'absolute' || s.position === 'fixed' || s.position === 'sticky') bump('position-' + s.position);
      if (s.display === 'flex' || s.display === 'grid') bump('display-' + s.display);
      if (s.gap && s.gap !== 'normal' && s.gap !== '0px') bump('gap');
      if (['Top', 'Right', 'Bottom', 'Left'].some((d) => { const v = s['padding' + d]; return v && v !== '0px'; })) bump('padding');
      if (['Top', 'Right', 'Bottom', 'Left'].some((d) => { const v = s['margin' + d]; return v && v !== '0px' && v !== 'auto'; })) bump('margin');
    }
    return c;
  };
  // Every image + CSS background image used inside a section (absolute URLs, de-duped).
  const sectionAssets = (el) => {
    const out = new Set();
    el.querySelectorAll('img').forEach((im) => { const u = abs(im.currentSrc || im.src || ''); if (/^https?:/.test(u)) out.add(u); });
    for (const n of [el, ...el.querySelectorAll('*')]) {
      const m = (getComputedStyle(n).backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1] && !m[1].startsWith('data:')) { const u = abs(m[1]); if (/^https?:/.test(u)) out.add(u); }
    }
    return [...out];
  };

  // Per-section: verbatim HTML + source class + computed look + assets + slider / block
  // decomposition. A hero whose background lives in an absolute layer (bgWrapperOf) stays VERBATIM.
  const sectionRoots = sectionEls.map((el) => bgWrapperOf(el) || el);
  sectionRoots.forEach((root, i) => {
    if (!sections[i]) return;
    sections[i].rawHtml = rawHtmlOf(root, true);
    sections[i].rawInner = rawHtmlOf(root, true, true); // inner HTML — the verbatim path hoists the root's class onto the builder section (no nested <section>)
    sections[i].sectionClass = (root.getAttribute && root.getAttribute('class')) || '';
    // The section's own id (`<section id="hero">`) → carried onto the builder section's CSS ID, so the
    // source's in-page anchor links (nav "Home" → #hero, smooth-scroll targets) still resolve. Read the
    // real <section> element, not a bg-wrapper root. Skip a generic/utility id (a class echoed as id).
    {
      const secEl = sectionEls[i] || root;
      const sid = (secEl.getAttribute && secEl.getAttribute('id')) || '';
      if (sid && /^[A-Za-z][\w-]*$/.test(sid)) sections[i].sectionId = sid;
    }
    // The section's content-column classes (e.g. col-lg-10 col-md-12 col-xl-8) — carried onto the
    // builder's intro column (fw-prefixed) so the content width matches the source.
    const contentCol = root.querySelector('[class*="col-"]');
    sections[i].colClass = contentCol ? colClasses(contentCol) : '';
    // A styling wrapper INSIDE the content column (e.g. <div class="cta-content bg-white p-5 rounded">)
    // → the builder column's Inner Wrapper Class. A single-column row is decomposed (not treated as a
    // row), so the wrapper div would otherwise be dived-through and its class dropped. Take the column's
    // sole element child when it wraps the heading and carries paint/spacing utilities.
    if (contentCol) {
      const fc = contentCol.firstElementChild;
      if (fc && contentCol.children.length === 1 && !/^H[1-6]$/.test(fc.tagName) && fc.querySelector('h1,h2,h3,h4,h5,h6')) {
        const wc = String(fc.className || '').trim();
        if (wc && /(^|\s)(bg-|p-|px-|py-|pt-|pb-|pl-|pr-|m-|rounded|shadow|border|card|content|inner|wrap|box)/i.test(wc)) {
          sections[i].innerWrapClass = wc;
        }
      }
    }
    sections[i].computed = sectionComputed(root); // appearance summary (spec)
    sections[i].diag = sectionDiag(root);          // report-only: border/shadow/radius/gradient
    sections[i].styleCensus = censusStyles(root);  // report-only: count of fidelity-critical computed props used by this section (vs what the carried CSS reproduces — drives the style-coverage report)
    sections[i].h = Math.round((root.getBoundingClientRect && root.getBoundingClientRect().height) || 0); // report-only: section height (px) — flags over-large/under-segmented sections
    sections[i].assets = sectionAssets(root);      // images / bg-images used in this section
    // Full decomposition for the MAPPING editor — every section (heroes included) broken into
    // its candidate elements, so the user can map each. Roles are suggested plugin-side.
    const mapBlocks = [];
    decompose(root, mapBlocks);
    sections[i].mapBlocks = mapBlocks;
    if (bgWrapperOf(sectionEls[i])) return; // hero with bg layer → auto-build keeps it verbatim
    const slider = detectSlider(root);
    if (slider) { sections[i].slider = slider; return; }
    // Heroes / h1 sections keep VERBATIM in the AUTO build: their text styling is usually scoped
    // to inner wrappers (e.g. `.banner .block h1`) that decomposition would drop. (The mapping
    // editor can still override this per-element.)
    // Heroes / h1 sections: decompose IF the structure is CLEAN — a decomposition where every block is
    // real (heading / text / buttons / testimonials / a row whose every cell is card / counter / buttons /
    // text / blocks / image / grid). A cell that would still fall to verbatim `html` means the scoped
    // inner-wrapper styling would be dropped, so keep the whole section VERBATIM. (Mapping editor can override.)
    // A cell is CLEAN only if it maps entirely to real shortcodes — a decomposed content column counts
    // only when NONE of its child blocks fell to verbatim `html` (an un-detected overline pill / stat row
    // leaves a code_block, which means the section is design-dense and should stay verbatim for fidelity).
    const MAPPABLE = ['heading', 'button', 'text', 'image', 'video', 'testimonials', 'pill', 'rating'];
    // Residual block kinds a decomposed hero column may carry that to-pages emits as a CONTAINED
    // code_block leaf (a small bespoke bit — a rating / social-proof row, an inline list) — these do
    // NOT force the WHOLE section verbatim. A column stays clean if it has ≥1 real block and every
    // other block is either mappable or one of these contained-verbatim kinds.
    const CONTAINED_OK = ['overline', 'row', 'html', 'image', 'list'];
    const cleanCell = (c) => c.card || c.counter || (c.buttons && c.buttons.length) || c.text || c.image || c.grid
      || c.imgComposite // an image + content-overlay cell kept verbatim is a CONTAINED code_block, not a section-verbatim trigger
      || (c.blocks && c.blocks.length
        && c.blocks.some((b) => MAPPABLE.includes(b.t))
        && c.blocks.every((b) => MAPPABLE.includes(b.t) || CONTAINED_OK.includes(b.t)));
    // A section decomposes as long as every top-level block is mappable OR a contained-verbatim leaf (a
    // decorative backdrop, or a row whose every cell is clean/contained). A decorative bg layer or one
    // image+badge composite no longer drags the whole (otherwise-clean) hero to a single code_block.
    const cleanHero = mapBlocks.length > 0 && mapBlocks.every((b) => (b.t !== 'html' || b.decor) && (b.t !== 'row' || (b.cols || []).every(cleanCell)));
    if (root.querySelector('h1') && !cleanHero) return;
    if (mapBlocks.some((b) => b.t !== 'html')) sections[i].blocks = mapBlocks;
  });

  // Strip pseudo-classes/elements so the bare selector can be test-matched — but NOT an ESCAPED
  // colon (`\:`), which is a Tailwind VARIANT separator inside the class name (`.md\:flex`,
  // `.lg\:hidden`, `.hover\:bg-x`). Without the lookbehind, `:flex` reads as a pseudo and gets
  // stripped → `.md\` matches nothing → every responsive/variant utility is silently dropped from
  // the carried CSS (the source's `hidden md:flex` nav then never un-hides → hamburger at desktop).
  // Strip only STATE pseudo-classes (:hover/:focus/… never active at capture time, so they'd make a
  // real rule fail `querySelector`) and pseudo-ELEMENTS (::before/…). KEEP structural pseudo-classes
  // (:not/:is/:where/:has/:nth-*/:first-child/…) — dropping those mangles the selector and loses the
  // rule: Tailwind's `space-y-*` (`.space-y-3 > :not([hidden]) ~ :not([hidden])`, the inter-item
  // margin-top) was becoming an invalid `.space-y-3 > ~` and getting dropped, so carried lists/columns
  // lost all their vertical spacing. `(?<!\\)` leaves escaped `\:` (Tailwind variant classes) intact.
  const stripPseudo = (sel) => sel
    .replace(/(?<!\\)::[\w-]+(\([^)]*\))?/g, '') // pseudo-elements (::before, ::after, ::placeholder, …)
    .replace(/(?<!\\):(?:hover|focus|focus-visible|focus-within|active|visited|target|checked|disabled|enabled|required|optional|valid|invalid|in-range|out-of-range|link|default|read-only|read-write|placeholder-shown|autofill|indeterminate|user-invalid|user-valid)\b(\([^)]*\))?/gi, '')
    .trim() || '*';
  const isGlobalSel = (test) => /^(:root|html|body|\*)$/i.test(test);
  const matchesPage = (test) => { if (isGlobalSel(test)) return true; try { return !!document.querySelector(test); } catch { return false; } };
  // A selector matches "within" a root if the root itself matches (ancestor-qualified
  // selectors evaluate against the live DOM) or any descendant matches.
  const matchesIn = (root, test) => { if (!root) return false; try { return root.matches(test) || !!root.querySelector(test); } catch { return false; } };

  // Vendor (framework/library) stylesheets stay GLOBAL — Bootstrap / Font Awesome / Owl /
  // Swiper / etc. are shared across sections, so they live once in the theme stylesheet. The
  // site's OWN rules are split per-section so each section carries its look in its Custom CSS.
  const VENDOR_RE = /(bootstrap|font-?awesome|owl[.-]?carousel|slick|swiper|splide|tiny-slider|animate(\.min)?\.css|aos|normalize|reset\.|jquery|magnific|fancybox|lightbox|nice-?select|select2|flatpickr|tailwind|line-?awesome|bootstrap-icons)/i;
  // Test only the PATH, not the full URL — otherwise a host like "orbitor-bootstrap.vercel.app"
  // makes EVERY sheet look like a vendor (bootstrap) and the site's own CSS never gets captured.
  const isVendorSheet = (href) => { try { return VENDOR_RE.test(new URL(href, location.href).pathname); } catch { return false; } };

  const chromeRoots = [headerEl, footerEl].filter(Boolean);

  const fontFaces = [];
  const linkedCss = [];
  // Global rules categorized by WHERE they're used, so the child theme can be written in a clean,
  // readable order: base/typography → utilities → header → footer. Each rule keeps its own @media
  // (responsive stays inline with its part, not lumped at the bottom).
  const buckets = { base: [], util: [], header: [], footer: [] };
  const siteRules = [];      // { media, parts:[selector,…], body } → matched per section below
  const pushCat = (cat, media, css) => buckets[cat].push({ media: media || '', css });
  // A selector with no class/id/attribute is a base element/typography/reset rule (body, h1-h6, p,
  // a, ul, li, *, …). Otherwise classify by whether it targets the header or footer; else a global
  // utility (.btn, .text-*, …) used somewhere on the page.
  const catFor = (sel) => {
    const t = stripPseudo(sel);
    if (!/[.#[]/.test(t)) return 'base';
    if (headerEl && matchesIn(headerEl, t)) return 'header';
    if (footerEl && matchesIn(footerEl, t)) return 'footer';
    return 'util';
  };
  const pushParts = (selParts, media, body) => {
    const by = { base: [], util: [], header: [], footer: [] };
    for (const p of selParts) by[catFor(p)].push(p);
    for (const cat of ['base', 'util', 'header', 'footer']) {
      if (by[cat].length) pushCat(cat, media, `${by[cat].join(', ')}{${body}}`);
    }
  };

  const walkRules = (rules, base, media, isVendor) => {
    for (const rule of rules) {
      switch (rule.type) {
        case 1: { // CSSStyleRule
          const parts = rule.selectorText.split(',').map((s) => s.trim()).filter(Boolean);
          const body  = absUrlsIn(rule.style.cssText, base);
          if (isVendor) {
            const keep = parts.filter((p) => matchesPage(stripPseudo(p)));
            if (keep.length) pushParts(keep, media, body);
          } else {
            // Site rule: root/html/body + header/footer parts go global (categorized); the whole
            // rule is also kept for per-section matching (a rule may serve both — duplication is inert).
            const gp = parts.filter((p) => { const t = stripPseudo(p); return isGlobalSel(t) || chromeRoots.some((r) => matchesIn(r, t)); });
            if (gp.length) pushParts(gp, media, body);
            // COMPLETENESS: every remaining page-matching utility (a class/id/attr selector that is
            // neither global nor chrome-scoped, e.g. body-section `.py-5`, `.feature-card`) ALSO goes
            // to the global `util` bucket. Previously these lived ONLY in per-section `siteRules`, so
            // when the source's utilities came from an inline <style> or a hash-named bundle (not
            // matched by VENDOR_RE) AND the per-section CSS merge was empty, every below-the-header
            // section shipped unstyled (the freshpaws "10% done" bug). This mirrors the "wholesale,
            // page-matched" treatment vendor sheets already get, making vendor-name detection
            // non-load-bearing for completeness. matchesPage() keeps it to selectors actually used on
            // the page, so we carry the used utilities — not the whole (possibly huge) framework.
            const up = parts.filter((p) => {
              const t = stripPseudo(p);
              return !isGlobalSel(t) && !chromeRoots.some((r) => matchesIn(r, t)) && matchesPage(t);
            });
            if (up.length) pushCat('util', media, `${up.join(', ')}{${body}}`);
            siteRules.push({ media: media || '', parts, body });
          }
          break;
        }
        case 3: // @import — recurse if readable, else re-link.
          try {
            if (rule.styleSheet) walkRules(rule.styleSheet.cssRules, rule.styleSheet.href || base, media, isVendor || isVendorSheet(rule.styleSheet.href || ""));
            else if (rule.href) linkedCss.push(new URL(rule.href, base).href);
          } catch { if (rule.href) linkedCss.push(new URL(rule.href, base).href); }
          break;
        case 4: case 12: { // @media / @supports — carry the at-rule down (single level; nesting is rare).
          const cond = rule.type === 4 ? `@media ${rule.media.mediaText}` : `@supports ${rule.conditionText}`;
          walkRules(rule.cssRules, base, media || cond, isVendor);
          break;
        }
        case 5: fontFaces.push(absUrlsIn(rule.cssText, base)); break;     // @font-face → fonts (top of base)
        case 7: pushCat('util', '', rule.cssText); break;                 // @keyframes → util (stripped later if anims off)
        default: break;
      }
    }
  };
  for (const sheet of document.styleSheets) {
    let rules = null;
    try { rules = sheet.cssRules; } catch { if (sheet.href) { linkedCss.push(sheet.href); } continue; }
    if (rules) walkRules(rules, sheet.href || location.href, '', isVendorSheet(sheet.href || ''));
  }

  const assemble = (chunks) => chunks.map((c) => (c.media ? `${c.media}{${c.css}}` : c.css)).join('\n');

  // Per-section CSS: the site's own rules that match within each captured section, trimmed to
  // just the matching selector parts. Goes into the section's Advanced → Custom CSS.
  sectionRoots.forEach((root, i) => {
    if (!sections[i]) return;
    const out = [];
    for (const r of siteRules) {
      const keep = r.parts.filter((p) => matchesIn(root, stripPseudo(p)));
      if (keep.length) out.push(r.media ? `${r.media}{${keep.join(', ')}{${r.body}}}` : `${keep.join(', ')}{${r.body}}`);
    }
    sections[i].css = out.join('\n');
  });

  // --- navigation mapper (framework-agnostic) -------------------------------
  // Extract the source nav into a portable menu TREE ({label, href, children}), regardless of
  // framework (Bootstrap .navbar-nav, Tailwind link group, plain <ul>). The converter builds a
  // real WordPress menu from it + renders wp_nav_menu (styled from the captured nav look). We
  // also mark the menu's spot in the header HTML with <!--SC_NAV--> so the swap is exact (no
  // regex surgery on nested dropdowns).
  const navMapper = (root) => {
    if (!root) return null;
    let menuUl = root.querySelector('.navbar-nav, ul.nav, .nav-menu, .menu, .main-menu');
    if (!menuUl) {
      const uls = [...root.querySelectorAll('ul')].filter((u) => u.querySelectorAll('li a').length >= 2);
      menuUl = uls.sort((a, b) => b.querySelectorAll('a').length - a.querySelectorAll('a').length)[0] || null;
    }
    if (!menuUl) return null;
    const itemFrom = (li) => {
      const a = li.querySelector(':scope > a') || li.querySelector('a');
      if (!a) return null;
      const label = clip(txt(a).replace(/\s*\(current\)\s*/i, '').trim(), 80);
      if (!label) return null;
      const href = abs(a.getAttribute('href') || '');
      const sub = li.querySelector(':scope > ul, :scope > .dropdown-menu, :scope > .sub-menu');
      const children = sub ? [...sub.querySelectorAll(':scope > li')].map(itemFrom).filter(Boolean) : [];
      return { label, href, children };
    };
    const tree = [...menuUl.querySelectorAll(':scope > li')].map(itemFrom).filter(Boolean);
    if (!tree.length) return null;
    const a0 = menuUl.querySelector('a');
    const lcs = a0 ? getComputedStyle(a0) : null;
    const ucs = getComputedStyle(menuUl);
    const dd = menuUl.querySelector('.dropdown-menu, :scope li ul, .sub-menu');
    const dcs = dd ? getComputedStyle(dd) : null;
    const gap = (ucs.columnGap && ucs.columnGap !== 'normal') ? ucs.columnGap : ((ucs.gap && ucs.gap !== 'normal') ? ucs.gap.split(' ').pop() : '');
    const style = {
      color: lcs ? lcs.color : '', fontSize: lcs ? lcs.fontSize : '', fontWeight: lcs ? lcs.fontWeight : '',
      letterSpacing: (lcs && lcs.letterSpacing !== 'normal') ? lcs.letterSpacing : '', textTransform: lcs ? lcs.textTransform : '',
      fontFamily: lcs ? lcs.fontFamily : '', gap,
      ddBg: dcs ? dcs.backgroundColor : '', ddShadow: (dcs && dcs.boxShadow !== 'none') ? dcs.boxShadow : '',
      ddRadius: dcs ? dcs.borderRadius : '', ddColor: dcs ? dcs.color : '',
    };
    return { menuUl, tree, style };
  };
  // --- footer mapper -------------------------------------------------------
  // Detect the footer's first column-row, count the columns, and grab each column's .widget inner
  // HTML (framework-agnostic). The converter maps them to the parent's footer-1..N widget areas
  // (Custom HTML placeholders the user then swaps for menus / social / text). The copyright bar is
  // grabbed separately → a child "Footer Copyright" widget area. Each spot is marked in the footer
  // HTML (<!--SC_FCOL_i-->, <!--SC_FCOPY-->) so the swap is exact.
  const footerMapper = (root) => {
    if (!root) return null;
    // Copyright block first, so we can exclude its column + map it to its own area.
    const copyEl = root.querySelector('.copyright, .footer-btm .copyright, .copyright-text, .footer-bottom .text-center')
      || ([...root.querySelectorAll('*')].find((e) => /copyright|©|&copy;|all rights/i.test(txt(e)) && txt(e).length < 220 && e.children.length <= 4) || null);
    // EVERY footer column slot, in DOM order, across ALL rows (a 3-row × 4-col footer → 12 slots).
    // Excludes the copyright's own column; keeps outermost columns only (no nested col double-count).
    let cols = [...root.querySelectorAll('[class*="col-"]')].filter((c) => {
      if (!/\bcol(-|\b)/i.test(String(c.className || ''))) return false;
      if (!txt(c).trim() && !c.querySelector('img')) return false;
      if (copyEl && (c === copyEl || c.contains(copyEl))) return false;
      return true;
    });
    cols = cols.filter((c) => !cols.some((o) => o !== c && o.contains(c)));
    if (!cols.length) return null;
    const colsHtml = cols.map((col) => {
      const w = col.querySelector('.widget') || col;
      return rawHtmlOf(w, false, true); // .widget INNER html (a widget area's <aside class="widget"> re-wraps it)
    });
    const copyHtml = copyEl ? rawHtmlOf(copyEl, false) : ''; // outer html (clean — its area has no wrapper)
    return { cols, colsHtml, copyEl, copyHtml };
  };

  const navInfo = headerEl ? navMapper(headerEl) : null;
  const footerInfo = footerEl ? footerMapper(footerEl) : null;
  // Footer HTML with each column's .widget + the copyright replaced by markers.
  const footerHtml = (() => {
    if (!footerEl) return rawHtmlOf(footerEl);
    if (!footerInfo) return rawHtmlOf(footerEl);
    footerInfo.cols.forEach((col, i) => { ( col.querySelector('.widget') || col ).setAttribute('data-sc-fcol', String(i)); });
    if (footerInfo.copyEl) { footerInfo.copyEl.setAttribute('data-sc-fcopy', '1'); }
    const clone = footerEl.cloneNode(true);
    footerEl.querySelectorAll('[data-sc-fcol]').forEach((e) => e.removeAttribute('data-sc-fcol'));
    footerEl.querySelectorAll('[data-sc-fcopy]').forEach((e) => e.removeAttribute('data-sc-fcopy'));
    clone.querySelectorAll('[data-sc-fcol]').forEach((e) => { e.replaceWith(document.createComment('SC_FCOL_' + e.getAttribute('data-sc-fcol'))); });
    clone.querySelectorAll('[data-sc-fcopy]').forEach((e) => { e.replaceWith(document.createComment('SC_FCOPY')); });
    return rawHtmlOf(clone);
  })();
  // Header HTML, with the nav <ul> replaced by an <!--SC_NAV--> placeholder when a menu was mapped.
  const headerHtml = (() => {
    if (!headerEl) return rawHtmlOf(headerEl);
    if (!navInfo || !navInfo.menuUl) return rawHtmlOf(headerEl);
    navInfo.menuUl.setAttribute('data-sc-nav', '1');
    const clone = headerEl.cloneNode(true);
    navInfo.menuUl.removeAttribute('data-sc-nav');
    const cu = clone.querySelector('[data-sc-nav]');
    if (cu) { cu.replaceWith(document.createComment('SC_NAV')); }
    return rawHtmlOf(clone);
  })();

  const chrome = (headerEl || footerEl) ? {
    header_html: headerHtml,
    nav_tree: navInfo ? navInfo.tree : [],
    nav_style: navInfo ? navInfo.style : null,
    footer_html: footerHtml,
    footer_cols: footerInfo ? footerInfo.colsHtml : [],
    footer_copyright: footerInfo ? footerInfo.copyHtml : '',
    // Categorized, unlabeled CSS groups — the plugin cleans each and writes them in a clean,
    // labeled order (base → utilities → header → [sections] → footer).
    base_css:   [fontFaces.join('\n'), assemble(buckets.base)].filter(Boolean).join('\n'),
    util_css:   assemble(buckets.util),
    header_css: assemble(buckets.header),
    footer_css: assemble(buckets.footer),
    linked_css: [...new Set(linkedCss)],
  } : null;

  // The site's content container width — FRAMEWORK-AGNOSTIC: a Bootstrap `.container`, a Tailwind
  // `max-w-7xl mx-auto`, or any centered max-width wrapper all resolve to the same computed
  // max-width. Mapped onto our `.fw-container` so the converted content column matches the source
  // (instead of the frontend-grid default ~1320px).
  // Site content-container width. A robust algorithm (the old one only knew Bootstrap `.container`
  // and returned the FIRST match, missing Tailwind `max-w-[1600px]` and picking stray wrappers):
  //   1. Collect every horizontally-CENTERED wrapper (margin-inline:auto, or equal non-zero L/R
  //      margins) that carries an explicit `max-width` in a sane range (600–2400px) and is actually
  //      rendered wide (≥480px) — i.e. a real content container, not an icon or a full-bleed band.
  //   2. Bucket by max-width and WEIGHT each bucket by the content AREA it wraps, so the main
  //      content container (header bar + hero + sections all share one max-width) dominates over a
  //      one-off narrow card that happens to be centered.
  //   3. The container width = the heaviest bucket's max-width.
  // Returns e.g. "1600px". The importer maps it to `.fw-container`'s width (both are border-box with
  // ~24px side padding, so the value transfers directly; see the demo-conversion playbook).
  const containerMax = (() => {
    const vw = window.innerWidth;
    // A RESPONSIVE container (Tailwind `.container`: max-width steps up per breakpoint — 640/768/1024/
    // 1280 and a 1536px cap at 2xl) must be captured at its DESIGN MAX, NOT the value at this one
    // capture viewport. Reading only the computed max-width at 1440px reports 1280 (the xl step) and
    // ships a too-narrow site that mismatches the source on any ≥1536px screen. So collect every
    // max-width declaration + its selector across ALL sheets (incl. inside @media) once, then a
    // candidate's design max = the LARGEST matching rule (or its computed value, whichever is bigger).
    const mwRules = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      const walk = (rs) => { for (const r of rs) {
        if (r.type === 4 || r.type === 12) { try { walk(r.cssRules); } catch { /* */ } }
        else if (r.type === 1 && r.style && r.style.maxWidth) {
          const mw = parseFloat(r.style.maxWidth);
          if (mw >= 600 && mw <= 2400 && r.selectorText) mwRules.push({ sel: r.selectorText, mw });
        }
      } };
      try { walk(rules); } catch { /* */ }
    }
    const designMax = (el) => {
      let best = parseFloat(getComputedStyle(el).maxWidth) || 0;
      for (const rr of mwRules) { if (rr.mw > best) { try { if (el.matches(rr.sel)) best = rr.mw; } catch { /* bad selector */ } } }
      return best;
    };
    const buckets = new Map(); // rounded max-width px -> summed content area
    for (const el of document.querySelectorAll('div,section,header,footer,main,article,nav')) {
      const mw = designMax(el);
      if (!mw || mw < 600 || mw > 2400) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 480) continue;
      // Centered = horizontally SYMMETRIC on the viewport (getComputedStyle resolves margin:auto
      // to 0px, so test the rendered box, not the margin value). This holds whether the container
      // fills the viewport (both gaps ~0) or is inset by auto margins (both gaps equal); an
      // asymmetric / left-aligned block (a sidebar) is rejected.
      const leftGap = r.left, rightGap = vw - r.right;
      if (Math.abs(leftGap - rightGap) > Math.max(8, r.width * 0.05)) continue;
      const key = Math.round(mw / 4) * 4; // tolerate sub-px rounding
      buckets.set(key, (buckets.get(key) || 0) + r.width * Math.max(1, r.height));
    }
    let best = 0, bestWeight = 0;
    for (const [px, weight] of buckets) { if (weight > bestWeight) { bestWeight = weight; best = px; } }
    return best ? best + 'px' : '';
  })();

  // Base heading typography (font-weight / color) read from the source's `h1..h6` / `.hN` rule.
  // Headings render inside page-builder component wrappers (e.g. .icon-box__title) whose CLASS
  // selector beats the source's element-level `h4 {…}`, so the theme re-asserts the base heading
  // weight/color at a higher specificity. Accumulated across matching rules (later wins, ~cascade).
  const baseHeading = (() => {
    const want = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', '.h1', '.h2', '.h3', '.h4', '.h5', '.h6']);
    const acc = {};
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule.type !== 1 || !rule.selectorText) continue;
        const parts = rule.selectorText.split(',').map((s) => s.trim());
        if (!parts.some((p) => want.has(p))) continue;
        const w = rule.style.getPropertyValue('font-weight'); if (w) acc.weight = w.trim();
        const c = rule.style.getPropertyValue('color'); if (c) acc.color = c.trim();
      }
    }
    return acc;
  })();

  return {
    title: document.title,
    tailwind: detectTailwind(), // source built with Tailwind → mapper trusts the `styles.tw` token intent
    tokens: { vars, brandColor, brandHover, body: pick(bodyCS, ['fontFamily', 'color', 'backgroundColor', 'lineHeight', 'fontSize']) },
    layout: { container_max: containerMax },
    baseHeading,
    header, footer, sections, chrome,
    assets: { images: [...imgs].filter((u) => /^https?:/.test(u)), fonts },
  };
}
