"""Embed an optional publisher's public update configuration at build time."""
import base64
import binascii
import os
from pathlib import Path
import plistlib
import sys
from urllib.parse import urlsplit

source, destination = map(Path, sys.argv[1:])
settings = plistlib.loads(source.read_bytes())
key = os.environ.get("SAMARE_UPDATE_PUBLIC_KEY", "").strip()
feed = os.environ.get("SAMARE_UPDATE_FEED_URL", "").strip()
if bool(key) != bool(feed):
    sys.exit("Set both SAMARE_UPDATE_PUBLIC_KEY and SAMARE_UPDATE_FEED_URL for a release build.")
if feed:
    address = urlsplit(feed)
    if not address.hostname or address.username is not None or address.fragment or not (
        address.scheme == "https" or (address.scheme == "http" and address.hostname == "127.0.0.1")
    ):
        sys.exit("Use an HTTPS update feed, or an HTTP feed on 127.0.0.1 for local testing.")
    try:
        valid = len(base64.b64decode(key, validate=True)) == 32
    except (ValueError, binascii.Error):
        valid = False
    if not valid:
        sys.exit("SAMARE_UPDATE_PUBLIC_KEY must contain a base64-encoded Ed25519 public key.")
    settings.update(SUPublicEDKey=key, SUFeedURL=feed)
destination.write_bytes(plistlib.dumps(settings, sort_keys=False))
