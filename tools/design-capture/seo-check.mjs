#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * SEO CHECK — audit any website the way a search engine sees it, and hand back one ranked plan.
 *
 * One engine, two ways in: the dashboard's SEO Check view (through serve.mjs, POST /seo-check) and the
 * kit's `seo-check` skill (through this file's CLI). Both must give the same answer, so neither has checks
 * of its own: everything that decides what is wrong lives here.
 *
 * WHAT IT LOOKS AT, in three passes:
 *   1. The site: robots.txt (and what it does to search and AI crawlers), the sitemap, llms.txt, the
 *      http→https and www redirects, and whether a page that does not exist answers 404.
 *   2. Each page, twice: the HTML the server sends (what a crawler gets before any JavaScript) and the
 *      page a real browser renders. Titles, descriptions, canonicals, robots, headings, alt text, social
 *      tags, structured data, hreflang, mixed content, thin pages, broken internal links.
 *   3. Optionally, Lighthouse through Google's PageSpeed Insights (public sites only) and a read of the
 *      main pages by the kit's AI, for what rules cannot judge: thin or vague content, missing proof of
 *      experience, answers an AI search would not quote.
 *
 * WHAT IT DOES NOT DO: change anything. It reads public pages. Fixing happens in WordPress (the SEO
 * extension's tools, through the AI Assistant or an agent), never from here.
 *
 * The finding rules are pure functions (pageFindings, siteFindings, group, score, diff, toMarkdown) so
 * seo-check.test.mjs can prove them without a network.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (compatible; UnysonPlusSEOCheck/1.0; +https://www.unysonplus.com)';

export const SEVERITY = ['critical', 'high', 'medium', 'low'];
/** Points one finding takes off the score, whatever the number of pages it is on. */
export const WEIGHT = { critical: 15, high: 7, medium: 3, low: 1, info: 0 };

/* ------------------------------------------------------------------ *
 * The rules. Each id has ONE wording, so a finding reads the same in
 * the dashboard, the Markdown report and the skill's plan.
 * ------------------------------------------------------------------ */

export const RULES = {
  // Site
  robots_blocks_all: { severity: 'critical', area: 'Crawling', title: 'robots.txt blocks every crawler from the whole site', why: 'A `Disallow: /` for all user agents keeps search engines out of every page. Usually a leftover from a staging site.', fix: 'Remove the `Disallow: /` line for `User-agent: *` (in WordPress: Settings → Reading, untick "Discourage search engines", and check the SEO extension\'s robots.txt editor).', verify: 'Open /robots.txt and confirm the `User-agent: *` group no longer disallows `/`.', fixWith: 'seo_update_settings' },
  robots_missing: { severity: 'low', area: 'Crawling', title: 'No robots.txt', why: 'Crawlers still work without one, but it is where they look for the sitemap first.', fix: 'Serve a robots.txt that allows crawling and names the sitemap.', verify: 'Open /robots.txt: it answers 200 and lists a `Sitemap:` line.', fixWith: 'seo_update_settings' },
  sitemap_missing: { severity: 'medium', area: 'Crawling', title: 'No XML sitemap found', why: 'Without a sitemap, search engines find pages only by following links, so deep or new pages are found late or never.', fix: 'Publish an XML sitemap (the SEO extension does this at /sitemap.xml) and submit it in Search Console and Bing Webmaster Tools.', verify: 'Open /sitemap.xml and confirm it lists your pages.', fixWith: 'seo_update_settings' },
  sitemap_not_in_robots: { severity: 'low', area: 'Crawling', title: 'robots.txt does not name the sitemap', why: 'A `Sitemap:` line lets every crawler find the sitemap without being told.', fix: 'Add `Sitemap: <your sitemap URL>` to robots.txt.', verify: 'robots.txt contains a `Sitemap:` line.', fixWith: 'seo_update_settings' },
  llms_missing: { severity: 'low', area: 'AI search', title: 'No llms.txt', why: 'llms.txt is a short Markdown index of a site for AI assistants. Not a ranking factor, but cheap, and some AI tools read it.', fix: 'Publish /llms.txt: the site name, one line on what it is, and links to the main pages with a sentence each.', verify: 'Open /llms.txt: it answers 200 as plain text or Markdown.', fixWith: '' },
  no_https_redirect: { severity: 'high', area: 'Security', title: 'The http:// address does not redirect to https://', why: 'Visitors and links that use http:// reach an unencrypted copy, and search engines may index both.', fix: 'Redirect every http:// request to the same https:// address with a 301.', verify: 'Open the http:// address: it ends on the https:// one.', fixWith: '' },
  host_duplicate: { severity: 'medium', area: 'Crawling', title: 'Both the www and the bare domain show the site', why: 'Two addresses with the same pages split links and can be indexed as duplicates.', fix: 'Pick one and 301-redirect the other to it.', verify: 'Open the other address: it redirects to the chosen one.', fixWith: '' },
  soft_404: { severity: 'medium', area: 'Crawling', title: 'A page that does not exist answers 200 instead of 404', why: 'Search engines then treat error pages as real pages ("soft 404"), and broken links look fine.', fix: 'Make the server answer 404 for unknown addresses (WordPress does this unless a plugin or theme overrides it).', verify: 'Open a made-up address on the site: the status is 404.', fixWith: '' },
  ai_crawlers_blocked: { severity: 'info', area: 'AI search', title: 'robots.txt blocks some AI crawlers', why: 'Blocking AI training crawlers is a choice, not an error. Blocking the crawlers AI search uses to fetch pages keeps the site out of AI answers.', fix: 'Keep training crawlers blocked if you want, but allow search-time crawlers (OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot) if you want to be cited.', verify: 'Read the robots.txt groups for those user agents.', fixWith: 'seo_update_settings' },
  broken_internal_links: { severity: 'high', area: 'Links', title: 'Links to pages that do not exist', why: 'Broken links waste crawl time, lose link value and send visitors to an error page.', fix: 'Change each link to a page that exists, or redirect the missing address to the nearest one.', verify: 'Run the check again: no broken links.', fixWith: 'seo_save_redirect' },
  duplicate_titles: { severity: 'medium', area: 'Titles', title: 'Several pages share one title', why: 'Search engines cannot tell which page answers which search, and results look the same.', fix: 'Give each page its own title that says what is on it.', verify: 'Every page title is different.', fixWith: 'seo_update_page' },
  duplicate_descriptions: { severity: 'low', area: 'Titles', title: 'Several pages share one meta description', why: 'Search engines often replace duplicate descriptions with text of their own choosing.', fix: 'Write a description for each page, or leave it empty so the page\'s own text is used.', verify: 'Every description is different.', fixWith: 'seo_update_page' },

  // Page
  status_error: { severity: 'critical', area: 'Crawling', title: 'The page answers with an error', why: 'A page that answers 4xx or 5xx is dropped from search.', fix: 'Restore the page, or redirect its address to the page that replaced it.', verify: 'The page answers 200.', fixWith: 'seo_save_redirect' },
  wp_cron_redirect: { severity: 'medium', area: 'Crawling', title: 'WordPress redirects visitors to run its scheduled tasks', why: 'With ALTERNATE_WP_CRON on, any visit made while a scheduled task is due is answered with a redirect to ?doing_wp_cron=…, so visitors and search engines sometimes get a 302 instead of the page.', fix: 'Remove ALTERNATE_WP_CRON from wp-config.php; if WordPress cron does not run on its own there, set DISABLE_WP_CRON and call wp-cron.php from a real server cron job.', verify: 'Load the page several times over a few minutes: it never redirects to ?doing_wp_cron.', fixWith: '' },
  redirect_chain: { severity: 'low', area: 'Links', title: 'The address goes through more than one redirect', why: 'Each hop slows the visit and loses a little link value; long chains may not be followed.', fix: 'Point links and the first redirect straight at the final address.', verify: 'The address reaches the page in one step.', fixWith: 'seo_save_redirect' },
  noindex: { severity: 'high', area: 'Indexing', title: 'The page asks search engines not to index it', why: 'A noindex in the robots meta tag or the X-Robots-Tag header keeps the page out of search. Right for thank-you pages, wrong for anything you want found.', fix: 'Remove the noindex if the page should be found (in Unyson+: the SEO box → Advanced).', verify: 'The page source has no `noindex`.', fixWith: 'seo_update_page' },
  title_missing: { severity: 'high', area: 'Titles', title: 'No page title', why: 'The title is the headline of the search result. Without one, the search engine makes one up.', fix: 'Write a title of about 50-60 characters that says what the page is.', verify: 'The page has a <title>.', fixWith: 'seo_update_page' },
  title_long: { severity: 'low', area: 'Titles', title: 'Title longer than 60 characters', why: 'Search results cut long titles, so the end is lost.', fix: 'Shorten the title, keeping the words people search at the start.', verify: 'The title is 60 characters or fewer.', fixWith: 'seo_update_page' },
  title_short: { severity: 'low', area: 'Titles', title: 'Title shorter than 15 characters', why: 'A very short title rarely says enough to win the click.', fix: 'Say what the page offers, and who for.', verify: 'The title is 15 characters or more.', fixWith: 'seo_update_page' },
  description_missing: { severity: 'medium', area: 'Titles', title: 'No meta description', why: 'The description is the text under the search result title; without one, the search engine picks a snippet itself.', fix: 'Write a description of about 120-155 characters that makes the click worth it.', verify: 'The page has a meta description.', fixWith: 'seo_update_page' },
  description_long: { severity: 'low', area: 'Titles', title: 'Meta description longer than 160 characters', why: 'Search results cut it, so the end is lost.', fix: 'Shorten it to about 155 characters.', verify: 'The description is 160 characters or fewer.', fixWith: 'seo_update_page' },
  description_short: { severity: 'low', area: 'Titles', title: 'Meta description shorter than 50 characters', why: 'Too short to persuade anyone to click.', fix: 'Say what the visitor gets on the page.', verify: 'The description is 50 characters or more.', fixWith: 'seo_update_page' },
  canonical_missing: { severity: 'low', area: 'Indexing', title: 'No canonical link', why: 'A canonical tells search engines which address is the real one when the same page is reachable several ways.', fix: 'Add a self-referencing canonical (the SEO extension does this on every page).', verify: 'The page has <link rel="canonical"> pointing at itself.', fixWith: 'seo_update_page' },
  canonical_multiple: { severity: 'high', area: 'Indexing', title: 'More than one canonical link', why: 'Search engines ignore canonicals that disagree, so none of them counts.', fix: 'Keep one canonical; usually two plugins or a theme and a plugin both add one.', verify: 'The page has exactly one canonical.', fixWith: '' },
  canonical_elsewhere: { severity: 'medium', area: 'Indexing', title: 'The canonical points at another address', why: 'The page asks search engines to index a different address instead of this one. Right for duplicates, wrong for a page you want found.', fix: 'Point the canonical at the page itself unless it really is a copy.', verify: 'The canonical equals the page address.', fixWith: 'seo_update_page' },
  h1_missing: { severity: 'medium', area: 'Content', title: 'No H1 heading', why: 'The H1 tells visitors and search engines what the page is about.', fix: 'Give the page one H1 (usually its title).', verify: 'The page has one <h1>.', fixWith: '' },
  h1_multiple: { severity: 'low', area: 'Content', title: 'More than one H1 heading', why: 'Not an error, but one clear main heading reads better and is easier for screen readers.', fix: 'Keep one H1 and turn the others into H2.', verify: 'The page has one <h1>.', fixWith: '' },
  heading_skip: { severity: 'low', area: 'Content', title: 'Heading levels are skipped', why: 'Jumping from H2 to H4 breaks the outline that screen readers and search engines read.', fix: 'Use heading levels in order.', verify: 'No level is skipped.', fixWith: '' },
  images_no_alt: { severity: 'medium', area: 'Images', title: 'Images without alt text', why: 'Alt text is how screen readers and image search understand a picture. (alt="" is fine for decoration.)', fix: 'Describe each meaningful image in a few words (in Unyson+: the AI Assistant can draft them in bulk).', verify: 'Every image has an alt attribute.', fixWith: 'update_media' },
  lang_missing: { severity: 'low', area: 'Content', title: 'The page does not state its language', why: 'The `lang` attribute helps search engines serve the page in the right country and screen readers pronounce it.', fix: 'Set `<html lang="…">` (WordPress does this from Settings → General → Site Language).', verify: 'The <html> element has a lang attribute.', fixWith: '' },
  viewport_missing: { severity: 'high', area: 'Mobile', title: 'No mobile viewport tag', why: 'Without it, phones show the desktop layout shrunk, and search engines rank by the mobile page.', fix: 'Add `<meta name="viewport" content="width=device-width, initial-scale=1">`.', verify: 'The page has a viewport meta tag.', fixWith: '' },
  og_missing: { severity: 'low', area: 'Social', title: 'No social sharing image or title', why: 'Without Open Graph tags, a shared link shows no picture and a guessed title.', fix: 'Set an og:title and og:image (the SEO extension adds them; set a default share image in its settings).', verify: 'The page has og:title and og:image.', fixWith: 'seo_update_page' },
  schema_invalid: { severity: 'medium', area: 'Structured data', title: 'Structured data that does not parse', why: 'A JSON-LD block with a syntax error is ignored completely, so the rich result it was meant for never shows.', fix: 'Fix the JSON (often a stray comma or an unescaped quote from a plugin or a hand-written block).', verify: 'Every JSON-LD block parses.', fixWith: '' },
  schema_none: { severity: 'low', area: 'Structured data', title: 'No structured data on the home page', why: 'Organization or WebSite structured data tells search engines who is behind the site and can add a logo and site name to results.', fix: 'Add Organization (or LocalBusiness) and WebSite JSON-LD (the SEO extension does this from its settings).', verify: 'The home page has a JSON-LD block.', fixWith: 'seo_update_settings' },
  thin_content: { severity: 'medium', area: 'Content', title: 'Very little text on the page', why: 'Pages with under about 250 words rarely answer a search well enough to rank.', fix: 'Add what a visitor needs to decide: details, answers to common questions, examples.', verify: 'The page has more substance (the word count is a guide, not a target).', fixWith: '' },
  js_only_content: { severity: 'high', area: 'Rendering', title: 'The text appears only after JavaScript runs', why: 'The HTML the server sends has almost no text. Google renders JavaScript later and not always; most AI crawlers never do.', fix: 'Render the main content on the server (a normal WordPress page already does).', verify: 'View the page source: the main text is in it.', fixWith: '' },
  mixed_content: { severity: 'high', area: 'Security', title: 'An https page loads files over http', why: 'Browsers block or warn about insecure files on a secure page, so images or scripts can go missing.', fix: 'Change those addresses to https://.', verify: 'The page loads no http:// files.', fixWith: '' },
  hreflang_no_self: { severity: 'low', area: 'International', title: 'Language links without one for the page itself', why: 'hreflang sets are expected to include the page\'s own language, or search engines may ignore them.', fix: 'Add an hreflang link for the page\'s own language.', verify: 'The page lists itself among its language links.', fixWith: '' },
  slow_response: { severity: 'low', area: 'Speed', title: 'The server takes over 1.5 seconds to answer', why: 'A slow first byte delays everything else and hurts Core Web Vitals.', fix: 'Turn on page caching and check slow plugins or hosting.', verify: 'The server answers in under a second.', fixWith: '' },

  // Lighthouse
  lighthouse_seo: { severity: 'medium', area: 'Lighthouse', title: 'Lighthouse SEO audit failed', why: 'Google\'s own SEO checklist flagged this.', fix: 'See the audit note.', verify: 'Lighthouse passes the audit.', fixWith: '' },
  lighthouse_cwv: { severity: 'medium', area: 'Speed', title: 'Core Web Vitals need work for real visitors', why: 'Google uses real-visitor loading, interaction and layout-stability data (from Chrome users) in ranking.', fix: 'Fix the slowest metric first: large images and render-blocking files for LCP, heavy scripts for INP, missing image sizes for CLS.', verify: 'The field data shows "Good" (it updates over 28 days).', fixWith: '' },
  lighthouse_score: { severity: 'medium', area: 'Lighthouse', title: 'Low Lighthouse score', why: 'A low score in one of Lighthouse\'s categories usually hides several smaller problems.', fix: 'Open the PageSpeed Insights report for the details.', verify: 'The score is 90 or more.', fixWith: '' },

  // AI review
  ai_content: { severity: 'medium', area: 'Content (AI review)', title: 'Content', why: '', fix: '', verify: '', fixWith: '' },
};

/** AI crawlers, split by what blocking them costs. */
export const AI_BOTS = {
  training: ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider', 'meta-externalagent', 'Amazonbot'],
  search: ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Claude-SearchBot', 'Claude-User'],
};

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/** robots.txt → { groups: [{ agents:[], rules:[{allow,path}] }], sitemaps:[] } */
export function parseRobots(text) {
  const groups = []; const sitemaps = [];
  let cur = null; let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'disallow' || key === 'allow') cur.rules.push({ allow: key === 'allow', path: val });
  }
  return { groups, sitemaps };
}

