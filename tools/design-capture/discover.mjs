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

/**
 * A BOT-SHAPED CLIENT GETS TURNED AWAY. Discovery fetched the sitemap and the home page with Node's own
 * `fetch`, and a bot-style User-Agent. A site behind a bot filter answers that with 403 — measured on a real
 * source: `robots.txt` 200 (so the sitemap URL was read), then the sitemap and the home page both 403, a 75 KB
 * challenge page. Every source came back empty and the picker offered ONE page, the root, as though the site
 * had no others. It has five in its nav alone.
 *
 * Changing the User-Agent is not enough: Node's fetch is refused whatever UA it sends, while curl with an
 * ordinary UA is served normally — the filter is reading the client, not the string. So when a static fetch
 * is refused, ask the REAL BROWSER this service already drives for capture. That browser renders the same
 * site successfully (which is why the home page converts), so it is the honest way to read the same public
 * pages we are about to render anyway.
 */
let _browserPromise = null;
let _ctxPromise = null;

/**
 * Read a URL through the real browser.
 *
 * The fetch is issued INSIDE a page on the target origin, not by navigating to the URL. Two reasons, both
 * measured: a navigation to an XML sitemap lands in Chrome's XML VIEWER, and `page.content()` then returns
 * the viewer's DOM — no `<loc>` elements, so the sitemap parsed as empty even though it had fetched fine;
 * and a fetch from the page shares the browser's cookies, so the clearance a bot filter sets on the first
 * navigation is reused instead of being re-challenged for every sub-sitemap.
 */
async function browserText(url, ms = 20000) {
  try {
    if (!_browserPromise) {
      const { chromium } = await import('playwright-core');
      _browserPromise = chromium.launch({ channel: 'chrome', headless: true });
    }
    const browser = await _browserPromise;
    const origin = new URL(url).origin;
    if (!_ctxPromise || _ctxPromise.origin !== origin) {
      _ctxPromise = { origin, page: (async () => {
        const pg = await browser.newPage();
        await pg.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: ms }).catch(() => {});
        return pg;
      })() };
    }
    const page = await _ctxPromise.page;
    const out = await page.evaluate(async ([u, t]) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), t);
      try {
        const r = await fetch(u, { redirect: 'follow', signal: ac.signal });
        if (!r.ok) return null;
        return await r.text();
      } catch { return null; } finally { clearTimeout(timer); }
    }, [url, ms]);
    if (out) return out;
    // Last resort: navigate. Fine for HTML, and harmless when the in-page fetch was merely blocked by CORS.
    const pg2 = await browser.newPage();
    try {
      const r = await pg2.goto(url, { waitUntil: 'domcontentloaded', timeout: ms });
      if (r && !r.ok()) return null;
      return await pg2.content();
    } finally { await pg2.close().catch(() => {}); }
  } catch {
    return null;
  }
}

/** Closes the discovery browser, if one was started. Safe to call when none was. */
export async function closeDiscoveryBrowser() {
  if (!_browserPromise) return;
  const p = _browserPromise;
  _browserPromise = null;
  _ctxPromise = null;
  try { (await p).close(); } catch { /* already gone */ }
}

/** True when the last fetchText() was REFUSED (blocked / errored) rather than simply empty. */
let _lastFetchBlocked = false;
export function lastFetchBlocked() { return _lastFetchBlocked; }

/**
 * Is this body the KIND of document we asked for?
 *
 * A 2xx is not always content. Bot mitigation answers a throttled client with a short 202 (measured: 192
 * bytes) or a 200 interstitial, and `r.ok` accepts both — the empty result then looks like a site with no
 * pages rather than a request that was turned away, which is the exact silence this path exists to break.
 * Length alone is the wrong test (a robots.txt is legitimately tiny), so judge by shape: a sitemap must
 * carry sitemap elements, a page must carry markup.
 */
function looksLike(body, kind) {
  if (!body) return false;
  if (kind === 'xml')  return /<(?:urlset|sitemapindex|loc)[\s>]/i.test(body);
  if (kind === 'html') return /<(?:html|body|a)[\s>]/i.test(body);
  return true; // robots.txt and friends: any 2xx text will do
}

/** One fetch with a timeout that actually fires — `fetch` alone will hang on a silent host. */
async function fetchText(url, ms = 12000, kind = 'text') {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  let refused = false;
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': UA } });
    if (r.ok) {
      const body = await r.text();
      if (looksLike(body, kind)) return body;
      refused = true; // served, but not the document we asked for
    } else {
      refused = true;
    }
  } catch {
    refused = true;
  } finally {
    clearTimeout(t);
  }
  // Refused, not empty — try the real browser before giving up, and remember that we had to.
  const viaBrowser = await browserText(url, Math.max(ms, 20000));
  if (looksLike(viaBrowser, kind)) return viaBrowser;
  if (refused) _lastFetchBlocked = true;
  return null;
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
/**
 * KIND FROM THE SITEMAP THAT LISTED IT.
 *
 * WordPress splits its sitemap by post type — `post-sitemap.xml`, `page-sitemap.xml`,
 * `category-sitemap.xml`, `author-sitemap.xml`, `post_tag-sitemap.xml` — which is an authoritative
 * classification handed to us for free. Discovery fetched all of them and merged the results into one
 * undifferentiated list, so a blog archive of 120 articles arrived looking exactly like 120 pages, and
 * converting them produced 120 WordPress PAGES: absent from the blog index, the feed, categories and tags.
 *
 * An ARCHIVE (category / author / tag) is not content at all — WordPress generates those. Converting one
 * yields a static duplicate that fights the real archive and goes stale the moment a post is added.
 */
