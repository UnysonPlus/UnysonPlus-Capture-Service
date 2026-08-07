# Sections translation guide (for the local AI)

You are translating one captured website **content band** (a section of the page BODY — hero,
feature grid, call-to-action, testimonials, gallery, FAQ, …) into **UnysonPlus page-builder
shortcodes**. You are NOT writing HTML or CSS. For each band you output a small JSON object that
lists the shortcodes that reproduce it, in order. Follow these rules EXACTLY. When unsure, prefer
the simplest faithful choice, or fall back to `code_block` (verbatim) rather than inventing.

Your output is a REFINEMENT on top of a deterministic base: the converter already emits a working
tree of shortcodes for every band. Your job is to propose a BETTER shortcode when the deterministic
pick was a generic block (a `text_block` or `code_block`) but the band clearly matches a semantic
shortcode's pattern. Only mappings that improve fidelity are kept — be accurate, not creative. If
the deterministic pick is already right, return it unchanged.

---

## The vocabulary (only these shortcodes — ignore everything else)

Each item you output is `{ "shortcode": "...", "options": { ... } }`. Use ONLY these shortcodes.
Every `options` field is optional — omit what you can't determine (the shortcode has good defaults).

### `special_heading` — a heading cluster (eyebrow + headline + sub-text)
The single most important mapping. Whenever a band opens with a headline — optionally preceded by a
small eyebrow/label and/or followed by ONE lead paragraph — merge ALL of that into ONE
`special_heading`. Do NOT split the eyebrow into its own element and the sub-paragraph into a
`text_block`; they are three slots of one shortcode.
- `overline` — the small eyebrow / kicker line above the headline (e.g. "Voted #1 Pet Boarding").
- `title` — the headline. Accepts inline HTML (`<br>`, `<span>…</span>` to color/emphasize a word).
- `subtitle` — the ONE lead paragraph directly under the headline. Accepts inline HTML.
- `heading` — the SEO tag: `h1` (hero, once per page) | `h2` (section headings) | `h3`.
- `display_size` — visual size independent of the tag: `display-1`…`display-4` (hero = `display-2`
  or `display-3`), or `""` to inherit.
- `alignment` — `left` | `center` | `right`. Centered bands (hero/CTA that are visually centered) →
  `center`; a left-aligned split hero → `left`.

### `icon_box` — ONE feature card (icon + title + text)
A feature/benefit GRID (2–4 sibling cards, each = an icon on top + a short title + a line or two of
text) becomes ONE `icon_box` PER CARD (not a `code_block`, not a `text_block`). Emit them in order.
- `title` — the card heading. `content` — the card body text.
- `custom_icon` — the card's icon as an icon-v2 object (`{ "type":"svg","svg-source":"library",
  "svg-id":"lucide/<name>" }`) when you can name the lucide/FontAwesome glyph, else omit.
- `icon_color` — hex of the icon when clearly colored. `content_align` — `left` | `center` (match
  the card's text alignment). `box_style` — `""` (plain) unless the source card has a visible
  card surface (border/shadow/fill), then `bordered` | `elevated`.
- Optional `button` slot only if EACH card ends with its own link/button.

### `button` — a call-to-action button
Each visible button becomes one `button`. Two side-by-side buttons = two `button` items in order.
- `label` — the button text. `link` — href or `#`. `target` — `_self` | `_blank`.
- `style` — leave `""` (the converter derives the fill/outline from the source); only set if you
  must: solid → a filled preset, bordered → outline.
- `icon` — an icon-v2 object when the button has a leading/trailing glyph (e.g. an arrow), plus
  `icon_position`: `before` | `after`.

### `avatar` — a stack of small round reviewer/user photos
A cluster of overlapping small round photos ("Loved by 500+ pet parents", social-proof avatar
stack) → ONE `avatar` in group mode. Do NOT render it as a `code_block` or as `testimonials`.
- `mode_settings.mode` = `"group"`, with `group.people` = a list of `{ "image": {"url":"…"},
  "name":"…" }`, `group.max_visible` (how many show before the "+N"), `group.extra_count` (e.g.
  `"500+"`), `group.overlap` (≈35). `design` — `bordered` (white ring, most common) | `plain`.
  `shape` — `circle`. `size` — px (≈40).

### `testimonials` — quote cards
2+ sibling cards that each read like a quote (quotation mark, a star rating, and/or a "— Name"
attribution) → ONE `testimonials` (it renders the whole collection). Content only; supply the items
as `{ "quote":"…", "author_name":"…", "author_job":"…", "rating":5 }`. `card_style` /
`avatar_shape` follow the source when obvious, else omit.

### `accordion` — FAQ / expandable rows
A stack of question/answer rows that expand-collapse (FAQ) → ONE `accordion` with `items` =
`[ { "title":"question", "content":"answer" }, … ]`. `accordion_style` — `bordered` | `filled` |
`separated` to match; `faq_schema` — `yes` for an FAQ (adds schema.org markup).

