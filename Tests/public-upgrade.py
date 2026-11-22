"""Use the public Samare update button in a disposable GitHub-hosted macOS GUI."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
REPO = "https://github.com/Digidai/samare/releases"
IDENTIFIER = "io.github.digidai.samare"
API = "https://api.github.com/repos/Digidai/samare/releases"
START = {"arm64": "0.1.0", "x86_64": "0.1.1"}
START_DMG_HASH = {
    ("arm64", "0.1.0"): "8bf0678febd777c1497788ea60160719ad45a48a1592e38606835bd67900adc6",
    ("x86_64", "0.1.1"): "c059da965d7176f433dbe2de1c822f343fabb68a8cfc9b5f2611f861d89ecd36",
}
FEED = {"arm64": "appcast.xml", "x86_64": "appcast-intel.xml"}
SPARKLE = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"
CURL = ["curl", "-fsSL", "--retry", "3", "--retry-all-errors"]
MARKER = "Saved before update."


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def wait_for(fn, label, seconds=30):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        result = fn()
        if result:
            return result
        time.sleep(0.15)
    raise RuntimeError("Timed out waiting for " + label)


def preferences():
    output = subprocess.run(["defaults", "export", IDENTIFIER, "-"], capture_output=True)
    return plistlib.loads(output.stdout) if output.returncode == 0 else {}


def release(selector):
    metadata = json.loads(run(*CURL, f"{API}/{selector}"))
    assert not metadata["draft"] and not metadata["prerelease"], metadata["tag_name"]
    return metadata


def version(tag):
    if not re.fullmatch(r"v?[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError(f"Expected a stable release version, got {tag!r}")
    return tag.removeprefix("v")


def asset(release_data, name):
    matches = [x for x in release_data["assets"] if x["name"] == name]
    if len(matches) != 1:
        raise ValueError(f"Expected one {name} in {release_data['tag_name']}")
    entry = matches[0]
    assert entry["browser_download_url"] == f"{REPO}/download/{release_data['tag_name']}/{name}"
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", entry["digest"]), entry["digest"]
    return entry


def download(directory, entry):
    path = directory / entry["name"]
    run(*CURL, entry["browser_download_url"], "-o", path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert path.stat().st_size == entry["size"] and "sha256:" + digest == entry["digest"], path.name
    return path


@contextmanager
def mounted(image, work):
    with tempfile.TemporaryDirectory(dir=work) as mount:
        run("hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, image)
        try:
            yield Path(mount) / "Samare.app"
        finally:
            run("diskutil", "eject", mount)


def verify_bundle(app, arch, expected_version):
    run("codesign", "--verify", "--deep", "--strict", app)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    assert info["CFBundleIdentifier"] == IDENTIFIER and info["CFBundleShortVersionString"] == expected_version
    assert info["SUFeedURL"] == REPO + "/latest/download/" + FEED[arch], info["SUFeedURL"]
    assert arch in run("lipo", "-archs", app / "Contents/MacOS" / info["CFBundleExecutable"]).split()
    signature = subprocess.check_output(["codesign", "-dvvv", "--arch", arch, app], stderr=subprocess.STDOUT, text=True)
    cdhash = re.search(r"^CDHash=([a-f0-9]{40})$", signature, re.MULTILINE)
    assert cdhash, signature
    return {"version": expected_version, "build": int(info["CFBundleVersion"]), "cdhash": cdhash.group(1)}


def prepare_releases(work, app, arch, start, expected):
    # Resolve "latest" once. Every independent reference download then uses a versioned URL and asset digest.
    newest = release("latest")
    target = version(newest["tag_name"])
    if expected != "latest" and version(expected) != target:
        raise ValueError(f"The production channel now points to {target}, expected {expected}.")
    if start == target:
        raise ValueError(f"The starting release {start} is already current.")
    origin = release(f"tags/v{start}")
    assert origin["tag_name"] == f"v{start}"
    initial = asset(origin, f"Samare-{start}-{arch}.dmg")
    known = START_DMG_HASH.get((arch, start))
    if known:
        assert initial["digest"] == "sha256:" + known
    with mounted(download(work, initial), work) as source:
        run("ditto", source, app)
    old = verify_bundle(app, arch, start)
    official_image = asset(newest, f"Samare-{target}-{arch}.dmg")
    with mounted(download(work, official_image), work) as source:
        new = verify_bundle(source, arch, target)
    assert new["build"] > old["build"], (old, new)
    feed = asset(newest, FEED[arch])
    items = ET.parse(download(work, feed)).findall("./channel/item")
    item, = [i for i in items if i.findtext(SPARKLE + "shortVersionString") == target]
    assert int(item.findtext(SPARKLE + "version")) == new["build"]
    enclosure = item.find("enclosure")
    archive_url = enclosure.attrib["url"]
    archive_name = archive_url.rsplit("/", 1)[-1]
    archive = asset(newest, archive_name)
    assert archive["browser_download_url"] == archive_url and archive["size"] == int(enclosure.attrib["length"])
    assert archive_name == f"Samare-{new['build']}-{archive['digest'].split(':')[1]}.zip"
    reference = work / "published-archive"
    run("ditto", "-x", "-k", download(work, archive), reference)
    assert verify_bundle(reference / "Samare.app", arch, target) == new, "Release DMG and update ZIP disagree"
    assets = {x["name"]: x["digest"] for x in (initial, official_image, feed, archive)}
    return old, new, assets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--architecture", choices=START, default="arm64")
    parser.add_argument("--from-version", help="Defaults to the first public release for the selected architecture.")
    parser.add_argument("--to-version", default="latest", help="Assert a specific currently published target, or latest.")
    args = parser.parse_args()
    arch = args.architecture
    start = version(args.from_version) if args.from_version else START[arch]
    if not (os.getenv("GITHUB_ACTIONS") == "true" and os.getenv("RUNNER_ENVIRONMENT") == "github-hosted"
            and platform.system() == "Darwin" and platform.machine() == arch and run("sysctl", "-in", "sysctl.proc_translated") != "1"):
        raise SystemExit(f"Requires a disposable native {arch} GitHub-hosted macOS runner.")
    temp = Path(os.environ["RUNNER_TEMP"]).resolve()
    evidence = temp / "samare-upgrade-evidence"
    evidence.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="samare-ui-", dir=temp))
    app = work / "Applications/Samare.app"
    folder = work / "Notebook"
    folder.mkdir()
    app.parent.mkdir()
    note = folder / "Release check.md"
    second = folder / "Checklist.md"
    note.write_text("# Release check\n\nA document created for the public macOS upgrade test.\n")
    second.write_text("# Checklist\n\nOther tab restored after the update.\n")
    second_bytes = second.read_bytes()
    inspector = work / "inspect-ui"
    ax = work / "accessibility"
    run("swiftc", ROOT / "Tests/public-upgrade-ui.swift", "-o", inspector)
    run("swiftc", ROOT / "Native/Tests/UpdateUI/main.swift", "-o", ax)

    def record(event, **fields):
        item = dict(time=time.time(), event=event, **fields)
        print(json.dumps(item), flush=True)
        with (evidence / "events.jsonl").open("a") as log:
            print(json.dumps(item), file=log)

    def state():
        return json.loads(run(inspector, "state"))

    def instances():
        items = state()["processes"]
        if any(Path(item["bundle"]).resolve() != app for item in items):
            raise RuntimeError("Another copy of Samare is running.")
        return items

    def control(pid, action, value=""):
        return subprocess.run([ax, pid, action, value], text=True, capture_output=True, timeout=8)

    def tree(pid, filename):
        snapshot = control(pid, "dump").stdout
        (evidence / filename).write_text(snapshot)
        return snapshot

    def ax_find(pid, value):
        return control(pid, "find", value).returncode == 0

    def session_matches():
        prefs = preferences()
        return ({Path(path).resolve() for path in prefs.get("tabs", [])} == {note, second}
                and Path(prefs.get("activePath", "")).resolve() == note
                and Path(prefs.get("activeWorkspace", "")).resolve() == folder)

    before = state()
    record("runner", architecture=arch, **before)
    assert not before["locked"] and before["trusted"], "The GUI session must be unlocked and Accessibility trusted."
    assert not before["processes"] and not preferences(), "Samare already has state on this runner."
    assert not (Path.home() / "Library/Application Support/Samare").exists()
    initial, target, assets = prepare_releases(work, app, arch, start, args.to_version or "latest")
    record("verified public releases", original=initial, target=target, assets=assets)
    button = "Update to Samare " + target["version"]
    old_pid = new_pid = None
    try:
        # The sole launch in this test. No process is launched or activated after clicking Update.
        run("open", "-n", "-a", app, "--args", "--workspace", folder, "--file", second, "--file", note)
        old = wait_for(instances, "the original app")[0]
        old_pid = old["pid"]
        wait_for(lambda: ax_find(old_pid, button), "public update badge", 75)
        assert ax_find(old_pid, "A document created for the public macOS upgrade test.")
        run(inspector, "edit", old_pid, app, MARKER)
        wait_for(lambda: MARKER in note.read_text(), "the native editor to save")
        wait_for(session_matches, "both original tabs and the active workspace")
        saved = note.read_bytes()
        (evidence / "before.txt").write_bytes(saved)
        assert MARKER in tree(old_pid, "before-accessibility.txt")
        record("before", process=old, build=initial["build"], note_sha256=hashlib.sha256(saved).hexdigest())

        result = control(old_pid, "button", button)
        record("press", pid=old_pid, role="AXButton", label=button, status=result.returncode)
        assert result.returncode == 0

        def relaunched():
            current = instances()
            return current if len(current) == 1 and current[0]["pid"] != old_pid else None

        new = wait_for(relaunched, "Sparkle to terminate the old process and relaunch the app", 210)[0]
        new_pid = new["pid"]
        assert new["started"] != old["started"] and old["bundle"] == new["bundle"]
        record("automatic relaunch", old_pid=old_pid, process=new)
        assert verify_bundle(app, arch, target["version"]) == target, "Installed bundle differs from public release"
        wait_for(lambda: ax_find(new_pid, "What’s new in Samare"), "the upgrade card")
        tree(new_pid, "upgrade-card.txt")
        assert control(new_pid, "button", "Close").returncode == 0
        wait_for(lambda: ax_find(new_pid, MARKER), "the restored active document")
        restored = tree(new_pid, "after-accessibility.txt")
        assert "Checklist" in restored and "Release check" in restored
        assert session_matches() and note.read_bytes() == saved and second.read_bytes() == second_bytes
        (evidence / "after.txt").write_bytes(note.read_bytes())
        record("restored", architecture=arch, version=target["version"], build=target["build"], bundle_cdhash=target["cdhash"],
               note_sha256=hashlib.sha256(note.read_bytes()).hexdigest(),
               tabs=preferences()["tabs"], workspace=preferences()["activeWorkspace"])
    finally:
        for item in instances():
            tree(item["pid"], "last-accessibility.txt")
            control(item["pid"], "quit")


if __name__ == "__main__":
    main()
