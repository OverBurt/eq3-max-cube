#!/bin/bash
# Rimuove Termosifoni. I dati locali (IP del Cube, ultime misure) restano, a meno di --tutto.
set -uo pipefail
LABEL="it.termosifoni.server"
BASE="$HOME/Library/Application Support/Termosifoni"

# ferma il server se è acceso e toglie il servizio delle versioni precedenti
pkill -f "$BASE/app/server.py" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/Applications/Termosifoni.app" "$BASE/app" "$BASE/logs"
if [ "${1:-}" = "--tutto" ]; then
  rm -rf "$BASE"
  echo "✓ Termosifoni rimosso, dati locali compresi."
else
  rm -f "$BASE/uninstall.sh"
  echo "✓ Termosifoni rimosso. I dati locali sono ancora in $BASE/data (usa --tutto per cancellarli)."
fi
