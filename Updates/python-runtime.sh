#!/bin/bash
# Package only the self-contained interpreter and standard library used by the two local services.
set -euo pipefail
cd "$(dirname "$0")/.."
base="$PWD/build/dependencies"
release=20261110
version=3.13.18
case "$(uname -m)" in
    arm64) arch=aarch64; digest=7a2384641584ab9984221fcb0fc9265df465922af71be71410529e2a9c3f0540 ;;
    x86_64) arch=x86_64; digest=d27d59a722db9f69926eb6d9564071247221f45a04da920ea7f3001c97e32f9b ;;
    *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;;
esac
target="$base/runtime-$version-$release-$arch"
# Keep the lib-dynload directory as a CPython exec-prefix landmark after relocation.
if [[ ! -f "$target/lib/python3.13/lib-dynload/_dbm.cpython-313-darwin.so" ]]; then
    mkdir -p "$base"
    scratch=$(mktemp -d "$base/runtime.XXXXXX")
    trap 'rm -rf "$scratch"' EXIT
    fetch() {
        local file="$base/$1" url="$2" sha="$3"
        if [[ ! -f "$file" ]]; then
            curl --fail --location --silent --show-error --retry 3 --retry-all-errors "$url" -o "$scratch/download"
            echo "$sha  $scratch/download" | shasum -a 256 -c - >&2
            mv "$scratch/download" "$file"
        fi
        echo "$sha  $file" | shasum -a 256 -c - >&2
    }
    archive="cpython-$version+$release-$arch-apple-darwin-install_only_stripped.tar.gz"
    fetch "$archive" "https://github.com/astral-sh/python-build-standalone/releases/download/$release/$archive" "$digest"
    notices="python-build-standalone-$release.tar.gz"
    fetch "$notices" "https://codeload.github.com/astral-sh/python-build-standalone/tar.gz/refs/tags/$release" 63b8166347616283ee6d3ed449e957bc71b65368bc60945d21ab957e6fcaee49
    tar xzf "$base/$archive" -C "$scratch"
    tar xzf "$base/$notices" -C "$scratch"
    dest="$scratch/runtime"
    mkdir -p "$dest"/{bin,lib/python3.13/lib-dynload,licenses}
    cp "$scratch/python/bin/python3.13" "$dest/bin/python3"
    cp "$scratch/python/lib/python3.13/lib-dynload/"_dbm*.so "$dest/lib/python3.13/lib-dynload/"
    cp "$scratch/python-build-standalone-$release"/LICENSE* "$dest/licenses/"
    cp "$scratch/python/lib/python3.13/LICENSE.txt" "$dest/licenses/Python-LICENSE.txt"
    ( cd "$scratch/python/lib/python3.13"
      /usr/bin/zip -q -X -r "$dest/lib/python313.zip" . -x '*/__pycache__/*' 'site-packages/*' 'lib-dynload/*' 'config-*' 'ensurepip/*' 'idlelib/*' 'tkinter/*' )
    "$dest/bin/python3" -I -B -c 'import sqlite3, ssl, http.server, selectors, fcntl'
    /usr/bin/python3 Updates/install-directory.py "$dest" "$target" lib/python3.13/lib-dynload/_dbm.cpython-313-darwin.so
fi
echo "$target"
