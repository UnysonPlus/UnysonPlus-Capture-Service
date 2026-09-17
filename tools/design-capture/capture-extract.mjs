// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Shared in-page extraction for the design-capture pipeline.
// Runs INSIDE the rendered page (headless Chrome) via page.evaluate() — used by both
// the local CLI (capture.mjs) and the hosted Cloudflare Worker. Must be fully
// self-contained: every helper is defined inline; only browser globals are referenced.
export function extractDesign() {
  // The PHONE-pass diff the capture stamped (data-sc-cs-sm: only the values that differ at 390px) as a { prop: value } map.
  const smOf = (el, attr = 'data-sc-cs-sm') => { const out = {}; const raw = (el && el.getAttribute && el.getAttribute(attr)) || ''; for (const d of raw.split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim(); } return out; };
  const mdOf = (el) => smOf(el, 'data-sc-cs-md'); // the TABLET-pass diff (820px)
  const xlOf = (el) => smOf(el, 'data-sc-cs-xl'); // the WIDE-pass diff (1920px → the >= 1536px tier)
  const pick = (s, keys) => { const o = {}; if (s) keys.forEach((k) => (o[k] = s[k])); return o; };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const hasBg = (c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
  // The page's BODY face (first family, lowercased, unquoted) and a leaf's OWN face when it differs — a mono chip /
  // value inside a sans card carries its family on the block, since no section styler reaches a nested block.
  // PHP: Mapper::set_body_face / first_face / nested_face_decl.
  const firstFace = (ff) => String(ff || '').split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
  let _bodyFace = ''; try { _bodyFace = firstFace(getComputedStyle(document.body).fontFamily); } catch { _bodyFace = ''; }
  const ownFaceOf = (cs) => { const ff = String((cs && cs.fontFamily) || '').trim(); if (!ff || !_bodyFace || !/^[a-z0-9"',\s-]+$/i.test(ff)) return ''; return firstFace(ff) === _bodyFace ? '' : ff.replace(/"/g, "'"); };

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
        // squiggle (a pet-care demo: a `<path d="M0 5 Q 50 10 100 5">` under "Second Home"). Keep it VERBATIM;
        // the default accent-span reconstruction below only rebuilds TEXT, so it drops the <path> and the
        // graphic vanishes. The svg's own classes (absolute / w-full / text-secondary) ride along.
        if (tag === 'svg') {
          let svg = n.outerHTML.replace(/\s+/g, ' ').trim();
          // Inline the svg's COMPUTED colour so its `stroke="currentColor"` / `fill="currentColor"`
          // resolves to the source accent (the demo underline = amber `text-secondary`) on the PAGE
          // BODY — the `.text-secondary{color:…}` rule the source relies on lives under the `.sc-tw`
          // chrome scope, not the body, so without this the underline inherits BLACK. Parity with the
          // PHP mapper's resolve_color_classes(); merge additively into any existing root style="".
          const sc = getComputedStyle(n).color;
          if (sc && !/^rgba?\(0,\s*0,\s*0,\s*0\)$/.test(sc.replace(/\s+/g, ''))) {
            const open = svg.slice(0, (svg.indexOf('>') + 1) || svg.length);
            if (/\bstyle\s*=\s*"/.test(open)) { svg = svg.replace(/\bstyle\s*=\s*"([^"]*)"/, (_m, ex) => `style="${ex.replace(/;?\s*$/, ';')}color:${sc}"`); }
            else { svg = svg.replace(/^<svg\b/i, `<svg style="color:${sc}"`); }
          }
          html += svg; sawTag = true; continue;
        }
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
          // Keep the source semantic class (the child theme can re-theme it) AND inline the computed
          // colour, so the two-tone span paints on the page BODY without depending on the `.sc-tw`-scoped
          // `.text-primary{color:…}` rule (which never lands on the body → black). Parity with the PHP
          // mapper's resolve_color_classes().
          inner = (acls && !deadColorClass)
            ? `<span class="${acls}" style="color:${s.color}">${inner}</span>`
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
  // The source's own `X:hover{color / background}` RULE (a plain-CSS site has no `hover:` utility): scan the
  // stylesheets once for :hover rules and read the first whose selector (with :hover stripped) matches the
  // element. PHP twin reads the capture's data-sc-hover stamp (stamped AFTER this extraction, so not here).
  // MEDIA-AWARE: the capture is a desktop snapshot, so a rule inside '@media (max-width:768px)' does not apply to it
  // (a mobile '.shell{width:min(100% - 32px,…)}' otherwise beat the desktop rule). PHP twin: sheet_unwrap_at_rules.
  const mediaApplies = (r) => { try { return !r.media || !r.media.mediaText || window.matchMedia(r.media.mediaText).matches; } catch { return true; } };
  let _hoverRules = null;
  const sheetHover = (el) => {
    if (!_hoverRules) {
      _hoverRules = [];
      const walk = (list) => { for (const r of list) { if (r.media && r.cssRules) { if (mediaApplies(r)) walk(r.cssRules); continue; } if (r.selectorText && r.selectorText.includes(':hover') && r.style) _hoverRules.push(r); } };
      for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch { continue; } walk(rules); }
    }
    const out = {};
    for (const r of _hoverRules) {
      for (const sel of r.selectorText.split(',')) {
        if (!sel.includes(':hover') || /::?(before|after)/.test(sel)) continue;
        const base = sel.replace(/:hover/g, '').trim(); if (!base) continue;
        let hit = false; try { hit = el.matches(base); } catch { hit = false; }
        if (!hit) continue;
        if (r.style.color) out.color = r.style.color;
        if (r.style.backgroundColor) out.backgroundColor = r.style.backgroundColor;
        if (r.style.borderColor || r.style.borderTopColor) out.borderColor = r.style.borderColor || r.style.borderTopColor;
      }
    }
    return Object.keys(out).length ? out : null;
  };
  // The FLUID font-size the source DECLARES for an element (`font-size:clamp(2.9rem,5.6vw,6rem)`) — the computed
  // px is one viewport's snapshot; the mapper carries the expression so the title keeps scaling. Last matching
  // non-pseudo rule wins; '' unless the value is clamp()/min()/max()/vw-based. PHP twin: stylesheet_decl + fs_decl.
  const _declRules = {};
  const sheetDecl = (el, prop) => {
    if (!_declRules[prop]) {
      const acc = _declRules[prop] = [];
      const walk = (list) => { for (const r of list) { if (r.media && r.cssRules) { if (mediaApplies(r)) walk(r.cssRules); continue; } if (r.selectorText && r.style && r.style[prop]) acc.push(r); } };
      for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch { continue; } walk(rules); }
    }
    let val = '';
    for (const r of _declRules[prop]) {
      for (const sel of r.selectorText.split(',')) {
        if (/::?[a-z-]+/.test(sel.replace(/:not\([^)]*\)/g, ''))) continue;
        let hit = false; try { hit = el.matches(sel.trim()); } catch { hit = false; }
        if (hit) val = r.style[prop];
      }
    }
    return val;
  };
  // A fluid heading keeps its RELATIVE metrics: the source's 'line-height:.9' / 'letter-spacing:-.06em' scale with
  // the font, so a computed px snapshot would freeze them at one viewport. The sheet's relative declaration wins
  // (unitless / em / %); otherwise the computed pair yields the ratio (lh ÷ fs → unitless; ls ÷ fs → em). PHP twin:
  // fluid_relative_decls → lh_decl / ls_decl.
  const fluidRelativeDecls = (el, cs) => {
    const out = { lh: '', ls: '' };
    const fs = parseFloat(cs.fontSize) || 0;
    const r3 = (a, b) => String(Math.round((a / b) * 1000) / 1000);
    const lh = sheetDecl(el, 'lineHeight');
    if (/^(?:\d*\.?\d+|[0-9.]+(?:em|%))$/i.test(lh)) out.lh = lh;
    else if (fs > 0 && /^[0-9.]+px$/.test(cs.lineHeight)) out.lh = r3(parseFloat(cs.lineHeight), fs);
    const ls = sheetDecl(el, 'letterSpacing');
    if (/^-?[0-9.]+(?:em|%)$/i.test(ls)) out.ls = ls;
    else if (fs > 0 && /^-?[0-9.]+px$/.test(cs.letterSpacing) && parseFloat(cs.letterSpacing) !== 0) out.ls = r3(parseFloat(cs.letterSpacing), fs) + 'em';
    return out;
  };
  let _fsRules = null;
  const sheetFontSizeDecl = (el) => {
    if (!_fsRules) {
      _fsRules = [];
      const walk = (list) => { for (const r of list) { if (r.media && r.cssRules) { if (mediaApplies(r)) walk(r.cssRules); continue; } if (r.selectorText && r.style && r.style.fontSize) _fsRules.push(r); } };
      for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch { continue; } walk(rules); }
    }
    let val = '';
    for (const r of _fsRules) {
      for (const sel of r.selectorText.split(',')) {
        if (/::?[a-z-]+/.test(sel.replace(/:not\([^)]*\)/g, ''))) continue;
        let hit = false; try { hit = el.matches(sel.trim()); } catch { hit = false; }
        if (hit) val = r.style.fontSize;
      }
    }
    return /^(?:clamp|min|max)\(|vw|vh|cq[wh]/i.test(val) ? val : '';
  };
  const hoverStyle = (el) => {
    if (!el || !el.getAttribute) return null;
    const hoverCls = (el.getAttribute('class') || '').split(/\s+/).filter((c) => c.startsWith('hover:'));
    if (!hoverCls.length) return sheetHover(el);
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
    // the section ROOT itself can be the card grid (a segmented band = the `grid md:grid-cols-3` of cards); PHP: section_root_row
    [sec, ...sec.querySelectorAll('*')].forEach((container) => {
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
      // Title: a real heading first, then bold, then a class-named title element (`.card-title`,
      // `.title`, `.name`, `[class*=heading]`) — many hand-built card pens use a <div>/<span> for the
      // title, not an <hN>, and missing it left every card title empty (→ the whole grid fell back to a
      // verbatim code_block instead of native card shortcodes). Mirror in PHP collect_cards.
      const h = k.querySelector('h2,h3,h4,h5,h6') || k.querySelector('strong,b')
        || k.querySelector('[class*="title" i],[class*="heading" i],[class*="name" i]');
      const p = k.querySelector('p');
      const title = clip(txt(h), 120);
      const body = p ? txt(p) : (h ? txt(k).replace(txt(h), '').trim() : txt(k));
      // Leading step number (01 / 1 / 12 …) if the card is a numbered step.
      const numEl = [...k.querySelectorAll('*')].find((e) => e.children.length === 0 && /^(0[1-9]|[1-9]|1[0-2])$/.test(txt(e)) && !(() => { for (let a = e.parentElement; a && a !== k; a = a.parentElement) { try { const ps = getComputedStyle(a).position; if (ps === 'absolute' || ps === 'fixed') return true; } catch { return false; } } return false; })()); // a number in an absolute chip over a photo (a date badge) is no step number
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
  // An ABSOLUTE covering layer painted with a TILE (a data-URI svg, a repeating gradient, a small-background-size gradient
  // dot grid) — or an empty wrapper whose only descendants are such layers (an opacity / blend wrapper). It is the band's
  // Background Pattern (findPattern), never content. (The capture stamps data-sc-pattern-layer AFTER the extract runs.)
  const isPatternLayer = (el) => {
    try {
      if (!el || el.nodeType !== 1 || txt(el).trim() || el.querySelector('img, video, svg, a, button, h1, h2, h3, h4, h5, h6, p')) return false;
      const cs = getComputedStyle(el); if (cs.position !== 'absolute' && cs.position !== 'fixed') return false;
      const pe = el.parentElement; if (!pe) return false;
      const r = el.getBoundingClientRect(), pr = pe.getBoundingClientRect();
      if (r.width < pr.width * 0.9 || r.height < pr.height * 0.9 || r.height < 120) return false;
      const bg = cs.backgroundImage || 'none'; const bs = cs.backgroundSize || '';
      const tiled = /^\d+(?:\.\d+)?px \d+(?:\.\d+)?px$/.test(bs) && parseFloat(bs) <= 96 && /gradient\(/.test(bg);
      if (bg !== 'none' && (/data:image\/svg|repeating-(?:linear|radial)-gradient/i.test(bg) || tiled)) return true;
      const kids = [...el.children]; return kids.length > 0 && kids.every(isPatternLayer);
    } catch { return false; }
  };
  const findPattern = (sec) => {
    // the capture's stamp first (capture.mjs: a covering CHILD layer tiled by a small background-size — a dot grid — with the
    // wrapper chain's opacity folded in and the tile's size / blend as data-sc-pattern-extra). PHP detect_section_pattern.
    const st = sec.getAttribute && sec.getAttribute('data-sc-pattern');
    if (st && st !== 'none') {
      const extra = sec.getAttribute('data-sc-pattern-extra') || ''; const xm = extra.match(/background-size:([^;]+)/); const bm = extra.match(/mix-blend-mode:([^;]+)/);
      return { image: st, repeat: 'repeat', size: xm ? xm[1].trim() : '', opacity: Math.min(1, parseFloat(sec.getAttribute('data-sc-pattern-opacity')) || 1), blend: bm ? bm[1].trim() : '' };
    }
    const els = [sec, ...sec.querySelectorAll('div')].slice(0, 60);
    let er; try { er = sec.getBoundingClientRect(); } catch { er = null; }
    for (const el of els) {
      for (const s of [getComputedStyle(el), getComputedStyle(el, '::before'), getComputedStyle(el, '::after')]) {
        const bg = s.backgroundImage;
        if (!bg || bg === 'none' || bg.length > 2000) continue;
        const bs = s.backgroundSize || ''; const tiled = /^\d+(?:\.\d+)?px \d+(?:\.\d+)?px$/.test(bs) && parseFloat(bs) <= 96 && /gradient\(/.test(bg);
        if (!/data:image\/svg|repeating-(linear|radial)-gradient/i.test(bg) && !tiled) continue;
        if (tiled && el !== sec) { // a tiled child must COVER the band (else it is a card's own texture)
          let r; try { r = el.getBoundingClientRect(); } catch { continue; }
          if (!er || r.width < er.width * 0.9 || r.height < er.height * 0.9) continue;
        }
        let op = Math.min(1, parseFloat(s.opacity) || 1); let blend = (s.mixBlendMode && s.mixBlendMode !== 'normal') ? s.mixBlendMode : '';
        for (let a = el.parentElement; a && a !== sec && el !== sec; a = a.parentElement) { let acs; try { acs = getComputedStyle(a); } catch { break; } op *= Math.min(1, parseFloat(acs.opacity) || 1); if (!blend && acs.mixBlendMode && acs.mixBlendMode !== 'normal') blend = acs.mixBlendMode; }
        return { image: bg, repeat: s.backgroundRepeat, size: s.backgroundSize, opacity: Math.round(op * 1000) / 1000, blend };
      }
    }
    return null;
  };
  // A band's PSEUDO-ELEMENT scrim — the dark tint painted by `::before` / `::after` (`.hero::after{inset:0;
  // background: radial-gradient(…), linear-gradient(…)}`), which no DOM element carries. Returns the covering
  // pseudo-layer's own background layers (gradients or a translucent colour) + opacity, or null. Twin of the
  // capture.mjs `data-sc-scrim` stamp the PHP media_bg_overlay / video-band readers consume.
  const findPseudoScrim = (sec) => {
    let er; try { er = sec.getBoundingClientRect(); } catch { return null; }
    if (er.width < 200 || er.height < 120) return null;
    for (const pe of ['::before', '::after']) {
      let s; try { s = getComputedStyle(sec, pe); } catch { continue; }
      if (!s || s.content === 'none' || s.content === 'normal' || s.display === 'none') continue;
      if (s.position !== 'absolute' && s.position !== 'fixed') continue;
      const covers = s.inset === '0px' || (s.top === '0px' && s.left === '0px' && s.right === '0px' && s.bottom === '0px')
        || (parseFloat(s.width) >= er.width * 0.9 && parseFloat(s.height) >= er.height * 0.9);
      if (!covers) continue;
      const bgi = s.backgroundImage || 'none', bgc = s.backgroundColor || '';
      let layers = '';
      if (bgi !== 'none' && /gradient\(/i.test(bgi) && !/url\(/i.test(bgi) && bgi.length <= 1500) layers = bgi;
      else if (/^rgba\(/i.test(bgc) && !/,\s*0\s*\)$/.test(bgc)) layers = bgc;
      if (!layers) continue;
      return { layers, opacity: Math.min(1, parseFloat(s.opacity) || 1) };
    }
    return null;
  };
  // A SHAPE DIVIDER — an edge-pinned SVG wave/tilt/curve/triangle at a section's top or bottom → the native
  // section divider option (NOT verbatim). Classifies the path silhouette by curve-command count. Parity with
  // PHP detect_section_divider().
  const findDivider = (sec) => {
    for (const svg of sec.querySelectorAll('svg')) {
      let w = svg, placement = '', flip = 'no';
      for (let i = 0; i < 3 && w && w !== sec; i++) {
        const cs = getComputedStyle(w);
        if (/-1(,\s*0)?\)/.test(cs.transform || '') || /rotate-180|scale-x-\[?-1|(?:^|\s)flip(?:-x)?\b/.test(w.className || '')) flip = 'yes';
        if (cs.position === 'absolute' || cs.position === 'fixed') {
          if (parseFloat(cs.top) === 0) placement = 'top';
          else if (parseFloat(cs.bottom) === 0) placement = 'bottom';
          break;
        }
        w = w.parentElement;
      }
      if (!placement) continue;
      const path = svg.querySelector('path'); if (!path) continue;
      const d = path.getAttribute('d') || ''; if (!d) continue;
      const curves = (d.match(/[CcSsQqTt]/g) || []).length;
      const shape = curves >= 3 ? 'wave' : (curves >= 1 ? 'curve' : ((d.match(/[Ll]/g) || []).length >= 3 ? 'triangle' : 'tilt'));
      const ha = svg.getAttribute('height'); const hm = ha && String(ha).match(/^([0-9.]+)/);
      const height = hm ? String(Math.round(parseFloat(hm[1]))) : String(Math.round(svg.getBoundingClientRect().height || 0)) || '';
      let fill = path.getAttribute('fill') || ''; if (!fill || fill === 'currentColor') fill = svg.getAttribute('fill') || '';
      const color = (fill && fill.toLowerCase() !== 'currentcolor' && fill !== 'none') ? fill : '';
      return { placement, shape, height, color, flip };
    }
    return null;
  };
  // Ambient particle/background LAYERS a source names descriptively (`fg-leaves`, `fg-sakura`, `#grain`,
  // a `.snow`/`.rain` overlay …) → the nearest built-in Background Effect. The mapper emits these as
  // STACKED bg_effect slots on the section (parity with PHP detect_section_bg_effects). High-precision:
  // the element must read as decorative (a <canvas>, aria-hidden, a layer-marker class like
  // `fg`/`particle`/`layer`, or absolute/fixed position) AND carry an effect keyword. A bespoke unnamed
  // WebGL scene (kage's three.js `#gl`, whose "embers" live only in JS) is NOT guessed here — that
  // ambiguous long tail is where the AI tiers pick the closest effect or skip.
  const bgFxMap = [
    [/(?:^|[\s_-])(?:leaf|leaves|sakura|petal|petals|blossom|cherry)(?:[\s_-]|$)/, 'snow', 'petals'],
    [/(?:^|[\s_-])(?:ember|embers|cinder|cinders)(?:[\s_-]|$)/, 'snow', 'embers'],
    [/(?:^|[\s_-])(?:ash|ashes)(?:[\s_-]|$)/, 'snow', 'ash'],
    [/(?:^|[\s_-])(?:snow|snowflake|flake|flakes)(?:[\s_-]|$)/, 'snow', 'snow'],
    [/(?:^|[\s_-])(?:rain|rainfall|drizzle|droplet|droplets)(?:[\s_-]|$)/, 'rain', ''],
    [/(?:^|[\s_-])(?:starfield|stars)(?:[\s_-]|$)/, 'starfield', ''],
    [/(?:^|[\s_-])(?:constellation)(?:[\s_-]|$)/, 'constellation', ''],
    [/(?:^|[\s_-])(?:confetti)(?:[\s_-]|$)/, 'confetti', ''],
    [/(?:^|[\s_-])(?:bubble|bubbles)(?:[\s_-]|$)/, 'bubbles', ''],
    [/(?:^|[\s_-])(?:firefly|fireflies)(?:[\s_-]|$)/, 'fireflies', ''],
    [/(?:^|[\s_-])(?:meteor|meteors|shooting-?stars?)(?:[\s_-]|$)/, 'meteors', ''],
    [/(?:^|[\s_-])(?:particle|particles)(?:[\s_-]|$)/, 'particles', ''],
    [/(?:^|[\s_-])(?:grain|film-?grain|noise)(?:[\s_-]|$)/, 'noise', ''],
    [/(?:^|[\s_-])(?:matrix)(?:[\s_-]|$)/, 'matrix', ''],
    [/(?:^|[\s_-])(?:aurora)(?:[\s_-]|$)/, 'aurora', ''],
    [/(?:^|[\s_-])(?:borealis)(?:[\s_-]|$)/, 'borealis', ''],
  ];
  const bgFxMarker = /(?:^|\s)(?:fg|fg-el|particles?|layers?|decor|backdrop|bg-scene|art-layers?|overlay|ambient)(?:-[a-z0-9]+)?(?:\s|$)/;
  const findBgEffects = (sec) => {
    const out = [], seen = new Set();
    const els = [...sec.querySelectorAll('*')].slice(0, 600);
    for (const el of els) {
      const hay = ' ' + ((el.getAttribute('class') || '') + ' ' + (el.id || '')).toLowerCase().trim() + ' ';
      if (hay.trim() === '') continue;
      const tag = el.tagName.toLowerCase();
      let decor = tag === 'canvas'
        || String(el.getAttribute('aria-hidden') || '').toLowerCase() === 'true'
        || bgFxMarker.test(hay);
      if (!decor) { const p = getComputedStyle(el).position; decor = p === 'absolute' || p === 'fixed'; }
      if (!decor) continue;
      for (const [re, effect, variant] of bgFxMap) {
        if (re.test(hay)) {
          const key = effect + ':' + variant;
          if (seen.has(key)) break;           // de-dupe identical layers (leaves + sakura → one petals)
          seen.add(key);
          out.push({ effect, variant });
          break;                              // first (most specific) keyword wins for this element
        }
      }
      if (out.length >= 4) break;             // auto-detection cap (users can add more by hand)
    }
    return out;
  };
  // Evidence for the AI tiers: a section has an ANIMATED BACKDROP (a WebGL/particle canvas or a strongly
  // "ambient" layer) that the deterministic keyword pass could NOT name. We hand the local model / Claude
  // these compact tokens + any engine hint so it can pick the closest built-in effect (or none). Returned
  // only when there is a STRONG signal (a <canvas> or an ambient-marker class) AND deterministic found
  // nothing — so a plain absolute-positioned decor div never triggers an AI call.
  const bgFxStrong = /(?:particle|canvas|webgl|three|gsap|pixi|shader|sim|backdrop|bg-scene|fg-el|ambient|effect-layer|animate-bg)/;
  const findBgFxCandidate = (sec) => {
    const tokens = new Set();
    let engine = '';
    const els = [...sec.querySelectorAll('canvas, [class], [id]')].slice(0, 400);
    for (const el of els) {
      const tag = el.tagName.toLowerCase();
      const cls = (el.getAttribute('class') || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const isCanvas = tag === 'canvas';
      if (!isCanvas && !bgFxStrong.test(cls + ' ' + id)) continue;
      if (isCanvas) { const en = el.getAttribute('data-engine') || el.getAttribute('data-lib') || ''; if (en && !engine) engine = String(en).slice(0, 40); }
      for (const t of (cls + ' ' + id).split(/[\s]+/)) { if (t && t.length <= 40 && bgFxStrong.test(t)) tokens.add(t); }
      if (isCanvas) tokens.add('canvas');
      if (tokens.size >= 8) break;
    }
    if (!tokens.size && !engine) return null;
    return { tokens: [...tokens].slice(0, 8), engine };
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
  // A full-viewport <header> that holds the H1 + CTA (AI-page-style: `<header class="min-h-screen">`,
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
  // …or a <header> that is a CONTENT band by shape: inside <main>, a heading but no link / nav at all (a grid canvas's hero
  // copy) — a masthead always carries links; the fixed <nav> beside it is the masthead (PHP: header_root).
  const _linklessHeroHeader = !!(headerEl && headerEl.closest('main') && !headerEl.querySelector('a, nav') && headerEl.querySelector('h1, h2'));
  const _heroAsHeader = isHeroHeader(headerEl) || _linklessHeroHeader;
  if (!headerEl || _heroAsHeader) {
    // SPA sites (Lovable / v0 / React) often skip <header> — the nav is a top-pinned bar. Also used
    // when the first <header> is really a hero: find the SEPARATE top nav bar and use IT as the
    // masthead. Topmost <nav>/navbar-classed element at the very top, full-ish width, ≥2 links/buttons.
    const cands = [...document.querySelectorAll('nav, [class*="navbar" i], [class*="header" i]')];
    const navBar = cands
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      // top <= 200, not <= 8: a DETACHED / floating masthead (the pill and card designs, and
      // ~15% of measured generated sites) sits 16-128px below the viewport top and would
      // otherwise be missed entirely, falling back to the hero. Height still gates out banners.
      .filter(({ el, r }) => r.top <= 200 && r.height > 0 && r.height <= 130 && r.width >= 300
        && (el.querySelectorAll('a, button').length >= 2 || (el.tagName === 'NAV' && /fixed|sticky/.test(getComputedStyle(el).position) && el.children.length >= 2))) // a LABEL-ONLY fixed nav bar (no links) is still the masthead
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
      // Skip HIDDEN items — a responsive overflow toggle ("More") or a mobile-only duplicate menu is
      // display:none at desktop, so it must not leak into the captured nav. Mirror in PHP nav_is_hidden.
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && el.getAttribute('aria-hidden') !== 'true';
      })
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
      // backdropFilter / boxShadow / borderRadius: a header that frosts (or lifts, or rounds) AT REST
      // and never changes on scroll has no header_scroll snapshot, so these were invisible to the
      // mapper and its Glass Blur / Shadow Depth options could never fire.
      // borderBottom*: a bar's hairline is its own bottom border (a source sheet's `.header{border-bottom:1px
      // solid …}`); without it the at-rest header_border could only fire from a scroll snapshot.
      element: pick(hcs, ['display', 'justifyContent', 'alignItems', 'backgroundColor', 'position', 'padding', 'backdropFilter', 'boxShadow', 'borderRadius', 'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor']),
      bar: pick(inner, ['display', 'justifyContent', 'backgroundColor', 'borderRadius', 'border', 'padding', 'maxWidth', 'backdropFilter', 'boxShadow']),
      logo: logoImg ? { type: 'image', src: abs(logoImg.currentSrc || logoImg.src) }
        : (logoLink ? { type: 'text', text: logoLink.textContent.trim(), icon: logoIcon(logoLink), computed: pick(getComputedStyle(logoLink), ['fontFamily', 'fontSize', 'fontWeight', 'color', 'letterSpacing']) } : null),
      // paddingLeft/Top: the link's own inset (PHP H3 menu_link_padding parity) — a padding-less, gap-spaced
      // row must pin the theme's default inset to 0 or every item box inflates.
      nav: navLinks.map((a) => ({ label: a.textContent.trim(), href: abs(a.getAttribute('href') || ''), computed: pick(getComputedStyle(a), ['fontFamily', 'fontSize', 'fontWeight', 'color', 'paddingLeft', 'paddingTop']), hover: hoverStyle(a) })),
      // The nav row's own `gap` (the spacing between padding-less links), read off the links' common parent.
      navGap: (() => { const p = navLinks[0] && navLinks[0].parentElement; if (!p || !navLinks[1] || !p.contains(navLinks[1])) return 0; const g = parseFloat(getComputedStyle(p).columnGap || getComputedStyle(p).gap); return g > 0 ? Math.round(g) : 0; })(),
      cta: cta ? { label: cta.textContent.trim(), href: abs(cta.getAttribute('href') || ''), computed: pick(getComputedStyle(cta), ['backgroundColor', 'color', 'borderRadius', 'padding', 'fontFamily', 'fontWeight']), hover: hoverStyle(cta) } : null,
    };
    // ---- masthead STRUCTURE (parity with PHP detect_header → ctas / rows / chips) ----
    const clsOf = (el) => (el && el.className && el.className.toString ? el.className.toString() : '');
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && el.getAttribute('aria-hidden') !== 'true'; };
    const inNav = (el) => !!(navEl && el !== navEl && navEl.contains(el));
    // A link that READS as a button by computed style (padding + a fill / border / rounding) — PHP cs_is_button().
    const btnLike = (el) => { const s = getComputedStyle(el); const bw = s.borderTopWidth; return parseFloat(s.paddingLeft) > 0 && (hasBg(s.backgroundColor) || (bw && bw !== '0px' && s.borderTopStyle !== 'none') || parseFloat(s.borderTopLeftRadius) > 0); };
    // EVERY masthead action in DOM order — a header often carries TWO CTAs and `cta` above keeps one. Each
    // carries its classes + skin so the theme-settings mapper resolves it to the matching button preset.
    // SECONDARY TEXT LINKS in the action cluster — a plain <a> ("Sign in") sharing a parent with a button-styled CTA, not a
    // button, not the brand, not a nav row (3+ plain links beside a button). PHP: header_text_links.
    header.textLinks = [...headerEl.querySelectorAll('a')].filter((a) => {
      const t = txt(a); const href = a.getAttribute('href') || '';
      if (!t || t.length > 24 || !href || !visible(a) || a === logoLink || a.querySelector('img,svg')) return false;
      const c = clsOf(a); if (/\b(btn|button|cta)\b/i.test(c) || btnLike(a)) return false;
      if (/(^|\s|-|_)(brand|logo)(\s|-|_|$)/i.test(c)) return false;
      const par = a.parentElement; if (!par) return false;
      let hasCta = false, plain = 0;
      for (const k of par.children) { if (!/^(A|BUTTON)$/.test(k.tagName) || !txt(k)) continue; if (k.tagName === 'BUTTON' || /\b(btn|button|cta)\b/i.test(clsOf(k)) || btnLike(k)) hasCta = true; else plain++; }
      return hasCta && plain <= 2;
    }).slice(0, 2).map((a) => { const s2 = getComputedStyle(a); return { label: txt(a), href: abs(a.getAttribute('href') || ''), color: s2.color, fontSize: s2.fontSize, fontWeight: s2.fontWeight, letterSpacing: s2.letterSpacing, textTransform: s2.textTransform, hover: hoverStyle(a) }; });
    header.ctas = links.filter((el) => {
      const t = txt(el); if (!t || t.length > 40 || !visible(el)) return false;
      const c = clsOf(el);
      if (/\b(toggle|toggler|hamburger|menu-?icon|navbar-toggler|search)\b/i.test(c)) return false;
      const tag = el.tagName.toLowerCase(); const href = el.getAttribute('href') || '';
      if (tag === 'button') return !inNav(el) && !el.hasAttribute('aria-controls') && !el.hasAttribute('aria-haspopup');
      if (/^tel:/i.test(href)) return true;
      if (!(/\b(btn|button|cta)\b/i.test(c) || btnLike(el))) return false;
      return !(inNav(el) && !href);
    }).slice(0, 4).map((el) => {
      const s = getComputedStyle(el);
      const bw = (s.borderTopWidth && s.borderTopWidth !== '0px') ? s.borderTopWidth : '';
      return { label: txt(el), href: abs(el.getAttribute('href') || ''), cls: clsOf(el),
        bs: { bg: hasBg(s.backgroundColor) ? s.backgroundColor : '', fg: s.color || '', bw, bds: bw ? s.borderTopStyle : '', bd: bw ? s.borderTopColor : '', grad: /linear-gradient\(/i.test(s.backgroundImage || '') ? s.backgroundImage : '' },
        fs: s.fontSize, pad: s.padding, height: s.height, hover: hoverStyle(el) };
    });
    // TWO-ROW masthead: a BRAND row (logo · chip · CTAs) stacked with a LINKS-ONLY nav row → the theme's
    // Bottom / Top Bar carries the menu. Reads the nav row's rule / padding / alignment / gap / fill and
    // the brand row's own height (the at-rest header height is the brand row, not both rows stacked).
    let navRowEl = null;
    header.rows = (() => {
      let kids = [...headerEl.children];
      let depth = 0; while (kids.length === 1 && depth < 3) { kids = [...kids[0].children]; depth++; }
      if (kids.length < 2) return null;
      const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, '');
      const linksOnly = (row) => {
        if (row.querySelector('img, button')) return false;
        let n = 0, lt = '';
        for (const a of row.querySelectorAll('a')) { if (/\b(btn|button|cta)\b/i.test(clsOf(a)) || btnLike(a)) return false; const t = txt(a); if (!t || t.length > 24) continue; n++; lt += ' ' + t; }
        return n >= 2 && norm(txt(row)) === norm(lt);
      };
      const isBrand = (row) => !!(row.querySelector('img, [data-sc-logo-svg]') || [...row.querySelectorAll('*')].some((d) => /(^|\s|-|_)(brand|logo)(\s|-|_|$)/.test(clsOf(d).toLowerCase())));
      let navI = -1, brandI = -1;
      kids.forEach((row, i) => { if (!visible(row)) return; if (navI < 0 && linksOnly(row)) { navI = i; return; } if (brandI < 0 && isBrand(row)) brandI = i; });
      if (navI < 0 || brandI < 0) return null;
      const nav = kids[navI], brand = kids[brandI];
      // STACKED, not side by side: a classic one-row masthead (`container flex justify-between` → logo · links · actions as
      // siblings) also has a links-only child and a brand child — in DOM order that read as two rows and the menu was
      // pushed to a Bottom Bar. Two rows means the nav's box lies wholly below (or above) the brand's box.
      { const nr = nav.getBoundingClientRect(), br = brand.getBoundingClientRect();
        const stacked = nr.top >= br.bottom - 2 || nr.bottom <= br.top + 2;
        if (!stacked) return null; }
      navRowEl = nav;
      const ns = getComputedStyle(nav);
      const out = { nav_pos: navI > brandI ? 'bottom' : 'top', nav_cls: clsOf(nav), align: 'left' };
      const bh = brand.getBoundingClientRect().height; if (bh >= 32) out.brand_height = Math.round(bh);
      const bp = parseFloat(getComputedStyle(brand).paddingLeft); if (bp > 0) out.brand_pad_x = Math.round(bp); // the row's own side inset
      const nh = nav.getBoundingClientRect().height; if (nh >= 16) out.nav_height = Math.round(nh);
      const side = out.nav_pos === 'bottom' ? 'Top' : 'Bottom'; // the rule sits on the edge facing the brand row
      const bw = ns['border' + side + 'Width'], bst = ns['border' + side + 'Style'], bc = ns['border' + side + 'Color'];
      if (parseFloat(bw) > 0 && bst && bst !== 'none' && hasBg(bc)) out.border = { width: Math.max(1, Math.round(parseFloat(bw))), style: bst, color: bc, side: side.toLowerCase() };
      if (/^[0-9.]+px(\s+[0-9.]+px){0,3}$/.test(ns.padding || '')) out.padding = ns.padding;
      const j = ns.justifyContent || ''; out.align = /center/.test(j) ? 'center' : (/end/.test(j) ? 'right' : 'left');
      const gap = parseFloat(ns.columnGap || ns.gap); if (gap > 0) out.gap = Math.round(gap);
      if (hasBg(ns.backgroundColor)) out.bg = ns.backgroundColor;
      // The links' own line-height — the row's height IS padding + this (parity with PHP header_rows link_lh).
      const a1 = nav.querySelector('a'); const lh = a1 ? parseFloat(getComputedStyle(a1).lineHeight) : 0;
      if (lh > 0) out.link_lh = Math.round(lh);
      return out;
    })();
    // Decorative TEXT CHIPS beside the brand (a pill label with a glowing dot): not a link / button / brand /
    // nav item — a plain styled label → a native list_item, hidden where the source's @media hides it.
    header.chips = (() => {
      const out = [];
      const inBrand = (el) => { for (let p = el; p && p !== headerEl; p = p.parentElement) { if (p.hasAttribute('data-sc-logo-svg') || p.querySelector('img') || /(^|\s|-|_)(brand|logo)(\s|-|_|$)/.test(clsOf(p).toLowerCase())) return true; } return false; };
      // The source's own `@media (max-width: N)` rule that hides the element → Hide On (mobile / +tablet).
      const hideOn = (el) => {
        let bp = 0;
        for (const ss of document.styleSheets) {
          let rules; try { rules = ss.cssRules; } catch { continue; }
          for (const r of rules) {
            if (!r.media || !r.cssRules) continue;
            const m = /max-width:\s*([0-9.]+)px/.exec(r.media.mediaText || ''); if (!m) continue;
            for (const rr of r.cssRules) { if (rr.style && rr.style.display === 'none' && rr.selectorText) { try { if (el.matches(rr.selectorText)) bp = Math.max(bp, parseFloat(m[1])); } catch { /* unsupported selector */ } } }
          }
        }
        return bp <= 0 ? [] : (bp <= 767 ? ['hide-xs'] : ['hide-xs', 'hide-sm']);
      };
      for (const el of headerEl.querySelectorAll('*')) {
        if (out.length >= 2) break;
        const tag = el.tagName.toLowerCase();
        if (['a', 'button', 'nav', 'ul', 'li', 'img', 'svg', 'script', 'style', 'input', 'select', 'form'].includes(tag)) continue;
        const wrap = el.parentElement && el.parentElement.closest('a, button, nav, ul, form'); if (wrap && headerEl.contains(wrap)) continue;
        if (navRowEl && navRowEl.contains(el)) continue;
        if (!visible(el)) continue;
        let own = ''; for (const cn of el.childNodes) { if (cn.nodeType === 3) own += cn.nodeValue; } own = own.replace(/\s+/g, ' ').trim();
        if (!own || own.length > 80 || inBrand(el)) continue;
        const s = getComputedStyle(el);
        const pill = parseFloat(s.borderTopLeftRadius) >= 40;
        const padded = parseFloat(s.paddingLeft) > 0 || parseFloat(s.paddingTop) > 0;
        if (!(pill || (hasBg(s.backgroundColor) && padded))) continue;
        const chip = { text: own, cls: clsOf(el), dot: null, hide: hideOn(el),
          cs: pick(s, ['gap', 'padding', 'borderRadius', 'backgroundColor', 'color', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'lineHeight', 'boxShadow', 'borderTopWidth', 'borderTopStyle', 'borderTopColor']) };
        for (const k of el.children) { // a dot / pip: a tiny EMPTY child with its own fill
          if (txt(k)) continue;
          const ks = getComputedStyle(k); const kh = parseFloat(ks.height);
          if (kh > 0 && kh <= 12 && hasBg(ks.backgroundColor)) { chip.dot = { size: Math.max(4, Math.round(kh)), color: ks.backgroundColor, shadow: (ks.boxShadow && ks.boxShadow !== 'none') ? ks.boxShadow : '' }; break; }
        }
        out.push(chip);
      }
      return out;
    })();
  }

  // --- footer (chrome + full content for the "copy the whole thing" path) ---
  const footerEl = document.querySelector('footer') || document.querySelector('[role=contentinfo]');
  let footer = null;
  if (footerEl) {
    const allText = txt(footerEl);
    const footerLinks = [...footerEl.querySelectorAll('a')];
    // Social = icon links (an svg/img/aria-label, usually text-less). The NETWORK is sniffed from the icon
    // class (`lucide-facebook`, `fab fa-instagram`), the aria-label/title, then the href host — so a
    // placeholder `href="#"` rounded-full circle still maps. Mirror of PHP social_network_of().
    const NET = ['facebook', 'instagram', 'twitter', 'x-twitter', 'youtube', 'linkedin', 'github', 'tiktok', 'dribbble', 'twitch', 'pinterest', 'discord', 'telegram', 'whatsapp', 'slack', 'mastodon'];
    const netOf = (a) => {
      // Self-contained className reader — `_clsOf` (below) is in the temporal dead zone here, since netOf
      // is CALLED during extraction before that const initializes. Inlining avoids the TDZ ReferenceError.
      const _cls = (el) => (el && el.className && el.className.toString ? el.className.toString() : '');
      let hay = ' ' + _cls(a).toLowerCase() + ' ' + (a.getAttribute('aria-label') || '').toLowerCase() + ' ' + (a.getAttribute('title') || '').toLowerCase() + ' ';
      a.querySelectorAll('svg,i,span,use').forEach((n) => { hay += ' ' + _cls(n).toLowerCase() + ' '; });
      for (const key of NET) {
        const w = key.replace(/[-]/g, '\\-');
        if (new RegExp('(?:lucide-|fa-|fab-|bi-|icon-|ion-|social-)' + w + '\\b').test(hay) || (key.length >= 4 && new RegExp('\\b' + w + '\\b').test(hay))) {
          return key === 'x-twitter' ? 'twitter' : key;
        }
      }
      return '';
    };
    const social = footerLinks
      .filter((a) => (a.querySelector('svg,img') || a.getAttribute('aria-label')) && (!txt(a) || netOf(a)))
      .map((a) => ({ label: a.getAttribute('aria-label') || '', href: abs(a.getAttribute('href') || ''), net: netOf(a) }))
      .filter((s) => s.net || s.label || /^https?:/i.test(s.href))
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
    // CONTACT column: a heading followed by <li> rows that are each a leading icon (svg) + text (address /
    // phone / email). Captured as structured rows (icon markup + tint + value with line breaks preserved) so
    // the emit reproduces the leading-icon list instead of a flat text blob. Mirror of PHP footer_contact_row.
    const contact = (() => {
      const heads = [...footerEl.querySelectorAll('h2,h3,h4,h5,h6')];
      for (const h of heads) {
        const wrap = h.parentElement; if (!wrap) continue;
        const lis = [...wrap.querySelectorAll('li')];
        if (lis.length < 2) continue;
        const rows = []; let withIcon = 0; let tint = '';
        lis.slice(0, 10).forEach((li) => {
          const sv = li.querySelector('svg');
          let icon = '', color = '';
          if (sv) {
            const mk = sv.outerHTML; if (mk && mk.length < 8000) icon = mk.replace(/\s+/g, ' ').trim();
            color = getComputedStyle(sv).color || '';
            if (!color) { const ch = sv.querySelector('*'); if (ch) color = getComputedStyle(ch).color || ''; }
          }
          const valEl = li.querySelector('span, p, a') || li;
          const clone = valEl.cloneNode(true);
          clone.querySelectorAll('svg').forEach((s) => s.remove());
          let inner = (clone.innerHTML || clone.textContent || '').replace(/<br\s*\/?>/gi, '\n');
          inner = inner.replace(/<[^>]+>/g, '').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
          if (!inner) return;
          if (icon) withIcon++;
          if (color && !tint) tint = color;
          rows.push({ icon, color, text: inner });
        });
        if (rows.length >= 2 && withIcon >= 2 && withIcon >= Math.ceil(rows.length / 2)) {
          rows.forEach((r) => { if (r.icon && !r.color && tint) r.color = tint; });
          return { title: clip(txt(h), 60), rows };
        }
      }
      return null;
    })();
    // NEWSLETTER / signup column: a heading whose column carries an email/text <input> (an email capture)
    // but NO link group and NO contact rows — the 4th "Sprinkles Club"-style column that would otherwise be
    // dropped. Captured as { title, tagline, placeholder, button } so the emit reproduces it with the native
    // newsletter element. Mirror of PHP detect_footer_columns' newsletter branch.
    const newsletter = (() => {
      const heads = [...footerEl.querySelectorAll('h2,h3,h4,h5,h6')];
      const linkHeads = new Set(groups.map((g) => g.title));
      const contactHead = contact ? contact.title : '';
      for (const h of heads) {
        const t = clip(txt(h), 60);
        if (!t || t === contactHead || linkHeads.has(t)) continue;
        const wrap = h.parentElement; if (!wrap) continue;
        if ([...wrap.querySelectorAll('a')].filter((a) => txt(a)).length >= 2) continue;
        const inp = [...wrap.querySelectorAll('input')].find((i) => {
          const it = (i.getAttribute('type') || '').toLowerCase().trim();
          return it === '' || it === 'email' || it === 'text' || it === 'search';
        });
        if (!inp) continue;
        const p = [...wrap.querySelectorAll('p')].map((x) => txt(x)).find((x) => x);
        const b = [...wrap.querySelectorAll('button, a')].map((x) => txt(x)).find((x) => x);
        return { title: t, tagline: clip(p || '', 200), placeholder: clip(inp.getAttribute('placeholder') || '', 80), button: clip(b || 'Subscribe', 40) };
      }
      return null;
    })();
    // Column GAP of the footer's widest multi-child grid/flex band, and the resting link colour.
    // The theme's footer column gap was a fixed 40px while 80% of real footers differ (48px is the
    // most common), so it has to be measured rather than assumed. Hover colour needs a real pointer
    // and is captured separately in capture.mjs.
    const _fGap = (() => {
      let host = null, best = 0;
      for (const el of footerEl.querySelectorAll('*')) {
        const d = getComputedStyle(el).display;
        if (d !== 'grid' && d !== 'flex') continue;
        const kids = [...el.children].filter((k) => k.getBoundingClientRect().width > 0);
        if (kids.length < 2 || kids.length > 8) continue;
        const w = el.getBoundingClientRect().width;
        if (w > best) { best = w; host = el; }
      }
      if (!host) return '';
      const g = getComputedStyle(host).columnGap || getComputedStyle(host).gap || '';
      return /^[0-9.]+px$/.test(g) ? g : '';
    })();
    const _fLink = (() => {
      const a = [...footerEl.querySelectorAll('a')].filter((x) => (x.textContent || '').trim().length > 1 && x.getBoundingClientRect().width > 0);
      return a.length ? getComputedStyle(a[Math.min(1, a.length - 1)]).color : '';
    })();
    // BOXED BODY (PHP: detect_footer_shell / footer_box_values). A single-child chain from <footer> reaching a
    // PANEL: ≥ 2 content rows on an element that paints its own skin (border / fill / gradient / shadow) AND
    // carries padding. Its measures → Footer → Layout → Boxed Body; empty absolute decor children → pseudo rules.
    const _isTransparent = (c) => !c || c === 'transparent' || /rgba?\([^)]*[,\/]\s*0\s*\)/.test(c);
    const _hasContent = (k) => (k.textContent || '').trim() !== '' || k.querySelector('img,svg');
    const _paintsPanel = (el) => {
      const cs = getComputedStyle(el);
      if (!/[1-9]/.test(cs.padding)) return false;
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (parseFloat(cs['border' + side + 'Width']) > 0 && cs['border' + side + 'Style'] !== 'none' && !_isTransparent(cs['border' + side + 'Color'])) return true;
      }
      if (!_isTransparent(cs.backgroundColor)) return true;
      if (/gradient/.test(cs.backgroundImage)) return true;
      if (cs.boxShadow && cs.boxShadow !== 'none') return true;
      return false;
    };
    const _cappedWidth = (el) => { // a width:min(1600px, ...) / max-width from the element's own stylesheet rules
      let best = 0;
      for (const ss of document.styleSheets) {
        let rules; try { rules = ss.cssRules; } catch { continue; }
        for (const r of rules) {
          if (!r.selectorText) continue;
          let ok = false; try { ok = el.matches(r.selectorText); } catch { ok = false; }
          if (!ok) continue;
          for (const v of [r.style.width, r.style.maxWidth]) { const m = /(\d+(?:\.\d+)?)px/.exec(String(v || '')); if (m && /min\(|^\d/.test(String(v)) && parseFloat(m[1]) > best) best = parseFloat(m[1]); }
        }
      }
      return best;
    };
    const _shell = (() => {
      let node = footerEl;
      for (let d = 0; d < 4; d++) {
        const content = [...node.children].filter(_hasContent);
        if (node !== footerEl && content.length >= 2 && _paintsPanel(node)) return node;
        if (content.length !== 1) return null;
        node = content[0];
      }
      return null;
    })();
    const _labelBarOf = (el) => { // PHP band_is_label_bar
      if (!el || el.querySelector('h1,h2,h3,h4,h5,h6,img,svg,form,input,ul')) return null;
      const cs = getComputedStyle(el);
      if (!/^(flex|grid|inline-flex)$/.test(cs.display)) return null;
      const cells = [];
      for (const k of el.children) {
        const t = (k.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (t.replace(/[^a-z0-9 ]/gi, ' ').trim().split(/\s+/).length > 8 || t.length > 60) return null;
        if (parseFloat(getComputedStyle(k).fontSize || cs.fontSize) > 14) return null;
        cells.push(t);
      }
      return cells.length >= 2 ? cells : null;
    };
    const _shellRows = _shell ? [...(_shell).children].filter(_hasContent) : [];
    const _lastRow = _shellRows.length ? _shellRows[_shellRows.length - 1] : null;
    const _mainRowEl = (() => { // PHP footer_main_row_el: the grid / flex row with the most text and ≥ 2 content children
      let best = null, bestT = -1;
      for (const d of (_shell || footerEl).querySelectorAll('div')) {
        const disp = getComputedStyle(d).display;
        if (disp !== 'grid' && disp !== 'flex') continue;
        if ([...d.children].filter(_hasContent).length < 2) continue;
        const t = (d.textContent || '').replace(/\s+/g, ' ').trim().length;
        if (t > bestT) { bestT = t; best = d; }
      }
      return best;
    })();
    const _shellInfo = _shell ? (() => {
      const cs = getComputedStyle(_shell);
      const border = (() => {
        const e = {};
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
          if (parseFloat(cs['border' + side + 'Width']) > 0 && cs['border' + side + 'Style'] !== 'none' && !_isTransparent(cs['border' + side + 'Color'])) e[side.toLowerCase()] = cs['border' + side + 'Width'] + ' ' + cs['border' + side + 'Style'] + ' ' + cs['border' + side + 'Color'];
        }
        return e;
      })();
      const decor = [];
      for (const k of _shell.children) {
        if (_hasContent(k) || k.children.length) continue;
        const kc = getComputedStyle(k);
        if (kc.position !== 'absolute') continue;
        if ((!kc.backgroundImage || kc.backgroundImage === 'none') && _isTransparent(kc.backgroundColor)) continue;
        decor.push(pick(kc, ['top', 'right', 'bottom', 'left', 'height', 'width', 'backgroundImage', 'backgroundColor', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'opacity', 'clipPath', 'borderRadius', 'filter', 'mixBlendMode']));
      }
      const copyIn = !!(_lastRow && (_labelBarOf(_lastRow) || /©|copyright|rights reserved/i.test(_lastRow.textContent || '')));
      const mainRowCs = _mainRowEl ? getComputedStyle(_mainRowEl) : null;
      const lastCs = (copyIn && _lastRow) ? getComputedStyle(_lastRow) : null;
      return {
        padding: cs.padding, margin: cs.margin, cappedWidth: _cappedWidth(_shell) || 0,
        backgroundColor: cs.backgroundColor, backgroundImage: cs.backgroundImage,
        border, radius: cs.borderRadius, boxShadow: cs.boxShadow, decor, copyrightInside: copyIn,
        mainRowPadding: mainRowCs ? mainRowCs.padding : '',
        lastRowMargin: lastCs ? lastCs.margin : '', lastRowPadding: lastCs ? lastCs.padding : '',
      };
    })() : null;
    const _labelBar = (() => { // the footer's last content row when it is a label bar (no © line)
      const scope = _shell || footerEl;
      let rows = [...scope.children].filter(_hasContent);
      if (rows.length < 2) return null;
      const last = rows[rows.length - 1];
      const cells = _labelBarOf(last);
      if (!cells) return null;
      const cs = getComputedStyle(last);
      return { cells, ...pick(cs, ['fontFamily', 'fontSize', 'fontWeight', 'color', 'letterSpacing', 'textTransform', 'lineHeight', 'display', 'justifyContent', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'backgroundColor']) };
    })();
    // The lead lockup's EYEBROW (PHP footer_lead_eyebrow_el): a short small / uppercase leaf right before the
    // footer's first display heading.
    const _leadEyebrow = (() => {
      const h = [...footerEl.querySelectorAll('h1,h2,h3')].find((x) => txt(x).split(/\s+/).length >= 2);
      if (!h) return null;
      let n = h.previousElementSibling;
      if (!n || !/^(div|span|p|small|em|strong)$/i.test(n.tagName) || n.querySelector('img,svg,a')) return null;
      const t = txt(n).replace(/\s+/g, ' ').trim();
      if (!t || t.length > 40 || /[.!?]$/.test(t)) return null;
      const cs = getComputedStyle(n);
      const small = parseFloat(cs.fontSize) <= 13, upper = cs.textTransform === 'uppercase' || (/[a-z]/i.test(t) && t === t.toUpperCase());
      if (!small && !upper) return null;
      return { text: t, ...pick(cs, ['fontFamily', 'fontSize', 'fontWeight', 'color', 'letterSpacing', 'textTransform', 'lineHeight', 'margin']) };
    })();
    footer = {
      computed: pick(getComputedStyle(footerEl), ['backgroundColor', 'color', 'padding', 'backgroundImage']),
      shell: _shellInfo,
      mainRow: _mainRowEl ? pick(getComputedStyle(_mainRowEl), ['display', 'alignItems', 'gridTemplateColumns']) : null,
      labelBar: _labelBar,
      leadEyebrow: _leadEyebrow,
      colGap: _fGap,
      linkColor: _fLink,
      brand: brandEl ? clip(txt(brandEl), 60) : '',
      groups: groups.slice(0, 6),
      contact,
      newsletter,
      social,
      copyright: ci >= 0 ? clip(allText.slice(ci), 200) : '',
      // BRAND-ONLY footer (PHP: the brand-only branch): the disclaimer paragraph beside the brand, and whether the two sit
      // side by side in one flex row (→ two columns: brand | paragraph) rather than stacked.
      tagline: (() => { const p0 = [...footerEl.querySelectorAll('p')].find((x) => txt(x).length >= 20 && !/©|copyright|rights reserved/i.test(txt(x))); return p0 ? { text: clip(txt(p0), 400), computed: pick(getComputedStyle(p0), ['fontSize', 'lineHeight', 'color', 'textAlign', 'maxWidth']), html: p0.innerHTML.replace(/<(?!br\s*\/?>)[^>]+>/g, '').trim() } : null; })(),
      brandRow: (() => { try { const p0 = [...footerEl.querySelectorAll('p')].find((x) => txt(x).length >= 20 && !/©|copyright|rights reserved/i.test(txt(x))); if (!p0) return false; const row = p0.parentElement; if (!row || row === footerEl && false) return false; const kids = [...row.children].filter((k) => (k.textContent || '').trim() || k.querySelector('img,svg')); if (kids.length < 2) return false; const cs = getComputedStyle(row); return (cs.display === 'flex' && !/column/.test(cs.flexDirection)) || cs.display === 'grid'; } catch { return false; } })(),
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
  let sectionEls = allSections
    .filter((s) => !allSections.some((o) => o !== s && o.contains(s)))
    .slice(0, 40);
  // SECTION-LESS content container (PHP: walk_section_roots → segment_bands). A <main> with NO <section> tags whose
  // bands are plain divs (a full-viewport hero holding a feature grid as a sibling div) converted to ZERO sections on
  // this path. Segment it: the direct content children (skipping absolute / fixed decor layers and empty spacers),
  // descending one lone wrapper; ≥ 2 → each is a band; 1 → that band; none → the container itself.
  if (!sectionEls.length && main !== document.body) {
    const isDecor = (el) => { const cs = getComputedStyle(el); return (cs.position === 'absolute' || cs.position === 'fixed') && !el.querySelector('h1,h2,h3') && (el.textContent || '').trim().length < 40; };
    const isBand = (el) => /^(div|section|article|main|header|figure|ul|ol)$/i.test(el.tagName) && !isDecor(el) && ((el.textContent || '').trim().length >= 20 || !!el.querySelector('img,video,svg,iconify-icon,h1,h2,h3'));
    const segment = (el, depth) => {
      if (depth > 2) return [];
      const content = [...el.children].filter(isBand);
      if (content.length >= 2) return content;
      if (content.length === 1) { const inner = segment(content[0], depth + 1); return inner.length >= 2 ? inner : []; }
      return [];
    };
    const bands = segment(main, 0);
    sectionEls = bands.length ? bands.slice(0, 40) : [main];
    if (bands.length >= 2) {
      // The container's own vertical padding (a pt-[25vh] on the <main>) belongs to the bands it wraps: top → the first,
      // bottom → the last (PHP: band_inherit_padding). Recorded on the element; the section computed read adds it.
      const mcs = getComputedStyle(main);
      bands[0]._scPadTopAdd = parseFloat(mcs.paddingTop) || 0;
      bands[bands.length - 1]._scPadBottomAdd = parseFloat(mcs.paddingBottom) || 0;
      bands.forEach((b) => { b._scBandOf = main.tagName.toLowerCase(); });
    }
  }
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
      pseudoScrim: findPseudoScrim(sec), // `::before/::after` tint over a media band (no DOM element carries it)
      bgEffects: findBgEffects(sec),
      bgFxCandidate: findBgFxCandidate(sec), // AI-tier evidence (unnamed animated backdrop); applied only where bgEffects is empty
      divider: findDivider(sec),
      computed: (() => {
        const c = pick(getComputedStyle(sec), ['backgroundColor', 'backgroundImage', 'padding', 'textAlign', 'color']);
        // a segmented band carries its container's top / bottom padding (see the section-less segmentation above)
        if (sec._scPadTopAdd || sec._scPadBottomAdd) {
          const cs = getComputedStyle(sec); const px = (v) => parseFloat(v) || 0;
          c.padding = Math.round(px(cs.paddingTop) + (sec._scPadTopAdd || 0)) + 'px ' + Math.round(px(cs.paddingRight)) + 'px ' + Math.round(px(cs.paddingBottom) + (sec._scPadBottomAdd || 0)) + 'px ' + Math.round(px(cs.paddingLeft)) + 'px';
        }
        return c;
      })(),
      bandOf: sec._scBandOf || '', // a band cut out of a section-less container (PHP: data-sc-band-of) — content-tall, never a forced 100vh
      computedSm: (() => { const m = smOf(sec); return (m.padding || m.margin) ? { padding: m.padding || '', margin: m.margin || '' } : null; })(), // the phone-pass padding / margin when they differ (PHP: sectionCsSm)
      computedXl: (() => { const m = xlOf(sec); return (m.padding || m.margin) ? { padding: m.padding || '', margin: m.margin || '' } : null; })(), // the wide-pass padding / margin when it differs (PHP: sectionCsXl)
      computedMd: (() => { const m = mdOf(sec); return (m.padding || m.margin) ? { padding: m.padding || '', margin: m.margin || '' } : null; })(), // the tablet-pass padding / margin (PHP: sectionCsMd)
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
  const _csrgb = (c) => { const cm = String(c || '').trim().match(/^color\(\s*(srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020)\s+([0-9.]+%?)\s+([0-9.]+%?)\s+([0-9.]+%?)(?:\s*\/\s*([0-9.]+%?))?\s*\)$/i); if (!cm) return null; const ch = (v) => { const f = /%$/.test(v) ? parseFloat(v) / 100 : parseFloat(v); return Math.max(0, Math.min(1, f)); }; let r = ch(cm[2]), g = ch(cm[3]), b = ch(cm[4]); if (cm[1] === 'srgb-linear') { const gam = (x) => x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; r = gam(r); g = gam(g); b = gam(b); } const a = cm[5] == null ? 1 : (/%$/.test(cm[5]) ? parseFloat(cm[5]) / 100 : parseFloat(cm[5])); return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a]; };
  const toRGB = (c) => {
    { const cs = _csrgb(c); if (cs) return cs; } // color(srgb …) from color-mix() / wide-gamut sources (PHP: color_to_hex)
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
    // An INLINE element's own text treatment (a vertical writing-mode label, a tracked uppercase span, a smaller / bolder
    // run) — the stamped props that DIFFER from its parent's — re-expressed as inline style (kses-safe props only), so a
    // styled span inside prose keeps its look. PHP twin: scrub() inline bits.
    clone.querySelectorAll('span,em,strong,b,i,small,mark,sub,sup').forEach((n) => {
      const own = n.getAttribute('data-sc-cs') || '', par = n.parentElement && n.parentElement.getAttribute('data-sc-cs') || '';
      if (!own || !par) return;
      const get = (cs, pr) => { const m = cs.match(new RegExp('(?:^|;)\\s*' + pr + ':\\s*([^;]+)')); return m ? m[1].trim() : ''; };
      const bits = [];
      for (const pr of ['writing-mode', 'letter-spacing', 'text-transform', 'font-size', 'font-weight', 'text-decoration-line']) {
        const v = get(own, pr); if (!v || v === get(par, pr) || ['none', 'normal', 'horizontal-tb', '0px'].includes(v.toLowerCase()) || !/^[a-z0-9.%\s-]+$/i.test(v)) continue;
        bits.push((pr === 'text-decoration-line' ? 'text-decoration' : pr) + ':' + v); if (pr === 'writing-mode') bits.push('display:inline-block');
      }
      if (bits.length) n.setAttribute('style', ((n.getAttribute('style') || '').replace(/;?\s*$/, '') + (n.getAttribute('style') ? ';' : '') + bits.join(';')));
    });
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
  // A CALL-TO-ACTION band → { title, message(html), button_*, button skin } or null. Parity PHP
  // is_cta_band + cta_build: a CENTERED div/section with exactly ONE non-h1 heading, optional subtext,
  // and exactly ONE button, and NO other media/list/table/form/column content (so a hero or feature grid
  // never qualifies; a 2-button CTA stays assembled so nothing is dropped).
  const ctaBandOf = (elx) => {
    if (!elx || !elx.tagName) return null;
    if (elx.tagName !== 'DIV' && elx.tagName !== 'SECTION') return null;
    const cs = getComputedStyle(elx);
    const centered = /(?:^|\s)text-center\b/.test(elx.className || '') || cs.textAlign === 'center';
    if (!centered) return null;
    if (elx.querySelector('h1')) return null;
    const heads = elx.querySelectorAll('h2,h3,h4,h5,h6');
    if (heads.length !== 1) return null;
    if (elx.querySelector('img,picture,video,iframe,ul,ol,table,form,input,select,textarea')) return null;
    const btns = [...elx.querySelectorAll('a,button')].filter((b) => looksButton(b));
    if (btns.length !== 1) return null;
    for (const sv of elx.querySelectorAll('svg')) { if (!btns[0].contains(sv)) return null; }
    // A genuine multi-column / card-grid child means it isn't a simple CTA.
    for (const k of [...elx.children]) { if (isRow(k)) return null; }
    const h = heads[0];
    const title = (h.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title) return null;
    const btn = btns[0];
    const bcs = getComputedStyle(btn);
    const parts = [...elx.querySelectorAll('p')].filter((p) => txt(p)).map((p) => rawHtmlOf(p, true));
    return {
      title,
      message: parts.join('\n'),
      button_label: (btn.textContent || '').replace(/\s+/g, ' ').trim(),
      button_link: abs(btn.getAttribute('href') || '#') || '#',
      button_target: (btn.getAttribute('target') === '_blank') ? '_blank' : '_self',
      buttonBg: bcs.backgroundColor, buttonColor: bcs.color, buttonRadius: bcs.borderRadius, buttonPad: bcs.padding,
    };
  };

  // A PAINTED EMPTY PANEL — no text / media, painted by the source itself (gradient layers or a colour), a real box
  // (>= 80px tall). It is content (a band's "visual" half), not a decorative wrapper. PHP: is_painted_panel.
  const panelPaintOf = (el) => {
    const s = getComputedStyle(el);
    let bgi = String(s.backgroundImage || ''); if (bgi === 'none' || !/gradient\(/i.test(bgi) || /url\(/i.test(bgi) || bgi.length > 1500) bgi = '';
    const bg = hasBg(s.backgroundColor) ? s.backgroundColor : '';
    return { bgi, bg };
  };
  const isPaintedPanel = (el) => {
    if (!el || !el.tagName || txt(el)) return false;
    if (el.querySelector('img, svg, video, iframe, picture, canvas, a, button, input')) return false;
    const p = panelPaintOf(el); if (!p.bgi && !p.bg) return false;
    return el.getBoundingClientRect().height >= 80;
  };
  // An element's own CARD skin (rounded + a fill / gradient / border), the shape the box-preset census clusters.
  // PHP: read_card_skin. null when it isn't a card.
  // A ONE-SIDED hairline (a footer row's border-top) with no radius / fill — a Box Preset whose border sits on that side
  // only ('sides' → border_sides). null otherwise. PHP: read_edge_skin.
  const edgeSkinOf = (el) => {
    const s = getComputedStyle(el);
    const real = (w, st, c) => (parseFloat(w) || 0) > 0 && st !== 'none' && hasBg(c);
    const top = real(s.borderTopWidth, s.borderTopStyle, s.borderTopColor), bot = real(s.borderBottomWidth, s.borderBottomStyle, s.borderBottomColor);
    if (top === bot) return null;
    if ((parseFloat(s.borderTopLeftRadius) || 0) > 0) return null;
    const side = top ? 'Top' : 'Bottom';
    return { bg: '', fill: '', gradient: '', radius: '', borderWidth: s['border' + side + 'Width'], borderStyle: s['border' + side + 'Style'], borderColor: s['border' + side + 'Color'], shadow: '', backdrop: '', padding: '', clip: false, sides: side.toLowerCase() };
  };
  const cardSkinOf = (el) => {
    const s = getComputedStyle(el);
    const grad = /linear-gradient\(/i.test(s.backgroundImage || '') && !/url\(/i.test(s.backgroundImage) ? s.backgroundImage : '';
    const radius = (parseFloat(s.borderTopLeftRadius) || 0) > 0 ? s.borderTopLeftRadius : '';
    const bw = (parseFloat(s.borderTopWidth) || 0) > 0 && s.borderTopStyle !== 'none' ? s.borderTopWidth : '';
    // a SQUARE card (radius 0) with a fill / border AND a real inset is a card too (a sharp-cornered console design); PHP: read_card_skin
    { const padded = (parseFloat(s.paddingTop) || 0) >= 8, fullBorder = !!bw && (parseFloat(s.borderBottomWidth) || 0) > 0, shadow = !!(s.boxShadow && s.boxShadow !== 'none');
      if (!(hasBg(s.backgroundColor) || grad || bw) || (!radius && !(fullBorder || shadow || (padded && (hasBg(s.backgroundColor) || grad))))) return null; } // square: a padded fill, a full border, or a shadow (PHP read_card_skin)
    return { bg: hasBg(s.backgroundColor) ? s.backgroundColor : '', fill: hasBg(s.backgroundColor) ? s.backgroundColor : '', gradient: grad, radius, borderWidth: bw, borderStyle: bw ? s.borderTopStyle : '', borderColor: bw && hasBg(s.borderTopColor) ? s.borderTopColor : '', shadow: (s.boxShadow && s.boxShadow !== 'none') ? s.boxShadow : '', backdrop: (s.backdropFilter && s.backdropFilter !== 'none') ? s.backdropFilter : '', padding: (parseFloat(s.paddingTop) || 0) > 0 ? s.padding : '', clip: /^(hidden|clip)$/.test(s.overflow || ''), hov: el.getAttribute('data-sc-hover') || '', kf: el.getAttribute('data-sc-keyframes') || '', pseudoOwned: el.hasAttribute('data-sc-decor-pseudo') }; // + EVERY captured state (PHP: read_card_skin hov / kf)
  };
  // A SINGLE-TRACK STACK: a grid with exactly one computed track (or a flex column) spacing >= 2 substantial
  // children with a gap → one stack block (the gap + margin survive; each child converts alone). PHP: stack.
  // EVERY decorative pseudo-layer on a box (a ring's inner hairline ::before + its blurred bloom ::after): non-covering,
  // absolute, text-free, and PAINTED (gradient / colour) or BORDERED (a border / box-shadow with no paint). Geometry as
  // % of the box so it scales. PHP twin: parse_decor_pseudos (the capture.mjs '||'-joined stamp).

  // ---- ANIMATED / SWEEP pseudo-layer helpers (shared text: capture.mjs ↔ capture-extract.mjs; PHP: parse_decor_pseudo 'sweep') ----
  // The DECLARED stylesheet rule of `el::pe` (last matching rule wins; @media that apply are entered). The computed style of an
  // ANIMATED pseudo is one mid-animation frame (a transform matrix), so a sweep layer must be read from what the author
  // wrote: its inset / transform / animation shorthand / blend mode, plus the @keyframes it names.
  const declaredPseudoRule = (el, pe) => {
    const suffix = new RegExp('::?' + pe.slice(2) + '\\s*$', 'i');
    let hit = null;
    const pick = (st) => {
      const o = {};
      const get = (p) => { const v = st.getPropertyValue(p); return v ? String(v).trim() : ''; };
      for (const p of ['inset', 'top', 'right', 'bottom', 'left', 'width', 'height', 'transform', 'mix-blend-mode', 'opacity', 'filter', 'border-radius']) { const v = get(p); if (v) o[p] = v; }
      const bg = get('background-image') || get('background'); if (bg && bg !== 'none') o.background = bg;
      // Rebuild the shorthand NAME-FIRST from the longhands (the browser serialises the shorthand with the name LAST:
      // '8s ease-in-out 0s infinite normal none running sheen'); drop the defaults so it reads like the author's rule.
      const anName = get('animation-name');
      const an = (anName && anName !== 'none') ? [anName, get('animation-duration') || '1s', get('animation-timing-function'), get('animation-delay'), get('animation-iteration-count'), get('animation-direction'), get('animation-fill-mode')].filter((x, i) => x && (i < 2 || (x !== 'normal' && x !== 'none' && x !== '0s' && x !== 'ease' && x !== '1'))).join(' ') : '';
      if (an) o.animation = an;
      return o;
    };
    const walk = (rules) => { for (const r of rules) { try {
      if (r.media && r.cssRules) { if (window.matchMedia(r.media.mediaText).matches) walk(r.cssRules); continue; }
      if (!r.selectorText || !r.style) { if (r.cssRules && r.type !== 7) walk(r.cssRules); continue; }
      for (const sel of r.selectorText.split(',')) { const s = sel.trim(); if (!suffix.test(s)) continue; const base = s.replace(suffix, '').trim(); if (!base) continue; try { if (el.matches(base)) hit = Object.assign(hit || {}, pick(r.style)); } catch { /* unsupported selector */ } }
    } catch { /* cross-origin / bad rule */ } } };
    for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch { continue; } walk(rules); }
    return hit;
  };
  // The @keyframes block a declared animation names (last definition wins), as its cssText — '' when none.
  const keyframesFor = (name) => {
    let text = '';
    const walk = (rules) => { for (const r of rules) { try {
      if (r.type === 7 && r.name === name) { text = r.cssText; continue; }
      if (r.cssRules && (!r.media || window.matchMedia(r.media.mediaText).matches)) walk(r.cssRules);
    } catch { /* skip */ } } };
    for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch { continue; } walk(rules); }
    return text;
  };
  // A SWEEP layer: a painted pseudo that MOVES (a declared transform and/or animation — the `.silk::after` sheen sweeping a
  // light band across a card). It is typically LARGER than its box (inset:-120%), so the "covering = scrim" gate must
  // not swallow it. Returns the layer (declared geometry / paint / motion + the host's overflow clip) or null.
  const sweepLayerOf = (el, pe, ps) => {
    const d = declaredPseudoRule(el, pe);
    if (!d || !(d.animation || d.transform)) return null;
    const bg = d.background || ((ps && ps.backgroundImage && ps.backgroundImage !== 'none') ? ps.backgroundImage : '');
    if (!bg || !/gradient\(/i.test(bg) || /url\(/i.test(bg) || bg.length > 1200) return null;
    const out = { pe: pe.slice(2), sweep: true, background: bg };
    if (d.inset) out.inset = d.inset; else for (const k of ['top', 'right', 'bottom', 'left']) if (d[k]) out[k] = d[k];
    if (d.width) out.width = d.width; if (d.height) out.height = d.height;
    if (d.transform && d.transform !== 'none') out.transform = d.transform;
    if (d.animation) { out.animation = d.animation; const nm = d.animation.split(/\s+/)[0]; const kf = nm ? keyframesFor(nm) : ''; if (kf) out.keyframes = kf; }
    if (d['mix-blend-mode'] && d['mix-blend-mode'] !== 'normal') out.blend = d['mix-blend-mode'];
    if (d.opacity && parseFloat(d.opacity) < 1) out.opacity = String(parseFloat(d.opacity));
    if (d.filter && d.filter !== 'none') out.filter = d.filter;
    if (d['border-radius'] && d['border-radius'] !== '0px' && d['border-radius'] !== '0') out.radius = d['border-radius'];
    try { const ov = getComputedStyle(el).overflow; if (/hidden|clip/.test(ov)) out.clip = true; } catch { /* ignore */ }
    return out;
  };
  // ---- THE LONG TAIL (parity with PHP box_extra_css / img_extra_css / text long tail / cell_geometry) ----
  const SAFE_V = /^[a-z0-9()%.,\s#\/+-]+$/i;
  const nonDef = (v, defs) => v && !defs.includes(String(v).trim().toLowerCase());
  // A box's long-tail visual props (opacity / filter / clip-path / mask / blend / outline / side borders / border-image /
  // background geometry / individual transforms / aspect-ratio / min-width / sticky) as `prop:value;…`. PHP: box_extra_css.
  const boxExtraOf = (el) => {
    let cs; try { cs = getComputedStyle(el); } catch { return ''; }
    const d = [];
    const g = (k) => String(cs.getPropertyValue(k) || '').trim();
    if (parseFloat(g('opacity')) < 1) d.push('opacity:' + parseFloat(g('opacity')));
    for (const pr of ['filter', 'clip-path', 'mix-blend-mode', 'translate', 'rotate', 'scale', 'aspect-ratio', 'min-width']) { const v = g(pr); if (nonDef(v, ['none', 'normal', 'auto', '0px']) && SAFE_V.test(v)) d.push(pr + ':' + v); }
    const mk = g('mask-image') || g('-webkit-mask-image'); if (nonDef(mk, ['none']) && !/url\(/i.test(mk) && SAFE_V.test(mk)) { d.push('-webkit-mask-image:' + mk); d.push('mask-image:' + mk); }
    if (nonDef(g('outline-style'), ['none']) && nonDef(g('outline-width'), ['0px']) && SAFE_V.test(g('outline-width') + g('outline-color'))) { d.push('outline:' + g('outline-width') + ' ' + g('outline-style') + (g('outline-color') ? ' ' + g('outline-color') : '')); if (/^-?[0-9.]+px$/.test(g('outline-offset')) && g('outline-offset') !== '0px') d.push('outline-offset:' + g('outline-offset')); }
    const tw = g('border-top-width');
    for (const side of ['left', 'right']) { const w = g('border-' + side + '-width'), st = g('border-' + side + '-style'), c = g('border-' + side + '-color'); if (w && w !== '0px' && w !== tw && nonDef(st, ['none']) && SAFE_V.test(w + st + c)) d.push('border-' + side + ':' + w + ' ' + st + (c ? ' ' + c : '')); }
    // an ACCENT edge (`border-2 border-t-[accent]`): the sides whose colour differs from the top's carry their own (PHP box_extra_css)
    { const tc = g('border-top-color'); if (tw && tw !== '0px' && tc) { for (const side of ['right', 'bottom', 'left']) { const w = g('border-' + side + '-width'), c = g('border-' + side + '-color'); if (w && w !== '0px' && w === tw && c && c.replace(/\s+/g, '').toLowerCase() !== tc.replace(/\s+/g, '').toLowerCase() && SAFE_V.test(c)) d.push('border-' + side + '-color:' + c + ' !important'); } } }
    const bi = g('border-image-source'); if (nonDef(bi, ['none']) && !/url\(/i.test(bi) && SAFE_V.test(bi)) { const bs = g('border-image-slice'); d.push('border-image:' + bi + ' ' + (/^[0-9.%\s]+(?:fill)?$/.test(bs) ? bs : '1')); }
    if (nonDef(g('background-image'), ['none'])) { for (const [pr, defs] of [['background-size', ['auto', 'auto auto']], ['background-position', ['0% 0%', '0px 0px']], ['background-repeat', ['repeat']]]) { const v = g(pr); if (nonDef(v, defs) && SAFE_V.test(v)) d.push(pr + ':' + v); } }
    { const tf = g('transform'); if (nonDef(tf, ['none']) && SAFE_V.test(tf)) d.push('transform:' + tf); } // a static rotate / skew on the box (PHP: hi-fi base transform)
    if (g('position') === 'sticky') { d.push('position:sticky'); if (/^-?[0-9.]+px$/.test(g('top'))) d.push('top:' + g('top')); d.push('z-index:2'); }
    return d.join(';');
  };
  // An <img>'s own filter / object-position / aspect-ratio. PHP: img_extra_css.
  const imgExtraOf = (img) => {
    let cs; try { cs = getComputedStyle(img); } catch { return ''; }
    const d = []; const g = (k) => String(cs.getPropertyValue(k) || '').trim();
    if (nonDef(g('filter'), ['none']) && SAFE_V.test(g('filter'))) d.push('filter:' + g('filter'));
    if (nonDef(g('object-position'), ['50% 50%', 'center', 'center center']) && g('object-fit') !== 'fill' && SAFE_V.test(g('object-position'))) d.push('object-position:' + g('object-position'));
    if (nonDef(g('aspect-ratio'), ['auto']) && /^[0-9.]+(?:\s*\/\s*[0-9.]+)?$/.test(g('aspect-ratio'))) d.push('aspect-ratio:' + g('aspect-ratio'));
    // The image's OWN corner radius (a `rounded-full` avatar inside a card) and its OWN small box (both sides <= 200px: an
    // avatar / thumb sized by the source, not by the column) → the card image keeps its size + shape. PHP: img_extra_css.
    if (nonDef(g('border-radius'), ['0px']) && /^[0-9.]+(?:px|%)(?:\s+[0-9.]+(?:px|%)){0,3}$/.test(g('border-radius'))) d.push('border-radius:' + g('border-radius'));
    try { const r = img.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.width <= 200 && r.height <= 200) d.push('width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) + 'px;flex:0 0 auto'); } catch { /* detached */ }
    return d.join(';');
  };
  // A text element's long tail (italic / shadow / decoration metrics / clamp / columns / writing-mode / wrap / indent /
  // hyphens / numeric variants / features / white-space / text-stroke / gradient text) with the same fix-ups the PHP
  // block_rule_fixups applies (clamp companions; background-image only as gradient text). PHP: text_long_tail_props.
  const textLongTailOf = (el) => {
    let cs; try { cs = getComputedStyle(el); } catch { return ''; }
    const g = (k) => String(cs.getPropertyValue(k) || '').trim(); const d = [];
    const put = (pr, v) => { if (v && /^[a-z0-9()%.,"'\s#\/-]+$/i.test(v)) d.push(pr + ':' + v); };
    if (nonDef(g('font-style'), ['normal'])) put('font-style', g('font-style'));
    if (nonDef(g('text-shadow'), ['none'])) put('text-shadow', g('text-shadow'));
    if (nonDef(g('text-decoration-thickness'), ['auto', 'from-font'])) put('text-decoration-thickness', g('text-decoration-thickness'));
    if (nonDef(g('text-underline-offset'), ['auto'])) put('text-underline-offset', g('text-underline-offset'));
    if ((d.some((x) => /^text-(decoration-thickness|underline-offset)/.test(x))) && g('text-decoration-color') && g('text-decoration-color') !== g('color')) put('text-decoration-color', g('text-decoration-color'));
    if (nonDef(g('-webkit-line-clamp'), ['none'])) { put('-webkit-line-clamp', g('-webkit-line-clamp')); d.push('display:-webkit-box', '-webkit-box-orient:vertical', 'overflow:hidden'); }
    if (nonDef(g('column-count'), ['auto'])) { put('column-count', g('column-count')); if (g('column-gap') && g('column-gap') !== 'normal') put('column-gap', g('column-gap')); }
    if (nonDef(g('writing-mode'), ['horizontal-tb'])) put('writing-mode', g('writing-mode'));
    if (nonDef(g('text-wrap'), ['wrap', ''])) put('text-wrap', g('text-wrap'));
    if (nonDef(g('text-indent'), ['0px', '0'])) put('text-indent', g('text-indent'));
    if (nonDef(g('hyphens'), ['manual'])) put('hyphens', g('hyphens'));
    if (nonDef(g('font-variant-numeric'), ['normal'])) put('font-variant-numeric', g('font-variant-numeric'));
    if (nonDef(g('font-feature-settings'), ['normal'])) put('font-feature-settings', g('font-feature-settings'));
    if (nonDef(g('white-space'), ['normal'])) put('white-space', g('white-space'));
    // Tracking / case / a truncate: a card's uppercase eyebrow-style description (`text-[13px] tracking-[0.2em] uppercase`) or a
    // single-line `truncate` — core props a prose profile carries but a card's .icon-box__content did not. PHP: card text long tail.
    if (nonDef(g('letter-spacing'), ['normal', '0px'])) put('letter-spacing', g('letter-spacing'));
    if (nonDef(g('text-transform'), ['none'])) put('text-transform', g('text-transform'));
    if (g('text-overflow') === 'ellipsis' && g('overflow') === 'hidden') d.push('text-overflow:ellipsis', 'overflow:hidden');
    if (nonDef(g('-webkit-text-stroke-width'), ['0px', '0'])) { put('-webkit-text-stroke-width', g('-webkit-text-stroke-width')); put('-webkit-text-stroke-color', g('-webkit-text-stroke-color')); }
    const clip = g('-webkit-background-clip') || g('background-clip');
    if (clip === 'text' && /gradient\(/i.test(g('background-image')) && !/url\(/i.test(g('background-image'))) { put('background-image', g('background-image')); d.push('background-clip:text', '-webkit-background-clip:text', '-webkit-text-fill-color:transparent'); }
    return d.join(';');
  };
  // The card's hover skin from the capture's data-sc-hover stamp (`hover-self{…}`; capture >= 1.10.95 stamps blocks, not only
  // buttons). PHP: read_card_skin's data-sc-hover fallback.
  // The :hover declarations the stylesheets target this element with (extraction runs before capture.mjs stamps
  // data-sc-hover, so the JS engine reads the rules itself). Same shape as the stamp's body.
  const hoverDeclsOf = (el) => {
    const out = [];
    const KEEP = ['transform', 'background-color', 'background-image', 'box-shadow', 'border-color', 'opacity', 'filter', 'color', 'text-decoration', 'text-decoration-line'];
    try {
      for (const ss of document.styleSheets) {
        let rules; try { rules = ss.cssRules; } catch { continue; }
        const walk = (list) => { for (const r of list) { try {
          if (r.media && r.cssRules) { if (window.matchMedia(r.media.mediaText).matches) walk(r.cssRules); continue; }
          if (!r.selectorText || !r.style || !/:hover\b/i.test(r.selectorText)) continue;
          for (let part of r.selectorText.split(',')) { part = part.trim(); if (!/:hover\b/i.test(part) || /::?(before|after)\b/i.test(part)) continue; const base = part.replace(/::?(hover|focus-visible|focus|active)\b(\([^)]*\))?/gi, '').trim(); if (!base) continue; try { if (el.matches(base)) { for (const k of KEEP) { const v = r.style.getPropertyValue(k); if (v) out.push(k + ':' + v); } } } catch { /* unsupported selector */ } }
        } catch { /* skip */ } } };
        walk(rules);
      }
    } catch { /* best-effort */ }
    return out.join(';');
  };
  // A child's HOVER declarations (its own :hover rule or a GROUP hover — the rule's :hover on an ancestor: hoverDeclsOf's
  // matches() already resolves `.group:hover .child` against the child) → 'prop:value;…' of colour / decoration / opacity /
  // transform. PHP: child_hover_decls (data-sc-hover-group stamp).
  const hoverGroupOf = (el) => {
    let raw = ''; try { raw = el.getAttribute('data-sc-hover-group') || ''; } catch { raw = ''; }
    if (!raw) { const st = (el.getAttribute && el.getAttribute('data-sc-hover')) || ''; const m = st.match(/hover-self\{([^}]*)\}/); if (m) raw = m[1]; }
    if (!raw) raw = hoverDeclsOf(el);
    if (!raw) return '';
    const out = [];
    for (const d of raw.split(';')) { const i = d.indexOf(':'); if (i < 0) continue; let k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim().replace(/\s*\/\s*var\([^)]*\)/, ''); if (!['color', 'text-decoration', 'text-decoration-line', 'opacity', 'transform', 'letter-spacing'].includes(k) || !v || !/^[a-z0-9()%.,\s#\/-]+$/i.test(v)) continue; if (k === 'text-decoration') k = 'text-decoration-line'; out.push(k + ':' + v); }
    return out.join(';');
  };
  const boxHoverOf = (el) => {
    const raw = el.getAttribute && el.getAttribute('data-sc-hover') || '';
    let body = (raw.match(/\{([^}]*)\}/g) || []).map((x) => x.slice(1, -1)).join(';');
    if (!body) body = hoverDeclsOf(el);
    if (!body) return null;
    const hv = {}; const m = (re) => { const r = body.match(re); return r ? r[1].trim() : ''; };
    const bg = m(/(?:^|;)\s*background(?:-color)?:\s*([^;]+)/i); if (bg && !/transparent|initial|inherit|rgba?\([^)]*,\s*0\s*\)/i.test(bg)) hv.fill = bg;
    const bd = m(/(?:^|;)\s*border-color:\s*([^;]+)/i); if (bd) hv.bdcol = bd;
    const hc = m(/(?:^|;)\s*color:\s*([^;]+)/i); if (hc && !/transparent|initial|inherit/i.test(hc)) hv.color = hc.replace(/\s*\/\s*var\([^)]*\)/, ''); // the card's hover INK (PHP: read_card_skin hover color)
    const sh = m(/(?:^|;)\s*box-shadow:\s*([^;]+)/i); if (sh && sh.toLowerCase() !== 'none' && /[1-9]/.test(sh)) hv.shadow = sh;
    const tf = m(/transform:\s*([^;]*)/i); if (tf) { if (/translate(?:y|3d)?\([^)]*-[0-9.]/i.test(tf)) hv.lift = true; const sc = tf.match(/scale\(\s*([0-9.]+)/i); if (sc) hv.scale = parseFloat(sc[1]); }
    return Object.keys(hv).length ? hv : null;
  };
  // A cell's OWN card skin (the element itself is a rounded box with a fill / gradient / border) — the same record
  // cardOf builds for icon cards, so a plain heading+text card keeps its box too. PHP: read_card_skin on the cell.
  const boxSkinOf = (el) => {
    let cs; try { cs = getComputedStyle(el); } catch { return null; }
    const okc = (v) => v && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent';
    const grad = /gradient\(/i.test(cs.backgroundImage || '') && !/url\(/i.test(cs.backgroundImage) ? cs.backgroundImage : '';
    const radius = (parseFloat(cs.borderTopLeftRadius) || 0) > 0 ? cs.borderTopLeftRadius : '';
    const bw = (parseFloat(cs.borderTopWidth) || 0) > 0 && cs.borderTopStyle !== 'none' && okc(cs.borderTopColor) ? cs.borderTopWidth : '';
    { const padded = (parseFloat(cs.paddingTop) || 0) >= 8, fullBorder = !!bw && (parseFloat(cs.borderBottomWidth) || 0) > 0, shadow = !!(cs.boxShadow && cs.boxShadow !== 'none');
      if (!(okc(cs.backgroundColor) || grad || bw) || (!radius && !(fullBorder || shadow || (padded && (okc(cs.backgroundColor) || grad))))) return null; } // square: a padded fill, a full border, or a shadow (PHP parity)
    const pad = /^[0-9.]+px(?:\s+[0-9.]+px){0,3}$/.test(String(cs.padding || '').trim()) ? String(cs.padding).trim() : ((parseFloat(cs.paddingTop) || 0) > 0 ? cs.paddingTop : '');
    return {
      bg: okc(cs.backgroundColor) ? cs.backgroundColor : '', fill: okc(cs.backgroundColor) ? cs.backgroundColor : '', gradient: grad,
      radius, borderWidth: bw, borderStyle: bw ? cs.borderTopStyle : '', borderColor: bw ? cs.borderTopColor : '',
      shadow: (cs.boxShadow && cs.boxShadow !== 'none') ? cs.boxShadow : '',
      backdrop: (cs.backdropFilter && cs.backdropFilter !== 'none') ? cs.backdropFilter : ((cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none') ? cs.webkitBackdropFilter : ''),
      padding: pad, clip: /hidden|clip/.test(cs.overflow || ''), extra: boxExtraOf(el), hover: boxHoverOf(el),
      hoverLift: /hover:-?translate-y-/.test(String(el.className || '')),
    };
  };
  // PHONE PASS: when the element's measured 390px padding differs (data-sc-cs-sm), the pad record's BASE tier becomes the
  // phone value and desktop rides `lg`. PHP: el_padding's phone tier. Returns the record unchanged when no phone diff.
  const padWithPhone = (el, pad) => {
    const sides4 = (sp) => { const q = sp.split(/\s+/).map(parseFloat); return { top: q[0], right: q.length >= 2 ? q[1] : q[0], bottom: q.length >= 3 ? q[2] : q[0], left: q.length === 4 ? q[3] : (q.length >= 2 ? q[1] : q[0]) }; };
    const ok = (v) => /^[0-9.]+px(?:\s+[0-9.]+px){0,3}$/.test(v || '');
    if (!pad || !pad.base) return pad;
    const sp = smOf(el).padding, mp = mdOf(el).padding;
    if (!ok(sp) && !ok(mp)) return pad;
    // base = phone (or desktop when the phone value is the same), md = tablet when it differs, lg = desktop.
    return { base: ok(sp) ? sides4(sp) : pad.base, md: ok(mp) ? sides4(mp) : null, lg: pad.base };
  };
  const decorPseudosOf = (el) => {
    const out = [];
    let er; try { er = el.getBoundingClientRect(); } catch { return out; }
    if (er.width < 120 || er.height < 60) return out;
    for (const pe of ['::before', '::after']) {
      let ps; try { ps = getComputedStyle(el, pe); } catch { continue; }
      if (!ps || ps.content === 'none' || ps.content === 'normal' || ps.display === 'none' || ps.position !== 'absolute') continue;
      const w = parseFloat(ps.width), h = parseFloat(ps.height);
      if (!((w >= 24 && h >= 2) || (h >= 24 && w >= 2))) continue; // a glow / blob, or a thin accent bar (capture.mjs twin)
      { const sw = sweepLayerOf(el, pe, ps); if (sw) { out.push(sw); continue; } } // a moving painted layer (its declared rule + keyframes) — before the covering gate
      if (w >= er.width * 0.9 && h >= er.height * 0.9) continue;
      const bgi = ps.backgroundImage || 'none', bgc = ps.backgroundColor || '';
      const painted = (bgi !== 'none' && /gradient\(/i.test(bgi) && !/url\(/i.test(bgi) && bgi.length <= 1200) || (/^rgba?\(/i.test(bgc) && !/,\s*0\s*\)$/.test(bgc));
      const bw = parseFloat(ps.borderTopWidth) || 0;
      const bordered = (bw > 0 && ps.borderTopStyle !== 'none' && /^rgba?\(/i.test(ps.borderTopColor) && !/,\s*0\s*\)$/.test(ps.borderTopColor)) || (ps.boxShadow && ps.boxShadow !== 'none');
      if (!painted && !bordered) continue;
      const pct = (px, base) => (Math.round((parseFloat(px) / base) * 1000) / 10) + '%';
      const d = { pe: pe.slice(2), width: w < 12 ? Math.round(w) + 'px' : pct(w, er.width), height: h < 12 ? Math.round(h) + 'px' : pct(h, er.height) }; // a thin side stays px
      { const zi = ps.zIndex; if (zi && zi !== 'auto') d.z = zi; else if (w * h < er.width * er.height * 0.15) d.above = true; } // stacking (capture.mjs twin)
      if (painted) d.background = bgi !== 'none' ? bgi : bgc;
      if (bw > 0 && ps.borderTopStyle !== 'none') d.border = ps.borderTopWidth + ' ' + ps.borderTopStyle + ' ' + ps.borderTopColor;
      if (ps.boxShadow && ps.boxShadow !== 'none') d.shadow = ps.boxShadow;
      if (Math.abs(parseFloat(ps.top)) <= Math.abs(parseFloat(ps.bottom))) d.top = pct(ps.top, er.height); else d.bottom = pct(ps.bottom, er.height);
      if (Math.abs(parseFloat(ps.left)) <= Math.abs(parseFloat(ps.right))) d.left = pct(ps.left, er.width); else d.right = pct(ps.right, er.width);
      if (ps.filter && ps.filter !== 'none') d.filter = ps.filter;
      const op = Math.min(1, parseFloat(ps.opacity) || 1); if (op < 1) d.opacity = String(op);
      if (ps.borderRadius && ps.borderRadius !== '0px') d.radius = ps.borderRadius;
      out.push(d);
    }
    return out;
  };
  // A SKINNED PANEL wrapping content — a ring / card / glass box that HOLDS blocks (fill, gradient, border or shadow),
  // not a row, not a chip row, not a pill (inline children only). PHP twin: is_panel / panel_build. Returns the panel's
  // measure ({ box, pad, width / maxw / aspect (the sheet's own expressions), align, selfCenter, centerH, centerV,
  // decor, mt, mb }) or null; the caller decomposes the children into "blocks".
  const panelOf = (el) => {
    if (!el || !/^(DIV|ARTICLE|ASIDE|SECTION|FIGURE)$/.test(el.tagName)) return null;
    const kids = rowKids(el); if (!kids.length) return null;
    if (kids.every((k) => /^(SPAN|SVG|I|EM|STRONG|B|A|SMALL|BR)$/.test(k.tagName))) return null; // a pill / badge
    const s = getComputedStyle(el);
    const grad = /gradient\(/i.test(s.backgroundImage || '') && !/url\(/i.test(s.backgroundImage) ? s.backgroundImage : '';
    const bw = (parseFloat(s.borderTopWidth) || 0) > 0 && s.borderTopStyle !== 'none' ? s.borderTopWidth : '';
    const shadow = (s.boxShadow && s.boxShadow !== 'none') ? s.boxShadow : '';
    if (!hasBg(s.backgroundColor) && !grad && !bw && !shadow) return null;
    let content = !!el.querySelector('h1,h2,h3,h4,h5,h6,p,img,video,iframe,picture,ul,ol');
    if (!content) { const tb = kids.filter((k) => !/^(SPAN|SVG|I|EM|STRONG|B|A|SMALL|BR)$/.test(k.tagName) && txt(k) !== '').length; content = tb >= 2; } // a stat card: label div + value div
    if (!content && txt(el).length < 80) return null;
    if (isRow(el) || chipRowOf(el) || /^(absolute|fixed)$/.test(s.position)) return null;
    const box = { bg: hasBg(s.backgroundColor) ? s.backgroundColor : '', fill: hasBg(s.backgroundColor) ? s.backgroundColor : '', gradient: grad, radius: (parseFloat(s.borderTopLeftRadius) || 0) > 0 ? s.borderTopLeftRadius : '', borderWidth: bw, borderStyle: bw ? s.borderTopStyle : '', borderColor: bw && hasBg(s.borderTopColor) ? s.borderTopColor : '', shadow, backdrop: (s.backdropFilter && s.backdropFilter !== 'none') ? s.backdropFilter : '', padding: '', clip: /^(hidden|clip)$/.test(s.overflow || '') };
    const okv = (v) => /^[a-z0-9()%.,\s+*\/-]+$/i.test(String(v || '')) ? String(v) : '';
    let width = okv(sheetDecl(el, 'width')), maxw = okv(sheetDecl(el, 'maxWidth')), aspect = okv(sheetDecl(el, 'aspectRatio'));
    if (width === 'auto') width = ''; if (maxw === 'none') maxw = ''; if (aspect === 'auto') aspect = '';
    if (!width && !maxw && /px$/.test(s.maxWidth || '')) maxw = s.maxWidth;
    // A SHELL expression (the site's own container cap) means the panel IS the section's container → it fills it. PHP parity.
    const shell = /^min\(\s*(?:\d+px\s*,\s*calc\(100%\s*-\s*\d+px\)|100%\s*-\s*\d+px\s*,\s*\d+px|calc\(100%\s*-\s*\d+px\)\s*,\s*\d+px)\s*\)$/i.test(width);
    if (shell) { width = ''; maxw = ''; }
    const par = el.parentElement; const pcs = par ? getComputedStyle(par) : null;
    let selfCenter = /auto/.test(s.marginLeft) && /auto/.test(s.marginRight);
    if (!selfCenter && pcs) {
      if (/grid/.test(pcs.display) && (pcs.justifyItems === 'center' || /center/.test(pcs.placeItems || ''))) selfCenter = true;
      else if (/flex/.test(pcs.display) && ((/column/.test(pcs.flexDirection) && pcs.alignItems === 'center') || (!/column/.test(pcs.flexDirection) && pcs.justifyContent === 'center'))) selfCenter = true;
    }
    let centerH = false, centerV = false;
    if (/grid/.test(s.display)) { centerH = s.justifyItems === 'center' || /center/.test(s.placeItems || ''); centerV = s.alignItems === 'center' || /center/.test(s.placeItems || ''); }
    else if (/flex/.test(s.display)) { if (/column/.test(s.flexDirection)) { centerH = s.alignItems === 'center'; centerV = s.justifyContent === 'center'; } else { centerH = s.justifyContent === 'center'; centerV = s.alignItems === 'center'; } }
    const pad = padWithPhone(el, { base: { top: parseFloat(s.paddingTop) || 0, right: parseFloat(s.paddingRight) || 0, bottom: parseFloat(s.paddingBottom) || 0, left: parseFloat(s.paddingLeft) || 0 } });
    // The panel's inset = its own padding + that of a SOLE unskinned wrapper child (the flattened '.inner' of a
    // '.shell > .inner' chain). PHP parity.
    if (kids.length === 1 && !cardSkinOf(kids[0]) && !edgeSkinOf(kids[0])) { const ks = getComputedStyle(kids[0]); for (const [k2, pr] of [['top', 'paddingTop'], ['right', 'paddingRight'], ['bottom', 'paddingBottom'], ['left', 'paddingLeft']]) pad.base[k2] += parseFloat(ks[pr]) || 0; }
    return { box, pad, width, maxw, aspect, align: s.textAlign === 'center' ? 'center' : '', selfCenter, centerH, centerV, shell, decor: decorPseudosOf(el), mt: parseFloat(s.marginTop) || 0, mb: parseFloat(s.marginBottom) || 0 };
  };
  const stackOf = (el) => {
    const kids = rowKids(el); if (kids.length < 2) return null;
    const s = getComputedStyle(el);
    let single = false;
    if (s.display === 'grid') { const tracks = String(s.gridTemplateColumns || '').trim().split(/\s+/).filter((x) => x && x !== 'none'); single = tracks.length === 1; }
    else if (/flex/.test(s.display || '') && /column/.test(s.flexDirection || '')) single = true;
    if (!single) return null;
    const gap = parseFloat((s.rowGap && s.rowGap !== 'normal') ? s.rowGap : s.gap) || 0; if (gap <= 0) return null;
    const subs = kids.filter((k) => k.querySelector('h1,h2,h3,h4,h5,h6,p,img,svg,video,iframe,picture,ul,ol') || txt(k).length >= 20 || isPaintedPanel(k) || !!panelOf(k)).length;
    if (subs < 2) return null;
    return { gap, mt: parseFloat(s.marginTop) || 0, mb: parseFloat(s.marginBottom) || 0 };
  };
  const isRow = (el) => {
    const kids = rowKids(el);
    if (kids.length < 2) return false;
    const s = getComputedStyle(el);
    // HARDENING (layout_row parity): a vertical flex-col stack is NOT a row; and a single-track grid
    // (`grid-cols-1`) is a STACK, not a multi-column band — require >=2 real column tracks so a
    // single-column heading/content band isn't split into a bogus 2-column row.
    if (s.display === 'flex' || s.display === 'inline-flex') return !(s.flexDirection || '').startsWith('column');
    if (s.display === 'grid') {
      const tracks = String(s.gridTemplateColumns || '').trim().split(/\s+/).filter((t) => t && t !== 'none');
      return tracks.length >= 2;
    }
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
    let fit = ( cs.objectFit && cs.objectFit !== 'fill' ) ? cs.objectFit : '';
    if ( !fit ) { // fall back to the object-cover / object-contain class when computed wasn't captured
      const icls = String(el.className || '');
      if ( /\bobject-cover\b/.test(icls) ) fit = 'cover';
      else if ( /\bobject-contain\b/.test(icls) ) fit = 'contain';
    }
    if ( fit ) o.objectFit = fit;
    if ( cs.boxShadow && cs.boxShadow !== 'none' ) o.shadow = cs.boxShadow;
    if ( cs.maxWidth && cs.maxWidth !== 'none' ) o.maxWidth = cs.maxWidth;
    // The image's OWN uniform border (a `border-4 border-white` photo frame) and outline / ring → the media_image builder's
    // `selector img` rule, so a framed / rounded photo stays a NATIVE element instead of a verbatim block. PHP: image_styles.
    { const bw = parseFloat(cs.borderTopWidth) || 0;
      if (bw > 0 && cs.borderTopStyle && cs.borderTopStyle !== 'none' && cs.borderTopWidth === cs.borderBottomWidth && cs.borderTopWidth === cs.borderLeftWidth) { o.borderWidth = cs.borderTopWidth; o.borderStyle = cs.borderTopStyle; o.borderColor = cs.borderTopColor; }
      const ow = parseFloat(cs.outlineWidth) || 0;
      if (ow > 0 && cs.outlineStyle && cs.outlineStyle !== 'none') { o.outline = cs.outlineWidth + ' ' + cs.outlineStyle + ' ' + cs.outlineColor + (cs.outlineOffset && cs.outlineOffset !== '0px' ? ';outline-offset:' + cs.outlineOffset : ''); } }
    // ASPECT-RATIO of the framing wrapper (a `aspect-video`/`aspect-[4/3]` box with object-cover crops the
    // photo to a fixed box) — from a Tailwind class or a computed aspect-ratio on the <img> or a near
    // ancestor. Parity with PHP img_wrapper_aspect(). Lets the media_image reproduce a fixed-ratio crop.
    const aspectOf = (n) => {
      if (!n || n.nodeType !== 1) return '';
      const c = String(n.className || '');
      if (/\baspect-video\b/.test(c)) return '16 / 9';
      if (/\baspect-square\b/.test(c)) return '1 / 1';
      const m = c.match(/aspect-\[([0-9.]+)\/([0-9.]+)\]/);
      if (m) return `${m[1]} / ${m[2]}`;
      const ar = getComputedStyle(n).aspectRatio;
      if (ar && ar !== 'auto' && ar.replace(/\s/g, '') !== '0/0') return ar.trim();
      return '';
    };
    let asp = aspectOf(el);
    for (let p = el.parentElement, i = 0; !asp && p && i < 3; p = p.parentElement, i++) asp = aspectOf(p);
    if ( asp ) o.aspect = asp;
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
  // EMPTY PAINTED BOXES inside a card / text cell (an aspect-ratio placeholder, a pattern tile, a colour swatch — no text,
  // no media, in flow): [{ n, css, before }] — `before` = precedes the anchor paragraph in document order. The hook
  // <div class="sc-deco-N"></div> rides the description / a code block; the paint rides scoped CSS. PHP: card_from_cell bodyDecor.
  // A logo strip's own treatment → the logo_grid options (gap / opacity dim / grayscale / mark size from the item font
  // size). PHP: logo_strip_build.
  const logoStripTreatment = (el) => {
    const o = {}; let cs; try { cs = getComputedStyle(el); } catch { return o; }
    const cls = ' ' + (el.getAttribute('class') || '') + ' ';
    let m;
    if ((m = String(cs.columnGap || cs.gap || '').match(/^([0-9.]+)px/))) o.gap = String(Math.round(+m[1])); else if ((m = cls.match(/(?:^|\s)gap-(\d+)(?:\s|$)/))) o.gap = String((+m[1]) * 4); // measured desktop gap first (a md:gap-16 is 64px at 1440)
    if ((m = cls.match(/(?:^|\s)opacity-(\d{1,3})(?:\s|$)/))) o.opacity = String((+m[1]) / 100); else if (+cs.opacity > 0 && +cs.opacity < 1) o.opacity = String(+cs.opacity);
    o.grayscale = (/\sgrayscale\s/.test(cls) || /grayscale/i.test(cs.filter || '')) ? 'yes' : 'no';
    const sp = el.querySelector('span'); if (sp) { const fs = parseFloat(getComputedStyle(sp).fontSize); if (fs > 0) o.iconSize = String(Math.round(fs * 1.2)); }
    // the ITEM's own mark→label gap / padding + label typography (PHP: logo_strip_build item)
    const it = [...el.children].find((c) => txt(c).trim());
    if (it) { const ics = getComputedStyle(it); const item = {}; const g = parseFloat(ics.columnGap || ics.gap); if (g > 0) item.gap = Math.round(g); item.pad = /^[0-9.]+px(\s+[0-9.]+px){0,3}$/.test(ics.padding) ? ics.padding : '0px'; if (/^[0-9.]+px$/.test(ics.fontSize)) item.fs = ics.fontSize; if (/^[0-9]+$/.test(ics.fontWeight)) item.fw = ics.fontWeight; if (/^[0-9.]+px$/.test(ics.lineHeight)) item.lh = ics.lineHeight; o.item = item; }
    return o;
  };
  const decorBoxesOf = (wrap, anchor) => {
    const boxes = [];
    for (const d of wrap.querySelectorAll('div,span,figure')) {
      if (boxes.length >= 4 || d === wrap || txt(d).trim()) continue;
      // an ICON CHIP (holds an <iconify-icon> / <i> / custom element / svg / img / media) is the card's icon, never decoration (PHP: holds_icon_or_media)
      if (/^(img|svg|picture|video|canvas|i|iconify-icon)$/i.test(d.tagName) || d.tagName.includes('-') || d.querySelector('img,svg,picture,video,canvas,i,iconify-icon') || [...d.querySelectorAll('*')].some(x => x.tagName.includes('-'))) continue;
      let cs; try { cs = getComputedStyle(d); } catch { continue; }
      if (/^(absolute|fixed)$/.test(cs.position) || cs.display === 'none') continue;
      const r = d.getBoundingClientRect(); const bg = cs.backgroundColor, bgi = cs.backgroundImage, ar = cs.aspectRatio;
      const painted = (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') || (bgi && bgi !== 'none');
      const hasAr = ar && ar !== 'auto' && ar.replace(/\s/g, '') !== '0/0';
      if (!(painted || hasAr) || !(r.height >= 24 || hasAr)) continue;
      const decl = [];
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') decl.push('background-color:' + bg);
      if (bgi && bgi !== 'none' && bgi.length <= 2000 && !/<\/style/i.test(bgi)) { decl.push('background-image:' + bgi.replace(/</g, '%3C').replace(/>/g, '%3E')); for (const [k, v] of [['background-size', cs.backgroundSize], ['background-position', cs.backgroundPosition], ['background-repeat', cs.backgroundRepeat]]) if (v && /^[a-z0-9%.,\s-]+$/i.test(v)) decl.push(k + ':' + v); }
      if (hasAr) decl.push('aspect-ratio:' + ar.trim()); else if (r.height >= 24) decl.push('height:' + Math.round(r.height) + 'px');
      if (cs.borderRadius && cs.borderRadius !== '0px') decl.push('border-radius:' + cs.borderRadius);
      if (cs.margin && /[1-9]/.test(cs.margin) && /^[0-9.px\s-]+$/.test(cs.margin)) decl.push('margin:' + cs.margin);
      if (!decl.length) continue;
      boxes.push({ n: boxes.length + 1, css: decl.join(';'), before: !!(anchor && (anchor.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_PRECEDING)) });
    }
    return boxes;
  };
  // A card whose title block and text sit SIDE BY SIDE (the cell is a flex ROW whose direct children are the heading's
  // block and the paragraph) → { gap, titleLast, from } for iconBoxNode's .icon-box__inner row rule. PHP: card_row_layout.
  const cardRowOf = (cell, h) => {
    if (!cell || !h) return null;
    let cs; try { cs = getComputedStyle(cell); } catch { return null; }
    if (!/flex/.test(cs.display) || cs.flexDirection.indexOf('row') !== 0) return null;
    const kids = [...cell.children]; if (kids.length < 2 || kids.length > 3) return null;
    let titleIdx = -1, textItem = null;
    kids.forEach((k, i) => { if (k === h || k.contains(h)) titleIdx = i; else if (k.tagName === 'P' || k.querySelector('p')) textItem = k; });
    if (titleIdx < 0 || !textItem) return null;
    const gap = parseFloat(cs.columnGap && cs.columnGap !== 'normal' ? cs.columnGap : cs.gap) || 0;
    let order = 0; try { order = parseInt(getComputedStyle(kids[titleIdx]).order, 10) || 0; } catch { order = 0; }
    const md = mdOf(cell)['flex-direction'] || '';
    return { gap: Math.round(gap), titleLast: order > 0 || (order === 0 && titleIdx > 0), from: /column/.test(md) ? 'lg' : 'md' };
  };
  // A card's EYEBROW: the nearest short (≤ 40 chars) leaf before the heading that is small (≤ 13px) or uppercase → { text, cs }.
  const cardEyebrowOf = (wrap, h) => {
    let best = null;
    for (const e of wrap.querySelectorAll('div,span,small,p,em,strong')) {
      if (e === h || e.contains(h)) { if (e === h) break; continue; }
      if (!(e.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      if (e.children.length) continue;
      const t = txt(e).replace(/\s+/g, ' ').trim();
      if (!t || t.length > 40 || /[.!?]$/.test(t)) continue;
      let cs; try { cs = getComputedStyle(e); } catch { continue; }
      const fs = parseFloat(cs.fontSize) || 16;
      const upper = cs.textTransform === 'uppercase' || (/[a-z]/i.test(t) && t === t.toUpperCase());
      if (fs > 13 && !upper) continue;
      best = { text: t, fontSize: cs.fontSize, letterSpacing: cs.letterSpacing, textTransform: cs.textTransform, color: cs.color, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, marginBottom: cs.marginBottom, fontFamily: cs.fontFamily };
    }
    return best;
  };
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
    // A big DISPLAY heading (>=30px) marks a hero/content column even when it uses an h2 (Tailwind sites
    // routinely size an h2 as `text-6xl`). Feature-card titles are ~18–24px, so this only rejects heroes —
    // which must DECOMPOSE (special_heading + native button + checklist) instead of swallowing the CTA.
    try { if ((parseFloat(getComputedStyle(h).fontSize) || 0) >= 30) return null; } catch { /* keep */ }
    // A FILLED CTA button in the column is the other hero tell: feature cards use a bare text link, so a
    // solid/filled button ( real bg + padding + a few chars ) means this is a content column with a CTA that
    // would be LOST inside an icon_box. Decompose it so the button maps to a native button shortcode.
    const _hasCta = [...cell.querySelectorAll('a[href], button')].some((bt) => {
      try { const bs = getComputedStyle(bt); const bg = bs.backgroundColor;
        return txt(bt).length >= 3 && bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && (parseFloat(bs.paddingLeft) || 0) >= 8;
      } catch { return false; }
    });
    if (_hasCta) return null;
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
    // Full badge SKIN (size / corner radius / border) so the JS Icon-Badge-Presets clustering
    // (buildIconBadgePresets, the JS counterpart of PHP build_icon_badge_presets) can derive the
    // Theme Settings → Components → Icon Badges library the same way box skins feed Box Presets.
    let iconBadgeSize = 0, iconBadgeRadius = '', iconBadgeBorderWidth = '', iconBadgeBorderColor = '';
    try {
      // an <iconify-icon> host (the capture fills it with its shadow svg) is not the chip — the chip is its parent (PHP parity)
      const _host = iconEl.parentElement; const _hostIsIcon = _host && /^iconify-icon$/i.test(_host.tagName);
      for (const el of [iconEl, _host, _hostIsIcon ? _host.parentElement : null].filter(Boolean)) {
        const cs = getComputedStyle(el);
        const m = (cs.backgroundColor || '').match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/i);
        const alpha = m ? (m[4] === undefined ? 1 : parseFloat(m[4])) : 0;
        if (m && alpha > 0.05) {
          const hx = (n) => ('0' + (+n).toString(16)).slice(-2);
          // Preserve a TINT badge (e.g. bg-primary/10 → rgba(...,0.1)) so it renders soft, not as a solid
          // circle with a white icon. Only flatten to a solid hex when the fill is (near-)opaque.
          iconBadgeColor = alpha < 0.98 ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${+alpha.toFixed(2)})` : '#' + hx(m[1]) + hx(m[2]) + hx(m[3]);
          const r = parseFloat(cs.borderTopLeftRadius) || 0;
          const box = el.getBoundingClientRect();
          const w = box.width || 0, h = box.height || 0;
          iconBadge = (r > 12 && r >= w / 2 - 2) ? 'solid-circle' : (r > 0 ? 'solid-rounded' : 'solid-square');
          // Roughly-square tiles only carry a meaningful "size"; skip an oblong wrapper.
          if (w && h && Math.abs(w - h) <= Math.max(6, 0.35 * Math.max(w, h))) { iconBadgeSize = Math.round((w + h) / 2); }
          else if (w) { iconBadgeSize = Math.round(w); }
          if (iconBadge === 'solid-rounded' && r > 0) { iconBadgeRadius = cs.borderTopLeftRadius; }
          const bw = parseFloat(cs.borderTopWidth) || 0;
          if (bw > 0) {
            iconBadgeBorderWidth = cs.borderTopWidth;
            const bm = (cs.borderTopColor || '').match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/i);
            const ba = bm ? (bm[4] === undefined ? 1 : parseFloat(bm[4])) : 0;
            if (bm && ba > 0.05) { iconBadgeBorderColor = '#' + hx(bm[1]) + hx(bm[2]) + hx(bm[3]); }
          }
          break;
        }
      }
    } catch { /* no badge */ }
    // The card BOX's own presentation → so the icon_box reproduces the source instead of its centred
    // default: text alignment (source feature cards are often LEFT, the shortcode default is centred),
    // the box padding (the `p-8` class collides with the plugin's own `.p-8` = 72px utility, so carry the
    // COMPUTED value), and the box skin (bg / border / radius / shadow) for the native box options.
    // Read the box skin + padding from the CELL when IT carries the box — a source card often wraps the
    // icon+heading in a header sub-div, so `wrap` is that header (no box) while the box/fill/radius/padding
    // live on the cell. Parity with PHP read_card_skin($cell). Falls back to `wrap` (the about-item pattern,
    // where wrap === cell anyway).
    const _cellCs = getComputedStyle(cell);
    const _cellBg = _cellCs.backgroundColor && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(_cellCs.backgroundColor);
    const _cellBoxed = _cellBg || (parseFloat(_cellCs.borderTopWidth) || 0) > 0 || (parseFloat(_cellCs.borderTopLeftRadius) || 0) > 0 || (_cellCs.boxShadow && _cellCs.boxShadow !== 'none');
    const boxCs = _cellBoxed ? _cellCs : getComputedStyle(wrap);
    let _al = (getComputedStyle(wrap).textAlign || 'left').replace(/^(start|justify)$/, 'left').replace(/^end$/, 'right');
    // A card that CENTRES its items by layout rather than text-align (`grid place-items-center`, a `flex flex-col items-center`)
    // reads as centred too. PHP twin: card_from_cell 'center'.
    { const wc = getComputedStyle(wrap); if (_al === 'left' && ((wc.display === 'grid' && /center/.test(wc.justifyItems)) || (/flex/.test(wc.display) && /column/.test(wc.flexDirection) && /center/.test(wc.alignItems)))) _al = 'center'; }
    const okc = (v) => v && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(v);
    return {
      icon, customIcon, lucide, iconLayout, iconColor, iconBadge, iconBadgeColor,
      iconBadgeSize, iconBadgeRadius, iconBadgeBorderWidth, iconBadgeBorderColor,
      decor: decorPseudosOf(cell), // the card's own decorative / sweep pseudo-layers (PHP: card_from_cell decor)
      title: clip(txt(h), 160),
      titleTag: h.tagName.toLowerCase(),
      overline: cardEyebrowOf(wrap, h), // a short muted / uppercase label before the heading → the icon_box Overline (PHP: card_eyebrow)
      // The card title's computed font-weight — a `font-serif` product title carries its real weight only
      // here (no weight utility class), so the imgbox title can re-assert it instead of the theme default
      // (500). Parity with PHP card build (`titleWeight`).
      titleWeight: h ? getComputedStyle(h).fontWeight : '',
      // EMPTY PAINTED BOXES inside the card (an aspect-ratio placeholder, a pattern tile): a class-hooked <div> in the
      // description, in document order around the paragraph, whose paint rides iconBoxNode's scoped CSS (PHP: bodyDecor).
      ...(() => {
        const boxes = decorBoxesOf(wrap, p);
        const hook = (b) => '<div class="sc-deco-' + b.n + '"></div>';
        return { decorBoxes: boxes, text: boxes.filter((b) => b.before).map(hook).join('') + (p ? rawHtmlOf(p, true) : '') + boxes.filter((b) => !b.before).map(hook).join('') };
      })(),
      link: link ? { label: clip(txt(link), 60), href: abs(link.getAttribute('href') || '') } : null,
      cls: String(wrap.className || ''),                      // the card wrapper class (.about-item …) → icon_box css_class
      align: /^(left|center|right)$/.test(_al) ? _al : 'left',
      pad: boxCs.padding,
      box: {
        bg: okc(boxCs.backgroundColor) ? boxCs.backgroundColor : '',
        fill: okc(boxCs.backgroundColor) ? boxCs.backgroundColor : '', // Box-Preset FILL (clustered incl. fill)
        radius: (parseFloat(boxCs.borderTopLeftRadius) || 0) > 0 ? boxCs.borderTopLeftRadius : '',
        borderWidth: (parseFloat(boxCs.borderTopWidth) || 0) > 0 ? boxCs.borderTopWidth : '',
        borderStyle: boxCs.borderTopStyle, borderColor: okc(boxCs.borderTopColor) ? boxCs.borderTopColor : '',
        shadow: (boxCs.boxShadow && boxCs.boxShadow !== 'none') ? boxCs.boxShadow : '',
        backdrop: ((boxCs.backdropFilter && boxCs.backdropFilter !== 'none') ? boxCs.backdropFilter : ((boxCs.webkitBackdropFilter && boxCs.webkitBackdropFilter !== 'none') ? boxCs.webkitBackdropFilter : '')),
        hoverLift: /hover:-?translate-y-/.test(String(wrap.className || '')), padding: boxCs.padding,
        extra: boxExtraOf(wrap), hover: boxHoverOf(wrap), // the long tail + the stamped hover (PHP: read_card_skin extra / data-sc-hover)
      },
      titleExtra: textLongTailOf(h), // the title's text long tail → .icon-box__title (PHP: titleCs)
      // CHILD RHYTHM: the second paragraph's measured top margin / hairline (space-y / divide-y) → p + p (PHP: bodyRhythm).
      bodyRhythm: (() => { const ps2 = wrap.querySelectorAll('p'); if (ps2.length < 2) return ''; let c; try { c = getComputedStyle(ps2[1]); } catch { return ''; } const d = []; const mt = parseFloat(c.marginTop) || 0; if (mt > 0) d.push('margin-top:' + Math.round(mt) + 'px'); const bw = parseFloat(c.borderTopWidth) || 0; if (bw > 0 && c.borderTopStyle !== 'none' && /^[a-z0-9(),.\s#%]+$/i.test(c.borderTopColor)) { d.push('border-top:' + c.borderTopWidth + ' ' + c.borderTopStyle + ' ' + c.borderTopColor); const pt = parseFloat(c.paddingTop) || 0; if (pt > 0) d.push('padding-top:' + Math.round(pt) + 'px'); } return d.join(';'); })(),
      cardRow: cardRowOf(wrap, h), // a side-by-side card (PHP: cardRow)
      // HOVER on the title / description (own or group), + whether each inherits the card's ink (PHP: titleHover / bodyHover).
      titleHover: h ? hoverGroupOf(h) : '', bodyHover: (() => { const bp = cell.querySelector('p'); return bp ? hoverGroupOf(bp) : ''; })(),
      titleInherits: (() => { try { return !h || getComputedStyle(h).color === getComputedStyle(cell).color; } catch { return true; } })(),
      bodyInherits: (() => { const bp = cell.querySelector('p'); try { return !bp || getComputedStyle(bp).color === getComputedStyle(cell).color; } catch { return true; } })(),
      // PHONE / TABLET PASS: the title's / description's 390px / 820px font-size (+ line-height) when it differs (PHP: titleCsSm/Md, bodyCsSm/Md).
      titleFsSm: h ? (smOf(h)['font-size'] || '') : '', titleLhSm: h ? (smOf(h)['line-height'] || '') : '', titleFsMd: h ? (mdOf(h)['font-size'] || '') : '', titleLhMd: h ? (mdOf(h)['line-height'] || '') : '',
      bodyFsSm: (() => { const bp = cell.querySelector('p'); return bp ? (smOf(bp)['font-size'] || '') : ''; })(), bodyLhSm: (() => { const bp = cell.querySelector('p'); return bp ? (smOf(bp)['line-height'] || '') : ''; })(),
      bodyFsMd: (() => { const bp = cell.querySelector('p'); return bp ? (mdOf(bp)['font-size'] || '') : ''; })(), bodyLhMd: (() => { const bp = cell.querySelector('p'); return bp ? (mdOf(bp)['line-height'] || '') : ''; })(),
      titleFsXl: h ? (xlOf(h)['font-size'] || '') : '', titleLhXl: h ? (xlOf(h)['line-height'] || '') : '', bodyFsXl: (() => { const bp = cell.querySelector('p'); return bp ? (xlOf(bp)['font-size'] || '') : ''; })(), bodyLhXl: (() => { const bp = cell.querySelector('p'); return bp ? (xlOf(bp)['line-height'] || '') : ''; })(),
      padXl: xlOf(wrap).padding || '', // the card's >= 1536px inset when it differs (PHP: cardCsXl)
      bodyExtra: (() => { const bp = cell.querySelector('p'); return bp ? textLongTailOf(bp) : ''; })(), // the description's → .icon-box__content (PHP: bodyCs)
      // The description's OWN measure (a max-width: 36ch resolved to px) → .icon-box__content{max-width} so the copy wraps
      // where the source wraps instead of filling the tile (PHP: n_icon_box bodyCs max-width).
      bodyMaxWidth: (() => { const bp = cell.querySelector('p'); if (!bp) return ''; let mw = ''; try { mw = getComputedStyle(bp).maxWidth; } catch { return ''; } return (/^[0-9.]+px$/.test(mw) && parseFloat(mw) < 900) ? mw : ''; })(),
      bodyLinkSkin: (() => { const bp = cell.querySelector('p'); const a = bp && bp.querySelector('a'); if (!a) return ''; let ls, ps; try { ls = getComputedStyle(a); ps = getComputedStyle(bp); } catch { return ''; } const d = []; if (ls.color && ls.color !== ps.color) d.push('color:' + ls.color); if (ls.textDecorationLine && ls.textDecorationLine !== 'none') d.push('text-decoration-line:' + ls.textDecorationLine); if (ls.textDecorationThickness && !/^(auto|from-font)$/.test(ls.textDecorationThickness)) d.push('text-decoration-thickness:' + ls.textDecorationThickness); if (ls.textUnderlineOffset && ls.textUnderlineOffset !== 'auto') d.push('text-underline-offset:' + ls.textUnderlineOffset); if (ls.textDecorationColor && ls.textDecorationColor !== ls.color) d.push('text-decoration-color:' + ls.textDecorationColor); if (ls.fontWeight && ls.fontWeight !== ps.fontWeight) d.push('font-weight:' + ls.fontWeight); return d.join(';'); })(), // the description's first inline link (PHP: bodyLinkCs)
      bodyColor: (() => { const bp = cell.querySelector('p'); if (!bp) return ''; try { const bc = getComputedStyle(bp).color, cc = getComputedStyle(cell).color; return bc && bc !== cc ? bc : ''; } catch { return ''; } })(), // the description's own ink when it differs from the card's (PHP: content_color)
      // A COLOURED card's inherited ink (a brand-filled `text-white` card): the title / description colour when it differs from the
      // PAGE ink (the body's colour = what the theme's heading / text defaults resolve to). PHP: n_icon_box page_ink.
      titleInk: (() => { try { const tc = getComputedStyle(h).color, pc = getComputedStyle(document.body).color; return tc && tc !== pc ? tc : ''; } catch { return ''; } })(),
      bodyInk: (() => { const bp = cell.querySelector('p'); if (!bp) return ''; try { const bc = getComputedStyle(bp).color, pc = getComputedStyle(document.body).color; return bc && bc !== pc ? bc : ''; } catch { return ''; } })(),
    };
  };

  // --- IMAGE-COMPOSITE DECOMPOSITION (P0 fidelity fix) — parity with the PHP Stitch path. -----------
  // A hero's "photo in an organic frame + floating badge + blob backdrop" is torn into NATIVE parts:
  // { image, cards[], blob } so to-pages emits a media_image (skin + blob via scoped CSS) + icon_box(es)
  // instead of one verbatim code_block. Returns null when the cell isn't a clean composite.
  const isTransparent = (v) => !v || /rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(v);
  const compositeOverlays = (cell) => {
    const cards = [], blobs = [];
    for (const d of cell.querySelectorAll('div')) {
      const cs = getComputedStyle(d);
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
      if (d.querySelector('img')) continue;                       // a wrapper AROUND the image is the frame
      const t = txt(d).trim();
      const hasIcon = !!d.querySelector('svg, i');
      if (!t && !hasIcon) {
        const rounded = (cs.borderRadius && !/^(0px)( 0px)*$/.test(cs.borderRadius.trim()));
        if (rounded || !isTransparent(cs.backgroundColor)) blobs.push(d);   // decorative blob layer
        continue;
      }
      const rounded = (parseFloat(cs.borderTopLeftRadius) || 0) > 0;
      const shadow = cs.boxShadow && cs.boxShadow !== 'none';
      if ((t || hasIcon) && (rounded || shadow || !isTransparent(cs.backgroundColor))) cards.push(d);
    }
    return { cards, blobs };
  };
  // A floating badge/card overlay (icon chip + bold title + muted subtitle) → the icon_box card shape.
  const floatingCardOf = (card) => {
    // the card's TEXT LINES (p / div / span / h-tag leaves with their own text): the TITLE is the heaviest / largest line, a small
    // FIRST line is the overline, the rest is content (PHP floating_card_block — a date chip's month over its day)
    const lines = [];
    for (const ln of card.querySelectorAll('p,div,span,h1,h2,h3,h4,h5,h6,strong,b,small')) {
      let own = ''; for (const tn of ln.childNodes) { if (tn.nodeType === 3) own += tn.nodeValue; else if (tn.nodeType === 1 && /^(strong|b|em|i|span)$/i.test(tn.tagName) && !tn.querySelector('*')) own += tn.textContent; }
      own = own.replace(/\s+/g, ' ').trim(); if (!own || !/[\p{L}\d]/u.test(own)) continue;
      const lcs = getComputedStyle(ln);
      lines.push({ text: own, el: ln, cs: lcs, fs: parseFloat(lcs.fontSize) || 16, w: parseInt(lcs.fontWeight, 10) || 400, tag: ln.tagName.toLowerCase() });
    }
    let title = '', subtitle = '', overline = null, titleLine = null;
    if (lines.length) {
      let ti = 0, best = -1; lines.forEach((l, i) => { const sc = l.fs * (l.w >= 600 ? 1.5 : 1) + (/^h[1-6]$/.test(l.tag) ? 4 : 0); if (sc > best) { best = sc; ti = i; } });
      titleLine = lines[ti]; title = titleLine.text; const rest = [];
      lines.forEach((l, i) => { if (i === ti) return; if (!overline && i < ti && l.fs <= 14) { overline = l; return; } rest.push(l.text); });
      subtitle = rest.join(' ');
    } else { title = txt(card).trim(); }
    const svg = card.querySelector('svg');
    const hx = (n) => ('0' + (+n).toString(16)).slice(-2);
    const toHex = (v) => { const m = String(v || '').match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i); return m ? '#' + hx(m[1]) + hx(m[2]) + hx(m[3]) : ''; };
    const o = { title, titleTag: 'h4', subtitle, iconLayout: 'inline-left', center: false };
    const ccs0 = getComputedStyle(card);
    if (titleLine) {
      const t = titleLine.cs, ex = [];
      if (Math.abs(titleLine.fs - 20) > 0.5 && titleLine.fs >= 10 && titleLine.fs <= 48) ex.push('font-size:' + titleLine.fs + 'px');
      const lh = parseFloat(t.lineHeight); if (lh > 0 && lh <= titleLine.fs * 1.15) ex.push('line-height:' + lh + 'px'); // a `leading-none` title keeps its tight leading
      const mb = parseFloat(t.marginBottom) || 0; if (Math.abs(mb - 8) > 0.5 && mb <= 40) ex.push('margin-bottom:' + mb + 'px');
      if (ex.length) o.titleExtra = ex.join(';');
      if (overline) {
        const oc = overline.cs; const mt = parseFloat(t.marginTop) || 0; const omb = parseFloat(oc.marginBottom) || 0;
        // an overline with NO margin of its own takes the title's `mt-*` as its gap (not the theme's 8px)
        o.overline = { text: overline.text, fontSize: oc.fontSize, letterSpacing: oc.letterSpacing, lineHeight: oc.lineHeight, textTransform: oc.textTransform, fontWeight: oc.fontWeight, color: oc.color, fontFamily: oc.fontFamily, marginBottom: (omb > 0 ? omb : mt) + 'px' };
      }
    }
    // a STACKED chip (`flex-col items-center`) keeps its column — the inline layout put the two lines side by side
    if (/^column/.test(ccs0.flexDirection || '') || /(?:^|\s)flex-col(?:\s|$)/.test(String(card.className || ''))) {
      o.iconLayout = 'top-title';
      if (/center/.test(ccs0.alignItems || '') || /center/.test(ccs0.textAlign || '')) o.center = true;
      o.innerGap = /^[0-9.]+px$/.test(ccs0.rowGap || '') ? ccs0.rowGap : '0';
    }
    if (/^[0-9.]+px$/.test(ccs0.minWidth || '') && parseFloat(ccs0.minWidth) > 0) o.minWidth = ccs0.minWidth;
    if (svg) {
      o.customIcon = svg.outerHTML;
      o.iconCls = String(svg.getAttribute('class') || '');
      const ic = toHex(getComputedStyle(svg).color);
      if (ic) o.iconColor = ic;                                  // hex → icon_box Icon Color (hex-only guard)
      const chip = (svg.parentElement && svg.parentElement !== card) ? svg.parentElement : null;
      if (chip) {
        const cs = getComputedStyle(chip);
        if (!isTransparent(cs.backgroundColor)) {
          // Preserve a TINT badge (bg-primary/10 → rgba(...,0.1)) so a soft chip stays soft instead of
          // becoming a solid circle with a white icon; flatten to a hex only when (near-)opaque.
          const bm = (cs.backgroundColor || '').match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/i);
          const ba = bm ? (bm[4] === undefined ? 1 : parseFloat(bm[4])) : 1;
          o.iconBadgeColor = (bm && ba < 0.98) ? `rgba(${bm[1]}, ${bm[2]}, ${bm[3]}, ${+ba.toFixed(2)})` : toHex(cs.backgroundColor);
          const r = parseFloat(cs.borderTopLeftRadius) || 0;
          o.iconBadge = (r >= 9999 || /50%/.test(cs.borderRadius)) ? 'solid-circle' : (r > 0 ? 'solid-rounded' : 'solid-square');
        }
      }
    }
    // Position + skin (from the source Tailwind classes + computed styles) for the scoped posCss.
    const cs = getComputedStyle(card);
    o.pos = { cls: String(card.className || ''), bg: cs.backgroundColor, radius: cs.borderRadius, shadow: cs.boxShadow, padding: cs.padding };
    return o;
  };
  const imgCompositeOf = (cell) => {
    const img = cell.querySelector('img');
    if (!img) return null;
    const ov = compositeOverlays(cell);
    if (!ov.cards.length && !ov.blobs.length) return null;         // not a decomposable composite
    // IMAGE-DOMINANT guard (parity with PHP is_decomposable_image_composite): a composite is a photo FRAME,
    // not one cell of a wider `image | text` band. Heading/body/button content OUTSIDE the absolute overlays
    // means a band — bail so it stays split into real columns instead of dropping the text side.
    const withinAbsolute = (node) => {
      for (let p = node.parentElement; p && p !== cell; p = p.parentElement) {
        if (/\b(?:absolute|fixed)\b/.test(String(p.className || ''))) return true;
        const pos = getComputedStyle(p).position;
        if (pos === 'absolute' || pos === 'fixed') return true;
      }
      return false;
    };
    for (const n of cell.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,button')) {
      const hasText = (n.textContent || '').trim() !== '';
      if (!hasText && !n.querySelector('svg,img')) continue;
      if (!withinAbsolute(n)) return null;                         // sibling content outside overlays → a band
    }
    const ics = getComputedStyle(img);
    const image = { src: abs(img.currentSrc || img.src || ''), alt: img.alt || '', ...imgSkin(img) };
    const bw = parseFloat(ics.borderTopWidth) || 0;
    if (bw > 0 && !isTransparent(ics.borderTopColor)) { image.borderWidth = ics.borderTopWidth; image.borderColor = ics.borderTopColor; }
    let blob = null;
    if (ov.blobs.length) {
      const bel = ov.blobs[0];
      const bcs = getComputedStyle(bel);
      const bcls = String(bel.className || '');
      const sm = bcls.match(/\bscale-(\d{1,3})\b/);
      // A FULL-BLEED tinted layer (`inset-0`) over the image is a SCRIM (paints ON TOP, z-index above the
      // <img>), not a decorative backdrop BEHIND it; a `hover:bg-transparent` scrim clears on hover. Parity
      // with PHP img_composite_skin_css.
      const scrim = /\binset-0\b/.test(bcls) || bcs.inset === '0px' || (bcs.top === '0px' && bcs.left === '0px' && bcs.right === '0px' && bcs.bottom === '0px');
      const hoverClear = scrim && /(?:^|\s)(?:group-)?hover:bg-transparent(?:\s|$)/.test(bcls);
      blob = { bg: bcs.backgroundColor, radius: bcs.borderRadius, scale: sm ? (parseInt(sm[1], 10) / 100) : 0,
        scrim, hoverClear, dur: (bcs.transitionDuration && bcs.transitionDuration !== '0s') ? bcs.transitionDuration : '' };
    }
    return { image, cards: ov.cards.map(floatingCardOf), blob };
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
      bs: { bg: bcs.backgroundColor, fg: bcs.color, bd: bcs.borderTopColor, bds: bcs.borderTopStyle, grad: (/linear-gradient\(/i.test(bcs.backgroundImage || '') ? bcs.backgroundImage : '') },
      // Full skin + dimensions so the mapper can build a faithful Button Preset. `tw`
      // carries the design-token intent (shadow-lg / rounded-full / border-2) that maps
      // onto the preset SCALES; the raw computed values are the fallback when not Tailwind.
      sh: (bcs.boxShadow && bcs.boxShadow !== 'none') ? bcs.boxShadow : '',
      rad: bcs.borderRadius, bw: bcs.borderTopWidth, bwStyle: bcs.borderTopStyle,
      pad: bcs.padding, height: bcs.height, radius: bcs.borderTopLeftRadius, fw: bcs.fontWeight, fs: bcs.fontSize, lh: bcs.lineHeight,
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
    // Overline ICON — a leading/trailing <svg> inside the overline pill (e.g. a lucide house before
    // "Your Prefab Financing Partner"). Captured for the native overline_icon option, kept out of the text.
    let ovIcon = '', ovIconPos = 'before';
    if (sp) {
      const svg = sp.querySelector('svg');
      if (svg && svg.innerHTML.trim()) {
        ovIcon = stripCs(svg.outerHTML);
        // Position: is the icon before or after the pill's text node?
        const spText = txt(sp);
        ovIconPos = (spText && sp.textContent.trim().indexOf(spText) > 0) ? 'after' : 'before';
      }
    }
    return {
      overline: sp ? clip(txt(sp), 60) : '',
      overlineClass: sp ? String(sp.className || '') : '',
      overlineIcon: ovIcon,
      overlineIconPos: ovIconPos,
      title: richHeading(h) || escHtml(txt(h)), // inner HTML — keep coloured <span> etc., no <hN> wrapper
      titleTag: h.tagName.toLowerCase(),
      titleClass: String(h.className || ''),
      subtitle: p0 ? ( richHeading(p0) || escHtml(txt(p0)) ) : '', // inner content, no <p> wrapper
      subtitleClass: p0 ? String(p0.className || '') : '',
      titleLongTail: textLongTailOf(h), subtitleLongTail: p0 ? textLongTailOf(p0) : '', // the text long tail (PHP: prose profiles)
      // The subtitle's own computed style (font-size / colour / line-height — headingNode's subtitle tier) and its first
      // inline link's skin, so a text card keeps a brand-coloured description and a styled link. PHP: bodyCs / bodyLinkCs.
      subtitleStyle: (() => { if (!p0) return null; try { const c = getComputedStyle(p0); return { fontSize: c.fontSize, color: c.color, lineHeight: c.lineHeight }; } catch { return null; } })(),
      subtitleLinkSkin: (() => { const a = p0 && p0.querySelector('a'); if (!a) return ''; let ls, ps; try { ls = getComputedStyle(a); ps = getComputedStyle(p0); } catch { return ''; } const d = []; if (ls.color && ls.color !== ps.color) d.push('color:' + ls.color); if (ls.textDecorationLine && ls.textDecorationLine !== 'none') d.push('text-decoration-line:' + ls.textDecorationLine); if (ls.textDecorationThickness && !/^(auto|from-font)$/.test(ls.textDecorationThickness)) d.push('text-decoration-thickness:' + ls.textDecorationThickness); if (ls.textUnderlineOffset && ls.textUnderlineOffset !== 'auto') d.push('text-underline-offset:' + ls.textUnderlineOffset); if (ls.textDecorationColor && ls.textDecorationColor !== ls.color) d.push('text-decoration-color:' + ls.textDecorationColor); if (ls.fontWeight && ls.fontWeight !== ps.fontWeight) d.push('font-weight:' + ls.fontWeight); return d.join(';'); })(),
      wrapClass: headingWrapClass(h), // a semantic <div class="heading"> wrapper → special_heading css_class
      paras: ps.slice(1).map((p) => rawHtmlOf(p, true)).filter((x) => x && x.trim()),
      decorBoxes: decorBoxesOf(h.parentElement || h, p0), // empty painted boxes beside the text (PHP: bodyDecor)
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
    const labelEl = [...wrap.querySelectorAll('p')].find((p) => txt(p) && txt(p).trim())
      || [...wrap.querySelectorAll('div,span')].find((e) => e !== stat && !e.contains(stat) && !e.children.length && txt(e).trim() && txt(e).length <= 32 && !/\d/.test(txt(e))); // a short leaf label ("ENERGY STATE")
    const label = labelEl ? txt(labelEl) : '';
    const labelFirst = !!(labelEl && (labelEl.compareDocumentPosition(stat) & Node.DOCUMENT_POSITION_FOLLOWING)); // the caption sits ABOVE the number ("ENERGY STATE" over "98%")
    const ncs = getComputedStyle(stat), hcs = getComputedStyle(host);
    // the digits' own face (a mono stat in a sans page) + the caption's measured treatment → a Text Style match on the
    // label block, the leftovers on its own Custom CSS, never an inline style (PHP: counter_number_treatment / counter_label_node)
    const numberFamily = ownFaceOf(ncs) ? String(ncs.fontFamily).split(',')[0].trim().replace(/^["']|["']$/g, '') : '';
    let labelStyle = null;
    if (labelEl) { const lc = getComputedStyle(labelEl); labelStyle = { fontSize: lc.fontSize, color: lc.color, lineHeight: lc.lineHeight, letterSpacing: lc.letterSpacing, textTransform: lc.textTransform, fontWeight: lc.fontWeight, textAlign: lc.textAlign, marginBottom: '0px', ownFace: ownFaceOf(lc) }; }
    // Stat cell text-align (source hero stats are centered) → counter + label centre to match (PHP parity).
    const wta = getComputedStyle(wrap).textAlign;
    const align = (wta === 'center' || wta === 'right') ? wta : '';
    return {
      number, start: '0', prefix, suffix, decimals, label, align,
      numberColor: toHexColor(ncs.color), suffixColor: toHexColor(hcs.color),
      numberSize: String(parseInt(ncs.fontSize, 10) || ''), numberWeight: String(parseInt(ncs.fontWeight, 10) || ''), numberFamily, labelStyle, labelFirst,
      prefixSize: String(parseInt(ncs.fontSize, 10) || ''),
      suffixSize: String(parseInt(hcs.fontSize, 10) || ''), suffixWeight: String(parseInt(hcs.fontWeight, 10) || ''),
    };
  };
  // A BENTO grid → a stack of rows. A 12-track grid whose items span 8 / 4 tracks across several visual rows was built as
  // ONE even row (six slivers). The cells' measured desktop widths are already their fractions (colFrac); group the cells by
  // their measured top into rows, each row's cells keeping their own width and the tile's measured height as min-height.
  // A single row (uniform or not) is left as built. PHP: bento_split.
  const bentoRowsOf = (el, rowBlk) => {
    try {
      const kids = rowKids(el); const cols = rowBlk.cols || [];
      if (getComputedStyle(el).display !== 'grid' || kids.length !== cols.length || cols.length < 2) return rowBlk;
      const tops = kids.map((k) => k.getBoundingClientRect().top), hs = kids.map((k) => k.getBoundingClientRect().height);
      // rows by VERTICAL OVERLAP, not by top: an items-center grid offsets a shorter cell's top (PHP: bento_split)
      const groups = [];
      tops.forEach((t, i) => { const g = groups.find((x) => Math.abs(x.y - t) <= 6 || (hs[i] > 0 && x.h > 0 && (Math.min(x.y + x.h, t + hs[i]) - Math.max(x.y, t)) >= 0.5 * Math.min(x.h, hs[i]))); if (g) { g.i.push(i); g.y = Math.min(g.y, t); g.h = Math.max(g.h, hs[i]); } else groups.push({ y: t, h: hs[i], i: [i] }); });
      if (groups.length < 2) return rowBlk;
      groups.sort((a, b) => a.y - b.y);
      const W12B = { 12: '1_1', 9: '3_4', 8: '2_3', 6: '1_2', 4: '1_3', 3: '1_4', 2: '1_6' };
      const w12 = (n) => W12B[n] || (n >= 11 ? '1_1' : n >= 7 ? '2_3' : n >= 5 ? '1_2' : n >= 4 ? '1_3' : n >= 3 ? '1_4' : '1_6');
      // A ROW-SPANNING tile (a row-span-2 scan panel beside two small cards over a wide one) overlaps cells that start
      // on DIFFERENT rows, so the y grouping would fold everything into one row. Split by X instead: the spanner's
      // column | the rest as their own stack of rows (widths re-measured inside that column). PHP: bento_split.
      if (kids.length >= 3) {
        const lefts = kids.map((k) => k.getBoundingClientRect().left), ws = kids.map((k) => k.getBoundingClientRect().width);
        const gridW = el.getBoundingClientRect().width || 1;
        let spanI = -1;
        for (let i = 0; i < kids.length && spanI < 0; i++) { if (!(hs[i] > 0)) continue; const below = kids.filter((_, j) => j !== i && tops[j] > tops[i] + 8 && tops[j] < tops[i] + hs[i] - 8).length; if (below > 0) spanI = i; }
        const distinctTops = new Set(tops.map((t) => Math.round(t / 8))).size;
        if (spanI >= 0 && distinctTops >= 2) {
          const sx0 = lefts[spanI], sx1 = sx0 + ws[spanI];
          const inn = [], rest = [];
          kids.forEach((_, i) => { const cx0 = lefts[i], cx1 = cx0 + ws[i]; const ov = Math.min(sx1, cx1) - Math.max(sx0, cx0); (ov > 0.5 * Math.min(sx1 - sx0, cx1 - cx0) ? inn : rest).push(i); });
          if (inn.length >= 1 && rest.length >= 1) {
            const mk = (i) => { const c = { ...cols[i] }; const h = hs[i]; if (!(c.minH > 0) && h >= 120) c.minH = Math.round(h); if (c.cw > 0) c.width = w12(c.cw); return c; };
            const spanCw = Math.max(1, Math.min(12, Math.round(ws[spanI] / gridW * 12))); const restW = Math.max(0.05, 1 - ws[spanI] / gridW);
            const rg = [];
            rest.forEach((i) => { const g = rg.find((x) => Math.abs(x.y - tops[i]) <= 8); if (g) g.i.push(i); else rg.push({ y: tops[i], i: [i] }); });
            rg.sort((a, b) => a.y - b.y);
            const rrows = rg.map((g) => ({ ...rowBlk, cols: g.i.map((i) => { const c = mk(i); c.cw = Math.max(1, Math.min(12, Math.round(ws[i] / gridW / restW * 12))); c.width = w12(c.cw); return c; }), nowrap: true, mt: 0, mb: 0 }));
            const restBlk = rrows.length === 1 ? rrows[0] : { t: 'stack', gap: (rowBlk.gap || 0) + 'px', mt: 0, mb: 0, items: rrows, bento: true };
            const spanCells = inn.map(mk);
            const leftCol = spanCells.length === 1 ? spanCells[0] : { cls: '', blocks: [{ t: 'stack', gap: (rowBlk.gap || 0) + 'px', mt: 0, mb: 0, items: spanCells.map((c) => ({ ...rowBlk, cols: [c], nowrap: true, mt: 0, mb: 0 })), bento: true }] };
            leftCol.cw = spanCw; leftCol.width = w12(spanCw);
            const rightCol = { cls: '', cw: Math.max(1, 12 - spanCw), width: w12(Math.max(1, 12 - spanCw)), blocks: [restBlk] };
            const spanFirst = lefts[spanI] <= Math.min(...rest.map((i) => lefts[i]));
            return { ...rowBlk, cols: spanFirst ? [leftCol, rightCol] : [rightCol, leftCol], nowrap: true };
          }
        }
      }
      const rows = groups.map((g) => { const r = { ...rowBlk, cols: g.i.map((i) => { const c = { ...cols[i] }; const h = kids[i].getBoundingClientRect().height; if (!(c.minH > 0) && h >= 120) c.minH = Math.round(h); if (c.cw > 0 && W12B[c.cw]) c.width = W12B[c.cw]; return c; }), nowrap: true, mt: 0, mb: 0 }; return r; });
      return { t: 'stack', gap: (rowBlk.gap || 0) + 'px', mt: rowBlk.mt || 0, mb: rowBlk.mb || 0, items: rows, bento: true };
    } catch { return rowBlk; }
  };
  // A PHOTO CELL painted with CSS (`bg-cover bg-center` + a url, no <img>, no text, ≥ 120px tall) → a cover media image. PHP: bg_photo_url / bg_photo_block.
  const bgPhotoOf = (el) => {
    try {
      if (txt(el).trim() !== '' || el.querySelector('img,video,iframe,picture,canvas')) return null;
      const cs = getComputedStyle(el); const m = String(cs.backgroundImage || '').match(/url\(\s*["']?([^"')\s]+)["']?\s*\)/i);
      if (!m || /^data:/i.test(m[1]) || /\.svg(?:$|\?)/i.test(m[1]) || /gradient\(/i.test(cs.backgroundImage)) return null;
      const h = parseFloat(cs.height) || parseFloat(cs.minHeight) || 0; if (h < 120) return null;
      const pos = /^[a-z0-9.%\s-]+$/i.test(cs.backgroundPosition || '') ? cs.backgroundPosition : 'center';
      return { src: abs(m[1]), alt: '', bgPhoto: { h: Math.round(h), pos } };
    } catch { return null; }
  };
  // The floating BADGE over a card's photo (a date chip pinned bottom-left over the image): the img's frame holding a small
  // absolute skinned child with text. Returns the frame or null. PHP: card_photo_badge.
  const cardPhotoBadgeOf = (card) => {
    try {
      const imgs = card.querySelectorAll('img'); if (imgs.length !== 1) return null;
      for (let fr = imgs[0].parentElement, i = 0; fr && fr !== card && i < 3; fr = fr.parentElement, i++) {
        const ov = compositeOverlays(fr); if (!ov.cards.length) continue;
        for (const c of ov.cards) {
          const ccs = getComputedStyle(c);
          if (/\binset-0\b/.test(String(c.className || '')) || (parseFloat(ccs.height) || 0) >= 160) continue;
          if (txt(c).trim().length <= 40) return fr;
        }
      }
    } catch { /* detached */ }
    return null;
  };
  // A card BODY's blocks: each child walked on its own; a flex ROW child of ≥ 2 blocks stays a content-sized row with its justify
  // (the `time | link` meta row). PHP: body_stack_blocks.
  const bodyStackBlocks = (body) => {
    const out = []; const kids = rowKids(body); const bcs = getComputedStyle(body);
    const bodyRow = (bcs.display === 'flex' || bcs.display === 'inline-flex') && !/^column/.test(bcs.flexDirection || '');
    if (!kids.length || bodyRow) { const hb = []; decompose(body, hb); return hb.filter((b) => b && b.t); }
    for (const kid of kids) {
      const kcs = getComputedStyle(kid);
      if (kcs.position === 'absolute' || kcs.position === 'fixed') continue;
      if (txt(kid).trim() === '' && !kid.querySelector('img,svg,video')) continue;
      let hb = []; decompose(kid, hb); hb = hb.filter((b) => b && b.t);
      if (!hb.length) { const t = txt(kid).trim(); if (t) hb = [textLeafBlock(kid, kid.tagName, String(kid.className || '').trim())]; else continue; }
      if (hb.length >= 2 && (kcs.display === 'flex' || kcs.display === 'inline-flex') && !/^column/.test(kcs.flexDirection || '') && rowKids(kid).length === hb.length) {
        const jc = kcs.justifyContent; const row = { t: 'row', role: 'columns', valign: /flex-end|end/.test(kcs.alignItems) ? 'end' : (/center/.test(kcs.alignItems) ? 'center' : ''), gap: parseFloat(kcs.columnGap) || 0, mt: Math.round(parseFloat(kcs.marginTop) || 0), mb: Math.round(parseFloat(kcs.marginBottom) || 0), nowrap: true, cols: hb.map((b) => { if (b.t === 'text') b.contentSized = true; return { cls: '', blocks: [b] }; }) };
        if (/^(space-between|space-around|space-evenly|center|flex-end|end)$/.test(jc)) row.justify = jc;
        out.push(row);
      } else { for (const b of hb) out.push(b); }
    }
    return out;
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
      if (isPaintedPanel(c)) cell.paint = panelPaintOf(c); // the gradient 'visual' half of a band → an empty painted cell
      // a CSS-painted PHOTO cell (`bg-cover` + a url) → a cover media image at the cell's box (it read as empty). PHP: bg_photo_block.
      if (!cell.paint) { const bp = bgPhotoOf(c); if (bp) cell.image = bp; }
      // a card whose PHOTO carries a floating BADGE: the image box has no layer for the chip — the cell decomposes into the photo
      // composite in a RELATIVE frame + the body's leaves in a padded stack. PHP: card_photo_badge in grid_cols.
      { const bfr = (!cell.image && !cell.paint) ? cardPhotoBadgeOf(c) : null;
        if (bfr) {
          const comp = imgCompositeOf(bfr); const blocks = [];
          if (comp && comp.image) {
            const items = [{ t: 'image', ...comp.image, blob: comp.blob || null }]; for (const fc of (comp.cards || [])) items.push({ t: 'floating_card', card: fc });
            const fh = parseFloat(getComputedStyle(bfr).height) || 0;
            const frame = { t: 'stack', gap: '0px', mt: 0, mb: 0, items, rel: true }; if (fh >= 80) frame.frameH = Math.round(fh);
            blocks.push(frame);
          }
          for (const kid of rowKids(c)) {
            if (kid === bfr || kid.contains(bfr)) continue;
            const kcs = getComputedStyle(kid); if (kcs.position === 'absolute' || kcs.position === 'fixed') continue;
            if (txt(kid).trim() === '' && !kid.querySelector('img,svg,video')) continue;
            const hb = bodyStackBlocks(kid); if (!hb.length) continue;
            const kp = { top: Math.round(parseFloat(kcs.paddingTop) || 0), right: Math.round(parseFloat(kcs.paddingRight) || 0), bottom: Math.round(parseFloat(kcs.paddingBottom) || 0), left: Math.round(parseFloat(kcs.paddingLeft) || 0) };
            const hasPad = kp.top > 0 || kp.right > 0 || kp.bottom > 0 || kp.left > 0;
            if (hasPad || hb.length >= 2) {
              const st = { t: 'stack', gap: (parseFloat(kcs.rowGap) || 0) + 'px', mt: 0, mb: 0, items: hb };
              if (hasPad) st.padPx = kp;
              if (/space-between/.test(kcs.justifyContent || '') && /^column/.test(kcs.flexDirection || '')) st.grow = true;
              blocks.push(st);
            } else blocks.push(hb[0]);
          }
          if (blocks.length >= 2) { cell.blocks = blocks; const own = boxSkinOf(c); if (own) cell.cardBox = own; }
        } }
      // The cell ITSELF may be a content-row shape: a tag / chip row, a single-track stack (of glass stat cards), or a bare
      // text leaf (a footer's brand line). Walking its children would split it into strays — claim it whole. PHP:
      // claim_element / the text-leaf cell in layout_cols.
      if (!c.querySelector('img,video,picture,iframe,svg,canvas') && txt(c) !== '') {
        if (chipRowOf(c)) cell.blocks = [chipsBlockOf(c)];
        else if (stackOf(c)) { const st = stackOf(c); const inner = []; decompose(c, inner); if (inner.length >= 2) cell.blocks = [{ t: 'stack', gap: st.gap + 'px', mt: st.mt, mb: st.mb, items: inner }]; }
        else if (!c.children.length) cell.blocks = [textLeafBlock(c, c.tagName, String(c.className || '').trim())];
        else if (isRow(c)) { const tmp = []; decompose(c, tmp, '', true); const rb = tmp.find((b) => b && b.t === 'row'); if (rb) cell.blocks = [rb]; } // a cell that IS a row (a strip card's .95/1.05 grid)
        // …or a CONTENT cell (a heading / real prose / a skinned panel of labels + bars): decomposed into blocks like the
        // single-column path does, instead of a verbatim html cell that drags the whole hero to verbatim. PHP: cell_is_decomposable.
        else if (!cell.blocks && (c.querySelector('h1,h2,h3,h4,h5,h6') || [...c.querySelectorAll('p')].some((pp) => txt(pp).length >= 20) || (boxSkinOf(c) && txt(c).length >= 12))) { const inner = []; decompose(c, inner); const real = inner.filter((b) => b && b.t); if (real.length && real.some((b) => b.t !== 'html')) cell.blocks = real; }
      }
      // A LONE-VIDEO cell (the video half of a two-column hero: one self-hosted <video>, no heading / prose / image) → the
      // native media_video carrying the clip's shell shape — not a verbatim cell that keeps the hero verbatim. PHP: cell_is_lone_video.
      if (!cell.blocks && !c.querySelector('img,picture,iframe,h1,h2,h3,h4,h5,h6') && c.querySelectorAll('video').length === 1 && ![...c.querySelectorAll('p')].some((pp) => txt(pp).length >= 20)) { const vb = videoBlockOf(c.querySelector('video')); if (vb && !vb.bg) cell.blocks = [vb]; }
      // The cell is itself a single-track STACK with a gap → the gap rides as the column's content gap. PHP: stack_gap.
      { const scs = getComputedStyle(c); if (scs.display === 'grid' && String(scs.gridTemplateColumns || '').trim().split(/\s+/).filter((x) => x && x !== 'none').length === 1) { const sg = parseFloat((scs.rowGap && scs.rowGap !== 'normal') ? scs.rowGap : scs.gap) || 0; if (sg > 0) cell.stackGap = sg; } }
      // The cell's EXACT grid track (px) — an unequal split (`1.08fr .92fr`) rounds to 6/6 in the 12-span
      // model; the mapper renders unequal tracks as a native Grid with the ratio. Plus a fixed min-height (a
      // 640px card) — PHP twin: Stitch::grid_px_tracks / cell_geometry.
      { const tw = c.getBoundingClientRect().width; if (tw > 0) cell.track = Math.round(tw * 10) / 10;
        const ccs0 = getComputedStyle(c); const mh = parseFloat(ccs0.minHeight); if (/px$/.test(ccs0.minHeight || '') && mh >= 120) { cell.minH = Math.round(mh); const smh = smOf(c)['min-height']; if (smh !== undefined) { const v = parseFloat(smh); cell.minHSm = (/px$/.test(smh) && v >= 120) ? Math.round(v) : 0; } const mdh = mdOf(c)['min-height']; if (mdh !== undefined) { const v = parseFloat(mdh); cell.minHMd = (/px$/.test(mdh) && v >= 120) ? Math.round(v) : 0; } } } // + the phone / tablet minimums (PHP: minh_sm / minh_md)
      // A DECORATIVE pseudo-layer on the cell (a blurred corner glow, `.card::before`): non-covering, absolute,
      // painted (gradient / colour), text-free. Geometry as % of the cell box so it scales with the card. PHP twin:
      // the capture.mjs data-sc-decor-pseudo stamp → Stitch::parse_decor_pseudo → Mapper::decor_pseudo_css.
      // The cell's OWN box skin (a rounded fill / gradient / border on the cell element itself) — every cell, not
      // only an image tile, so a plain heading+text card keeps its box (PHP: own_card = read_card_skin(cell)).
      if (!cell.cardBox) { const own = boxSkinOf(c); if (own) cell.cardBox = own; }
      // a FIXED SMALL BOX cell (a 52px `rounded-full` numeral disc): the box's size rides the column's inner wrapper, not the
      // track; the cell that IS the text leaf strips its copy of the skin and a one-line leaf stays one line. PHP: layout_cols fixedBox / nowrapText.
      if (cell.cardBox && cell.blocks && cell.blocks.length === 1 && cell.blocks[0].t === 'text' && !c.children.length) {
        const r = c.getBoundingClientRect(); const ccs1 = getComputedStyle(c); const tx = txt(c).trim();
        const isRound = /50%|9999px/.test(ccs1.borderRadius || '') || (parseFloat(ccs1.borderTopLeftRadius) || 0) >= r.height / 2;
        let fw = r.width, fh = r.height; if (isRound && fh > 0) fw = Math.min(fw, fh);
        if (tx.length <= 4 && fw >= 20 && fw <= 96 && fh >= 20 && fh <= 96) cell.fixedBox = { w: Math.round(fw), h: Math.round(fh) };
        { const tb = cell.blocks[0]; tb.bg = ''; tb.bgImage = ''; tb.border = ''; tb.borderRadius = ''; tb.boxShadow = ''; tb.padding = ''; } // the column wears the skin — the leaf's copy would paint it again
        const lh = parseFloat(ccs1.lineHeight) || 0, pt = parseFloat(ccs1.paddingTop) || 0;
        if (lh > 0 && r.height > 0 && r.height - 2 * pt < 1.6 * lh && tx.length <= 24) cell.nowrapText = true;
      }
      // The cell's own placement: order → native Order, align-self → native Align Self, min-width / sticky → scoped CSS. PHP: cell_geometry.
      { let ccs; try { ccs = getComputedStyle(c); } catch { ccs = null; } if (ccs) {
        const ord = String(ccs.order || '').trim(); if (/^-?\d+$/.test(ord) && ord !== '0') cell.order = parseInt(ord, 10);
        const asm = { 'flex-start': 'start', start: 'start', 'self-start': 'start', center: 'center', 'flex-end': 'end', end: 'end', 'self-end': 'end', stretch: 'stretch', baseline: 'baseline' };
        if (asm[String(ccs.alignSelf || '').trim()]) cell.alignSelf = asm[String(ccs.alignSelf).trim()];
        const cc2 = []; const mw = String(ccs.minWidth || '').trim(); if (/^[0-9.]+(?:px|%|rem|em|vw|ch)$/.test(mw) && mw !== '0px') cc2.push('min-width:' + mw);
        if (ccs.position === 'sticky') { cc2.push('position:sticky'); if (/^-?[0-9.]+px$/.test(ccs.top)) cc2.push('top:' + ccs.top); cc2.push('align-self:flex-start'); }
        if (cc2.length) cell.cellCss = cc2.join(';');
        { let ccs; try { ccs = getComputedStyle(c); } catch { ccs = null; } if (ccs) { const mt = parseFloat(ccs.marginTop) || 0, mb = parseFloat(ccs.marginBottom) || 0; if (mt > 0) cell.mt = Math.round(mt); if (mb > 0) cell.mb = Math.round(mb); } } // the cell's own vertical margin (PHP: cell_geometry mt / mb)
        if (smOf(c).display === 'none') cell.hideSm = true; // PHONE PASS: the cell is hidden on phones (PHP: hide_sm)
        { const _rv = revealOf(c); if (_rv) cell.reveal = _rv; }
        { const _la = loopAnimOf(c); if (_la) cell.loopAnim = _la; } // the cell's own running animation (a drifting shell) // the cell's own CSS-class reveal (a staggered card) → the column's Scroll Motion (PHP: cell_geometry reveal)
        { const fm = parseFloat(mdOf(c)['track-frac']), fs = parseFloat(smOf(c)['track-frac']); if (fm > 0 && fm <= 1.001) cell.fracMd = Math.min(1, fm); if (fs > 0 && fs <= 1.001) cell.fracSm = Math.min(1, fs); } // the cell's measured tablet / phone fraction (PHP: cell_geometry frac)
        // …and per tier: display at 1440 / 820 / 390 (the diffs inherit the desktop value) → a md:hidden phone-only card
        // hides on tablets + desktops, a lg:hidden on desktops only (PHP: cell_geometry hide).
        { let lgNone = false; try { lgNone = getComputedStyle(c).display === 'none'; } catch { /* detached */ }
          const at = (m) => (m.display ? m.display === 'none' : lgNone); const mdNone = at(mdOf(c)), smNone = at(smOf(c));
          // the theme's tiers: hide-xs < 768 (the 390 pass), hide-sm 768-991 (the 820 pass), hide-md >= 992 (the 1440 pass) — the old
          // keys sat one tier off (hide-md = the tablet pass), so a `hidden lg:block` desktop panel vanished on desktop. PHP: cell_geometry.
          if (lgNone || mdNone || smNone) cell.hide = { 'hide-xs': smNone, 'hide-sm': mdNone, 'hide-md': lgNone }; }
      } }
      cell.decorPseudo = (() => {
        const er = c.getBoundingClientRect(); if (er.width < 120 || er.height < 60) return null;
        for (const pe of ['::before', '::after']) {
          let ps; try { ps = getComputedStyle(c, pe); } catch { continue; }
          if (!ps || ps.content === 'none' || ps.content === 'normal' || ps.display === 'none' || ps.position !== 'absolute') continue;
          const w = parseFloat(ps.width), h = parseFloat(ps.height);
          if (!(w >= 24 && h >= 24) || (w >= er.width * 0.9 && h >= er.height * 0.9)) continue;
          const bgi = ps.backgroundImage || 'none', bgc = ps.backgroundColor || '';
          const painted = (bgi !== 'none' && /gradient\(/i.test(bgi) && !/url\(/i.test(bgi) && bgi.length <= 1200) || (/^rgba?\(/i.test(bgc) && !/,\s*0\s*\)$/.test(bgc));
          if (!painted) continue;
          const pct = (px, base) => (Math.round((parseFloat(px) / base) * 1000) / 10) + '%';
          const d = { pe: pe.slice(2), width: pct(w, er.width), height: pct(h, er.height), background: bgi !== 'none' ? bgi : bgc };
          if (Math.abs(parseFloat(ps.top)) <= Math.abs(parseFloat(ps.bottom))) d.top = pct(ps.top, er.height); else d.bottom = pct(ps.bottom, er.height);
          if (Math.abs(parseFloat(ps.left)) <= Math.abs(parseFloat(ps.right))) d.left = pct(ps.left, er.width); else d.right = pct(ps.right, er.width);
          if (ps.filter && ps.filter !== 'none') d.filter = ps.filter;
          const op = Math.min(1, parseFloat(ps.opacity) || 1); if (op < 1) d.opacity = String(op);
          if (ps.borderRadius && ps.borderRadius !== '0px') d.radius = ps.borderRadius;
          return d;
        }
        return (decorPseudosOf(c).find((d) => d.sweep) || null); // a moving sweep layer on the cell (larger than its box)
      })();
      // The cell's OWN flex layout → so the column can replay it via native content_direction / gap
      // (a flex-ROW cell lays its children side-by-side; a stacked column is the default). Captured
      // for every flex cell; the mapper only acts on `row` (+ the gap).
      const ccs = getComputedStyle(c);
      if ((ccs.display === 'flex' || ccs.display === 'inline-flex') && [...c.children].filter((k) => visibleEl(k)).length >= 2) {
        cell.flex = { dir: ccs.flexDirection, justify: ccs.justifyContent, align: ccs.alignItems, gap: ccs.columnGap || ccs.gap };
      }
      // The cell's OWN capped max-width (source `max-w-2xl` / `max-w-[620px]` / inline) → the column's
      // content measure. Without it a hero TEXT column fills the full 50% grid track and its paragraph
      // wraps in fewer lines than the source (which clamps the text to e.g. 42rem), shifting content
      // below. Only when a max-w-* utility (or inline max-width) is present; computed → a clean px cap.
      // Parity with the PHP Stitch element_max_width carry. (Fidelity fix.)
      {
        const ccls = String(c.className || '');
        const inlineMw = (c.getAttribute && (c.getAttribute('style') || '')) || '';
        if ((/(?:^|\s)max-w-(?:\[[^\]]+\]|[a-z0-9]+)/.test(ccls) || /max-width\s*:/.test(inlineMw)) && ccs.maxWidth && ccs.maxWidth !== 'none' && /^[0-9.]+px$/.test(ccs.maxWidth)) {
          cell.maxw = ccs.maxWidth;
        }
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
          // A card that WRAPS a nested icon-text/feature list (icon + heading + description, THEN a grid of
          // icon+text rows — e.g. a "Loan Types" card) must NOT collapse into one icon_box (dropping the
          // list). Decompose into an icon_box HEADER block + a feature_list block; the box then lands on the
          // COLUMN (2+ shortcodes). Parity with PHP grid_cols() cell_wraps_icon_text_list decomposition.
          const _flEl = cellWrapsIconTextList(c);
          if (_flEl) {
            const _flBlock = iconTextListBlockOf(_flEl);
            if (_flBlock) {
              const _p = _flEl.parentNode, _n = _flEl.nextSibling;
              if (_p) _p.removeChild(_flEl);                     // hide the list so the header card excludes its text
              const _hdr = cardOf(c);
              if (_p) _p.insertBefore(_flEl, _n);                // restore
              if (_hdr) { cell.cardBox = _hdr.box || null; _hdr.box = null; cell.blocks = [{ t: 'card', card: _hdr }, _flBlock]; } // box → the COLUMN, not the header icon_box
            }
          }
          if (!cell.blocks) cell.card = cardOf(c);               // single icon card
          if (!cell.card && !cell.blocks) {
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
              // IMAGE CARD (img + heading/text in normal flow — a service / blog / gallery card whose
              // "icon" is a photo, not a glyph, so cardOf's icon requirement misses it). DECOMPOSE into
              // native media_image + heading + text so the photo survives as a SWAPPABLE image input and
              // the copy stays editable — instead of textBlockOf collapsing it to text and DROPPING the
              // image. In a uniform grid this yields a row of editable image cards (the repeater the user
              // expects). The absolute-overlay composite case is handled separately below (text-in-overlay,
              // so flowHeading/flowPara are false there and this branch doesn't fire).
              if (!cell.blocks && img && (flowHeading || flowPara)) {
                const inner = []; decompose(c, inner);
                const real = inner.filter((x) => x.t !== 'html');
                if (real.length >= 2 && real.some((x) => x.t === 'image')) { cell.blocks = inner; }
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
                    // A framed photo TILE — the cell itself is a card (radius / fill / gradient / border / shadow)
                    // and the image fills it (object-fit cover, or as tall as its frame within 4px) → the cell's
                    // own box rides as its Box Preset (clipping to the radius) and the image is emitted in FILL
                    // mode. PHP twin: Stitch cell_is_lone_image / image_fills_cell / read_card_skin($cell).
                    {
                      const ccs = getComputedStyle(c);
                      const okc = (v) => v && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent';
                      const grad = /linear-gradient\(/i.test(ccs.backgroundImage || '') && !/url\(/i.test(ccs.backgroundImage) ? ccs.backgroundImage : '';
                      const radius = (parseFloat(ccs.borderTopLeftRadius) || 0) > 0 ? ccs.borderTopLeftRadius : '';
                      const bw = (parseFloat(ccs.borderTopWidth) || 0) > 0 && ccs.borderTopStyle !== 'none' ? ccs.borderTopWidth : '';
                      if (radius && (okc(ccs.backgroundColor) || grad || bw)) {
                        cell.cardBox = {
                          bg: okc(ccs.backgroundColor) ? ccs.backgroundColor : '', fill: okc(ccs.backgroundColor) ? ccs.backgroundColor : '', gradient: grad,
                          radius, borderWidth: bw, borderStyle: bw ? ccs.borderTopStyle : '', borderColor: bw && okc(ccs.borderTopColor) ? ccs.borderTopColor : '',
                          shadow: (ccs.boxShadow && ccs.boxShadow !== 'none') ? ccs.boxShadow : '',
                          backdrop: (ccs.backdropFilter && ccs.backdropFilter !== 'none') ? ccs.backdropFilter : '',
                          padding: (parseFloat(ccs.paddingTop) || 0) > 0 ? ccs.padding : '',
                          clip: true, // a rounded frame around media clips (source overflow:hidden)
                        };
                        const ics = getComputedStyle(img);
                        { const ix = imgExtraOf(img); if (ix) cell.image.extra = ix; } // the image's own filter / object-position / aspect-ratio (PHP: img_extra_css)
                        const ch = c.getBoundingClientRect().height, ih = img.getBoundingClientRect().height;
                        if (ics.objectFit === 'cover' || /\bobject-cover\b/.test(img.className || '') || (ch >= 120 && Math.abs(ih - ch) <= 4)) cell.image.fill = true;
                      }
                    }
                  } else {
                    // Image + a content-bearing overlay (a floating badge / blob) → DECOMPOSE into native
                    // parts { image, cards[], blob } (P0 fidelity fix) so to-pages emits a media_image +
                    // icon_box(es) instead of one verbatim code_block. `imgComposite` stays truthy either
                    // way, so the clean-hero gate still lets the REST of the section decompose; a shape we
                    // can't cleanly tear apart (imgCompositeOf → null) falls back to verbatim (=== true).
                    cell.imgComposite = imgCompositeOf(c) || true;
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
    }).filter((c) => c.html.trim() || c.image || c.paint); // an empty cell is dropped — a CSS-painted photo / a painted panel is content
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
    // EXTRA TEXTS — a bordered footer row (border-t) holding a stat/result (a muted label + emphasized
    // value, e.g. "Total savings" → "$14,200", or a lone "40% more closes") → { label, value }[]. Prefers
    // two distinct leaf texts; else splits a single "Label $Figure" string on the figure. Parity with PHP
    // testimonial_extra(). Empty when the card has no footer stat.
    let extra = [];
    const foot = [...b.children].find((e) => /(?:^|\s)border-t/.test(e.className || '') || /border-top/.test(e.className || ''));
    if (foot) {
      const parts = [];
      for (const e of foot.querySelectorAll('p,span,div,strong,b,dt,dd')) {
        if (e.children.length > 0) continue; // leaf only
        const t = txt(e).replace(/\s+/g, ' ').trim();
        if (t && t !== quote && t.length <= 60 && !parts.includes(t)) parts.push(t);
      }
      if (parts.length >= 2) {
        extra = [{ label: parts[0], value: parts[1] }];
      } else {
        const ft = txt(foot).replace(/\s+/g, ' ').trim();
        if (ft && ft !== quote && ft.length <= 60) {
          const m = ft.match(/^(.*?)\s*((?:[$€£]\s?[\d.,]+|\d[\d.,]*\s*%|\d[\d.,]+)\b.*)$/u);
          if (m && m[1].trim()) extra = [{ label: m[1].trim(), value: m[2].trim() }];
          else extra = [{ label: '', value: ft }];
        }
      }
    }
    return { quote, image, name, position, siteName, siteUrl, rating: ratingOf(b), extra };
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
    const vcls = (el.getAttribute('class') || '');
    // Does the video FILL its box (cover)? computed object-fit, object-cover class, or a w-full+h-full pair.
    const covers = vcs.objectFit === 'cover' || /\bobject-cover\b/.test(vcls)
      || (/\bw-full\b/.test(vcls) && /\bh-full\b/.test(vcls));
    // Positioned as a background layer — either the video ITSELF is absolute/fixed, or (the common pattern)
    // a cover-fill video INSIDE an `absolute/fixed inset-0` wrapper. Walk up to 4 ancestors reading computed
    // position + class, so `<div class="absolute inset-0"><video class="w-full h-full object-cover">` is
    // caught, not just `<video class="absolute inset-0 object-cover">`. Mirrors the PHP video recognizer.
    const selfAbs = vcs.position === 'absolute' || vcs.position === 'fixed';
    let ancAbs = false;
    for (let a = el.parentElement, d = 0; a && d < 4; a = a.parentElement, d++) {
      const acs = getComputedStyle(a), acls = ` ${a.getAttribute('class') || ''} `;
      const abs = acs.position === 'absolute' || acs.position === 'fixed'
        || / absolute /.test(acls) || / fixed /.test(acls);
      if (abs && (/inset-0/.test(acls) || acs.position === 'absolute' || acs.position === 'fixed')) { ancAbs = true; break; }
    }
    const bgVideo = covers && (selfAbs || ancAbs);
    // Aspect ratio from the video's own `aspect-[W/H]` class (a portrait reel is `aspect-[9/16]`), so the
    // media_video box matches instead of letterboxing a portrait clip in a forced 16:9 frame. PHP twin: the
    // stitch video recognizer's $vaspect.
    let vaspect = '';
    const am = vcls.match(/aspect-\[(\d+)\/(\d+)\]/);
    if (am) { const k = `${am[1]}x${am[2]}`; if (['16x9', '4x3', '1x1', '21x9', '9x16', '3x4'].includes(k)) vaspect = k; }
    // Responsive visibility: a source often ships a MOBILE `sm:hidden` reel beside a desktop one — carry the
    // video's own + wrapping-ancestor classes so the mapper can hide the mobile-only clip on desktop (else it
    // renders as a stray letterboxed box). PHP twin: rhideCls in the stitch video recognizer.
    let rcls = ` ${vcls}`;
    for (let a = el.parentElement, d = 0; a && d < 3; a = a.parentElement, d++) { rcls += ` ${a.getAttribute('class') || ''}`; }
    // The clip's SHELL (an organic-shell wrapper: radius / mask / filter / a shaped aspect + cap / a running animation) — read
    // from the video up its wrapper chain, carried as scoped CSS on the media_video (PHP: media_shape_css). Only a CONTENT clip.
    const shapeCss = (() => {
      if (bgVideo) return '';
      const d = []; let radius = '', mask = '', filter = '', clip = '', ar = '', cap = '', anim = null;
      for (let a = el, k = 0; a && a.tagName !== 'SECTION' && k < 4; a = a.parentElement, k++) {
        let cs; try { cs = getComputedStyle(a); } catch { break; }
        const cls = ' ' + String(a.className || '') + ' ';
        if (!radius && cs.borderRadius && !/^0(px|%)?(\s|$)/.test(cs.borderRadius.trim()) && cs.borderRadius !== '0px') radius = cs.borderRadius;
        if (!mask) { const mk = (cs.maskImage && cs.maskImage !== 'none') ? cs.maskImage : ((cs.webkitMaskImage && cs.webkitMaskImage !== 'none') ? cs.webkitMaskImage : ''); if (mk) mask = mk; }
        if (!filter && cs.filter && cs.filter !== 'none') filter = cs.filter;
        if (!clip && cs.clipPath && cs.clipPath !== 'none') clip = cs.clipPath;
        if (a !== el) {
          if (!ar) { const am2 = (cs.aspectRatio && cs.aspectRatio !== 'auto') ? cs.aspectRatio : ''; const cm = cls.match(/\saspect-\[([0-9.]+)(?:\/([0-9.]+))?\]/); if (am2) ar = am2; else if (cm) ar = cm[1] + (cm[2] ? ' / ' + cm[2] : ''); }
          if (!cap) { const mw = parseFloat(cs.maxWidth); if (/px$/.test(cs.maxWidth) && mw >= 200) cap = Math.round(mw) + 'px'; }
          if (!anim) anim = loopAnimOf(a);
        }
      }
      let arRule = '';
      if (ar) { const parts = ar.split('/').map((x) => parseFloat(x)); const w = parts[0] > 0 ? parts[0] : 1, h = parts[1] > 0 ? parts[1] : 1; arRule = 'selector.video-ratiobox[data-ratio],selector .video-ratiobox[data-ratio]{--vid-aspect:' + (Math.round(h / w * 10000) / 100) + '%;}'; d.push('width:100%', 'max-width:' + (cap || '100%') + ' !important'); }
      else if (cap) d.push('width:100%', 'max-width:' + cap + ' !important');
      if (radius) d.push('border-radius:' + radius, 'overflow:hidden');
      if (clip) d.push('clip-path:' + clip);
      if (mask) d.push('-webkit-mask-image:' + mask, 'mask-image:' + mask);
      if (filter) d.push('filter:' + filter);
      let out = d.length ? 'selector{' + d.join(';') + ';}' : '';
      out += arRule;
      if (anim) out += 'selector{' + anim.css + ';}' + (anim.kf ? '\n' + anim.kf : '');
      return out;
    })();
    return {
      t: 'video', mode: 'self_hosted', src: src ? abs(src) : '', webm: webm ? abs(webm) : '', poster: el.getAttribute('poster') ? abs(el.getAttribute('poster')) : '', // (an EMPTY attribute absolutized to the PAGE URL — which the importer then tried to sideload on every conversion)
      bg: bgVideo, aspect: vaspect, cover: covers, rhideCls: rcls, shapeCss,
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
    let eyebrow = /rounded-full|uppercase|eyebrow|kicker|overline|tracking/i.test(c) || t === t.toUpperCase();
    // FRAMEWORK-AGNOSTIC: the COMPUTED style says eyebrow — uppercase, tracked (>= 1px), small (<= 14px), a text
    // leaf, and NOT a boxed pill (a fill / border makes it a chip, owned by the boxed-text / chip-row rules).
    // A plain-CSS `.section-label` is the same kicker a Tailwind `uppercase tracking-[.3em]` is. PHP: is_pill.
    if (!eyebrow) {
      const ncs = getComputedStyle(node);
      eyebrow = ncs.textTransform === 'uppercase' && (parseFloat(ncs.letterSpacing) || 0) >= 1 && (parseFloat(ncs.fontSize) || 99) <= 14
        && [...node.children].every((k) => ['SPAN', 'STRONG', 'B', 'EM', 'I', 'svg', 'SVG', 'BR'].includes(k.tagName))
        && !hasBg(ncs.backgroundColor) && !(parseFloat(ncs.borderTopWidth) > 0 && ncs.borderTopStyle !== 'none');
    }
    if (!eyebrow) return false;
    return [...parent.children].some((k) => /^H[1-6]$/.test(k.tagName) && (node.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING));
  };
  // ============================================================================================
  // Structured / interactive native-widget detectors — parity with the PHP Stitch `is_*` recognizers
  // (class-fw-site-converter-stitch.php: is_pricing_table / is_steps_flow / is_timeline /
  // is_progress_bars / is_tabs_widget / is_lottie_embed / is_svg_draw / is_accordion_group /
  // is_text_list, + table_block). Each is a TIGHT structural match (mirrors the PHP guard faithfully)
  // so it can never swallow a generic feature/card grid; the dispatcher offers them BEFORE the
  // SKIP/decor/row/text/dive branches, matching the PHP priorities that sit above card_grid.
  // ============================================================================================
  const cn = (el) => (el && el.getAttribute && el.getAttribute('class')) || ''; // robust for HTML + SVG
  const stripCs = (h) => String(h == null ? '' : h).replace(/\s+data-sc-[a-z-]+="[^"]*"/gi, '').trim();
  // Substantial (non-empty, non-decorative) direct element children (PHP widget_children).
  const wChildren = (el) => [...el.children].filter((k) => {
    const t = k.tagName.toLowerCase();
    if (['script', 'style', 'br', 'hr', 'template'].includes(t)) return false;
    return txt(k) !== '' || k.querySelector('img,svg');
  });
  // The item's title text (first heading / .title-ish / strong), PHP item_title_text.
  const wTitle = (el) => {
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) { const n = el.querySelector(h); if (n && txt(n)) return txt(n); }
    const c = [...el.querySelectorAll('*')].find((x) => /\b(title|name|heading|plan-?name|step-?title)\b/.test(cn(x).toLowerCase()) && txt(x));
    if (c) return txt(c);
    const s = el.querySelector('strong'); if (s && txt(s)) return txt(s);
    return '';
  };
  // The item's body text = first <p>, else full text minus a leading title (PHP item_body_text).
  const wBody = (el, title) => {
    const p = el.querySelector('p'); if (p && txt(p)) return txt(p);
    let all = txt(el);
    if (title && all.indexOf(title) === 0) all = all.slice(title.length).trim();
    return all;
  };

  // --- table (PHP table_block): a <table> with >=1 row → { rows:[[{html,header,align}…]…], caption, style } ---
  // The table's MEASURED skin (PHP table_style_evidence): the mode of every body / header cell's computed style is the
  // base a Table Preset owns; each cell carries only what DIFFERS from that base as its own inline style (tableCellHtml).
  const TBL_TEXT = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'lineHeight'];
  const TBL_PADS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
  const cssName = (k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  const inertZero = (v) => !v || v === '0px' || v === '0' || v === 'none' || v === 'transparent' || /rgba\(\d+, \d+, \d+, 0\)/.test(v);
  const tableEvidence = (el) => {
    const secOf = (tr) => { const pt = tr.parentElement ? tr.parentElement.tagName.toLowerCase() : ''; if (pt === 'thead') return 'head'; if (pt === 'tfoot') return 'foot'; return ''; };
    const head = [], body = [], foot = [];
    for (const tr of el.querySelectorAll('tr')) {
      const sec = secOf(tr);
      if (sec === 'head') { head.push(tr); continue; }
      if (sec === 'foot') { foot.push(tr); continue; }
      const cells = [...tr.children].filter((c) => /^t[dh]$/i.test(c.tagName));
      if (cells.length && cells.every((c) => c.tagName.toLowerCase() === 'th') && !body.length) head.push(tr); else body.push(tr);
    }
    const cellsOf = (trs) => trs.flatMap((tr) => [...tr.children].filter((c) => /^t[dh]$/i.test(c.tagName)));
    const hc = cellsOf(head), bc = cellsOf(body), fc = cellsOf(foot);
    // the MODE per prop (a prop at its default — normal tracking, no case, no fill — still votes, so four uppercase cells never out-vote sixteen plain ones)
    const mode = (cells, props) => {
      const votes = {}; for (const c of cells) { const cs = getComputedStyle(c); for (const pr of props) { let v = cs[pr] || ''; if ((pr === 'letterSpacing' && v === 'normal') || (pr === 'textTransform' && v === 'none') || (pr === 'backgroundColor' && inertZero(v))) v = ''; (votes[pr] = votes[pr] || {})[v] = (votes[pr][v] || 0) + 1; } }
      const out = {}; for (const pr of Object.keys(votes)) { const best = Object.entries(votes[pr]).sort((a, b) => b[1] - a[1])[0]; if (best && best[0] !== '') out[pr] = best[0]; } return out;
    };
    const td = mode(bc, [...TBL_TEXT, ...TBL_PADS, 'backgroundColor', 'textAlign']);
    const th = mode(hc, [...TBL_TEXT, ...TBL_PADS, 'backgroundColor', 'textAlign']);
    const tf = mode(fc, [...TBL_TEXT, ...TBL_PADS, 'backgroundColor']);
    // the body's TEXT base is what the cells INHERIT — the <tbody> (or first body row) — the cells' mode fills the rest
    const group = el.querySelector('tbody') || body[0];
    if (group) { const gcs = getComputedStyle(group); for (const pr of TBL_TEXT) { const v = gcs[pr] || ''; if (!v || (pr === 'letterSpacing' && v === 'normal') || (pr === 'textTransform' && v === 'none')) { if (pr === 'letterSpacing' || pr === 'textTransform') delete td[pr]; continue; } td[pr] = v; } }
    const rule = (e, edge) => { if (!e) return ''; const cs = getComputedStyle(e); const w = cs['border' + edge + 'Width'], st = cs['border' + edge + 'Style'], col = cs['border' + edge + 'Color']; if (inertZero(w) || !st || st === 'none' || st === 'hidden' || inertZero(col)) return ''; return w + '|' + st + '|' + col; };
    let hline = body.length >= 2 ? (rule(body[1], 'Top') || rule(body[1], 'Bottom')) : '';
    if (!hline && bc.length) hline = rule(bc[0], 'Bottom') || rule(bc[0], 'Top');
    const vline = bc.length ? (rule(bc[bc.length > 1 ? 1 : 0], 'Right') || rule(bc[bc.length > 1 ? 1 : 0], 'Left')) : '';
    const hdline = (head.length ? rule(head[0], 'Bottom') : '') || (hc.length ? rule(hc[0], 'Bottom') : '');
    const ftline = (foot.length ? rule(foot[0], 'Top') : '') || (fc.length ? rule(fc[0], 'Top') : '');
    // the frame: the table's own border / radius / shadow, else a wrapper holding ONLY the table
    const frameOf = (e) => { const cs = getComputedStyle(e); const f = {}; if (!inertZero(cs.borderTopWidth) && cs.borderTopWidth === cs.borderBottomWidth && cs.borderTopWidth === cs.borderLeftWidth) f.border = cs.borderTopWidth + ' ' + (cs.borderTopStyle || 'solid') + ' ' + cs.borderTopColor; if (!inertZero(cs.borderRadius)) f.radius = cs.borderRadius; if (cs.boxShadow && cs.boxShadow !== 'none') f.shadow = cs.boxShadow; return f; };
    let frame = frameOf(el);
    if (!Object.keys(frame).length && el.parentElement && el.parentElement.children.length === 1) { const pf = frameOf(el.parentElement); if (Object.keys(pf).length) frame = pf; }
    let hover = '';
    for (const n of [...body, ...bc]) { const h = n.getAttribute('data-sc-hover') || ''; const m = h.match(/hover-self\{([^}]*)\}/); if (m) { hover = m[1].trim(); break; } }
    const fills = body.map((tr) => { let bg = getComputedStyle(tr).backgroundColor; if (inertZero(bg) && tr.children[0]) bg = getComputedStyle(tr.children[0]).backgroundColor; return inertZero(bg) ? '' : bg; });
    const distinct = [...new Set(fills.filter(Boolean))];
    const capEl = el.querySelector('caption'); const capd = capEl ? (() => { const cs = getComputedStyle(capEl); return { color: cs.color, fontSize: cs.fontSize, fontStyle: cs.fontStyle }; })() : null;
    let transition = ''; if (body[0]) { const d = getComputedStyle(body[0]).transitionDuration || ''; const m = d.split(',')[0].trim().match(/^([0-9.]+)(m?s)$/); if (m) transition = String(Math.round(m[2] === 'ms' ? parseFloat(m[1]) : parseFloat(m[1]) * 1000)); }
    const px = (v) => (/^-?[0-9.]+px$/.test(v || '') ? v : '');
    const toCss = (o) => { const out = {}; for (const k of Object.keys(o)) out[cssName(k)] = o[k]; return out; };
    return {
      style: { td: toCss(td), th: toCss(th), tf: toCss(tf), hline, vline, hdline, ftline, frame, hover, stripe_bg: distinct.length >= 2 ? distinct[1] : '', row_bg: distinct[0] || (td.backgroundColor && !inertZero(td.backgroundColor) ? td.backgroundColor : ''), caption: capd ? { color: capd.color, 'font-size': px(capd.fontSize), 'font-style': capd.fontStyle } : {}, transition, has_head: hc.length > 0, has_foot: fc.length > 0 },
      tdBase: td, thBase: th,
    };
  };
  // colours as HEX (#rrggbb / #rrggbbaa): the cell is kses-sanitised, whose style filter drops rgb()/rgba() values
  const hexOf = (v) => String(v || '').replace(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)/gi, (m, r, g, b, a) => { const h = (x) => ('0' + Math.min(255, Math.round(parseFloat(x))).toString(16)).slice(-2); let out = '#' + h(r) + h(g) + h(b); if (a != null && a !== '' && parseFloat(a) < 1) out += h(parseFloat(a) * 255); return out; });
  const tableCellHtml = (c, base) => {
    const CELL = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform'];
    const INNER = ['backgroundColor', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'padding', 'border', 'borderRadius', 'display'];
    const inert = (pr, v) => { v = String(v || '').toLowerCase().trim(); if (!v || v === 'inherit' || v === 'initial') return true; if (pr === 'letterSpacing' && v === 'normal') return true; if (pr === 'textTransform' && v === 'none') return true; if (pr === 'backgroundColor' && inertZero(v)) return true; if (pr === 'borderRadius' && (v === '0px' || v === '0')) return true; if (pr === 'padding' && /^(0px\s*)+$/.test(v)) return true; if (pr === 'border' && (/^0px/.test(v) || /none/.test(v))) return true; if (pr === 'display' && !['inline-block', 'block', 'inline-flex', 'flex'].includes(v)) return true; return false; };
    const diff = (cs, ref, props) => { const out = {}; for (const pr of props) { const v = String(cs[pr] || '').trim(); if (inert(pr, v)) continue; if (ref && ref[pr] != null && String(ref[pr]).trim().toLowerCase() === v.toLowerCase()) continue; out[pr] = hexOf(v.replace(/"/g, "'")); } return out; };
    const clone = c.cloneNode(true);
    // pair each clone descendant with its original (same order) so the computed styles are read from the live DOM
    const orig = [...c.querySelectorAll('*')], copies = [...clone.querySelectorAll('*')];
    copies.forEach((n, i) => {
      const o = orig[i]; if (!o) return;
      const own = getComputedStyle(o), par = o.parentElement ? getComputedStyle(o.parentElement) : null;
      const d = diff(own, par, INNER);
      const painted = d.backgroundColor != null || d.border != null;
      if (!painted) { delete d.padding; delete d.display; delete d.borderRadius; } // (an inline chip keeps its inline display — its padding paints without growing the line)
      for (const a of [...n.attributes]) { if (a.name === 'class' || a.name === 'id' || a.name === 'style' || a.name.startsWith('data-sc-')) n.removeAttribute(a.name); }
      const st = Object.keys(d).map((k) => cssName(k) + ':' + d[k]).join(';'); if (st) n.setAttribute('style', st);
    });
    let html = clone.innerHTML.trim();
    if (!html) return '';
    const d = diff(getComputedStyle(c), base, CELL);
    const st = Object.keys(d).map((k) => cssName(k) + ':' + d[k]).join(';');
    if (st) html = '<span style="' + st.replace(/"/g, '&quot;') + '">' + html + '</span>';
    return html;
  };
  const tableCellAlign = (c) => { const ta = (getComputedStyle(c).textAlign || '').toLowerCase(); return ta === 'right' || ta === 'end' ? 'right' : ta === 'center' ? 'center' : ''; };
  const tableBlockOf = (el) => {
    const ev = tableEvidence(el);
    const rows = [];
    for (const tr of el.querySelectorAll('tr')) {
      const cells = [];
      for (const c of [...tr.children]) {
        const ct = c.tagName.toLowerCase();
        if (ct !== 'td' && ct !== 'th') continue;
        cells.push({ html: tableCellHtml(c, ct === 'th' ? ev.thBase : ev.tdBase), header: ct === 'th', align: tableCellAlign(c) });
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return null;
    const capEl = el.querySelector('caption');
    // Styling evidence (parity with PHP table_block $style) for the mapper's table-preset pick. NOTE:
    // the actual Table Preset SLUG is chosen PHP-side (Mapper::table_preset_for reads the WP Theme
    // Settings preset library), which the capture service can't see — we carry the evidence only.
    const th = el.querySelector('th');
    const hcs = th ? getComputedStyle(th) : null;
    const tcs = getComputedStyle(el);
    const bgs = new Set();
    for (const tr of el.querySelectorAll('tr')) {
      const b = getComputedStyle(tr).backgroundColor;
      if (b && b !== 'transparent' && !/,\s*0\)\s*$/.test(b)) bgs.add(b);
    }
    return { t: 'table', rows, caption: capEl ? txt(capEl) : '',
      style: { header_cs: hcs ? ('background-color:' + hcs.backgroundColor) : '', table_cs: 'border-color:' + tcs.borderTopColor, striped: bgs.size >= 2, ...ev.style } };
  };

  // --- accordion (PHP is_accordion_group): >=2 <details><summary> OR >=2 [aria-expanded] toggles ---
  const isAccordionGroup = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'details' || tag === 'summary') return false;
    let details = 0;
    for (const d of el.querySelectorAll('details')) if (d.querySelector('summary')) details++;
    if (details >= 2) return true;
    let toggles = 0;
    for (const t of el.querySelectorAll('[aria-expanded]')) if (txt(t)) toggles++;
    return toggles >= 2;
  };
  const accordionBlockOf = (el) => {
    const items = [];
    const dets = el.querySelectorAll('details');
    if (dets.length) {
      for (const d of dets) {
        const sum = d.querySelector('summary'); if (!sum) continue;
        const title = txt(sum);
        const clone = d.cloneNode(true);
        clone.querySelectorAll('summary').forEach((s) => s.remove());
        if (title) items.push({ title, content: stripCs(clone.innerHTML), open: d.hasAttribute('open') });
      }
    } else {
      const doc = el.ownerDocument;
      for (const tgl of el.querySelectorAll('[aria-expanded]')) {
        const title = txt(tgl); if (!title) continue;
        let panelHtml = '';
        const ctrl = (tgl.getAttribute('aria-controls') || '').trim();
        if (ctrl && doc) { const p = doc.getElementById(ctrl); if (p) panelHtml = stripCs(p.innerHTML); }
        if (!panelHtml) { const sib = tgl.nextElementSibling; if (sib) panelHtml = stripCs(sib.innerHTML); }
        items.push({ title, content: panelHtml, open: String(tgl.getAttribute('aria-expanded') || '').toLowerCase() === 'true' });
      }
    }
    // FAQ JSON-LD — recover answers a Radix/Headless accordion unmounts from closed panels, AND flag
    // `faq` when the page's schema.org/FAQPage structured data covers these questions, so the rebuilt
    // accordion re-emits the FAQ schema (native `faq_schema`). Parity with PHP accordion_block.
    let faqMatched = 0;
    const faq = faqJsonLdMap(el.ownerDocument);
    if (faq && Object.keys(faq).length) {
      for (const it of items) {
        const ans = faq[faqKey(it.title)];
        if (ans === undefined) continue;
        faqMatched++;
        if (!String(it.content || '').trim()) {
          it.content = /</.test(ans) ? ans : '<p>' + ans.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</p>';
        }
      }
    }
    if (items.length < 2) return null;
    const block = { t: 'accordion', items };
    const design = accordionDesign(el);
    if (design && Object.keys(design).length) block.design = design;
    // FAQ schema present when the structured data covers at least half the questions.
    if (faqMatched >= Math.max(1, Math.floor(items.length / 2))) block.faq = true;
    return block;
  };
  // A schema.org/FAQPage question→answer map from the document's JSON-LD (parity with PHP faq_jsonld_map).
  const faqKey = (s) => String(s || '').replace(/<[^>]*>/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const faqJsonLdMap = (doc) => {
    const map = {};
    if (!doc || !doc.querySelectorAll) return map;
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let data; try { data = JSON.parse((s.textContent || '').trim()); } catch (e) { continue; }
      const nodes = (data && Array.isArray(data['@graph'])) ? data['@graph'] : [data];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const t = node['@type'];
        const isFaq = (typeof t === 'string' && t.toLowerCase() === 'faqpage') || (Array.isArray(t) && t.includes('FAQPage'));
        if (!isFaq || !node.mainEntity) continue;
        let ents = Array.isArray(node.mainEntity) ? node.mainEntity : [node.mainEntity];
        for (const q of ents) {
          if (!q || typeof q !== 'object') continue;
          const name = String(q.name || '').trim();
          const ans = (q.acceptedAnswer && typeof q.acceptedAnswer === 'object') ? String(q.acceptedAnswer.text || '') : '';
          if (name && ans.trim()) map[faqKey(name)] = ans;
        }
      }
    }
    return map;
  };
  // Read the source accordion's visual design (parity with PHP accordion_design): style/icon/position/
  // alignment/radius/gap/elevation/title bg — best-effort, each key omitted when there's no clear signal.
  const accordionDesign = (el) => {
    const d = {};
    let items = [...el.querySelectorAll('details')];
    if (!items.length) {
      // Climb each toggle to the ancestor whose PARENT holds >=2 toggle-bearing children (the real accordion
      // TRACK), so an intermediate single wrapper (`max-w-3xl > space-y-4 > cards`) doesn't over-climb to the
      // bare track and miss each card's own classes — the "matched the outer wrapper → flush" bug. Parity w/ PHP.
      const hasToggle = (n) => !!(n && n.nodeType === 1 && (n.hasAttribute('aria-expanded') || n.querySelector('[aria-expanded]')));
      for (const t of el.querySelectorAll('[aria-expanded]')) {
        let w = t, found = null;
        while (w && w !== el) {
          const p = w.parentElement;
          if (!p) break;
          const sibs = [...p.children].filter(hasToggle).length;
          if (sibs >= 2 || p === el) { found = w; break; }
          w = p;
        }
        if (found && !items.includes(found)) items.push(found);
      }
    }
    if (!items.length) return d;
    const first = items[0];
    const pxv = (v) => parseFloat(v) || 0;
    // The real accordion TRACK = the items' shared parent — container-level reads come from here, not $el.
    const track = (first.parentElement || el);
    // Item card's + container's utility CLASSES — the style signal often lives ONLY in Tailwind classes, and
    // `space-y-N` sets margin-TOP (invisible to the computed gap / margin-bottom reads), so every measurement
    // below falls back to these. Without it a SEPARATED card list read as `flush`. Parity with PHP.
    const iCls = ' ' + (first.getAttribute('class') || '').toLowerCase() + ' ';
    const oCls = ' ' + (track.getAttribute('class') || '').toLowerCase() + ' ';
    const hasBgCls = /\sbg-(?!transparent|none)[a-z][a-z0-9/-]*/.test(iCls);
    const hasBdCls = /\sborder(?:-[trbl])?\b/.test(iCls) && !/\sborder-0\b|\sborder-none\b/.test(iCls);
    const radiusCls = /\srounded-(?:2xl|3xl|full)\b/.test(iCls) ? 20 : (/\srounded-xl\b/.test(iCls) ? 12 : (/\srounded-lg\b/.test(iCls) ? 8 : (/\srounded(?:-md|-sm)?\b/.test(iCls) ? 4 : 0)));
    let gm; const gapCls = (gm = oCls.match(/\s(?:space-y|gap(?:-y)?)-(\d+(?:\.\d+)?)\b/)) ? parseFloat(gm[1]) * 4 : ((gm = iCls.match(/\smb-(\d+(?:\.\d+)?)\b/)) ? parseFloat(gm[1]) * 4 : 0);
    const divideCls = /\sdivide-y\b/.test(oCls);
    let bar = first.tagName.toLowerCase() === 'details' ? first.querySelector('summary') : null;
    if (!bar) bar = first.querySelector('[aria-expanded]') || first;
    // icon
    let iconEl = null;
    for (const c of bar.querySelectorAll('*')) {
      const ct = c.tagName.toLowerCase(), cc = (c.getAttribute('class') || '');
      if (ct === 'svg' || ct === 'i' || c.hasAttribute('data-lucide') ||
        /\b(icon|chevron|arrow|plus|minus|caret|toggle|expand|indicator)\b/i.test(cc)) iconEl = c;
    }
    const barTxt = txt(bar);
    const probe = (iconEl ? (iconEl.getAttribute('class') || '') + ' ' + (iconEl.getAttribute('data-lucide') || '') + ' ' + (iconEl.getAttribute('icon') || '') + ' ' + iconEl.innerHTML : '') + ' ' + barTxt;
    if (iconEl || /[+−×›▶⌄▼▾˅]/u.test(barTxt)) {
      if (/chevron|caret|⌄|▾|▼|›|˅/u.test(probe)) d.icon_style = 'chevron';
      else if (/arrow|triangle|▶|▸/u.test(probe)) d.icon_style = 'arrow';
      else if (/\btimes\b|\bclose\b|\bx-|\bxmark|×/u.test(probe)) d.icon_style = 'plus-x';
      else if (/plus|minus|[+−]/u.test(probe)) d.icon_style = 'plus-minus';
      else if (iconEl && iconEl.tagName.toLowerCase() === 'svg') d.icon_style = 'chevron';
    } else { d.icon_style = 'none'; }
    // position
    let pos = 'left';
    const jc = getComputedStyle(bar).justifyContent || '';
    if (/between|end|right/i.test(jc)) pos = 'right';
    if (iconEl) {
      const kids = [...bar.children]; const last = kids[kids.length - 1];
      if (last === iconEl || /auto/i.test(getComputedStyle(iconEl).marginLeft || '')) pos = 'right';
    }
    if (d.icon_style && d.icon_style !== 'none') d.icon_position = pos;
    // alignment
    const ta = (getComputedStyle(bar).textAlign || '').toLowerCase();
    if (ta === 'center') d.title_alignment = 'center'; else if (ta === 'right') d.title_alignment = 'right';
    // title tag — the header is often wrapped in a real heading (<h3><button aria-expanded>); carry the level.
    for (let hn = bar; hn && hn !== first; hn = hn.parentElement) {
      if (/^h[2-6]$/.test(hn.tagName.toLowerCase())) { d.title_tag = hn.tagName.toLowerCase(); break; }
    }
    // radius
    const csf = getComputedStyle(first);
    const rr = csf.borderRadius || '';
    let radius = pxv(rr);
    if (radius <= 0 && radiusCls > 0) radius = radiusCls; // class fallback (rounded-xl → 12px)
    if (radius > 0) d.corner_radius = radius >= 16 ? 'lg' : (radius >= 8 ? 'md' : 'sm');
    else if (rr === '0px' || divideCls) d.corner_radius = 'none';
    // gap — computed flex-gap / margin-bottom, else the class fallback (space-y-N uses margin-TOP, unseen).
    let gap = Math.max(pxv(getComputedStyle(track).gap), pxv(csf.marginBottom), pxv(csf.marginTop));
    if (gap < 4 && gapCls >= 4) gap = gapCls;
    if (gap >= 4) {
      // The accordion Item Spacing option renders a `.mb-{slug}` utility, and the view sanitizes the value
      // (stripping brackets), so an arbitrary `mb-[16px]` matches no rule. Snap to the nearest INTEGER
      // spacing-scale slug so the gap actually renders (16px → mb-3). Parity with PHP accordion_design.
      const sc = [[0, 0], [1, 4], [2, 8], [3, 16], [4, 24], [5, 48], [6, 56], [7, 64], [8, 72], [9, 80], [10, 96], [11, 112], [12, 128]];
      let best = 3, bd = Infinity;
      for (const [slug, spx] of sc) { const dd = Math.abs(spx - gap); if (dd < bd) { bd = dd; best = slug; } }
      d.item_spacing = 'mb-' + best;
    }
    // style family
    const itemBg = csf.backgroundColor || '';
    const hasBg = (itemBg && itemBg !== 'rgba(0, 0, 0, 0)' && itemBg !== 'transparent') || hasBgCls;
    let itemBw = pxv(csf.borderTopWidth);
    if (itemBw < 1 && hasBdCls) itemBw = 1; // class fallback (`border` / `border-border`)
    const outerBw = pxv(getComputedStyle(track).borderTopWidth);
    const hasEdge = itemBw >= 1 || radius > 0;
    if (gap >= 4 && (hasEdge || hasBg)) d.accordion_style = (hasBg && itemBw < 1 && radius <= 4) ? 'filled' : 'separated';
    else if (gap < 4 && outerBw >= 1) d.accordion_style = 'bordered';
    else if (gap < 4 && !hasBg && !hasEdge) d.accordion_style = 'flush';
    // title bg
    let m; if (hasBg && (m = /rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/.exec(itemBg))) {
      const hx = (n) => ('0' + (+n).toString(16)).slice(-2);
      d.title_bg_color = { predefined: '', custom: '#' + hx(m[1]) + hx(m[2]) + hx(m[3]) };
    }
    // elevation
    const sh = csf.boxShadow || '';
    if (sh && sh !== 'none') { const sm = /(\d+(?:\.\d+)?)px/.exec(sh); d.elevation = (sm && parseFloat(sm[1]) >= 12) ? 'raised' : 'subtle'; }
    // panel (content) element — parity with PHP accordion_design: <details> first non-summary child, else
    // the aria-controls target or the bar's next sibling. Used for the content bg + text colour.
    let panel = null;
    if (first.tagName.toLowerCase() === 'details') { for (const ch of first.children) { if (ch.tagName.toLowerCase() !== 'summary') { panel = ch; break; } } }
    else { const ctrl = (bar.getAttribute('aria-controls') || '').trim(); if (ctrl && el.ownerDocument) panel = el.ownerDocument.getElementById(ctrl); if (!panel) panel = bar.nextElementSibling; }
    const rgbHex = (css) => { const mm = /rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/.exec(String(css || '')); if (!mm) return ''; const hx = (n) => ('0' + (+n).toString(16)).slice(-2); return '#' + hx(mm[1]) + hx(mm[2]) + hx(mm[3]); };
    const nearBlack = (css) => { const mm = /rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/.exec(String(css || '')); return !!mm && +mm[1] < 70 && +mm[2] < 70 && +mm[3] < 70; };
    const colv = (hex) => ({ predefined: '', custom: hex });
    if (panel) {
      const pbg = getComputedStyle(panel).backgroundColor || '';
      if (pbg && pbg !== 'transparent' && pbg !== 'rgba(0, 0, 0, 0)') { const h = rgbHex(pbg); if (h) d.content_bg_color = colv(h); }
      const pc = getComputedStyle(panel).color || '';
      if (pc && !nearBlack(pc)) { const h = rgbHex(pc); if (h) d.tab_content_color = colv(h); }
    }
    const bcol = getComputedStyle(bar).color || '';
    if (bcol && !nearBlack(bcol)) { const h = rgbHex(bcol); if (h) d.tab_title_color = colv(h); }
    if (iconEl) { const ic = getComputedStyle(iconEl).color || ''; if (ic && !nearBlack(ic)) { const h = rgbHex(ic); if (h) d.icon_closed_color = colv(h); } }
    // multiple open — a <details> group opens panels independently; Bootstrap collapse with data-bs-parent = single.
    if (first.tagName.toLowerCase() === 'details') d.multiple_open = 'yes';
    else { let hasParent = false; for (const _n of el.querySelectorAll('[data-bs-parent]')) { hasParent = true; break; } d.multiple_open = hasParent ? 'no' : 'yes'; }
    // Compact hint for the local-AI verify pass (real icon signal, not titles): the toggle icon markup +
    // bar class + item geometry, so the model can confirm/correct icon_style & accordion_style.
    d._hint = {
      icon: (iconEl ? ((iconEl.getAttribute('data-lucide') || iconEl.getAttribute('icon') || '') + ' ' + (iconEl.getAttribute('class') || '') + ' ' + iconEl.innerHTML).replace(/\s+/g, ' ').trim().slice(0, 180) : (barTxt.match(/[+−×›▶⌄▼▾]/u) || [''])[0]),
      count: items.length, gap: Math.round(gap), radius: Math.round(radius), hasBg, itemBw: Math.round(itemBw),
    };
    return d;
  };

  // --- feature_list (PHP is_text_list): real <ul>/<ol>, >=2 non-empty <li>, NOT a nav/menu/tab list ---
  const isTextList = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'ul' && tag !== 'ol') return false;
    const cls = cn(el).toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (/\b(menu|nav|navbar|pagination|breadcrumb|tabs?|tab-list|tablist|social|slider|carousel|steps|dropdown)\b/.test(cls)) return false;
    if (['menu', 'menubar', 'tablist', 'navigation'].includes(role)) return false;
    if (el.closest && el.closest('nav')) return false;
    let lis = 0;
    for (const li of [...el.children]) if (li.tagName.toLowerCase() === 'li' && txt(li)) lis++;
    return lis >= 2;
  };
  const textListBlockOf = (el) => {
    const ordered = el.tagName.toLowerCase() === 'ol';
    const items = [];
    for (const li of [...el.children]) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      const t = txt(li); if (!t) continue;
      items.push({ text: t, html: stripCs(li.innerHTML) });
    }
    return items.length >= 2 ? { t: 'feature_list', ordered, items } : null;
  };

  // --- DIV-based icon+text list (PHP is_icon_text_list) → feature_list. A container whose EVERY child is an
  // inline icon (svg / lucide) + a SHORT label (the modfii hero `flex items-center gap-2` [svg + span] rows:
  // "No credit impact" · "0.5% closing fee" · "Green mortgage options"). The <ul>/<li> path can't see these,
  // so they were dumped as verbatim code_blocks. Excludes nav/menu/tab/social strips; cards (with headings)
  // fail the row test. ---
  const isIconTextRow = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'ul', 'ol', 'li', 'svg', 'img', 'input', 'select'].includes(tag)) return false;
    const hasIcon = !!(el.querySelector('svg') || el.querySelector('[data-lucide], i[class*="lucide-"], [icon^="lucide:"]') || el.querySelector('i'));
    if (!hasIcon) return false;
    const t = (txt(el) || '').trim();
    if (!t || t.length > 60) return false;
    for (let i = 1; i <= 6; i++) if (el.querySelector('h' + i)) return false;
    if (el.querySelector('img') || el.querySelector('button')) return false;
    if (el.querySelector('a[class*="btn"]')) return false;
    return true;
  };
  const isIconTextList = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'nav', 'ul', 'ol', 'form'].includes(tag)) return false;
    if (el.closest && el.closest('nav')) return false;
    const cls = cn(el).toLowerCase();
    if (/\b(menu|nav|navbar|pagination|breadcrumb|tabs?|tablist|social|slider|carousel|dropdown|toolbar)\b/.test(cls)) return false;
    const kids = [...el.children].filter((k) => {
      const kt = k.tagName.toLowerCase();
      if (['script', 'style', 'br', 'hr', 'template'].includes(kt)) return false;
      return txt(k) || k.querySelector('img') || k.querySelector('svg');
    });
    if (kids.length < 2) return false;
    for (const k of kids) if (!isIconTextRow(k)) return false;
    return true;
  };
  const iconTextListBlockOf = (el) => {
    const items = [];
    const iconColors = [];
    let textColor = '', labelFs = 0, markerSize = 0;
    for (const k of [...el.children]) {
      const kt = k.tagName.toLowerCase();
      if (['script', 'style', 'br', 'hr', 'template'].includes(kt)) continue;
      const t = (txt(k) || '').trim(); if (!t) continue;
      const row = { text: t, html: stripCs(k.innerHTML) };
      // Per-item ICON — the exact inline <svg> (reproduced verbatim) + its computed colour + size, so the
      // native marker resolves the source glyph / tint / width. Parity with PHP icon_text_list_block.
      const svg = k.querySelector('svg');
      const iconEl = svg || k.querySelector('[class*="lucide-"], i');
      if (svg) row.icon_svg = svg.outerHTML;
      if (iconEl) {
        const ics = getComputedStyle(iconEl);
        if (/^rgb/i.test(ics.color)) { row.icon_color = ics.color; iconColors.push(ics.color); }
        if (!markerSize) { const w = parseFloat(ics.width || '0'); if (w > 0) markerSize = w; }
      }
      // Label element (span/p) → the list-level text colour + size (from the FIRST row that has one).
      if (!textColor && !labelFs) {
        const le = k.querySelector('span') || k.querySelector('p');
        if (le && (txt(le) || '').trim()) {
          const lcs = getComputedStyle(le);
          if (/^rgb/i.test(lcs.color)) textColor = lcs.color;
          const fsm = String(lcs.fontSize || '').match(/^([0-9.]+)px$/); if (fsm) labelFs = parseFloat(fsm[1]);
        }
      }
      items.push(row);
    }
    if (items.length < 2) return null;
    const cls = cn(el).toLowerCase();
    const cs = getComputedStyle(el);
    // Orientation: an inline flex/inline-flex strip that ISN'T a column stack = horizontal; flex-col / grid = vertical.
    let orientation = 'vertical';
    if ((/\bflex\b|\binline-flex\b/.test(cls) || /flex/.test(cs.display || '')) && !/\bflex-col\b/.test(cls) && !/\bgrid\b/.test(cls) && cs.flexDirection !== 'column') orientation = 'horizontal';
    // The wrapping gap (between items) → spacing_size; the first row's own gap (icon↔label) → item gap.
    const listGap = parseFloat((cs.rowGap && cs.rowGap !== 'normal' ? cs.rowGap : (cs.gap && cs.gap !== 'normal' ? String(cs.gap).split(' ')[0] : '')) || '0') || 0;
    let itemGap = 0;
    const k0 = [...el.children].find((k) => txt(k));
    if (k0) { const rcs = getComputedStyle(k0); itemGap = parseFloat((rcs.columnGap && rcs.columnGap !== 'normal' ? rcs.columnGap : (rcs.gap && rcs.gap !== 'normal' ? String(rcs.gap).split(' ').pop() : '')) || '0') || 0; }
    // List-level marker colour = the most common icon colour across the rows.
    let markerColor = '';
    if (iconColors.length) { const counts = {}; for (const c of iconColors) counts[c] = (counts[c] || 0) + 1; markerColor = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ''; }
    return { t: 'feature_list', ordered: false, items, orientation, markerColor, textColor, labelFs, markerSize, listGap, itemGap };
  };
  // The FIRST descendant container that is an icon-text/feature list inside `cell` (excluding `cell` itself) →
  // lets a card cell that wraps a nested feature list decompose into an icon_box header + a feature_list,
  // instead of one icon_box that drops the list. Parity with PHP cell_wraps_icon_text_list.
  const cellWrapsIconTextList = (cell) => {
    for (const d of cell.querySelectorAll('div,ul,section')) { if (d !== cell && isIconTextList(d)) return d; }
    return null;
  };

  // --- inline LINK STRIP (PHP is_inline_link_strip) → ONE centered text_block. A flex row whose children are
  // all short inline <a> links + <=3-char separators (•/|//), e.g. a footer policy-links line. Claimed high so
  // a card_grid/layout_row doesn't split each link into its own column (dropping separators + inline flow). ---
  const isInlineLinkStrip = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'nav', 'ul', 'ol', 'form', 'header'].includes(tag)) return false;
    if (el.closest && el.closest('nav')) return false;
    const cls = cn(el).toLowerCase();
    const cs = getComputedStyle(el);
    const isFlex = /flex|inline-flex/.test(cls) || /flex/.test(cs.display || '');
    if (!isFlex) return false;
    if (/\b(menu|nav|navbar|pagination|breadcrumb|tabs?|tablist|social|slider|carousel|dropdown|toolbar)\b/.test(cls)) return false;
    const kids = [...el.children].filter((k) => { const kt = k.tagName.toLowerCase(); if (['script', 'style', 'br', 'hr', 'template'].includes(kt)) return false; return !!(txt(k)); });
    if (kids.length < 2) return false;
    let links = 0;
    for (const k of kids) {
      const kt = k.tagName.toLowerCase();
      const t = (txt(k) || '').trim();
      if (kt === 'a') {
        if (!t || t.length > 40) return false;
        const kcs = getComputedStyle(k);
        const padded = parseFloat(kcs.paddingLeft || '0') >= 12 || parseFloat(kcs.paddingTop || '0') >= 8;
        const bg = kcs.backgroundColor && !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(kcs.backgroundColor);
        const bordered = parseFloat(kcs.borderTopWidth || '0') > 0;
        if (padded && (bg || bordered)) return false; // a button-styled CTA is not a link-strip item
        if (k.querySelector('img,svg,h1,h2,h3,h4,h5,h6,p,div,button')) return false;
        links++;
      } else {
        if (t.length > 3) return false; // a short separator only
        if (k.querySelector('a,img,svg')) return false;
      }
    }
    return links >= 2;
  };
  const inlineLinkStripBlock = (el) => {
    const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const parts = [];
    for (const k of [...el.children]) {
      const kt = k.tagName.toLowerCase();
      const t = (txt(k) || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (kt === 'a') {
        const href = (k.getAttribute('href') || '').trim();
        const target = (k.getAttribute('target') || '').trim();
        parts.push('<a href="' + escAttr(href || '#') + '"' + (target === '_blank' ? ' target="_blank" rel="noopener"' : '') + '>' + escHtml(t) + '</a>');
      } else {
        parts.push(escHtml(t)); // separator (•, |, /)
      }
    }
    if (parts.length < 2) return null;
    const cls = cn(el).toLowerCase();
    const cs = getComputedStyle(el);
    const center = /justify-center|text-center|mx-auto/.test(cls) || cs.justifyContent === 'center' || cs.textAlign === 'center';
    return { t: 'text', role: 'text', cls: 'sc-link-strip', align: center ? 'center' : '', textAlign: center ? 'center' : '', text: txt(el), html: '<p class="sc-link-strip">' + parts.join(' ') + '</p>' };
  };

  // --- tabs (PHP is_tabs_widget): a tablist (role or .tabs/.nav-tabs) with >=2 tabs each → a panel ---
  const elsWithRole = (el, role) => [...el.querySelectorAll('*')].filter((c) => (c.getAttribute('role') || '').toLowerCase() === role);
  const isTabsWidget = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['table', 'nav', 'details', 'summary'].includes(tag)) return false;
    let dets = 0; for (const d of el.querySelectorAll('details')) if (d.querySelector('summary')) dets++;
    if (dets >= 2) return false;
    const tabs = elsWithRole(el, 'tab'), panels = elsWithRole(el, 'tabpanel');
    if (tabs.length >= 2) {
      if (panels.length >= 2) return true;
      let resolved = 0; const doc = el.ownerDocument;
      for (const t of tabs) { const id = (t.getAttribute('aria-controls') || '').trim(); if (id && doc && doc.getElementById(id)) resolved++; }
      if (resolved >= 2) return true;
    }
    const cls = cn(el).toLowerCase();
    if (/\b(tabs|nav-tabs|tab-group|tabbed|tabset)\b/.test(cls)) {
      let labels = 0;
      for (const c of el.querySelectorAll('*')) {
        const ct = c.tagName.toLowerCase(); if (!['a', 'button', 'li', 'span'].includes(ct)) continue;
        const cc = cn(c).toLowerCase();
        if (c.hasAttribute('data-tab') || c.hasAttribute('aria-controls') || /\b(tab-link|nav-link|tab-title|tab-btn)\b/.test(cc)) labels++;
      }
      let panels2 = 0;
      for (const c of el.querySelectorAll('*')) {
        const cc = cn(c).toLowerCase();
        if (c.hasAttribute('data-tab-content') || /\b(tab-pane|tab-panel|tab-content-item)\b/.test(cc)) panels2++;
      }
      if (labels >= 2 && panels2 >= 2) return true;
    }
    return false;
  };
  const tabsBlockOf = (el) => {
    const doc = el.ownerDocument;
    let labels = elsWithRole(el, 'tab'), panels = elsWithRole(el, 'tabpanel');
    if (labels.length < 2) {
      labels = []; panels = [];
      for (const c of el.querySelectorAll('*')) {
        const ct = c.tagName.toLowerCase(); const cc = cn(c).toLowerCase();
        if (['a', 'button', 'li', 'span'].includes(ct) && (c.hasAttribute('data-tab') || c.hasAttribute('aria-controls') || /\b(tab-link|nav-link|tab-title|tab-btn)\b/.test(cc))) labels.push(c);
        if (c.hasAttribute('data-tab-content') || /\b(tab-pane|tab-panel|tab-content-item)\b/.test(cc)) panels.push(c);
      }
    }
    const items = [];
    labels.forEach((lab, i) => {
      const title = txt(lab); if (!title) return;
      let panel = null;
      let ctrl = (lab.getAttribute('aria-controls') || '').trim(); if (!ctrl) ctrl = (lab.getAttribute('data-tab') || '').trim();
      if (ctrl && doc) {
        let p = doc.getElementById(ctrl);
        if (!p) p = panels.find((pp) => (pp.getAttribute('data-tab-content') || '').trim() === ctrl || (pp.getAttribute('id') || '').trim() === ctrl) || null;
        panel = p;
      }
      if (!panel && panels[i]) panel = panels[i];
      const content = panel ? stripCs(panel.innerHTML) : '';
      const active = ((lab.getAttribute('aria-selected') || '').toLowerCase() === 'true' || /\bactive\b/.test(cn(lab).toLowerCase())) ? 'yes' : 'no';
      items.push({ title, content, active });
    });
    return items.length >= 2 ? { t: 'tabs', items } : null;
  };

  // --- steps (PHP is_steps_flow): .steps/.process OR every child numbered, each with a title ---
  const stepMarker = (el) => {
    if (/^\s*(?:step\s*)?(\d{1,2})\b/i.test(txt(el))) return true;
    for (const c of el.querySelectorAll('*')) {
      // A distinct element whose ENTIRE text is a 1-2 digit number (optionally zero-padded: 01, 02) is a
      // step-number badge — the common "big number + title + copy" step card where the number span abuts
      // the title with no separator ("01Tell Us…"), so the leading-digit test above can't fire. Parity with
      // PHP step_marker (this check was missing here, so numbered card grids read as icon-box columns).
      // (…never inside an ABSOLUTE chip pinned over a photo — an event card's `JUN / 08` date badge is a date, not a step)
      const inAbs = (() => { for (let a = c.parentElement; a && a !== el; a = a.parentElement) { try { const ps = getComputedStyle(a).position; if (ps === 'absolute' || ps === 'fixed') return true; } catch { return false; } } return false; })();
      if (/^0*\d{1,2}$/.test(txt(c)) && !inAbs) return true;
      const cc = cn(c).toLowerCase();
      if (/step-?(number|index|num|count)|\b(number|circle|marker|count)\b/.test(cc) && /\d/.test(txt(c))) return true;
    }
    return false;
  };
  const isStepsFlow = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['table', 'thead', 'tbody', 'tr', 'nav', 'dl', 'details', 'summary'].includes(tag)) return false;
    if (el.querySelector('details')) return false;
    const kids = wChildren(el); const n = kids.length; if (n < 2) return false;
    let cls = cn(el).toLowerCase(); for (const k of kids) cls += ' ' + cn(k).toLowerCase();
    const classSignal = /\b(steps?|process|how-?it-?works|process-?flow)\b/.test(cls);
    let titled = 0, numbered = 0;
    for (const k of kids) { if (wTitle(k)) titled++; if (stepMarker(k)) numbered++; }
    if (titled < 2) return false;
    return classSignal ? true : (numbered >= n);
  };
  // The ICON of one step (parity PHP step_icon): lucide id → {lucide}, inline svg → {svg}, img → {img}, else null.
  const stepIcon = (k) => {
    const li = k.querySelector('[data-lucide], i[class*="lucide-"], [icon^="lucide:"], svg[class*="lucide-"]');
    if (li) {
      const dl = li.getAttribute('data-lucide'); if (dl) return { lucide: 'lucide/' + dl.trim().toLowerCase() };
      const ic = li.getAttribute('icon') || ''; const m = ic.match(/^lucide:([a-z0-9-]+)$/i); if (m) return { lucide: 'lucide/' + m[1].toLowerCase() };
      const cls = (li.className && li.className.baseVal !== undefined ? li.className.baseVal : li.className) || '';
      const cm = String(cls).match(/\blucide-([a-z0-9-]+)/); if (cm && cm[1] !== 'lucide') return { lucide: 'lucide/' + cm[1] };
    }
    const svg = k.querySelector('svg'); if (svg && svg.innerHTML.trim()) return { svg: svg.outerHTML };
    const img = k.querySelector('img'); if (img && (img.getAttribute('src') || '').trim()) return { img: img.getAttribute('src').trim() };
    return null;
  };
  // Steps DESIGN (parity PHP detect_steps_design): horizontal|vertical|cards + marker/marker_shape/accent.
  const detectStepsDesign = (el, items) => {
    const out = { design: 'horizontal' };
    const cls = ' ' + cn(el).toLowerCase() + ' ';
    const dir = getComputedStyle(el).flexDirection || '';
    const vertical = (cls.includes(' flex-col ') && !cls.includes('md:flex-row')) || /column/.test(dir) || cls.includes(' grid-cols-1 ');
    if (vertical) out.design = 'vertical';
    const kids = [...el.children];
    const isBoxedEl = (elm) => {
      const c = ' ' + cn(elm).toLowerCase() + ' ';
      if (/\b(?:border|shadow|rounded|bg-white|bg-card)\b/.test(c)) return true;
      const s = getComputedStyle(elm); const bg = s.backgroundColor;
      const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
      return parseFloat(s.borderTopWidth) >= 1 || parseFloat(s.borderRadius) >= 4 || (s.boxShadow && s.boxShadow !== 'none') || hasBg;
    };
    // The step CARD may be the child itself OR a NESTED wrapper (source pattern: `<div class="relative">` →
    // connector + `<div class="… bg … border rounded">card</div>`). Resolve the actual boxed element so the
    // card design + skin aren't missed just because the outer flow wrapper is unstyled.
    const cardOf = (child) => {
      if (isBoxedEl(child)) return child;
      for (const d of child.querySelectorAll('div')) { if (isBoxedEl(d)) return d; }
      return child;
    };
    let boxed = 0, n = 0; const cards = [];
    for (const k of kids) { n++; const card = cardOf(k); cards.push(card); if (isBoxedEl(card)) boxed++; }
    if (!vertical && n >= 2 && boxed >= n - 1) out.design = 'cards';
    // Step-card box SKIN (icon-box `box` shape) so the census clusters it and box_style can be assigned.
    if (out.design === 'cards' && cards[0]) {
      const s = getComputedStyle(cards[0]);
      const okc = (v) => v && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(v);
      out.box = {
        bg: okc(s.backgroundColor) ? s.backgroundColor : '', fill: okc(s.backgroundColor) ? s.backgroundColor : '',
        radius: (parseFloat(s.borderTopLeftRadius) || 0) > 0 ? s.borderTopLeftRadius : '',
        borderWidth: (parseFloat(s.borderTopWidth) || 0) > 0 ? s.borderTopWidth : '',
        borderStyle: s.borderTopStyle, borderColor: okc(s.borderTopColor) ? s.borderTopColor : '',
        shadow: (s.boxShadow && s.boxShadow !== 'none') ? s.boxShadow : '',
        backdrop: (s.backdropFilter && s.backdropFilter !== 'none') ? s.backdropFilter : '',
        hoverLift: /hover:-?translate-y-/.test(cn(cards[0])),
      };
    }
    // Marker shape + accent: prefer the ICON BADGE (the element wrapping the step's icon that carries a
    // fill/radius — e.g. `w-14 h-14 rounded-2xl bg-primary/10`), not the plain number span. Falls back to a
    // number/marker chip so a number-only flow still reads its shape.
    const first = kids[0];
    let marker = null;
    if (first) {
      const ic = first.querySelector('svg, i[class*="lucide-"], [data-lucide], img');
      if (ic) {
        for (let p = ic.parentElement; p && p !== first.parentElement && p !== first; p = p.parentElement) {
          const ps = getComputedStyle(p); const pbg = ps.backgroundColor;
          if ((pbg && pbg !== 'rgba(0, 0, 0, 0)' && pbg !== 'transparent') || parseFloat(ps.borderRadius) > 0) { marker = p; break; }
        }
      }
      if (!marker) {
        for (const c of first.querySelectorAll('*')) {
          if (/^0*\d{1,2}$/.test(txt(c)) || /step-?(number|index|num|count)|\b(marker|badge|circle|count|number)\b/.test(cn(c).toLowerCase())) { marker = c; break; }
        }
      }
    }
    if (marker) {
      const ms = getComputedStyle(marker); const rr = ms.borderRadius || '', rad = parseFloat(rr);
      if (rad >= 999 || rr.includes('50%')) out.marker_shape = 'circle';
      else if (rad >= 4) out.marker_shape = 'rounded';
      else if (rr === '0px') out.marker_shape = 'square';
      const mbg = ms.backgroundColor, mm = /rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)(?:\D+([\d.]+))?/.exec(mbg || '');
      if (mbg && mbg !== 'rgba(0, 0, 0, 0)' && mbg !== 'transparent' && mm) {
        // Preserve a translucent tint (source badges are often `bg-primary/10`) so the marker reads light.
        if (mm[4] != null && parseFloat(mm[4]) < 1) out.accent = `rgba(${+mm[1]}, ${+mm[2]}, ${+mm[3]}, ${mm[4]})`;
        else { const hx = (x) => ('0' + (+x).toString(16)).slice(-2); out.accent = '#' + hx(mm[1]) + hx(mm[2]) + hx(mm[3]); }
      }
    }
    const withIcon = items.filter((it) => it.icon).length;
    if (withIcon >= Math.max(1, Math.floor(items.length / 2))) out.marker = 'icon';
    // Connector — a thin line element between steps (h-px/h-0.5 bar or a gradient/bg divider) → keep the line;
    // otherwise turn it off so a boxed source with no line doesn't get a spurious connector.
    let hasConn = false;
    for (const k of kids) {
      for (const c of k.querySelectorAll('*')) {
        const cc = ' ' + cn(c).toLowerCase() + ' ';
        if (/\b(?:connector|step-line|divider-line)\b/.test(cc) || (/\bh-(?:px|0\.5|\[1px\]|\[2px\])\b/.test(cc) && /\b(?:bg-|gradient)/.test(cc))) { hasConn = true; break; }
      }
      if (hasConn) break;
    }
    out.connector = hasConn ? 'solid' : 'none';
    return out;
  };
  const stepsBlockOf = (el) => {
    const items = [];
    for (const k of wChildren(el)) {
      const title = wTitle(k); if (!title) continue;
      let num = ''; const m = txt(k).match(/^\s*(?:step\s*)?(\d{1,2})\b/i); if (m) num = m[1];
      if (!num) { // glued number span ("01Tell Us…") → pull the child whose entire text is a 1-2 digit number (keeps 01/02)
        for (const c of k.querySelectorAll('*')) { const ct = txt(c); if (/^0*\d{1,2}$/.test(ct)) { num = ct; break; } }
      }
      items.push({ title, content: wBody(k, title), number: num, icon: stepIcon(k) });
    }
    return items.length >= 2 ? { t: 'steps', items, design: detectStepsDesign(el, items) } : null;
  };

  // --- timeline (PHP is_timeline): .timeline OR every child dated, each with a title ---
  const timelineDate = (el) => {
    const time = el.querySelector('time'); if (time && txt(time)) return txt(time);
    const t = txt(el); let m;
    if ((m = t.match(/\b((?:19|20)\d{2})\b/))) return m[1];
    if ((m = t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/i))) return m[0];
    if ((m = t.match(/\b\d{1,2}\/\d{4}\b/))) return m[0];
    return '';
  };
  const isTimeline = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['table', 'thead', 'tbody', 'tr', 'nav', 'dl', 'details', 'summary'].includes(tag)) return false;
    if (el.querySelector('details')) return false;
    const kids = wChildren(el); const n = kids.length; if (n < 2) return false;
    let cls = cn(el).toLowerCase(); for (const k of kids) cls += ' ' + cn(k).toLowerCase();
    const classSignal = /\btimeline\b/.test(cls);
    let dated = 0, titled = 0;
    for (const k of kids) { if (timelineDate(k)) dated++; if (wTitle(k)) titled++; }
    if (titled < 2) return false;
    return classSignal ? (dated >= 1) : (dated >= n);
  };
  const timelineBlockOf = (el) => {
    const items = [];
    for (const k of wChildren(el)) {
      const title = wTitle(k), date = timelineDate(k);
      if (!title && !date) continue;
      let body = wBody(k, title);
      if (date && body.indexOf(date) === 0) body = body.slice(date.length).trim();
      items.push({ date, title, text: body });
    }
    return items.length >= 2 ? { t: 'timeline', items } : null;
  };

  // --- progress (PHP is_progress_bars): >=2 items, EVERY one a STRUCTURAL bar (role=progressbar or
  //     an inner width:NN%). Text-only "NN%" is excluded (a stat grid stays counters). ---
  const barPercent = (el) => {
    const cands = [];
    if ((el.getAttribute('role') || '').toLowerCase() === 'progressbar') cands.push(el);
    for (const c of el.querySelectorAll('[role="progressbar"]')) cands.push(c);
    for (const c of cands) { const v = c.getAttribute('aria-valuenow'); if (v != null && v !== '' && !isNaN(v)) return Math.max(0, Math.min(100, Math.round(+v))); }
    const nodes = [el, ...el.querySelectorAll('*')];
    for (const c of nodes) {
      const st = c.getAttribute('style') || ''; const m = st.match(/width\s*:\s*([\d.]+)\s*%/i);
      if (m) { const cc = cn(c).toLowerCase(); if (/\b(bar|fill|progress|meter|value|inner)\b/.test(cc) || c !== el) return Math.max(0, Math.min(100, Math.round(+m[1]))); }
      // a utility-class fill (w-[96%] / w-3/4) inside a TRACK: a short (<= 16px) rounded / clipped parent whose only child it is (PHP: bar_percent)
      const ccls = ' ' + cn(c).toLowerCase() + ' '; let pct = null;
      const wa = ccls.match(/(?:^|\s)w-\[([0-9.]+)%\]/); const wf = ccls.match(/(?:^|\s)w-([1-9][0-9]?)\/([1-9][0-9]?)(?:\s|$)/);
      if (wa) pct = parseFloat(wa[1]); else if (wf) pct = parseFloat(wf[1]) / parseFloat(wf[2]) * 100;
      if (pct != null && c.parentElement) { let pcs; try { pcs = getComputedStyle(c.parentElement); } catch { pcs = null; } const ph = pcs ? c.parentElement.getBoundingClientRect().height : 0; if (pcs && ph > 0 && ph <= 16 && c.parentElement.children.length === 1 && (pcs.overflow === 'hidden' || parseFloat(pcs.borderTopLeftRadius) > 0)) return Math.max(0, Math.min(100, Math.round(pct))); }
    }
    return null;
  };
  const isProgressBars = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['table', 'thead', 'tbody', 'tr', 'nav', 'dl', 'details', 'summary'].includes(tag)) return false;
    if (el.querySelector('details')) return false;
    const kids = wChildren(el); const n = kids.length; if (n < 2) return false;
    let bars = 0; for (const k of kids) if (barPercent(k) != null) bars++;
    return bars >= 2 && bars === n;
  };
  const progressBlockOf = (el) => {
    const bars = [];
    for (const k of wChildren(el)) {
      const pct = barPercent(k); if (pct == null) continue;
      let label = '';
      for (const c of k.querySelectorAll('*')) { const cc = cn(c).toLowerCase(); if (/\b(label|skill-?name|title|name)\b/.test(cc) && txt(c)) { label = txt(c); break; } }
      if (!label) label = txt(k).replace(/\b\d{1,3}\s*%/g, '').trim();
      bars.push({ label, percent: pct });
    }
    return bars.length >= 2 ? { t: 'progress', bars } : null;
  };

  // --- pricing_table (PHP is_pricing_table): >=2 plan columns and a currency+number price token in
  //     MOST columns (>=ceil(0.6n)) — a plain feature grid (no currency) is NOT claimed. ---
  const cellPriceParts = (el) => {
    const t = txt(el); if (!t) return null;
    const m = t.match(/([$€£¥₹])\s?(\d[\d.,]*)/); if (!m) return null;
    let period = ''; const pm = t.match(/\/\s*(mo|month|yr|year|wk|week|day|user|seat)s?\b/i); if (pm) period = '/' + pm[1].toLowerCase();
    return { currency: m[1], price: m[2].replace(/,/g, ''), period };
  };
  const isPricingTable = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['table', 'thead', 'tbody', 'tr', 'ul', 'ol', 'nav', 'dl', 'details', 'summary'].includes(tag)) return false;
    if (el.querySelector('details') || el.querySelector('table')) return false;
    const kids = wChildren(el); const n = kids.length; if (n < 2) return false;
    let priced = 0, withList = 0, withImg = 0, withShop = 0;
    for (const k of kids) {
      if (cellPriceParts(k)) priced++;
      if (k.querySelector('ul,ol')) withList++;
      if (k.querySelector('img')) withImg++;
      const cta = [...k.querySelectorAll('a,button')].map((b) => txt(b)).join(' ');
      if (/\b(add to (cart|basket|bag)|buy now|shop now|order now)\b/i.test(cta)) withShop++;
    }
    if (priced < Math.max(2, Math.ceil(n * 0.6))) return false;
    // A PRODUCT-card grid (a shop) also has prices but is NOT a pricing table: pricing plans have a FEATURE
    // LIST per column, while product cards have a product IMAGE and/or an "Add to cart/basket" CTA and no
    // feature list. Reject those so they fall through to card -> icon_box (keeps image/title/desc/button)
    // instead of a pricing_table with a bogus "/mo". Parity with PHP is_pricing_table.
    const maj = Math.ceil(n * 0.6);
    if (withList < maj && (withImg >= maj || withShop >= maj)) return false;
    return true;
  };
  const pricingBlockOf = (el) => {
    const plans = [];
    for (const k of wChildren(el)) {
      const price = cellPriceParts(k); const title = wTitle(k);
      if (!title && !price) continue;
      const features = [];
      const ul = k.querySelector('ul') || k.querySelector('ol');
      if (ul) for (const li of ul.querySelectorAll('li')) { const t = txt(li); if (t) features.push(t); }
      let btnLabel = '', btnUrl = '';
      for (const bt of ['a', 'button']) { const b = k.querySelector(bt); if (b && txt(b)) { btnLabel = txt(b); btnUrl = abs(b.getAttribute('href') || ''); break; } }
      const kcls = cn(k).toLowerCase();
      const featured = /\b(featured|popular|recommended|highlight(ed)?|best|pro)\b/.test(kcls) ? 'yes' : 'no';
      let ribbon = '';
      if (featured === 'yes') {
        for (const c of k.querySelectorAll('*')) { const cc = cn(c).toLowerCase(); if (/\b(ribbon|badge|popular|tag|label)\b/.test(cc) && txt(c) && txt(c).length <= 24) { ribbon = txt(c); break; } }
      }
      plans.push({ title: title || '', currency: price ? price.currency : '$', price: price ? price.price : '', period: price ? price.period : '', features: features.join('\n'), featured, ribbon, btn_label: btnLabel, btn_url: btnUrl });
    }
    return plans.length >= 2 ? { t: 'pricing', plans } : null;
  };

  // --- lottie (PHP is_lottie_embed): <lottie-player>/<dotlottie-player>, or a container carrying a
  //     .json/.lottie src + a lottie/bodymovin class or data-animation-path/data-lottie flag ---
  const lottieSrcOf = (el) => {
    for (const a of ['src', 'data-src', 'data-animation-path', 'data-lottie', 'data-json', 'href']) {
      const v = (el.getAttribute(a) || '').trim(); if (v && /\.(json|lottie)(\?|#|$)/i.test(v)) return v;
    }
    return '';
  };
  const isLottieEmbed = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'lottie-player' || tag === 'dotlottie-player') return true;
    if (el.querySelector('lottie-player,dotlottie-player')) return true;
    if (lottieSrcOf(el)) { const cls = cn(el).toLowerCase(); if (/\b(lottie|bodymovin|dotlottie)\b/.test(cls) || el.hasAttribute('data-animation-path') || el.hasAttribute('data-lottie')) return true; }
    return false;
  };
  const lottieBlockOf = (el) => {
    let src = lottieSrcOf(el);
    if (!src) { const p = el.querySelector('lottie-player,dotlottie-player'); if (p) src = lottieSrcOf(p); }
    return src ? { t: 'lottie', src: abs(src) } : null;
  };

  // --- svg_draw (PHP is_svg_draw): inline <svg> with a draw class/data-draw flag, or stroke-dash
  //     animated paths — NOT a plain decorative icon <svg> ---
  const isSvgDraw = (el) => {
    if (el.tagName.toLowerCase() !== 'svg') return false;
    const cls = cn(el).toLowerCase();
    if (/\b(svg-?draw|line-?draw|draw-?svg|animate-?draw|self-?draw)\b/.test(cls)) return true;
    if (el.hasAttribute('data-draw') || el.hasAttribute('data-svg-draw')) return true;
    for (const st of ['path', 'line', 'polyline', 'circle', 'rect']) {
      for (const p of el.querySelectorAll(st)) {
        if (p.hasAttribute('stroke-dasharray') || p.hasAttribute('stroke-dashoffset')) return true;
        const style = (p.getAttribute('style') || '').toLowerCase();
        if (style.includes('stroke-dasharray') || style.includes('stroke-dashoffset')) return true;
      }
    }
    return false;
  };
  const svgDrawBlockOf = (el) => {
    let markup = el.outerHTML || '';
    markup = markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    markup = stripCs(markup);
    return markup ? { t: 'svg_draw', code: markup } : null;
  };

  // Dispatcher — TIGHT structural match, highest PHP priority first. Tag-scoped fast paths (svg /
  // lottie / table / ul-ol) can't overlap the container widgets. Returns a typed block or null.
  const structuredWidgetOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'svg') return isSvgDraw(el) ? svgDrawBlockOf(el) : null; // svg is otherwise SKIP → verbatim
    if (isLottieEmbed(el)) return lottieBlockOf(el);
    if (tag === 'table') return el.querySelector('tr') ? tableBlockOf(el) : null;
    if (isTextList(el)) return textListBlockOf(el);
    if (isPricingTable(el)) return pricingBlockOf(el);   // 99
    if (isStepsFlow(el)) return stepsBlockOf(el);        // 98
    if (isTimeline(el)) return timelineBlockOf(el);      // 97
    if (isProgressBars(el)) return progressBlockOf(el);  // 96
    if (isTabsWidget(el)) return tabsBlockOf(el);        // 95
    if (isAccordionGroup(el)) return accordionBlockOf(el); // 89
    if (isInlineLinkStrip(el)) return inlineLinkStripBlock(el); // 93 (link strip → one centered text_block)
    if (isIconTextList(el)) return iconTextListBlockOf(el); // 84 (DIV icon+text list → feature_list)
    return null;
  };

  // Source-animation INTENT → an animate.css effect string (parity with PHP Stitch::anim_intent):
  // AOS (data-aos), animate.css v4 (animate__*), WOW v3 (wow fadeInUp), or a directional generic reveal
  // hook (data-animate/scroll/reveal/motion). '' when there's no signal (no false motion). Stamped onto
  // decomposed blocks; to-pages enables it on the node's Animations tab for the standard {enable,yes}
  // shape only (interactive widgets are left at their default, matching apply_block_anim).
  const ANIM_DIR = { up: 'animate__fadeInUp', down: 'animate__fadeInDown', left: 'animate__fadeInLeft', right: 'animate__fadeInRight' };
  // The capture's CSS-class reveal stamp (capture.mjs data-sc-reveal) → { dir, distance, scale, duration, delay, ease }.
  // PHP twin: reveal_of. Read off the element itself (a reveal class sits on the animated element, not a wrapper).
  // The element's OWN running class animation (capture data-sc-anim: a pulsing dot, a swaying word, a drifting shell, a
  // scroll-grown card) + its @keyframes → { css, kf } or null. PHP: loop_anim_of.
  const loopAnimOf = (el) => {
    try {
      const a = (el.getAttribute('data-sc-anim') || '').trim();
      if (!a || !/^animation:[a-z0-9_ .,()%-]+(?:;animation-(?:timeline|range):[a-z0-9 ().%-]+)*$/i.test(a)) return null;
      let kf = (el.getAttribute('data-sc-keyframes') || '').trim(); if (kf && !/^@keyframes\s+[\w-]+\s*\{[^<>]*\}\s*$/.test(kf)) kf = '';
      return { css: a, kf };
    } catch { return null; }
  };
  const revealOf = (el) => {
    if (!el || !el.getAttribute) return null;
    const v = el.getAttribute('data-sc-reveal'); if (!v) return null;
    const o = {}; for (const part of v.split(';')) { const i = part.indexOf(':'); if (i > 0) o[part.slice(0, i)] = part.slice(i + 1); }
    return { dir: o.dir || 'none', distance: parseFloat(o.distance) || 0, scale: parseFloat(o.scale) || 1, duration: parseFloat(o.duration) || 0, delay: parseFloat(o.delay) || 0, ease: o.ease || '' };
  };
  const animOf = (el) => {
    if (!el || !el.getAttribute) return '';
    const aos = (el.getAttribute('data-aos') || '').trim().toLowerCase();
    if (aos) {
      let m;
      if ((m = aos.match(/(up|down|left|right)/)) && !aos.includes('zoom')) return ANIM_DIR[m[1]];
      if (aos.indexOf('zoom-out') === 0) return 'animate__zoomOut';
      if (aos.indexOf('zoom') === 0) return 'animate__zoomIn';
      if (aos.indexOf('flip') === 0) return 'animate__flipInX';
      return 'animate__fadeIn';
    }
    const cls = cn(el); let m;
    if ((m = cls.match(/\banimate__([A-Za-z]+)\b/))) return 'animate__' + m[1];
    if (/\bwow\b/i.test(cls) && (m = cls.match(/\b(fadeIn[A-Za-z]*|zoomIn|zoomOut|slideIn[A-Za-z]*|bounceIn[A-Za-z]*|flipIn[A-Za-z]*)\b/))) return 'animate__' + m[1];
    for (const at of ['data-animate', 'data-scroll', 'data-reveal', 'data-motion']) {
      if (el.hasAttribute(at)) {
        const v = (el.getAttribute(at) || '').toLowerCase();
        for (const k of Object.keys(ANIM_DIR)) if (v.includes(k)) return ANIM_DIR[k];
        return 'animate__fadeInUp';
      }
    }
    return '';
  };

  // An AUTO-SCROLL MARQUEE / horizontal-scroll strip: a continuously scrolling track (`animate-marquee`
  // / `animate-scroll-left|right`, on the element OR its single track child), or an `overflow-x-auto` flex
  // row of many fixed-width `flex-shrink-0` cards (a reel / logo ticker). It must stay ONE verbatim block —
  // splitting it into builder columns stacks the cards and loses the horizontal scroll. PHP twin:
  // Stitch::is_marquee_strip(). The scroll keyframe is reproduced by the Tailwind CSS layer.
  const isMarqueeStrip = (el) => {
    if (!el || !el.getAttribute) return false;
    const hasAnim = (c) => /\banimate-(marquee|scroll(?:-left|-right)?)\b/.test(c);
    const cls = ` ${el.getAttribute('class') || ''} `;
    if (hasAnim(cls)) return true;
    const kidsAll = [...el.children];
    if (kidsAll.length === 1 && kidsAll[0].getAttribute && hasAnim(` ${kidsAll[0].getAttribute('class') || ''} `)) return true;
    const s = getComputedStyle(el);
    if (s.overflowX === 'auto' || s.overflowX === 'scroll' || /\boverflow-x-(auto|scroll)\b/.test(cls)) {
      const kids = rowKids(el);
      const shrink0 = kids.filter((k) => /\b(?:flex-)?shrink-0\b/.test(k.className || '')).length;
      if (kids.length >= 4 && shrink0 >= Math.ceil(kids.length / 2)) return true;
    }
    return false;
  };

  // The full computed style of a TEXT LEAF → one text block (font / colour / rhythm / box skin / position).
  // Shared by the plain leaf branch and the chip-row branch (each chip is a leaf). PHP twin: the
  // text block shape in collect_blocks + text_box_skin.
  const textLeafBlock = (child, tag, cls) => { const _tcs = getComputedStyle(child); return { t: 'text', html: rawHtmlOf(child, true), text: clip(txt(child), 200), tag: tag.toLowerCase(), cls,
      longTail: textLongTailOf(child), // the text long tail (italic / shadow / clamp / columns / … — PHP: prose profiles + block_rule_fixups)
      fontSizeSm: smOf(child)['font-size'] || '', lineHeightSm: smOf(child)['line-height'] || '', // the phone-pass size when it differs (PHP: csSm)
      linkSkin: (() => { const a = child.querySelector('a'); if (!a) return ''; let ls; try { ls = getComputedStyle(a); } catch { return ''; } const d = []; if (ls.color && ls.color !== _tcs.color) d.push('color:' + ls.color); if (ls.textDecorationLine && ls.textDecorationLine !== 'none') d.push('text-decoration-line:' + ls.textDecorationLine); if (ls.textDecorationThickness && !/^(auto|from-font)$/.test(ls.textDecorationThickness)) d.push('text-decoration-thickness:' + ls.textDecorationThickness); if (ls.textUnderlineOffset && ls.textUnderlineOffset !== 'auto') d.push('text-underline-offset:' + ls.textUnderlineOffset); if (ls.textDecorationColor && ls.textDecorationColor !== ls.color) d.push('text-decoration-color:' + ls.textDecorationColor); if (ls.fontWeight && ls.fontWeight !== _tcs.fontWeight) d.push('font-weight:' + ls.fontWeight); return d.join(';'); })(), // the first inline link's own skin (PHP: linkCs)
      // Full computed style so the decomposed text_block reproduces EVERY class effect (font-size /
      // colour / line-height / letter-spacing / alignment / bottom margin) — nothing dropped.
      fontSize: _tcs.fontSize, color: _tcs.color, lineHeight: _tcs.lineHeight, letterSpacing: _tcs.letterSpacing, marginBottom: _tcs.marginBottom, paddingBottom: _tcs.paddingBottom, textAlign: _tcs.textAlign, fontWeight: _tcs.fontWeight,
      ownFace: ownFaceOf(_tcs), // the leaf's own face when it differs from the body face (a mono chip in a sans card)
      contentSized: (() => { try { const pcs = getComputedStyle(child.parentElement); return (/flex/.test(pcs.display) && !/column/.test(pcs.flexDirection)) || /inline-(block|flex)/.test(_tcs.display) || /(fit|max)-content/.test(_tcs.width); } catch { return false; } })(), // a flex-row item / inline-block keeps its own width (a boxed chip)
      // BOX skin — a paragraph that IS a box (a glass callout, a floating note) → a real Box Preset on the text
      // block's Box Style (to-pages stashes it on _box; capture.mjs assigns box_style). Parity with PHP text_box_skin.
      bg: hasBg(_tcs.backgroundColor) ? _tcs.backgroundColor : '', bgImage: (/gradient\(/i.test(_tcs.backgroundImage || '') && !/url\(/i.test(_tcs.backgroundImage) ? _tcs.backgroundImage : ''),
      border: (parseFloat(_tcs.borderTopWidth) > 0 && _tcs.borderTopStyle !== 'none') ? (_tcs.borderTopWidth + ' ' + _tcs.borderTopStyle + ' ' + _tcs.borderTopColor) : '',
      borderRadius: _tcs.borderRadius, boxShadow: (_tcs.boxShadow && _tcs.boxShadow !== 'none') ? _tcs.boxShadow : '', padding: _tcs.padding,
      backdrop: ((_tcs.backdropFilter && _tcs.backdropFilter !== 'none') ? _tcs.backdropFilter : ((_tcs.webkitBackdropFilter && _tcs.webkitBackdropFilter !== 'none') ? _tcs.webkitBackdropFilter : '')),
      // Out-of-flow placement (a chip pinned over a band) → the native Position option. Parity with PHP element_position_from.
      position: _tcs.position, top: _tcs.top, right: _tcs.right, bottom: _tcs.bottom, left: _tcs.left, zIndex: _tcs.zIndex }; };
  // A CHIP ROW: a flex container with >=2 element children, EVERY one a short text leaf (1-40 chars, only
  // inline / empty decorative children, no media / link / button) that is BOXED (a fill, gradient, border or
  // shadow of its own) or pill-shaped (radius >= 40px). A tag row, a metric row, a skills list. PHP: is_chip_row.
  const chipRowOf = (el) => {
    if (!el || !el.tagName) return false;
    const cs = getComputedStyle(el);
    if (!/flex/.test(cs.display || '') || /column/.test(cs.flexDirection || '')) return false;
    const kids = rowKids(el);
    if (kids.length < 2 || kids.length > 12) return false;
    let plain = 0;
    for (const k of kids) {
      if (['A', 'BUTTON', 'IMG', 'SVG', 'VIDEO', 'UL', 'OL', 'NAV', 'FORM', 'INPUT'].includes(k.tagName)) return false;
      if (k.querySelector('a, button, img, video, iframe, h1, h2, h3, h4, h5, h6, p, ul')) return false;
      if ([...k.querySelectorAll('div')].some((d) => txt(d) !== '')) return false; // a dot / pip div is fine; content is not
      const t = txt(k); if (!t || t.length > 40) return false;
      const ks = getComputedStyle(k);
      const boxed = hasBg(ks.backgroundColor) || (ks.backgroundImage || '').toLowerCase().includes('gradient(') || (parseFloat(ks.borderTopWidth) > 0 && ks.borderTopStyle !== 'none') || (ks.boxShadow && ks.boxShadow !== 'none');
      const pill = (parseFloat(ks.borderTopLeftRadius) || 0) >= 40;
      if (!boxed && !pill) plain++;
    }
    // Every chip boxed → a pill row. ALL plain → a tag row ('Harvest · Water · Equilibrium' spans spaced by the row's gap):
    // still ONE flex row of text leaves, each keeping its typography, no Box Preset. A mix is neither. PHP: is_chip_row.
    if (plain > 0 && plain < kids.length) return false;
    if (plain === kids.length) {
      if (!(parseFloat(cs.columnGap || cs.gap) > 0)) return false;
      if (/^space-/.test(cs.justifyContent || '')) return false; // a SPREAD row (brand left, tags right) is a layout row
      for (const k of kids) { if (!/^(SPAN|DIV|LI)$/.test(k.tagName)) return false; if ([...k.children].some((kk) => !/^(SVG|I|EM|STRONG|B)$/.test(kk.tagName))) return false; }
    }
    return true;
  };
  // The chip-row block for a container chipRowOf() accepted (shared by decompose and the cell path).
  const chipsBlockOf = (child) => {
    const _ccs = getComputedStyle(child); const _jc = _ccs.justifyContent || '';
    return { t: 'chips', gap: _ccs.columnGap || _ccs.gap || '', align: /center/.test(_jc) ? 'center' : (/end/.test(_jc) ? 'end' : ''), mt: parseFloat(_ccs.marginTop) || 0, mb: parseFloat(_ccs.marginBottom) || 0,
      keepRowSm: !/column/.test(smOf(child)['flex-direction'] || '') && !/^(block|grid)$/.test(smOf(child).display || ''), // PHONE PASS: still a row at 390px (PHP: keepRowSm)
      items: rowKids(child).map((k) => textLeafBlock(k, k.tagName, (k.className && k.className.toString) ? k.className.toString().trim() : '')) };
  };
  // A grid / flex row that scrolls horizontally (an explicit column auto-flow, a scroll-snap, or tracks wider than the box
  // under overflow-x:auto) → its measure: item width ('minmax(78%, 980px)' → 'max(78%, 980px)'), snap, bottom pad. PHP: is_scroller / scroller_spec.
  const scrollerOf = (el) => {
    const s = getComputedStyle(el);
    if (!/^(auto|scroll)/.test(s.overflowX || '')) return null;
    let hit = /^column/.test(s.gridAutoFlow || '') || (s.scrollSnapType && s.scrollSnapType !== 'none');
    if (!hit && /grid/.test(s.display)) { const sum = String(s.gridTemplateColumns || '').split(/\s+/).reduce((a, t) => a + (parseFloat(t) || 0), 0); const w = el.getBoundingClientRect().width; if (w > 0 && sum > w * 1.2) hit = true; }
    if (!hit) return null;
    let item = String(s.gridAutoColumns || '').trim(); const mm = item.match(/^minmax\(\s*([^,]+),\s*([^)]+)\)$/i); if (mm) item = 'max(' + mm[1].trim() + ', ' + mm[2].trim() + ')';
    if (!item || item === 'auto') { const t0 = parseFloat(String(s.gridTemplateColumns || '')); const w = el.getBoundingClientRect().width; item = (t0 && w) ? (Math.round(t0 / w * 1000) / 10) + '%' : ''; }
    if (!/^[a-z0-9()%.,\s+*\/-]+$/i.test(item)) item = '';
    return { item, snap: (s.scrollSnapType && s.scrollSnapType !== 'none') ? 'start' : '', padB: parseFloat(s.paddingBottom) || 0 };
  };
  // selfOnly: run the chain on EL itself (a cell claimed whole as a row). PHP: claim_element.
  // A flattened wrapper's horizontal inset: its own left/right margin + padding in px. A centred cap (an auto
  // margin, a max-width, a fixed width, or a container / max-w-* class) returns 0/0 — that measure rides maxWidth,
  // and its RESOLVED auto margins would otherwise read as a huge inset. PHP twin: Stitch::el_inset_x.
  const insetXOf = (el) => {
    const z = { l: 0, r: 0 };
    try {
      const cls = ' ' + ((el.className && el.className.toString) ? el.className.toString() : '') + ' ';
      if (/\s(?:mx|ml|mr|ms|me)-auto\s/.test(cls) || /\s(?:container|max-w-(?!none|full))/.test(cls)) return z;
      const cs = getComputedStyle(el);
      if (cs.maxWidth && cs.maxWidth !== 'none') return z;
      // DECLARED width / auto margin (stylesheet or inline) = a centred cap, not an inset.
      const dw = String(el.style.width || sheetDecl(el, 'width') || '').trim();
      if (dw && dw !== 'auto' && dw !== '100%') return z;
      const dml = String(el.style.marginLeft || sheetDecl(el, 'marginLeft') || sheetDecl(el, 'margin') || sheetDecl(el, 'marginInline') || '');
      const dmr = String(el.style.marginRight || sheetDecl(el, 'marginRight') || sheetDecl(el, 'margin') || sheetDecl(el, 'marginInline') || '');
      if (/auto/.test(dml) || /auto/.test(dmr)) return z;
      const ml = parseFloat(cs.marginLeft) || 0, mr = parseFloat(cs.marginRight) || 0;
      // A SKINNED wrapper (a painted / bordered / rounded panel) owns its padding — emitted as a box whose preset carries that
      // inset — so its children take only its MARGIN (else the inset applies twice). PHP: el_inset_x read_card_skin.
      const skinned = !!boxSkinOf(el) || !!(el.parentElement && el.parentElement.children.length === 1 && boxSkinOf(el.parentElement)); // …or the sole child of a skinned wrapper
      const pl = skinned ? 0 : (parseFloat(cs.paddingLeft) || 0), prr = skinned ? 0 : (parseFloat(cs.paddingRight) || 0);
      const cap = 1440 / 4;
      let ml2 = ml, mr2 = mr;
      if (ml < 0 || mr < 0 || ml > cap || mr > cap) { ml2 = 0; mr2 = 0; }
      const desk = { l: Math.max(0, ml2) + Math.max(0, pl), r: Math.max(0, mr2) + Math.max(0, prr) };
      // …and the same inset at 390 / 820 (the tier stamps' margin / padding, else the desktop value). PHP: el_inset_x_tier.
      const sides = (short) => { const pp = String(short || '').trim().split(/\s+/); if (!pp[0] || pp.some((x) => !/^-?[0-9.]+px$/.test(x))) return null; const rr = parseFloat(pp.length >= 2 ? pp[1] : pp[0]), ll = pp.length >= 4 ? parseFloat(pp[3]) : rr; return [ll, rr]; };
      const tier = (m) => { const mm = sides(m.margin) || [ml2, mr2], pd = skinned ? [0, 0] : (sides(m.padding) || [pl, prr]); let a = mm[0], bb = mm[1]; if (a < 0 || bb < 0 || a > cap || bb > cap) { a = 0; bb = 0; } return { l: Math.max(0, a) + Math.max(0, pd[0]), r: Math.max(0, bb) + Math.max(0, pd[1]) }; };
      const tsm = tier(smOf(el)), tmd = tier(mdOf(el));
      return { l: desk.l, r: desk.r, lSm: tsm.l, rSm: tsm.r, lMd: tmd.l, rMd: tmd.r };
    } catch (e) { return z; }
  };
  const paintBlockOf = (child) => {
    try {
      if (!/^(div|span|figure|section)$/i.test(child.tagName)) return null;
      if ((child.textContent || '').trim() !== '' || child.querySelector('img,svg,video,iframe,a')) return null;
      const cs = getComputedStyle(child); if (cs.position === 'absolute' || cs.position === 'fixed') return null;
      const r = child.getBoundingClientRect(); if (r.height < 40) return null;
      const fill = hasBg(cs.backgroundColor), grad = /gradient\(/i.test(cs.backgroundImage || ''), border = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
      if (!fill && !grad && !border) return null;
      const d = [];
      if (fill) d.push('background-color:' + cs.backgroundColor); if (grad) d.push('background-image:' + cs.backgroundImage);
      if (cs.borderRadius && cs.borderRadius !== '0px') d.push('border-radius:' + cs.borderRadius);
      if (border) d.push('border:' + cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor);
      if (cs.boxShadow && cs.boxShadow !== 'none') d.push('box-shadow:' + cs.boxShadow);
      const grow = parseFloat(cs.flexGrow) >= 1 || /(?:^|\s)(?:h-full|flex-1|grow)(?:\s|$)/.test(' ' + String(child.className || '') + ' ');
      if (grow) { d.push('flex:1 1 auto'); d.push('min-height:' + Math.round(r.height) + 'px'); } else d.push('height:' + Math.round(r.height) + 'px');
      d.push('width:100%');
      for (const k of child.children) { const kc = getComputedStyle(k); if (kc.backdropFilter && kc.backdropFilter !== 'none') { d.push('backdrop-filter:' + kc.backdropFilter); break; } }
      return { t: 'paint', css: d.join(';'), mt: Math.round(parseFloat(cs.marginTop) || 0), mb: Math.round(parseFloat(cs.marginBottom) || 0) };
    } catch { return null; }
  };
  const labelCtaRowOf = (child) => {
    try {
      const cs = getComputedStyle(child); if (!/flex/.test(cs.display) || /column/.test(cs.flexDirection)) return null;
      const kids = [...child.children]; if (kids.length < 2 || kids.length > 3) return null;
      let btn = 0, lbl = 0;
      for (const k of kids) {
        const kt = k.tagName.toLowerCase();
        if (kt === 'button' || (kt === 'a' && looksButton(k))) { btn++; continue; }
        if (/^(span|div|p|strong|em|b)$/.test(kt) && !k.querySelector('a,img,svg')) { const t = txt(k).trim(); if (t && t.length <= 40) { lbl++; continue; } }
        return null;
      }
      if (btn < 1 || lbl < 1) return null;
      const cols = kids.map((k) => { const inner = []; decompose(k, inner, '', true); const blocks = inner.filter((b) => b && b.t); if (!blocks.length) { const t = txt(k).trim(); if (!t) return null; blocks.push(textLeafBlock(k, k.tagName, String(k.className || '').trim())); } for (const b of blocks) if (b.t === 'text') b.contentSized = true; return { cls: '', blocks }; }).filter(Boolean);
      if (cols.length < 2) return null;
      const jc = cs.justifyContent, row = { t: 'row', role: 'columns', valign: /flex-end|end/.test(cs.alignItems) ? 'end' : (/center/.test(cs.alignItems) ? 'center' : ''), gap: parseFloat(cs.columnGap) || 0, mt: Math.round(parseFloat(cs.marginTop) || 0), mb: Math.round(parseFloat(cs.marginBottom) || 0), nowrap: true, cols };
      if (/^(space-between|space-around|space-evenly|center|flex-end|end)$/.test(jc)) row.justify = jc;
      return row;
    } catch { return null; }
  };
  const loneIconBlockOf = (child, parent) => {
    try {
      const tag = String(child.tagName || '').toLowerCase();
      const isIcon = tag === 'iconify-icon' || tag === 'svg' || ((tag === 'i' || tag === 'span') && /\b(?:fa|fas|far|fab|bi|ri|material-symbols|material-icons|icon-|lucide)/i.test(String(child.className || '')));
      if (!isIcon || txt(child).trim() !== '') return null;
      for (let a = parent; a && a.tagName; a = a.parentElement) {
        const at = a.tagName.toLowerCase();
        if (/^(a|button|h[1-6]|p|li|label)$/.test(at)) return null;
        if (at === 'body') break;
        if (txt(a).trim() !== '' && a.querySelectorAll('*').length <= 3) return null; // an icon + text lockup (a chip, a meta row) owns its glyph
      }
      const svgEl = tag === 'svg' ? child : child.querySelector('svg');
      const svg = svgEl ? svgEl.outerHTML.replace(/\s+data-sc-[a-z-]+=(?:"[^"]*"|'[^']*')/gi, '') : '';
      const cls = String(child.className || '').trim();
      const fam = (!svg && cls.match(/\b((?:fa[srb]?|bi|ri)\s+[a-z0-9-]+|[a-z]+-[a-z0-9-]+)\b/i)) ? cls.match(/\b((?:fa[srb]?|bi|ri)\s+[a-z0-9-]+|[a-z]+-[a-z0-9-]+)\b/i)[1] : '';
      if (!svg && !fam) return null;
      const cs = getComputedStyle(child);
      let size = 0; for (const v of [cs.fontSize, cs.height, cs.width]) { const n = parseFloat(v); if (n > 0) { size = n; break; } }
      const ta = cs.textAlign;
      // a Lucide glyph's library id rides along (PHP lone_icon_block lucide): a stripped inline svg falls back to the library icon
      const lucideM = svgEl ? String(svgEl.getAttribute('class') || '').match(/(?:^|\s)lucide-([a-z0-9-]+)(?:\s|$)/) : null;
      const lucide = (lucideM && lucideM[1] !== 'lucide') ? 'lucide/' + lucideM[1] : '';
      const out = { t: 'lone_icon', svg, fa: fam, lucide, size: Math.round(size), color: cs.color || '', align: (ta === 'center' || ta === 'right') ? ta : '', mt: Math.round(parseFloat(cs.marginTop) || 0), mb: Math.round(parseFloat(cs.marginBottom) || 0) };
      // The glyph's TILE — a wrapper holding only this glyph, painted (a fill / a ring / a shadow) and sized like a badge
      // (≤ 200px): a ring emblem over a CTA. Its skin rides with the block (PHP lone_icon_block tileCs → an Icon Badge Preset);
      // its own margins / centring stand for the glyph's.
      const tile = child.parentElement;
      if (tile && tile.tagName.toLowerCase() !== 'body' && tile.children.length === 1 && !txt(tile).trim()) {
        const ts = getComputedStyle(tile); const tr = tile.getBoundingClientRect();
        const painted = !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(ts.backgroundColor || '') || parseFloat(ts.borderTopWidth) > 0 || (ts.boxShadow && ts.boxShadow !== 'none');
        if (painted && tr.width > 0 && tr.width <= 200 && tr.height <= 200) {
          out.tile = { w: Math.round(tr.width), h: Math.round(tr.height), bg: ts.backgroundColor, borderW: parseFloat(ts.borderTopWidth) > 0 ? ts.borderTopWidth : '', borderColor: ts.borderTopColor, radius: ts.borderRadius, shadow: ts.boxShadow && ts.boxShadow !== 'none' ? ts.boxShadow : '' };
          out.mt = Math.round(parseFloat(ts.marginTop) || 0); out.mb = Math.round(parseFloat(ts.marginBottom) || 0);
          if (ts.marginLeft === 'auto' || /mx-auto/.test(String(tile.className || ''))) out.align = 'center';
        }
      }
      return out;
    } catch { return null; }
  };
  const decompose = (el, out, inheritAnim = '', selfOnly = false) => {
    let _rat;
    for (const child of (selfOnly ? [el] : [...el.children])) {
      // the section's PATTERN layer (capture data-sc-pattern-layer: a covering dot-grid / tile overlay, possibly under an
      // opacity / blend wrapper) is the section's Background Pattern preset already (sectionPattern) — not an html leftover
      if (child.hasAttribute && (child.hasAttribute('data-sc-pattern-layer') || (!txt(child) && !child.querySelector('img, video, svg') && child.querySelector('[data-sc-pattern-layer]')) || isPatternLayer(child))) continue;
      const vblk = videoBlockOf(child);          // before SKIP: provider IFRAMEs are otherwise skipped
      if (vblk) { out.push(vblk); continue; }
      if (!visibleEl(child)) continue;
      // Structured / interactive native widgets (pricing / steps / timeline / progress / tabs / lottie /
      // svg_draw / accordion / table / feature_list) — TIGHT structural matches offered BEFORE the
      // SKIP/decor/row/text/dive branches, so a real widget maps to its native shortcode instead of
      // verbatim markup. Parity with the PHP Stitch is_* recognizers (which sit above card_grid). svg is
      // handled here first so a draw-SVG isn't lost to the SKIP_TAGS verbatim path just below.
      { const _wblk = structuredWidgetOf(child); if (_wblk) { out.push(_wblk); continue; } }
      // A LONE GLYPH standing on its own as a block (a card header's mark, a section's emblem) — never one inside a link /
      // button / heading / label lockup (those own their icon) → the native icon shortcode. PHP: is_lone_icon / lone_icon_block.
      { const _li = loneIconBlockOf(child, el); if (_li) { out.push(_li); continue; } }
      // An EMPTY PAINTED block IN FLOW (a product card's gradient frame, a swatch): no text / media, a fill / gradient / border
      // of its own, a measured height >= 40px → the native empty Div carrying the paint + its height (or growth). PHP: paint_block.
      { const _pb = paintBlockOf(child); if (_pb) { out.push(_pb); continue; } }
      // A LABEL + BUTTON row (a card's "$2,450 | Acquire"): one row of content-sized cells on the row's justify. PHP: label_cta_row.
      { const _lr = labelCtaRowOf(child); if (_lr) { out.push(_lr); continue; } }
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
          if (dcls !== '' || dsty !== '') {
            // Carry the layer's COMPUTED paint so to-pages can rebuild it as a NATIVE Div instead of
            // raw markup. Reading it here is the only option: rawHtmlOf() does not stamp data-sc-cs,
            // so the downstream engine would otherwise see only a class list it cannot resolve
            // (Tailwind arbitrary values and shadcn CSS-variable palettes both need the computed
            // value). Measured on a 120-site a second AI-page generator corpus: 300 of 359 unmapped `html` leaves (83.6%)
            // are these layers, making them the single largest source of code_blocks.
            const dr = child.getBoundingClientRect();
            out.push({
              t: 'html', html: rawHtmlOf(child, true), decor: true,
              paint: {
                bg:      dcs.backgroundColor || '',
                bgImage: (dcs.backgroundImage && dcs.backgroundImage !== 'none') ? dcs.backgroundImage : '',
                blur:    (dcs.filter && dcs.filter !== 'none') ? ((dcs.filter.match(/blur\(([^)]+)\)/) || [])[1] || '') : '',
                blend:   (dcs.mixBlendMode && dcs.mixBlendMode !== 'normal') ? dcs.mixBlendMode : '',
                radius:  (dcs.borderRadius && dcs.borderRadius !== '0px') ? dcs.borderRadius : '',
                opacity: (dcs.opacity && dcs.opacity !== '1') ? dcs.opacity : '',
                position: dcs.position,
                top: dcs.top, right: dcs.right, bottom: dcs.bottom, left: dcs.left,
                zIndex: (dcs.zIndex && dcs.zIndex !== 'auto') ? dcs.zIndex : '',
                w: Math.round(dr.width), h: Math.round(dr.height),
              },
            });
          }
          continue;
        }
      }
      const tag = child.tagName;
      const cls = (child.className && child.className.toString) ? child.className.toString() : '';
      // Source-animation intent for this child (falls back to an inherited wrapper intent). Stamped onto
      // the leaf blocks this iteration pushes (post-chain, below) so a decomposed heading/text/button/
      // image/testimonials carries the same reveal the source had. Parity with PHP anim_intent.
      const cAnim = animOf(child) || inheritAnim;
      const _animStart = out.length;
      // A testimonials collection → one `testimonials` block (content only; design not preserved).
      // Checked before the gallery/slider branch because a testimonial carousel also has images.
      const tst = testimonialsOf(child);
      if (tst) { out.push({ t: 'testimonials', items: tst.items, anim: cAnim }); continue; }
      // A gallery carousel (image-card slider) → one clean static grid code-block (real slides
      // only, slider chrome + loop clones stripped). Checked first so we never dive into the
      // slick/swiper track (which would emit the loop clones as extra columns).
      if (isSliderContainer(child)) {
        const gh = galleryGridHtml(child);
        if (gh) { out.push({ t: 'html', html: gh, gallery: true }); continue; }
      }
      // An auto-scroll marquee / horizontal reel strip → ONE verbatim code_block (not split into columns).
      if (isMarqueeStrip(child)) { out.push({ t: 'html', html: rawHtmlOf(child, true), marquee: true }); continue; }
      // A logo / "trusted by" strip (>=2 <img>, no headings, NOT an avatar/rating cluster) → native
      // logo_grid (each <img> → one editable logo). Parity PHP is_logo_strip / logo_strip_items.
      if (tag !== 'IMG' && child.querySelectorAll('img').length >= 2
          && !child.querySelector('h1,h2,h3,h4,h5,h6') && !ratingClusterOf(child)) {
        const logos = [...child.querySelectorAll('img')].map((im) => {
          const src = abs(im.currentSrc || im.src || im.getAttribute('data-src') || '');
          if (!src) return null;
          const a = im.closest('a');
          return { url: src, name: im.alt || '', link_url: a ? abs(a.getAttribute('href') || '') : '',
            link_target: (a && a.getAttribute('target') === '_self') ? '_self' : '_blank', svg: '' };
        }).filter(Boolean);
        if (logos.length >= 2) { out.push({ t: 'logo_grid', logos, ...logoStripTreatment(child), html: rawHtmlOf(child, true), anim: cAnim }); continue; }
      }
      // An ICON brand strip (no <img>): sibling items each holding an inline <svg> or an <iconify-icon icon="prefix:name">
      // beside a short visible text label → native logo_grid with the labels SHOWN (the mark is a mark, the text is the
      // brand name). The iconify mark rides the iconify SVG API URL tinted to the strip's colour. PHP: logo_strip_items.
      if (tag !== 'IMG' && !child.querySelector('img,h1,h2,h3,h4,h5,h6,button') && !ratingClusterOf(child)) {
        const items = [...child.children].filter((c) => /^(span|div|a|li)$/i.test(c.tagName));
        if (items.length >= 2 && items.every((c) => c.querySelector('svg,iconify-icon'))) {
          let stripHex = ''; try { const rgb = getComputedStyle(child).color.match(/\d+/g); if (rgb) stripHex = '#' + rgb.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join(''); } catch { /* */ }
          const logos = items.map((c) => {
            const sv = c.querySelector('svg'); const svg = sv ? sv.outerHTML.replace(/ data-sc-[a-z-]+="[^"]*"/g, '') : '';
            const name = txt(c).replace(/\s+/g, ' ').trim();
            let url = '';
            if (!svg) { const ii = c.querySelector('iconify-icon'); const m = ii && String(ii.getAttribute('icon') || '').toLowerCase().trim().match(/^([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)$/); if (m) url = 'https://api.iconify.design/' + m[1] + '/' + m[2] + '.svg?height=32' + (stripHex ? '&color=' + encodeURIComponent(stripHex) : ''); }
            if ((!svg && !url) || name.length > 40) return null;
            const a = c.tagName === 'A' ? c : c.querySelector('a');
            return { url, svg, name, label: !!name, link_url: a ? abs(a.getAttribute('href') || '') : '', link_target: (a && a.getAttribute('target') === '_self') ? '_self' : '_blank' };
          }).filter(Boolean);
          if (logos.length >= 2) { out.push({ t: 'logo_grid', logos, ...logoStripTreatment(child), html: rawHtmlOf(child, true), anim: cAnim }); continue; }
        }
      }
      // CALL-TO-ACTION band → native call_to_action: DISABLED (parity with PHP). The native shortcode
      // is a horizontal title-left/button-right bordered box, the wrong shape for a centered CTA, so a
      // CTA band falls through to the faithful assembled path (centered heading + text + button).
      // ctaBandOf stays defined for a future variant-aware node.
      // { const cta = ctaBandOf(child); if (cta) { out.push({ t: 'cta', ...cta, anim: cAnim }); continue; } }
      // A NEWSLETTER / email-signup <form> → the native `newsletter` shortcode (parity with PHP
      // is_newsletter_form / newsletter_build). Claimed as ONE block so its <input> isn't dropped and the
      // submit button doesn't become a bare text block. The section heading/copy stay separate above it.
      // A SIGNUP LOCKUP without a <form>: an anonymous div holding ONE email / text input (often inside a styled pill
      // wrapper) and ONE labelled submit-shaped button, and nothing else substantial. PHP: is_newsletter_form ($lockup).
      const signupLockup = (el) => {
        if (el.tagName === 'FORM' || !/^(DIV|SECTION|ASIDE)$/.test(el.tagName)) return false;
        const ins = [...el.querySelectorAll('input')]; if (ins.length !== 1) return false;
        const t = (ins[0].type || '').toLowerCase(); if (!(t === '' || t === 'email' || t === 'text')) return false;
        if (/search/i.test(ins[0].placeholder || '')) return false;
        const btn = [...el.querySelectorAll('button')].find((b) => txt(b) && !/^button$/i.test(b.type || '')); if (!btn) return false;
        return !el.querySelector('h1,h2,h3,h4,h5,h6,p,ul,ol,img,video');
      };
      if (tag === 'FORM' || signupLockup(child)) {
        const inputs = [...child.querySelectorAll('input')];
        const bad = inputs.some((i) => /^(password|search)$/i.test((i.type || '')));
        const fields = inputs.filter((i) => { const t = (i.type || '').toLowerCase(); return t === '' || t === 'email' || t === 'text'; });
        if (!bad && fields.length) {
          const emailIn = inputs.find((i) => (i.type || '').toLowerCase() === 'email');
          let emailPh = emailIn ? (emailIn.placeholder || '').trim() : '';
          const texts = inputs.filter((i) => { const t = (i.type || '').toLowerCase(); return t === '' || t === 'text'; }).map((i) => (i.placeholder || '').trim());
          if (!emailPh && texts.length) emailPh = texts.shift();
          const namePh = texts.length ? texts[0] : '';
          const btnEl = child.querySelector('button') || inputs.find((i) => (i.type || '').toLowerCase() === 'submit') || null;
          const btnLabel = btnEl ? (clip(txt(btnEl), 40) || (btnEl.value || '').trim()) : '';
          const bcs = btnEl ? getComputedStyle(btnEl) : null;
          const fcs = fields[0] ? getComputedStyle(fields[0]) : null;
          const incls = fields[0] ? ' ' + String(fields[0].className || '').toLowerCase() + ' ' : '';
          let rounded = 'rounded-0';
          if (/\srounded-full\s/.test(incls)) rounded = 'pill';
          else if (/\srounded(?:-(?:sm|md|lg|xl|2xl|3xl))?\s/.test(incls)) rounded = 'rounded';
          let align = '';
          for (let p = child.parentElement, i = 0; p && i < 5; p = p.parentElement, i++) {
            const pc = ' ' + String(p.className || '').toLowerCase() + ' ';
            if (/\stext-center\s/.test(pc)) { align = 'center'; break; }
            if (/\stext-right\s/.test(pc)) { align = 'right'; break; }
            if (/\stext-left\s/.test(pc)) { align = 'left'; break; }
          }
          // The FIELD WRAPPER — the element that visually IS the field when the input is transparent (a paper pill around an
          // icon + input): its radius decides the roundness, its skin rides on the field, a glyph before the input is the icon.
          // PHP: newsletter_build (wrap / icon / design / gap).
          let wrap = null;
          for (let w = fields[0].parentElement; w && w !== child.parentElement; w = w.parentElement) { const ws = getComputedStyle(w); if ((parseFloat(ws.borderTopLeftRadius) || 0) > 0 || hasBg(ws.backgroundColor) || /gradient\(/.test(ws.backgroundImage || '')) { wrap = w; break; } if (w === child) break; }
          const wcs = wrap ? getComputedStyle(wrap) : null;
          if (wcs) { const wr = parseFloat(wcs.borderTopLeftRadius) || 0; if (wr >= 40) rounded = 'pill'; else if (wr > 0) rounded = 'rounded'; }
          const fieldSkin = wcs ? { bgi: /gradient\(/.test(wcs.backgroundImage || '') ? wcs.backgroundImage : '', bg: hasBg(wcs.backgroundColor) ? wcs.backgroundColor : '', border: ((parseFloat(wcs.borderTopWidth) || 0) > 0 && wcs.borderTopStyle !== 'none') ? wcs.borderTopWidth + ' ' + wcs.borderTopStyle + ' ' + wcs.borderTopColor : '', shadow: (wcs.boxShadow && wcs.boxShadow !== 'none') ? wcs.boxShadow : '', backdrop: (wcs.backdropFilter && wcs.backdropFilter !== 'none') ? wcs.backdropFilter : '', padding: wcs.padding, height: wcs.height, fontSize: fcs ? fcs.fontSize : '', color: fcs ? fcs.color : '' } : null;
          let icon = null, iconColor = '';
          { const scope = wrap || child; for (const g of scope.querySelectorAll('*')) { if (g === fields[0]) break; if (g.tagName === 'SVG') icon = { svg: g.outerHTML }; else if ((g.getAttribute('icon') || '').trim()) icon = { id: g.getAttribute('icon').trim() }; else if ((g.getAttribute('data-lucide') || '').trim()) icon = { id: 'lucide:' + g.getAttribute('data-lucide').trim() }; else if (g.tagName === 'I' && g.className) icon = { cls: String(g.className) }; if (icon) { iconColor = getComputedStyle(g).color; break; } } }
          let phColor = ''; { const m = String(fields[0].className || '').match(/placeholder:text-\[(#[0-9a-f]{3,8})\]/i); if (m) phColor = m[1]; else { try { phColor = getComputedStyle(fields[0], '::placeholder').color || ''; } catch { phColor = ''; } } }
          // The placeholder tint from a Tailwind opacity utility (placeholder-white/90). PHP parity.
          if (!phColor) { const m2 = String(fields[0].className || '').match(/placeholder(?::text)?-(white|black)(?:\/(\d{1,3}))?/i); if (m2) { const a = m2[2] ? Math.max(0, Math.min(100, parseInt(m2[2], 10))) / 100 : 1; phColor = 'rgba(' + (m2[1].toLowerCase() === 'white' ? '255, 255, 255' : '0, 0, 0') + ', ' + a + ')'; } }
          const ccs = getComputedStyle(child);
          let design = 'inline';
          if (btnEl) { const rowBox = /flex/.test(ccs.display) && !/column/.test(ccs.flexDirection) && btnEl.parentElement === child && fields[0].parentElement === child; if ((/\bw-full\b/.test(String(btnEl.className || '')) && !/\b(?:sm|md|lg|xl):w-(?:auto|fit|max|min|\d+)\b/.test(String(btnEl.className || ''))) || (bcs && bcs.width === ccs.width) || (!rowBox && btnEl.parentElement === child) || /grid/.test(ccs.display)) design = 'stacked'; }
          let gap = btnEl ? (parseFloat(bcs.marginTop) || 0) : 0; if (gap <= 0) gap = parseFloat((ccs.rowGap && ccs.rowGap !== 'normal') ? ccs.rowGap : ccs.gap) || 0;
          // CAPSULE (PHP parity): the skinned field wrapper holds the BUTTON too → one pill with the submit inside it.
          if (wrap && btnEl && wrap.contains(btnEl) && design !== 'stacked') design = 'capsule';
          const wrapMaxWidth = wcs && /^[0-9.]+px$/.test(wcs.maxWidth) ? wcs.maxWidth : '';
          const fieldHover = (() => { const m = /hover-self\{([^}]*)\}/.exec((wrap && wrap.getAttribute('data-sc-hover')) || ''); if (m) return m[1]; try { return wrap ? hoverDeclsOf(wrap) : ''; } catch { return ''; } })(); // the wrapper's OWN :hover — the stamp, else the stylesheet rules (extraction runs before the stamp); PHP: field_hover
          out.push({ t: 'newsletter', role: 'newsletter', placeholder: emailPh, name_placeholder: namePh, show_name: !!namePh,
            button_label: btnLabel, align, rounded, design, gap, wrapMaxWidth, inputPadding: fcs ? fcs.padding : '', fieldHover, reveal: revealOf(child),
            button_bg: bcs ? bcs.backgroundColor : '', button_fg: bcs ? bcs.color : '',
            button: btnEl ? { cls: String(btnEl.className || ''), fontSize: bcs.fontSize, textTransform: bcs.textTransform, letterSpacing: bcs.letterSpacing, lineHeight: bcs.lineHeight, height: bcs.height, fontWeight: bcs.fontWeight, pad: bcs.padding, radius: bcs.borderTopLeftRadius, bs: { bg: bcs.backgroundColor, fg: bcs.color, bd: bcs.borderTopColor, bds: bcs.borderTopStyle, bw: bcs.borderTopWidth, grad: /gradient\(/.test(bcs.backgroundImage || '') ? bcs.backgroundImage : '' } } : null,
            field_bg: (fcs && !isTransparent(fcs.backgroundColor)) ? fcs.backgroundColor : '', fieldSkin, placeholderColor: phColor, icon, iconColor,
            fieldFocus: (fields[0].getAttribute && fields[0].getAttribute('data-sc-focus')) || '' }); // the field's :focus skin (capture.mjs stamp; PHP: field_focus)
          continue;
        }
      }
      if (/^H[1-6]$/.test(tag)) {
        const html = richHeading(child) || escHtml(txt(child));
        if (html) { const _hcs = getComputedStyle(child); const _fsd = sheetFontSizeDecl(child); const _rel = _fsd ? fluidRelativeDecls(child, _hcs) : { lh: '', ls: '' }; out.push({ t: 'heading', level: +tag[1], html, text: clip(txt(child), 200), tag: tag.toLowerCase(), cls, wrapCls: headingWrapClass(child), fsDecl: _fsd, lhDecl: _rel.lh, lsDecl: _rel.ls, fontSize: _hcs.fontSize, fontWeight: _hcs.fontWeight, color: _hcs.color, marginBottom: _hcs.marginBottom, marginTop: _hcs.marginTop, lineHeight: _hcs.lineHeight, letterSpacing: _hcs.letterSpacing, align: (_hcs.textAlign || 'left').replace(/^(start|justify)$/, 'left').replace('end', 'right'), longTail: textLongTailOf(child), fontSizeSm: smOf(child)['font-size'] || '', lineHeightSm: smOf(child)['line-height'] || '' }); }
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
          groupCls: (child.parentElement && [...child.parentElement.children].every((k) => looksButton(k) || (k.children.length === 1 && looksButton(k.firstElementChild)))) ? String(child.parentElement.className || '') : '', // wrapper classes → to-pages full-width + wrapper mt/mb spacing, ONLY a buttons-only wrapper (a hero column's mt-12 is not the button's) (PHP parity)
          pad: bcs.padding, height: bcs.height, radius: bcs.borderTopLeftRadius, lineHeight: bcs.lineHeight, fontSize: bcs.fontSize, fontWeight: bcs.fontWeight,
          hover: hoverStyle(child), // NEVER-DROP hover: resolved hover:* colours → to-pages scoped :hover
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
        // fontSize + letterSpacing: the overline has NO native size/letter-spacing option, so carry the
        // computed values (never-drop → scoped .heading-overline CSS in to-pages). Without these the
        // eyebrow lost its size/tracking and rendered in the theme default. Parity with PHP overline_typography_css.
        out.push({ t: 'overline', marginBottom: ocs.marginBottom, marginTop: ocs.marginTop, html: ovHtml, text: clip(txt(child), 60), cls, pill: /rounded-full|inline-flex|inline-block|pill/i.test(cls), color: ocs.color, bg: ocs.backgroundColor, borderW: ocs.borderTopWidth, borderColor: ocs.borderTopColor, radius: ocs.borderRadius, padding: ocs.padding, backdropFilter: (ocs.backdropFilter && ocs.backdropFilter !== 'none' ? ocs.backdropFilter : (ocs.webkitBackdropFilter && ocs.webkitBackdropFilter !== 'none' ? ocs.webkitBackdropFilter : '')), textTransform: ocs.textTransform, fontSize: ocs.fontSize, lineHeight: ocs.lineHeight, letterSpacing: ocs.letterSpacing, fontWeight: ocs.fontWeight, gap: ((ocs.columnGap && ocs.columnGap !== 'normal') ? ocs.columnGap : ocs.gap), iconSvg: ovIcon, iconPos: ovIconPos });
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
          // svg icon — else a font-icon class token. The SVG is the demo "Book a Stay →" arrow that
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
            pad: bcs.padding, height: bcs.height, radius: bcs.borderTopLeftRadius, lineHeight: bcs.lineHeight, fontSize: bcs.fontSize, fontWeight: bcs.fontWeight,
            hover: hoverStyle(bel), // NEVER-DROP hover: resolved hover:* colours → to-pages scoped :hover
            groupRow, groupFirst: ki === 0, groupLast: ki === kids.length - 1,
            bs: { bg: bcs.backgroundColor, fg: bcs.color, bd: bcs.borderTopColor, bds: bcs.borderTopStyle, bw: bcs.borderTopWidth } });
        });
      } else if (chipRowOf(child)) {
        // A CHIP ROW (a flex row of short, pill/box-shaped text labels) → one `chips` block: the row's gap /
        // alignment / margin + each chip as a text leaf (a Text Block wearing a Box Preset). PHP twin: chip_row.
        out.push(chipsBlockOf(child));
      } else if (isTextLeaf(child)) {
        if (txt(child)) { out.push(textLeafBlock(child, tag, cls)); }
      } else if (panelOf(child)) {
        // A SKINNED PANEL holding content (a ring / a glass card) → one panel block; its children decompose inside.
        const pn = panelOf(child); const inner = []; decompose(child, inner, cAnim);
        if (pn.align === 'center') for (const ib of inner) { if (ib && /^(heading|text|overline|button)$/.test(ib.t) && !ib.align) ib.align = 'center'; }
        if (inner.length) out.push({ t: 'panel', ...pn, blocks: inner }); else out.push(...inner);
      } else if (stackOf(child)) {
        // A STACK WITH A GAP (a single-track grid of band cards) → one stack block; children decompose on their own.
        const st = stackOf(child); const inner = []; decompose(child, inner, cAnim);
        if (inner.length >= 2) out.push({ t: 'stack', gap: st.gap + 'px', mt: st.mt, mb: st.mb, items: inner }); else out.push(...inner);
      } else if (isRow(child)) {
        const cols = rowCols(child);
        if (cols.length) {
          // The row's vertical alignment of its columns (source `.row.align-items-center` etc.) →
          // the builder columns' Content Vertical Align. Read computed (works for classes or CSS).
          const _rcs = getComputedStyle(child);
          const ai = (_rcs.alignItems || '').toLowerCase();
          const valign = ai === 'center' ? 'center'
            : ( ( ai === 'flex-end' || ai === 'end' ) ? 'end'
            : ( ( ai === 'flex-start' || ai === 'start' ) ? 'start' : '' ) );
          // Pass #5 — the row's inter-column GAP (px) → spacing-scale distillation onto the section's
          // native Gap option (to-pages sectionGapSlug). column-gap wins; else the `gap` shorthand's
          // last value (row-gap col-gap). Parity with PHP grid_gap_px().
          const _gapRaw = (_rcs.columnGap && _rcs.columnGap !== 'normal') ? _rcs.columnGap
            : ((_rcs.gap && _rcs.gap !== 'normal') ? _rcs.gap.split(' ').pop() : '');
          const gap = parseFloat(_gapRaw) || 0;
          // RESPONSIVE gap layers (base / md: / lg:) from the grid's Tailwind classes, so a source
          // `gap-10 lg:gap-16` keeps its 40px mobile AND 64px desktop gutter on the per-device Section Gap
          // instead of flattening to the single computed value. Parity with PHP grid_gap_responsive().
          const _gcls = ' ' + String(child.className || '') + ' ';
          const _gapPick = (re) => { const m = _gcls.match(re); return m ? parseFloat(m[1]) * 4 : 0; };
          const gapResp = {
            base: _gapPick(/\sgap(?:-x)?-(\d+(?:\.\d+)?)\b/) || gap,
            md: _gapPick(/\smd:gap(?:-x)?-(\d+(?:\.\d+)?)\b/),
            lg: _gapPick(/\slg:gap(?:-x)?-(\d+(?:\.\d+)?)\b/),
          };
          // Carry the raw HTML so a NESTED row that reaches blockToNode (e.g. a bespoke rating /
          // social-proof cluster inside a decomposed hero column) renders verbatim as a CONTAINED
          // code_block instead of an EMPTY one. (A top-level layout row is still built into columns.)
          const rowBlk = { t: 'row', cols, valign, gap, gapResp, html: rawHtmlOf(child, true) };
          // The ROW itself is a CARD (a band: rounded, filled, clipped, min-height) → its skin + min-height ride on the
          // row so to-pages wraps the flexed row in the card's Box Preset at the card's height. PHP: rowBox / minh.
          const rsk = cardSkinOf(child) || edgeSkinOf(child); if (rsk) rowBlk.rowBox = rsk;
          // The row's own main-axis placement (space-between / center / end), inset and margins ride along so a footer row
          // keeps its brand-left / tags-right spread, its 26px top inset and its 64px above. PHP: layout_row justify / pad.
          if (/^(space-between|space-around|space-evenly|center|flex-end|end)$/.test(_rcs.justifyContent || '')) rowBlk.justify = _rcs.justifyContent;
          { const rp = { top: parseFloat(_rcs.paddingTop) || 0, right: parseFloat(_rcs.paddingRight) || 0, bottom: parseFloat(_rcs.paddingBottom) || 0, left: parseFloat(_rcs.paddingLeft) || 0 }; if (rp.top || rp.right || rp.bottom || rp.left) rowBlk.pad = padWithPhone(child, { base: rp }); }
          rowBlk.mt = parseFloat(_rcs.marginTop) || 0; rowBlk.mb = parseFloat(_rcs.marginBottom) || 0;
          // A flex row that does NOT wrap (the default 'nowrap', or a grid) keeps its cells on one line. PHP: nowrap.
          rowBlk.nowrap = /grid/.test(_rcs.display) || !_rcs.flexWrap || _rcs.flexWrap === 'nowrap';
          // TABLET / PHONE PASS: the row's track count at 820px / 390px when it differs (PHP: tracksMd / tracksSm).
          { const tc = (m) => { const v = String(m['grid-template-columns'] || '').trim(); return (!v || v === 'none') ? 0 : v.split(/\s+/).length; }; rowBlk.tracksMd = tc(mdOf(child)); rowBlk.tracksSm = tc(smOf(child)); }
          const scr = scrollerOf(child); if (scr) rowBlk.scroll = scr; // a horizontal scroll strip
          const rmh = parseFloat(_rcs.minHeight); if (/px$/.test(_rcs.minHeight || '') && rmh >= 120) rowBlk.minh = Math.round(rmh);
          out.push(bentoRowsOf(child, rowBlk));
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
        // The media_image builder now reproduces the image's radius / shadow / border / outline / filter / clip-path
        // (imgSkin + imgExtraOf → `selector img`), so only a skin it CANNOT express stays verbatim: a decorative blob
        // class, or a border that differs per side (a `border-l-4` accent). PHP parity: the 'image' recognizer + image_styles.
        const perSide = (() => { const c = getComputedStyle(im); return c.borderTopWidth !== c.borderBottomWidth || c.borderTopWidth !== c.borderLeftWidth || c.borderLeftWidth !== c.borderRightWidth; })();
        const skinClass = /(^|\s)blob/i.test(imCls) || perSide;
        const hasSkin = skinClass;
        if (!/^https?:/.test(src)) { out.push({ t: 'html', html: rawHtmlOf(child, true) }); }
        else if (hasSkin) { out.push({ t: 'html', html: rawHtmlOf(child, true) }); }
        else { out.push({ t: 'image', src, alt: im.alt || '', ...sk, extra: imgExtraOf(im) }); } // + the image's own filter / object-position / aspect-ratio (PHP: img_extra_css)
      } else if (child.children.length && !child.matches('table,figure,ul,ol,dl')) {
        const _dvStart = out.length;
        decompose(child, out, cAnim); // single-column wrapper → dive (carry its reveal intent to children)
        // …and carry the wrapper's HORIZONTAL inset (a plain-CSS `.shell{margin:0 24px}` / `px-6` band wrapper) onto every
        // block it produced. The section shortcode renders a flexbox child with no .fw-container, so this inset is
        // the only thing keeping the band off the viewport edge. Nested wrappers add up; a centred cap (auto
        // margins / max-width / fixed width) is NOT an inset — its measure rides maxWidth. PHP twin: el_inset_x.
        // …its own VERTICAL margin too (a `text-center mb-20` heading wrapper): the top margin rides the first block it produced, the
        // bottom margin the last (mtAdd / mbAdd → the heading's Spacing, else the block's scoped margin). PHP: collect_blocks.
        if (out.length > _dvStart) { try { const wcs = getComputedStyle(child); const wmt = (parseFloat(wcs.marginTop) || 0) + (parseFloat(wcs.paddingTop) || 0), wmb = (parseFloat(wcs.marginBottom) || 0) + (parseFloat(wcs.paddingBottom) || 0); /* margin + the wrapper's own vertical padding (PHP: el_margin + el_padding) */ if (wmt > 0) { const f = out[_dvStart]; if (f && typeof f === 'object') f.mtAdd = Math.max(+f.mtAdd || 0, wmt); } if (wmb > 0) { const l = out[out.length - 1]; if (l && typeof l === 'object') l.mbAdd = Math.max(+l.mbAdd || 0, wmb); } } catch { /* detached */ } }
        { const wx = insetXOf(child); if ((wx.l > 0 || wx.r > 0) && out.length > _dvStart) { for (let _i = _dvStart; _i < out.length; _i++) { const _b = out[_i]; if (!_b || typeof _b !== 'object') continue; const cur = (_b.mxAdd && typeof _b.mxAdd === 'object') ? _b.mxAdd : { l: 0, r: 0 }; _b.mxAdd = { l: (cur.l || 0) + wx.l, r: (cur.r || 0) + wx.r, lSm: (cur.lSm != null ? cur.lSm : (cur.l || 0)) + (wx.lSm != null ? wx.lSm : wx.l), rSm: (cur.rSm != null ? cur.rSm : (cur.r || 0)) + (wx.rSm != null ? wx.rSm : wx.r), lMd: (cur.lMd != null ? cur.lMd : (cur.l || 0)) + (wx.lMd != null ? wx.lMd : wx.l), rMd: (cur.rMd != null ? cur.rMd : (cur.r || 0)) + (wx.rMd != null ? wx.rMd : wx.r) }; } } }
      } else {
        out.push({ t: 'html', html: rawHtmlOf(child, true) }); // media / list / table leaf → verbatim
      }
      // Stamp this iteration's freshly-pushed LEAF blocks with the source reveal intent (parity with
      // apply_block_anim — to-pages enables it only on the standard {enable,yes} shape). Skip verbatim
      // html (decor/undecomposed) so a decorative backdrop doesn't get false motion.
      if (cAnim) { for (let _i = _animStart; _i < out.length; _i++) { const _b = out[_i]; if (_b && _b.t !== 'html' && !_b.anim) _b.anim = cAnim; } }
      // …and the CSS-class reveal (a measured entrance: direction / distance / duration / per-element delay) → Scroll Motion.
      { const _rv = revealOf(child); if (_rv) { for (let _i = _animStart; _i < out.length; _i++) { const _b = out[_i]; if (_b && _b.t !== 'html' && !_b.reveal) _b.reveal = _rv; } } }
      { const _la = loopAnimOf(child); if (_la) { for (let _i = _animStart; _i < out.length; _i++) { const _b = out[_i]; if (_b && !_b.loopAnim) _b.loopAnim = _la; } } } // the element's own running class animation (PHP: loop_anim_of)
      // PHONE PASS: the element is display:none at 390px → every block it produced is hidden on phones (PHP: hideSm).
      if (smOf(child).display === 'none') { for (let _i = _animStart; _i < out.length; _i++) { const _b = out[_i]; if (_b && typeof _b === 'object') _b.hideSm = true; } }
      // SELF-CONTAINMENT — feed the leaf's COMPUTED typography into the block so textBlock()'s existing
      // self-containment reproduces any dropped Tailwind class effect (font-size/line-height/weight/tracking/
      // transform) in the element's Advanced Custom CSS. Only leaves WITHOUT a rich native size option
      // (text/overline) — headings own their size via display_size, buttons already self-contain, structural
      // widgets carry their own skin. Idempotent: only fills fields the block didn't already capture.
      try {
        const _lcs = getComputedStyle(child);
        for (let _i = _animStart; _i < out.length; _i++) {
          const _b = out[_i];
          if (!_b || (_b.t !== 'text' && _b.t !== 'overline')) continue;
          if (_b.fontSize == null) _b.fontSize = _lcs.fontSize;
          if (_b.lineHeight == null) _b.lineHeight = _lcs.lineHeight;
          if (_b.fontWeight == null) _b.fontWeight = _lcs.fontWeight;
          if (_b.letterSpacing == null) _b.letterSpacing = _lcs.letterSpacing;
          if (_b.textTransform == null) _b.textTransform = _lcs.textTransform;
          if (_b.color == null && _lcs.color) _b.color = _lcs.color;
        }
      } catch { /* no computed style available */ }
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
    // background, else a solid CTA band silently converts to no background (the pet-care demo CTA bug).
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
    // a segmented band carries its container's top / bottom padding (see the section-less segmentation; PHP: band_inherit_padding)
    if (el._scPadTopAdd || el._scPadBottomAdd) { const px = (v) => parseFloat(v) || 0; o.padding = Math.round(px(s.paddingTop) + (el._scPadTopAdd || 0)) + 'px ' + Math.round(px(s.paddingRight)) + 'px ' + Math.round(px(s.paddingBottom) + (el._scPadBottomAdd || 0)) + 'px ' + Math.round(px(s.paddingLeft)) + 'px'; }
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
      if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') bump('background-color');
      if ((s.backdropFilter && s.backdropFilter !== 'none') || (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none')) bump('backdrop-filter');
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
      // Carry the RAW id — the to-pages layer slugifies it (slug_from_id parity: lowercase →
      // [a-z0-9-] → trim dashes) so an anchor id like "Our Services" / "sec:pricing" still
      // survives as a clean css_id, matching the PHP section_id() P0 fix. (Was gated to a
      // strict identifier here, which dropped ids the PHP path would have slugged & kept.)
      if (sid && sid.trim()) sections[i].sectionId = sid.trim();
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
    // The section ROOT is itself a horizontal ROW of cells (a segmented band = the `grid md:grid-cols-3` of feature cards):
    // build it as ONE row block from its cells (each a card / column) — decomposing its children instead sent every
    // card cell to the panel path (a nested flexbox holding only the heading). PHP twin: section_root_row.
    const rootRow = (() => {
      try {
        const rcs = getComputedStyle(root);
        const horiz = rcs.display === 'grid' || (/flex/.test(rcs.display) && !/column/.test(rcs.flexDirection || ''));
        if (!horiz || !isRow(root)) return null;
        // an ABSOLUTE child takes no track: the covering bg-video wrapper is the section's backdrop (sec.bgVideo, below),
        // a pinned scroll arrow is decor — counting them as cells kept the hero verbatim (PHP: in-flow children only)
        const absKids = [...root.children].filter((c) => { try { return getComputedStyle(c).position === 'absolute'; } catch { return false; } });
        const flowKids = [...root.children].filter((c) => !absKids.includes(c));
        if (absKids.length && flowKids.length === 1) return null; // a single in-flow child → the plain decompose path (a lone column)
        const cols = rowCols(root);
        if (!cols || cols.length < 2) return null;
        const ai = (rcs.alignItems || '').toLowerCase();
        const valign = ai === 'center' ? 'center' : ((ai === 'flex-end' || ai === 'end') ? 'end' : ((ai === 'flex-start' || ai === 'start') ? 'start' : ''));
        const gapRaw = (rcs.columnGap && rcs.columnGap !== 'normal') ? rcs.columnGap : ((rcs.gap && rcs.gap !== 'normal') ? rcs.gap.split(' ').pop() : '');
        const gap = parseFloat(gapRaw) || 0;
        const gcls = ' ' + String(root.className || '') + ' ';
        const gp = (re) => { const m = gcls.match(re); return m ? parseFloat(m[1]) * 4 : 0; };
        const blk = { t: 'row', cols, valign, gap, gapResp: { base: gp(/\sgap(?:-x)?-(\d+(?:\.\d+)?)\b/) || gap, md: gp(/\smd:gap(?:-x)?-(\d+(?:\.\d+)?)\b/), lg: gp(/\slg:gap(?:-x)?-(\d+(?:\.\d+)?)\b/) }, html: rawHtmlOf(root, true), mt: 0, mb: 0 }; // the root's own margin is the section's rhythm, not the row's
        if (/^(space-between|space-around|space-evenly|center|flex-end|end)$/.test(rcs.justifyContent || '')) blk.justify = rcs.justifyContent;
        return blk;
      } catch { return null; }
    })();
    // A COVERING <video> inside an absolute layer of the section (a hero's backdrop clip) → the section's own background
    // video (to-pages: Background-Pro video + the layer's scrim as the overlay). PHP: apply_bg_video. Read here so the
    // wrapper is neither a cell nor a verbatim leftover.
    const bgv = (() => {
      try {
        const rr = root.getBoundingClientRect(); if (rr.height < 200) return null;
        for (const v of root.querySelectorAll('video')) {
          const blk = videoBlockOf(v); if (!blk || !blk.bg || !(blk.src || blk.webm)) continue;
          const vr = v.getBoundingClientRect(); if (vr.width < rr.width * 0.9 || vr.height < rr.height * 0.9) continue;
          // the layer's scrim: a sibling / descendant of the wrapper painted with a gradient or a translucent colour and no text
          let overlay = ''; let wrap = v.parentElement;
          for (let k = 0; k < 3 && wrap && wrap !== root; k++, wrap = wrap.parentElement) { /* climb to the absolute layer */ if (getComputedStyle(wrap).position === 'absolute') break; }
          const layer = wrap && wrap !== root ? wrap : v.parentElement;
          for (const d of [...(layer ? layer.querySelectorAll('div') : []), ...(layer && layer.parentElement ? [...layer.parentElement.children].filter((x) => x !== layer && !x.contains(v)) : [])]) {
            if ((d.textContent || '').trim() || d.querySelector('video, img')) continue;
            const ds = getComputedStyle(d); if (ds.position !== 'absolute') continue;
            const dr = d.getBoundingClientRect(); if (dr.width < rr.width * 0.9 || dr.height < rr.height * 0.9) continue;
            if (ds.backgroundImage && ds.backgroundImage !== 'none') { overlay = ds.backgroundImage; break; }
            if (ds.backgroundColor && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(ds.backgroundColor)) { overlay = ds.backgroundColor; break; }
          }
          return { src: blk.src || '', webm: blk.webm || '', poster: blk.poster || '', overlay };
        }
      } catch { /* detached */ }
      return null;
    })();
    if (bgv) sections[i].bgVideo = bgv;
    if (rootRow) mapBlocks.push(rootRow); else decompose(root, mapBlocks);
    // the bg video's own block (a lone-video cell / a video leaf the walk produced) is the section's backdrop, not content
    if (bgv) { for (let k = mapBlocks.length - 1; k >= 0; k--) { const b = mapBlocks[k]; if (b && b.t === 'video' && b.bg) mapBlocks.splice(k, 1); else if (b && b.t === 'html' && /<video\b/i.test(String(b.html || '')) && !/<(h[1-6]|p)\b/i.test(String(b.html || ''))) mapBlocks.splice(k, 1); } }
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
    // Every block kind to-pages.mjs emits as a first-class shortcode. A kind that HAS a shortcode must
    // never force its whole section verbatim — that was causing 37 of 44 gate failures across a
    // 120-site a second AI-page generator corpus (feature_list x20, card x6, newsletter x4, logo_grid, rating, pricing,
    // steps, timeline, accordion), and with it 58% of all hero bands. Keep in sync with the
    // `b.t === '<kind>'` arms in to-pages.mjs's _blockToNode.
    const MAPPABLE = [
      'heading', 'button', 'text', 'image', 'video', 'testimonials', 'pill', 'rating',
      'feature_list', 'newsletter', 'logo_grid', 'pricing', 'steps', 'timeline',
      'accordion', 'tabs', 'table', 'progress', 'card', 'cta', 'lottie', 'svg_draw',
    ];
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
      // A section's Custom CSS carries only the rules SPECIFIC to that section. Globally scoped parts
      // (:root / html / body / *, and the pseudo-element forms stripPseudo folds into '*') are already
      // emitted once in the global base/util buckets, so re-including them here copied Tailwind's
      // ~90-property preflight (`*, ::before, ::after { --tw-*: … }`) into EVERY band — a 36.5 KB
      // median per page, 4.86 MB across a 120-site corpus, of user-facing Advanced-tab CSS for zero
      // visual gain. A `--tw-*`-only body is dropped outright: nothing reads those custom properties
      // once Tailwind itself is gone.
      if (/^\s*(?:--tw-[\w-]+\s*:[^;]*;?\s*)+$/.test(String(r.body || ''))) continue;
      const keep = r.parts.filter((p) => {
        const t = stripPseudo(p);
        if (isGlobalSel(t)) return false;
        return matchesIn(root, t);
      });
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
    // A VISIBLE menu list only — a hidden mobile drawer's <ul> (display:none at the capture width) must not be the sample
    // (its 16px/400 links were read as the desktop nav's typography). PHP: detect_menu_styles skips nav_el_hidden links.
    const shown = (u) => { try { return u.getClientRects().length > 0 && getComputedStyle(u).visibility !== 'hidden'; } catch { return false; } };
    let menuUl = [...root.querySelectorAll('.navbar-nav, ul.nav, .nav-menu, .menu, .main-menu')].find(shown) || null;
    if (!menuUl) {
      const uls = [...root.querySelectorAll('ul')].filter((u) => shown(u) && u.querySelectorAll('li a').length >= 2);
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
    // Typography by MODE across the visible top-level links (not the first link, which may be an odd item).
    const mode = (vals) => { const f = {}; for (const v of vals) if (v) f[v] = (f[v] || 0) + 1; return Object.keys(f).sort((a, b) => f[b] - f[a])[0] || ''; };
    const as = [...menuUl.querySelectorAll(':scope > li > a')].filter(shown);
    const a0 = as[0] || menuUl.querySelector('a');
    const lcs0 = a0 ? getComputedStyle(a0) : null;
    const lcs = lcs0 ? { color: mode(as.map((a) => getComputedStyle(a).color)) || lcs0.color, fontSize: mode(as.map((a) => getComputedStyle(a).fontSize)) || lcs0.fontSize, fontWeight: mode(as.map((a) => getComputedStyle(a).fontWeight)) || lcs0.fontWeight, letterSpacing: mode(as.map((a) => getComputedStyle(a).letterSpacing)) || lcs0.letterSpacing, textTransform: mode(as.map((a) => getComputedStyle(a).textTransform)) || lcs0.textTransform, fontFamily: lcs0.fontFamily } : null;
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
    // Parity with the PHP raw_chrome_split densest-column-row detection: a Tailwind grid/flex footer whose
    // columns carry NO `col-*` class (e.g. `grid grid-cols-4` of bare <div>s) yields <2 cols above — the
    // real columns (Quick Links / Contact) were missed and stayed baked into the footer HTML verbatim. Fall
    // back to the densest grid/flex CONTAINER whose direct children are the columns, skipping link-list
    // <ul>s (a menu inside one column) so a 4-link list can't masquerade as the column row.
    if (cols.length < 2) {
      let best = null, bestN = 1;
      root.querySelectorAll('div,ul,section').forEach((el) => {
        const kids = [...el.children];
        if (kids.length < 2) return;
        const listish = kids.filter((k) => /^(LI|A)$/.test(k.tagName)).length;
        if (listish * 2 > kids.length) return; // a link list, not the column row
        if (!/grid|flex/.test(String(el.className || '').toLowerCase())) return;
        if (copyEl && (el === copyEl || el.contains(copyEl)) && kids.length <= 2) return; // the copyright bar
        if (kids.length > bestN) { bestN = kids.length; best = el; }
      });
      if (best) {
        cols = [...best.children].filter((c) => (txt(c).trim() || c.querySelector('img')) && !(copyEl && (c === copyEl || c.contains(copyEl))));
      }
    }
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
    // NEVER-DROP footer COLUMN-HEADING typography (uppercase / tracking / weight / size / colour) from the
    // first column heading — the footer builder has no native heading option, so it's carried as scoped CSS.
    footer_heading_style: (() => {
      if (!footerInfo || !Array.isArray(footerInfo.cols)) return null;
      for (const col of footerInfo.cols) {
        const h = col.querySelector('h2,h3,h4,h5,h6');
        if (h && (h.textContent || '').trim()) {
          const cs = getComputedStyle(h);
          return { transform: cs.textTransform, letterSpacing: cs.letterSpacing, fontWeight: cs.fontWeight, fontSize: cs.fontSize, color: cs.color };
        }
      }
      return null;
    })(),
    // First footer nav LINK's distinctive typography (transform/tracking/weight/size) + hover token — carried
    // as scoped `.footer-menu a` CSS (never-drop). Parity with PHP footer_link_css().
    footer_link_style: (() => {
      if (!footerEl) return null;
      for (const li of footerEl.querySelectorAll('li')) {
        const a = li.querySelector('a');
        if (!a) continue;
        const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.split(/\s+/).length > 4) continue;
        const cs = getComputedStyle(a);
        const hm = String(a.className || '').match(/hover:text-([a-z][a-z0-9-]*)/);
        // List-item vertical spacing — the source's own rhythm (a `space-y-N`/`gap-N` utility or a real
        // computed row-gap / sibling margin-top), so the footer list doesn't render cramped at the theme's
        // 8px default. Walk up to the <ul>/list container. Parity with PHP footer_list_gap_px().
        let gap = 0;
        let n = a;
        for (let i = 0; i < 6 && n && n.getAttribute; i++) {
          const cls = ' ' + String(n.className || '').toLowerCase() + ' ';
          const um = cls.match(/\s(?:space-y|gap-y|gap)-(\d+(?:\.\d+)?)\s/);
          if (um) { gap = parseFloat(um[1]) * 4; break; }
          const gcs = getComputedStyle(n);
          const rg = parseFloat(gcs.rowGap || gcs.gap || '');
          if (rg > 0) { gap = rg; break; }
          const tag = (n.tagName || '').toLowerCase();
          if (tag === 'ul' || tag === 'ol' || tag === 'nav') {
            const lis = n.querySelectorAll(':scope > li');
            if (lis.length >= 2) { const mt = parseFloat(getComputedStyle(lis[1]).marginTop || ''); if (mt > 0) gap = mt; }
            break;
          }
          n = n.parentElement;
        }
        return { transform: cs.textTransform, letterSpacing: cs.letterSpacing, fontWeight: cs.fontWeight, fontSize: cs.fontSize, lineHeight: cs.lineHeight, hover: hm ? hm[1] : '', gap: gap > 0 ? Math.round(gap) : 0 };
      }
      return null;
    })(),
    // Footer TAGLINE typography (first long non-copyright <p>): size / line-height / colour → scoped
    // `.footer-tagline` CSS (never-drop). Parity with PHP footer_tagline_css().
    footer_tagline_style: (() => {
      if (!footerEl) return null;
      for (const p of footerEl.querySelectorAll('p')) {
        const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 40 && !/©|rights reserved|copyright/i.test(t)) {
          const cs = getComputedStyle(p);
          return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color };
        }
      }
      return null;
    })(),
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
        else if (r.type === 1 && r.style && (r.style.maxWidth || /^min\(/.test(String(r.style.width || '').trim()))) {
          // `max-width:Npx`, `max-width:min(Npx, …)` and a `width:min(Npx, …)` shell all declare the cap N;
          // parseFloat alone read `min(…)` as NaN and the design cap of such a shell was never seen.
          const capPx = (v) => { const m = /^(?:min\(\s*)?([0-9.]+)px/.exec(String(v || '').trim()); return m ? parseFloat(m[1]) : 0; };
          const mw = capPx(r.style.maxWidth) || capPx(r.style.width);
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

  // --- deterministic chrome / preset probes (in-browser mirrors of the PHP Stitch builders) ---
  // These read RESOLVED computed styles + semantic classes here (where a live DOM exists) so the
  // node-side consumers (to-theme-settings.mjs / to-presets.mjs) can emit the SAME native Theme-
  // Settings values + presets the PHP FW_Site_Converter_Stitch path produces. KEEP IN SYNC with:
  //   build_button_presets()  →  buttonSkins        (role + computed skin per a/button)
  //   detect_logo()/infer_frame_shape()  →  logoDetail (icon frame shape/bg, wordmark size/weight)
  //   detect_header_chrome_styles()  →  mobileBreakpoint (+ header.bar.maxWidth = container width)
  //   build_spacing_scale()  →  spacingTokens       (arbitrary off-scale spacing lengths)

  const _clsOf = (el) => (el && el.className && el.className.toString ? el.className.toString() : '');
  const _isWhitish = (bg) => { const m = String(bg).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/); return m ? (+m[1] > 240 && +m[2] > 240 && +m[3] > 240) : /^(#fff|#ffffff|white)$/i.test(String(bg).trim()); };

  // Button skins — every short-text a/button, ROLE from the semantic fill class (bg-primary → Primary,
  // bg-secondary/accent/cta → Secondary, whitish+border → Outline, else Fill/Outline), computed skin
  // (fill/text/border/radius/padding/font). Mirror of build_button_presets()'s skin loop.
  const buttonSkins = (() => {
    const out = [];
    document.querySelectorAll('a, button').forEach((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 40) return;
      const s = getComputedStyle(el);
      const bg = s.backgroundColor;
      // GRADIENT FILL — a `.btn-primary { background: linear-gradient(...) }` paints via background-IMAGE, so
      // its background-COLOR is transparent. Reading only bg-color misclassifies it as Outline (or drops it).
      // Capture the linear-gradient and treat it as a fill so the role is Fill and the preset carries the
      // gradient (parity with PHP FW_Site_Converter_Stitch::build_button_presets()).
      const bgImg = s.backgroundImage || '';
      const grad = /(^|\s|,)linear-gradient\(/i.test(bgImg) ? bgImg : '';
      const filled = hasBg(bg) || !!grad;
      let bw = s.borderTopWidth; if (bw === '0px' || bw === '0') bw = '';
      const c = ' ' + _clsOf(el).toLowerCase() + ' ';
      if (!filled && !bw && !/\b(btn|button|cta)\b/.test(c)) return;
      let role;
      // The SOURCE'S OWN semantic button name wins first — `btn-primary` / `button-secondary` / `cta-accent` / BEM
      // `btn--outline` / a bare `primary`. The author already named the role; the preset keeps that name so Theme
      // Settings reads like the source and the mapper's `btn-primary` style resolves to it. Only a source with NO
      // semantic name falls back to the computed-style roles (Fill / Outline). Parity with the PHP stitch.
      const semM = c.match(/\s(?:(?:btn|button|cta)[-_]{1,2})?(primary|secondary|accent|outline|ghost|tertiary)(?:[-_][a-z0-9]+)?\s/);
      const sem = semM ? semM[1] : '';
      if (sem === 'primary') role = 'Primary';
      else if (sem === 'secondary') role = 'Secondary';
      else if (sem === 'accent') role = 'Accent';
      else if (sem) role = 'Outline'; // outline / ghost / tertiary
      else if (/\sbg-(primary|brand)\b/.test(c)) role = 'Primary';
      else if (/\sbg-(secondary|accent|cta)\b/.test(c)) role = 'Secondary';
      else if ((!filled || _isWhitish(bg)) && bw) role = 'Outline';
      else if (filled && !_isWhitish(bg)) role = 'Fill';
      else role = 'Outline';
      out.push({
        role,
        cls: _clsOf(el), // the source's own classes (size-name votes: btn-sm / btn-lg / button--large …)
        bg: hasBg(bg) ? bg : '',
        grad,
        fg: s.color || '',
        bd: bw ? (s.borderTopColor || '') : '',
        bw: bw || '',
        shadow: (s.boxShadow && s.boxShadow !== 'none') ? s.boxShadow : '',
        radius: s.borderRadius || '',
        px: s.paddingLeft || '', py: s.paddingTop || '',
        // FIXED height (h-11) with ~0 vertical padding → the size preset's Min Height (content centres to it),
        // the exact reproduction vs guessing Padding Y. Derive from the `h-N` CLASS first (Tailwind h-N = N×4px)
        // — the computed height is unreliable here (often the ~24px CONTENT height); fall back to computed.
        height: (() => {
          const cls = String((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '');
          const py = parseFloat(s.paddingTop) || 0, fs = parseFloat(s.fontSize) || 16;
          let h = 0; const hm = cls.match(/(?:^|\s)h-(\d{1,2}|\[[0-9.]+(?:px|rem)\])(?:\s|$)/);
          if (hm) { const hv = hm[1]; h = hv[0] === '[' ? parseFloat(hv.replace(/[^0-9.]/g, '')) * (/rem/.test(hv) ? 16 : 1) : parseFloat(hv) * 4; }
          else { h = parseFloat(s.height) || 0; }
          return (py < 4 && h >= 28 && h <= 80 && h > fs * 1.6) ? Math.round(h) + 'px' : '';
        })(),
        fs: s.fontSize || '', lh: s.lineHeight || '',
        // Typography the native colour/size preset fields can't hold → reproduced in the preset Custom CSS
        // (parity with the PHP stitch's appearance_css): font-family (a display face different from the body
        // font), letter-spacing, uppercase, weight. Without ff the converted button silently inherits the body font.
        ff: s.fontFamily || '', ls: s.letterSpacing || '', tt: s.textTransform || '', fw: s.fontWeight || '',
        hoverBg: (hoverStyle(el) || {}).backgroundColor || '',
        // The capture's RESOLVED :hover declarations (`hover-self{transform:translateY(-4px)}`) + the source's own
        // transition, so the preset carries the hover MOTION verbatim (parity with the PHP stitch's skin hov/tr).
        hov: el.getAttribute('data-sc-hover') || '', kf: el.getAttribute('data-sc-keyframes') || '', // the pseudo layers' @keyframes
        tr: s.transition || '',
      });
    });
    return out;
  })();

  // Logo detail — the icon tile (frame shape/bg from its radius vs box) + the wordmark's own span
  // (color/size/weight, and a 2nd-tone accent). Mirror of detect_logo() + infer_frame_shape().
  const inferFrameShape = (radius, boxPx) => {
    radius = String(radius || '').trim();
    if (radius === '' || /^0(px|rem|em)?(\s+0(px|rem|em)?)*$/.test(radius)) return 'square';
    if (radius.indexOf('%') !== -1 || /(?:^|\s)(?:99\d\d|[1-9]\d{4,})px/.test(radius)) return 'circle';
    const rm = radius.match(/([0-9.]+)px/); const r = rm ? parseFloat(rm[1]) : 0;
    const bm = String(boxPx || '').match(/([0-9.]+)px/); const b = bm ? parseFloat(bm[1]) : 0;
    // CSS clamps radius to box/2, so ratio ≥ ~0.5 is a fully-rounded CIRCLE (e.g. rounded-2xl 24px on a
    // 40px tile → circle, not squircle). 0.22–0.5 is the app-icon squircle look. Parity with PHP infer_frame_shape.
    if (r > 0 && b > 0) { const ratio = r / b; if (ratio >= 0.5) return 'circle'; if (ratio >= 0.22) return 'squircle'; return 'rounded'; }
    if (r >= 10) return 'squircle';
    return r > 0 ? 'rounded' : 'square';
  };
  // CSS-COMPOSED MARK → inline SVG. Many modern brands draw the logo ICON in pure CSS — nested absolutely
  // positioned <div>s with gradient/solid fills, rounded corners and a small rotation, no <img>/<svg>. The
  // detectors below then capture nothing and the mark is lost (the wordmark falls back to the site name). We
  // reconstruct it from the LIVE geometry into a faithful, resolution-independent inline SVG: each painted
  // layer → a <rect> (box relative to the mark, corner radius, rotation) filled with its own paint (a linear
  // gradient → an SVG <linearGradient>, else the solid colour). Drops into logo_icon (svg-inline) like any real
  // inline-SVG logo; PHP detect_logo reads the SAME svg off the `data-sc-logo-svg` attribute we stamp.
  const _mkSplitTop = (s) => { const out = []; let depth = 0, cur = ''; for (const ch of s) { if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; } if (cur.trim() !== '') out.push(cur); return out.map((x) => x.trim()); };
  const _mkGradient = (bg) => {
    if (!bg || bg.indexOf('linear-gradient') === -1) return null;
    const inner = bg.slice(bg.indexOf('linear-gradient(') + 16, bg.lastIndexOf(')'));
    const parts = _mkSplitTop(inner); if (!parts.length) return null;
    let dir = 'to bottom', si = 0;
    if (/^(to\s|[-0-9.]+deg|[-0-9.]+rad|[-0-9.]+turn)/.test(parts[0])) { dir = parts[0]; si = 1; }
    const raw = parts.slice(si).filter(Boolean); if (raw.length < 2) return null;
    const stops = raw.map((sr, i) => { const mm = sr.match(/^(.*?)(?:\s+([0-9.]+)%)?$/); return { color: (mm[1] || sr).trim(), off: mm[2] !== undefined ? parseFloat(mm[2]) : (i / (raw.length - 1)) * 100 }; });
    let x1 = 0, y1 = 0, x2 = 0, y2 = 1; const dm = dir.trim().match(/^([-0-9.]+)deg$/);
    if (dm) { const a = parseFloat(dm[1]) * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a); x1 = 0.5 - dx / 2; y1 = 0.5 - dy / 2; x2 = 0.5 + dx / 2; y2 = 0.5 + dy / 2; }
    else { const to = dir.replace('to', ''); const rr = /right/.test(to), l = /left/.test(to), t = /top/.test(to), bo = /bottom/.test(to); x1 = rr ? 0 : (l ? 1 : 0.5); x2 = rr ? 1 : (l ? 0 : 0.5); y1 = bo ? 0 : (t ? 1 : 0.5); y2 = bo ? 1 : (t ? 0 : 0.5); }
    return { x1, y1, x2, y2, stops };
  };
  const _mkAngle = (t) => { if (!t || t === 'none') return 0; const m = t.match(/matrix\(([^)]+)\)/); if (!m) return 0; const n = m[1].split(',').map(parseFloat); return Math.atan2(n[1], n[0]) * 180 / Math.PI; };
  // The header's leftmost logo SLOT — used when there's no brand <a> (a link-less logo like ModFii's
  // `<div class="flex items-center gap-2">…</div>`). Without this the brand falls back to the WHOLE header, so
  // the wordmark harvests the glued nav ("ModFiiFinancingResources…") and a random nav <svg> masquerades as the
  // logo icon. Mirror of PHP header_brand_block(): descend single-child wrappers to the flex row, then the first
  // child slot that isn't the nav / a link cluster and has an <img> or short (≤24 char) text.
  const _mkElChildren = (el) => [...el.children].filter((n) => n.nodeType === 1);
  const _mkBrandBlock = (header) => {
    if (!header) return null;
    let row = header, guard = 0;
    while (guard++ < 6) {
      const kids = _mkElChildren(row);
      if (kids.length === 1 && ['div', 'header', 'a'].indexOf(kids[0].tagName.toLowerCase()) !== -1) { row = kids[0]; continue; }
      break;
    }
    for (const slot of _mkElChildren(row)) {
      const tag = slot.tagName.toLowerCase();
      if (tag === 'nav' || slot.querySelector('nav')) continue;
      if (slot.querySelectorAll('a').length > 1) continue;
      const hasImg = !!slot.querySelector('img');
      const t = (slot.textContent || '').replace(/\s+/g, ' ').trim();
      if (hasImg || (t !== '' && (t.length <= 24 || (t.split(/\s+/).length >= 2 && t.length <= 48)))) return slot;
    }
    return null;
  };
  // The mark ROOT within a brand: the outermost small (≤96px) text-free element whose subtree paints a gradient
  // or an opaque fill — i.e. the decorative icon cluster, not the wordmark.
  const _mkFindMark = (scope) => {
    const cands = [...scope.querySelectorAll('*')].filter((el) => {
      if ((el.textContent || '').trim() !== '') return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width > 96 || r.height > 96) return false;
      return [el, ...el.querySelectorAll('*')].some((n) => { const cs = getComputedStyle(n); return (cs.backgroundImage && cs.backgroundImage.indexOf('gradient') !== -1) || hasBg(cs.backgroundColor); });
    });
    if (!cands.length) return null;
    return cands.find((el) => !cands.some((o) => o !== el && o.contains(el))) || cands[0];
  };
  const _mkSynth = (root) => {
    const rr = root.getBoundingClientRect(), W = Math.round(rr.width), H = Math.round(rr.height);
    if (W < 4 || H < 4) return '';
    const layers = [root, ...root.querySelectorAll('*')].filter((el) => { const cs = getComputedStyle(el); return (cs.backgroundImage && cs.backgroundImage.indexOf('gradient') !== -1) || hasBg(cs.backgroundColor); });
    if (!layers.length) return '';
    let defs = '', rects = '', gi = 0;
    for (const el of layers) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const x = +(r.left - rr.left).toFixed(2), y = +(r.top - rr.top).toFixed(2), w = +r.width.toFixed(2), h = +r.height.toFixed(2);
      if (w < 1 || h < 1) continue;
      const rad = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, w / 2, h / 2);
      const g = _mkGradient(cs.backgroundImage); let fill;
      if (g) { const id = 'g' + (gi++); defs += `<linearGradient id="${id}" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">` + g.stops.map((s) => `<stop offset="${(+s.off).toFixed(1)}%" stop-color="${s.color}"/>`).join('') + '</linearGradient>'; fill = `url(#${id})`; }
      else fill = cs.backgroundColor;
      let tf = ''; const ang = _mkAngle(cs.transform); if (Math.abs(ang) > 0.5) tf = ` transform="rotate(${ang.toFixed(2)} ${(x + w / 2).toFixed(2)} ${(y + h / 2).toFixed(2)})"`;
      rects += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rad.toFixed(2)}"${tf} fill="${fill}"/>`;
    }
    if (!rects) return '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" fill="none" role="img" aria-hidden="true">` + (defs ? `<defs>${defs}</defs>` : '') + rects + '</svg>';
  };
  const logoDetail = (() => {
    const d = { text: '', icon: '', image: '', svg: '', icon_color: '', frame: 'none', frame_bg: '', title_color: '', title_size: '', title_weight: '', title_font: '', title_ls: '', title_hover: '', icon_size: '', title_accent_color: '', title_accent_text: '' };
    if (!headerEl) return d;
    // Brand = the first non-button link whose href is home ('/', '#', or the origin).
    let brand = [...headerEl.querySelectorAll('a')].find((a) => {
      const href = (a.getAttribute('href') || '').trim();
      const home = href === '' || href === '#' || href === '/' || /^https?:\/\/[^/]+\/?$/.test(href);
      return home && !looksButton(a);
    }) || null;
    // The home-anchor candidate is a MENU link inside a LINK CLUSTER (a masthead that IS the <nav>: every '#' link
    // qualifies, so the first menu item became the wordmark + site title). A link-less brand block (icon + wordmark
    // span) that PRECEDES the cluster is the real brand — prefer the leftmost slot. PHP parity: detect_logo.
    if (brand && !brand.querySelector('img') && brand.parentElement && brand.parentElement.querySelectorAll('a').length >= 2) {
      const slot = _mkBrandBlock(headerEl);
      if (slot && slot !== brand && !slot.contains(brand) && (slot.compareDocumentPosition(brand) & Node.DOCUMENT_POSITION_FOLLOWING)) brand = slot;
    }
    brand = brand || _mkBrandBlock(headerEl) || headerEl;
    const img = brand.querySelector('img');
    if (img && !String(img.getAttribute('src') || '').startsWith('data:')) d.image = abs(img.currentSrc || img.src);
    // Wordmark span: the first span whose text is part of the brand's short label; base tone + size/weight,
    // a later differently-coloured span = the accent tone (two-tone wordmark residual).
    const brandTxt = (brand.textContent || '').replace(/\s+/g, ' ').trim();
    if (brandTxt && brandTxt.split(/\s+/).length <= 4 && (brandTxt.length <= 24 || (brandTxt.split(/\s+/).length >= 2 && brandTxt.length <= 48))) d.text = brandTxt;
    let sawBase = false;
    brand.querySelectorAll('span').forEach((sp) => {
      const st = (sp.textContent || '').replace(/\s+/g, ' ').trim();
      if (!st || !d.text || d.text.indexOf(st) === -1) return;
      const cs = getComputedStyle(sp);
      if (!sawBase) {
        if (cs.color) d.title_color = cs.color;
        if (cs.fontSize) d.title_size = cs.fontSize;
        if (/^(300|400|500|600|700|800|900)$/.test(String(parseInt(cs.fontWeight, 10)))) d.title_weight = String(parseInt(cs.fontWeight, 10));
        if (cs.fontFamily) d.title_font = cs.fontFamily;
        if (cs.letterSpacing && cs.letterSpacing !== 'normal' && cs.letterSpacing !== '0px') d.title_ls = cs.letterSpacing;
        sawBase = true;
      } else if (cs.color && d.title_color && cs.color !== d.title_color && d.title_accent_color === '') {
        d.title_accent_color = cs.color;
        // The accent RUN text ("Paws" of a two-tone wordmark) — a real sub-run of the wordmark, so the emit can
        // SPLIT it into ink + <span class="accent">. Mirror of PHP detect_logo's title_accent_text.
        if (st && st !== d.text && d.text.indexOf(st) !== -1) d.title_accent_text = st;
      }
    });
    if (!d.title_color) { const bc = getComputedStyle(brand); d.title_color = bc.color || ''; }
    // Wordmark FONT-FAMILY + LETTER-SPACING fallback (text sat directly on the <a>, no measured span) + the
    // hover colour token (`hover:text-primary`, unreadable from computed :hover) → mapped to a preset var. Mirror of PHP.
    { const bc2 = getComputedStyle(brand);
      if (!d.title_font && bc2.fontFamily) d.title_font = bc2.fontFamily;
      if (!d.title_ls && bc2.letterSpacing && bc2.letterSpacing !== 'normal' && bc2.letterSpacing !== '0px') d.title_ls = bc2.letterSpacing;
      const hm = _clsOf(brand).match(/hover:text-([a-z][a-z0-9-]*)/); if (hm) d.title_hover = hm[1];
    }
    // Icon mark: inline <svg> (verbatim) + its color + an optional colored frame tile ancestor.
    const svg = brand.querySelector('svg');
    if (svg) {
      const mk = svg.outerHTML; if (mk && mk.length < 12000) d.svg = mk.replace(/\s+/g, ' ').trim();
      const scls = _clsOf(svg).toLowerCase();
      d.icon_color = scls.indexOf('text-white') !== -1 ? '#ffffff' : (getComputedStyle(svg).color || '');
      const iw = getComputedStyle(svg).width; if (iw && /^[0-9.]+px$/.test(iw)) d.icon_size = iw;
      let anc = svg.parentNode;
      while (anc && anc !== brand && anc.nodeType === 1) {
        const acs = getComputedStyle(anc);
        const bg = acs.backgroundColor;
        if (hasBg(bg)) {
          d.frame_bg = bg;
          d.frame = inferFrameShape(acs.borderRadius, acs.width);
          if (!d.icon_color) d.icon_color = '#ffffff';
          break;
        }
        anc = anc.parentNode;
      }
    }
    // Iconify web component (`<iconify-icon icon="ph:leaf-bold">`) renders its glyph in SHADOW DOM — there is
    // no light-DOM <svg>, so `brand.querySelector('svg')` above finds nothing and the synth fallback below
    // fabricated the icon CONTAINER's background rect, DROPPING the real glyph (cloud-forest's leaf rendered as
    // an empty translucent circle). Pull the rendered SVG out of the shadow root and stamp it as the logo mark
    // so BOTH the JS path (d.svg) and the PHP path (data-sc-logo-svg, re-parsed from rendered.html) get the leaf.
    if (!d.svg && !img) {
      const ii = brand.querySelector('iconify-icon');
      const sh = ii && ii.shadowRoot ? ii.shadowRoot.querySelector('svg') : null;
      if (sh) {
        const mk = sh.outerHTML;
        if (mk && mk.length < 12000) {
          d.svg = mk.replace(/\s+/g, ' ').trim();
          const iics = getComputedStyle(ii);
          d.icon_color = /text-white/.test(_clsOf(ii)) ? '#ffffff' : (iics.color || '');
          const iw = iics.width; if (iw && /^[0-9.]+px$/.test(iw)) d.icon_size = iw;
          // the icon sits in a coloured tile? carry that frame like the inline-svg path does.
          let anc = ii.parentNode;
          while (anc && anc !== brand && anc.nodeType === 1) { const acs = getComputedStyle(anc); if (hasBg(acs.backgroundColor)) { d.frame_bg = acs.backgroundColor; d.frame = inferFrameShape(acs.borderRadius, acs.width); if (!d.icon_color) d.icon_color = '#ffffff'; break; } anc = anc.parentNode; }
          try { (ii.closest('[data-sc-logo-svg]') || ii.parentElement || ii).setAttribute('data-sc-logo-svg', d.svg); } catch { /* read-only DOM */ }
        }
      }
    }
    // No <img> and no inline <svg>? The icon may be a CSS-COMPOSED mark (gradient <div>s). Reconstruct it as an
    // inline SVG so it survives the conversion, and stamp it on the mark root so the PHP path (detect_logo) reads
    // the same markup off `data-sc-logo-svg`. icon_size = the mark's rendered box so it lands at the source size.
    let synthMark = null;
    if (!d.svg && !img) {
      synthMark = _mkFindMark(brand);
      if (synthMark) {
        const mk = _mkSynth(synthMark);
        if (mk) {
          d.svg = mk;
          const mr = synthMark.getBoundingClientRect();
          if (mr.width) d.icon_size = Math.round(mr.width) + 'px';
          try { synthMark.setAttribute('data-sc-logo-svg', mk); } catch { /* read-only DOM, skip */ }
        } else { synthMark = null; }
      }
    }
    // (No inline svg → a library icon id is already captured on header.logo.icon.)
    // LAYOUT — how the mark + wordmark sit, so the native logo_layout isn't hardcoded inline-left: icon-only
    // (a mark with no wordmark), else inline/stacked by the brand's flex-direction and left/right by whether
    // the icon precedes the wordmark in DOM order. Mirrors the header_logo logo_layout option choices.
    (() => {
      const iconEl = svg || brand.querySelector('img') || synthMark;
      if (!d.text && iconEl) { d.layout = 'icon-only'; return; }
      if (!iconEl || !d.text) { d.layout = 'inline-left'; return; }
      const col = /column/.test(getComputedStyle(brand).flexDirection || '');
      const txtNode = [...brand.querySelectorAll('span')].find((s) => d.text.indexOf((s.textContent || '').trim()) !== -1) || null;
      let iconFirst = true;
      if (txtNode) { iconFirst = !!(iconEl.compareDocumentPosition(txtNode) & 0x04 /* DOCUMENT_POSITION_FOLLOWING */); }
      d.layout = (col ? 'stacked-' : 'inline-') + (iconFirst ? 'left' : 'right');
    })();
    return d;
  })();
  if (header && header.logo) header.logo.detail = logoDetail;

  // Header CTA style class (btn-primary / btn-secondary / btn-outline) from its semantic fill class.
  if (header && header.cta && headerEl) {
    const ctaEl = [...headerEl.querySelectorAll('a, button')].reverse().find((a) => (a.textContent || '').trim() === header.cta.label);
    if (ctaEl) {
      const cc = ' ' + _clsOf(ctaEl).toLowerCase() + ' ';
      if (/\sbg-(primary|brand)\b/.test(cc)) header.cta.style = 'btn-primary';
      else if (/\sbg-(secondary|accent|cta)\b/.test(cc)) header.cta.style = 'btn-secondary';
      else if (cc.indexOf(' border') !== -1 && (cc.indexOf(' bg-white') !== -1 || !/\sbg-(?!transparent)/.test(cc))) header.cta.style = 'btn-outline';
    }
  }

  // Mobile breakpoint — the width at which the inline nav collapses (hidden md:flex / md:hidden → 'md',
  // the lg: variants → 'lg'). Mirror of detect_header_chrome_styles()'s $bp sniff.
  let mobileBreakpoint = '';
  if (headerEl) {
    for (const el of headerEl.querySelectorAll('*')) {
      const c = ' ' + _clsOf(el) + ' ';
      let m = c.match(/\shidden\s+(md|lg):flex\b/) || c.match(/\s(md|lg):hidden\b/);
      if (m) { mobileBreakpoint = m[1]; break; }
    }
  }

  // Footer inner content wrapper max-width (container width parity for the footer, like the header bar).
  let footerContainerMax = '';
  if (footerEl) {
    let best = 0, fluid = false, sawWrap = false;
    for (const el of footerEl.querySelectorAll('*')) {
      const c = ' ' + _clsOf(el).toLowerCase() + ' ';
      const isWrap = c.indexOf(' container ') !== -1 || c.indexOf(' container-fluid ') !== -1 || c.indexOf(' mx-auto ') !== -1 || /\smax-w-/.test(c);
      if (!isWrap) continue;
      sawWrap = true;
      if (c.indexOf(' container-fluid ') !== -1 || /\smax-w-(full|none)\b/.test(c)) fluid = true;
      const mw = getComputedStyle(el).maxWidth;
      const pm = String(mw).match(/^([0-9.]+)px$/);
      if (pm) { const px = parseFloat(pm[1]); if (px >= 320 && px <= 2200 && px > best) best = px; }
    }
    footerContainerMax = best > 0 ? String(Math.round(best)) : (sawWrap && fluid ? 'fluid' : '');
  }

  // Arbitrary off-scale SPACING tokens actually present in the markup (pt-[192px], mb-[3.5rem], …),
  // ≥ 40px, not already on the Tailwind base scale. Mirror of build_spacing_scale()'s harvest.
  const spacingTokens = (() => {
    const html = document.documentElement.outerHTML;
    const re = /\b(?:p[trblxy]?|m[trblxy]?|gap(?:-[xy])?|space-[xy])-\[([0-9.]+(?:px|rem|em))\]/g;
    const seen = new Set(); const out = []; let m;
    while ((m = re.exec(html))) {
      const v = m[1].toLowerCase(); if (seen.has(v)) continue; seen.add(v);
      const pm = v.match(/^([0-9.]+)px$/); const rm = v.match(/^([0-9.]+)(rem|em)$/);
      const px = pm ? parseFloat(pm[1]) : (rm ? parseFloat(rm[1]) * 16 : 0);
      if (px >= 40) out.push({ value: v, px });
    }
    // Pass #5 MEASURED FOLD — a source whose off-scale rhythm lives only in COMPUTED style (a
    // non-Tailwind / visual builder: no `pt-[…]` class to scan) still contributes its real spacing
    // to the editable scale. Sample every element's computed vertical padding/margin and keep the
    // OFF-scale values (≥40px, not within 1px of a base-scale step) as exact px tokens — the SAME
    // values the section distillation emits as `pt-[NNpx]`. Mirror of PHP build_spacing_scale()'s
    // data-sc-cs harvest (same `body *` set, ≥40px threshold, 1px on-scale tolerance, dedupe-by-px).
    const BASE_PX = [0, 4, 8, 16, 24, 48, 56, 64, 72, 80, 96, 112, 128];
    const onScale = (px) => BASE_PX.some((b) => Math.abs(b - px) <= 1);
    const seenPx = new Set(out.map((t) => Math.round(t.px)));
    const measured = [];
    document.querySelectorAll('body *').forEach((el) => {
      const s = getComputedStyle(el);
      for (const prop of ['paddingTop', 'paddingBottom', 'marginTop', 'marginBottom']) {
        const mm = String(s[prop] || '').match(/^([0-9.]+)px$/);
        if (!mm) continue;
        const px = Math.round(parseFloat(mm[1]));
        if (px < 40 || onScale(px) || seenPx.has(px)) continue;
        seenPx.add(px); measured.push({ value: px + 'px', px });
      }
    });
    measured.sort((a, b) => a.px - b.px);
    out.push(...measured);
    return out;
  })();

  // Typography — the source's base body run (densest <p>) + each heading level h1–h6's first real
  // occurrence, measured from live computed styles. MIRROR of PHP detect_typography(); the node
  // consumer (to-theme-settings.mjs) assembles these under the `typography` Theme-Settings key.
  // size = px int; line-height = unitless ratio (computed px ÷ font-size, rounded); letter-spacing =
  // px number ('normal'/0 dropped); family = the first non-generic family in the computed stack.
  const typography = (() => {
    const firstFam = (stack) => {
      const one = String(stack || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
      const generic = ['inherit', 'initial', 'sans-serif', 'serif', 'monospace', 'system-ui', '-apple-system', 'ui-sans-serif', 'ui-serif'];
      return (one === '' || generic.includes(one.toLowerCase())) ? '' : one;
    };
    const lhRatio = (lh, size) => {
      lh = String(lh || '').trim(); size = parseFloat(size) || 0;
      if (lh === '' || lh.toLowerCase() === 'normal' || size <= 0) return '';
      let m = lh.match(/^([0-9.]+)px$/); if (m) return String(Math.round((parseFloat(m[1]) / size) * 100) / 100);
      m = lh.match(/^([0-9.]+)$/); if (m) return String(Math.round(parseFloat(m[1]) * 100) / 100);
      return '';
    };
    const lsPx = (ls) => {
      ls = String(ls || '').trim();
      if (ls === '' || ls.toLowerCase() === 'normal') return '';
      const m = ls.match(/^(-?[0-9.]+)px$/); if (!m) return '';
      const v = Math.round(parseFloat(m[1]) * 100) / 100; return Math.abs(v) < 0.01 ? '' : (v + 'px'); // keep the unit: a bare number reads as em (PHP $ls_px parity)
    };
    const out = {};
    // BODY — the densest paragraph (a real content run, not a caption).
    let bestP = null, bestLen = 0;
    document.querySelectorAll('p').forEach((p) => { const l = txt(p).length; if (l > bestLen) { bestLen = l; bestP = p; } });
    if (bestP) {
      const cs = getComputedStyle(bestP); const b = {};
      const sm = String(cs.fontSize).match(/^([0-9.]+)px$/); if (sm) b.size = Math.round(parseFloat(sm[1]));
      const fam = firstFam(cs.fontFamily); if (fam) b.family = fam;
      const lh = lhRatio(cs.lineHeight, b.size || 0); if (lh !== '') b['line-height'] = lh;
      const ls = lsPx(cs.letterSpacing); if (ls !== '') b['letter-spacing'] = ls;
      if (Object.keys(b).length) out.body = b;
    }
    // HEADINGS h1–h6 — the FIRST occurrence of each level with real text.
    for (const lvl of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const h = [...document.getElementsByTagName(lvl)].find((e) => txt(e) !== '');
      if (!h) continue;
      const cs = getComputedStyle(h); const rec = {};
      const sm = String(cs.fontSize).match(/^([0-9.]+)px$/); if (sm) rec.size = Math.round(parseFloat(sm[1]));
      const w = String(parseInt(cs.fontWeight, 10) || ''); if (/^[1-9]00$/.test(w)) rec.weight = w;
      const fam = firstFam(cs.fontFamily); if (fam) rec.family = fam;
      const lh = lhRatio(cs.lineHeight, rec.size || 0); if (lh !== '') rec['line-height'] = lh;
      const ls = lsPx(cs.letterSpacing); if (ls !== '') rec['letter-spacing'] = ls;
      const tt = String(cs.textTransform || '').toLowerCase(); if (['uppercase', 'lowercase', 'capitalize'].includes(tt)) rec['text-transform'] = tt;
      if (Object.keys(rec).length) out[lvl] = rec;
    }

    // TEXT STYLES (font_sizes) — MIRROR of PHP Stitch::build_text_styles(): a Display scale from the
    // headings (>=20px, largest-first, deduped → display-1..N) + a BODY scale distilled length-weighted
    // from the paragraphs (the DOMINANT paragraph size = the body base → NO preset; each distinct non-base
    // size carrying meaningful text → a stable-classed role: Lead 20/lead · Subtitle 18/font-subtitle ·
    // Small 14/font-small · Caption 12/font-caption) + an Eyebrow (uppercase + tracking). Byte-identical
    // entry shape + classes to PHP so the downstream `font_sizes` consumer + to-pages assignment match.
    out.textStyles = (() => {
      const wtNorm = (w) => { w = String(w || '').trim().toLowerCase(); if (/^[1-9]00$/.test(w)) return w; if (w === 'bold') return '700'; if (w === 'normal') return '400'; return ''; };
      const mk = (name, size, weight, lh, ls, transform, cls) => ({ name, size: String(size), weight: String(weight || ''), line_height: String(lh || ''), letter_spacing: String(ls || ''), transform: String(transform || ''), class: String(cls || '') });
      // --- Display scale from headings (largest rendered size per heading, >=20px). ---
      const disp = {};
      for (const lvl of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
        for (const hn of document.getElementsByTagName(lvl)) {
          const cs = getComputedStyle(hn);
          const sm = String(cs.fontSize).match(/^([0-9.]+)px$/); if (!sm) continue;
          const px = Math.round(parseFloat(sm[1])); if (px < 20) continue;
          if (!disp[px]) { const w = String(parseInt(cs.fontWeight, 10) || ''); disp[px] = { size: px, weight: (/^[1-9]00$/.test(w) ? w : ''), lh: lhRatio(cs.lineHeight, px) }; }
        }
      }
      const dv = Object.values(disp).sort((a, b) => b.size - a.size);
      const dispSizes = {}; dv.forEach((d) => { dispSizes[d.size] = true; });
      // --- Eyebrow / overline: uppercase + tracking, smallest-sized instance. ---
      let eye = null, eyeBest = -1;
      for (const node of document.body.getElementsByTagName('*')) {
        const cs = getComputedStyle(node);
        if (cs.textTransform !== 'uppercase') continue;
        const ls = lsPx(cs.letterSpacing); if (ls === '') continue;
        const sm = String(cs.fontSize).match(/^([0-9.]+)px$/); const sz = sm ? Math.round(parseFloat(sm[1])) : null;
        const score = (sz !== null) ? (1000 - sz) : 0;
        if (score > eyeBest) { eyeBest = score; eye = { size: sz !== null ? String(sz) : '', weight: wtNorm(cs.fontWeight), ls }; }
      }
      // --- Body scale from paragraphs (length-weighted per rounded px). ---
      const blen = {}, brep = {}, breplen = {};
      document.querySelectorAll('p').forEach((p) => {
        const cs = getComputedStyle(p);
        const sm = String(cs.fontSize).match(/^([0-9.]+)px$/); if (!sm) return;
        const px = Math.round(parseFloat(sm[1]));
        const len = txt(p).trim().length; if (len <= 0) return;
        blen[px] = (blen[px] || 0) + len;
        if (len > (breplen[px] || 0)) { breplen[px] = len; brep[px] = p; }
      });
      const bodyPresets = [];
      const sizes = Object.keys(blen).map(Number);
      if (sizes.length) {
        sizes.sort((a, b) => blen[b] - blen[a]);       // most total body text first
        const basePx = sizes[0]; delete blen[basePx];   // dominant = base = no preset
        const MIN_TEXT = 24;
        // Lead: non-base size >= 19 with the most text (fallback 20).
        let leadPx = null, leadLen = -1;
        for (const px of Object.keys(blen).map(Number)) { if (px >= 19 && blen[px] > leadLen) { leadPx = px; leadLen = blen[px]; } }
        const leadSize = leadPx !== null ? leadPx : 20;
        const repMeta = (px) => { const r = brep[px]; if (!r) return { w: '', lh: '', ls: '' }; const cs = getComputedStyle(r); return { w: wtNorm(cs.fontWeight), lh: lhRatio(cs.lineHeight, px), ls: lsPx(cs.letterSpacing) }; };
        const lm = repMeta(leadPx !== null ? leadPx : -1);
        bodyPresets.push({ order: leadSize, name: 'Lead', size: leadSize, weight: (lm.w === '400' ? '' : lm.w), lh: lm.lh, ls: lm.ls, cls: 'lead' });
        const buckets = {}; // class => { name, size, len }
        for (const px of Object.keys(blen).map(Number)) {
          const len = blen[px];
          if (len < MIN_TEXT) continue;
          if (px === leadPx) continue;
          if (px >= 19) continue;
          if (dispSizes[px]) continue;                  // de-dupe vs a heading Display
          let name, cls;
          if (px >= 17) { name = 'Subtitle'; cls = 'font-subtitle'; }
          else if (px >= 13) { name = 'Small'; cls = 'font-small'; }
          else if (px >= 11) { name = 'Caption'; cls = 'font-caption'; }
          else continue;
          if (!buckets[cls] || len > buckets[cls].len) buckets[cls] = { name, size: px, len };
        }
        for (const cls of Object.keys(buckets)) { const bk = buckets[cls]; const m2 = repMeta(bk.size); bodyPresets.push({ order: bk.size, name: bk.name, size: bk.size, weight: (m2.w === '400' ? '' : m2.w), lh: m2.lh, ls: m2.ls, cls }); }
        bodyPresets.sort((a, b) => b.order - a.order);
      }
      // Assemble in the SAME order as PHP: Display 1..N, then body roles (Lead/Subtitle/Small/Caption), then Eyebrow.
      const presets = [];
      const n = Math.min(6, dv.length);
      for (let i = 0; i < n; i++) presets.push(mk('Display ' + (i + 1), dv[i].size, dv[i].weight, dv[i].lh, '', '', 'display-' + (i + 1)));
      if (bodyPresets.length) { for (const bp of bodyPresets) presets.push(mk(bp.name, bp.size, bp.weight, bp.lh, bp.ls, '', bp.cls)); }
      else presets.push(mk('Lead', 20, '', '', '', '', 'lead'));
      if (eye) presets.push(mk('Eyebrow', eye.size, eye.weight, '', eye.ls, 'uppercase', ''));
      return presets;
    })();
    return out;
  })();

  // Does the source use the literal Tailwind `.container` class inside a header/footer/section/main?
  // Signals a RESPONSIVE breakpoint ladder (sm/md/lg/xl/2xl) rather than a single fixed max-width, so
  // to-theme-settings.mjs emits the upper container tiers as scoped @media CSS. Mirror of
  // site_uses_tw_container().
  const usesTwContainer = (() => {
    for (const tag of ['header', 'footer', 'section', 'main']) {
      for (const root of document.getElementsByTagName(tag)) {
        for (const el of root.getElementsByTagName('*')) {
          if ((' ' + _clsOf(el).toLowerCase() + ' ').indexOf(' container ') !== -1) return true; // exact token, not container-fluid
        }
      }
    }
    return false;
  })();

  // FAVICON — the best <link rel="icon"|"apple-touch-icon"|"shortcut icon"> href, resolved absolute.
  // Priority mirrors the PHP detect_favicon(): apple-touch-icon > largest icon (sizes=NxN) > any raster
  // (png/webp/jpg/…) > .ico > /favicon.ico. Consumed by to-design-config.mjs as `favicon`.
  const favicon = (() => {
    const links = [...document.querySelectorAll('link[rel][href]')].filter((l) => {
      const r = (l.getAttribute('rel') || '').toLowerCase();
      return r.includes('icon'); // covers "icon", "shortcut icon", "apple-touch-icon"
    }).map((l) => {
      const r = (l.getAttribute('rel') || '').toLowerCase();
      const href = abs(l.getAttribute('href') || '');
      const sz = (l.getAttribute('sizes') || '').match(/(\d+)\s*[x×]\s*(\d+)/i);
      const path = href.replace(/[?#].*$/, '');
      return {
        href, apple: r.includes('apple-touch-icon'), size: sz ? +sz[1] : 0,
        raster: /\.(png|jpe?g|webp|gif|avif)$/i.test(path) || (r.includes('apple-touch-icon') && !/\.(ico|svg)$/i.test(path)),
        ico: /\.ico$/i.test(path),
      };
    }).filter((c) => c.href && !/^data:/i.test(c.href));
    const apples = links.filter((c) => c.apple).sort((a, b) => b.size - a.size);
    if (apples.length) return apples[0].href;
    const sized = links.filter((c) => c.size > 0).sort((a, b) => b.size - a.size);
    if (sized.length) return sized[0].href;
    const raster = links.find((c) => c.raster);
    if (raster) return raster.href;
    const ico = links.find((c) => c.ico);
    if (ico) return ico.href;
    try { return new URL('/favicon.ico', location.href).href; } catch { return ''; }
  })();

  // BOX CENSUS — every distinct box SKIN on the page (fill + border + radius + shadow + backdrop, plus
  // hover-lift from `hover:` classes), clustered by full skin. Feeds the Box Presets library so glass
  // panels, stat boxes, tinted cards and pills ALL get a preset — not just icon-box cards. Mirror of the
  // PHP build_box_presets() detection; fill is in the key so red/green tints don't merge.
  const boxCensus = (() => {
    const skip = new Set(['HTML', 'HEAD', 'BODY', 'SECTION', 'NAV', 'HEADER', 'FOOTER', 'MAIN', 'SCRIPT', 'STYLE', 'SVG', 'PATH', 'BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'IMG']);
    const nc = (c) => { c = String(c || '').trim().toLowerCase(); const m = c.match(/rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)(?:[,\s/]+([0-9.]+))?/); if (!m) return ''; const a = m[4] === undefined ? 1 : parseFloat(m[4]); if (a === 0) return ''; return a < 1 ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})` : `rgb(${m[1]}, ${m[2]}, ${m[3]})`; };
    const map = new Map();
    const els = document.querySelectorAll('div,article,li,span,aside');
    for (let i = 0; i < els.length && i < 4000; i++) {
      const el = els[i]; if (skip.has(el.tagName)) continue;
      const cs = getComputedStyle(el);
      const radius = (parseFloat(cs.borderTopLeftRadius) || 0) > 0 ? cs.borderTopLeftRadius : '';
      const bw = (parseFloat(cs.borderTopWidth) || 0) > 0 ? cs.borderTopWidth : '';
      const shadow = (cs.boxShadow && cs.boxShadow !== 'none') ? cs.boxShadow : '';
      const fill = nc(cs.backgroundColor);
      // GRADIENT fill — a gradient card paints via background-IMAGE (transparent background-color); read it so the
      // skin counts as filled and the Box Preset carries it (parity with PHP box_slug / build_box_presets).
      const gradient = /(^|\s|,)linear-gradient\(/i.test(cs.backgroundImage || '') ? cs.backgroundImage : '';
      const backdrop = (cs.backdropFilter && cs.backdropFilter !== 'none') ? cs.backdropFilter : ((cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none') ? cs.webkitBackdropFilter : '');
      if (!(radius || shadow || backdrop) || !(fill || gradient || bw || shadow || backdrop)) continue; // a card/panel/chip, not a section
      const r = el.getBoundingClientRect(); if (r.width < 40 || r.height < 24) continue;
      const cls = String(el.className || '');
      const key = fill + '|' + radius + '|' + shadow.replace(/\s+/g, '') + '|' + bw + '|' + (bw ? nc(cs.borderTopColor) : '') + '|' + backdrop.replace(/\s+/g, '') + '|' + gradient.replace(/\s+/g, '');
      if (!map.has(key)) map.set(key, { fill, gradient, radius, borderWidth: bw, borderStyle: cs.borderTopStyle, borderColor: cs.borderTopColor, shadow, backdrop, padding: cs.padding, hoverLift: /hover:-?translate-y-/.test(cls), count: 0 });
      map.get(key).count++;
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 40);
  })();

  return {
    title: document.title,
    favicon,
    tailwind: detectTailwind(), // source built with Tailwind → mapper trusts the `styles.tw` token intent
    typography, usesTwContainer,
    // The site container's declared side gutter (capture.mjs stamp) → to-theme-settings layout_container_gutter.
    // The browser-measured / declared site content width (capture.mjs stamp) → to-theme-settings layout_container_width
    // when the header / footer carry no container of their own (PHP: detect_site_content_width).
    contentWidth: (() => { try { const w = parseInt(document.documentElement.getAttribute('data-sc-content-width') || '0', 10); return w >= 600 && w <= 2400 ? w : 0; } catch { return 0; } })(),
    phonePass: document.documentElement.getAttribute('data-sc-phone-pass') === '1', // the capture measured 390px too (PHP: phonePass)
    contentGutterSm: (() => { try { const g = parseInt(document.documentElement.getAttribute('data-sc-content-gutter-sm') || '0', 10); return g > 0 && g <= 120 ? g : 0; } catch { return 0; } })(), // the container's phone gutter (PHP: declared_container_gutter_sm)
    contentGutter: (() => { try { const g = parseInt(document.documentElement.getAttribute('data-sc-content-gutter') || '0', 10); return g > 0 && g <= 200 ? g : 0; } catch { return 0; } })(),
    contentGutterInside: (() => { try { return document.documentElement.getAttribute('data-sc-content-gutter-inside') === '1'; } catch { return false; } })(), // the gutter is the container's own padding (inside its measured width)
    // A PAGE-WIDE fixed video backdrop: ONE <video> pinned behind all content by a position:fixed full-viewport wrapper
    // (a body-level .bg-video-container) → the theme's Site Background video layer in FIXED mode, never a section
    // background (PHP: detect_page_fixed_video / el_is_page_fixed_layer). { mp4, webm, poster } or null.
    pageFixedVideo: (() => {
      try {
        const full = (el) => { const cs = getComputedStyle(el); if (cs.position !== 'fixed') return false; const r = el.getBoundingClientRect(); return r.width >= innerWidth * 0.95 && r.height >= innerHeight * 0.9; };
        // …or a PARTIAL-WIDTH page backdrop: a fixed, viewport-TALL, unframed layer (no radius — a framed one is a floating
        // portal) behind the content (z-index <= 1 / pointer-events none), anchored to one side (a 60vw right anchor with a
        // radial mask). Its geometry / mask / filter / a decor glow sibling ride Misc CSS on .site-bg-video (PHP:
        // page_backdrop_layer_of / page_backdrop_css).
        const backdrop = (el) => { const cs = getComputedStyle(el); if (cs.position !== 'fixed') return false; const r = el.getBoundingClientRect(); if (r.height < innerHeight * 0.9) return false; if (parseFloat(cs.borderTopLeftRadius) > 0) return false; const z = parseInt(cs.zIndex, 10); if (!(isNaN(z) || z <= 1 || cs.pointerEvents === 'none')) return false; return !el.querySelector('a') && (el.textContent || '').trim() === ''; };
        for (const v of document.querySelectorAll('video')) {
          let host = null, partial = null; for (let a = v, d = 0; a && a !== document.body && d < 6; a = a.parentElement, d++) { if (/^(section|main|header|footer)$/i.test(a.tagName)) break; if (full(a)) { host = a; break; } if (!partial && backdrop(a)) { partial = a; } }
          if (!host && partial) host = partial;
          if (!host) continue;
          if ((host.textContent || '').trim().length > 40) continue;
          const css = (() => {
            if (!partial || host !== partial) return '';
            const hc = getComputedStyle(host), r = host.getBoundingClientRect(), d = [];
            if (r.width < innerWidth * 0.95) { d.push('width:' + (Math.round(r.width / innerWidth * 1000) / 10) + 'vw'); if (r.left > 4) { d.push('left:auto'); d.push('right:0'); } else { d.push('right:auto'); d.push('left:0'); } }
            const mask = hc.maskImage && hc.maskImage !== 'none' ? hc.maskImage : (hc.webkitMaskImage && hc.webkitMaskImage !== 'none' ? hc.webkitMaskImage : ''); if (mask) { d.push('-webkit-mask-image:' + mask); d.push('mask-image:' + mask); }
            if (hc.opacity && hc.opacity !== '1') d.push('opacity:' + hc.opacity);
            if (hc.mixBlendMode && hc.mixBlendMode !== 'normal') d.push('mix-blend-mode:' + hc.mixBlendMode);
            const out = []; if (d.length) out.push('.site-bg-video{' + d.join(' !important;') + ' !important;}');
            const vc = getComputedStyle(v), vd = []; if (vc.filter && vc.filter !== 'none') vd.push('filter:' + vc.filter); if (vc.objectPosition && !/^50%\s+50%$/.test(vc.objectPosition)) vd.push('object-position:' + vc.objectPosition); if (vc.opacity && vc.opacity !== '1') vd.push('opacity:' + vc.opacity);
            if (vd.length) out.push('.site-bg-video video{' + vd.join(';') + ';}');
            for (const k of host.children) { if (k === v || k.tagName === 'VIDEO' || (k.textContent || '').trim()) continue; const kc = getComputedStyle(k), kd = []; if (kc.backgroundImage && kc.backgroundImage !== 'none') kd.push('background-image:' + kc.backgroundImage); if (kc.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(kc.backgroundColor)) kd.push('background-color:' + kc.backgroundColor); if (!kd.length) continue; if (kc.mixBlendMode && kc.mixBlendMode !== 'normal') kd.push('mix-blend-mode:' + kc.mixBlendMode); if (kc.opacity && kc.opacity !== '1') kd.push('opacity:' + kc.opacity); out.push('.site-bg-video::after{content:"";position:absolute;inset:0;pointer-events:none;' + kd.join(';') + ';}'); break; }
            return out.join('\n');
          })();
          let mp4 = v.getAttribute('src') || '', webm = '';
          for (const so of v.querySelectorAll('source')) { const ss = so.getAttribute('src') || ''; const st = (so.getAttribute('type') || '').toLowerCase(); if (!ss) continue; if (!webm && (st === 'video/webm' || /\.webm(\?|$)/i.test(ss))) webm = ss; if (!mp4 && (st === 'video/mp4' || /\.mp4(\?|$)/i.test(ss))) mp4 = ss; }
          if (!mp4 && !webm) continue;
          return { mp4: mp4 ? abs(mp4) : '', webm: webm ? abs(webm) : '', poster: v.getAttribute('poster') ? abs(v.getAttribute('poster')) : '', css };
        }
      } catch { /* best-effort */ }
      return null;
    })(),
    // The page SHELL's own stylesheet rules (PHP: page_shell_css): the rules the source <body> / <main> wear by their OWN
    // classes (not resolvable utilities) + the @keyframes they animate, re-targeted at the theme's body / main.site-main.
    // A scroll-driven background shift (view-timeline / animation-timeline) on <main> is the case in point.
    pageShellCss: (() => {
      try {
        const DROP = /(?:^|;)\s*(?:display|position|top|right|bottom|left|width|min-width|max-width|height|min-height|margin[a-z-]*|padding[a-z-]*|overflow[a-z-]*|flex[a-z-]*|grid[a-z-]*|z-index)\s*:[^;]*;?/gi;
        const TYPE = /(?:^|;)\s*(?:font[a-z-]*|color|line-height|letter-spacing|-webkit-font-smoothing|-moz-osx-font-smoothing|text-rendering)\s*:[^;]*;?/gi;
        const utility = (c) => /^(?:[a-z]+:)*(?:text|font|bg|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|flex|grid|gap|w|h|min-w|max-w|rounded|border|antialiased|tracking|leading|uppercase|relative|absolute|fixed|overflow-[a-z]+|z-\d+|items-[a-z]+|justify-[a-z]+|opacity-\d+|hidden|block|inline[a-z-]*)(?:-|$)/.test(c);
        const rulesOf = () => { const out = []; for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch { continue; } const walk = (list) => { for (const r of list) { if (r.cssRules && r.media) { walk(r.cssRules); continue; } out.push(r); } }; walk(rules); } return out; };
        const all = rulesOf(); let out = '';
        for (const [tag, target] of [['body', 'body:not(.wp-admin)'], ['main', 'main.site-main']]) {
          const el = document.querySelector(tag); if (!el) continue;
          const toks = []; if (el.id) toks.push('#' + el.id); for (const c of String(el.className || '').split(/\s+/)) { if (c && /^[A-Za-z_][\w-]*$/.test(c) && !utility(c)) toks.push('.' + c); }
          const bareRe = new RegExp('^' + tag + '(::?[a-z-]+)?$', 'i'); // …plus the element's own bare rules (a layered body gradient, a fixed body::before grid)
          const anims = new Set(); let part = '';
          for (const r of all) {
            if (!r.selectorText || !r.style) continue;
            const sels = r.selectorText.split(',').map((x) => x.trim()).filter((one) => toks.some((t) => one.includes(t)) || bareRe.test(one));
            if (!sels.length) continue;
            const pseudo = /::?(before|after)\b/i.test(r.selectorText); // a pseudo LAYER's placement (fixed, inset:0, z-index:-1) is its design
            let body = pseudo ? r.style.cssText : r.style.cssText.replace(DROP, ''); if (tag === 'body') { for (let k = 0; k < 3; k++) body = body.replace(TYPE, ''); }
            body = body.replace(/^[\s;]+|[\s;]+$/g, ''); if (!body) continue;
            const an = r.style.getPropertyValue('animation-name') || (r.style.getPropertyValue('animation') || '').split(/\s+/)[0]; if (an && an !== 'none') anims.add(an.trim());
            part += sels.map((one) => one.replace(new RegExp('(?:' + tag + ')?(' + toks.map((t) => t.replace(/[.#]/g, '\$&')).join('|') + ')(?![\w-])', 'gi'), target)).join(',') + '{' + body + ';}';
          }
          for (const r of all) { if (r.type === CSSRule.KEYFRAMES_RULE && anims.has(r.name)) part += r.cssText.replace(/\s+/g, ' '); }
          if (part.includes(target + '{') || part.includes(target + ':')) out += (out ? '\n' : '') + part;
        }
        return out;
      } catch { return ''; }
    })(),
    // The page's FIXED decorative PATTERN layer: a body-level fixed full-viewport wrapper (no text / media) painting a gradient
    // grid or a data-URI tile → the Site Background Pattern (PHP: detect_page_fixed_pattern). A blurred glow blob is a fill, not a tile.
    pageFixedPattern: (() => {
      try {
        for (const wrap of document.body.children) {
          const wcs = getComputedStyle(wrap); if (wcs.position !== 'fixed') continue;
          const r = wrap.getBoundingClientRect(); if (r.width < innerWidth * 0.95 || r.height < innerHeight * 0.9) continue;
          if ((wrap.textContent || '').trim() || wrap.querySelector('img,video,svg,iframe,canvas')) continue;
          for (const c of [wrap, ...wrap.querySelectorAll('*')]) {
            const cs = getComputedStyle(c); const img = String(cs.backgroundImage || '').trim();
            if (!img || img === 'none' || img.length > 3000 || /url\((?!"?data:image\/svg)/i.test(img) || !/gradient\(|data:image\/svg/i.test(img)) continue;
            const sz = String(cs.backgroundSize || '').trim();
            if (/blur\(/.test(cs.filter || '') || (!/repeating-|data:image\/svg/i.test(img) && !/^[0-9.]+px/.test(sz))) continue;
            return { image: img, opacity: Math.min(1, parseFloat(cs.opacity) || 1), size: /^[a-z0-9.%,\s-]+$/i.test(sz) ? sz : '', repeat: (cs.backgroundRepeat && cs.backgroundRepeat !== 'repeat') ? cs.backgroundRepeat : '' };
          }
        }
      } catch { /* best-effort */ }
      return null;
    })(),
    tokens: { vars, brandColor, brandHover, body: pick(bodyCS, ['fontFamily', 'color', 'backgroundColor', 'lineHeight', 'fontSize']) },
    layout: { container_max: containerMax },
    baseHeading,
    header, footer, sections, chrome,
    buttonSkins, mobileBreakpoint, spacingTokens, footerContainerMax, boxCensus,
    assets: { images: [...imgs].filter((u) => /^https?:/.test(u)), fonts },
  };
}
