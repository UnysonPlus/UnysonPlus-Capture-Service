// motion-record.test.mjs — the recorder's analysis and the motion → Interaction pass, on recorded samples of
// motion-fixtures/fixture-motion-01 (no browser needed). Run: node --test motion-record.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyse, nearestEase, curve, applyRecordedMotion, motionValue, motionAttr } from './motion-record.mjs';

const raw = JSON.parse(readFileSync(new URL('./motion-fixtures/fixture-motion-01/raw-series.json', import.meta.url), 'utf8'));
const rec = analyse(raw.raw, raw.phases, { url: 'fixture-motion-01', viewport: { width: 1440, height: 900 }, step: 25, end: raw.end });
const by = (t) => rec.elements.find((e) => e.text.startsWith(t));

test('every moving element of the fixture is found, nothing unmatched', () => {
  assert.equal(rec.elements.length, 7);
  assert.equal(rec.unmatched.length, 0);
});

test('CSS / Web Animation timing is exact, and the curve is the engine key that matches it', () => {
  const h1 = by('Motion that converts');
  assert.deepEqual([h1.phase, h1.delay, h1.duration, h1.ease, h1.source], ['load', 0.2, 0.8, 'classic_out', 'css-animation']);
  assert.deepEqual([h1.from.opacity, h1.from.y], [0, 40]);
  const cta = by('See more');
  assert.deepEqual([cta.delay, cta.duration, cta.ease, cta.from.scale, cta.from.opacity], [0.6, 0.5, 'classic_back', 0.8, 0]);
  const p = by('This paragraph slides');
  assert.deepEqual([p.delay, p.duration, p.from.x, p.from.opacity], [0, 0.6, -60, 0]);
});

test('script motion is fitted: start, length within a step, the quad in-out curve', () => {
  const js = by('This line fades');
  assert.equal(js.phase, 'view');
  assert.equal(js.source, 'script');
  assert.ok(Math.abs(js.duration - 0.9) <= 0.05, 'duration ' + js.duration);
  assert.equal(js.ease, 'bezier_in_out');
});

test('the staggered cards are one even stagger group, 0.15 s apart', () => {
  assert.equal(rec.staggers.length, 1);
  assert.deepEqual([rec.staggers[0].count, rec.staggers[0].gap, rec.staggers[0].even], [3, 0.15, true]);
});

test('curves: keywords, cubic-bezier and linear() evaluate; nearestEase finds exact keys', () => {
  assert.ok(Math.abs(curve('ease-out')(0.5) - 0.6847) < 0.01);
  assert.equal(curve('linear(0, 0.5, 1)')(0.25), 0.25);
  assert.equal(nearestEase('cubic-bezier(0.22, 1, 0.36, 1)').key, 'classic_out');
});

test('the stamp and the Interaction value carry the recording', () => {
  const h1 = by('Motion that converts');
  assert.equal(motionAttr(h1), 'ph=load;d=0.2;du=0.8;e=classic_out;o=0;x=0;y=40;s=1;r=0;b=0;src=css-animation');
  const v = motionValue(by('OneFirst'));
  assert.equal(v.mode, 'view');
  assert.equal(v.view.leave, 'keep');
  assert.deepEqual([v.view.steps.s1.direction, v.view.steps.s1.y, v.view.steps.s1.scale, v.view.steps.s2.target], ['from', 50, 0.95, 'none']);
});

test('the text pass puts motion on the right node: a heading by its own title, a card on its column', () => {
  const tree = [{ type: 'section', atts: {}, _items: [
    { type: 'flexbox', atts: { html_tag: 'div' }, _items: [
      { type: 'simple', shortcode: 'special_heading', atts: { title: 'Motion that converts', subtitle: 'This paragraph slides in from the left with a CSS transition when the page has loaded.', heading: 'h1' }, _items: [] },
    ] },
    { type: 'flexbox', atts: { html_tag: 'div' }, _items: [
      { type: 'simple', shortcode: 'special_heading', atts: { title: 'One', subtitle: 'First card rises in.', heading: 'h3' }, _items: [] },
    ] },
  ] }];
  const r = applyRecordedMotion(tree, { elements: [by('Motion that converts'), by('This paragraph slides'), by('OneFirst')] });
  assert.equal(r.applied, 2);
  assert.equal(tree[0]._items[0]._items[0].atts.upw_interactions.mode, 'load', 'heading by its title');
  assert.equal(tree[0]._items[1].atts.upw_interactions.mode, 'view', 'the card wrapper → the column, not the heading inside');
  assert.equal(r.unplaced.length, 1, 'the merged subtitle is reported, not applied');
});
