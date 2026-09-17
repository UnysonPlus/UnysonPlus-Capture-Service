/** The capture subfolder slug for a URL — hostname (sans www) + path + a query signature: two previews on one host + path
 *  (`?slug=a` / `?slug=b`) used to overwrite each other mid-build. capture.mjs writes with it, serve.mjs reads with it. */
export function siteSlug(u) {
  try {
    const url = new URL(u);
    let s = url.hostname.replace(/^www\./i, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (path) s += '_' + path.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
    // a QUERY that selects the page (`?slug=…`, `?category=…&slug=…`, `?id=…`) is part of the identity: two previews on one
    // host + path used to write into the same folder and overwrite each other mid-build (a RECURRING finding). A tracking /
    // cache query (utm_*, v=, ref=) is ignored.
    const q = [...url.searchParams.entries()].filter(([k]) => !/^(utm_|fbclid|gclid|ref$|v$|_$|cache)/i.test(k));
    if (q.length) { const sig = q.map(([k, v]) => k + '=' + v).join('&'); let h = 5381; for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) >>> 0; const slugQ = q.find(([k]) => /slug|page|id|name/i.test(k)); s += '_' + (slugQ ? slugQ[1].replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 40) + '_' : '') + h.toString(16).slice(0, 6); }
    return s || 'site';
  } catch { return 'site'; }
}
