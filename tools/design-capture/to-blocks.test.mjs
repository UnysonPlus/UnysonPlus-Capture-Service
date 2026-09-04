// Browser-free golden fixtures for the block emitter (to-blocks.mjs). Feeds synthetic capture
// intermediates through the real toBlocks() and asserts the emitted core-block markup: the right
// blocks, correct nesting/balance, key content, attribute escaping, and edge-case skipping. Guards
// Tier C1 of the block-theme output roadmap against regressions the way the page-builder path's
// golden fixtures guard to-pages.
//
// Run: node to-blocks.test.mjs   (exit 1 on any failure)
import { toBlocks } from './to-blocks.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

// --- a framework-free WP block-comment tokenizer (no WordPress needed) ---
function tokens(markup) {
  const out = [];
  const re = /<!--\s*(\/?)wp:([a-z0-9/-]+)((?:(?!-->)[\s\S])*?)(\/?)-->/g;
  let m;
  while ((m = re.exec(markup))) out.push({ name: m[2], close: m[1] === '/', self: m[4] === '/' });
  return out;
}
const openCounts = (markup) => {
  const c = {};
  for (const t of tokens(markup)) if (!t.close) c[t.name] = (c[t.name] || 0) + 1;
  return c;
};
// Every non-self-closing open has a correctly-ordered matching close.
const balanced = (markup) => {
  const stack = [];
  for (const t of tokens(markup)) {
    if (t.close) { if (stack.pop() !== t.name) return false; }
    else if (!t.self) stack.push(t.name);
  }
  return stack.length === 0;
};

/* ================================================================== *
 * Fixture 1 — a hero band: overline + centered heading + text + button
 * ================================================================== */
{
  const cap = { sections: [ { blocks: [
    { t: 'overline', html: 'OUR STORY', align: 'center' },
    { t: 'heading', level: 2, html: 'Home of <strong>Juicy</strong> Burgers', align: 'center' },
    { t: 'text', html: '<p>Angus beef &amp; extreme shakes.</p>', align: 'center' },
    { t: 'button', label: 'Book a Table', href: 'https://x.test/book?a=1&b=2' },
  ] } ] };
  const m = toBlocks(cap);
  const c = openCounts(m);
  console.log('Fixture 1 — hero band');
  ok(c['group'] === 1, 'one core/group wraps the section');
  ok(c['heading'] === 1 && c['paragraph'] === 2, 'one heading + two paragraphs (overline + text)');
  ok(c['buttons'] === 1 && c['button'] === 1, 'one buttons > button');
  ok(/"align":"full","layout":\{"type":"constrained"\}/.test(m), 'section group is alignfull + constrained');
  ok(/<!-- wp:heading \{"level":2,"textAlign":"center"\} -->/.test(m), 'heading carries level + textAlign');
  ok(/<h2 class="wp-block-heading has-text-align-center">Home of <strong>Juicy<\/strong> Burgers<\/h2>/.test(m), 'heading keeps inline HTML + align class');
  ok(m.includes('has-small-font-size">OUR STORY</p>'), 'overline → small paragraph');
  ok(/<p class="has-text-align-center">Angus beef &amp; extreme shakes\.<\/p>/.test(m), 'paragraph unwraps <p> + keeps entities');
  ok(m.includes('wp-block-button__link wp-element-button" href="https://x.test/book?a=1&amp;b=2">Book a Table'), 'button link escaped (& → &amp;)');
  ok(balanced(m), 'all blocks balanced/nested');
}

/* ================================================================== *
 * Fixture 2 — a row of two image+heading columns
 * ================================================================== */
{
  const cap = { sections: [ { blocks: [ { t: 'row', cols: [
    { blocks: [ { t: 'image', src: 'https://x.test/a.jpg', alt: 'A "quoted" alt' }, { t: 'heading', level: 3, html: 'Waffles' } ] },
    { blocks: [ { t: 'image', src: 'https://x.test/b.jpg', alt: 'Shake' }, { t: 'heading', level: 3, html: 'Shakes' } ] },
  ] } ] } ] };
  const m = toBlocks(cap);
  const c = openCounts(m);
  console.log('Fixture 2 — columns');
  ok(c['columns'] === 1 && c['column'] === 2, 'one columns > two columns');
  ok(c['image'] === 2 && c['heading'] === 2, 'two images + two headings inside');
  ok(m.includes('alt="A &quot;quoted&quot; alt"'), 'image alt escaped (" → &quot;)');
  ok(m.includes('<img src="https://x.test/a.jpg"'), 'image src present');
  ok(balanced(m), 'columns/column/image/heading balanced');
}

