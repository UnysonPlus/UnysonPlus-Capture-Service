// Parity tests for the JS hi-fi faithful-base twins (mirror of the PHP golden test's Pass-1/Pass-2 checks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hifiBaseCss, csValueInert, applyNativeMargin, spacingPxToSlug, csFromFields } from './to-pages.mjs';

test('hifiBaseCss emits a :where() base for a captured cs', () => {
  const cs = { color: 'rgb(10, 20, 30)', 'box-shadow': '0 4px 6px rgba(0,0,0,.1)' };
  const out = hifiBaseCss(cs, []);
  assert.match(out, /^:where\(selector\)\{.*\}$/);
  assert.ok(out.includes('color:rgb(10, 20, 30);'));
  assert.ok(out.includes('box-shadow:0 4px 6px rgba(0,0,0,.1);'));
});

test('hifiBaseCss excludes props already reproduced natively (keeps the rest)', () => {
  const cs = { color: 'rgb(10, 20, 30)', 'box-shadow': '0 4px 6px rgba(0,0,0,.1)' };
  const out = hifiBaseCss(cs, ['color']);
  assert.ok(!out.includes('color:'), 'already prop dropped');
  assert.ok(out.includes('box-shadow:'), 'non-already prop kept');
});

test('hifiBaseCss drops visually-inert defaults', () => {
  const out = hifiBaseCss({ 'font-weight': '400', 'text-align': 'left', opacity: '1', transform: 'none' }, []);
  assert.equal(out, '', 'all-inert computed style → empty base (no rule)');
});

test('hifiBaseCss is specificity-0 (wrapped in :where())', () => {
  const out = hifiBaseCss({ 'letter-spacing': '2px' }, []);
  assert.ok(out.startsWith(':where(selector){'));
});

test('hifiBaseCss OFF → empty', () => {
  assert.equal(hifiBaseCss({ color: 'rgb(1,2,3)' }, [], false), '');
});

test('hifiBaseCss preserves CS_APPEARANCE property ORDER (byte-shape parity with PHP)', () => {
  const cs = { transform: 'scale(1.1)', 'background-color': 'rgb(255, 0, 0)', color: 'rgb(0, 0, 255)' };
  // background-color comes before color which comes before transform in CS_APPEARANCE.
  assert.equal(hifiBaseCss(cs, []), ':where(selector){background-color:rgb(255, 0, 0);color:rgb(0, 0, 255);transform:scale(1.1);}');
});

test('csValueInert matches the PHP inert rules', () => {
  assert.equal(csValueInert('background-color', 'rgba(0, 0, 0, 0)'), true);
  assert.equal(csValueInert('background-color', 'transparent'), true);
  assert.equal(csValueInert('border', '0px none rgb(0,0,0)'), true);
  assert.equal(csValueInert('opacity', '1'), true);
  assert.equal(csValueInert('color', 'rgb(1,2,3)'), false);
});

test('spacingPxToSlug: 24px → 4, 48px → 5 (Bootstrap-aligned rem scale)', () => {
  assert.equal(spacingPxToSlug(24), '4');
  assert.equal(spacingPxToSlug(48), '5');
  assert.equal(spacingPxToSlug(0), '0');
});

test('applyNativeMargin: computed margins → native mt-N / mb-N (empty sides only)', () => {
  const spacing = { margin: { all: '', top: '', right: '', bottom: '', left: '' }, padding: { all: '', top: '', right: '', bottom: '', left: '' }, advanced: [] };
  applyNativeMargin(spacing, { 'margin-top': '24px', 'margin-bottom': '48px' });
  assert.equal(spacing.margin.top, 'mt-4');
  assert.equal(spacing.margin.bottom, 'mb-5');
});

test('applyNativeMargin: does not overwrite an already-set (class-mapped) side; OFF → no change', () => {
  const spacing = { margin: { all: '', top: 'mt-3', right: '', bottom: '', left: '' }, padding: {}, advanced: [] };
  applyNativeMargin(spacing, { 'margin-top': '24px', 'margin-bottom': '48px' });
  assert.equal(spacing.margin.top, 'mt-3', 'class-mapped side preserved');
  const off = { margin: { all: '', top: '', right: '', bottom: '', left: '' }, padding: {}, advanced: [] };
  applyNativeMargin(off, { 'margin-top': '24px' }, false);
  assert.equal(off.margin.top, '', 'OFF leaves native spacing empty');
});

test('csFromFields maps flat + nested styles to the PHP data-sc-cs prop names', () => {
  const cs = csFromFields({ color: 'rgb(1,2,3)', fontSize: '18px', styles: { boxShadow: '0 1px 2px #000', transform: 'none' }, marginBottom: '48px' });
  assert.equal(cs.color, 'rgb(1,2,3)');
  assert.equal(cs['font-size'], '18px');
  assert.equal(cs['box-shadow'], '0 1px 2px #000');
  assert.equal(cs['margin-bottom'], '48px');
});
