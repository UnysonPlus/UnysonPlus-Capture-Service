# Converter dashboard — the tool's live front-end

A local, dependency-free web UI for the deterministic site converter. Paste a URL, watch every
pipeline stage run in real time, then inspect the captured design tokens (with their provenance),
the per-section conversion report, and a source-vs-result comparison.

## Run

```
node dashboard/server.mjs            # → http://localhost:4600, watches D:/Web Dev/capture-out
node dashboard/server.mjs --out <capture-out-dir> --port 4600
```

Open `http://localhost:<port>`. Paste a URL and hit **Convert** to start a fresh conversion (the
server spawns `capture.mjs`), or click a past run under **Recent conversions**.

## How it works

- `capture.mjs` writes a live log as it runs: **`<outdir>/progress.jsonl`** (one line per step) and
  **`<outdir>/progress.json`** (`{status, steps[], summary}`), plus a `<capture-out>/_active.json`
  pointer to the site currently converting. The dashboard polls these while a run is in flight.
- The server (`server.mjs`) is a tiny Node HTTP server: it serves the SPA, lists conversions, parses
  `conversion-report.csv` → JSON, serves `design-config.json` (tokens) + the screenshots, and exposes
  `POST /api/convert {url}` to launch a run.
- The UI (`index.html`) is a single self-contained file (inline CSS/JS, no build step).

## Why

So a human can see exactly which stage + tool is running and **where every captured value came from**
(e.g. "heading font sampled from an `<h1>`, not the logo"; "container = the largest max-width across
breakpoints, i.e. the design max") instead of trusting a silent CLI or guessing after the fact.