/** Does this robots.txt keep `agent` out of `/`? Most specific group wins, as crawlers read it. */
export function robotsBlocksRoot(robots, agent) {
  const a = String(agent).toLowerCase();
  const own = robots.groups.filter((g) => g.agents.includes(a));
  const groups = own.length ? own : robots.groups.filter((g) => g.agents.includes('*'));
  if (!groups.length) return false;
  const rules = groups.flatMap((g) => g.rules);
  const dis = rules.some((r) => !r.allow && r.path === '/');
  const allowRoot = rules.some((r) => r.allow && (r.path === '/' || r.path === '/$'));
  return dis && !allowRoot;
}

/** Strip a URL down to what makes two addresses the same page (the query string does not: ?page=2 and a
 *  stray ?doing_wp_cron are views of the page, and their canonical rightly points at the bare address). */
export function sameUrl(a, b) {
  const n = (u) => { try { const x = new URL(u); x.hash = ''; return x.origin.toLowerCase() + x.pathname.replace(/\/+$/, ''); } catch { return String(u || ''); } };
  return n(a) === n(b);
}

/** Findings for one page. `p` is what collectPage() returns; tested with hand-made objects. */
export function pageFindings(p, { isHome = false } = {}) {
  const out = [];
  const add = (id, detail = '') => out.push({ id, url: p.url, detail });
  if (p.status >= 400 || p.status === 0) { add('status_error', p.status ? 'HTTP ' + p.status : 'No answer' + (p.error ? ': ' + p.error : '')); return out; }
  const cron = /[?&]doing_wp_cron=/.test(String(p.finalUrl || ''));
  if (cron) add('wp_cron_redirect', 'Seen on this check; it comes and goes with the scheduled tasks');
  if (!cron && (p.redirects || []).length > 1) add('redirect_chain', p.redirects.length + ' redirects: ' + p.redirects.join(' → '));
  const robots = (String(p.robotsMeta || '') + ',' + String(p.xRobots || '')).toLowerCase();
  if (/noindex/.test(robots)) add('noindex', [p.robotsMeta && 'meta: ' + p.robotsMeta, p.xRobots && 'header: ' + p.xRobots].filter(Boolean).join('; '));
  const t = String(p.title || '').trim();
  if (!t) add('title_missing');
  else if (t.length > 60) add('title_long', t.length + ' characters: "' + t + '"');
  else if (t.length < 15) add('title_short', '"' + t + '"');
  const d = String(p.description || '').trim();
  if (!d) add('description_missing');
  else if (d.length > 160) add('description_long', d.length + ' characters');
  else if (d.length < 50) add('description_short', '"' + d + '"');
  const canon = p.canonicals || [];
  if (!canon.length) add('canonical_missing');
  else if (new Set(canon.map((c) => c.replace(/\/+$/, ''))).size > 1) add('canonical_multiple', canon.join(', '));
  else if (!sameUrl(canon[0], p.finalUrl || p.url)) add('canonical_elsewhere', canon[0]);
  const h1 = p.h1s || [];
  if (!h1.length) add('h1_missing');
  else if (h1.length > 1) add('h1_multiple', h1.length + ' H1s');
  let prev = 0; let skipped = '';
  for (const lvl of p.headingLevels || []) { if (prev && lvl > prev + 1) { skipped = 'H' + prev + ' → H' + lvl; break; } prev = lvl; }
  if (skipped) add('heading_skip', skipped);
  if (p.imagesNoAlt > 0) add('images_no_alt', p.imagesNoAlt + ' of ' + p.images + ' images');
  if (!p.lang) add('lang_missing');
  if (!p.viewport) add('viewport_missing');
  if (!p.ogTitle || !p.ogImage) add('og_missing', [!p.ogTitle && 'og:title', !p.ogImage && 'og:image'].filter(Boolean).join(' and ') + ' missing');
  if (p.jsonldInvalid > 0) add('schema_invalid', p.jsonldInvalid + ' block(s)');
  if (isHome && !(p.jsonldTypes || []).length && !p.jsonldInvalid) add('schema_none');
  if (p.words < 250 && !isHome && !/contact|kontakt|login|cart|checkout|account/i.test(p.url)) add('thin_content', p.words + ' words');
  if (p.words >= 150 && p.rawWords < p.words * 0.3) add('js_only_content', p.rawWords + ' words in the HTML, ' + p.words + ' after rendering');
  if ((p.mixed || []).length) add('mixed_content', p.mixed.slice(0, 3).join(', ') + (p.mixed.length > 3 ? ' …' : ''));
  if ((p.hreflang || []).length && !p.hreflang.some((h) => sameUrl(h.href, p.finalUrl || p.url))) add('hreflang_no_self', p.hreflang.length + ' language links');
  if (p.ttfb > 1500) add('slow_response', Math.round(p.ttfb) + ' ms');
  return out;
}

