#!/bin/bash
# Run in a logged-in macOS session with Accessibility access for the terminal.
set -euo pipefail
cd "$(dirname "$0")/.."
fixture=$(mktemp -d "${TMPDIR:-/tmp}/samare-pdf-export.XXXXXXXX")
trap 'rm -rf "$fixture"' EXIT
bundle="$fixture/Samare PDF Export Test.app"
mkdir -p "$bundle/Contents/MacOS"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.digidai.samare.test.pdf-panel</string>
<key>CFBundleName</key><string>Samare PDF Export Test</string>
<key>CFBundleExecutable</key><string>ExportTest</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
sources=()
for source in Native/*.swift; do
  if [[ "$source" != Native/main.swift ]]; then sources+=("$source"); fi
done
/usr/bin/swiftc -swift-version 5 -module-cache-path "$fixture/module-cache" \
  -framework AppKit -framework WebKit -framework PDFKit "${sources[@]}" \
  Native/Tests/Export/*.swift -o "$bundle/Contents/MacOS/ExportTest"
/usr/bin/codesign --force --sign - "$bundle"
"$bundle/Contents/MacOS/ExportTest" --isolated -AppleLanguages '(en)'
