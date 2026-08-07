# Community benchmarks — maintainer setup

The dashboard's **Benchmarks** tab can (1) run the model benchmark with one click, (2) let a user
**share** their result to a Google Form you own, and (3) show a curated **Community results** table.
This doc is for the maintainer wiring up (2) and (3). It's a lightweight, manual curation loop — no
server, no database.

## 1. Create the Google Form

Create a Google Form (forms.google.com) with these fields (all short-answer text is fine):

| Field | Purpose |
|-------|---------|
| **Model** | e.g. `qwen3:8b`, `claude-code` |
| **Score** | 0–100 (the best score) |
| **Benchmark version** | the capture-service / benchmark version (`service_version`) |
| **Hardware** | free text, e.g. `16GB / RTX 3060` |
| **Seconds** | avg seconds per run |
| _(optional)_ **OS / notes** | anything else useful |

## 2. Get the prefilled `entry.XXXX` IDs

The dashboard opens a **pre-filled** form link so the user just reviews + submits. To get the field
IDs:

1. In the Form editor, open the **⋮ menu → Get pre-filled link**.
2. Type a placeholder value into every field, click **Get link**, and copy the generated URL.
3. It looks like:
   `https://docs.google.com/forms/d/e/FORM_ID/viewform?usp=pp_url&entry.111=Model&entry.222=Score&...`
4. Read off the `entry.NNNN` number that follows each field's placeholder value — that's the field's
   entry ID.

## 3. Paste them into `dashboard/index.html`

Near the top of the `<script>` in `dashboard/index.html`, fill in the `BENCHMARK_FORM` constant:

```js
const BENCHMARK_FORM = {
  url: 'https://docs.google.com/forms/d/e/FORM_ID/viewform',
  fields: {
    model:    'entry.111',
    score:    'entry.222',
    version:  'entry.333',
    hardware: 'entry.444',
    seconds:  'entry.555',
  },
};
```

Leave `url` empty (`''`) to keep sharing disabled — the **Share** button then shows a note pointing
back to this file instead of opening a form. Only model / score / version / hardware / seconds are
ever shared; **no site data** leaves the machine.

## 4. Curation loop (Form responses → shipped JSON)

Community results are **hand-curated** into `guides/community-benchmarks.json` so you control what
ships:

1. Open the Form's **Responses → View in Sheets** (or download CSV).
2. Aggregate per model (avg/best score, typical hardware, submission count) and append/merge entries
   into `guides/community-benchmarks.json`:

   ```json
   {
     "version": 1,
     "updated": "2026-08-06",
     "note": "Community-submitted benchmark scores, curated from the Google Form.",
     "results": [
       { "model": "qwen3:8b", "avg_score": 71, "best_score": 78, "hardware": "16GB / RTX 3060", "submissions": 4, "version": "1.8.40" }
     ]
   }
   ```

   The dashboard's Community table reads `model`, `avg_score` / `best_score`, `hardware`,
   `submissions`, and `version` (all optional — missing values render as `—`).
3. Bump `package.json` and ship. The file is already part of the `"guides"` npm `files` entry, so it
   travels with the package.

Keep it curated (dedupe, sanity-check scores) — the table is a community signal, not raw form dump.
