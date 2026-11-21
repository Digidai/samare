"""Use the public Samare update button in a disposable GitHub-hosted macOS GUI."""
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
REPO = "https://github.com/Digidai/samare/releases"
IDENTIFIER = "io.github.digidai.samare"
DMG = "Samare-0.1.0-arm64.dmg"
DMG_HASH = "8bf0678febd777c1497788ea60160719ad45a48a1592e38606835bd67900adc6"
RELEASE_CDHASH = "91436f2304cd1231e4741ef2f6b2464784fe778c"
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


def verify_bundle(app, expected_version, expected_build):
    run("codesign", "--verify", "--strict", "--deep", app)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    assert (info["CFBundleIdentifier"], info["CFBundleShortVersionString"], info["CFBundleVersion"]) == (
        IDENTIFIER, expected_version, expected_build)
    assert info["SUFeedURL"] == REPO + "/latest/download/appcast.xml"


def main():
    if not (os.getenv("GITHUB_ACTIONS") == "true"
            and os.getenv("RUNNER_ENVIRONMENT") == "github-hosted"
            and platform.system() == "Darwin" and platform.machine() == "arm64"):
        raise SystemExit("Requires a disposable arm64 GitHub-hosted macOS runner.")
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
    record("runner", **before)
    assert not before["locked"] and before["trusted"], "The GUI session must be unlocked and Accessibility trusted."
    assert not before["processes"] and not preferences(), "Samare already has state on this runner."
    assert not (Path.home() / "Library/Application Support/Samare").exists()
    run("curl", "-fsSL", "--retry", "3", "--retry-all-errors", REPO + "/download/v0.1.0/" + DMG, "-o", work / DMG)
    assert hashlib.sha256((work / DMG).read_bytes()).hexdigest() == DMG_HASH
    volume = work / "volume"
    volume.mkdir()
    run("hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", volume, work / DMG)
    try:
        run("ditto", volume / "Samare.app", app)
    finally:
        run("diskutil", "eject", volume)
    verify_bundle(app, "0.1.0", "1")
    old_pid = new_pid = None
    try:
        # The sole launch in this test. No process is launched or activated after clicking Update.
        run("open", "-n", "-a", app, "--args", "--workspace", folder, "--file", second, "--file", note)
        old = wait_for(instances, "the original app")[0]
        old_pid = old["pid"]
        wait_for(lambda: ax_find(old_pid, "Update to Samare 0.1.1"), "public update badge", 75)
        assert ax_find(old_pid, "A document created for the public macOS upgrade test.")
        run(inspector, "edit", old_pid, app, MARKER)
        wait_for(lambda: MARKER in note.read_text(), "the native editor to save")
        wait_for(session_matches, "both original tabs and the active workspace")
        saved = note.read_bytes()
        (evidence / "before.txt").write_bytes(saved)
        assert MARKER in tree(old_pid, "before-accessibility.txt")
        record("before", process=old, build=1, note_sha256=hashlib.sha256(saved).hexdigest())

        result = control(old_pid, "button", "Update to Samare 0.1.1")
        record("press", pid=old_pid, role="AXButton", label="Update to Samare 0.1.1", status=result.returncode)
        assert result.returncode == 0

        def relaunched():
            current = instances()
            return current if len(current) == 1 and current[0]["pid"] != old_pid else None

        new = wait_for(relaunched, "Sparkle to terminate the old process and relaunch the app", 210)[0]
        new_pid = new["pid"]
        assert new["started"] != old["started"] and old["bundle"] == new["bundle"]
        record("automatic relaunch", old_pid=old_pid, process=new)
        verify_bundle(app, "0.1.1", "2")
        signatures = subprocess.check_output(["codesign", "-dvvv", app], stderr=subprocess.STDOUT, text=True)
        assert "CDHash=" + RELEASE_CDHASH in signatures.splitlines()
        wait_for(lambda: ax_find(new_pid, "What’s new in Samare"), "the upgrade card")
        tree(new_pid, "upgrade-card.txt")
        assert control(new_pid, "button", "Close").returncode == 0
        wait_for(lambda: ax_find(new_pid, MARKER), "the restored active document")
        restored = tree(new_pid, "after-accessibility.txt")
        assert "Checklist" in restored and "Release check" in restored
        assert session_matches() and note.read_bytes() == saved and second.read_bytes() == second_bytes
        (evidence / "after.txt").write_bytes(note.read_bytes())
        record("restored", build=2, bundle_cdhash=RELEASE_CDHASH,
               note_sha256=hashlib.sha256(note.read_bytes()).hexdigest(),
               tabs=preferences()["tabs"], workspace=preferences()["activeWorkspace"])
    finally:
        for item in instances():
            tree(item["pid"], "last-accessibility.txt")
            control(item["pid"], "quit")


if __name__ == "__main__":
    main()
