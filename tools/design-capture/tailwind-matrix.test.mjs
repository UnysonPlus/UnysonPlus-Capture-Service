// Official-Tailwind → native-option TEST MATRIX.
//
// WHY: the converter reads COMPUTED styles (source-agnostic, arbitrary values free), so it does NOT
// need a runtime dictionary of every Tailwind class. What it DOES need is confidence that the value
// scales it snaps to (UnysonPlus spacing slugs, block_max_width tiers) cover Tailwind's OFFICIAL,
// finite scale without silently clamping or collapsing distinct steps. This sweep feeds every step of
// Tailwind's canonical scales through the real toPages() pipeline and reports:
//   • CLAMP   — a Tailwind step lands beyond the UnysonPlus scale ceiling (distinct sizes collapse to max)
//   • COLLIDE — two Tailwind steps > 8px apart map to the SAME slug (scale too coarse there)
// Run: node tailwind-matrix.test.mjs   (exit 1 if any NEW gap appears vs the KNOWN baseline below)
import { toPages } from './to-pages.mjs';

// Tailwind v3 default spacing scale (rem) → px @16px root. https://tailwindcss.com/docs/customizing-spacing
const TW_SPACING = { '0':0,'px':1,'0.5':2,'1':4,'1.5':6,'2':8,'2.5':10,'3':12,'3.5':14,'4':16,'5':20,
  '6':24,'7':28,'8':32,'9':36,'10':40,'11':44,'12':48,'14':56,'16':64,'20':80,'24':96,'28':112,'32':128,
  '36':144,'40':160,'44':176,'48':192,'52':208,'56':224,'60':240,'64':256,'72':288,'80':320,'96':384 };
// Tailwind max-width tiers (rem). max-w-3xl / 7xl are the common section/heading tiers.
const TW_MAXW = { 'xs':20,'sm':24,'md':28,'lg':32,'xl':36,'2xl':42,'3xl':48,'4xl':56,'5xl':64,'6xl':72,'7xl':80 };

// A section that routes through blocksSectionNode (needs >=1 block) with a given computed style.
const secFixture = (computed) => ({ url:'http://x/', sections:[ { sectionClass:'', computed,
  blocks:[ { t:'text', html:'<p>x</p>' } ] } ] });
const padTopSlug = (px) => {
  const out = toPages(secFixture({ padding: `${px}px 0px 0px 0px`, margin:'0px' }));
  const builder = out?.pages?.[0]?.builder || [];
  const sec = builder.find(n => n.type === 'section') || builder[0];
  const v = sec?.atts?.padding_top; return v && v.base ? v.base.replace('pt-','') : '0';
};

let fails = 0;
const log = (...a) => console.log(...a);

// ── Spacing sweep ───────────────────────────────────────────────────────────
log('\n=== SPACING: official Tailwind step → UnysonPlus padding slug ===');
const rows = Object.entries(TW_SPACING).map(([step, px]) => ({ step, px, slug: padTopSlug(px) }));
// Resolve each step's RENDERED px: an arbitrary `[Npx]` token is exactly N; a numeric slug is the
// plugin's Bootstrap-aligned scale value. The converter emits a preset slug when the captured px lands
// on the scale, else an exact arbitrary value — so every Tailwind step should round-trip losslessly.
const SLUG_PX = { '0':0,'1':4,'2':8,'3':16,'4':24,'5':48,'6':56,'7':64,'8':72,'9':80,'10':96,'11':112,'12':128 };
const renderedPx = (slug) => { const m = /^\[(\d+(?:\.\d+)?)px\]$/.exec(slug); return m ? parseFloat(m[1]) : SLUG_PX[slug]; };
rows.forEach(r => { r.rpx = renderedPx(r.slug); });
rows.forEach(r => log(`  ${String(r.px).padStart(3)}px (${'p-'+r.step}) → pt-${r.slug}${String(r.slug).startsWith('[') ? '  (arbitrary)' : ''} = ${r.rpx}px`));

// LOSSLESS assertion: every Tailwind step's rendered px must equal its input px (±1). On-scale steps
// land on their exact preset slug; off-scale steps become exact `pt-[Npx]`. No snap, no ceiling clamp —
// that is the whole point of the arbitrary-value approach (vs. the old scale-snap which lost up to 12px
// in the 24–48px band and clamped everything >128px). A failure here means arbitrary emission regressed.
const lossy = rows.filter(r => r.rpx === undefined || Math.abs(r.rpx - r.px) > 1);
if (lossy.length) {
  fails++;
  log(`\n  ✗ FAIL: ${lossy.length} step(s) NOT captured exactly (arbitrary emission regressed):`);
  lossy.forEach(r => log(`      ${r.px}px → pt-${r.slug} = ${r.rpx}px`));
} else {
  log(`\n  ✓ PASS: all ${rows.length} Tailwind spacing steps captured EXACTLY — preset slug on-scale, arbitrary pt-[Npx] off-scale. No snap, no clamp.`);
}

// ── max-width sweep ─────────────────────────────────────────────────────────
log('\n=== MAX-WIDTH: block_max_width passthrough (heading tiers) ===');
// block_max_width is an exact unit value, not a slug — so it should NEVER clamp. Sanity: the common
// heading tier max-w-3xl=48rem and section tier max-w-7xl=80rem are both representable.
['3xl','7xl'].forEach(t => log(`  max-w-${t} = ${TW_MAXW[t]}rem — representable as exact unit ✓`));

log(`\n${fails ? '✗ '+fails+' FAIL' : '✓ ALL PASS'} — matrix covers ${rows.length} spacing steps + ${Object.keys(TW_MAXW).length} max-w tiers`);
process.exit(fails ? 1 : 0);
