#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
app="${1:-$PWD/build/Samare.app}"
image="${2:-$PWD/build/Samare.dmg}"
/usr/bin/codesign --verify --deep --strict "$app"
tools="$PWD/build/dependencies/dmg-tools"
if [[ ! -x "$tools/bin/dmgbuild" ]]; then
    /usr/bin/python3 -m venv "$tools"
    "$tools/bin/python" -m pip --disable-pip-version-check install dmgbuild==1.6.5 ds_store==1.3.1 mac_alias==2.2.2
fi
stage=$(mktemp -d "$PWD/build/dmg.XXXXXX")
trap 'rm -rf "$stage"' EXIT
/usr/bin/swift Updates/InstallerBackground.swift "$stage/background.png"
"$tools/bin/python" - "$app" "$stage" <<'PY'
from dmgbuild import build_dmg
from pathlib import Path
import sys
app, stage = (Path(s).resolve() for s in sys.argv[1:])
build_dmg(str(stage/'installer.dmg'), 'Samare', settings={
    'format': 'UDZO', 'files': [str(app)], 'symlinks': {'Applications': '/Applications'},
    'icon': str(app/'Contents/Resources/Samare.icns'), 'background': str(stage/'background.png'),
    'window_rect': ((200, 100), (720, 440)), 'icon_size': 128, 'text_size': 16,
    'icon_locations': {app.name: (200, 260), 'Applications': (520, 260)},
    'show_icon_preview': True,
})
PY
mv -f "$stage/installer.dmg" "$image"
printf '%s\n' "$image"
