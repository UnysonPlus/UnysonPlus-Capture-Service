// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Box Preset parity guard (browser-free). Feeds synthetic box SKINS — the shape capture-extract.mjs stamps on
// boxCensus — through the real buildBorderPresets() and asserts the rule that regressed and was re-fixed:
//
//   GRADIENT FILL — a card styled `background: linear-gradient(...)` paints via background-IMAGE, so its
//   background-COLOR is transparent. The skin must still count as a real box (not be dropped as "no fill") and
//   the derived Box Preset must carry the gradient on its Background-Pro fill:
//   states.default.background.gradient.data = { type:'linear', angle, stops:[…] }.
//   Docs rule: "the box is ALWAYS a real Box Preset, never a bare box class + Custom CSS."
//   Mirror of PHP Mapper::box_slug()/register_box_preset() + Stitch::build_box_presets() ($fill_val).
//
// Run: node box-presets-parity.test.mjs   (exit 1 on any failure)
import { buildBorderPresets, parseLinearGradient } from './box-presets.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

const GRAD = 'linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(255, 255, 255, 0.58))';

// ── 1. The shared parser (one source of truth for button + box builders) ────────────────────────────────────
const p = parseLinearGradient(GRAD);
ok(!!p && p.type === 'linear' && p.angle === 180, 'parser: 180deg linear');
ok(!!p && p.stops.length === 2 && p.stops[0].position === 0 && p.stops[1].position === 100, 'parser: 2 stops, even spread 0/100');
ok(parseLinearGradient('linear-gradient(to right, #fff, #000)').angle === 90, 'parser: "to right" → 90');
ok(parseLinearGradient('linear-gradient(#fff, #000)').angle === 180, 'parser: directionless → 180 (to bottom)');
ok(parseLinearGradient('radial-gradient(#fff, #000)') === null, 'parser: radial → null (left to CSS path)');
ok(parseLinearGradient('linear-gradient(#fff)') === null, 'parser: single stop → null');

// ── 2. A gradient-only card (transparent bg-color, gradient bg-image, radius + shadow, no border) ────────────
const gradCard = { fill: '', gradient: GRAD, radius: '24px', shadow: 'rgba(0, 0, 0, 0.15) 0px 16px 42px 0px', borderWidth: '0px', borderStyle: 'none', borderColor: 'rgba(0, 0, 0, 0)', backdrop: '' };
const r = buildBorderPresets([gradCard, gradCard]);
ok(Array.isArray(r.derived) && r.derived.length === 1, 'gradient card is NOT dropped → exactly one derived Box Preset');
const bg = r.derived[0] && r.derived[0].states && r.derived[0].states.default && r.derived[0].states.default.background;
ok(!!bg && bg.gradient && bg.gradient.data && bg.gradient.data.type === 'linear', 'preset background carries gradient.data (Background-Pro)');
ok(!!bg && bg.gradient.data.angle === 180 && bg.gradient.data.stops.length === 2, 'preset gradient = 180deg, 2 stops');
ok(!!bg && bg.gradient.data.stops[0].color === 'rgba(255, 255, 255, 0.94)', 'preset stop[0] colour verbatim');
ok(!!bg && bg.color.value.custom === '', 'solid colour left empty (gradient wins)');
ok(!!r.derived[0].states.default.box_shadow, 'resting shadow still carried alongside the gradient');

// ── 3. Distinct gradients → distinct presets; a gradient card ≠ a same-shape solid card ─────────────────────
const solidCard = { ...gradCard, gradient: '', fill: 'rgb(255, 255, 255)' };
const otherGrad = { ...gradCard, gradient: 'linear-gradient(90deg, #ff0000, #0000ff)' };
const r2 = buildBorderPresets([gradCard, solidCard, otherGrad]);
ok(r2.derived.length === 3, 'gradient / solid / other-gradient cluster into 3 distinct presets');

// ── 4. A styleless box (no fill, gradient, radius, shadow, border, backdrop) is still skipped ───────────────
const r3 = buildBorderPresets([{ fill: '', gradient: '', radius: '', shadow: '', borderWidth: '0px' }]);
ok((r3.derived || []).length === 0, 'trivial skin still yields no preset (no derived set)');

// ── 5. A card's captured hover MOTION → the SHARED Hover Animations library (`hover_animation`), with the
//       buttons' fidelity guard: lift + no resting shadow → Lift; lift on a card keeping its shadow → plain
//       hover_fx lift; grow → Grow (no scale Custom CSS). Parity with the PHP stitch. ─────────────────────────
const card = { fill: 'rgb(255, 255, 255)', radius: '16px', shadow: '', borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgb(230, 230, 230)' };
const dLift = buildBorderPresets([{ ...card, hover: { lift: true } }]).derived[0];
ok(dLift.hover_animation === 'btnfx-lift' && !dLift.hover_fx.includes('lift'), 'lift, no resting shadow → hover_animation btnfx-lift (no duplicate hover_fx lift)');
const dLiftSh = buildBorderPresets([{ ...card, radius: '18px', shadow: 'rgba(0, 0, 0, 0.1) 0px 4px 12px 0px', hover: { lift: true } }]).derived[0];
ok(dLiftSh.hover_animation === '' && dLiftSh.hover_fx.includes('lift'), 'lift on a card that KEEPS its resting shadow → no library effect, plain hover_fx lift (guard)');
const dLiftSh2 = buildBorderPresets([{ ...card, radius: '20px', shadow: 'rgba(0, 0, 0, 0.1) 0px 4px 12px 0px', hover: { lift: true, shadow: 'rgba(0, 0, 0, 0.2) 0px 16px 32px 0px' } }]).derived[0];
ok(dLiftSh2.hover_animation === 'btnfx-lift', 'lift whose hover ALSO changes the shadow → native Lift');
const dGrow = buildBorderPresets([{ ...card, radius: '22px', hover: { scale: '1.05' } }]).derived[0];
ok(dGrow.hover_animation === 'btnfx-grow' && !String(dGrow.custom_css).includes('scale('), 'grow (scale 1.05) → hover_animation btnfx-grow, no scale Custom CSS');

if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
console.log('\nAll box-preset parity checks passed.');
