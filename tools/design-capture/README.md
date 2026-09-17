# design-capture

Render a (possibly JS-only) website in headless Chrome and capture its **design** so the
Unyson+ **Site Converter** can rebuild it in WordPress. One pass produces everything the
converter needs — copying *stylings and structure*, never the source's identity (the logo
stays the WordPress site's own Site Logo / Site Title; the footer brand is the Site Title).

## Usage

```bash
npm install                       # once (installs playwright-core)
node capture.mjs <url> [outdir]   # outdir defaults to ./capture-out
```

## Site Analyzer — convert by URL from the WordPress admin (`serve.mjs`)

Instead of running the CLI and uploading the `.zip` by hand, run this tool as a tiny
**local service** and convert sites straight from **Unyson+ → Convert → "Convert a site by
URL"**. Three steps (this is what the admin page's "Capture service — setup" panel describes):

```bash
# 1. Prerequisites: Node 20+ and Google Chrome installed (the capture uses your system Chrome).
node -v                              # confirm Node 20+

# 2. Install the service (first time only) — from this folder (tools/design-capture):
npm install

# 3. Start it and leave it running:
npm start                            # = node serve.mjs, serves http://localhost:8787
PORT=9000 npm start                  # different port (PowerShell: $env:PORT=9000; npm start)
```

Leave it running while you convert sites; the WordPress admin page (in your browser, same
machine) reaches `http://localhost:8787` directly.

## AI companion — refine a conversion with Claude (`to-ai.mjs`)

The same service exposes **`POST /ai-convert`**, used by the **"Use AI"** checkbox in
**Unyson+ → Convert → Convert from a file**. The deterministic converter parses an export into a draft
*mapping* (sections → elements); the AI step hands that draft + the original markup to Claude and gets
back a **refined mapping** (corrected roles, decorative chrome dropped) plus a **`custom_css`** that styles
the rebuilt WordPress markup to look like the original. The plugin then builds the page from the refined
mapping and folds the CSS into the generated child theme — so the model never hand-writes fragile
page-builder JSON.

### Two ways to power it (auto-detected)

You don't need an API key if you already use **Claude Code** — the service picks a backend automatically:

**A. Claude Code (your subscription — no API key, no extra billing).** If the `claude` CLI is installed
and signed in, just start the service normally:

```bash
npm start            # if `claude` is on PATH + signed in, AI uses your subscription
```

The service shells out to `claude -p` locally for each refinement. First time, run `claude` once
interactively to sign in. (Point it at a specific binary with `CLAUDE_CLI=/path/to/claude` if needed.)

**B. Anthropic API key (pay-per-use).** Start it with a key from <https://console.anthropic.com>
(billed separately from a Claude.ai subscription):

```bash
# macOS / Linux
ANTHROPIC_API_KEY=sk-ant-... npm start
# Windows PowerShell
$env:ANTHROPIC_API_KEY="sk-ant-..."; npm start
```

Pick order: `AI_BACKEND` env (`api` / `claude-code`) overrides, else an API key wins, else the `claude`
CLI, else AI is off. Optional: `ANTHROPIC_MODEL=claude-opus-4-8` to choose a model (API default:
`claude-sonnet-4-6`; Claude Code uses your configured model).

`GET /health` reports `"aiReady": true` and `"aiBackend": "claude-code" | "api"`, and the admin's AI
status turns green ("AI ready (Claude Code subscription)" / "(API key)"). **Nothing leaves your machine** —
your key/subscription lives only in this local service; WordPress only ever receives the finished mapping +
CSS. Neither available → `/ai-convert` returns 503 and the converter falls back to the deterministic +
manual-review flow.

## Staying up to date

The service knows its own version (from `package.json`) and checks GitHub for a newer one — **offline-safe**
(any failure is ignored, so a localhost/offline user is never blocked). `GET /health` returns
`{ version, latest, updateAvailable }`, the startup log prints a one-line hint when behind, and the
WordPress **Capture service** box shows e.g. *"✓ Service running — v1.7.0"* or *"⬆ Update available
v1.8.0 — run `git pull && npm install`"*.

