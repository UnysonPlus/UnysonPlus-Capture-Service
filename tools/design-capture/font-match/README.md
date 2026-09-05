# Visual font matcher

Finds the nearest **free Google font** for a source site's **licensed / self-hosted** heading or body
face, so the Site Converter can substitute one it can't legally rehost. Self-owned, offline, deterministic —
no third-party model, no non-commercial dependency.

## How it works

The source browser already has the real licensed face loaded, so the capture service **measures it as it
renders** (no font file needed) and matches its shape against a prebuilt index of Google fonts.

- **`match.mjs`** — runtime. `matchRenderedFont(page, family, k)` rasterizes probe glyphs of `family` on a
  headless-browser canvas, derives a 6-feature shape vector, and returns the nearest fonts from `font-index.json`.
  Best-effort (returns `null`, never throws). Called from `capture.mjs`, which writes the top pick to
  `design-config.json` as `fonts.heading_visual` / `fonts.body_visual`.
- **`font-index.json`** — the prebuilt index (~130 Google fonts × the 6 features, z-normalised). Committed.

The 6 features (all read from rasterized glyphs, deterministic): `widthRatio` (condensed↔wide), `xHeightRat`
(low↔high x-height / all-caps titling), `weight` (light↔black), `contrast` (grotesque↔Didone), `serif`
(sans↔serif feet), `round` (geometric roundness).

## Consumed by the converter

The PHP theme generator (`FW_Site_Converter_Theme_Generator::from_capture`) reads `fonts.heading_visual`
and uses it as the lookalike **only when its curated name→lookalike map misses** — the curated map always
wins when it has an entry (so e.g. `Neutraface → Josefin Sans` from the map, not the visual pick). The visual
match fills the long tail of unmapped licensed faces.

## Regenerating the index

The index is only as good as the catalogue it can pick from — every free font a heading might be substituted
*to* should be in it. To widen coverage or refresh:

```bash
cd build
python download-fonts.py        # fetch TTFs (per families.txt) into ./fonts via the GitHub API
npm i opentype.js playwright     # dev-only build deps (NOT needed at capture runtime)
node build-index.mjs             # rewrites ../font-index.json
```

Edit `build/families.txt` (one Google-fonts folder slug per line) to add/remove candidates. `build/fonts/`
(the downloaded TTFs) is a build artifact and is **not** committed — only `font-index.json` is.
