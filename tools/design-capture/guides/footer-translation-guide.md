# Footer translation guide (for the local AI)

You are translating a captured website **footer** into **UnysonPlus Footer Theme Settings** — the
native, editable footer model — so the site no longer needs a baked static footer template. You do
NOT write HTML or CSS. You output a small JSON object mapping the source footer into the settings
below. Follow these rules EXACTLY. When unsure, prefer the simplest faithful choice.

Your output is judged by how faithfully the rebuilt footer matches the source screenshot; only
accurate mappings are kept — so map what you can SEE, do not invent.

---

## The footer is FOUR stacked bars, top → bottom
`pre` → `main` → `post` → `copyright`. **Order is sacred** — bars always render in that order, so
assign the source's bands (full-width horizontal strips) to preserve top-to-bottom order.

- **main** = the primary content band — the biggest multi-column grid (logo + link columns). MOST
  footers only need `main` + `copyright`.
- **copyright** = the LAST band (the © line / legal links). ALWAYS its own bar.
- **pre** = a band ABOVE the main grid (e.g. a newsletter/CTA strip). Usually null.
- **post** = a secondary band BELOW the main grid but above © (e.g. app badges, language row). Usually null.

Set a bar to `null` if the source has no band for it.

## Each bar is a list of COLUMNS; each column is an ordered list of ELEMENTS
Element `{ "type": ..., ...fields }` — use ONLY these types:
- `logo` — the footer logo/brandmark. No fields.
- `text` — a paragraph / tagline / address block / © line. Field: `"content"` (plain text; you may use `{{current_year}}` for a year).
- `heading` — a column title like "Quick Links", "Services", "Contact Info". Field: `"text"`.
- `menu` — a list of links. Field: `"links": [ {"text":"Home","href":"/"}, … ]`.
- `social_icons` — a row of social links (facebook/instagram/twitter/…). No fields (the icons are auto-detected).
- `icon_text` — an icon + short text (address/phone/email line). Fields: `"text"`, `"icon"` (e.g. `map-pin`,`phone`,`mail` or ""), `"link"` ("tel:…","mailto:…", url, or "").

A typical footer link column = a `heading` element followed by a `menu` element (or `icon_text` items for a contact column).

## Column ratio vs. auto-width
- If the source columns look like **content-hugging lists spread with space-between** (a wider brand block on the left, then narrow link lists) → set the bar's `"auto_width": true` and `"justify": "between"`.
- Otherwise leave `auto_width` false (equal columns).

## Colors (whole footer)
- `"background"`: the footer's background color as a hex (e.g. `#293d36` for a dark footer), or `""` if it has none.
- `"text_color"`: hex of the general footer text.
- `"link_color"`: hex of the footer links.

---

## Mapping rules (source → settings)
1. **Find the bands.** Most footers = one big multi-column grid + a © bar below it. That's `main` + `copyright`.
2. **Main grid → `main.columns`.** Each visual column of the grid becomes one column. The brand column (logo + description + social) usually leads, then link columns (each a `heading` + `menu`), then a contact column (`heading` + `icon_text` items). Preserve their left-to-right order.
3. **Copyright bar → `copyright.columns`.** The © line is a `text` element. If legal links (Privacy/Terms) sit on the opposite side, that's a 2nd column with a `menu`. (1 col = centered, 2 cols = left/right.)
4. **Colors** from the footer's computed styles (dark bg + light text is the common case).
5. **Do NOT** invent bands, columns, or elements the source doesn't have. No duplicate logo.

---

## Output format (STRICT — output ONLY this JSON, no prose, no code fences)

```
{
  "background": "#293d36",
  "text_color": "#ffffff",
  "link_color": "#a7f3d0",
  "bars": {
    "pre": null,
    "main": {
      "auto_width": true,
      "justify": "between",
      "columns": [
        { "elements": [ {"type":"logo"}, {"type":"text","content":"Your pet's favorite home away from home."}, {"type":"social_icons"} ] },
        { "elements": [ {"type":"heading","text":"Quick Links"}, {"type":"menu","links":[{"text":"Home","href":"/"},{"text":"Our Services","href":"/services"}]} ] },
        { "elements": [ {"type":"heading","text":"Services"}, {"type":"menu","links":[{"text":"Dog Boarding","href":"#"},{"text":"Cat Boarding","href":"#"}]} ] },
        { "elements": [ {"type":"heading","text":"Contact Info"}, {"type":"icon_text","icon":"map-pin","text":"123 Fresh Meadow Lane","link":""}, {"type":"icon_text","icon":"phone","text":"(555) 123-4567","link":"tel:5551234567"} ] }
      ]
    },
    "post": null,
    "copyright": {
      "columns": [
        { "elements": [ {"type":"text","content":"© {{current_year}} FreshPaws Pet Boarding. All rights reserved."} ] },
        { "elements": [ {"type":"menu","links":[{"text":"Privacy Policy","href":"#"},{"text":"Terms of Service","href":"#"}]} ] }
      ]
    }
  }
}
```

Return exactly one JSON object with keys `background`, `text_color`, `link_color`, and `bars`
(`bars` has `pre`,`main`,`post`,`copyright` — any of pre/main/post/copyright may be `null`). Omit a
field you can't determine. No commentary.
