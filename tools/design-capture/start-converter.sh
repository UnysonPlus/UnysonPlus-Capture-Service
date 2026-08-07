#!/usr/bin/env bash
# ============================================================================
#  UnysonPlus Converter - one-click launcher (macOS / Linux)
#  Starts the capture service + dashboard (http://localhost:4600 opens
#  automatically), plus Ollama if installed (Experimental local-AI tier).
#  macOS: rename to start-converter.command and `chmod +x` to double-click it.
# ============================================================================
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed or not on PATH."
  echo "  Install Node 20+ from https://nodejs.org/ then run this again."
  echo
  read -r -p "Press Enter to close..." _
  exit 1
fi

if [ ! -d node_modules/playwright-core ]; then
  echo "First run - installing dependencies (npm install), this happens once..."
  npm install
fi

# Optional: start Ollama for the local-AI tier. Prefer a PATH install; else fall back to the BUNDLED
# portable ollama shipped in the assembled kit (probe a few candidate relative paths). Non-fatal — never
# blocks the service. Only when using the BUNDLED exe do we point OLLAMA_MODELS at the kit's models dir
# beside it (matching the top-level kit launcher); a system install keeps its own default store.
OLLAMA_BIN=""
if command -v ollama >/dev/null 2>&1; then
  OLLAMA_BIN="ollama"
else
  for c in "../../ollama/ollama" "../../../ollama/ollama" "../../../../ollama/ollama"; do
    if [ -x "$c" ]; then OLLAMA_BIN="$c"; break; fi
  done
fi
if [ -n "$OLLAMA_BIN" ]; then
  echo "Starting Ollama (local AI)..."
  if [ "$OLLAMA_BIN" != "ollama" ]; then
    d=$(dirname "$OLLAMA_BIN"); mkdir -p "$d/models" 2>/dev/null || true; export OLLAMA_MODELS="$d/models"
  fi
  ("$OLLAMA_BIN" serve >/dev/null 2>&1 &)
fi

# Free port 8787 (capture service) from any previous run, so THIS launch rebinds it. We do NOT kill 4600
# (dashboard): ensure-open.mjs reuses a current dashboard SERVER (no needless restart) and only restarts
# it when its code is stale — but it always opens a fresh browser tab on launch (below).
for p in 8787; do
  pids=$(lsof -ti tcp:"$p" 2>/dev/null) || pids=""
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
done

# Always pop the dashboard open when the converter is STARTED — a fresh tab every launch (even a
# duplicate) beats silently none when the previous tab was closed. Mid-conversion auto-opens stay quiet.
export DASHBOARD_FORCE_OPEN=1

echo
echo "  Starting the UnysonPlus capture service..."
echo "  The dashboard is at  http://localhost:4600  (a browser tab opens automatically)"
echo "  Keep this terminal open while you convert.  Press Ctrl+C to stop."
echo
node serve.mjs
