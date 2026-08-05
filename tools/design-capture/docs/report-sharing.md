# Sharing conversion reports upstream (opt-in)

The Site Converter gets smarter from real-world failures. Every capture already writes a
**conversion report** (`conversion-report.csv/html`) tracing each source element → the shortcode it
became, flagging `fallback` (code_block catch-alls), `opportunity`, `styling-drop`, and
over-large/under-segmented sections. This page explains how a developer can **optionally** send an
**anonymized** version of that report upstream so the whole community's converter improves.

## What is (and isn't) sent

`--share` sends a single **structural-only** JSON (`share-report.json`). It contains:

- **Kept:** element roles, detected/mapped shortcode, the `fallback`/`opportunity`/`styling-drop`
  flags, source tag names, **class tokens** (e.g. `py-32 grid min-h-screen` — arbitrary bracket
  values that could embed content are redacted to `[…]`), computed-style **property names**
  (border/shadow/…), section counts + heights, and the converter version.
- **Never sent:** the source **URL/host** (only a salted one-way **hash**, so the same site dedupes
  without being revealed), **content text**, **images**, **links/hrefs**, inline style *values*,
  screenshots, or anything resembling PII.

It is **opt-in and per-run**: nothing is built or sent unless you pass a flag.

```
node capture.mjs <url>                     # normal run — NOTHING shared
node capture.mjs <url> --share-preview     # ALSO writes share-report.json so you can INSPECT it (no send)
node capture.mjs <url> --share             # writes it AND submits it upstream (implies --share-preview)
node capture.mjs <url> --share --findings=share-findings.json   # ALSO attach your got-vs-expected diagnosis
```

## Attach your got-vs-expected diagnosis (`share-findings.json`)

The auto report carries only what the converter **did**. Your judgment of what it **should** have done —
and any **confident-but-wrong** mapping (one with no `fallback`/`opportunity` flag, so the row looks clean)
— is the highest-value signal and has to be added by you. Write a **`share-findings.json`** next to the
capture: a JSON **array** of

```json
[ { "ref": "s2:heading h2", "got": "code_block", "expected": "special_heading",
    "note": "faq accordion mapped to plain columns", "systematic": true,
    "solution": "recognizer: a <details>/<summary> or role=region list of Q/A → n_accordion(); each summary→item title, panel→content" } ]
```

`ref` = section/element, `got` = what it produced, `expected` = the correct shortcode/option/token, `note`
≤120 chars **structural only** (auto-redacted of URLs/emails/quoted content).

- **`solution` (optional) — a fix SKETCH for the maintainer to REVIEW, never auto-applied.** For a
  **reusable** pattern only, attach the *approach* you'd take — a recognizer sketch, or the child-theme
  shortcode you wrote — so the maintainer can promote it into the converter. It's your OWN code, not source
  content; still capped at ~2000 chars + URL/email-redacted. Omit it for one-offs. **Outside agents never
  edit the converter** — this is a suggestion the maintainer reviews, not a patch that lands.

`--share` looks for the file at `--findings=<path>`, else `share-findings.json` in the site's out-dir /
base-outdir / cwd, sanitizes it into the payload, and adds an `N agent-findings` count to the summary.
`aggregate-reports.mjs` marks solution-bearing findings with **✎** and prints their sketches under
*"Proposed solutions (REVIEW, never auto-apply)."*

## Streaming mode — ask once, then send each bug immediately (`send-finding.mjs`)

The default cadence is **ask once → auto-send each finding with a notification**. Each send is a **lean**
`{ hostHash, converterVersion, one finding }` (a few hundred bytes — a bug-heavy site never nears the 50k
Sheets-cell limit), throttled to ≥1s apart, and it prints a concise line so the user sees what went out:

```
node send-finding.mjs --url=<src> --finding='{"ref":"s2:heading h2","got":"code_block",
                      "expected":"special_heading","note":"faq accordion mapped to plain cols","systematic":true}'
node send-finding.mjs --url=<src> --summary --stats=capture-out/<site>/design-config.json   # once-per-site aggregate
```

- **`--summary`** sends a stats-only aggregate once per site, so the "what's commonly missed across sites"
  signal survives without repeating the full report per bug.
- Same sanitizer as `--share` (structural only; the `note` is auto-redacted). The Google Form is unchanged
  — every payload rides the existing `payload` field; only the JSON's `kind` differs (`finding`/`summary`/
  full report).

## Consent cadence — ask ONCE; then stream + notify; a **no** is final

**Frame it as an improvement, not a "bug".** What you found is a *place the converter could translate
better*, not a defect — and it improves the **Site Converter** (the tool), not the Dev Kit (the docs).

- **Ask exactly once, upfront** — warm but HONEST (positive framing must not drop *what is sent*):
  > *"As I rebuild this site I'll sometimes spot places the **Site Converter** could translate better.
  > Want me to send those upstream to help it improve? It's **anonymized and structural only — no page
  > content, no URL**. I'll show you each one as it goes, and it's totally fine to say no."*

  A **yes** authorizes streaming for the WHOLE site — never ask per item (consent-fatigue / a dark pattern).
  A **no** is final for that site; never re-prompt.
- **Notify concisely each time — an improvement, not a bug** —
  `⚑ Converter improvement reported: heading → special_heading (it had fallen back to a code block)` — plus a
  one-line tally at the end. Transparency is what makes the single upfront yes an *informed* one.
- **Consent is the site owner's** → it does not carry to a *different* site; a new site = ask once again.
- **Batch alternative:** collect findings into one `share-findings.json` and run `--share` to send it all at
  the end instead. Same consent rules.

