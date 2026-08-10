# ⚠️ Keep the "no‑AI" conversion algorithm in sync — BOTH implementations

The deterministic (**no‑AI**) converter — the logic that turns a source design into a UnysonPlus
**child theme + page‑builder pages** *without* calling an LLM — exists **TWICE**, once per input path.
**If you change one, you MUST change the other** so the two paths produce consistent results.

> **📘 Manual procedure + hard-won learnings — read before a demo OR a launch-site conversion.**
> The human-followed process these converters AUTOMATE, and every gotcha from building demos
> (Theme-Settings-first mapping, Text Styles, the 3-tier Custom CSS escape hatch, logo strips /
> inline SVG, `mask-image` background fades, the fidelity + computed-style diff gate, …) lives in the
> **Site Conversion Playbook**: `framework/extensions/site-converter/docs/site-conversion-playbook.md`
> (in the plugin / `UnysonPlus-Site-Converter-Extension` repo). The converters' north star is to EMIT
> what that playbook builds by hand — keep them converging on it.

| Path | Lives in | Files |
|---|---|---|
| **URL capture** (this repo) | `tools/design-capture/` (JS) | `capture-extract.mjs`, `to-pages.mjs`, `to-design-config.mjs` |
| **File upload** (the WP plugin) | `unysonplus/framework/extensions/site-converter/includes/` (PHP) | `class-fw-site-converter-stitch.php`, `class-fw-site-converter-mapper.php`, `class-fw-site-converter-theme-generator.php` |

> The **AI** path (`to-ai.mjs`, `/ai-convert`) is separate — this rule is about the **deterministic**
> path that runs offline. (When the AI authors the child theme, the deterministic path is the fallback.)

## What "conversion logic" means (any of these changed → sync the other side)

- What counts as a **page section** vs. chrome.
- How sections map to **shortcodes** (roles: `title` / `text` / `button` / `columns` / `icon_box` /
  `counter` / `feature_list` / `image` / `video` / `scroll_indicator` / `code` / `skip`).
  **Pick the purpose-built element for the content pattern** (see "element selection vs effect addition"
  in the site playbook) — the resting state matches the source; never add motion the source lacks.
  - **`video`** — a source `<video>` (self-hosted) or a provider `<iframe>` (YouTube/Vimeo/…) → the
    native **`media_video`** shortcode (self-hosted file / oEmbed URL), **never** a raw `<video>` in a
    text/code block. PHP: `stitch` `video` recognizer + `Mapper::n_video()` / `embed_to_page_url()`.
    JS: `videoBlockOf()` (before `SKIP_TAGS`) + `videoNode()` / `embedToPageUrl()`. Self-hosted mode
    carries autoplay/muted/loop/controls/playsinline; autoplay forces muted.
  - **`counter`** — a big KPI/stat number → the **`counter`** (Animated Counter). Number-only; the
    label is a sibling `special_heading`/`text_block`; prefix/suffix are inline captions ($, %, PB/s).
    PHP `Mapper::n_counter()` + JS `counterNode()` (both already wired).
  - **`feature_list`** — an icon-led list / checklist (`<ul>`/list of icon+text rows) → **`feature_list`**
    (design `icon` = per-item icons, or `check`/`numbered`/`bullet`), NOT stacked `icon_box`es. Each item
    = `{ text, subtext, icon, state }`. Carry an explicit icon size to `marker_size`.
  - **`image`** — a standalone `<img>` → the native **`media_image`** shortcode, **never** a `gallery`
    (that's for multiple images) and never a `code_block`. A `gallery` is only for a set of images.
  - **`scroll_indicator`** — a bottom-of-hero `animate-bounce` label + chevron that anchors to the next
    section → the **`scroll_indicator`** shortcode (text, icon, target `#anchor`, layout, animation).
  - **`logo_grid`** — a logo / "trusted by" strip (a row of ≥2 `<img>`, no headings) → the native
    **`logo_grid`** shortcode (each `<img>` → one logo: image URL + alt name + enclosing-`<a>` link),
    **never** a verbatim code_block. PHP: `stitch` `logo_strip` recognizer (pri 25) + `Mapper::n_logo_grid()`.
    JS: `logoStripOf`/decompose `t:'logo_grid'` + `logoGridNode()`.
  - **`call_to_action`** — a CENTERED band with exactly ONE heading (h2–h6, not a hero h1), optional
    subtext, and exactly ONE button → the native **`call_to_action`** shortcode (title=plain text,
    message=HTML, one button). TIGHT so a hero (h1 + media + 2 buttons) or a feature grid never qualifies;
    a 2-button CTA stays assembled (one button slot) so nothing is dropped. The source button's fill is
    reproduced on `.btn.btn-1` via the node's scoped custom_css. PHP: `stitch` `call_to_action` recognizer
    (pri 81) + `Mapper::n_cta()`. JS: `ctaBandOf` + `ctaNode()`.
- **Per-section container width** — read each section's `mx-auto max-w-{3xl..6xl}` and set the section's
  **Container Width** option (Narrow 768 / Medium 896 / Wide 1024 / Custom) instead of the global width or
  per-element max-widths. The GLOBAL Container Width still maps the widest band (`max-w-7xl` → 1328px).
- **Hover overlays** — a card's `absolute inset-0` + `opacity-0` + `group-hover:opacity-100` child is a
  fade-in sheen; reproduce as a scoped `::before`/`::after` fade (+ the `hover:border-*` change).
- **Icon size** — a source icon with an explicit size (`text-4xl`, `w-8 h-8`) → the element's **Icon Size**
  option (icon / feature_list / icon_box), not child CSS.
- What's treated as **chrome** (header / footer / nav) vs. body **content**.
- **Header / footer detection** — e.g. a bare sticky `<nav class="fixed top-0">` as the header when
  there's no `<header>`; excluding the standalone brand link and the CTA from the nav menu.
- **Token / design extraction** — palette, fonts, spacing → the design‑config / child‑theme CSS.
- **Child‑theme file generation** — `style.css`, `header.php`, `footer.php` (the plugin's theme
  generator owns these; the capture path feeds it the same design‑config shape).

## Reference

The **capture service's extraction is usually the more‑complete** one (it has a live DOM + computed
styles, not just static HTML). When in doubt, make the PHP match the JS behavior.

