/**
 * The Kit Assistant's tools — what the dashboard Chat can look at, through the machinery that already
 * runs in this service. All READ-ONLY: nothing here writes to a site, starts a capture or changes a file
 * outside `<capture-out>/_chat/` (where a look at a URL leaves its screenshot).
 *
 *   captureSummaryForChat  the watched capture-out folder in a few lines (injected as context, not a tool)
 *   look_at_url            open a page in the kit's own browser: title, headings, text, links, screenshot
 *   conversion_report      a captured site's per-section result: what fell back, what was dropped, why
 *   search_docs / read_doc the kit's own docs (recipes, styles, option references, the build protocol)
 *
 * The definitions are OpenAI-shaped function tools, which both the Ollama and the endpoint transports
 * accept unchanged. Plan: https://docs.unysonplus.com/ai-dev-kit/kit-assistant
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';

const RESULT_MAX = 9000; // characters of tool result handed back to the model per call

/* ---------- capture-out ---------- */

export function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** Minimal CSV reader (quoted fields, embedded commas / quotes / newlines). */
function parseCsv(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') { q = false; } else { f += c; }
    } else if (c === '"') { q = true; } else if (c === ',') { row.push(f); f = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = [];
    } else { f += c; }
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift() || [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** Every capture under the folder, newest first: { dir, slug, url, at, stats }. */
export function listCaptures(captureOut) {
  let names = [];
  try { names = readdirSync(captureOut); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (n.startsWith('_') || n.startsWith('.')) continue;
    const dir = join(captureOut, n);
    let st; try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory() || !existsSync(join(dir, 'pages.json'))) continue;
    const stats = (readJsonSafe(join(dir, 'share-stats.json')) || {}).stats || null;
    const dc = readJsonSafe(join(dir, 'design-config.json')) || {};
    let url = dc.source_url || dc.sourceUrl || dc.url || '';
    if (!url) {
      try { url = (readFileSync(join(dir, 'conversion-report.csv'), 'utf8').split(/\r?\n/)[1] || '').split(',')[0] || ''; } catch { /* none */ }
    }
    out.push({ dir, slug: n, url, at: st.mtimeMs, stats });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** A few lines for the system prompt, so "what did my last capture do?" has an answer before any tool call. */
export function captureSummaryForChat(captureOut, limit = 8) {
  const caps = listCaptures(captureOut);
  if (!caps.length) return 'The capture-out folder (' + captureOut + ') has no captures yet.';
  const lines = caps.slice(0, limit).map((c) => {
    const s = c.stats;
    const nums = s ? `${s.sections} sections, ${s.elements} elements, ${s.fallbacks} fallback(s), ${s.stylingDrops || 0} styling drop(s)` : 'no report';
    return `- ${c.slug}${c.url ? ' (' + c.url + ')' : ''} — captured ${new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')}; ${nums}`;
  });
  return `Captures in ${captureOut} (newest first, ${caps.length} in all):\n${lines.join('\n')}\nUse conversion_report for any one of them.`;
}

export function findCapture(captureOut, site) {
  const caps = listCaptures(captureOut);
  const q = String(site || '').trim().toLowerCase();
  if (!q || q === 'latest' || q === 'last') return caps[0] || null;
  const norm = (s) => s.toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return caps.find((c) => c.slug.toLowerCase() === q)
    || caps.find((c) => c.url && norm(c.url).replace(/_$/, '') === norm(q))
    || caps.find((c) => c.slug.toLowerCase().includes(norm(q)) || (c.url && c.url.toLowerCase().includes(q)))
    || null;
}

/** tool_conversion_report — the per-section story of one capture. */
export function conversionReport(captureOut, { site } = {}) {
  const c = findCapture(captureOut, site);
  if (!c) return { error: `No capture matches "${site}". Captures: ${listCaptures(captureOut).slice(0, 12).map((x) => x.slug).join(', ') || 'none'}.` };
  let rows = [];
  try { rows = parseCsv(readFileSync(join(c.dir, 'conversion-report.csv'), 'utf8')); } catch { /* none */ }
  const sections = {};
  for (const r of rows) {
    const k = r.s_index;
    if (!sections[k]) sections[k] = { section: Number(k), decision: r.s_decision, class: r.s_class.slice(0, 80), height: Number(r.s_height) || 0, elements: [] };
    sections[k].elements.push({ role: r.role, mapped: r.mapped, fallback: r.fallback === 'yes', opportunity: r.opportunity === 'yes', why: r.why, dropped_styles: r.s_dropped_styles || undefined, text: (r.text || '').slice(0, 90) });
  }
  const list = Object.values(sections).sort((a, b) => a.section - b.section);
  const problems = list.flatMap((s) => s.elements.filter((e) => e.fallback || e.opportunity || e.dropped_styles).map((e) => ({ section: s.section, ...e })));
  let style = null;
  try {
    const sc = parseCsv(readFileSync(join(c.dir, 'style-coverage.csv'), 'utf8'));
    const carried = sc.filter((r) => r.carried === 'yes').length;
    style = { properties: sc.length, carried, percent: sc.length ? Math.round((carried / sc.length) * 100) : null, not_carried: sc.filter((r) => r.carried !== 'yes').slice(0, 15).map((r) => `section ${r.s_index}: ${r.property} (${r.how})`) };
  } catch { /* none */ }
  return {
    capture: c.slug, url: c.url, folder: c.dir, stats: c.stats,
    problems, style_coverage: style,
    sections: list.map((s) => ({ section: s.section, decision: s.decision, height: s.height, mapped: s.elements.map((e) => e.mapped).filter(Boolean).join(', ') })),
    files: ['conversion-report.html', 'style-coverage.html', 'animation-report.html'].filter((f) => existsSync(join(c.dir, f))).map((f) => join(c.dir, f)),
  };
}

/* ---------- look at a URL ---------- */

/** tool_look_at_url — one page in the kit's browser. Read-only; leaves a screenshot under _chat/. */
export async function lookAtUrl(captureOut, { url } = {}) {
  const u = String(url || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(u)) return { error: 'url must be an http(s) address.' };
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200); // client-rendered sites (most AI-built ones) paint after load
    const data = await page.evaluate(() => {
      const t = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const heads = [...document.querySelectorAll('h1,h2,h3')].slice(0, 40).map((h) => h.tagName.toLowerCase() + ': ' + t(h.innerText)).filter((x) => x.length > 4);
      const links = [...document.querySelectorAll('a[href]')];
      const nav = [...document.querySelectorAll('header a[href], nav a[href]')].slice(0, 20).map((a) => t(a.innerText) + ' → ' + a.getAttribute('href')).filter((x) => !x.startsWith(' →'));
      return {
        title: document.title,
        description: (document.querySelector('meta[name="description"]') || {}).content || '',
        lang: document.documentElement.lang || '',
        headings: heads,
        navigation: nav,
        link_count: links.length,
        image_count: document.images.length,
        sections: document.querySelectorAll('section').length,
        height: document.documentElement.scrollHeight,
        text: t(document.body ? document.body.innerText : '').slice(0, 5000),
      };
    });
    const dir = join(captureOut, '_chat'); mkdirSync(dir, { recursive: true });
    const shot = join(dir, 'look-' + new URL(u).hostname.replace(/[^a-z0-9.-]/gi, '_') + '-' + Date.now() + '.png');
    await page.screenshot({ path: shot });
    return { url: page.url(), status: resp ? resp.status() : null, ...data, screenshot: shot };
  } catch (e) {
    return { error: 'Could not open the page: ' + e.message.split('\n')[0] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/* ---------- the kit's docs ---------- */

function walkMd(dir, out = []) {
  let names = []; try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (n.startsWith('.') || n === 'node_modules' || n.startsWith('_')) continue;
    const p = join(dir, n); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkMd(p, out); else if (/\.md$/i.test(n)) out.push(p);
  }
  return out;
}

/** tool_search_docs — rank the kit's docs for a query; return paths + the best-matching passage. */
export function searchDocs(docsDir, { query, limit = 5 } = {}) {
  const terms = String(query || '').toLowerCase().split(/[^a-z0-9_-]+/).filter((w) => w.length > 2);
  if (!terms.length) return { error: 'query needs a word or two, e.g. "hero recipe".' };
  const hits = [];
  for (const p of walkMd(docsDir)) {
    let text; try { text = readFileSync(p, 'utf8'); } catch { continue; }
    const rel = relative(docsDir, p).split(sep).join('/');
    const low = text.toLowerCase(); const lowPath = rel.toLowerCase();
    let score = 0;
    for (const w of terms) {
      if (lowPath.includes(w)) score += 12;
      const m = low.split(w).length - 1; score += Math.min(m, 25);
    }
    if (!score) continue;
    // best passage: the paragraph with the most distinct terms
    const paras = text.split(/\n\s*\n/);
    let best = paras[0] || '', bs = -1;
    for (const para of paras) { const pl = para.toLowerCase(); const s = terms.filter((w) => pl.includes(w)).length; if (s > bs) { bs = s; best = para; } }
    hits.push({ path: rel, score, title: (text.match(/^#\s+(.+)$/m) || [])[1] || rel, passage: best.trim().slice(0, 600) });
  }
  hits.sort((a, b) => b.score - a.score);
  return { docs_folder: docsDir, results: hits.slice(0, Math.min(10, Math.max(1, Number(limit) || 5))), note: 'read_doc returns a whole doc.' };
}

/** tool_read_doc — one doc, by the path search_docs returned. Never reads outside the docs folder. */
export function readDoc(docsDir, { path } = {}) {
  const root = resolve(docsDir);
  const p = resolve(root, String(path || ''));
  if (!p.startsWith(root + sep) || !/\.md$/i.test(p)) return { error: 'path must be a .md path from search_docs, inside the kit docs.' };
  try {
    const text = readFileSync(p, 'utf8');
    return { path: relative(root, p).split(sep).join('/'), length: text.length, content: text.slice(0, 14000), truncated: text.length > 14000 };
  } catch { return { error: 'No such doc: ' + path }; }
}

/* ---------- the tool table ---------- */

export const CHAT_TOOL_DEFS = [
  { type: 'function', function: { name: 'look_at_url', description: 'Open a web page in the kit\'s own browser (it renders JavaScript, so AI-built sites work) and return its title, headings, navigation, visible text and a screenshot file path. Read-only. Use it whenever the person asks about a site or a URL.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'http(s) address' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'conversion_report', description: 'A captured site\'s conversion report: per-section decisions, the elements that fell back (e.g. to code_block) and why, dropped styles, and style coverage. site = the capture folder name, its URL, or "latest".', parameters: { type: 'object', properties: { site: { type: 'string' } }, required: ['site'] } } },
  { type: 'function', function: { name: 'search_docs', description: 'Search the AI Dev Kit\'s own docs (section recipes, style directions, shortcode and option references, Theme Settings, the build protocol). Returns paths and the best passage of each. Use it before answering how-to questions about Unyson+.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_doc', description: 'Read one kit doc in full, by a path from search_docs.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
];

/**
 * Runs a tool by name. Returns { ok, result (object), text (what the model sees, capped) }.
 * @param {{captureOut:string, docsDir:string}} env
 */
export async function runChatTool(env, name, args) {
  const a = args && typeof args === 'object' ? args : {};
  let result;
  try {
    if (name === 'look_at_url') result = await lookAtUrl(env.captureOut, a);
    else if (name === 'conversion_report') result = conversionReport(env.captureOut, a);
    else if (name === 'search_docs') result = searchDocs(env.docsDir, a);
    else if (name === 'read_doc') result = readDoc(env.docsDir, a);
    else result = { error: 'Unknown tool "' + name + '". Tools: ' + CHAT_TOOL_DEFS.map((t) => t.function.name).join(', ') + '.' };
  } catch (e) {
    result = { error: e.message };
  }
  let text = JSON.stringify(result);
  if (text.length > RESULT_MAX) text = text.slice(0, RESULT_MAX) + '…(truncated)';
  return { ok: !result.error, result, text };
}
