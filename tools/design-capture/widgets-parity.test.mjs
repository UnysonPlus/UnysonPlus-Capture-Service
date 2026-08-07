// Browser-free fixtures: synthetic capture BLOCKS (the shape capture-extract's structured-widget
// detectors now emit) fed through the real toPages() pipeline, asserting each maps to the right native
// shortcode + payload — parity with the PHP Mapper n_* builders. Each surface has a NEGATIVE control
// (a below-min payload → code_block fallback, exactly like PHP). Also covers the section-CSS-ID
// slug_from_id parity and the reveal-animation (anim_intent) enablement.
//
// NOTE: the DETECTION side (capture-extract is_* tight matches) runs inside headless Chrome via
// page.evaluate and isn't unit-testable here; these tests guard the BUILD + routing side (to-pages).
//
// Run: node widgets-parity.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

// Feed one section whose body is a single block; return the first non-column shortcode node emitted.
const nodeFor = (block, secExtra = {}) => {
  const out = toPages({ url: 'http://x/', sections: [{ sectionClass: '', computed: {}, blocks: [block], ...secExtra }] });
  const sec = (out?.pages?.[0]?.builder || []).find((n) => n.type === 'section');
  const flat = (sec?._items || []).flatMap((c) => c._items || []);
  return { sec, node: flat[0], all: flat };
};

console.log('\n=== accordion ===');
{
  const { node } = nodeFor({ t: 'accordion', items: [{ title: 'Q1', content: '<p>A1</p>' }, { title: 'Q2', content: '<p>A2</p>' }] });
  ok(node && node.shortcode === 'accordion', 'accordion block → accordion shortcode');
  ok(node && node.atts.tabs.length === 2 && node.atts.tabs[0].tab_title === 'Q1' && node.atts.tabs[0].is_open === 'no', 'each item → a tabs row {tab_title,tab_content,is_open:no}');
  // The DETECTION side (is_accordion_group) requires >=2 items; the BUILDER (n_accordion parity) only
  // bails on ZERO real items → code_block, so the builder-level negative control uses an empty group.
  const neg = nodeFor({ t: 'accordion', items: [{ title: '', content: '' }] });
  ok(neg.node && neg.node.shortcode === 'code_block', 'NEG: no real items → code_block fallback');
}

console.log('\n=== feature_list ===');
{
  const ul = nodeFor({ t: 'feature_list', ordered: false, items: [{ text: 'Fast' }, { text: 'Secure' }] });
  ok(ul.node && ul.node.shortcode === 'feature_list' && ul.node.atts.design === 'check', '<ul> → feature_list design:check');
  const ol = nodeFor({ t: 'feature_list', ordered: true, items: [{ text: 'One' }, { text: 'Two' }] });
  ok(ol.node && ol.node.atts.design === 'numbered', '<ol> → design:numbered');
  ok(ul.node && ul.node.atts.items.length === 2 && ul.node.atts.items[0].text === 'Fast', 'each <li> → an item');
  const neg = nodeFor({ t: 'feature_list', items: [] });
  ok(neg.node && neg.node.shortcode === 'code_block', 'NEG: no items → code_block');
}

console.log('\n=== tabs ===');
{
  const { node } = nodeFor({ t: 'tabs', items: [{ title: 'A', content: '<p>a</p>', active: 'no' }, { title: 'B', content: '<p>b</p>', active: 'yes' }] });
  ok(node && node.shortcode === 'tabs', 'tabs block → tabs shortcode');
  ok(node && node.atts.tabs.length === 2 && node.atts.tabs[1].is_active === 'yes', 'active tab preserved');
  const noActive = nodeFor({ t: 'tabs', items: [{ title: 'A', content: 'a', active: 'no' }, { title: 'B', content: 'b', active: 'no' }] });
  ok(noActive.node.atts.tabs[0].is_active === 'yes', 'no active flag → first tab active (fallback)');
  const neg = nodeFor({ t: 'tabs', items: [{ title: 'Solo', content: 'x', active: 'no' }] });
  ok(neg.node && neg.node.shortcode === 'code_block', 'NEG: <2 tabs → code_block');
}