Always get the **site owner's consent** before sharing a report for a site you built for a client.

## One-time setup — create the Google Form (maintainer)

The submission target is a normal Google Form backed by a Sheet, so there's **no server to host** and
**submitters need no Google account**.

1. Create a Google Form (e.g. "UnysonPlus Converter Reports"). Add **two** questions, both
   **"Paragraph"** (long answer) type:
   - **Q1 — "payload"** (the JSON). Make it **not required** to avoid validation edge cases.
   - **Q2 — "summary"** (a short human line). Also not required.
2. Link it to a Sheet (**Responses → Link to Sheets**) and turn on
   **Responses → ⋮ → Get email notifications for new responses** so `unysonplus@gmail.com` is pinged.
3. Get the **`responseUrl`** and the two **field entry ids**:
   - **responseUrl:** open the live form, **View source**, find the `<form action="…/formResponse">` —
     that action URL is your `responseUrl` (`https://docs.google.com/forms/d/e/<FORM_ID>/formResponse`;
     a `/u/0/` account-index segment is harmless, keep or drop it).
   - **entry ids (easiest — the pre-filled link, NOT view-source):** in the Form **editor**, top-right
     **⋮ (More) → "Get pre-filled link"**, type a recognizable dummy in each field (e.g. `PAYLOAD_HERE`
     in Q1, `SUMMARY_HERE` in Q2), click **"Get link" → "COPY LINK"**. The copied URL contains
     `…&entry.<number>=PAYLOAD_HERE&entry.<number>=SUMMARY_HERE` — the number before `=PAYLOAD_HERE` is
     the **payload** id, the one before `=SUMMARY_HERE` is **summary**.
4. Copy `share-config.example.json` → **`share-config.json`** (gitignored) and fill it in:

   ```json
   {
     "email": "unysonplus@gmail.com",
     "form": {
       "responseUrl": "https://docs.google.com/forms/d/e/<FORM_ID>/formResponse",
       "fields": { "payload": "entry.<Q1_ID>", "summary": "entry.<Q2_ID>" }
     }
   }
   ```

5. Test: `node capture.mjs <some-url> --share` → the console should print
   **"submitted upstream via Google Form ✓"** and a row should appear in the Sheet.

Distribute `share-config.json` to trusted contributors however you like (it holds only public form
ids, no secrets). Developers without it still get the **mailto:** fallback on `--share`.

## No form yet? The mailto fallback

Until `share-config.json` has a form, `--share` writes `share-report.json` and prints a **mailto:**
draft to `unysonplus@gmail.com`; the developer sends it from their **own** email and attaches the
JSON. (Never embed the Gmail password/app-password in the tool — the inbox only ever **receives**.)

## Future upgrade — a hosted endpoint

When real (PHP/Node) hosting is available, swap the Form for a small endpoint that lands in the same
inbox: point `form.responseUrl` at it (or add an `endpoint` field) — the tool-side change is trivial,
and the sanitizer/consent flow above is unchanged. GitHub Pages can't be it (static, can't receive a
POST).

## Maintainer side — turning reports into fixes (`aggregate-reports.mjs`)

The Sheet is the **append-only source of truth** — never edit or delete rows to "clear" them. Instead,
`aggregate-reports.mjs` reads the responses, **dedupes what it has already processed** (a local
content-fingerprint watermark — deletion-safe, no Sheet writes), and **ranks the systematic failures** so
you know what to fix next.

**LIVE PULL — no copy-paste (recommended).** Publish the responses Sheet once (File → Share → **Publish to
web → Comma-separated values (.csv)**, keep **"Automatically republish when changes are made"** ON), then
point the aggregator at that URL — it fetches the current CSV directly (a script `fetch` follows Google's
307 redirect automatically):

```
node aggregate-reports.mjs --url "<published-csv-url>"          # live pull; ranks only NEW reports (dry run)
node aggregate-reports.mjs --url "<published-csv-url>" --all     # re-rank everything (ignore watermark)
node aggregate-reports.mjs --url "<published-csv-url>" --commit  # AFTER acting on the list: mark processed
node aggregate-reports.mjs --csv responses.csv                   # alt: a CSV you downloaded (File → Download → CSV)
```

> **This project's form** (intake `unysonplus@gmail.com`) is already published as CSV:
> `https://docs.google.com/spreadsheets/d/e/2PACX-1vT4LeyA2-kTnr2wi9c8u0czetG3JlBg5LmnRK9HAMBw3carIShkG-e7k51nZkzbL9XwoLe_wDCXh2CO/pub?output=csv`
> The maintainer's agent can also just **WebFetch that URL** and analyze it inline — no export, no local file.

It writes **`reports-todo.md`** with two ranked tables: (1) recurring `(role · detected · srcTag ·
class-token)` patterns that became a `fallback`/`opportunity`, ranked by **how many distinct sites** hit
each; and (2) — leading in practice — the **agent findings** `got → expected` (from `share-findings.json`
batches AND streamed `kind:'finding'` payloads), which carry the CORRECT target and are the only way a
**confident-but-wrong** mapping surfaces. That ranking IS the converter's to-do.

The loop: `aggregate-reports.mjs --url` → pick the top pattern(s)/finding(s) → improve the converter
(mirror every change to **both** paths: JS `to-pages.mjs`/`capture-extract.mjs` AND PHP
`class-fw-site-converter-mapper.php`/`-stitch.php`, per the workspace `CLAUDE.md`) → `--commit` to mark
those reports processed so the next run only surfaces newer ones. No row is ever deleted; the watermark
(`.reports-watermark.json`, gitignored) is what advances.