/* ================================================================== *
 * Fixture 3 — fallback (rich type) + verbatim section
 * ================================================================== */
{
  const cap = { sections: [
    { blocks: [ { t: 'testimonials', html: '<div class="revs">Great!</div>' } ] },
    { html: '<section class="promo">Verbatim</section>' },
  ] };
  const m = toBlocks(cap);
  const c = openCounts(m);
  console.log('Fixture 3 — fallback + verbatim');
  ok(c['html'] === 2, 'unmapped rich type and verbatim section each → core/html');
  ok(m.includes('<div class="revs">Great!</div>') && m.includes('<section class="promo">Verbatim</section>'), 'raw HTML carried verbatim');
  ok(balanced(m), 'balanced');
}

/* ================================================================== *
 * Fixture 4 — edge cases: level clamp, empty skip, missing src skip
 * ================================================================== */
{
  const cap = { sections: [ { blocks: [
    { t: 'heading', level: 9, html: 'Clamped' },   // out-of-range level → h2
    { t: 'heading', html: '   ' },                  // empty → skipped
    { t: 'text', html: '' },                        // empty → skipped
    { t: 'image', alt: 'no source' },               // no src → skipped
    { t: 'button', href: 'https://x.test' },        // no label → skipped
  ] } ] };
  const m = toBlocks(cap);
  const c = openCounts(m);
  console.log('Fixture 4 — edge cases');
  ok((c['heading'] || 0) === 1, 'only the non-empty heading emits');
  ok(/<!-- wp:heading \{"level":2\} -->/.test(m) && /<h2 /.test(m), 'out-of-range level clamps to 2');
  ok(!c['image'] && !c['paragraph'] && !c['buttons'], 'empty text / srcless image / labelless button all skipped');
  ok(balanced(m), 'balanced');
}

/* ================================================================== *
 * Fixture 5 — empty capture is safe
 * ================================================================== */
{
  console.log('Fixture 5 — empty/robustness');
  ok(toBlocks({}) === '' && toBlocks({ sections: [] }) === '', 'no sections → empty string');
  ok(toBlocks({ sections: [ { blocks: [] } ] }) === '', 'a section with no emittable blocks is dropped');
}

/* ================================================================== *
 * Fixture 6 — enriched vocabulary (Tier C6): UnysonPlus blocks
 * ================================================================== */
{
  const cap = { sections: [ { blocks: [
    { t: 'heading', level: 2, html: 'Menu', text: 'Menu' },
    { t: 'button', label: 'Book a Table', href: 'https://x.com/book' },
  ] } ] };
  const core = toBlocks(cap);
  const enr  = toBlocks(cap, { vocabulary: 'enriched' });
  const cc = openCounts(core);
  const ce = openCounts(enr);

  console.log('Fixture 6 — enriched vocabulary');
  ok(cc['buttons'] === 1 && !cc['unysonplus/button'], 'core vocabulary emits core/buttons, no UnysonPlus block');
  ok(!ce['buttons'] && ce['unysonplus/button'] === 1, 'enriched vocabulary swaps the button for unysonplus/button');
  ok(/<!-- wp:unysonplus\/button \{"upOptions":\{"label":"Book a Table","link":"https:\/\/x\.com\/book","target":"_self"\}\} \/-->/.test(enr), 'enriched button carries upOptions {label,link,target} as a self-closing dynamic block');
  ok(balanced(enr), 'enriched markup is balanced');
  // A button with no label can't enrich → falls back to the core mapper (which also drops it).
  ok(toBlocks({ sections: [ { blocks: [ { t: 'button', href: '/x' } ] } ] }, { vocabulary: 'enriched' }) === '', 'label-less button enriches to nothing → core fallback drops it');
}