To update (notify-by-default — you stay in control):

```bash
git pull && npm install   # then restart: node serve.mjs
```

Prefer it to self-update? Start it with **`AUTO_UPDATE=1`** and on launch it will `git pull --ff-only`
+ `npm install` + restart itself when a new version exists (skips silently with no internet or if it
isn't a git clone):

```bash
AUTO_UPDATE=1 npm start                          # macOS / Linux
$env:AUTO_UPDATE="1"; npm start                  # Windows PowerShell
```

> The package is **not published to npm**, so `npx unysonplus-site-capture` will not resolve on
> a clean machine — use the `npm install` + `npm start` steps above. (To get the bare command
> working locally without publishing, `npm link` once in this folder; then
> `unysonplus-site-capture` starts the service from anywhere.)

Then in WP admin, paste a URL and click **Analyze & convert**. The admin page runs in *your*
browser on *your* machine, so it reaches `http://localhost:8787` directly — even though the
(remote) WP server can't. The service renders the page, builds the bundle, and the extension
applies it (media → theme → pages → menus). Leave the service running while you convert sites.

| Endpoint | Returns |
|---|---|
| `GET /health` | `{ ok, service, version }` (the admin page pings this to show "service detected") |
| `GET /capture?url=<url>` | the `convert-bundle.zip` for that URL |

CORS is open and `Access-Control-Allow-Private-Network: true` is sent, so an `https` WP admin
page can fetch from `http://localhost` (browsers treat loopback as trustworthy). No service?
The manual `capture.mjs` → upload-`.zip` path still works as a fallback.

## Outputs

| File | What | Where it goes in WordPress |
|---|---|---|
| `design-capture.json` | The raw capture — tokens, header/footer chrome, full body block model, assets. | Source of truth; can be pasted into the generator directly (auto-detected). |
| `design-config.json` | The **theme** config (fonts, colors, header logo/menu/button styling, footer menu/social/copyright, background). | Unyson+ → Convert → **Generate header & footer theme** (Child or Standalone). |
| `pages.json` | The **body** as an editable page-builder **Home page** (sections → `special_heading` / `text_block` / `icon_box` columns). | Unyson+ → Convert → **Import Pages** (or drop into a Convert bundle). |
| `full.png`, `header.png` | Screenshots for reference. | — |
| `animations.json` + `animation-report.csv/html` | The **animation tracer**'s findings — detected libraries (GSAP/ScrollTrigger dump, Lenis, Lottie, Three.js, Swiper, AOS), CSS keyframes + hover diffs, scroll motion traces (reveal/parallax/pin), numbered **frame sequences** (`…/%d.webp` pattern + count + start), and scroll-hijacked-page detection — each mapped to a suggested Animation Engine fx (`gsap_motion` reveal, hover `lift`/`scale`/`color_shift`, marquee, `image_sequence`, scrollytelling **stage** backdrop). | Review the report; the JSON is the machine-readable input for emitting fx on converted pages. **URL path only** — a static HTML file has no runtime to trace, so the PHP file-upload path intentionally has no equivalent (documented asymmetry, not drift). |

## Raw chrome — pixel-faithful header & footer

`capture-extract.mjs` also emits a **`chrome`** block: the **verbatim HTML** of the header
and footer (URLs absolutized, `<script>` stripped) plus the **matching CSS** — every rule
across the page's stylesheets whose selector matches an element inside the header/footer,
plus `:root`/`html`/`body` globals, `@font-face` and `@keyframes`. Cross-origin sheets that
can't be read (CDN Bootstrap / Font Awesome / Google Fonts) are returned as `linked_css`
hrefs. This rides along in `theme-design.json` as `raw_chrome`.

When the generator sees `raw_chrome`, it **mirrors the chrome exactly** instead of rebuilding
it: the captured HTML becomes the header/footer template parts, the captured CSS becomes the
theme's `style.css`, and the `linked_css` libraries are re-enqueued (the chrome CSS depends on
them so it wins the cascade). A small reset neutralizes the parent theme's `#page`/`#content`/
`#colophon` wrappers so the mirrored markup owns its own layout. The result reproduces the
source header & footer pixel-for-pixel (hover, responsive, webfonts included). Trade-off: it's
a static visual mirror — the nav isn't a WordPress menu yet, and the logo is the source's own.

