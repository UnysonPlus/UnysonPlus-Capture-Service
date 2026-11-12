// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The SEO check's rules, proven without a network: what each page and site shape reports, how findings
 * merge and score, what counts as a change between two runs, and what is kept from the AI's answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, robotsBlocksRoot, pageFindings, siteFindings, group, score, diff, cleanAi, isPublicHost, sameUrl, toMarkdown } from './seo-check.mjs';

const good = {
  url: 'https://example.com/about', finalUrl: 'https://example.com/about', status: 200, redirects: [], ttfb: 300,
  title: 'About our bakery in Leeds | Example', description: 'Who bakes your bread, where the flour comes from and how to find the shop in the centre of Leeds.',
  canonicals: ['https://example.com/about'], robotsMeta: '', xRobots: '', lang: 'en', viewport: 'width=device-width',
  h1s: ['About us'], headingLevels: [1, 2, 2, 3], images: 3, imagesNoAlt: 0, ogTitle: 'About', ogImage: 'https://example.com/a.jpg',
  jsonldTypes: ['Organization'], jsonldInvalid: 0, words: 600, rawWords: 590, mixed: [], hreflang: [],
};
const ids = (list) => list.map((f) => f.id).sort();

test('a healthy page reports nothing', () => {
  assert.deepEqual(pageFindings(good), []);
});

test('each page problem is reported once, with its detail', () => {
  const p = { ...good, title: '', description: 'Short', canonicals: [], h1s: [], headingLevels: [2, 4], imagesNoAlt: 2, lang: '', viewport: '', ogImage: '', jsonldInvalid: 1, words: 90, rawWords: 10, mixed: ['http://example.com/x.jpg'], ttfb: 2400 };
  assert.deepEqual(ids(pageFindings(p)), ['canonical_missing', 'description_short', 'h1_missing', 'heading_skip', 'images_no_alt', 'lang_missing', 'mixed_content', 'og_missing', 'schema_invalid', 'slow_response', 'thin_content', 'title_missing', 'viewport_missing']);
  assert.equal(pageFindings(p).find((f) => f.id === 'heading_skip').detail, 'H2 → H4');
});

test('an error page reports only the error', () => {
  assert.deepEqual(ids(pageFindings({ ...good, status: 404 })), ['status_error']);
  assert.match(pageFindings({ ...good, status: 0, error: 'timeout' })[0].detail, /No answer: timeout/);
});

test('noindex is read from the meta tag and the header', () => {
  assert.ok(ids(pageFindings({ ...good, robotsMeta: 'noindex, follow' })).includes('noindex'));
  assert.ok(ids(pageFindings({ ...good, xRobots: 'noindex' })).includes('noindex'));
});

test('canonicals: one elsewhere, several disagreeing, a trailing slash is the same page', () => {
  assert.ok(ids(pageFindings({ ...good, canonicals: ['https://example.com/other'] })).includes('canonical_elsewhere'));
  assert.ok(ids(pageFindings({ ...good, canonicals: ['https://example.com/a', 'https://example.com/b'] })).includes('canonical_multiple'));
  assert.ok(!ids(pageFindings({ ...good, canonicals: ['https://example.com/about/'] })).includes('canonical_elsewhere'));
  assert.ok(sameUrl('https://Example.com/about/', 'https://example.com/about#top'));
});

test('text that only exists after JavaScript is flagged; a short contact page is not thin', () => {
  assert.ok(ids(pageFindings({ ...good, words: 800, rawWords: 40 })).includes('js_only_content'));
  assert.ok(!ids(pageFindings({ ...good, url: 'https://example.com/contact', words: 60, rawWords: 60 })).includes('thin_content'));
});

test('the home page needs structured data; other pages do not', () => {
  assert.ok(ids(pageFindings({ ...good, jsonldTypes: [] }, { isHome: true })).includes('schema_none'));
  assert.ok(!ids(pageFindings({ ...good, jsonldTypes: [] })).includes('schema_none'));
});

test('robots.txt: most specific group wins, Allow: / reopens', () => {
  const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n\nSitemap: https://example.com/sitemap.xml');
  assert.equal(robotsBlocksRoot(r, 'googlebot'), false);
  assert.equal(robotsBlocksRoot(r, 'bingbot'), true);
  assert.deepEqual(r.sitemaps, ['https://example.com/sitemap.xml']);
  const shared = parseRobots('User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /');
  assert.equal(robotsBlocksRoot(shared, 'ccbot'), true);
  assert.equal(robotsBlocksRoot(shared, 'googlebot'), false);
});

test('site rules: blocked crawlers, missing files, duplicates', () => {
  const pages = [{ ...good }, { ...good, url: 'https://example.com/team' }];
  const f = siteFindings({ robots: 'User-agent: *\nDisallow: /', sitemapCount: 0, llms: false, https: true, httpRedirects: false, otherHostServes: true, otherHost: 'www.example.com', soft404: 'x', brokenLinks: [{ url: 'https://example.com/old', status: 404, from: 'https://example.com/' }], pages });
  assert.deepEqual(ids(f), ['broken_internal_links', 'duplicate_descriptions', 'duplicate_titles', 'host_duplicate', 'llms_missing', 'no_https_redirect', 'robots_blocks_all', 'sitemap_missing', 'sitemap_not_in_robots', 'soft_404']);
});

