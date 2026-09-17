// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// CONTAINER GUTTER + CONTENT WIDTH parity (browser-free; 2026-09-17). A random corpus page measured 8px off on every band:
// its gutter was the bands' own `px-8` padding (no calc() container rule), which the capture never stamped, and its
// `max-w-[1700px]` container carried that padding INSIDE its width — the theme's Container Width is a CONTENT width
// (gutter outside), so 1700 rendered +64px wide (the feed's RECURS x3 "+48px per band"). The capture stamps
// data-sc-content-gutter (measured) + data-sc-content-gutter-inside; to-theme-settings subtracts an inside gutter.
// The extraction also ran BEFORE the stamps existed (home.contentWidth was always 0): capture.mjs now re-reads them.
// PHP twin: Stitch::declared_container_gutter (measured fallback) + detect_site_content_width (gutter inside).
// Golden: tests/golden-fixture-1-test.php [V].   Run: node container-gutter-parity.test.mjs   (exit 1 on any failure)
import { toThemeSettings } from './to-theme-settings.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg); if (!cond) fails++; };

// (1) a padding gutter INSIDE the measured container: 1700 outer, 32px each side → 1636 content
const ts = toThemeSettings({ colors: { bg: '#02040a', ink: '#f8fafc' } }, { contentWidth: 1700, contentGutter: 32, contentGutterInside: true });
const gl = (ts.values || ts).general_layout || {};
ok(gl.layout_container_gutter && gl.layout_container_gutter.value === '32', 'the measured band padding (px-8) is the Container Gutter (32px)');
ok(gl.layout_container_width && gl.layout_container_width.lg && gl.layout_container_width.lg.value === '1636', 'an inside gutter is subtracted from the Container Width (1700 outer → 1636 content)');

// (2) a calc() gutter OUTSIDE the cap (`min(1440px, calc(100% - 48px))`): the cap IS the content width — untouched
const ts2 = toThemeSettings({ colors: { bg: '#fff', ink: '#000' } }, { contentWidth: 1440, contentGutter: 24, contentGutterInside: false });
const gl2 = (ts2.values || ts2).general_layout || {};
ok(gl2.layout_container_width && gl2.layout_container_width.lg && gl2.layout_container_width.lg.value === '1440', 'a calc() gutter outside the cap leaves the Container Width alone (1440)');

// (3) no gutter stamped at all → no gutter option, width as stamped
const ts3 = toThemeSettings({ colors: { bg: '#fff', ink: '#000' } }, { contentWidth: 1280 });
const gl3 = (ts3.values || ts3).general_layout || {};
ok(!gl3.layout_container_gutter && gl3.layout_container_width && gl3.layout_container_width.lg.value === '1280', 'no gutter stamp → no gutter option, the stamped width stands');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
