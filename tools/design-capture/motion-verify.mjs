/**
 * motion-verify.mjs — check a converted page's motion against its source, frame by frame (roadmap 10c), and turn what
 * does not match into motion-gap findings (10d).
 *
 * Both pages are recorded the same way (motion-record.mjs: a virtual clock, load + in view). Each moving source element
 * is paired with the converted element that has the same text (whitespace ignored; a converted wrapper whose text starts
 * with it counts), and compared:
 *   - timing: delay and duration, in ms (pass: within ±80 ms each);
 *   - easing: the distance between the two speed curves (RMS of progress over 0..1; pass: ≤ 0.05);
 *   - start state: opacity, x / y, scale, rotate, blur (pass: within 0.05 / 4 px / 0.02 / 2° / 1 px);
 *   - trigger: load vs in view. A source "in view" motion that plays on load in the conversion because the element is
 *     already on screen there is noted, not failed (that is the layout, not the motion).
 * A source motion with no converted counterpart is MISSING (with the converter's reason when its motion-report.json is
 * given); a converted motion with no source counterpart is EXTRA.
 *
 *   node motion-verify.mjs <sourceUrl> <convertedUrl> <outDir> [--report=<capture-out>/motion-report.json]
 *        [--fixture=<neutral id>] [--send]
 *
 * Writes <outDir>/motion-verify.json, motion-verify.html (table + side-by-side frame strips, frames in motion-frames/)
 * and motion-gaps.json: one send-finding.mjs --motion-gap tuple per gap. --send files them (ONLY after the person's one
 * consent for the session; see the site-build protocol), otherwise it prints the commands.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { recordMotion, curve } from './motion-record.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const easeFn = (() => {
  let map = null;
  return (e) => {
    if (e.easeSource) { const f = curve(e.easeSource); if (f) { return f; } }
    if (!map) { map = JSON.parse(readFileSync(join(HERE, 'engine-easings.json'), 'utf8')).easings; }
    if (/^cubic-bezier\(/.test(e.ease)) { return curve(e.ease); }
    return map[e.ease] ? curve(map[e.ease].css) : null;
  };
})();
const key = (s) => String(s || '').replace(/\s+/g, '').slice(0, 80);
const rmsCurves = (f, g) => { if (!f || !g) { return null; } let s = 0; for (let i = 0; i <= 60; i++) { const p = i / 60, d = f(p) - g(p); s += d * d; } return Math.round(Math.sqrt(s / 61) * 1000) / 1000; };
const TOL = { delay: 80, duration: 80, ease: 0.05, opacity: 0.05, x: 4, y: 4, scale: 0.02, rotate: 2, blur: 1 };

/** Compare two recordings. */
export function compareMotion(src, conv, opts = {}) {
  const unplaced = new Map(((opts.report && opts.report.unplaced) || (opts.report && opts.report.pages && opts.report.pages[0] && opts.report.pages[0].unplaced) || []).map((u) => [key(u.text), u.why]));
  const used = new Set();
  const rows = [];
  for (const s of src.elements) {
    const k = key(s.full || s.text);
    let cands = conv.elements.filter((c, i) => !used.has(i) && key(c.full || c.text) === k);
    if (!cands.length) { cands = conv.elements.filter((c, i) => !used.has(i) && k && (key(c.full || c.text).startsWith(k) || k.startsWith(key(c.full || c.text)))); }
    if (!cands.length) {
      rows.push({ verdict: 'missing', src: s, why: unplaced.get(key(s.text)) || unplaced.get(k) || 'no converted element with this text moves' });
      continue;
    }
    cands.sort((a, b) => (Math.abs(a.delay - s.delay) + Math.abs(a.duration - s.duration)) - (Math.abs(b.delay - s.delay) + Math.abs(b.duration - s.duration)));
    const c = cands[0];
    used.add(conv.elements.indexOf(c));
    const d = {
      delay: Math.round((c.delay - s.delay) * 1000), duration: Math.round((c.duration - s.duration) * 1000),
      ease: rmsCurves(easeFn(s), easeFn(c)),
      opacity: +(c.from.opacity - s.from.opacity).toFixed(2), x: c.from.x - s.from.x, y: c.from.y - s.from.y,
      scale: +(c.from.scale - s.from.scale).toFixed(3), rotate: c.from.rotate - s.from.rotate, blur: +(c.from.blur - s.from.blur).toFixed(1),
    };
    const fails = Object.keys(TOL).filter((k2) => d[k2] != null && Math.abs(d[k2]) > TOL[k2]);
    let triggerNote = '';
    if (s.phase !== c.phase) {
      const top0 = conv.layout0 && conv.layout0[c.path] != null ? conv.layout0[c.path] : (conv.layout ? conv.layout[c.path] : null);
      const onScreen = c.phase === 'load' && s.phase === 'view' && top0 != null && top0 < (conv.viewport.height || 900);
      triggerNote = onScreen ? 'plays on load in the conversion because it is already on screen there (layout, not motion)' : `trigger differs: source ${s.phase}, conversion ${c.phase}`;
      if (!onScreen) { fails.push('trigger'); }
    }
    rows.push({ verdict: fails.length ? 'drift' : 'match', src: s, conv: c, diff: d, fails, triggerNote });
  }
  const extra = conv.elements.filter((c, i) => !used.has(i)).map((c) => ({ verdict: 'extra', conv: c }));
  const all = rows.concat(extra);
  const count = (v) => all.filter((r) => r.verdict === v).length;
  return { summary: { source: src.elements.length, matched: count('match'), drift: count('drift'), missing: count('missing'), extra: count('extra'), notExpressible: (src.unmatched || []).length }, rows: all, sourceUnmatched: src.unmatched || [] };
}

