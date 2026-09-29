/**
 * VERIFY A WHOLE SITE — run the per-page lenses across every converted page, not just the home page.
 *
 * WHY THIS EXISTS. `verifySections` and `verifyUrls` each take ONE source/converted pair. That is the
 * right shape for a lens you aim, but nothing ever looped them, so every layout claim made about a
 * conversion was a claim about its home page. The text-coverage audit had the same blind spot and, once
 * it was made per-page, the first real run showed exactly why it matters: the home page read 97.7% while
 * an inner form page read 83.8%, losing its trust badges, its reassurance copy and a heading. The pages
 * nobody looks at are where the problems accumulate, precisely because nobody looks at them.
 *
 * This runs the section lens per page and ranks the results, so "the conversion is good" becomes a
 * statement about the site rather than about one page of it.
 *
 * Usage:
 *   import { verifySite } from './verify-site.mjs';
 *   await verifySite({
 *     sourceOrigin: 'https://example.com',
 *     convertedOrigin: 'http://localhost',
 *     paths: ['/', '/about', '/pricing'],      // or omit and pass `discover: true`
 *   });
 */
import { verifySections } from './verify.mjs';
import { discoverPages } from './discover.mjs';

/** A converted WordPress path for a source path: '/' stays '/', '/a/b' becomes '/b/' (the page slug). */
/**
 * Turn one page's sections into its row of the report — or refuse to grade it.
 *
 * Pulled out so the refusal is testable without a browser. The rule it encodes is the one the loop got
 * wrong: an empty section list is NOT a clean page, it is an unmeasured one, and reporting it as clean
 * makes a broken run look like a perfect conversion.
 */
export function gradeSections(path, secs) {
  if (!Array.isArray(secs) || !secs.length) {
    return { path, ok: false,
      error: 'no sections found on one side — the page did not load, is empty, or the URL is wrong (not graded)' };
  }
  const findings = secs.flatMap((s) => s.findings || []);
  const missing = findings.filter((f) => /^(missing|img-missing|icon-missing|section-missing)$/.test(f.kind)).length;
  return {
    path, ok: true, sections: secs.length, missing,
    height_delta_px: secs.reduce((n, s) => n + Math.abs(s.dh || 0), 0),
    worst_section: secs.slice().sort((a, b) => Math.abs(b.dh || 0) - Math.abs(a.dh || 0))[0]?.id || '',
  };
}

export function convertedPathFor(srcPath) {
  const segs = String(srcPath || '/').split('/').filter(Boolean);
  if (!segs.length) return '/';
  return '/' + segs[segs.length - 1] + '/';
}

/**
 * Which pages to check, in which order, within the budget.
 *
 * Pulled out as its own function so the rules are testable without a browser: the home page always leads
 * (it is the page everything else is judged against), duplicates collapse, and the cap is applied LAST so
 * it trims the tail rather than silently dropping '/' when the caller forgot to include it.
 */
export function planPages(paths, limit = 12) {
  let list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
  list = list.map((p) => (p.startsWith('/') ? p : '/' + p));
  if (!list.includes('/')) list.unshift('/');
  else list = ['/'].concat(list.filter((p) => p !== '/'));
  return [...new Set(list)].slice(0, Math.max(1, limit));
}

/**
 * @param {object}   o
 * @param {string}   o.sourceOrigin     e.g. https://example.com
 * @param {string}   o.convertedOrigin  e.g. http://localhost
 * @param {string[]} [o.paths]          source paths to check; '/' first
 * @param {boolean}  [o.discover]       when no paths are given, ask discoverPages for them
 * @param {number}   [o.limit]          cap the number of pages checked (default 12 — each page is a render)
 * @param {number}   [o.width]          viewport width (default 1440)
 */
export async function verifySite({
  sourceOrigin, convertedOrigin, paths = null, discover = false, limit = 12, width = 1440,
} = {}) {
  if (!sourceOrigin || !convertedOrigin) {
    return { ok: false, error: 'sourceOrigin and convertedOrigin are required', pages: [] };
  }

  let list = Array.isArray(paths) ? paths.slice() : [];
  if (!list.length && discover) {
    const d = await discoverPages({ url: sourceOrigin });
    // Nav pages first — those are the ones a visitor actually reaches, so they are the ones worth the
    // render budget when the cap bites.
    list = (d.pages || []).sort((a, b) => (b.inNav - a.inNav) || (a.depth - b.depth)).map((p) => p.path);
  }
  list = planPages(list, limit);

  const pages = [];
  for (const p of list) {
    const sourceUrl = sourceOrigin.replace(/\/+$/, '') + p;
    const convertedUrl = convertedOrigin.replace(/\/+$/, '') + convertedPathFor(p);
    let r;
    try {
      r = await verifySections({ sourceUrl, convertedUrl, width });
    } catch (e) {
      // A page that could not be graded is recorded as such, never as a page with no problems — silence
      // and success must not look the same.
      pages.push({ path: p, ok: false, error: String((e && e.message) || e) });
      continue;
    }
    if (r && r.error) { pages.push({ path: p, ok: false, error: r.error }); continue; }

    pages.push(gradeSections(p, r.sections || []));
  }

  const graded = pages.filter((p) => p.ok);
  return {
    ok: true,
    checked: pages.length,
    graded: graded.length,
    ungraded: pages.length - graded.length,
    total_missing: graded.reduce((n, p) => n + p.missing, 0),
    total_height_delta_px: graded.reduce((n, p) => n + p.height_delta_px, 0),
    // Ranked worst-first: the point of a site-wide pass is to say WHICH page to open next.
    pages: pages.slice().sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? 1 : -1)
      || (b.missing - a.missing) || (b.height_delta_px - a.height_delta_px)),
  };
}
