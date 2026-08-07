# Header translation guide (for the local AI)

You are translating a captured website **header** into **UnysonPlus Header Theme Settings** — the
native, editable header model. You are NOT writing HTML or CSS. You output a small JSON object that
maps the source header into these settings. Follow these rules EXACTLY. When unsure, prefer the
simplest faithful choice and leave a field empty (the theme has good defaults).

Your output is judged by how faithfully the rebuilt header matches the source screenshot. Only
mappings that improve fidelity are kept — so be accurate, not creative.

---

## The target model (only these fields — ignore everything else)

A header is three horizontal ZONES (left / center / right), each holding an ordered list of ELEMENTS,
plus a few layout + color settings. Put each source element in the zone matching its horizontal
position in the source.

### Elements (put in a zone's list). Each is `{ "type": "...", ...fields }`:
- `logo` — the site logo. No extra fields here (its details go in `identity`, below). Usually LEFT.
- `menu_area` — the primary navigation menu. Field: `"menu": "primary"`. Usually CENTER or RIGHT.
- `cta_button` — a prominent button (e.g. "Book a Stay", "Get Started", "Contact Us"). Fields:
  `"text"` (button label from the source), `"link"` (href or "#"), `"style"`: one of
  `filled` | `outline` | `pill` (match the source: solid fill → `filled`; bordered → `outline`;
  fully-rounded → `pill`). Usually RIGHT.
- `icon_text` — an icon next to a short text (e.g. a phone number with a phone icon, "Call us").
  Fields: `"text"`, `"icon"` (short name like `phone`,`mail`,`map-pin` if identifiable else ""),
  `"link"` ("tel:…", "mailto:…", or url).
- `social_icons` — a row of social links (facebook/instagram/twitter/…). No extra fields.
- `search` — a search icon/box. No extra fields.

Only use these element types. If the source has something else, drop it (don't invent a type).

### `layout` object:
- `"mode"`: almost always `"top"` (standard horizontal bar). Only use `"vertical"` if the source
  nav is a fixed SIDE rail, or `"overlay"` if clicking a hamburger opens a FULLSCREEN menu.
- `"design"`: `classic` (normal bar, default) | `pill` (header floats as a rounded pill) |
  `card` (elevated rounded card) | `centered` (logo centered above the menu). Match the source.
- `"behavior"`: `static` (default) | `sticky` (stays on scroll) | `sticky-shrink` (stays + shrinks) |
  `hide-on-scroll` | `transparent-overlay` (transparent over the hero, gets a solid bg on scroll).
  **Rule:** if the capture reports the header background CHANGES on scroll (e.g. transparent →
  solid/white), use `transparent-overlay`. If it just stays fixed, use `sticky`.
- `"container"`: `container` (fixed centered width, default) | `container-fluid` (full width).
- `"bg_color"`: the header's background color as a hex (e.g. `#ffffff`) or `""` for transparent.
  If behavior is `transparent-overlay`, this is the SCROLLED (solid) background.

### `identity` object (the logo):
- `"logo_type"`: `simple` (the logo is a single image/graphic) | `custom` (an ICON + TEXT wordmark,
  like a paw icon next to the word "FreshPaws").
- If `custom`: `"site_title"` (the brand text from the source), `"layout"`: `inline-left`
  (icon left of text, most common) | `inline-right` | `icon-only` | `stacked-left`, and
  `"title_color"` (hex of the brand text) + `"icon_color"` (hex of the icon) when clearly colored.
- If `simple`: no extra fields (the image is handled separately).

### `menu` object (nav link styling — fill from the source's nav links):
- `"link_color"` (hex of a normal nav link), `"link_hover_color"` (hex of the hover/active color if
  known, else ""), `"item_style"`: `none` (default) | `underline` | `pill` | `box` | `highlight`
  (match how the source shows the active/hover item), `"uppercase"`: true/false.

---

## Mapping rules (source → settings)

1. **Read the source header markup + the per-element computed styles provided.** Identify: the logo
   (image vs icon+text), the nav menu links, any prominent button(s), phone/email icon-text, social
   icons, search.
2. **Zones by position.** Left-most cluster → `left`; a centered menu → `center`; right-aligned
   button/menu → `right`. A very common pattern is: logo LEFT, menu CENTER or RIGHT, CTA button RIGHT.
3. **Logo.** Icon + brand word (SVG/emoji + text) ⇒ `identity.logo_type = "custom"`, `layout =
   "inline-left"`, `site_title` = the brand word, colors from the computed styles. A single logo
   image ⇒ `logo_type = "simple"`.
4. **CTA button.** The most visually prominent header button (filled/rounded, stands out) ⇒
   `cta_button` with its exact `text`. A pill (fully rounded) ⇒ `style:"pill"`; solid ⇒ `filled`;
   outlined ⇒ `outline`.
5. **Behavior/colors** per the rules above — use the capture's scroll-state info when present.
6. **Do NOT duplicate.** One `menu_area`, one logo. Don't add elements the source doesn't have.

---

## Output format (STRICT — output ONLY this JSON, no prose, no code fences)

```
{
  "left":   [ {"type":"logo"} ],
  "center": [ {"type":"menu_area","menu":"primary"} ],
  "right":  [ {"type":"cta_button","text":"Book a Stay","link":"#","style":"pill"} ],
  "layout": { "mode":"top", "design":"classic", "behavior":"transparent-overlay",
              "container":"container", "bg_color":"#ffffff" },
  "identity": { "logo_type":"custom", "site_title":"FreshPaws", "layout":"inline-left",
                "title_color":"#1a3c34", "icon_color":"#16a34a" },
  "menu": { "link_color":"#1a3c34", "link_hover_color":"#16a34a",
            "item_style":"none", "uppercase":false }
}
```

Return exactly one JSON object with those top-level keys (`left`, `center`, `right`, `layout`,
`identity`, `menu`). Omit a zone by giving it `[]`. Omit any field you can't determine (don't guess a
color you can't see). No commentary.