function sitemapKind(sitemapUrl) {
  const f = String(sitemapUrl || '').toLowerCase();
  if (/(?:^|[/_-])(category|post_tag|tag|author)[_-]?sitemap/.test(f)) return 'archive';
  if (/(?:^|[/_-])post[_-]?sitemap/.test(f)) return 'post';
  if (/(?:^|[/_-])page[_-]?sitemap/.test(f)) return 'page';
  // WordPress core's own naming: wp-sitemap-posts-post-1.xml / wp-sitemap-posts-page-1.xml
  if (/wp-sitemap-taxonomies/.test(f) || /wp-sitemap-users/.test(f)) return 'archive';
  if (/wp-sitemap-posts-page/.test(f)) return 'page';
  if (/wp-sitemap-posts-post/.test(f)) return 'post';
  return '';
}

/** A URL that is an archive by its PATH, for sources whose sitemaps are not split by type. */
function archiveByPath(u) {
  return /^\/(category|tag|author|archives?)(\/|$)/i.test(u.pathname || '');
}

export async function sitemapPages(origin, { maxIndexes = 8, cap = 2000 } = {}) {
  const tried = new Set();
  const found = new Map(); // url -> kind ('' when the sitemap name says nothing)
  const candidates = [];

  const robots = await fetchText(origin + '/robots.txt', 8000, 'text');
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
    const xml = await fetchText(abs, 12000, 'xml');
    if (!xml) continue;
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const kind = sitemapKind(abs);
    for (const loc of locsOf(xml)) {
      if (isIndex) {
        if (indexesLeft-- > 0) candidates.push(loc);
        continue;
      }
      const n = normalizeUrl(loc, origin);
      if (!n) continue;
      let k = kind;
      if (!k) { try { k = archiveByPath(new URL(n)) ? 'archive' : ''; } catch { k = ''; } }
      // First listing wins, but a real kind always beats a blank one.
      if (!found.has(n) || (k && !found.get(n))) found.set(n, k);
      if (found.size >= cap) break;
    }
  }
  return [...found.entries()].map(([url, kind]) => ({ url, kind }));
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
    for (const raw of list || []) {
      // A source may hand us a bare URL or a { url, kind } record (the sitemap knows the type).
      const href = (raw && typeof raw === 'object') ? raw.url : raw;
      const kind = (raw && typeof raw === 'object') ? (raw.kind || '') : '';
      const n = normalizeUrl(href, origin);
      if (!n) continue;
      if (!byUrl.has(n)) byUrl.set(n, { url: n, sources: [], kind: '' });
      const e = byUrl.get(n);
      if (!e.sources.includes(name)) e.sources.push(name);
      if (kind && !e.kind) e.kind = kind;
    }
  }
  byUrl.delete(home);

  const rows = [...byUrl.values()].map((e) => {
    const path = new URL(e.url).pathname;
    const depth = path.split('/').filter(Boolean).length;
    // Nothing said what it is: a path that looks like an archive still is one, and anything else is
    // treated as a page — the safe default, since converting a page as a page is what always happened.
    let kind = e.kind;
    if (!kind) { kind = /^\/(category|tag|author|archives?)(\/|$)/i.test(path) ? 'archive' : 'page'; }
    return { ...e, kind, path, depth, group: groupOf(e.url, origin), inNav: e.sources.includes('nav') };
  });

  // Pages first, then posts, then archives; within a kind the old ordering stands.
  const rank = (k) => (k === 'page' ? 0 : k === 'post' ? 1 : 2);
  rows.sort((a, b) => (rank(a.kind) - rank(b.kind)) || (b.inNav - a.inNav) || (a.depth - b.depth) || a.path.localeCompare(b.path));
  return [{ url: home, path: '/', depth: 0, group: '', kind: 'page', inNav: true, sources: ['home'], home: true }, ...rows];
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

  _lastFetchBlocked = false;
  const sources = {};
  sources.sitemap = await sitemapPages(origin);
  sources.nav = (nav || []).map((n) => (typeof n === 'string' ? n : n && n.href)).filter(Boolean);
  sources.footer = linksInHtml(footerHtml, origin);

  // Only pay for the static fetch when we have no rendered HTML to read instead.
  const html = renderedHtml || (sources.sitemap.length ? '' : (await fetchText(url, 12000, 'html')) || '');
  sources.page = linksInHtml(html, origin);

  const all = mergePages(sources, origin, url);
  // ARCHIVES ARE NOT CONTENT. WordPress generates category / tag / author listings; a converted copy is a
  // static duplicate that fights the real archive and goes stale as soon as a post is added. They are
  // counted so the picker can say what was set aside, and kept out of the list it offers.
  const pages = all.filter((p) => 'archive' !== p.kind);
  const kinds = { page: 0, post: 0, archive: 0 };
  for (const p of all) { kinds[p.kind] = (kinds[p.kind] || 0) + 1; }
  const groups = {};
  for (const p of pages) {
    const k = p.group || '(top level)';
    groups[k] = (groups[k] || 0) + 1;
  }
  // A BLOCKED SCAN IS NOT AN EMPTY SITE. When every source was refused, the honest answer is to say so:
  // reporting `1 page` (the root, which is only there because it is the URL that was pasted) reads as
  // 'this site has one page', and the user has no reason to doubt it. Measured on a real source whose nav
  // alone lists five.
  const blocked = _lastFetchBlocked && pages.length <= 1;
  return {
    ok: true,
    origin,
    total: pages.length,
    counts: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.length])),
    groups,
    kinds,
    pages,
    blocked,
    ...(blocked ? { warning: 'The site refused this service’s requests (bot protection), so its sitemap and links could not be read. Add page URLs by hand, or convert them one at a time.' } : {}),
  };
}
