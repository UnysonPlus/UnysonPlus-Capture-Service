// Map a design-capture → the Site Converter's design-config (stylings only — the
// logo and brand stay the WordPress site's own at render time). Mirror of the PHP
// FW_Site_Converter_Theme_Generator::from_capture so EITHER file feeds the generator
// (the admin "Generate theme" tool auto-detects a raw capture too).
export function toDesignConfig(cap) {
  const firstFamily = (stack) => {
    if (!stack) return '';
    const f = String(stack).split(',')[0].trim().replace(/^["']|["']$/g, '');
    const generic = ['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'inherit'];
    return generic.includes(f.toLowerCase()) ? '' : f;
  };
  const nz = (v) => {
    v = (v || '').toString().trim();
    return (v === '' || v === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(v)) ? '' : v;
  };
  const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
  const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));

  const tokens = cap.tokens || {}, vars = tokens.vars || {}, body = tokens.body || {};
  const head = cap.header || {}, foot = cap.footer || {}, assets = cap.assets || {};
  const origin = originOf(cap.url || '');

  // The THEME heading font must come from an actual <h1>/<h2>, NOT the logo. A logo's <a> wrapper
  // often computes to the BODY font (the brand text is a nested <span class="font-heading">), so
  // sampling the logo first mis-detected the heading font as Inter when every real heading is Nunito.
  // Priority: a section's heading → the brand-token heading sample → last resort the logo.
  const headingFace = (cap.sections || []).find((s) => s.headingComputed?.fontFamily)?.headingComputed?.fontFamily
    // Fallback: the page-wide heading sample (set by the brand-token sampler) — the only source
    // on a scroll-hijacked page, where there are no in-flow sections to read a heading from.
    || cap.baseHeading?.fontFamily
    || head.logo?.computed?.fontFamily || '';
  const headingFont = firstFamily(headingFace);
  const bodyFont = firstFamily(body.fontFamily);

  const families = [headingFont, bodyFont].filter(Boolean).map((f) => f.replace(/ /g, '+'));
  const google = (assets.fonts || []).find(
    (u) => /fonts\.googleapis\.com\/css/i.test(u) && !/Material\+(Symbols|Icons)/i.test(u) && families.some((f) => new RegExp(f, 'i').test(u)),
  ) || (assets.fonts || []).find((u) => /fonts\.googleapis\.com\/css/i.test(u) && !/Material\+(Symbols|Icons)/i.test(u)) || '';

  // Icon webfont (Material Symbols) — disabled until card icons are emitted as inline
  // SVG (icon_box esc_html's non-SVG custom_icon), so we don't load an unused font.
  const icons = '';

  // Accent / brand color. The naive pick is the `--primary` CSS var, but sites that bundle
  // Bootstrap (the plugin itself does) ship `--primary:#007bff` (BS4) / `#0d6efd` (BS5) as the
  // DEFAULT and override the real brand color only on custom classes (e.g. the gold CTA button).
  // So when `--primary` is exactly a Bootstrap default AND the CTA carries a non-neutral color,
  // trust the CTA — otherwise it's blue everywhere when the site is actually orange/gold/etc.
  const toRGB = (c) => {
    c = String(c || '').trim();
    let m = /^#([0-9a-f]{3})$/i.exec(c);
    if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
    m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = /^rgba?\(([^)]+)\)/i.exec(c);
    if (m) { const p = m[1].split(',').map((s) => parseFloat(s)); return [p[0], p[1], p[2]]; }
    return null;
  };
  const toHex = (c) => { const r = toRGB(c); return r ? '#' + r.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('') : ''; };
  const isNeutral = (c) => { const r = toRGB(c); if (!r) return false; return (Math.max(...r) - Math.min(...r)) <= 24; }; // white/black/gray have ~no hue
  const BOOTSTRAP_PRIMARY = ['#007bff', '#0d6efd'];
  const cssPrimary = nz(vars['--primary']);
  // Page-wide brand color (dominant non-neutral button fill) — the most reliable brand
  // signal; the header CTA can be a transparent text link (then this catches the gold
  // `.btn` elsewhere on the page). Falls back to the header CTA, then nav color.
  const brand = nz(tokens.brandColor);
  const ctaBg = nz(head.cta?.computed?.backgroundColor);
  const navColor = nz(head.nav?.[0]?.computed?.color);
  const brandPick = (brand && !isNeutral(brand)) ? brand : ((ctaBg && !isNeutral(ctaBg)) ? ctaBg : '');
  const primaryIsBootstrapDefault = BOOTSTRAP_PRIMARY.includes(toHex(cssPrimary));
  const accent = (primaryIsBootstrapDefault && brandPick)
    ? brandPick
    : (cssPrimary || brandPick || navColor || ctaBg);

  // Pill buttons report an absurd px radius (e.g. 3.35e7px) — clamp to 9999px.
  const clampRadius = (r) => {
    r = (r || '').toString().trim();
    const m = /^([0-9]*\.?[0-9]+(?:e\+?[0-9]+)?)px$/i.exec(r);
    if (m) return parseFloat(m[1]) > 100 ? '9999px' : r;
    return r;
  };

  // Logo styling — text logos only (image logos keep defaults + the Site Logo).
  const lc = head.logo?.computed || {};
  const logoStyle = (!head.logo || head.logo.type === 'text')
    ? prune({ font: firstFamily(lc.fontFamily), size: lc.fontSize || '', weight: (lc.fontWeight || '').toString(), color: nz(lc.color), letter_spacing: (lc.letterSpacing && lc.letterSpacing !== 'normal') ? lc.letterSpacing : '' })
    : {};
  // Button styling — copied from the source CTA's computed style, incl. its :hover state
  // (parsed from the button's hover:* utilities in capture-extract; used to be dropped).
  const cc = head.cta?.computed || {};
  // Prefer the brand (primary body) button's :hover over the header CTA's — the header CTA
  // is often a bag/search/icon button whose hover isn't the primary button's.
  const bh = tokens.brandHover || {};
  const ch = head.cta?.hover || {};
  const ctaStyle = prune({
    bg: nz(cc.backgroundColor), color: nz(cc.color), radius: clampRadius(cc.borderRadius),
    padding: (cc.padding || '').toString().trim(), font_weight: (cc.fontWeight || '').toString(),
    hover_bg: nz(bh.backgroundColor || ch.backgroundColor), hover_color: nz(bh.color || ch.color), hover_border: nz(bh.borderColor || ch.borderColor),
  });

  const label = (head.cta?.label || '').trim();
  const navLabels = (head.nav || []).map((n) => (n.label || '').trim().toLowerCase());
  const localizeHref = (href) => {
    href = (href || '').trim();
    if (href === '' || href === '#') return '/#get-started';
    if (origin && href.toLowerCase().startsWith(origin.toLowerCase())) {
      const rest = href.slice(origin.length) || '/';
      return rest[0] === '/' ? rest : '/' + rest;
    }
    return href;
  };
  const titleToName = (t) => {
    t = (t || '').trim();
    if (!t) return 'Converted Site';
    return (t.split(/\s+[—–\-|·:]\s+/u)[0] || '').trim() || 'Converted Site';
  };
  const name = titleToName(cap.title);

  // Header nav → menu items (drop the CTA label — it's the button), hrefs de-branded.
  const headerMenu = (head.nav || [])
    .map((n) => ({ label: (n.label || '').trim(), href: n.href }))
    .filter((n) => n.label && !(label && n.label.toLowerCase() === label.toLowerCase()))
    .map((n) => ({ label: n.label, url: localizeHref(n.href) }));

  // Footer content — copied as an editable starting point. Link columns → menu items
  // (group title → top-level item with the links as children; flat links → top-level).
  let footerMenu = [];
  if (foot.groups && foot.groups.length) {
    foot.groups.forEach((g) => {
      const title = (g.title || '').trim();
      const links = (g.links || []).map((l) => ({ label: l.label || '', url: localizeHref(l.href) }));
      if (title) footerMenu.push({ label: title, url: '#', children: links });
      else footerMenu = footerMenu.concat(links);
    });
  } else if (foot.links) {
    footerMenu = foot.links.map((l) => ({ label: l.label || '', url: localizeHref(l.href) }));
  }
  // Keep socials that carry a NETWORK (from the icon class) OR a label OR a real URL — so icon-only
  // `href="#"` circles (network sniffed by icon) survive, matching the PHP detect_footer_social path.
  const footerSocial = (foot.social || []).filter((s) => (s.net || '').trim() || (s.label || '').trim() || /^https?:/i.test(s.href || ''))
    .map((s) => ({ label: (s.label || '').trim(), url: localizeHref(s.href), net: (s.net || '').trim() }));
  // Structured CONTACT column (icon+text rows) — passed through verbatim for the native leading-icon list.
  const footerContact = foot.contact && Array.isArray(foot.contact.rows) && foot.contact.rows.length
    ? { title: foot.contact.title || '', rows: foot.contact.rows } : null;
  // A newsletter / signup column (heading + email input + button) → carried through so the emit keeps the
  // 4th footer column instead of dropping it. Mirror of PHP detect_footer_columns' newsletter branch.
  const footerNewsletter = foot.newsletter && foot.newsletter.title
    ? { title: foot.newsletter.title, tagline: foot.newsletter.tagline || '', placeholder: foot.newsletter.placeholder || '', button: foot.newsletter.button || 'Subscribe' } : null;
  // Keep only the editable tail after the "© year brand." sentence as a starter tagline.
  const taglineFromCopyright = (copy) => {
    copy = (copy || '').trim();
    if (!copy) return '';
    const parts = copy.split(/\.\s+/);
    return parts.length >= 2 && parts.slice(1).join('. ').trim()
      ? parts.slice(1).join('. ').trim().replace(/\.*$/, '.') : '';
  };

  // Hero decorative pattern (the faint "+" overlay) — from the first section that has one.
  const heroPattern = (cap.sections || []).map((s) => s.bgPattern).find(Boolean) || null;

  return {
    theme: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''), mode: 'child' },
    // Source favicon (absolute URL) — bundled into the child theme + used as the Site Icon / <head> link
    // by the PHP theme generator. Same field name the PHP path emits, so the generator consumes either.
    ...(cap.favicon ? { favicon: cap.favicon } : {}),
    hero: heroPattern ? { pattern: heroPattern } : {},
    layout: prune({ container_max: (cap.layout && cap.layout.container_max) || '' }),
    fonts: prune({ heading: headingFont, heading_weight: (cap.baseHeading && cap.baseHeading.weight) || '', body: bodyFont, google, icons }),
    colors: prune({
      ink: nz(body.color), accent, bg: nz(body.backgroundColor),
      // The theme's DEFAULT heading colour must be the DOMINANT heading tone (usually the ink used by
      // the h1's base text), NOT an accent. The brand-token sampler can land on a coloured <span>
      // inside a heading (FreshPaws: h1 = ink "Your Pet's" + green "Second Home"), which mis-set every
      // heading to green — turning the ink hero title green AND the white-on-green CTA heading invisible
      // (green on green). Prefer the first real section heading's own colour; per-heading overrides
      // (e.g. a white CTA heading) are carried separately by headingNode's title_color.
      heading: nz((cap.sections || []).find((s) => s.headingComputed?.color)?.headingComputed?.color || cap.baseHeading?.color),
      header_bg: nz(head.bar?.backgroundColor),
      footer_bg: nz(foot.computed?.backgroundColor), footer_text: nz(foot.computed?.color),
    }),
    header: {
      style: 'bar', menu_location: 'primary',
      sticky: ['fixed', 'sticky'].includes(head.element?.position),
      menu: headerMenu,
      logo: logoStyle,
      cta: {
        enabled: label !== '', label: label || 'Get started',
        href: localizeHref(head.cta?.href), dedupe_from_menu: label !== '' && navLabels.includes(label.toLowerCase()),
        style: ctaStyle,
      },
    },
    footer: { widget_area: true, brand: true, copyright: taglineFromCopyright(foot.copyright), menu: footerMenu, social: footerSocial, contact: footerContact, newsletter: footerNewsletter },
    background: { dotted: false },
  };
}
