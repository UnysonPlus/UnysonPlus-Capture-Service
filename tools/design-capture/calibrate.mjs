/**
 * CALIBRATE THE VERIFICATION LENSES — point each one at a page and ITSELF.
 *
 * A perfect input must produce a perfect score. Whatever a lens reports on a page compared with itself is
 * the instrument's own error, and every real reading sits on top of it. Without this number a finding is an
 * opinion: earlier in this converter's life the drift lens read up to 20.5% on a single band of two renders
 * of the SAME page (a hero video at a different frame each time), so anything under about 20% looked exactly
 * like a finding and was noise. Freezing motion took that floor to 0.
 *
 * Run it after ANY change to verify.mjs, and before trusting a surprising number:
 *   node calibrate.mjs <url> [more urls…]
 *
 * Every lens should print 0. A non-zero line is a bug in the lens, not a finding about the page.
 */
import { verifyUrls, verifySections, verifyChrome } from './verify.mjs';

const urls = process.argv.slice(2).filter((a) => /^https?:\/\//i.test(a));
if (!urls.length) {
  console.error('usage: node calibrate.mjs <url> [url…]   (each is compared with ITSELF)');
  process.exit(2);
}

let bad = 0;
for (const url of urls) {
  console.log(`\n=== ${url} (vs itself) ===`);

  const u = await verifyUrls({ sourceUrl: url, convertedUrl: url, bands: 12 });
  if (!u.ok) { console.log(`  verifyUrls      ERROR ${u.reason || u.error}`); bad++; }
  else {
    const worst = Math.max(0, ...(u.bands || []).map((b) => b.drift_pct));
    console.log(`  verifyUrls      overall ${u.overall_drift_pct}%  worst band ${worst}%   ${u.overall_drift_pct === 0 && worst === 0 ? 'clean' : 'NOISE FLOOR — readings below this are not evidence'}`);
    if (u.overall_drift_pct !== 0 || worst !== 0) bad++;
  }

  const s = await verifySections({ sourceUrl: url, convertedUrl: url });
  if (s && s.error) { console.log(`  verifySections  ERROR ${s.error}`); bad++; }
  else {
    const secs = s.sections || [];
    const findings = secs.flatMap((x) => x.findings || []);
    const dh = secs.reduce((n, x) => n + Math.abs(x.dh || 0), 0);
    const kinds = {};
    for (const f of findings) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
    console.log(`  verifySections  ${secs.length} sections, ${findings.length} findings, Σ|Δh| ${dh}px   ${findings.length === 0 && dh === 0 ? 'clean' : 'FALSE FINDINGS: ' + JSON.stringify(kinds)}`);
    if (findings.length || dh) bad++;
  }

  for (const scope of ['header', 'footer']) {
    const c = await verifyChrome({ sourceUrl: url, convertedUrl: url, scope });
    const n = (c && c.findings) ? c.findings.length : 0;
    if (c && c.ok === false) { console.log(`  verifyChrome ${scope.padEnd(6)} skipped (${c.error})`); continue; }
    console.log(`  verifyChrome ${scope.padEnd(6)} ${n} findings   ${n === 0 ? 'clean' : 'FALSE FINDINGS'}`);
    if (n) bad++;
  }
}

console.log(bad ? `\n✗ ${bad} lens reading(s) were non-zero on a perfect input — fix the lens before trusting a finding.`
                : '\n✓ every lens reads zero on a perfect input — findings can be trusted at face value.');
process.exit(bad ? 1 : 0);
