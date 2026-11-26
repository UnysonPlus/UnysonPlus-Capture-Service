# Motion fixtures (roadmap 10)

Pages with KNOWN motion, for the motion recorder (`motion-record.mjs`), the converter's motion → Interaction mapping and
`motion-verify.mjs`. Each folder is keyed by a neutral id and holds:

- `index.html`: the page. Serve it from any local web server (`http://localhost/<folder>/`) to record or convert it.
- `raw-series.json`: the recorder's raw samples of that page (`MR_DEBUG=<file> node motion-record.mjs <url>`), which
  `motion-record.test.mjs` analyses without a browser.

`fixture-motion-01` (true values, from its own CSS / script):

| Element | Trigger | Delay | Duration | Curve | From |
| --- | --- | --- | --- | --- | --- |
| h1 | load (CSS animation) | 0.2 s | 0.8 s | cubic-bezier(.22,1,.36,1) | y 40, opacity 0 |
| hero p | load (CSS transition on a class added at load) | 0 | 0.6 s | ease-out | x -60, opacity 0 |
| .cta | load (Web Animation) | 0.6 s | 0.5 s | cubic-bezier(.34,1.56,.64,1) | scale 0.8, opacity 0 |
| .js-in p | in view (requestAnimationFrame tween) | — | 0.9 s | ease-in-out quad | y 30, opacity 0 |
| 3 cards | in view (CSS transition, staggered) | 0 / 0.15 / 0.3 s | 0.7 s | cubic-bezier(.16,1,.3,1) | y 50, scale 0.95, opacity 0 |