**…but not always — check both before assuming.** A real case (fixed in v1.7.47): body-band
detection. The PHP `walk_section_roots()` was a correct depth‑agnostic DFS (dive through plain
wrappers, claim the outermost `<section>`s), while the JS used a hardcoded 3‑level selector
(`:scope > section, :scope > div > section, :scope > div > div > section`). That silently matched
**nothing** on the very common WordPress chain `main > article > div.entry-content > div > section`,
so such pages converted to an EMPTY page with no error. The JS now mirrors the PHP: query every
`<section>` under `main` and keep only the outermost ones. **Lesson: when the two paths disagree,
the more‑complete one is whichever is depth/structure‑agnostic — verify, don't assume it's the JS.**

**Another real case (fixed in capture‑service v1.7.78 / site‑converter v1.3.36): global `util_css`
completeness — the "10%‑done conversion" bug.** The JS categorizer (`capture-extract.mjs`, the
`walkRules` site‑rule branch) split a first‑party sheet's rules into `base` / `util` / `header` /
`footer`, but only promoted **global (`:root` / `html` / `body`) and header/footer‑scoped** selectors
to the global buckets. Every **other** utility — a body‑section `.py-5`, `.feature-card`, a card
`.shadow`, … — was deferred to per‑section CSS **only**. Meanwhile the global `util` bucket was fed
almost exclusively by sheets whose **filename matched `VENDOR_RE`** (`tailwind`, `bootstrap`, …). A
Tailwind/JIT source that ships its utilities from an **inline `<style>` (no href) or a hash‑named
bundle** (e.g. `index-Cd4aA-AH.css`) is classified as first‑party, so its body‑section utilities never
entered `util_css`; when the raw‑chrome mirror theme was generated and the per‑section CSS merge came
through empty, **every below‑the‑header section shipped unstyled** — the hero looked right, the feature
grid / CTA / footer were bare text (the `freshpaws` "~10% done" demo). **Fix:** in the site‑rule branch,
ALSO push every page‑matching, non‑global, non‑chrome selector into the global `util` bucket, gated by
`matchesPage()` so only utilities **actually used on the page** are carried — the same "wholesale,
page‑matched" treatment vendor sheets already get, which makes vendor‑name detection **non‑load‑bearing
for completeness**. The **PHP upload path needed no change** (it carries the whole reproduced CSS blob
as `css` → the theme generator treats it as `util`, already complete), but the **invariant now holds on
both sides: global `util_css` must carry ALL page‑matching utilities — not just header/footer‑scoped or
vendor‑named ones.** Verified on the real freshpaws source (Wegic, hash‑named bundle): `util_css`
**203 B → 2089 B**. **Lesson: never let CSS completeness depend on a source's stylesheet *filename* or on
a later per‑section merge — a section that renders must carry its full CSS at theme‑generation time.**

## Checklist before finishing any conversion change

- [ ] PHP file‑path engine updated (`class-fw-site-converter-*`).
- [ ] JS URL‑path engine updated (`capture-extract.mjs` / `to-pages.mjs` / `to-design-config.mjs`).
- [ ] Both make the same chrome / section / shortcode decisions on a shared sample.
- [ ] Versions bumped (plugin `unysonplus.php` + `framework/manifest.php`; the extension manifest;
      this repo's `tools/design-capture/package.json`).

_(This rule is also recorded in the workspace `CLAUDE.md` and the extension's `AGENTS.md`.)_