/* ================================================================== *
 * Fixture 7 — enriched heading + text mappings
 * ================================================================== */
{
  const cap = { sections: [ { blocks: [
    { t: 'heading', level: 3, html: 'Our <em>Menu</em>', text: 'Our Menu', align: 'center' },
    { t: 'text', html: '<p>Fresh daily.</p>', align: 'left' },
  ] } ] };
  const core = toBlocks(cap);
  const enr  = toBlocks(cap, { vocabulary: 'enriched' });
  const cc = openCounts(core);
  const ce = openCounts(enr);

  console.log('Fixture 7 — enriched heading + text');
  ok(cc['heading'] === 1 && cc['paragraph'] === 1, 'core vocabulary uses core/heading + core/paragraph');
  ok(ce['unysonplus/special-heading'] === 1 && !ce['heading'], 'heading → unysonplus/special-heading');
  ok(ce['unysonplus/text-block'] === 1 && !ce['paragraph'], 'text → unysonplus/text-block');
  ok(/"title":"Our Menu","heading":"h3","alignment":"center"/.test(enr), 'special-heading carries plain title, tag from level, alignment');
  ok(/"text":"<p>Fresh daily\.<\/p>","text_align":"left"/.test(enr), 'text-block carries the rich HTML + text_align');
  // A heading with no plain text can't enrich → core/heading fallback (which uses html).
  const noText = toBlocks({ sections: [ { blocks: [ { t: 'heading', level: 2, html: '<em>x</em>' } ] } ] }, { vocabulary: 'enriched' });
  ok(/wp:heading/.test(noText) && !/special-heading/.test(noText), 'text-less heading degrades to core/heading');
  ok(balanced(enr), 'balanced');
}

/* ================================================================== *
 * Fixture 8 — enriched section wrapper
 * ================================================================== */
{
  const cap = { sections: [ { blocks: [
    { t: 'heading', level: 2, html: 'Menu', text: 'Menu' },
    { t: 'button', label: 'Book', href: '/book' },
  ] } ] };
  const core = toBlocks(cap);
  const enr  = toBlocks(cap, { vocabulary: 'enriched' });
  const cc = openCounts(core);
  const ce = openCounts(enr);

  console.log('Fixture 8 — enriched section');
  ok(cc['group'] === 1 && !cc['unysonplus/section'], 'core wraps the band in core/group');
  ok(ce['unysonplus/section'] === 1 && !ce['group'], 'enriched wraps the band in unysonplus/section');
  ok(/<!-- wp:unysonplus\/section \{"align":"full"\} -->/.test(enr), 'section carries align:full, no upOptions (renders with shortcode defaults)');
  ok(ce['unysonplus/special-heading'] === 1 && ce['unysonplus/button'] === 1, 'inner blocks are enriched too');
  ok(balanced(enr), 'enriched section + inner blocks are balanced');
  // A verbatim (html-only) section still enriches the WRAPPER while the content degrades to core/html.
  const verb = toBlocks({ sections: [ { html: '<div>raw</div>' } ] }, { vocabulary: 'enriched' });
  ok(/wp:unysonplus\/section/.test(verb) && /wp:html/.test(verb), 'verbatim section: unysonplus/section wraps a core/html fallback');
}

/* ================================================================== *
 * Fixture 9 — enriched row keeps the core/columns wrapper, enriches inside
 * ================================================================== */
{
  const cap = { sections: [ { blocks: [ { t: 'row', cols: [
    { blocks: [ { t: 'heading', level: 3, html: 'Left', text: 'Left' }, { t: 'button', label: 'A', href: '/a' } ] },
    { blocks: [ { t: 'heading', level: 3, html: 'Right', text: 'Right' } ] },
  ] } ] } ] };
  const enr = toBlocks(cap, { vocabulary: 'enriched' });
  const ce = openCounts(enr);

  console.log('Fixture 9 — enriched row');
  // There is no UnysonPlus "row" block (the .fw-row grid parent isn't exposed as a block, and a bare
  // unysonplus/column stacks), and core/columns is the superior responsive, plugin-free layout — so the
  // COLUMNS WRAPPER stays core while the CONTENT enriches.
  ok(ce['columns'] === 1 && ce['column'] === 2, 'row keeps core/columns > 2×core/column wrapper');
  ok(!ce['unysonplus/column'], 'no unysonplus/column emitted (deliberate: core columns wrapper)');
  ok(ce['unysonplus/special-heading'] === 2 && ce['unysonplus/button'] === 1, 'inner content is enriched inside the core columns');
  ok(balanced(enr), 'balanced');
}

console.log('\n' + (fails ? `✗ ${fails} FAILED` : '✓ ALL PASSED'));
process.exit(fails ? 1 : 0);
