#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
task_control_app="${1:?App bundle path required}"
task_control_source="$PWD/macos/mac-controls"
task_control_build="$PWD/dist/mac-control-build"
mkdir -p "$task_control_build" "$task_control_app/Contents/MacOS" "$task_control_app/Contents/Library/LaunchServices"
task_control_common=(
  "$task_control_source/FanProtocol.swift"
  "$task_control_source/upstream/FanControlSupport.swift"
  "$task_control_source/upstream/FanControlHardware.swift"
  "$task_control_source/upstream/SMCClient.swift"
  "$task_control_source/upstream/TemperatureSensorSelector.swift"
)
swiftc -O -target "$(uname -m)-apple-macosx13.0" -framework AppKit -framework CoreAudio -framework IOKit -framework Security \
  "${task_control_common[@]}" "$task_control_source/SystemControls.swift" "$task_control_source/ClientMain.swift" \
  -o "$task_control_app/Contents/MacOS/MacControlClient"
codesign --force --sign - --identifier app.opendeck.mac-control-client "$task_control_app/Contents/MacOS/MacControlClient"
"${OPEN_DECK_NODE:-node}" --input-type=module - "$task_control_app/Contents/MacOS/MacControlClient" "$task_control_build/FanClientTrust.swift" <<'JS'
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const result=spawnSync('/usr/bin/codesign',['-d','--verbose=4',process.argv[2]],{encoding:'utf8'});
if(result.status!==0)throw Error('Client signature unavailable');
const hash=result.stderr.match(/^CDHash=([a-f0-9]{40})$/m)?.[1];
if(!hash)throw Error('Client CDHash unavailable');
fs.writeFileSync(process.argv[3],'// SPDX-License-Identifier: GPL-3.0-or-later\n// Generated build trust: this daemon accepts only this exact signed client.\nenum FanClientTrust { static let requirement = '+JSON.stringify('cdhash H"'+hash+'"')+' }\n');
JS
swiftc -O -D FAN_DAEMON -target "$(uname -m)-apple-macosx13.0" -framework IOKit -framework SystemConfiguration \
  "${task_control_common[@]}" "$task_control_build/FanClientTrust.swift" "$task_control_source/daemon/main.swift" \
  -o "$task_control_app/Contents/Library/LaunchServices/app.opendeck.host.fan-control"
codesign --force --sign - --identifier app.opendeck.host.fan-control "$task_control_app/Contents/Library/LaunchServices/app.opendeck.host.fan-control"
"$task_control_app/Contents/MacOS/MacControlClient" --selftest
"$task_control_app/Contents/Library/LaunchServices/app.opendeck.host.fan-control" --selftest
# Include complete corresponding source for both independent GPL executables.
rm -rf "$task_control_app/Contents/Resources/MacControls-Source"
mkdir -p "$task_control_app/Contents/Resources/MacControls-Source"
mkdir -p "$task_control_app/Contents/Resources/MacControls-Source/macos/mac-controls" "$task_control_app/Contents/Resources/MacControls-Source/scripts"
cp -R "$task_control_source/" "$task_control_app/Contents/Resources/MacControls-Source/macos/mac-controls/"
cp "$task_control_build/FanClientTrust.swift" "$task_control_app/Contents/Resources/MacControls-Source/"
cp "$0" "$task_control_app/Contents/Resources/MacControls-Source/scripts/build-mac-controls.sh"
cp "$task_control_source/COPYING" "$task_control_app/Contents/Resources/MacControls-Source/COPYING"
cat > "$task_control_app/Contents/Resources/MacControls-Source/README.md" <<'SOURCE'
# Mac controls corresponding source

GPL-3.0-or-later. With Xcode Command Line Tools and Node.js 22+, run from this folder:

    bash scripts/build-mac-controls.sh /absolute/path/to/output/OpenDeckControls.app

This builds the independent client and fan daemon. It does not install the privileged daemon.
The complete Open Deck application source is at https://github.com/Yaklede/open-deck.
SOURCE
