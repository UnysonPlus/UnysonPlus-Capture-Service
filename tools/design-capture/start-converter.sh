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

# Optional: start Ollama for the Experimental local-AI tier, if installed. Non-fatal.
if command -v ollama >/dev/null 2>&1; then
  echo "Starting Ollama (local AI - Experimental)..."
  (ollama serve >/dev/null 2>&1 &)
fi

echo
echo "  Starting the UnysonPlus capture service..."
echo "  The dashboard opens automatically at  http://localhost:4600"
echo "  Keep this terminal open while you convert.  Press Ctrl+C to stop."
echo
node serve.mjs