/** One send-finding.mjs --motion-gap tuple per gap. */
export function gapsOf(result, fixture) {
  const fx = fixture || 'fixture-motion';
  const desc = (e) => `${e.tag} ${e.phase === 'view' ? 'in view' : 'on load'}: from opacity ${e.from.opacity}, x ${e.from.x}, y ${e.from.y}, scale ${e.from.scale}${e.from.rotate ? ', rotate ' + e.from.rotate : ''}${e.from.blur ? ', blur ' + e.from.blur : ''}; ${Math.round(e.duration * 1000)} ms after ${Math.round(e.delay * 1000)} ms, ${e.ease}`;
  const gaps = [];
  for (const r of result.rows) {
    if (r.verdict === 'missing') {
      gaps.push({ fixture: fx, surface: 'element', motion: desc(r.src), tried: 'recorded motion → Interaction (route + text pass)', outcome: 'no-fallback', fallback: 'none', note: r.why });
    } else if (r.verdict === 'drift') {
      gaps.push({ fixture: fx, surface: 'element', motion: desc(r.src), tried: 'recorded motion → Interaction', outcome: 'partial', fallback: 'none', note: 'drift: ' + r.fails.map((f) => f + ' ' + (r.diff[f] != null ? r.diff[f] : '')).join(', ') });
    }
  }
  for (const u of result.sourceUnmatched) {
    gaps.push({ fixture: fx, surface: u.kind === 'loop' ? 'element' : 'element', motion: `${u.tag} ${u.kind}: ${u.note}`, tried: 'Interactions (load / in view), Scroll Motion', outcome: 'no-fallback', fallback: 'none' });
  }
  return gaps;
}

