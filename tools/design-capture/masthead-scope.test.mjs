// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * verifyChrome MEASURES THE MASTHEAD, NOT WHATEVER CARRIES THE <header> TAG.
 *
 * The lens looked up `header, .site-header` and, if it found something, used it. One source ships
 * `<header>` as its HERO and a separate `<nav class="sticky top-0">` as the bar — so the lens compared the
 * HERO against the converted masthead. It reported the four real nav links as `extra` and the hero's words
 * as `missing`: eight findings, none of them true, and the four real ones unreachable behind them. Worse,
 * when the nav placement was later fixed the number could not move, because the lens was not looking at it.
 *
 * The fallback that finds a sticky top bar already existed; it simply never ran, because the <header>
 * lookup had "succeeded". A masthead sits at the top of the page and is short — that is the whole rule.
 *
 * Run: node masthead-scope.test.mjs
 */
import { looksLikeMasthead, MASTHEAD_MAX_TOP, MASTHEAD_MAX_H } from './verify.mjs';

let pass = 0, fail = 0;
const ok = (c, m, got) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m + (got !== undefined ? '  — ' + got : '')); } };
const rect = (top, height) => ({ top, height });

console.log('\n=== what a masthead looks like ===');
ok(looksLikeMasthead(rect(0, 65)), 'a 65px bar at the very top IS a masthead');
ok(looksLikeMasthead(rect(8, 96)), 'a small top offset is still a masthead');

console.log('\n=== what it does not ===');
ok(!looksLikeMasthead(rect(0, 897)), 'an 897px HERO carrying the <header> tag is NOT a masthead (the real defect)', 'height ' + 897 + ' > ' + MASTHEAD_MAX_H);
ok(!looksLikeMasthead(rect(640, 80)), 'a short bar far down the page is not the masthead', 'top 640 > ' + MASTHEAD_MAX_TOP);
ok(!looksLikeMasthead(null), 'nothing is not a masthead');

console.log('\n=== the thresholds are shared, not duplicated ===');
ok(MASTHEAD_MAX_TOP === 8 && MASTHEAD_MAX_H === 240, 'the in-page lookup and this predicate read the SAME numbers',
  `top=${MASTHEAD_MAX_TOP} h=${MASTHEAD_MAX_H}`);

console.log(`\nMASTHEAD SCOPE RESULT: ${fail === 0 ? 'PASS' : 'FAIL'}   (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
