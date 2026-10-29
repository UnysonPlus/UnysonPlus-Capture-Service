// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Free stock search: footage, photos and sounds from sources whose licences allow commercial use (see the kit's
// docs/stock-media.md, checked 2026-10-28). Pexels and Pixabay need the person's own free API key; NASA and Openverse
// need none. Every result carries its licence and the credit it needs; a download goes into the project's media/ and
// its source, licence and credit into the project's notes.


const UA = { 'User-Agent': 'UnysonPlus-AI-Dev-Kit (Kinetic Scenes stock search)' };

// ---- keys (environment first, then the kit settings, where the Studio saves them) ----
async function settings() { return import('./studio-addons.mjs'); }
export async function stockKeys() {
  const a = await settings();
  return { pexels: process.env.PEXELS_API_KEY || a.kitSetting('pexels-key') || '', pixabay: process.env.PIXABAY_API_KEY || a.kitSetting('pixabay-key') || '' };
}
export async function setStockKey(source, key) {
  if (!['pexels', 'pixabay'].includes(source)) throw Object.assign(new Error('Keys are for pexels or pixabay.'), { code: 400 });
  (await settings()).kitSetting(`${source}-key`, String(key || '').trim() || undefined);
  return stockStatus();
}
export const SOURCES = ['pexels', 'pixabay', 'nasa', 'openverse'];
/** The sources the person switched off in the Studio (Stock sources): neither they nor an agent search them. */
async function offSources() { const v = (await settings()).kitSetting('stock-off'); return Array.isArray(v) ? v : []; }
export async function setStockSources({ off = [] } = {}) {
  (await settings()).kitSetting('stock-off', off.filter((s) => SOURCES.includes(s)));
  return stockStatus();
}
/** Per source: { key: needs one / has one, on }. */
export async function stockStatus() {
  const k = await stockKeys(), off = await offSources();
  const o = {};
  for (const s of SOURCES) o[s] = { on: !off.includes(s), needsKey: s === 'pexels' || s === 'pixabay', hasKey: s === 'pexels' ? !!k.pexels : s === 'pixabay' ? !!k.pixabay : true };
  return { sources: o };
}

// ---- Pixabay asks for results to be cached for 24 hours ----
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600e3) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
async function json(url, headers = {}, ms = 20000) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return r.json();
}

const LIC = {
  pexels: { licence: 'Pexels License: free, commercial use allowed, no credit required', credit: null, url: 'https://www.pexels.com/license/' },
  pixabay: { licence: 'Pixabay Content License: free, commercial use allowed, no credit required (no political use; no commercial use of shown trademarks)', credit: null, url: 'https://pixabay.com/service/license-summary/' },
  nasa: { licence: 'NASA media: generally not copyrighted; acknowledge NASA; no implied endorsement, no NASA logos', credit: 'NASA', url: 'https://www.nasa.gov/nasa-brand-center/images-and-media/' },
};

/** One result: { source, id, kind: video|photo|audio, title, thumb, width, height, seconds, by, page, file, licence, credit, licenceUrl }. */
const pick = (files, w) => files.filter((f) => f.link).sort((a, b) => Math.abs((a.width || 0) - w) - Math.abs((b.width || 0) - w))[0];

