# HTML → WordPress Conversion kit

Turn an **HTML / AI-generated website** (Lovable, v0, a hand-built site, a static export…) into a
**native, editable UnysonPlus WordPress site** — a real page-builder site with a global design
system, not a dead HTML dump pasted into a Custom-HTML block.

This folder is the **rails**: a spec your AI agent reads, worked examples it learns from, and small
generator scripts it can adapt. The agent looks at the target site and **emits UnysonPlus's native
artifacts** (Styling Presets, a Full Page builder template, a child-theme stylesheet, header/footer);
WordPress imports them. You can `git clone` this folder and point your own AI at it.

> **This kit does NOT contain the plugin or theme** — only the spec + examples + scripts. The
> *target WordPress site* needs Unyson+ and the theme installed (see Prerequisites).

---

## 🚀 Quick start — run the converter (for total beginners)

You convert a site from inside WordPress at **Unyson+ → Convert**. There are **two ways**, and only the
second one needs you to run anything from this repo:

- **Convert from a file** — upload an export `.zip` (e.g. from Google Stitch). **Nothing to install or
  run.** If that's all you need, you can skip the rest of this Quick start.
- **Convert from a URL**, or **Use AI** to match the design more closely — these need the small
  **capture service** that lives in this repo, running on your own computer. The steps below get it
  running. (It's a tiny helper that opens the page in Chrome to read it, and — optionally — calls AI.
  It runs **only on your machine**; nothing about your site or your API key is sent anywhere.)

### What you need first

1. **Node.js 20 or newer** — download from **<https://nodejs.org>** (pick the “LTS” button) and install it.
2. **Google Chrome** — <https://www.google.com/chrome/> (the service uses it to open pages).
3. *(Only if you want the AI option)* an **Anthropic API key** — get one at
   <https://console.anthropic.com> (it looks like `sk-ant-...`). This is separate from a Claude.ai
   subscription and is billed per use.

### Step 1 — Download this repo

Easiest: on the GitHub page, click the green **Code** button → **Download ZIP**, then unzip it
anywhere (e.g. your Desktop). **Or**, if you have Git installed, open a terminal and run:

```bash
git clone https://github.com/UnysonPlus/UnysonPlus-Capture-Service.git
```

### Step 2 — Open a terminal *in the service folder*

A “terminal” is the text window where you type commands.

- **Windows:** open the unzipped folder in **File Explorer**, go into `tools\design-capture`, then click
  the address bar, type `cmd`, and press **Enter** — a black command window opens already in that folder.
- **Mac:** open **Terminal** (press ⌘+Space, type “Terminal”), type `cd ` (with a space), then drag the
  `tools/design-capture` folder onto the window and press **Enter**.

You should now be “inside” the `tools/design-capture` folder. (To check, type `ls` on Mac or `dir` on
Windows and press Enter — you should see `serve.mjs` in the list.)

### Step 3 — Install it (first time only)

Type this and press Enter, then wait for it to finish (it downloads what the service needs):

```bash
npm install
```

You only ever do this **once** per download.

### Step 4 — Start the service

```bash
node serve.mjs
```

You'll see `UnysonPlus capture service → http://localhost:8787`. **Leave this window open** while you
convert — closing it stops the service. (To stop it later, click the window and press **Ctrl + C**.)

**To turn on the AI option,** you have two choices (the service auto-detects which):

- **Already use Claude Code?** Just `node serve.mjs` — if the `claude` command is installed and you've
  signed in (run `claude` once), the AI uses **your Claude subscription**, no API key needed.
- **Have an API key instead?** Start it with the key (pay-per-use, from <https://console.anthropic.com>):

```bash
# Mac / Linux:
ANTHROPIC_API_KEY=sk-ant-... node serve.mjs

# Windows (PowerShell):
$env:ANTHROPIC_API_KEY="sk-ant-..."; node serve.mjs
```

### Step 5 — Convert, in WordPress

Go to **WordPress admin → Unyson+ → Convert**. At the top, the capture service status turns **green**
once it's detected. Now either paste a site **URL**, or tick **Use AI** and upload a file, then click
**Convert**. WordPress builds a child theme + pages and activates them for you.

### Keeping it updated / common problems

- **Update later:** if you cloned with Git, run `git pull` in the folder, then `npm install` again. (ZIP
  users: download a fresh ZIP.)
- **“service not detected” in WordPress:** make sure the Step 4 window is still open and running, and
  that the **Service URL** on the Convert page matches (default `http://localhost:8787`).
- **`node: command not found`:** Node.js isn't installed (or the terminal was open before you installed
  it) — install it from nodejs.org and open a **new** terminal.
- **Port already in use:** start it on another port, e.g. `PORT=9000 node serve.mjs`, and put that URL in
  the Convert page's Service URL box.

> The rest of this README is the deeper **spec + examples** an AI agent reads to do a fully custom
> conversion. For the everyday “upload/URL → WordPress” flow above, you don't need it.

---

## 1. Prerequisites (on the target WordPress site)

The artifacts this kit produces are consumed by the UnysonPlus stack, so the WP site must have:

| Requirement | Why | Where |
|---|---|---|
| **WordPress** 5.8+ / PHP 7.4+ | host | — |
| **Unyson+ plugin** (active) | the page builder, shortcodes, Styling Presets, Templates import, theme-settings export/import | `github.com/UnysonPlus/UnysonPlus` |
| **UnysonPlus Theme** (parent theme, active — or a child of it) | renders the builder content + header/footer + the design/token layer on the front end | `github.com/UnysonPlus/UnysonPlus-Theme` |
| **Site Converter extension** (active) | fetches the source site's **images** into the Media Library (Unyson+ → Convert) | `github.com/UnysonPlus/UnysonPlus-Site-Converter-Extension` — *bundled in the plugin*; activate under Unyson+ → Extensions |
| *(optional)* a **child theme** | the production-aligned home for the carried design CSS + webfont (e.g. a `<your-site>-child` theme); alternatively the CSS rides in Theme Settings → Misc → Custom CSS | you generate it (see the worked example) |

You do **not** need any of these *files* inside this kit — install the plugin + theme on the site,
then import the artifacts the agent emits.

---

## 2. What's in this kit

```
UnysonPlus HTML to Wordpress Conversion/
├── README.md                 ← you are here (how to use + prerequisites)
├── conversion-contract.md    ← THE SPEC: the exact artifact formats UnysonPlus consumes.
│                               Your agent reads this first. Self-contained prose + examples.
├── conversion-plan.md        ← the initiative's roadmap / context / honest trade-offs.
├── reference-exports/        ← REAL, ground-truth exports — the shapes an agent must mirror:
│   ├── example-full-page-template-export.json     (a real Full Page builder-template export)
│   └── example-theme-settings-design-export.json  (a real Theme Settings "design" export)
└── examples/                 ← WORKED EXAMPLES — complete conversions to study + copy:
    ├── static-html-site/     ← a self-contained HTML/CSS landing page (the full round-trip):
    │   ├── README.md  analysis.md  source/        (source + the mapping)
    │   ├── presets.json  theme-settings-design.json  full-page-template.json  global.css
    │   ├── phase3-chrome.sh                        (menus/site-title via WP-CLI)
    │   └── build-template.mjs  build-theme-settings.mjs  build-child-theme.mjs   (generators)
    └── react-spa-site/       ← a JS / React (SPA) site, rendered client-side (in progress):
        └── analysis.md  source/
```

> **Note on links inside `conversion-contract.md`:** it deep-links into the plugin/theme source
> (`../unysonplus/…`, `../unysonplus-theme/…`). Those resolve when this folder sits next to the
> plugin in the dev monorepo; in a standalone clone they're just reference pointers — the contract's
> prose + the worked example stand on their own.

---

## 3. How to convert a site (the procedure)

Give your AI agent this kit and the target site URL. The flow (tokens-first — see contract §0.3):

**0. Capture & analyze the source.** If it's a JS app (React/Vite/Lovable/v0), render it (headless)
   to get the real DOM — the static HTML is just a shell. Extract the design system (fonts, palette,
   spacing) and segment the page into sections → UnysonPlus primitives. Write an `analysis.md`
   (see `examples/static-html-site/analysis.md` and `examples/react-spa-site/analysis.md` for the format).

**1. Design system → presets / child-theme CSS.** Map the tokens to Styling Presets, and/or carry
   the source stylesheet into a child theme (scoped to `.entry-content`, resets stripped — contract
   §0.4 / gap G12) plus enqueue any webfont. See `build-child-theme.mjs`.

**2. Header / Footer (chrome).** Populate the theme's Primary/Footer menus + site title
   (`phase3-chrome.sh`), styled to match via a small bridge (contract §3.3).

**3. Page body → a Full Page template.** Emit the page as a `kind:"full"` builder-template `.json`
   (sections → columns → leaves: `special_heading`, `text_block`, `icon_box`, `accordion`, … and
   `code_block` for the ~10% that doesn't map). Data/interactive bands → a thin domain shortcode or a
   `code_block` placeholder (contract §0.5). Mirror `reference-exports/example-full-page-template-export.json`
   for the exact shape; `build-template.mjs` is a working generator.

**4. Images → Media Library.** Unyson+ → **Convert** → scan the site URL (turn on "mine the JS
   bundle" for JS apps) → preview the thumbnails → pick → import (de-duped by URL + content hash).

**5. Import + wire up, in this order:**
   1. **Child theme** → upload to `wp-content/themes/` and activate (or paste the CSS into Theme
      Settings → Misc → Custom CSS).
   2. **Theme-settings design file** (if used) → Theme Settings → Misc → **Import design**.
   3. **Images** → Unyson+ → **Convert** (step 4).
   4. **Full Page template** → Unyson+ Templates → **Full → Import** → create a page from it → set as
      the front page.
   5. **Menus** → Appearance → Menus (or `phase3-chrome.sh`).

When the page round-trips and reads like the source, the conversion is done. The worked example
`examples/static-html-site/` shows every one of these artifacts produced for a real site — copy its patterns.

---

## 4. Philosophy (the short version)

Convert **structure + design system, not HTML**. Favor **editability over pixel-perfection**, with a
`code_block` + scoped-CSS escape hatch for the part that doesn't map cleanly. Full rationale, format
specs, and the gap log (G1–G12) are in **`conversion-contract.md`**.

---

## License

**PolyForm Noncommercial 1.0.0** — see [`LICENSE`](LICENSE). Free to run locally and to convert sites for yourself
or for clients (the sites you build are yours); not for resale, bundling into a paid product, or offering as a
hosted service without a commercial license (jonmlas@gmail.com). The UnysonPlus plugin and theme this service
feeds stay GPL-2.0-or-later.