/** Findings that only make sense across the whole site. */
export function siteFindings(s) {
  const out = [];
  const add = (id, detail = '', urls = []) => out.push({ id, url: '', detail, urls });
  if (s.robots === null) add('robots_missing');
  else if (typeof s.robots === 'string') {
    const r = parseRobots(s.robots);
    const blocked = ['googlebot', 'bingbot'].filter((b) => robotsBlocksRoot(r, b));
    if (blocked.length) add('robots_blocks_all', blocked.length === 2 ? '' : 'Blocks ' + (blocked[0] === 'googlebot' ? 'Google' : 'Bing'));
    if (!r.sitemaps.length) add('sitemap_not_in_robots');
    const blockedSearch = AI_BOTS.search.filter((b) => robotsBlocksRoot(r, b));
    const blockedTrain = AI_BOTS.training.filter((b) => robotsBlocksRoot(r, b));
    // When everything is blocked the AI note only repeats it.
    if ((blockedSearch.length || blockedTrain.length) && !robotsBlocksRoot(r, '*')) {
      add('ai_crawlers_blocked', [blockedSearch.length && 'AI search: ' + blockedSearch.join(', '), blockedTrain.length && 'AI training: ' + blockedTrain.join(', ')].filter(Boolean).join('; '));
      if (blockedSearch.length) out[out.length - 1].severity = 'medium';
    }
  }
  if (!s.sitemapCount) add('sitemap_missing');
  if (s.llms === false) add('llms_missing');
  if (s.https && s.httpRedirects === false) add('no_https_redirect');
  if (s.otherHostServes) add('host_duplicate', s.otherHost);
  if (s.soft404) add('soft_404', s.soft404);
  if ((s.brokenLinks || []).length) add('broken_internal_links', s.brokenLinks.length + ' address(es)', s.brokenLinks.map((b) => b.url + ' (' + (b.status || 'no answer') + ', linked from ' + b.from + ')'));
  // Duplicates across the checked pages.
  const dupe = (key, id) => {
    const by = new Map();
    for (const p of s.pages || []) { const v = String(p[key] || '').trim(); if (!v || p.status >= 400) continue; if (!by.has(v)) by.set(v, []); by.get(v).push(p.url); }
    for (const [v, urls] of by) if (urls.length > 1) add(id, '"' + v.slice(0, 90) + '" on ' + urls.length + ' pages', urls);
  };
  dupe('title', 'duplicate_titles');
  dupe('description', 'duplicate_descriptions');
  return out;
}

