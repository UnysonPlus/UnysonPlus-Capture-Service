/**
 * masthead.test.mjs — prove the scored masthead resolver beats querySelector('header')
 * on real sources. No localhost, no WordPress, no conversion: it loads each URL and
 * compares what the two strategies resolve, then performs the scroll-state read that
 * capture.mjs actually does.
 *
 *   node masthead.test.mjs                       # the built-in mixed sample
 *   node masthead.test.mjs --urls list.txt       # a corpus list (converter-trainer/sites/*.txt)
 *   node masthead.test.mjs --limit 20 --concurrency 6
 *
 * Exits 1 on a REGRESSION (the resolver finds nothing where the naive selector found a
 * legitimate non-hero header), and also when nothing was actually verified — an
 * all-errors run must never look like a pass.
 */
import { chromium } from 'playwright-core';
import fs from 'fs';
import { readMastheadState, describeMasthead } from './masthead.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const DEFAULT = [
  // <header> IS the masthead (must not regress)
  'https://sweetwish-patisserie-shop.wegic.net/',
  'https://luxora-eyewear-store.wegic.net/',
  'https://serenity-spa-wellness.wegic.net/',
  // <header> is the HERO, the real bar is a <nav> (the bug this fixes)
  'https://openhero.art/api/preview?category=tech&slug=lumina-ai',
  'https://openhero.art/api/preview?category=tech&slug=anime-environment-engine',
  'https://openhero.art/api/preview?category=nature&slug=crystal-universe',
  // detached / floating bar (top offset > 8px)
  'https://openhero.art/api/preview?category=nature&slug=solitary-elevation-project',
];

const expand = l => /^https?:\/\//i.test(l) ? l
  : (l.includes('|') ? `https://openhero.art/api/preview?category=${l.split('|')[0].trim()}&slug=${l.split('|')[1].trim()}` : null);

const listFile = flag('urls');
let urls = listFile
  ? fs.readFileSync(listFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(expand).filter(Boolean)
  : DEFAULT;
const limit = Number(flag('limit', 0));
if (limit > 0) urls = urls.slice(0, limit);
if (!urls.length) { console.error('FAIL - no URLs to test.'); process.exit(1); }
const CONC = Number(flag('concurrency', 5));

const browser = await chromium.launch({ channel: 'chrome' });
const rows = [];
let i = 0;

async function worker() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  while (true) {
    const k = i++; if (k >= urls.length) break;
    const url = urls[k];
    const page = await ctx.newPage();
    const row = { url };
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2200);
      row.d = await page.evaluate(describeMasthead);
      row.top = await page.evaluate(readMastheadState);
      await page.evaluate('window.scrollTo(0, Math.max(720, innerHeight))');
      await page.waitForTimeout(500);
      row.scrolled = await page.evaluate(readMastheadState);
      // what the OLD code would have read, for the comparison
      row.naive = await page.evaluate(`(function(){var h=document.querySelector('header');if(!h)return null;
        var s=getComputedStyle(h);return {bg:s.backgroundColor,position:s.position,h:Math.round(h.getBoundingClientRect().height)};})()`);
    } catch (e) { row.error = String(e.message).slice(0, 80); }
    await page.close();
    rows.push(row);
  }
  await ctx.close();
}
await Promise.all(Array.from({ length: Math.min(CONC, urls.length) }, () => worker()));
await browser.close();

let disagree = 0, naiveNull = 0, naiveHero = 0, regressions = 0, twoState = 0;
console.log(`\nmasthead resolver vs querySelector('header') - ${rows.length} sites\n`);
for (const r of rows) {
  if (r.error) { console.log(`  ERR  ${r.url.slice(-52)} :: ${r.error}`); continue; }
  const d = r.d || {};
  const changed = r.top && r.scrolled &&
    ['bg', 'backdrop', 'shadow', 'padTop', 'padBottom', 'borderBottom'].some(k => (r.top[k] || '') !== (r.scrolled[k] || ''));
  if (changed) twoState++;
  if (!d.agrees) disagree++;
  if (!r.naive) naiveNull++;
  if (d.naiveWasHero) naiveHero++;
  // regression = naive found a real, non-hero header and we found nothing
  if (r.naive && !d.naiveWasHero && !d.found) regressions++;
  const verdict = d.agrees ? 'same' : (!r.naive ? 'NAIVE FOUND NOTHING' : d.naiveWasHero ? 'NAIVE HIT THE HERO' : 'differs');
  console.log(`  ${(d.found ? `<${d.tag}>` : 'none').padEnd(9)} ${String(d.position || '').padEnd(7)} ` +
              `y=${String(d.rect ? d.rect.y : '-').padEnd(4)} h=${String(d.rect ? d.rect.h : '-').padEnd(4)} ` +
              `${changed ? 'two-state' : '         '}  ${verdict.padEnd(20)} ${r.url.replace(/^https?:\/\//, '').slice(0, 46)}`);
}

const okRows = rows.filter(r => !r.error);
const resolved = rows.filter(r => r.d && r.d.found).length;
console.log(`\n  resolved a masthead        : ${resolved}/${okRows.length}`);
console.log(`  differs from querySelector : ${disagree}`);
console.log(`     ...naive returned null  : ${naiveNull}`);
console.log(`     ...naive hit the HERO   : ${naiveHero}`);
console.log(`  two-state captured         : ${twoState}`);
console.log(`  REGRESSIONS                : ${regressions}`);

// An all-errors run must FAIL rather than pass with zero denominators - that masked a
// real serialization bug once already (the resolver was not surviving into the page).
const fail = msg => { console.error('\nFAIL - ' + msg); process.exit(1); };
if (!okRows.length) fail('every site errored; nothing was verified.');
if (okRows.length < rows.length * 0.7) fail(`${rows.length - okRows.length}/${rows.length} sites errored.`);
if (!resolved) fail('resolved no masthead on any site.');
if (regressions) fail('the resolver lost a header the naive selector found.');
console.log('\nPASS');
