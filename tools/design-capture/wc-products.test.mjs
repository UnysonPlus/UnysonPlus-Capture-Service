// Browser-free fixture: a captured PRODUCT-CARD grid → wc_products with the ribbon slot ON and the
// card skin/hover + ribbon translated into scoped section CSS. Guards the two misses from the
// pinky-bites conversion: (1) show_ribbon hardcoded 'no' (badge dropped), (2) the card wrapper's
// `hover:shadow-xl hover:-translate-y-2` never captured/emitted (flat card). No browser — feeds a
// synthetic capture through the real toPages() pipeline and asserts the emitted node + CSS.
//
// Run: node wc-products.test.mjs   (exit 1 on any failure)
import { toPages } from './to-pages.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

// A product cell: <img> + a price token (cellIsProduct), plus the captured wrapper skin/hover + ribbon
// (as capture-extract's rowCols now attaches them — mirrors the pinky-bites "Best Seller" card).
const productCell = (withRibbon) => ({
  width: '1_1', cw: 4,
  html: '<img src="cupcake.jpg" alt="Vanilla"><h3>Vanilla Dream</h3><span>$4.50</span>',
  wrap: {
    bg: 'rgb(255, 255, 255)', radius: '32px',
    borderW: '1px', borderStyle: 'solid', borderColor: 'rgb(252, 231, 243)',
    shadow: 'rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, rgba(0, 0, 0, 0.1) 0px 2px 4px -2px',
    hoverShadow: 'xl', hoverLift: '2',
  },
  ...(withRibbon ? { ribbon: {
    text: 'Best Seller', bg: 'rgb(252, 231, 243)', color: 'rgb(255, 107, 139)', radius: '9999px',
    padding: '4px 14px', fontSize: '12px', fontWeight: '900', letterSpacing: '0.6px',
    borderW: '1px', borderColor: 'rgb(251, 207, 232)',
  } } : {}),
});

const grid = (withRibbon) => ({
  url: 'http://x/', sections: [{
    sectionClass: '', computed: {},
    blocks: [{ t: 'row', cols: [productCell(withRibbon), productCell(false), productCell(false)] }],
  }],
});

const findWc = (out) => {
  const sec = (out?.pages?.[0]?.builder || []).find((n) => n.type === 'section');
  const wc = (sec?._items || []).flatMap((c) => c._items || []).find((n) => n.shortcode === 'wc_products');
  return { sec, wc };
};

console.log('\n=== wc_products: ribbon detection + card skin/hover translation ===');

// (A) With a badge in the cards → show_ribbon flips ON + ribbon skin CSS emitted.
{
  const { sec, wc } = findWc(toPages(grid(true)));
  ok(!!wc, 'product grid → a wc_products node');
  ok(wc && wc.atts.show_ribbon === 'yes', 'badge detected → show_ribbon: "yes" (was hardcoded "no")');
  const css = (sec && sec.atts && sec.atts.custom_css) || '';
  ok(/\.upwc-product\{[^}]*border-radius:32px/.test(css.replace(/\s+/g, '')), 'card rest skin (radius 32px) → scoped CSS');
  ok(/\.upwc-product:hover\{[^}]*translateY\(-8px\)/.test(css.replace(/\s+/g, '')), 'hover:-translate-y-2 → :hover translateY(-8px)');
  ok(/\.upwc-product:hover\{[^}]*box-shadow/.test(css.replace(/\s+/g, '')), 'hover:shadow-xl → :hover box-shadow');
  ok(/\.upwc-product__badge\.ribbon\{/.test(css.replace(/\s+/g, '')), 'ribbon badge skin → scoped CSS');
  ok(/text-transform:uppercase/.test(css.replace(/\s+/g, '')), 'ribbon uppercase preserved');
}

// (B) No badge → ribbon stays OFF, but the card skin/hover still translate.
{
  const { sec, wc } = findWc(toPages(grid(false)));
  ok(wc && wc.atts.show_ribbon === 'no', 'no badge → show_ribbon stays "no"');
  const css = (sec && sec.atts && sec.atts.custom_css) || '';
  ok(/translateY\(-8px\)/.test(css.replace(/\s+/g, '')), 'card hover still translated without a ribbon');
  ok(!/__badge\.ribbon/.test(css), 'no ribbon CSS when no badge');
}

console.log(fails ? `\nFAILED (${fails})` : '\nALL PASS');
process.exit(fails ? 1 : 0);
