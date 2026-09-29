/**
 * PAGE DISCOVERY — find the pages a site actually has, before capturing any of them.
 *
 * WHY THIS EXISTS. Discovery used to be one thing: `homeCapture.header.nav`, the links found inside the
 * header element and filtered to labels under 30 characters. On a real source that published 133 URLs in
 * its sitemap, the converter found 2 — because the nav was not a plain row of links. A drawer that is
 * closed at capture time, or a mega-menu that mounts on hover, yields almost nothing, and nothing in the
 * pipeline noticed: the conversion reported success with two pages.
 *
 * So discovery is a UNION of four sources, cheapest and most authoritative first:
 *
 *   1. SITEMAP — `robots.txt`'s `Sitemap:` lines, then the usual paths. Authoritative, complete, and it
 *      costs one fetch with no browser render. A sitemap index is followed one level down.
 *   2. HEADER NAV — what the old code used. Still useful: it tells us which pages the site considers
 *      primary, which is what should be pre-selected in a picker.
 *   3. FOOTER LINKS — where sites put the pages the header omits (legal, about, contact).
 *   4. IN-PAGE LINKS — same-origin anchors anywhere on the rendered home page, the catch-all.
 *
 * Every URL carries WHERE IT CAME FROM, because that is what lets a picker pre-select sensibly instead of
 * dumping 133 equal-looking checkboxes on someone.
 */

const UA = 'Mozilla/5.0 (compatible; UnysonPlusCapture/1.0; +https://unysonplus.com)';

/** One fetch with a timeout that actually fires — `fetch` alone will hang on a silent host. */
async function fetchText(url, ms = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Normalise to a comparable same-origin URL, or null when it is not a page of this site. */
export function normalizeUrl(href, origin) {
  if (!href) return null;
  let u;
  try { u = new URL(String(href).trim(), origin); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.origin !== origin) return null;
  u.hash = '';
  u.search = '';                                  // a filtered/paginated view is the same page
  // A file is not a page. Kept deliberately short: anything not obviously an asset stays in, because a
  // missing page is a worse error than one extra row in a list the user is about to review anyway.
  if (/\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|gz|mp4|webm|mp3|wav|css|js|json|xml|rss|txt|woff2?|ttf|eot)$/i.test(u.pathname)) return null;
  if (/^\/wp-(admin|login|json|content|includes)\b/i.test(u.pathname)) return null;
  u.pathname = u.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  return u.href;
}

/** `<loc>` values from a sitemap or sitemap index. */
function locsOf(xml) {
  const out = [];
  const rx = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = rx.exec(xml))) out.push(m[1].replace(/&amp;/g, '&'));
  return out;
}

/**
 * Every URL the site's own sitemap declares. Follows a sitemap index one level (capped), because that is
 * how WordPress and most SEO plugins publish more than a few hundred URLs.
 */
export async function sitemapPages(origin, { maxIndexes = 8, cap = 2000 } = {}) {
  const tried = new Set();
  const found = new Set();
  const candidates = [];

  const robots = await fetchText(origin + '/robots.txt', 8000);
  if (robots) {
    for (const line of robots.split(/\r?\n/)) {
      const m = /^\s*sitemap:\s*(\S+)/i.exec(line);
      if (m) candidates.push(m[1]);
    }
  }
  candidates.push(origin + '/sitemap.xml', origin + '/sitemap_index.xml', origin + '/wp-sitemap.xml');

  let indexesLeft = maxIndexes;
  while (candidates.length && found.size < cap) {
    const next = candidates.shift();
    const abs = normalizeUrl(next, origin) ? next : next;   // sitemaps may legitimately live off-path
    if (tried.has(abs)) continue;
    tried.add(abs);
    const xml = await fetchText(abs, 12000);
    if (!xml) continue;
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    for (const loc of locsOf(xml)) {
      if (isIndex) {
        if (indexesLeft-- > 0) candidates.push(loc);
        continue;
      }
      const n = normalizeUrl(loc, origin);
      if (n) found.add(n);
      if (found.size >= cap) break;
    }
  }
  return [...found];
}

/** Same-origin anchors in a chunk of HTML. Used for the footer and the in-page catch-all. */
export function linksInHtml(html, origin) {
  const out = new Set();
  if (!html) return [];
  const rx = /<a\b[^>]*\shref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  let m;
  while ((m = rx.exec(html))) {
    const raw = m[1].replace(/^['"]|['"]$/g, '');
    const n = normalizeUrl(raw, origin);
    if (n) out.add(n);
  }
  return [...out];
}

/** The first path segment — the grouping key that makes a long list readable. */
export function groupOf(url, origin) {
  let p;
  try { p = new URL(url).pathname; } catch { return ''; }
  const seg = p.split('/').filter(Boolean);
  return seg.length ? seg[0] : '';
}

/**
 * Merge every source into one ranked list.
 *
 * `sources` is a map of name → array of URLs. The output keeps the ranking a picker needs: the home page,
 * then pages the NAV points at (the site's own idea of what matters), then everything else by depth and
 * path. Each entry records every source that produced it, so "in the nav" and "sitemap only" stay
 * distinguishable — that distinction is what makes a sensible default selection possible.
 */
export function mergePages(sources, origin, homeUrl) {
  const home = normalizeUrl(homeUrl || origin, origin) || origin;
  const byUrl = new Map();
  for (const [name, list] of Object.entries(sources)) {
    for (const u of list || []) {
      const n = normalizeUrl(u, origin);
      if (!n) continue;
      if (!byUrl.has(n)) byUrl.set(n, { url: n, sources: [] });
      const e = byUrl.get(n);
      if (!e.sources.includes(name)) e.sources.push(name);
    }
  }
  byUrl.delete(home);

  const rows = [...byUrl.values()].map((e) => {
    const path = new URL(e.url).pathname;
    const depth = path.split('/').filter(Boolean).length;
    return { ...e, path, depth, group: groupOf(e.url, origin), inNav: e.sources.includes('nav') };
  });

  rows.sort((a, b) => (b.inNav - a.inNav) || (a.depth - b.depth) || a.path.localeCompare(b.path));
  return [{ url: home, path: '/', depth: 0, group: '', inNav: true, sources: ['home'], home: true }, ...rows];
}

/**
 * Discover a site's pages.
 *
 * `renderedHtml` is optional: pass the home page's rendered HTML when a browser has already loaded it (a
 * JS-built site links nothing in its static markup, so without it we fall back to sitemap + raw HTML).
 * `nav` / `footerHtml` are optional extras from a capture that already ran.
 */
export async function discoverPages({ url, renderedHtml = '', nav = [], footerHtml = '' } = {}) {
  let origin;
  try { origin = new URL(url).origin; } catch { return { ok: false, error: 'bad-url', pages: [] }; }

  const sources = {};
  sources.sitemap = await sitemapPages(origin);
  sources.nav = (nav || []).map((n) => (typeof n === 'string' ? n : n && n.href)).filter(Boolean);
  sources.footer = linksInHtml(footerHtml, origin);

  // Only pay for the static fetch when we have no rendered HTML to read instead.
  const html = renderedHtml || (sources.sitemap.length ? '' : (await fetchText(url)) || '');
  sources.page = linksInHtml(html, origin);

  const pages = mergePages(sources, origin, url);
  const groups = {};
  for (const p of pages) {
    const k = p.group || '(top level)';
    groups[k] = (groups[k] || 0) + 1;
  }
  return {
    ok: true,
    origin,
    total: pages.length,
    counts: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.length])),
    groups,
    pages,
  };
}
