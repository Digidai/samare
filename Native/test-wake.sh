#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/ModuleCache
scratch=$(mktemp -d "${TMPDIR:-/tmp}/samare-wake-host.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
bundle="$scratch/Host.app/Contents"
mkdir -p "$bundle/MacOS" "$bundle/Resources/Bridge" "$scratch/home"
cp Bridge/samare Bridge/references.py "$bundle/Resources/Bridge/"
/usr/bin/plutil -create xml1 "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string WakeHarness' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string io.github.digidai.samare.wakecheck' "$bundle/Info.plist"
host=()
for source in Native/*.swift; do if [[ "$source" != Native/main.swift ]]; then host+=("$source"); fi; done
/usr/bin/swiftc -swift-version 5 -module-cache-path build/ModuleCache -framework AppKit -framework WebKit "${host[@]}" Native/Tests/Wake/main.swift -o "$bundle/MacOS/WakeHarness"
"$bundle/MacOS/WakeHarness" "$scratch/home"
