#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
root="$PWD"
app="${1:-$root/build/Samare.app}"
resources="$app/Contents/Resources"
sparkle=$(Updates/dependency.sh)
runtime=$(Updates/python-runtime.sh)
mkdir -p "$app/Contents/Frameworks"
rsync -a --delete "$sparkle/Sparkle.framework/" "$app/Contents/Frameworks/Sparkle.framework/"
mkdir -p "$app/Contents/MacOS" "$resources" "$root/build/ModuleCache"
/usr/bin/swiftc -swift-version 5 -target "$(uname -m)-apple-macos12" -module-cache-path "$root/build/ModuleCache" -O -F "$sparkle" -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks -framework AppKit -framework WebKit Native/*.swift -o "$app/Contents/MacOS/Samare"
/usr/bin/python3 Updates/configure-plist.py Info.plist "$app/Contents/Info.plist"
rsync -a --exclude '.DS_Store' --delete Resources/ "$resources/"
cp LICENSE THIRD-PARTY-NOTICES.txt "$resources/"
mkdir -p "$resources/Runtime"
rsync -a --delete "$runtime/" "$resources/Runtime/"
mkdir -p "$resources/Updates"
cp Updates/channel.py "$resources/Updates/"
cp "$sparkle/LICENSE" "$resources/Updates/Sparkle-LICENSE"
icons="$root/build/Samare.iconset"
/usr/bin/swift Native/Icon/generate.swift "$icons"
/usr/bin/iconutil -c icns "$icons" -o "$resources/Samare.icns"
if [[ -d Samples ]]; then rsync -a Samples/ "$resources/Samples/"; fi
test -x Bridge/samare
mkdir -p "$resources/Bridge"
rsync -a --exclude '__pycache__' Bridge/ "$resources/Bridge/"
extension="$app/Contents/PlugIns/SamarePreview.appex"
mkdir -p "$extension/Contents/MacOS" "$extension/Contents/Resources"
/usr/bin/swiftc -swift-version 5 -target "$(uname -m)-apple-macos12" -module-cache-path "$root/build/ModuleCache" -O -parse-as-library -application-extension -framework Quartz -framework JavaScriptCore -Xlinker -e -Xlinker _NSExtensionMain Native/QuickLook/*.swift -o "$extension/Contents/MacOS/SamarePreview"
cp Native/QuickLook/Info.plist "$extension/Contents/Info.plist"
rsync -a --delete --delete-excluded --include typefaces.css --include /diagram.js --include /fonts/ --include '/fonts/***' --include /vendor/ \
    --include /vendor/editor-libs.js --include /vendor/pele.global.js --include /vendor/js-yaml.min.js --include /vendor/katex.min.css --include /vendor/fonts/ --include '/vendor/fonts/*.woff2' \
    --include /vendor/licenses/ --include '/vendor/licenses/***' --exclude '*' Resources/ "$extension/Contents/Resources/"
/usr/bin/codesign --force --sign - --entitlements Native/QuickLook/Entitlements.plist "$extension"
/usr/bin/codesign --force --sign - "$app"
/usr/bin/codesign --verify --deep --strict "$app"
printf '%s\n' "$app"