/** Merge raw findings into one entry per rule (page rules) or per rule+detail (site rules). */
export function group(raw) {
  const map = new Map();
  for (const f of raw) {
    const rule = RULES[f.id] || {};
    const key = f.id + (f.url ? '' : '|' + (f.detail || '')) + (f.id === 'ai_content' || f.id === 'lighthouse_seo' ? '|' + f.title : '');
    if (!map.has(key)) {
      map.set(key, {
        id: f.id,
        severity: f.severity || rule.severity || 'low',
        area: f.area || rule.area || '',
        title: f.title || rule.title || f.id,
        why: f.why || rule.why || '',
        fix: f.fix || rule.fix || '',
        verify: f.verify || rule.verify || '',
        fixWith: rule.fixWith || '',
        detail: f.url ? '' : (f.detail || ''),
        pages: [],
      });
    }
    const g = map.get(key);
    if (f.url) g.pages.push({ url: f.url, detail: f.detail || '' });
    for (const u of f.urls || []) g.pages.push({ url: u, detail: '' });
  }
  const order = (s) => (s === 'info' ? 9 : SEVERITY.indexOf(s));
  return [...map.values()].sort((a, b) => order(a.severity) - order(b.severity) || b.pages.length - a.pages.length || a.title.localeCompare(b.title));
}

/**
 * 100 minus the weight of each finding (once per finding, not per page), floored at 0. The AI's content
 * findings are listed but not scored: they are judgement, and they vary between runs, so a score that
 * counted them would move when nothing on the site had changed.
 */
export function score(groups) {
  return Math.max(0, 100 - groups.filter((g) => g.id !== 'ai_content').reduce((n, g) => n + (WEIGHT[g.severity] || 0), 0));
}

/** The stable key a finding is compared by between two runs. */
function keysOf(groups) {
  const out = new Map();
  for (const g of groups) {
    const base = g.id + '|' + (g.id === 'ai_content' || g.id === 'lighthouse_seo' ? g.title : g.detail && !g.pages.length ? g.detail : '');
    if (!g.pages.length) out.set(base, { title: g.title, url: '' });
    for (const p of g.pages) out.set(base + '|' + p.url, { title: g.title, url: p.url });
  }
  return out;
}

/** What changed since the previous run of the same site: fixed and new findings. */
export function diff(prev, cur) {
  if (!prev) return null;
  // AI findings are reworded on every run, so they would show as fixed-and-new on an unchanged site.
  const rules = (list) => (list || []).filter((g) => g.id !== 'ai_content');
  const a = keysOf(rules(prev.findings)), b = keysOf(rules(cur.findings));
  const fixed = [...a].filter(([k]) => !b.has(k)).map(([, v]) => v);
  const added = [...b].filter(([k]) => !a.has(k)).map(([, v]) => v);
  return { previous_at: prev.checked_at, previous_score: prev.score, fixed, new: added };
}

/** Is this host reachable from outside (so PageSpeed Insights can fetch it)? */
export function isPublicHost(host) {
  const h = String(host || '').toLowerCase();
  return !(h === 'localhost' || h.endsWith('.local') || h.endsWith('.test') || h.endsWith('.localhost')
    || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '[::1]');
}

