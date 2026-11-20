#!/bin/bash
# Installa Termosifoni sul Mac:
#   - copia l'app in ~/Library/Application Support/Termosifoni
#   - crea Termosifoni.app in /Applications (o ~/Applications) con la sua icona
#
# Nessun servizio in background: aprendo Termosifoni.app parte il server,
# che si spegne da solo 3 minuti dopo la chiusura del pannello.
#
# Uso:  ./install.sh [IP_CUBE]        (senza IP il Cube viene cercato in rete)
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
PORT=8765
IDLE=180
OLD_LABEL="it.termosifoni.server"            # servizio delle versioni precedenti
BASE="$HOME/Library/Application Support/Termosifoni"
# /Applications se scrivibile (compare in Finder e Launchpad), altrimenti ~/Applications
if [ -w /Applications ]; then APP="/Applications/Termosifoni.app"; else APP="$HOME/Applications/Termosifoni.app"; fi
PY=/usr/bin/python3
CUBE_IP="${1:-}"

"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 9))' || { echo "Serve Python 3.9 o successivo ($PY)"; exit 1; }

# versioni precedenti: toglie il servizio sempre attivo
if [ -f "$HOME/Library/LaunchAgents/$OLD_LABEL.plist" ]; then
  echo "• Rimuovo il vecchio servizio in background"
  launchctl bootout "gui/$(id -u)/$OLD_LABEL" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/LaunchAgents/$OLD_LABEL.plist"
fi
# un server già acceso con la versione vecchia va fermato prima di aggiornare i file
pkill -f "$BASE/app/server.py" >/dev/null 2>&1 || true

echo "• Copio i file in $BASE"
mkdir -p "$BASE/app" "$BASE/data" "$BASE/logs"
rm -rf "$BASE/app/static"
cp "$SRC/server.py" "$BASE/app/"
cp -R "$SRC/static" "$BASE/app/static"
cp "$SRC/uninstall.sh" "$BASE/"
chmod +x "$BASE/uninstall.sh"

echo "• Creo $APP"
rm -rf "$APP"
# toglie la copia in ~/Applications delle versioni precedenti
[ "$APP" != "$HOME/Applications/Termosifoni.app" ] && rm -rf "$HOME/Applications/Termosifoni.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Termosifoni</string>
  <key>CFBundleDisplayName</key><string>Termosifoni</string>
  <key>CFBundleIdentifier</key><string>it.termosifoni.app</string>
  <key>CFBundleExecutable</key><string>Termosifoni</string>
  <key>CFBundleIconFile</key><string>Termosifoni</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.1</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF
cat > "$APP/Contents/MacOS/Termosifoni" <<EOF
#!/bin/bash
# Avvia il server se non è già acceso e apre il pannello in una finestra dedicata.
# Il server si spegne da solo $IDLE secondi dopo la chiusura del pannello.
BASE="$BASE"
URL="http://127.0.0.1:$PORT/"
up() { curl -fsS -m 1 "\${URL}api/ping" >/dev/null 2>&1; }
if ! up; then
  nohup "$PY" "\$BASE/app/server.py" $CUBE_IP --port $PORT --data "\$BASE/data" --idle-exit $IDLE \\
    >>"\$BASE/logs/server.log" 2>&1 </dev/null &
  for i in \$(seq 1 40); do up && break; sleep 0.25; done
fi
for b in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if open -Ra "\$b" >/dev/null 2>&1; then exec open -na "\$b" --args --app="\$URL"; fi
done
exec open "\$URL"
EOF
chmod +x "$APP/Contents/MacOS/Termosifoni"

# icona .icns dall'SVG
TMP="$(mktemp -d)"; SET="$TMP/Termosifoni.iconset"; mkdir "$SET"
sips -s format png "$SRC/static/icon.svg" --resampleWidth 1024 --out "$TMP/1024.png" >/dev/null
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/1024.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d "$TMP/1024.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/Termosifoni.icns"
rm -rf "$TMP"
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

echo "✓ Fatto. Apri Termosifoni da $(dirname "$APP"), dal Launchpad o da Spotlight."
echo "  Al primo avvio macOS potrebbe chiedere l'accesso alla rete locale: serve per parlare con il Cube."
echo "  Per disinstallare: \"$BASE/uninstall.sh\""
