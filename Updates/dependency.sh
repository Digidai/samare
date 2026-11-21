#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
base=build/dependencies
version=2.9.6
dest="$base/sparkle-$version"
archive="$base/Sparkle-$version.tar.xz"
sum=52bf9e88cdd972fc0c81501377a880e90d47031bd8ca5462488f843e2609e192
if [[ ! -x "$dest/bin/sign_update" ]]; then
  mkdir -p "$base"
  tmp=$(mktemp -d "$base/sparkle.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  if [[ ! -f "$archive" ]]; then
    curl --fail --location --silent --show-error --retry 3 --retry-all-errors -o "$tmp/archive" "https://github.com/sparkle-project/Sparkle/releases/download/$version/Sparkle-$version.tar.xz"
    echo "$sum  $tmp/archive" | shasum -a 256 -c - >&2
    mv "$tmp/archive" "$archive"
  fi
  echo "$sum  $archive" | shasum -a 256 -c - >&2
  mkdir "$tmp/sdk"
  tar xf "$archive" -C "$tmp/sdk"
  /usr/bin/python3 Updates/install-directory.py "$tmp/sdk" "$dest" bin/sign_update
fi
echo "$PWD/$dest"
