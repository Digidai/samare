#!/usr/bin/env python3
"""Sign a staged Samare app, notarize it for ZIP updates, then notarize the installer."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
MACH_O = {bytes.fromhex(s) for s in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe",
    "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
)}


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def mach_objects(directory):
    objects = set()
    for file in directory.rglob("*"):
        if file.is_symlink() or not file.is_file():
            continue
        with file.open("rb") as stream:
            if stream.read(4) in MACH_O:
                objects.add(file)
    return objects


def signing_plan(app):
    contents = app / "Contents"
    framework = contents / "Frameworks/Sparkle.framework"
    version = framework / "Versions/Current"
    services = version / "XPCServices"
    runtime = contents / "Resources/Runtime"
    extension = contents / "PlugIns/SamarePreview.appex"
    # Follow Sparkle's manual signing order and entitlement guidance.
    # https://sparkle-project.org/documentation/sandboxing/#code-signing
    targets = [
        (services / "Installer.xpc", []),
        (services / "Downloader.xpc", ["--preserve-metadata=entitlements"]),
        (version / "Autoupdate", []),
        (version / "Updater.app", []),
        (framework, []),
    ]
    targets.extend((file, []) for file in sorted(mach_objects(runtime)))
    targets.extend([
        (extension, ["--entitlements", ROOT / "Native/QuickLook/Entitlements.plist"]),
        (app, []),
    ])
    planned = set()
    for target, _ in targets:
        if target.suffix == ".framework":
            info = target / "Resources/Info.plist"
            binary = target / plistlib.loads(info.read_bytes())["CFBundleExecutable"]
        elif target.is_dir():
            info = target / "Contents/Info.plist"
            binary = target / "Contents/MacOS" / plistlib.loads(info.read_bytes())["CFBundleExecutable"]
        else:
            binary = target
        if not binary.is_file() or app not in binary.resolve().parents:
            raise SystemExit(f"Missing or external signing target: {binary}")
        planned.add(binary.resolve())
    contents_found = mach_objects(contents)
    if planned != contents_found:
        unexpected = sorted(str(p.relative_to(app)) for p in planned ^ contents_found)
        raise SystemExit("Signing plan differs from bundle binaries: " + ", ".join(unexpected))
    return targets


def identities():
    listing = run("/usr/bin/security", "find-identity", "-v", "-p", "codesigning",
                  capture_output=True, text=True).stdout
    return re.findall(r'^\s*\d+\) ([0-9a-fA-F]{40}) "(Developer ID Application: [^"]+)"$',
                      listing, re.MULTILINE)


def record_notary_response(arguments, destination):
    # Stream Apple's reply straight to disk. Keep incomplete output if the connection drops.
    partial = destination.with_suffix(".partial")
    with partial.open("xb") as output:
        result = subprocess.run(["/usr/bin/xcrun", "notarytool", *arguments, "--output-format", "json"],
                                stdout=output)
    try:
        response = json.loads(partial.read_bytes())
    except (ValueError, UnicodeDecodeError) as error:
        raise SystemExit(f"notarytool returned no complete JSON response; diagnostics: {partial}") from error
    partial.rename(destination)
    return response, result.returncode


def notarize(upload, staple_target, profile, output, kind):
    auth = ["--keychain-profile", profile]
    receipt = output / f"{kind}-submission.json"
    response, code = record_notary_response(["submit", upload, *auth, "--no-wait"], receipt)
    submission = response.get("id")
    if submission:
        print(f"{upload.name}: Apple submission {submission}; saved {receipt}", flush=True)
    if code or not submission:
        raise SystemExit(f"Apple did not confirm the upload; inspect {receipt}")

    # Save the submission ID before waiting, so an interrupted wait can be retried by ID.
    status, code = record_notary_response(["wait", submission, *auth], output / f"{kind}-notarization.json")
    print(f"{upload.name}: {status.get('status', 'unknown status')} ({submission})", flush=True)
    if code or status.get("status") != "Accepted":
        if status.get("status") in {"Invalid", "Rejected"}:
            subprocess.run(["/usr/bin/xcrun", "notarytool", "log", submission,
                            output / f"{kind}-notary-log.json", *auth])
        raise SystemExit(f"Apple has not accepted {upload.name}; the submitted files and receipts are in {output}")
    # A ticket can take a moment to propagate after the service accepts the submission.
    for delay in (0, 5, 15, 30):
        time.sleep(delay)
        attempt = subprocess.run(["/usr/bin/xcrun", "stapler", "staple", staple_target])
        if not attempt.returncode:
            break
    attempt.check_returncode()
    run("/usr/bin/xcrun", "stapler", "validate", staple_target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="inspect the local bundle and available identities")
    mode.add_argument("--submit", action="store_true", help="sign and submit a copy of the bundle to Apple")
    parser.add_argument("--app", type=Path, default=ROOT / "build/Samare.app")
    parser.add_argument("--output", type=Path, default=ROOT / "build/notarized",
                        help="new directory for the signed app, disk image and Apple receipts")
    parser.add_argument("--identity", default=os.getenv("SAMARE_SIGN_IDENTITY"),
                        help="Developer ID Application name or SHA-1 fingerprint (auto-select if unique)")
    parser.add_argument("--profile", default=os.getenv("SAMARE_NOTARY_PROFILE"),
                        help="existing notarytool Keychain profile")
    args = parser.parse_args()
    app = args.app.resolve()
    plan = signing_plan(app)
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", app)
    python = Path("Contents/Resources/Runtime/bin/python3")
    imports = "import _dbm, ssl, sqlite3, http.server, fcntl"
    run(app / python, "-I", "-B", "-c", imports)
    available = identities()
    if args.check:
        for target, _ in plan:
            print(target.relative_to(app.parent))
        print(f"Local bundle passed; {len(plan)} signing targets, "
              f"{len(available)} valid Developer ID Application identities.")
        return
    selected = [fingerprint for fingerprint, name in available
                if not args.identity or args.identity.lower() == fingerprint.lower() or args.identity == name]
    if len(selected) != 1:
        parser.error("one valid Developer ID Application identity and private key must be selected")
    if not args.profile:
        parser.error("set --profile to a validated notarytool Keychain profile")
    output = args.output.resolve()
    if output.exists() or app == output or app in output.parents:
        parser.error("--output must be a new directory outside the source bundle")
    # Verify the credentials before allocating a release directory. Do not print the team's history.
    run("/usr/bin/xcrun", "notarytool", "history", "--keychain-profile", args.profile,
        "--output-format", "json", stdout=subprocess.DEVNULL)
    output.mkdir(mode=0o700, parents=True)
    work = output / ".pending"
    work.mkdir()
    print(f"Keeping submission receipts in {output} and in-progress artifacts in {work}", flush=True)
    signed = work / "Samare.app"
    run("/usr/bin/ditto", app, signed)
    for target, flags in signing_plan(signed):
        run("/usr/bin/codesign", "--force", "--sign", selected[0], "--timestamp", "--options", "runtime",
            *flags, target)
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", signed)
    run(signed / python, "-I", "-B", "-c", imports)
    upload = work / "Samare.zip"
    run("/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", signed, upload)
    notarize(upload, signed, args.profile, output, "app")
    run("/usr/sbin/spctl", "--assess", "--type", "execute", signed)
    image = work / "Samare.dmg"
    run(ROOT / "Updates/package-dmg.sh", signed, image)
    run("/usr/bin/codesign", "--force", "--sign", selected[0], "--timestamp", image)
    notarize(image, image, args.profile, output, "dmg")
    run("/usr/bin/codesign", "--verify", "--strict", image)
    run("/usr/sbin/spctl", "--assess", "--type", "open", "--context", "context:primary-signature", image)
    signed.rename(output / signed.name)
    image.rename(output / image.name)
    upload.unlink()
    work.rmdir()
    print(output)


if __name__ == "__main__":
    main()
