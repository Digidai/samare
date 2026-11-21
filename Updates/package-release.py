#!/usr/bin/env python3
"""Package an independently signed Sparkle release into a private directory."""
import argparse
import fcntl
import hashlib
import os
import pathlib
import plistlib
import subprocess
import tempfile
import re
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlsplit

root = pathlib.Path(__file__).resolve().parents[1]
support = pathlib.Path.home() / "Library/Application Support"
p = argparse.ArgumentParser()
p.add_argument("--app", type=pathlib.Path, default=root / "build/Samare.app")
p.add_argument("--channel", type=pathlib.Path, default=support / "Samare/Releases")
p.add_argument("--key", type=pathlib.Path, default=support / "Samare Publisher/ed25519")
p.add_argument("--archive-base-url", help="Public HTTPS directory for archives hosted separately from the feed")
args = p.parse_args()
if args.archive_base_url:
    parts = urlsplit(args.archive_base_url)
    if parts.scheme != "https" or not parts.hostname or parts.username is not None or parts.query or parts.fragment:
        p.error("--archive-base-url must be an HTTPS directory URL")
app = args.app.resolve()
meta = plistlib.loads((app / "Contents/Info.plist").read_bytes())
feed_path = urlsplit(meta.get("SUFeedURL", "")).path
feed_name = "appcast-intel.xml" if feed_path.endswith("/appcast-intel.xml") else "appcast.xml"
build = meta["CFBundleVersion"]
if not re.fullmatch("[0-9]+", build):
    p.error("expected an integer build number")
if not args.key.is_file():
    p.error("publisher signing key is missing")
key = subprocess.check_output(["/usr/bin/swift", root/"Updates/new-key.swift", args.key], text=True).strip()
if key != meta.get("SUPublicEDKey"):
    p.error("publisher key does not match the public key embedded in this app")
subprocess.run(["codesign", "--verify", "--deep", "--strict", app], check=True)
sdk = pathlib.Path(subprocess.check_output([root / "Updates/dependency.sh"], text=True).strip())
tool = sdk / "bin/sign_update"
ns = "http://www.andymatuschak.org/xml-namespaces/sparkle"
ET.register_namespace("sparkle", ns)
args.channel.mkdir(mode=0o700, parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(dir=args.channel) as tmp:
    zipfile = pathlib.Path(tmp) / ("Samare-" + build + ".zip")
    subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, zipfile], check=True)
    sig = subprocess.check_output([tool, "--ed-key-file", args.key, zipfile], text=True).strip()
    enc = ET.fromstring('<enclosure xmlns:sparkle="' + ns + '" ' + sig + '/>')
    digest = hashlib.sha256()
    with zipfile.open("rb") as content:
        for chunk in iter(lambda: content.read(1 << 20), b""):
            digest.update(chunk)
    archive_name = f"Samare-{build}-{digest.hexdigest()}.zip"
    archive_url = urljoin(args.archive_base_url.rstrip("/") + "/", archive_name) if args.archive_base_url else archive_name
    enc.set("url", archive_url)
    enc.set("type", "application/octet-stream")
    rss = ET.Element("rss", version="2.0")
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = "Samare"
    item = ET.SubElement(channel, "item")
    ET.SubElement(item, "title").text = meta["CFBundleDisplayName"]
    for k, val in [("version", build), ("shortVersionString", meta["CFBundleShortVersionString"]), ("minimumSystemVersion", meta["LSMinimumSystemVersion"])]:
        ET.SubElement(item, "{" + ns + "}" + k).text = val
    item.append(enc)
    feed = pathlib.Path(tmp) / feed_name
    ET.ElementTree(rss).write(feed, encoding="utf-8", xml_declaration=True)
    subprocess.run([tool, "--ed-key-file", args.key, feed], check=True)
    with (args.channel / ".publish-lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        published = args.channel / feed.name
        if published.exists():
            versions = ET.parse(published).getroot().iter("{" + ns + "}version")
            if any(v.text and v.text.isdigit() and int(v.text) > int(build) for v in versions):
                p.error("channel already contains a newer build")
        # Older feeds can still finish downloading their original archive.
        os.replace(zipfile, args.channel / archive_name)
        os.replace(feed, published)
print(args.channel / feed_name)