console.log('\n=== steps ===');
{
  const { node } = nodeFor({ t: 'steps', items: [{ title: 'Sign up', content: 'do it', number: '1' }, { title: 'Build', content: 'go', number: '2' }] });
  ok(node && node.shortcode === 'steps', 'steps block → steps shortcode');
  ok(node && node.atts.steps.length === 2 && node.atts.steps[0].number === '1', 'each child → a step {title,content,number}');
  const neg = nodeFor({ t: 'steps', items: [{ title: 'Only', content: 'x', number: '1' }] });
  ok(neg.node && neg.node.shortcode === 'code_block', 'NEG: <2 steps → code_block');
}

console.log('\n=== timeline ===');
{
  const { node } = nodeFor({ t: 'timeline', items: [{ date: '2019', title: 'Founded', text: 'start' }, { date: '2023', title: 'Grew', text: 'more' }] });
  ok(node && node.shortcode === 'timeline', 'timeline block → timeline shortcode');
  ok(node && node.atts.items.length === 2 && node.atts.items[0].date === '2019', 'each entry → a milestone {date,title,text}');
  const dateOnly = nodeFor({ t: 'timeline', items: [{ date: '2019', title: '', text: '' }, { date: '2020', title: '', text: '' }] });
  ok(dateOnly.node.atts.items[0].title === '2019', 'empty title → falls back to the date');
  const neg = nodeFor({ t: 'timeline', items: [{ date: '2019', title: 'One', text: '' }] });
  ok(neg.node && neg.node.shortcode === 'code_block', 'NEG: <2 entries → code_block');
}

console.log('\n=== progress ===');
{
  const { node } = nodeFor({ t: 'progress', bars: [{ label: 'Design', percent: 80 }, { label: 'Code', percent: 150 }] });
  ok(node && node.shortcode === 'progress', 'progress block → progress shortcode');
  ok(node && node.atts.layout.type === 'bar' && node.atts.bars.length === 2, 'bar layout + each item → a bar');
  ok(node && node.atts.bars[1].percent === 100, 'percent clamped to 0..100');
  const neg = nodeFor({ t: 'progress', bars: [{ label: 'Solo', percent: 50 }] });
  ok(neg.node && neg.node.shortcode === 'code_block', 'NEG: <2 bars → code_block');
}

console.log('\n=== pricing_table ===');
{
  const { node } = nodeFor({ t: 'pricing', plans: [
    { title: 'Basic', currency: '$', price: '9', period: '/mo', features: 'A\nB', featured: 'no', ribbon: '', btn_label: 'Buy', btn_url: 'http://x/buy' },
    { title: 'Pro', currency: '$', price: '29', period: '/mo', features: 'A\nB\nC', featured: 'yes', ribbon: 'Popular', btn_label: 'Buy', btn_url: '' },
  ] });
  ok(node && node.shortcode === 'pricing_table', 'pricing block → pricing_table shortcode');
  ok(node && node.atts.plans.length === 2 && node.atts.plans[0].price.monthly === '9', 'plan price → multi-inline {monthly,yearly}');
  ok(node && node.atts.plans[1].featured === 'yes' && node.atts.plans[1].ribbon === 'Popular', 'featured + ribbon carried');
  const neg = nodeFor({ t: 'pricing', plans: [{ title: 'Solo', price: '9' }] });
  ok(neg.node && neg.node.shortcode === 'code_block', 'NEG: <2 plans → code_block');
}

console.log('\n=== table ===');
{
  const rows = [
    [{ html: 'Plan', header: true }, { html: 'Price', header: true }],
    [{ html: 'Basic', header: false }, { html: '$9', header: false }],
  ];
  const { node } = nodeFor({ t: 'table', rows, caption: 'Pricing', style: { striped: false } });
  ok(node && node.shortcode === 'table', 'table block → table shortcode');
  ok(node && node.atts.table.header_options.header_rows === 1, 'leading all-<th> row → header_rows:1');
  ok(node && node.atts.table.content.length === 2 && node.atts.table.content[1][1].textarea === '$9', 'cell html → textarea');
  ok(node && node.atts.caption === 'Pricing', 'caption carried');
  const neg = nodeFor({ t: 'table', rows: [], caption: '' });
  ok(neg.node && neg.node.shortcode === 'code_block', 'NEG: no rows → code_block');
}

