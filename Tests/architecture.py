"""Verify an installed application, its dependencies and its rendered Markdown on macOS."""
import argparse
import contextlib
from pathlib import Path
import platform
import subprocess
import tempfile


def output(*args):
    return subprocess.check_output(args, text=True).strip()


@contextlib.contextmanager
def installed(image, folder):
    mount = folder / "volume"
    mount.mkdir()
    subprocess.run(["hdiutil", "attach", "-quiet", "-readonly", "-nobrowse", "-mountpoint", mount, image], check=True)
    app = folder / "Applications/Samare.app"
    try:
        assert (mount / "Applications").readlink() == Path("/Applications")
        subprocess.run(["ditto", mount / "Samare.app", app], check=True)
    finally:
        subprocess.run(["diskutil", "eject", mount], check=True)
    yield app


def check_binaries(app, arch):
    subprocess.run(["codesign", "--verify", "--deep", "--strict", app], check=True)
    magics = {"feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "cafebabf", "bebafeca", "bfbafeca"}
    count = 0
    for file in app.rglob("*"):
        if file.is_symlink() or not file.is_file():
            continue
        with file.open("rb") as stream:
            if stream.read(4).hex() not in magics:
                continue
        slices = output("lipo", "-archs", file).split()
        if arch not in slices:
            raise AssertionError(f"{file.relative_to(app)} contains only {slices}")
        count += 1
    runtime = app / "Contents/Resources/Runtime/bin/python3"
    for required in [app / "Contents/MacOS/Samare", runtime,
                     app / "Contents/PlugIns/SamarePreview.appex/Contents/MacOS/SamarePreview",
                     app / "Contents/Frameworks/Sparkle.framework/Sparkle"]:
        assert arch in output("lipo", "-archs", required).split(), required
    architecture = output("/usr/bin/arch", "-" + arch, runtime, "-I", "-B", "-c",
                          "import fcntl, http.server, platform, sqlite3, ssl; print(platform.machine())")
    assert architecture == arch, architecture
    print(f"Verified code signatures, {count} Mach-O files, Quick Look, Sparkle and {architecture} bundled Python.", flush=True)


def read_document(app, arch, folder):
    document = folder / "fixture.md"
    content = "# Meadow Ledger\n\nOrchards open in spring.\n"
    document.write_text(content)
    capture = folder / "rendered.png"
    executable = app / "Contents/MacOS/Samare"
    subprocess.run(["/usr/bin/arch", "-" + arch, executable, "--isolated", "--file", document,
                    "--capture", capture, "--quit-after-capture"], timeout=90, check=True)
    # Inspect the app's WKWebView snapshot so the check proves the editor displayed the file's contents.
    vision = """
import Foundation
import Vision
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
request.usesLanguageCorrection = false
request.usesCPUOnly = true
let image = URL(fileURLWithPath: CommandLine.arguments[1])
try VNImageRequestHandler(url: image).perform([request])
for result in request.results ?? [] { print(result.topCandidates(1).first?.string ?? "") }
"""
    text = subprocess.check_output(["/usr/bin/swift", "-", capture], input=vision, text=True, timeout=90)
    for expected in ["Meadow Ledger", "Orchards open in spring"]:
        assert expected.casefold() in text.casefold(), f"Missing {expected!r} in rendered text:\n{text}"
    assert document.read_text() == content
    print("The installed app displayed the Markdown heading and paragraph and exited normally.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dmg", type=Path)
    parser.add_argument("arch", choices=["arm64", "x86_64"])
    parser.add_argument("--require-native", action="store_true")
    args = parser.parse_args()
    translated = subprocess.run(["sysctl", "-in", "sysctl.proc_translated"], capture_output=True, text=True)
    host = "arm64" if translated.stdout.strip() == "1" else platform.machine()
    if args.require_native and host != args.arch:
        parser.error(f"A native {args.arch} host is required, found {host}.")
    print(f"Host {host}, testing {args.arch} ({'native' if host == args.arch else 'translated'}).", flush=True)
    with tempfile.TemporaryDirectory(prefix="samare-architecture-") as temporary:
        folder = Path(temporary)
        with installed(args.dmg.resolve(), folder) as app:
            check_binaries(app, args.arch)
            read_document(app, args.arch, folder)