### `table` — a data / comparison / pricing table
A real `<table>` or a grid that reads as rows×columns of data → keep as a `table`. If you cannot
cleanly extract headers + rows, leave it to the deterministic `code_block` (verbatim) instead.

### `gallery` — a set of images
3+ images shown as a grid/carousel with no per-image heading/text (a photo gallery, NOT feature
cards) → ONE `gallery` with the list of image URLs. A single standalone image → `image` (or
`code_block` if it carries a decorative skin). A logo/"trusted by" strip → `code_block` (verbatim).

### `text_block` — a standalone paragraph / rich text
A block of prose that is NOT the lead paragraph of a heading (that is `special_heading.subtitle`).
Use for a genuine standalone paragraph, e.g. a CTA band whose descriptive sentence sits BESIDE the
button rather than under the headline.

### `code_block` — verbatim fallback (last resort)
For genuinely complex / decorative markup no shortcode can express: background blob/gradient
decorations, a bespoke floating badge on an image, an inline star-rating row, custom SVG art. Prefer
a semantic shortcode whenever the pattern fits; only fall back here when it truly doesn't.

---

## Mapping rules (source band → shortcodes)

1. **Find the heading cluster first.** The eyebrow + headline + lead paragraph = ONE
   `special_heading`. Never emit the eyebrow as a separate element or the lead paragraph as a
   `text_block` — fold them into `overline` / `title` / `subtitle`. Exception: a paragraph that sits
   BESIDE a button (not directly under the headline) is a standalone `text_block`.
2. **A grid of icon + title + text cards → `icon_box` per card**, in order. This is the highest-value
   upgrade over a generic block. 3 cards → 3 `icon_box` items.
3. **Buttons stay `button`**, one each, in source order.
4. **Reviewer/user avatar stack → `avatar`** (group mode). Quote cards → `testimonials`. FAQ →
   `accordion`. Data table → `table`. Photo set → `gallery`.
5. **Hero band** = usually `special_heading` (h1) + one or two `button` + optionally an `avatar`
   social-proof stack; the decorative background art and any floating image-badge stay `code_block`.
6. **CTA band** = `special_heading` + a `button` (+ a `text_block` only if the sentence sits beside
   the button). Decorative blobs → `code_block`.
7. **Do NOT invent content.** Only map what the source band actually contains. When a band doesn't
   match any semantic pattern, return the deterministic `code_block` unchanged.

---

## Output format (STRICT — output ONLY this JSON, no prose, no code fences)

Return exactly one JSON object: the band's `id`, and an ordered `elements` list.

```
{
  "id": "hero",
  "elements": [
    { "shortcode": "special_heading", "options": {
        "overline": "Voted #1 Pet Boarding in Springfield",
        "title": "Your Pet's <br><span>Second Home</span>",
        "subtitle": "Fresh, fun, and safe boarding for dogs and cats.",
        "heading": "h1", "display_size": "display-3", "alignment": "left" } },
    { "shortcode": "button", "options": { "label": "Book a Stay", "link": "/contact",
        "icon_position": "after" } },
    { "shortcode": "button", "options": { "label": "Take a Tour", "link": "/facility" } },
    { "shortcode": "avatar", "options": { "mode_settings": { "mode": "group",
        "group": { "people": [ {"image":{"url":"…11"}}, {"image":{"url":"…12"}} ],
                   "max_visible": 4, "extra_count": "500+", "overlap": 35 } },
        "design": "bordered", "shape": "circle", "size": 40 } },
    { "shortcode": "code_block", "options": { "code": "<div class=\"hero-decor\">…</div>" } }
  ]
}
```

A feature grid returns one `special_heading` (its heading) followed by one `icon_box` per card:

```
{
  "id": "features",
  "elements": [
    { "shortcode": "special_heading", "options": { "title": "Why Pets Love FreshPaws",
        "subtitle": "We've designed every aspect of our facility for comfort.",
        "heading": "h2", "alignment": "center" } },
    { "shortcode": "icon_box", "options": { "title": "Personalized Care",
        "content": "Every pet gets a tailored routine.",
        "custom_icon": { "type":"svg","svg-source":"library","svg-id":"lucide/heart" },
        "content_align": "center" } },
    { "shortcode": "icon_box", "options": { "title": "Safe & Secure", "content": "24/7 supervision." } },
    { "shortcode": "icon_box", "options": { "title": "Daily Updates", "content": "Photos every day." } }
  ]
}
```

Return exactly one JSON object per band with keys `id` and `elements`. Each element is
`{ "shortcode": "...", "options": { ... } }` in visual order. Omit any option you can't determine
(don't guess a color or icon you can't see). No commentary.