/* ------------------------------------------------------------------ *
 * Network
 * ------------------------------------------------------------------ */

async function get(url, { ms = 15000, method = 'GET', follow = true, maxHops = 6 } = {}) {
  const hops = [];
  let cur = url; const t0 = Date.now(); let ttfb = 0;
  for (let i = 0; i <= maxHops; i++) {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), ms);
    let r;
    try { r = await fetch(cur, { method, redirect: 'manual', signal: ac.signal, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*' } }); }
    catch (e) {
      clearTimeout(timer);
      const error = e && e.name === 'AbortError' ? 'No answer within ' + Math.round(ms / 1000) + ' seconds' : String((e && e.cause && e.cause.code) || (e && e.message) || e);
      return { url, finalUrl: cur, status: 0, error, redirects: hops, headers: {}, body: '', ttfb: Date.now() - t0 };
    }
    if (!ttfb) ttfb = Date.now() - t0;
    const loc = r.headers.get('location');
    if (follow && r.status >= 300 && r.status < 400 && loc) {
      clearTimeout(timer);
      hops.push(r.status + ' ' + cur);
      cur = new URL(loc, cur).href;
      continue;
    }
    let body = '';
    try { if (method === 'GET') body = await r.text(); } catch { /* */ }
    clearTimeout(timer);
    const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
    return { url, finalUrl: cur, status: r.status, redirects: hops, headers, body, ttfb };
  }
  return { url, finalUrl: cur, status: 0, error: 'Too many redirects', redirects: hops, headers: {}, body: '', ttfb };
}

function rawWordCount(html) {
  const s = String(html || '')
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  return (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

/** Read the rendered page. Runs in the browser. */
function extractInPage() {
  const q = (s) => document.querySelector(s);
  const meta = (n) => { const e = q('meta[name="' + n + '" i]') || q('meta[property="' + n + '" i]'); return e ? (e.getAttribute('content') || '') : ''; };
  const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => h.offsetParent !== null || h.getClientRects().length);
  const imgs = [...document.querySelectorAll('img')];
  const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || '');
  const types = []; let invalid = 0;
  for (const raw of jsonld) {
    try { const j = JSON.parse(raw); const walk = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach(walk); if (x['@type']) types.push(...[].concat(x['@type'])); if (x['@graph']) walk(x['@graph']); }; walk(j); }
    catch { invalid++; }
  }
  const main = q('main') || q('article') || q('[role="main"]') || document.body;
  const clone = main.cloneNode(true);
  clone.querySelectorAll('nav,header,footer,script,style,noscript,svg').forEach((n) => n.remove());
  const text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  const https = location.protocol === 'https:';
  const mixed = https ? [...document.querySelectorAll('img[src],script[src],link[rel="stylesheet"][href],iframe[src],video[src],audio[src],source[src]')]
    .map((e) => e.getAttribute('src') || e.getAttribute('href') || '').filter((u) => /^http:\/\//i.test(u)) : [];
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /^https?:/i.test(h));
  const html = document.documentElement.outerHTML;
  return {
    title: document.title || '',
    description: meta('description'),
    canonicals: [...document.querySelectorAll('link[rel="canonical" i]')].map((l) => l.href),
    robotsMeta: [meta('robots'), meta('googlebot')].filter(Boolean).join(', '),
    lang: document.documentElement.getAttribute('lang') || '',
    viewport: meta('viewport'),
    h1s: heads.filter((h) => h.tagName === 'H1').map((h) => h.innerText.trim().slice(0, 120)),
    headings: heads.slice(0, 40).map((h) => ({ level: +h.tagName[1], text: h.innerText.trim().slice(0, 120) })),
    headingLevels: heads.map((h) => +h.tagName[1]),
    images: imgs.length,
    imagesNoAlt: imgs.filter((i) => !i.hasAttribute('alt') && (i.naturalWidth === 0 || i.naturalWidth > 2)).length,
    ogTitle: meta('og:title'), ogImage: meta('og:image'), twitterCard: meta('twitter:card'),
    jsonldTypes: types, jsonldInvalid: invalid,
    hreflang: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => ({ lang: l.getAttribute('hreflang'), href: l.href })),
    words, text: text.slice(0, 6000), mixed: [...new Set(mixed)].slice(0, 20), links: [...new Set(links)],
    generator: meta('generator'),
    unysonPlus: /\/plugins\/unysonplus\//.test(html) || /\/themes\/unysonplus-theme\//.test(html),
    wordpress: /\/wp-content\/|\/wp-includes\//.test(html),
  };
}

/** Fetch a page twice: as the server sends it, and as a browser renders it. */
export async function collectPage(browser, url) {
  let raw = await get(url, { ms: 30000 });
  if (raw.status === 0) raw = await get(url, { ms: 30000 }); // a busy server, not a dead page: one more try
  const base = { url, finalUrl: raw.finalUrl, status: raw.status, redirects: raw.redirects, ttfb: raw.ttfb,
    xRobots: raw.headers['x-robots-tag'] || '', rawWords: rawWordCount(raw.body), error: raw.error || '' };
  if (raw.status >= 400 || raw.status === 0 || !/html/i.test(raw.headers['content-type'] || 'text/html')) return { ...base, words: 0, links: [] };
  const page = await browser.newPage({ userAgent: UA });
  try {
    await page.goto(raw.finalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    return { ...base, ...(await page.evaluate(extractInPage)) };
  } catch (e) {
    return { ...base, words: 0, links: [], error: 'Could not render: ' + String(e.message || e).split('\n')[0] };
  } finally { await page.close().catch(() => {}); }
}

/** The sitemap of a site in a sub-folder: its own files only, one index level deep. */
async function folderSitemap(folder) {
  const found = new Set(); const queue = [folder + '/wp-sitemap.xml', folder + '/sitemap.xml', folder + '/sitemap_index.xml']; const seen = new Set(); let indexes = 8;
  while (queue.length && found.size < 2000) {
    const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);
    const r = await get(u, { ms: 12000 }); if (r.status !== 200 || !/<(urlset|sitemapindex)[\s>]/i.test(r.body)) continue;
    const locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex[\s>]/i.test(r.body)) { for (const l of locs) if (indexes-- > 0 && !/(taxonom|categor|tag|author|users)/i.test(l)) queue.push(l); continue; }
    for (const l of locs) if (l.startsWith(folder + '/') || l === folder) found.add(l);
  }
  return [...found].map((url) => ({ url, kind: '' }));
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

