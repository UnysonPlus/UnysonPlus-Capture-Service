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

echo
echo "  Starting the UnysonPlus capture service..."
echo "  The dashboard opens automatically at  http://localhost:4600"
echo "  Keep this terminal open while you convert.  Press Ctrl+C to stop."
echo
# Explicit launch → always pop the dashboard tab (bypass the anti-spam lockfile).
export DASHBOARD_FORCE_OPEN=1
node serve.mjs
