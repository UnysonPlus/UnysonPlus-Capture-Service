/**
 * CONTENT audit: does each converted page carry ITS OWN source page's words?
 *
 * Why this exists. A per-path check that matches on the recorded source URL said PASS while three converted
 * pages carried the WRONG page's content: a slug collision had overwritten the capture snapshot, so the page
 * was labelled `/construction-loans/fha` and held `/modular-home-financing/loan-options/fha`. Identity
 * metadata proves a page is LABELLED right, never that it IS right. Only comparing rendered text to the
 * source it claims caught it.
 *
 * Usage: node content-audit.mjs <srcOrigin> <convOrigin> [sampleSize]
 *        pages are read from the install via the pairs on stdin: "<srcPath>\t<slug>" per line.
 */
import { chromium } from 'playwright-core';

const words = (t) => new Set(String(t || '').toLowerCase().match(/[a-z]{4,}/g) || []);

export function coverage(srcText, convText) {
  const sw = words(srcText), cw = words(convText);
  if (!sw.size) return { ok: false, error: 'source page produced no words — not graded' };
  let hit = 0; for (const w of sw) if (cw.has(w)) hit++;
  return { ok: true, pct: Math.round((hit / sw.size) * 1000) / 10, srcWords: sw.size, convWords: cw.size };
}

/** Pages whose text is identical to another page's are suspicious: one snapshot may have overwritten another. */
export function findDuplicateContent(rows) {
  const byText = new Map();
  for (const r of rows) {
    if (!r.convText || r.convText.length < 200) continue;
    const k = r.convText.slice(0, 4000);
    if (!byText.has(k)) byText.set(k, []);
    byText.get(k).push(r.slug);
  }
  return [...byText.values()].filter((g) => g.length > 1);
}

async function main() {
  const [srcOrigin, convOrigin] = process.argv.slice(2);
  const pairs = (await new Promise((res) => { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => res(s)); }))
    .split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('\t'));
  const b = await chromium.launch({ executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const read = async (u, wait) => { try { const r = await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await p.waitForTimeout(wait); return { st: r.status(), t: await p.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim()) }; }
    catch { return { st: 'ERR', t: '' }; } };
  const rows = [];
  for (const [srcPath, slug] of pairs) {
    const S = await read(srcOrigin.replace(/\/+$/, '') + srcPath, 2200);
    const C = await read(convOrigin.replace(/\/+$/, '') + '/' + slug + '/', 400);
    const c = coverage(S.t, C.t);
    rows.push({ slug, srcPath, convText: C.t, ...c });
    const label = !c.ok ? 'UNGRADED' : c.pct >= 95 ? 'ok' : c.pct >= 80 ? 'LOW' : 'BAD';
    console.log(`  ${label.padEnd(8)} ${String(c.pct ?? '-').padStart(5)}%  ${slug.padEnd(24)} <- ${srcPath}`);
  }
  await b.close();
  const graded = rows.filter((r) => r.ok);
  const bad = graded.filter((r) => r.pct < 95);
  console.log(`\ngraded ${graded.length}/${rows.length}   below 95%: ${bad.length}   mean ${graded.length ? (graded.reduce((n, r) => n + r.pct, 0) / graded.length).toFixed(1) : '-'}%`);
  const dupes = findDuplicateContent(rows);
  console.log(`pages sharing identical content: ${dupes.length}`);
  for (const g of dupes) console.log(`   ! ${g.join('  ==  ')}`);
}
await main();