console.log('\n=== lottie ===');
{
  const { node } = nodeFor({ t: 'lottie', src: 'http://x/anim.json' });
  ok(node && node.shortcode === 'lottie' && node.atts.source === 'url' && node.atts.lottie_url === 'http://x/anim.json' && node.atts.trigger === 'viewport', 'lottie block → lottie shortcode (url source, viewport trigger)');
  const neg = nodeFor({ t: 'lottie', src: '' });
  ok(neg.node && neg.node.shortcode === 'code_block', 'NEG: no src → code_block');
}

console.log('\n=== svg_draw ===');
{
  const { node } = nodeFor({ t: 'svg_draw', code: '<svg><path d="M0 0 L10 10" stroke-dasharray="20"/></svg>' });
  ok(node && node.shortcode === 'svg_draw' && node.atts.svg.source === 'code' && node.atts.trigger === 'view', 'svg_draw block → svg_draw shortcode (code source, view trigger)');
  ok(node && /stroke-dasharray/.test(node.atts.svg.code.code), 'markup carried into svg.code.code');
  const neg = nodeFor({ t: 'svg_draw', code: '   ' });
  ok(neg.node && neg.node.shortcode === 'code_block', 'NEG: blank code → code_block');
}

console.log('\n=== section CSS ID (slug_from_id parity) ===');
{
  const out = toPages({ url: 'http://x/', sections: [{ sectionClass: '', computed: {}, sectionId: 'Our Services', blocks: [{ t: 'heading', level: 2, html: 'Hi' }] }] });
  const sec = out.pages[0].builder.find((n) => n.type === 'section');
  ok(sec && sec.atts.css_id === 'our-services', '"Our Services" → css_id "our-services" (lowercase, spaces→dash)');
  const out2 = toPages({ url: 'http://x/', sections: [{ sectionClass: '', computed: {}, sectionId: 'sec:pricing--A', blocks: [{ t: 'heading', level: 2, html: 'Hi' }] }] });
  const sec2 = out2.pages[0].builder.find((n) => n.type === 'section');
  ok(sec2 && sec2.atts.css_id === 'sec-pricing-a', 'punctuation collapsed/trimmed → "sec-pricing-a"');
}

console.log('\n=== reveal animation (anim_intent parity) ===');
{
  // A heading block carrying a source reveal intent → the node's Animations tab is ENABLED with the effect.
  const withAnim = nodeFor({ t: 'heading', level: 2, html: 'Hi', anim: 'animate__fadeInUp' });
  ok(withAnim.node && withAnim.node.atts.animation.enable === 'yes' && withAnim.node.atts.animation.yes.effect === 'animate__fadeInUp', 'anim intent → animation enabled with mapped effect');
  // No intent → stays disabled (no false motion).
  const noAnim = nodeFor({ t: 'heading', level: 2, html: 'Hi' });
  ok(noAnim.node && noAnim.node.atts.animation.enable === 'no', 'NEG: no intent → animation stays disabled');
  // An interactive widget (no standard {enable,yes} shape) is left untouched even with an intent.
  const widgetAnim = nodeFor({ t: 'tabs', anim: 'animate__fadeInUp', items: [{ title: 'A', content: 'a', active: 'no' }, { title: 'B', content: 'b', active: 'no' }] });
  ok(widgetAnim.node && widgetAnim.node.shortcode === 'tabs' && !('animation' in widgetAnim.node.atts), 'NEG: interactive widget has no animation att → left at default');
}

console.log(fails ? `\nFAILED (${fails})` : '\nALL PASS');
process.exit(fails ? 1 : 0);