async function pexels(q, kind, key, orient) {
  if (!key) return { results: [], note: 'Pexels needs a free API key (pexels.com/api).' };
  const o = orient ? `&orientation=${orient}` : '';
  if (kind === 'video') {
    const j = await cached(`px-v-${q}-${o}`, () => json(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=20${o}`, { Authorization: key }));
    return { results: (j.videos || []).map((v) => { const f = pick(v.video_files || [], 1920); return { source: 'pexels', id: String(v.id), kind: 'video', title: (v.url || '').split('/').filter(Boolean).pop()?.replace(/-\d+$/, '').replace(/-/g, ' ') || 'Pexels video', thumb: v.image, width: f?.width || v.width, height: f?.height || v.height, seconds: v.duration, by: v.user?.name, page: v.url, file: f?.link, ...lic('pexels') }; }) };
  }
  const j = await cached(`px-p-${q}-${o}`, () => json(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=20${o}`, { Authorization: key }));
  return { results: (j.photos || []).map((p) => ({ source: 'pexels', id: String(p.id), kind: 'photo', title: p.alt || 'Pexels photo', thumb: p.src?.medium, width: p.width, height: p.height, by: p.photographer, page: p.url, file: p.src?.large2x || p.src?.original, ...lic('pexels') })) };
}

async function pixabay(q, kind, key, orient) {
  if (!key) return { results: [], note: 'Pixabay needs a free API key (pixabay.com/api/docs).' };
  if (kind === 'video') {
    const j = await cached(`pb-v-${q}`, () => json(`https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(q)}&per_page=20&safesearch=true`));
    return { results: (j.hits || []).map((h) => { const f = h.videos?.large?.url ? h.videos.large : h.videos?.medium; return { source: 'pixabay', id: String(h.id), kind: 'video', title: h.tags || 'Pixabay video', thumb: h.videos?.tiny?.thumbnail || h.videos?.small?.thumbnail || '', width: f?.width, height: f?.height, seconds: h.duration, by: h.user, page: h.pageURL, file: f?.url, ...lic('pixabay') }; }) };
  }
  const o = orient === 'portrait' ? '&orientation=vertical' : orient === 'landscape' ? '&orientation=horizontal' : '';
  const j = await cached(`pb-p-${q}-${o}`, () => json(`https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(q)}&per_page=20&safesearch=true${o}`));
  return { results: (j.hits || []).map((h) => ({ source: 'pixabay', id: String(h.id), kind: 'photo', title: h.tags || 'Pixabay photo', thumb: h.previewURL, width: h.imageWidth, height: h.imageHeight, by: h.user, page: h.pageURL, file: h.largeImageURL, ...lic('pixabay') })) };
}

async function nasa(q, kind) {
  if (kind === 'audio') return { results: [] };
  const mt = kind === 'video' ? 'video' : 'image';
  const j = await cached(`nasa-${mt}-${q}`, () => json(`https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=${mt}`));
  const items = (j.collection?.items || []).slice(0, 20);
  return { results: items.map((it) => { const d = it.data?.[0] || {}; return { source: 'nasa', id: d.nasa_id, kind: kind === 'video' ? 'video' : 'photo', title: d.title || d.nasa_id, thumb: it.links?.find((l) => l.render === 'image')?.href || it.links?.[0]?.href, by: d.center ? `NASA ${d.center}` : 'NASA', page: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`, file: null, asset: d.nasa_id, ...lic('nasa') }; }) };
}

async function openverse(q, kind) {
  if (kind === 'video') return { results: [] };
  const ep = kind === 'audio' ? 'audio' : 'images';
  // Only works whose licence allows commercial use and changes (no NC, no ND).
  const j = await cached(`ov-${ep}-${q}`, () => json(`https://api.openverse.org/v1/${ep}/?q=${encodeURIComponent(q)}&license_type=commercial,modification&page_size=20&mature=false`, {}, 60000));
  return { results: (j.results || []).map((r) => {
    const name = `${(r.license || '').toUpperCase() === 'CC0' || r.license === 'pdm' ? (r.license === 'pdm' ? 'Public Domain Mark' : 'CC0') : `CC ${(r.license || '').toUpperCase()} ${r.license_version || ''}`.trim()}`;
    const needsCredit = !['cc0', 'pdm'].includes(r.license);
    return { source: 'openverse', id: r.id, kind: kind === 'audio' ? 'audio' : 'photo', title: r.title || 'Untitled', thumb: r.thumbnail, width: r.width, height: r.height, seconds: r.duration ? r.duration / 1000 : undefined, by: r.creator, page: r.foreign_landing_url, file: r.url,
      licence: `${name} (from ${r.source || r.provider}): commercial use and changes allowed${needsCredit ? '; credit required' : ''}`, credit: needsCredit ? (r.attribution || `"${r.title}" by ${r.creator}, ${name}`) : null, licenceUrl: r.license_url };
  }) };
}
const lic = (s) => ({ licence: LIC[s].licence, credit: LIC[s].credit, licenceUrl: LIC[s].url });

/** Searches the sources: { results, notes }. kind: video | photo | audio. orient: portrait | landscape | ''. */
export async function stockSearch({ q, kind = 'video', sources, orient = '' }) {
  if (!q || !String(q).trim()) throw Object.assign(new Error('Give something to search for.'), { code: 400 });
  const k = await stockKeys();
  const off = await offSources();
  const want = (sources?.length ? sources : SOURCES).filter((s) => !off.includes(s));
  if (!want.length) return { results: [], notes: ['Every stock source is switched off (Stock sources in the Studio menu).'] };
  const jobs = { pexels: () => pexels(q, kind, k.pexels, orient), pixabay: () => pixabay(q, kind, k.pixabay, orient), nasa: () => nasa(q, kind), openverse: () => openverse(q, kind) };
  const settled = await Promise.allSettled(want.filter((s) => jobs[s]).map((s) => jobs[s]().then((r) => ({ s, ...r }))));
  const results = [], notes = [];
  for (const x of settled) {
    if (x.status === 'fulfilled') { results.push(...x.value.results.filter((r) => r.file || r.asset)); if (x.value.note) notes.push(x.value.note); }
    else notes.push(String(x.reason?.message || x.reason));
  }
  return { results, notes };
}

/** NASA's files for an item: the largest MP4 (video) or the original/large JPEG (photo). */
async function nasaFile(id, kind) {
  const j = await json(`https://images-api.nasa.gov/asset/${encodeURIComponent(id)}`);
  const hrefs = (j.collection?.items || []).map((i) => i.href);
  const pref = kind === 'video' ? ['~large.mp4', '~orig.mp4', '~medium.mp4', '~mobile.mp4', '.mp4'] : ['~large.jpg', '~orig.jpg', '~medium.jpg', '.jpg', '.png'];
  for (const p of pref) { const h = hrefs.find((x) => x.toLowerCase().endsWith(p)); if (h) return h.replace(/^http:/, 'https:'); }
  throw new Error('NASA has no downloadable file for this item.');
}

/**
 * Downloads a result into a project: the file to media/, and a line in the notes with its source, page, licence and
 * credit. Returns { path: "media/…", note }.
 */
export async function stockGet(project, r) {
  if (!project || !r?.source) throw Object.assign(new Error('Give the project and the result to download.'), { code: 400 });
  const w = await import('./studio-workspace.mjs');
  const url = r.source === 'nasa' ? await nasaFile(r.asset || r.id, r.kind) : r.file;
  if (!url) throw new Error('This result has no file to download.');
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10 * 60e3) });
  if (!res.ok) throw new Error(`The download failed (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (/\.(mp4|webm|mov|jpe?g|png|webp|mp3|wav|ogg|flac|m4a)(\?|$)/i.exec(url)?.[1] || (r.kind === 'video' ? 'mp4' : r.kind === 'audio' ? 'mp3' : 'jpg')).toLowerCase();
  const stem = `${r.source}-${String(r.title || r.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || r.id}`;
  const path = w.addMedia(project, `${stem}.${ext}`, buf);
  const note = `Stock ${r.kind}: ${path} — ${r.title}${r.by ? ` by ${r.by}` : ''}, ${r.page}. Licence: ${r.licence}${r.credit ? `. CREDIT REQUIRED: ${r.credit}` : '. No credit required'}.`;
  w.addNote(project, note, 'Decided');
  return { path, note, credit: r.credit || null };
}