/** Google's PageSpeed Insights for one URL (mobile). Works without a key, within a shared quota. */
const settingsFile = () => join(historyDir(), '..', 'seo-check-settings.json');
/** Settings kept on this computer only: the PageSpeed Insights key. */
export function getSettings() { try { return JSON.parse(readFileSync(settingsFile(), 'utf8')) || {}; } catch { return {}; } }
export function setSettings(next) {
  const cur = getSettings(); const out = { ...cur };
  if (typeof next.psi_key === 'string') out.psi_key = next.psi_key.trim().replace(/[^A-Za-z0-9_-]/g, '');
  mkdirSync(dirname(settingsFile()), { recursive: true }); writeFileSync(settingsFile(), JSON.stringify(out, null, 2));
  return publicSettings();
}
/** What the dashboard may see: whether a key is set, never the key. */
export function publicSettings() { const k = psiKey(); return { psi_key_set: !!k, psi_key_from: process.env.PSI_API_KEY || process.env.GOOGLE_API_KEY ? 'environment' : (k ? 'saved' : '') }; }
export function psiKey() { return process.env.PSI_API_KEY || process.env.GOOGLE_API_KEY || getSettings().psi_key || ''; }

export async function pageSpeed(url, { key = psiKey() } = {}) {
  const u = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  u.searchParams.set('url', url); u.searchParams.set('strategy', 'mobile');
  for (const c of ['performance', 'accessibility', 'best-practices', 'seo']) u.searchParams.append('category', c);
  if (key) u.searchParams.set('key', key);
  const r = await fetch(u, { signal: AbortSignal.timeout(90000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || '';
    // Google's quota message names its internal project; say what it means instead.
    if (r.status === 429 || /quota/i.test(msg)) throw new Error(key ? "your key's PageSpeed Insights quota is used up for today" : "Google's shared daily PageSpeed Insights quota is used up");
    throw new Error(msg.split('.')[0] || 'PageSpeed Insights answered ' + r.status);
  }
  const lr = j.lighthouseResult || {};
  const scores = {};
  for (const [k, v] of Object.entries(lr.categories || {})) scores[k] = v.score == null ? null : Math.round(v.score * 100);
  const seoRefs = ((lr.categories || {}).seo || {}).auditRefs || [];
  const failed = seoRefs.map((ref) => (lr.audits || {})[ref.id]).filter((a) => a && a.score !== null && a.score < 1 && a.scoreDisplayMode !== 'notApplicable' && a.scoreDisplayMode !== 'manual')
    .map((a) => ({ id: a.id, title: a.title, note: String(a.description || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 300) }));
  const le = j.loadingExperience || {};
  const field = {};
  for (const [k, v] of Object.entries(le.metrics || {})) field[k] = { p75: v.percentile, category: v.category };
  return { scores, failed, field, overall: le.overall_category || '' };
}

/* ------------------------------------------------------------------ *
 * The AI read
 * ------------------------------------------------------------------ */

export function aiPrompt(pages, site) {
  const sample = pages.map((p) => ({
    url: p.url, title: p.title, description: p.description, h1: (p.h1s || [])[0] || '',
    headings: (p.headings || []).slice(0, 16).map((h) => 'H' + h.level + ' ' + h.text), words: p.words,
    text: String(p.text || '').split(/\s+/).slice(0, 700).join(' '),
  }));
  const system = 'You are a senior SEO editor reviewing a website\'s main pages for what automated checks cannot judge. '
    + 'You are given each page\'s title, description, headings and text. Reply with JSON only, no prose.';
  const user = [
    'Site: ' + site,
    'PAGES:', JSON.stringify(sample),
    '',
    'Judge, for each page and for the site as a whole:',
    '- Does the page clearly answer what someone searching for it wants? Is it vague, generic or padded?',
    '- Experience and trust (E-E-A-T): real details, examples, names, numbers, proof, who is behind it, how to contact them.',
    '- Would an AI search answer quote it? Clear direct answers, definitions, facts in short self-contained sentences, lists, FAQs.',
    '- Do the title and description promise what the page delivers, with the words people would search?',
    '- Topics a visitor would expect that no page covers.',
    '',
    'Return exactly this JSON shape:',
    '{"summary":"<two sentences on the site\'s content overall>",',
    ' "findings":[{"url":"<one of the page urls, or empty for site-wide>","severity":"high|medium|low","title":"<short problem, 3-9 words>","why":"<one or two sentences, specific to this page>","fix":"<what to write or change, concretely>","verify":"<how to tell it is done>"}],',
    ' "pages":[{"url":"<page url>","title":"<a better title under 60 characters, or empty if it is already good>","description":"<a better description of 120-155 characters, or empty if it is already good>"}]}',
    '',
    'Rules: at most 12 findings, the most important first. Be specific: name the section or claim, never "add more content". '
    + 'Do not repeat technical checks (missing tags, alt text, speed): those are already covered. '
    + 'Only suggest a title or description that is clearly better, and keep the brand at the end of a title only if the original had it.',
  ].join('\n');
  return { system, user };
}

/** Keep only what the model was allowed to say about pages it was actually shown. */
export function cleanAi(j, urls) {
  const ok = new Set(urls); const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const sev = (s) => (['high', 'medium', 'low'].includes(s) ? s : 'medium');
  const findings = (Array.isArray(j && j.findings) ? j.findings : []).slice(0, 12)
    .filter((f) => f && clean(f.title, 90) && (!f.url || ok.has(f.url)))
    .map((f) => ({ id: 'ai_content', url: f.url || '', urls: [], severity: sev(f.severity), area: 'Content (AI review)', title: clean(f.title, 90), why: clean(f.why, 400), fix: clean(f.fix, 500), verify: clean(f.verify, 240), detail: '' }));
  const pages = (Array.isArray(j && j.pages) ? j.pages : []).filter((p) => p && ok.has(p.url))
    .map((p) => ({ url: p.url, title: clean(p.title, 70), description: clean(p.description, 170) })).filter((p) => p.title || p.description);
  return { summary: clean(j && j.summary, 600), findings, pages };
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

export function historyDir() {
  const root = process.env.CAPTURE_OUT || resolve(HERE, '..', '..', '..', '..', 'capture-out');
  return join(root, '_seo-checks');
}
const hostDir = (host) => join(historyDir(), String(host).replace(/[^a-z0-9.-]/gi, '_'));

export function listHistory(host) {
  const d = hostDir(host); if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json')).sort().reverse().map((f) => {
    try { const j = JSON.parse(readFileSync(join(d, f), 'utf8')); return { file: f, checked_at: j.checked_at, score: j.score, mode: j.mode, counts: j.counts }; } catch { return null; }
  }).filter(Boolean);
}
export function listSitesChecked() {
  const d = historyDir(); if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).map((h) => { const runs = listHistory(h); return runs.length ? { host: h, last: runs[0] } : null; }).filter(Boolean)
    .sort((a, b) => String(b.last.checked_at).localeCompare(String(a.last.checked_at)));
}
export function readReport(host, file) {
  const runs = listHistory(host); const f = file || (runs[0] && runs[0].file);
  if (!f || /[\\/]/.test(f)) return null;
  try { return JSON.parse(readFileSync(join(hostDir(host), f), 'utf8')); } catch { return null; }
}

