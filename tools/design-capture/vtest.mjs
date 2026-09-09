import { verifyUrls } from './verify.mjs';
const rendered = process.argv[2];
const label = process.argv[3] || 'SITE';
const src = 'file:///' + rendered.replace(/\\/g, '/');
const r = await verifyUrls({ sourceUrl: src, convertedUrl: 'http://localhost/', width: 1440, bands: 8 });
console.log(`${label}: overall_drift=${r.overall_drift_pct}%  height_delta=${r.height_delta_pct}%  compared=${r.compared}`);
if (Array.isArray(r.bands)) console.log('  bands drift%: ' + r.bands.map(b => b.pct).join(' | '));