## Reporting a converter miss (the findings feed)

A conversion that differs from its source is reported as a MEASURED tuple, streamed one finding at a time:

```
node send-finding.mjs --url=<src> --finding='{"region":"s2","property":"font-weight","got":"400","expected":"700",
  "construct":"button.btn-amber .font-bold","path":"capture-out/<site>","twin":"php","loss":"overridden","recurs":true,
  "severity":"style","computed":"font-weight 400 from .btn (0,1,0) — the preset rule lost","note":"…",
  "fixture":"@capture-out/<site>/fixture.html","twin_shows":"button weight 400 (same as the page)","solution":"the general rule, not a per-site patch"}'
node make-fixture.mjs capture-out/<site> "<css selector>"      # the stamped repro fixture (structure only, ≤ 32 KB; repeated siblings pruned to 3 per run when over)
node send-finding.mjs --url=<src> --summary --stats=capture-out/<site>/share-stats.json --positives="hero cover + 3 icon boxes"  # once per site (the POSITIVES go here)
node pull-findings.mjs [--since=<ISO>] [--json=<file>] [--fixtures=<dir>]                # the maintainer's side
```

The sender refuses a finding without `region · property · got · expected · construct · path · twin · loss`, an
unstamped fixture, a fixture without `twin_shows` (what the PHP twin emitted for it — the proof it reproduces), a
`solution` that is a `#id{…}` site patch, a note that says "fixed per-site" without the general `solution`, or a
POSITIVE row (it goes in the summary's `--positives`). `severity` (`layout | content-loss | style | cosmetic`) orders
the maintainer's batch; `computed` (what `getComputedStyle` returned on the built page, and which rule won) settles an
`overridden` loss. `got` / `expected` are computed values read on the
BUILT page (`twin: php` = the WordPress import) and the source at the same viewport; `construct` is the source
class / rule / tag; `path` is the capture-out folder. Full contract: the AI Dev Kit's `docs/site-build-protocol.md`.

## Multi-page conversion

`capture.mjs` captures the **home** page, then crawls the **header nav's internal links**
(same-origin, real paths — not `#anchors` / `mailto:` / `tel:`) and captures each as its own
WordPress page (capped at `MAX_PAGES`, default 10). The chrome (header/footer), theme, style
guide and media come from home + the union of all pages; each page's body is a verbatim mirror.
Page slugs derive from the URL's last path segment (`speakers.html` → `speakers`); home is the
front page. **Internal links are rewritten to root-relative WP paths** (`/speakers/`, `/` for
home/index) in both the chrome and every page body, so the converted site navigates between the
real pages. The Pages importer (plugin side) already creates a page per entry, idempotent by slug.

## Element decomposition (intro-only) → real shortcodes

`capture-extract.mjs` `decompose()` routes a section's content to editable builder elements,
keeping the layout:
- standalone **headings** → `special_heading`, **intro paragraphs** → `text_block`, **CTA
  buttons** → `button` (alignment from the captured `text-align`);
- a **multi-column row** → real builder **columns** at the captured widths (from the `col-*`
  span), each cell's content a **`code_block`** (e.g. a speakers grid → a `special_heading`
  intro + a row of `1_4` columns, one per speaker-item);
- anything else (media leaves, lists, tables) stays a verbatim `code_block`.

