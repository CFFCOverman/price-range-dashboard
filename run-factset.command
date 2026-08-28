#!/bin/sh
set -u

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FETCHER_DIR="$ROOT_DIR/fetcher"

printf '\033]0;Price Range Dashboard - FactSet fetch\007'
cd "$FETCHER_DIR" || {
  echo "[ERROR] Could not find the fetcher folder next to this file."
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js was not found. Install the LTS release from https://nodejs.org"
  echo "        or run: brew install node"
  printf "Press Return to close... "
  read -r _answer
  exit 1
fi

if ! node preflight.mjs deps; then
  echo "[setup] Installing locked fetcher dependencies..."
  npm ci || exit 1
fi

if ! node preflight.mjs chrome; then
  echo "[setup] Registering Google Chrome for Playwright..."
  npx playwright install chrome || exit 1
fi

echo
echo "[note] First login: ./run-factset.command --login"
echo
node factset-fetch.mjs "$@"
RC=$?

echo
if [ "$RC" -eq 0 ]; then
  echo "Data -> Assets/    Logs -> Assets/_logs/"
else
  echo "[ERROR] FactSet fetch failed (exit code $RC)."
fi
printf "Press Return to close... "
read -r _answer
exit "$RC"