function html(result, srcShots, convShots, meta) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const v = { match: '#00b295', drift: '#e0890b', missing: '#e5484d', extra: '#8e4ec6' };
  const row = (r) => {
    const s = r.src, c = r.conv, d = r.diff || {};
    const fmt = (e) => e ? `${e.phase} · ${Math.round(e.delay * 1000)}+${Math.round(e.duration * 1000)} ms · ${esc(e.ease)} · from o${e.from.opacity} x${e.from.x} y${e.from.y} s${e.from.scale}` : '—';
    return `<tr><td><b style="color:${v[r.verdict]}">${r.verdict}</b></td><td>${esc((s || c).tag)} “${esc(((s || c).text || '').slice(0, 40))}”</td><td>${fmt(s)}</td><td>${fmt(c)}</td>`
      + `<td>${r.diff ? `delay ${d.delay} ms · duration ${d.duration} ms · curve ${d.ease == null ? '?' : d.ease}` : ''}${r.fails && r.fails.length ? '<br><b>off: ' + esc(r.fails.join(', ')) + '</b>' : ''}${r.triggerNote ? '<br><i>' + esc(r.triggerNote) + '</i>' : ''}${r.why ? '<br><i>' + esc(r.why) + '</i>' : ''}</td></tr>`;
  };
  const strip = (title, shots) => shots.length ? `<h3>${esc(title)}</h3><div class="strip">${shots.map((x) => `<figure><img src="${esc(x.file)}" alt=""><figcaption>${x.phase} ${x.t} ms${x.phase === 'view' ? ' (scroll ' + x.scrollY + ')' : ''}</figcaption></figure>`).join('')}</div>` : '';
  const S = result.summary;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Motion check</title><style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1c1e22}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e4e5e8;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f4f5f7}.strip{display:flex;gap:8px;overflow-x:auto}.strip figure{margin:0}.strip img{width:260px;border:1px solid #e4e5e8;border-radius:4px;display:block}figcaption{font-size:12px;color:#5f6266}</style></head><body>
<h1>Motion check</h1><p>Source: ${esc(meta.source)}<br>Converted: ${esc(meta.converted)}<br>Recorded on a virtual clock, ${meta.step} ms steps.</p>
<p><b>${S.matched}</b> of ${S.source} source motions match · <b>${S.drift}</b> drift · <b>${S.missing}</b> missing · <b>${S.extra}</b> extra in the conversion · ${S.notExpressible} not expressible as an Interaction.</p>
<table><tr><th>Verdict</th><th>Element</th><th>Source</th><th>Converted</th><th>Difference</th></tr>${result.rows.map(row).join('')}</table>
<h2>Frames, side by side</h2>${strip('Source, load', srcShots.filter((x) => x.phase === 'load'))}${strip('Converted, load', convShots.filter((x) => x.phase === 'load'))}${strip('Source, in view', srcShots.filter((x) => x.phase === 'view'))}${strip('Converted, in view', convShots.filter((x) => x.phase === 'view'))}
</body></html>`;
}

/** Record both, compare, write the files. */
export async function verifyMotion({ browser, source, converted, outDir, report = null, fixture = '' }) {
  mkdirSync(join(outDir, 'motion-frames'), { recursive: true });
  const opts = { browser, shots: [0, 200, 400, 600, 800, 1200], viewShots: [100, 300, 600, 1000] };
  const src = await recordMotion({ ...opts, url: source });
  const conv = await recordMotion({ ...opts, url: converted });
  const save = (rec, tag) => (rec.shots || []).map((x, i) => { const file = `motion-frames/${tag}-${x.phase}-${i}-${x.t}.jpg`; writeFileSync(join(outDir, file), x.png); return { phase: x.phase, t: x.t, scrollY: x.scrollY, file }; });
  const srcShots = save(src, 'src'), convShots = save(conv, 'conv');
  delete src.shots; delete conv.shots;
  const result = compareMotion(src, conv, { report });
  const gaps = gapsOf(result, fixture);
  const strip = (e) => e && ({ ...e, frames: undefined });
  writeFileSync(join(outDir, 'motion-verify.json'), JSON.stringify({ source, converted, summary: result.summary, rows: result.rows.map((r) => ({ ...r, src: strip(r.src), conv: strip(r.conv) })), sourceUnmatched: result.sourceUnmatched }, null, 1));
  writeFileSync(join(outDir, 'motion-gaps.json'), JSON.stringify(gaps, null, 1));
  writeFileSync(join(outDir, 'motion-verify.html'), html(result, srcShots, convShots, { source, converted, step: src.step }));
  return { result, gaps };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const flag = (n) => { const f = args.find((a) => a.startsWith('--' + n + '=')); return f ? f.slice(n.length + 3) : ''; };
  const [source, converted, outDir] = pos;
  if (!source || !converted || !outDir) { console.log('node motion-verify.mjs <sourceUrl> <convertedUrl> <outDir> [--report=motion-report.json] [--fixture=id] [--send]'); process.exit(1); }
  let report = null; const rp = flag('report'); if (rp && existsSync(rp)) { report = JSON.parse(readFileSync(rp, 'utf8')); }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { result, gaps } = await verifyMotion({ browser, source, converted, outDir, report, fixture: flag('fixture') });
    const S = result.summary;
    console.log(`${S.matched}/${S.source} match · ${S.drift} drift · ${S.missing} missing · ${S.extra} extra · ${S.notExpressible} not expressible  → ${join(outDir, 'motion-verify.html')}`);
    for (const r of result.rows) {
      const e = r.src || r.conv;
      console.log(`  ${r.verdict.padEnd(7)} ${e.tag.padEnd(4)} "${(e.text || '').slice(0, 28)}"${r.diff ? ` Δdelay ${r.diff.delay}ms Δdur ${r.diff.duration}ms curve ${r.diff.ease}` : ''}${r.fails && r.fails.length ? ' OFF: ' + r.fails.join(',') : ''}${r.triggerNote ? ' (' + r.triggerNote + ')' : ''}${r.why ? ' — ' + r.why : ''}`);
    }
    if (gaps.length) {
      if (args.includes('--send')) {
        for (const g of gaps) { execFileSync(process.execPath, [join(HERE, 'send-finding.mjs'), '--url=' + source, '--motion-gap', '--gap=' + JSON.stringify(g)], { stdio: 'inherit' }); }
      } else {
        console.log(`${gaps.length} motion gap(s) in ${join(outDir, 'motion-gaps.json')}. To file them (after the person's consent): add --send, or one by one: node send-finding.mjs --url=<src> --motion-gap --gap='<json>'`);
      }
    }
  } finally { await browser.close(); }
}