A section only decomposes when it yields at least one shortcode-able element; **hero sections
with an absolute background layer (`bgWrapperOf`) and detected sliders stay as-is**. The source
section class is carried onto the builder `section` so descendant CSS still styles the
extracted + verbatim content. `code_block` remains the universal fallback for unmapped markup.

## Slider → carousel mapping

`capture-extract.mjs` `detectSlider()` recognizes initialized sliders (Swiper / Owl / Slick /
Splide / Bootstrap carousel — excluding the loop CLONES those libs inject) inside a section and
extracts each slide's `image / heading / text / button`. `to-pages.mjs` then emits the editable
**`carousel`** shortcode instead of a static code-block, choosing a layout heuristic: image-only
slides → a logo strip (multi-per-view, no arrows); heading+button+image → a hero (background
image, text overlaid); otherwise a 1-up content slider. A hero whose background is an absolute
layer (bg-box) is left as a verbatim code-block so the background survives.

## How the mapping stays faithful

- **Grid detection** — `findGrids` recognizes both CSS `display:grid` AND **Bootstrap flex
  rows** (`.row > .col-*`). Bootstrap (which the plugin itself uses) is flexbox, not CSS grid,
  so without this every Bootstrap card grid flattened into the generic mirror; now they map to
  real feature/card columns. (Tile cap is 12 so larger card grids — e.g. a food menu — aren't skipped.)
- **Header detection** — `capture-extract.mjs` first looks for `<header>` / `[role=banner]`;
  if neither exists (common in SPA / Lovable / v0 / React sites) it falls back to the topmost
  pinned bar — a `<nav>` (or navbar/header-classed element) at `top ≈ 0`, full-ish width, with
  ≥2 links/buttons — and reads its logo (styling only), nav items and CTA from there. Logo/CTA
  scanning includes `<button>` since SPAs route via JS.
- `to-design-config.mjs` — capture → theme config. Mirrors the PHP
  `FW_Site_Converter_Theme_Generator::from_capture` (the generator auto-detects a raw capture
  too, so either file works). Heading/body fonts (incl. the source's own Google Fonts URL),
  `--primary` accent, logo + CTA-button styling (pill radius clamped), header sticky, footer
  link columns → an editable menu, copyright tagline.
- `to-pages.mjs` — capture body sections → the Pages-importer payload. Clones the heavy default
  att-blobs from `atom-templates.json` (real nodes extracted from a proven export) and swaps
  only the content, per the conversion rule *"clone shapes from a real export, only swap
  content."* The plugin's own encoder regenerates `post_content`, so every section stays
  editable in the builder. **Archetype vs. mirror routing:** simple sections (hero, steps, plain
  feature grids) use native shortcodes; sections that are grids of *chrome'd* cards (stat cards,
  — and a **countdown** in the hero (a row of number + time-unit cells like "03 Days 14 Hours
  21 Min 56 Sec") is detected and emitted as the `countdown` shortcode, targeting capture-time +
  the snapshot's remaining time (the editor user can reset it to the real event date). **Hero
  buttons** are emitted as real, editable `button` shortcodes (inline-block `.btn`, so they flow
  inline; the hero's text-align centers/left-aligns the row) rather than text-block links —
  auction-item cards with badge/price/bid-count, progress cards) are detected by
  `isRichCardSection()` and routed to the DOM-mirror instead — the icon_box archetype can't
  express that richness, but the mirror reproduces it faithfully (card bg/border/shadow, badges,
  price, etc.). The **hero** has two shapes: a *cover* hero (full-bleed background photo with
  centered white text, chosen when the heading text is light) and the *split* text/media layout.
- `to-mirror.mjs` — the generic DOM-mirror. Maps a mirror subtree → section/column/text-block
  carrying each element's computed styles into `.scm-*` classes. A bare "NN%" text is synthesized
  into a progress bar (the source's fill width/colour aren't captured, so width comes from the %
  and the fill is painted with the `--primary` accent).

`atom-templates.json` is regenerated from a proven page export (see the extraction one-liner in
the repo history) whenever the builder's option schema changes.