/**
 * Check a site. mode 'quick' = the address given (plus the site checks); 'full' = the pages in the
 * sitemap, up to `limit`. Returns the report and saves it to the history.
 */
export async function checkSite({ url, mode = 'quick', limit = 25, ai = true, lighthouse = true, onProgress = () => {}, ask = null } = {}) {
  let start;
  try { start = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url); } catch { throw new Error('That is not a web address.'); }
  const step = (s) => { try { onProgress(s); } catch { /* */ } };
  const origin = start.origin; const host = start.host;
  const report = { url: start.href, host, mode, checked_at: new Date().toISOString(), tool: 'seo-check 1', notes: [] };

  step('Reading robots.txt, the sitemap and llms.txt');
  const robotsRes = await get(origin + '/robots.txt', { ms: 10000 });
  // No answer is not the same as no file: an unreachable robots.txt or llms.txt is left unjudged.
  const robots = robotsRes.status === 0 ? undefined : robotsRes.status === 200 && !/<html/i.test(robotsRes.body.slice(0, 300)) ? robotsRes.body : null;
  if (robots === undefined) report.notes.push('robots.txt could not be read (' + robotsRes.error + '), so its checks were skipped.');
  const llmsRes = await get(origin + '/llms.txt', { ms: 10000 });
  const llms = llmsRes.status === 0 ? undefined : llmsRes.status === 200 && !/<html/i.test(llmsRes.body.slice(0, 300)) && llmsRes.body.trim().length > 20;
  const { sitemapPages, closeDiscoveryBrowser } = await import('./discover.mjs');
  // A site in a sub-folder (WordPress at example.com/blog/) keeps its sitemap there, and the host's
  // own sitemap belongs to another site: read the folder's first and keep only its pages.
  const folder = mode === 'full' && start.pathname !== '/' && start.pathname.endsWith('/') ? start.origin + start.pathname.replace(/\/+$/, '') : '';
  let sitemap = [];
  try {
    sitemap = folder ? await folderSitemap(folder) : (await sitemapPages(origin, { cap: 2000 })).filter((x) => x.kind !== 'archive');
  } catch { /* */ }
  finally { await closeDiscoveryBrowser().catch(() => {}); }

  step('Checking redirects and error pages');
  let httpRedirects = null;
  if (start.protocol === 'https:') {
    const h = await get('http://' + host + '/', { ms: 10000 });
    httpRedirects = h.status !== 0 ? /^https:/i.test(h.finalUrl) : null;
  }
  let otherHostServes = false; let otherHost = '';
  if (isPublicHost(host) && host.split('.').length >= 2 && !/^\d/.test(host)) {
    otherHost = host.startsWith('www.') ? host.slice(4) : 'www.' + host;
    const o = await get(start.protocol + '//' + otherHost + '/', { ms: 8000 });
    otherHostServes = o.status === 200 && new URL(o.finalUrl).host === otherHost && o.redirects.length === 0;
  }
  const probe = await get(origin + '/this-page-should-not-exist-' + Math.random().toString(36).slice(2, 9) + '/', { ms: 10000 });
  const soft404 = probe.status === 200 ? 'A made-up address answered 200' : '';

  // Which pages.
  let urls = [start.href];
  if (mode === 'full') {
    const extra = sitemap.map((x) => x.url).filter((u) => !sameUrl(u, start.href));
    urls = [start.href, ...extra].slice(0, Math.max(1, Math.min(100, limit)));
    if (!sitemap.length) report.notes.push('No sitemap was found, so only the address given was checked. The full check reads its pages from the sitemap.');
  }

  const { chromium } = await import('playwright-core');
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  const pages = [];
  try {
    let done = 0;
    await pool(urls, 3, async (u) => {
      const p = await collectPage(browser, u); pages.push(p);
      step('Checked ' + (++done) + ' of ' + urls.length + ' pages');
    });
  } finally { await browser.close().catch(() => {}); }
  pages.sort((a, b) => urls.indexOf(a.url) - urls.indexOf(b.url));

  // Internal links that go nowhere: a sample of the ones not already checked as pages.
  step('Checking internal links');
  const known = new Map(pages.map((p) => [p.url.replace(/\/+$/, ''), p.status]));
  const linkFrom = new Map();
  for (const p of pages) for (const l of p.links || []) {
    let x; try { x = new URL(l); } catch { continue; }
    if (x.host !== host) continue; x.hash = '';
    if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|webm|mp3)$/i.test(x.pathname) || /\/wp-(admin|login)/.test(x.pathname) || /[?&](add-to-cart|replytocom)=/.test(x.search)) continue;
    const k = x.href.replace(/\/+$/, '');
    if (!linkFrom.has(k)) linkFrom.set(k, p.url);
  }
  const toCheck = [...linkFrom.keys()].filter((k) => !known.has(k)).slice(0, mode === 'full' ? 80 : 40);
  const brokenLinks = [];
  await pool(toCheck, 5, async (k) => {
    let r = await get(k, { ms: 12000, method: 'HEAD' });
    if (r.status === 405 || r.status === 403 || r.status === 0) r = await get(k, { ms: 12000 });
    if (r.status === 404 || r.status === 410) brokenLinks.push({ url: k, status: r.status, from: linkFrom.get(k) });
  });

  // Findings.
  const raw = [];
  pages.forEach((p, i) => raw.push(...pageFindings(p, { isHome: new URL(p.url).pathname === '/' || (!!folder && sameUrl(p.url, start.href)) })));
  raw.push(...siteFindings({
    robots, sitemapCount: sitemap.length, llms, https: start.protocol === 'https:', httpRedirects,
    otherHostServes, otherHost, soft404, brokenLinks, pages,
  }));

  // Lighthouse, public sites only.
  if (lighthouse) {
    if (!isPublicHost(host)) report.notes.push('Lighthouse was skipped: Google\'s PageSpeed Insights cannot reach a site that only runs on this computer.');
    else {
      step('Running Lighthouse through PageSpeed Insights (about a minute)');
      try {
        const ps = await pageSpeed(pages[0] ? pages[0].finalUrl || pages[0].url : start.href);
        report.lighthouse = ps;
        for (const [k, v] of Object.entries(ps.scores)) if (v != null && v < 70) raw.push({ id: 'lighthouse_score', url: '', detail: k + ': ' + v, title: 'Low Lighthouse ' + k.replace('-', ' ') + ' score (' + v + ')', severity: v < 50 ? 'high' : 'medium' });
        for (const a of ps.failed) raw.push({ id: 'lighthouse_seo', url: '', title: 'Lighthouse: ' + a.title, detail: '', why: a.note || RULES.lighthouse_seo.why, severity: 'medium' });
        const bad = Object.entries(ps.field || {}).filter(([, v]) => v.category === 'SLOW' || v.category === 'AVERAGE');
        if (bad.length) raw.push({ id: 'lighthouse_cwv', url: '', detail: bad.map(([k, v]) => k.replace(/_/g, ' ').toLowerCase() + ' ' + v.p75 + ' (' + v.category.toLowerCase() + ')').join('; '), severity: bad.some(([, v]) => v.category === 'SLOW') ? 'high' : 'medium' });
      } catch (e) { report.notes.push('Lighthouse could not run: ' + e.message + '.' + (psiKey() ? '' : ' Add your own free Google API key in the SEO Check settings (or set PSI_API_KEY) to get a quota of your own.')); }
    }
  }

  // The AI read.
  if (ai) {
    const askFn = ask || (await import('./to-ai.mjs').then((m) => (m.aiReady() ? m.askText : null)).catch(() => null));
    const readable = pages.filter((p) => p.status < 400 && p.words > 0);
    if (!askFn) report.notes.push('The content review was skipped: no AI is set up in the kit.');
    else if (!readable.length) report.notes.push('The content review was skipped: no page had readable text.');
    else {
      step('Reading the main pages with the AI');
      const pick = [readable[0], ...readable.slice(1).sort((a, b) => b.words - a.words)].slice(0, 6);
      try {
        const { system, user } = aiPrompt(pick, origin);
        const txt = await askFn({ system, user, maxTokens: 5000 });
        const { extractJson } = await import('./to-ai.mjs');
        const j = extractJson(txt);
        if (!j) throw new Error('the answer was not JSON');
        const c = cleanAi(j, pick.map((p) => p.url));
        report.ai = { summary: c.summary, suggestions: c.pages, pages_read: pick.map((p) => p.url) };
        raw.push(...c.findings);
      } catch (e) { report.notes.push('The content review failed: ' + e.message); }
    }
  }

  report.findings = group(raw);
  report.score = score(report.findings);
  report.counts = Object.fromEntries([...SEVERITY, 'info'].map((s) => [s, report.findings.filter((f) => f.severity === s).length]));
  report.site = {
    robots: robots === undefined ? null : robots !== null, sitemap_pages: sitemap.length, llms: !!llms, https: start.protocol === 'https:',
    wordpress: pages.some((p) => p.wordpress), unysonplus: pages.some((p) => p.unysonPlus),
  };
  report.pages = pages.map((p) => ({ url: p.url, status: p.status, title: p.title || '', description: p.description || '', words: p.words || 0, error: p.error || '' }));

  // History.
  const prev = readReport(host);
  report.changes = diff(prev, report);
  try { mkdirSync(hostDir(host), { recursive: true }); writeFileSync(join(hostDir(host), report.checked_at.replace(/[:.]/g, '-') + '.json'), JSON.stringify(report, null, 2)); }
  catch (e) { report.notes.push('The report could not be saved: ' + e.message); }
  step('Done');
  return report;
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

