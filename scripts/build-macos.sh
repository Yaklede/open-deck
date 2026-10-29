#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
task_node="${OPEN_DECK_NODE:-$(command -v node)}"
task_app="$PWD/dist/Open Deck.app"
mkdir -p "$task_app/Contents/MacOS" "$task_app/Contents/Resources"
rm -rf "$task_app/Contents/Resources/host"
cp "$task_node" "$task_app/Contents/Resources/node"
cp -R host "$task_app/Contents/Resources/"
"$task_node" --input-type=module -e 'import fs from "node:fs"; import {execFileSync} from "node:child_process"; const version=JSON.parse(fs.readFileSync("package.json")).version; const commit=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(); fs.writeFileSync(process.argv[1],JSON.stringify({version,build:26,commit}));' "$task_app/Contents/Resources/host/build-info.json"
mkdir -p "$task_app/Contents/Resources/node_modules"
rm -rf "$task_app/Contents/Resources/node_modules/ws"
cp -R node_modules/ws "$task_app/Contents/Resources/node_modules/"
cp LICENSE "$task_app/Contents/Resources/OpenDeck-LICENSE"
cp -R docs/licenses "$task_app/Contents/Resources/ThirdParty-Licenses"
cp assets/OpenDeck.icns "$task_app/Contents/Resources/OpenDeck.icns"
task_license="$(dirname "$(dirname "$task_node")")/LICENSE"
if [[ -f "$task_license" ]]; then cp "$task_license" "$task_app/Contents/Resources/Node-LICENSE"; else echo 'Node distribution LICENSE is required alongside bin/node' >&2; exit 1; fi
swiftc -O -target "$(uname -m)-apple-macosx13.0" -framework AppKit -framework WebKit -framework Security macos/OpenDeck.swift macos/MacFanAccess.swift -o "$task_app/Contents/MacOS/OpenDeck"
cat > "$task_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.opendeck.host</string><key>CFBundleIconFile</key><string>OpenDeck.icns</string><key>CFBundleName</key><string>Open Deck</string><key>CFBundleExecutable</key><string>OpenDeck</string><key>CFBundleVersion</key><string>26</string><key>CFBundleShortVersionString</key><string>0.14.1</string><key>NSAppleEventsUsageDescription</key><string>Open Deck controls apps and Chrome tabs when you press your configured buttons.</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>
PLIST
bash scripts/build-mac-controls.sh "$task_app"
"$task_node" --input-type=module - "$task_app/Contents/Info.plist" <<'JS'
import fs from 'node:fs';
const file=process.argv[2];
fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('</dict></plist>','<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>Open Deck</string><key>CFBundleURLSchemes</key><array><string>opendeck</string></array></dict></array></dict></plist>'));
JS
swiftc -O -target "$(uname -m)-apple-macosx13.0" -framework AppKit macos/VorssaintPreferences.swift -o "$task_app/Contents/Resources/VorssaintPreferences"
codesign --force --sign - "$task_app/Contents/Resources/VorssaintPreferences"
swiftc -O -target "$(uname -m)-apple-macosx13.0" -framework IOKit macos/MacMetrics.swift -o "$task_app/Contents/Resources/MacMetrics"
codesign --force --sign - "$task_app/Contents/Resources/MacMetrics"
codesign --force --sign - "$task_app/Contents/Resources/node"
codesign --force --sign - "$task_app"
"$task_node" --input-type=module - "$task_app" <<'JS'
import fs from 'node:fs';import path from 'node:path';import{spawnSync}from'node:child_process';
const app=process.argv[2],signed=spawnSync('/usr/bin/codesign',['-d','--verbose=4',path.join(app,'Contents/MacOS/MacControlClient')],{encoding:'utf8'});
const hash=signed.stderr.match(/^CDHash=([a-f0-9]{40})$/m)?.[1];
if(signed.status!==0||!hash||!fs.readFileSync(path.join(app,'Contents/Resources/MacControls-Source/FanClientTrust.swift'),'utf8').includes(hash))throw Error('Fan helper client trust changed during app signing');
JS
codesign --verify --deep --strict "$task_app"
ditto -c -k --sequesterRsrc --keepParent "$task_app" dist/Open-Deck-macOS-arm64.zip
echo "Built: $task_app"
