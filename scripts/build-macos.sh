#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
task_node="${OPEN_DECK_NODE:-$(command -v node)}"
task_app="$PWD/dist/Open Deck.app"
mkdir -p "$task_app/Contents/MacOS" "$task_app/Contents/Resources"
rm -rf "$task_app/Contents/Resources/host"
cp "$task_node" "$task_app/Contents/Resources/node"
cp -R host "$task_app/Contents/Resources/"
cp LICENSE "$task_app/Contents/Resources/OpenDeck-LICENSE"
cp assets/OpenDeck.icns "$task_app/Contents/Resources/OpenDeck.icns"
task_license="$(dirname "$(dirname "$task_node")")/LICENSE"
if [[ -f "$task_license" ]]; then cp "$task_license" "$task_app/Contents/Resources/Node-LICENSE"; else echo 'Node distribution LICENSE is required alongside bin/node' >&2; exit 1; fi
swiftc -O -target "$(uname -m)-apple-macosx13.0" -framework AppKit -framework WebKit macos/OpenDeck.swift -o "$task_app/Contents/MacOS/OpenDeck"
cat > "$task_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.opendeck.host</string><key>CFBundleIconFile</key><string>OpenDeck.icns</string><key>CFBundleName</key><string>Open Deck</string><key>CFBundleExecutable</key><string>OpenDeck</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>NSAppleEventsUsageDescription</key><string>Open Deck controls apps and Chrome tabs when you press your configured buttons.</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>
PLIST
codesign --force --sign - "$task_app/Contents/Resources/node"
codesign --force --deep --sign - "$task_app"
ditto -c -k --sequesterRsrc --keepParent "$task_app" dist/Open-Deck-macOS-arm64.zip
echo "Built: $task_app"