export function toMarkdown(r) {
  const L = [];
  L.push('# SEO check: ' + r.host, '');
  L.push('Checked ' + String(r.checked_at).replace('T', ' ').slice(0, 16) + ' UTC · ' + (r.mode === 'full' ? 'full check, ' + (r.pages || []).length + ' pages' : 'quick check, one page') + ' · score **' + r.score + '/100**', '');
  const c = r.counts || {};
  L.push('| Critical | High | Medium | Low |', '|---|---|---|---|', '| ' + [c.critical, c.high, c.medium, c.low].map((n) => n || 0).join(' | ') + ' |', '');
  if (r.lighthouse && r.lighthouse.scores) L.push('Lighthouse (mobile): ' + Object.entries(r.lighthouse.scores).map(([k, v]) => k + ' ' + v).join(', '), '');
  if (r.changes) L.push('Since ' + String(r.changes.previous_at).slice(0, 10) + ' (score ' + r.changes.previous_score + '): ' + r.changes.fixed.length + ' fixed, ' + r.changes.new.length + ' new.', '');
  if (r.ai && r.ai.summary) L.push('**Content overall:** ' + r.ai.summary, '');
  for (const n of r.notes || []) L.push('> ' + n, '');
  L.push('## The plan', '');
  let i = 0;
  for (const f of r.findings || []) {
    if (f.severity === 'info') continue;
    L.push('### ' + (++i) + '. ' + f.title + ' (' + f.severity + ')', '');
    if (f.detail) L.push(f.detail, '');
    if (f.why) L.push('**Why:** ' + f.why, '');
    if (f.fix) L.push('**Fix:** ' + f.fix, '');
    if (f.verify) L.push('**Check it worked:** ' + f.verify, '');
    if (f.pages.length) { L.push('Pages:'); for (const p of f.pages.slice(0, 25)) L.push('- ' + p.url + (p.detail ? ' (' + p.detail + ')' : '')); if (f.pages.length > 25) L.push('- … and ' + (f.pages.length - 25) + ' more'); L.push(''); }
  }
  const info = (r.findings || []).filter((f) => f.severity === 'info');
  if (info.length) { L.push('## For your information', ''); for (const f of info) L.push('- **' + f.title + '.** ' + (f.detail ? f.detail + '. ' : '') + f.why); L.push(''); }
  if (r.ai && r.ai.suggestions && r.ai.suggestions.length) {
    L.push('## Suggested titles and descriptions', '');
    for (const s of r.ai.suggestions) { L.push('- ' + s.url); if (s.title) L.push('  - Title: ' + s.title); if (s.description) L.push('  - Description: ' + s.description); }
    L.push('');
  }
  L.push('## Pages checked', '', '| Page | Status | Words | Title |', '|---|---|---|---|');
  for (const p of r.pages || []) L.push('| ' + p.url + ' | ' + (p.status || '—') + ' | ' + p.words + ' | ' + String(p.title).replace(/\|/g, '/') + ' |');
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * CLI: node seo-check.mjs <url> [--full] [--limit N] [--no-ai] [--no-lighthouse] [--md file] [--json file]
 * ------------------------------------------------------------------ */

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : ''; };
  const url = args.find((a) => /^https?:\/\//i.test(a) || (/\./.test(a) && !a.startsWith('--') && !/\.(md|json)$/i.test(a)));
  if (!url) {
    console.log('Usage: node seo-check.mjs <url> [--full] [--limit N] [--no-ai] [--no-lighthouse] [--md report.md] [--json report.json]');
    process.exit(1);
  }
  checkSite({
    url, mode: flag('--full') ? 'full' : 'quick', limit: parseInt(val('--limit'), 10) || 25,
    ai: !flag('--no-ai'), lighthouse: !flag('--no-lighthouse'), onProgress: (s) => console.error('· ' + s),
  }).then((r) => {
    if (val('--json')) writeFileSync(val('--json'), JSON.stringify(r, null, 2));
    const md = toMarkdown(r);
    if (val('--md')) writeFileSync(val('--md'), md);
    if (!val('--md') && !val('--json')) process.stdout.write(md);
    else console.log('Score ' + r.score + '/100 · ' + r.findings.length + ' findings · saved to ' + hostDir(r.host));
    process.exit(0);
  }).catch((e) => { console.error('SEO check failed: ' + e.message); process.exit(2); });
}