test('a file that could not be fetched is not reported missing', () => {
  const f = siteFindings({ robots: undefined, llms: undefined, sitemapCount: 3, pages: [] });
  assert.deepEqual(ids(f), []);
});

test('blocking AI training crawlers is information; blocking AI search costs something', () => {
  const train = siteFindings({ robots: 'User-agent: GPTBot\nDisallow: /\nSitemap: x', sitemapCount: 1, llms: true, pages: [] });
  assert.equal(train.find((x) => x.id === 'ai_crawlers_blocked').severity, undefined);
  assert.equal(group(train).find((x) => x.id === 'ai_crawlers_blocked').severity, 'info');
  const search = siteFindings({ robots: 'User-agent: PerplexityBot\nDisallow: /\nSitemap: x', sitemapCount: 1, llms: true, pages: [] });
  assert.equal(search.find((x) => x.id === 'ai_crawlers_blocked').severity, 'medium');
});

test('findings merge per rule, sort by severity, and score once each; AI findings are not scored', () => {
  const g = group([
    { id: 'title_long', url: 'https://example.com/a' }, { id: 'title_long', url: 'https://example.com/b' },
    { id: 'noindex', url: 'https://example.com/a' },
    { id: 'ai_content', url: '', title: 'Counts disagree', severity: 'high' },
  ]);
  assert.deepEqual(g.map((x) => x.id), ['noindex', 'ai_content', 'title_long']);
  assert.equal(g.find((x) => x.id === 'title_long').pages.length, 2);
  assert.equal(score(g), 100 - 7 - 1);
});

test('a second run lists what was fixed and what is new', () => {
  const a = { checked_at: 't1', score: 90, findings: group([{ id: 'title_long', url: 'https://example.com/a' }, { id: 'llms_missing', url: '' }]) };
  const b = { findings: group([{ id: 'title_long', url: 'https://example.com/b' }, { id: 'llms_missing', url: '' }]) };
  const d = diff(a, b);
  assert.deepEqual(d.fixed.map((x) => x.url), ['https://example.com/a']);
  assert.deepEqual(d.new.map((x) => x.url), ['https://example.com/b']);
  assert.equal(diff(null, b), null);
});

test('the AI answer: only pages it was shown, bounded strings, known severities', () => {
  const c = cleanAi({ summary: 'ok', findings: [
    { url: 'https://example.com/', severity: 'urgent', title: 'Vague hero', why: 'w', fix: 'f', verify: 'v' },
    { url: 'https://elsewhere.example/', severity: 'high', title: 'Not shown' },
    { url: '', severity: 'low', title: 'Site wide' },
  ], pages: [{ url: 'https://example.com/', title: 'Better title', description: '' }, { url: 'https://nope.example/', title: 'x' }] }, ['https://example.com/']);
  assert.deepEqual(c.findings.map((f) => [f.title, f.severity]), [['Vague hero', 'medium'], ['Site wide', 'low']]);
  assert.equal(c.pages.length, 1);
});

test('an alternate-cron redirect is named for what it is, not as a chain', () => {
  const f = ids(pageFindings({ ...good, redirects: ['302 https://example.com/news'], finalUrl: 'https://example.com/news?doing_wp_cron=1.2', canonicals: ['https://example.com/news'], url: 'https://example.com/news' }));
  assert.ok(f.includes('wp_cron_redirect'));
  assert.ok(!f.includes('redirect_chain'));
  assert.ok(!f.includes('canonical_elsewhere'));
});

test('AI findings never count as fixed or new between runs', () => {
  const a = { checked_at: 't1', score: 90, findings: group([{ id: 'ai_content', url: '', title: 'One wording' }]) };
  const b = { findings: group([{ id: 'ai_content', url: '', title: 'Another wording' }]) };
  assert.deepEqual([diff(a, b).fixed.length, diff(a, b).new.length], [0, 0]);
});

test('local addresses are not public (PageSpeed cannot reach them)', () => {
  for (const h of ['localhost', '127.0.0.1', '192.168.1.4', 'mysite.local', 'site.test']) assert.equal(isPublicHost(h), false, h);
  assert.equal(isPublicHost('www.example.com'), true);
});

test('the Markdown report carries the plan, the fix and the check', () => {
  const r = { host: 'example.com', checked_at: '2026-01-01T00:00:00Z', mode: 'quick', score: 92, counts: { high: 1 }, notes: [], pages: [{ url: 'https://example.com/', status: 200, words: 300, title: 'Home' }], findings: group([{ id: 'noindex', url: 'https://example.com/' }]) };
  const md = toMarkdown(r);
  assert.match(md, /### 1\. The page asks search engines not to index it \(high\)/);
  assert.match(md, /\*\*Check it worked:\*\*/);
});
