// Tool fixture: the ink lens must (a) name a recoloured run, (b) not fire on the same ink written differently.
import { verifySections } from './verify.mjs';
const mk = (color) => 'data:text/html,' + encodeURIComponent(
  `<!doctype html><html><head><style>body{margin:0;font:16px/1.4 Arial}section{padding:40px}</style></head><body>
   <section><h2 style="font-size:60px;color:#fff">Let us Move <span style="color:${color}">Forward.</span></h2></section></body></html>`);
const same = await verifySections({ sourceUrl: mk('rgb(255, 61, 0)'), convertedUrl: mk('rgba(255,61,0,1)') });
const diff = await verifySections({ sourceUrl: mk('rgb(255, 61, 0)'), convertedUrl: mk('#ffffff') });
const inks = (r) => (r.sections || []).flatMap((s) => (s.findings || []).filter((f) => f.kind === 'ink'));
const a = inks(same).length, b = inks(diff).length;
console.log(`[ink] same ink, different notation -> ${a} findings (expect 0): ${a === 0 ? 'PASS' : 'FAIL'}`);
console.log(`[ink] recoloured run              -> ${b} findings (expect >=1): ${b >= 1 ? 'PASS' : 'FAIL'}`);
process.exit(a === 0 && b >= 1 ? 0 : 1);
