#!/bin/bash
# Installa Termosifoni sul Mac:
#   - copia l'app in ~/Library/Application Support/Termosifoni
#   - avvia il server all'accesso (LaunchAgent, solo su 127.0.0.1)
#   - crea ~/Applications/Termosifoni.app con la sua icona
#
# Uso:  ./install.sh [IP_CUBE]        (senza IP il Cube viene cercato in rete)
#       ./install.sh --no-start      (installa i file senza avviare il servizio)
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
PORT=8765
LABEL="it.termosifoni.server"
BASE="$HOME/Library/Application Support/Termosifoni"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/Termosifoni.app"
PY=/usr/bin/python3

START=1; CUBE_IP=""
for a in "$@"; do
  case "$a" in
    --no-start) START=0 ;;
    *) CUBE_IP="$a" ;;
  esac
done

"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 9))' || { echo "Serve Python 3.9 o successivo ($PY)"; exit 1; }

echo "• Copio i file in $BASE"
mkdir -p "$BASE/app" "$BASE/data" "$BASE/logs"
rm -rf "$BASE/app/static"
cp "$SRC/server.py" "$BASE/app/"
cp -R "$SRC/static" "$BASE/app/static"
cp "$SRC/uninstall.sh" "$BASE/"
chmod +x "$BASE/uninstall.sh"

echo "• Creo il servizio di avvio automatico"
mkdir -p "$(dirname "$AGENT")"
ARGS="<string>$PY</string><string>$BASE/app/server.py</string>"
[ -n "$CUBE_IP" ] && ARGS="$ARGS<string>$CUBE_IP</string>"
ARGS="$ARGS<string>--port</string><string>$PORT</string><string>--data</string><string>$BASE/data</string>"
cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>$ARGS</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$BASE/logs/server.log</string>
  <key>StandardErrorPath</key><string>$BASE/logs/server.log</string>
</dict></plist>
EOF

echo "• Creo $APP"
rm -rf "$APP"
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
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF
cat > "$APP/Contents/MacOS/Termosifoni" <<EOF
#!/bin/bash
# Si assicura che il server sia acceso e apre il pannello in una finestra dedicata.
URL="http://127.0.0.1:$PORT/"
if ! curl -fsS -m 2 "\${URL}api/state" >/dev/null 2>&1; then
  launchctl kickstart "gui/\$(id -u)/$LABEL" >/dev/null 2>&1 || true
  for i in \$(seq 1 20); do curl -fsS -m 1 "\${URL}api/state" >/dev/null 2>&1 && break; sleep 0.5; done
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

if [ "$START" = 1 ]; then
  echo "• Avvio il servizio"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$AGENT"
  for i in $(seq 1 20); do curl -fsS -m 1 "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1 && break; sleep 0.5; done
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then
    echo "✓ Fatto. Apri Termosifoni da ~/Applications o da Spotlight."
  else
    echo "! Il servizio non risponde: guarda $BASE/logs/server.log"
  fi
else
  echo "✓ File installati (servizio non avviato)."
fi
echo "  Per disinstallare: \"$BASE/uninstall.sh\""
