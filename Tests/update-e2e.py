"""Exercise Sparkle against disposable app bundles, separate preference domains and channels."""
import http.server
import pathlib
import plistlib
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

root = pathlib.Path(__file__).resolve().parents[1]
sdk = pathlib.Path(subprocess.check_output([root/"Updates/dependency.sh"], text=True).strip())
runtime = pathlib.Path(subprocess.check_output([root/"Updates/python-runtime.sh"], text=True).strip())
def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)
def wait_for(log, needle, count=1, seconds=55):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        s = log.read_text() if log.exists() else ""
        if sum(needle in line for line in s.splitlines()) >= count: return s
        time.sleep(.15)
    raise RuntimeError(f"timed out waiting for {needle!r} in {log}\n" + s[-1200:])

def check_during_background(home, source_app, appcast):
    home.mkdir()
    release_response = threading.Event()
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            (home/"request-started").touch()
            if not release_response.wait(timeout=20):
                self.send_error(503)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/xml")
            self.send_header("Content-Length", str(len(appcast)))
            self.end_headers()
            self.wfile.write(appcast)
        def log_message(self, *args):
            pass
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        app = home/source_app.name
        run("ditto", source_app, app)
        plist = app/"Contents/Info.plist"
        info = plistlib.loads(plist.read_bytes())
        ident = "io.github.digidai.samare.update-test." + uuid.uuid4().hex
        info.update(CFBundleIdentifier=ident, SUFeedURL=f"http://127.0.0.1:{server.server_port}/appcast.xml")
        plist.write_bytes(plistlib.dumps(info))
        run("/usr/bin/codesign", "-f", "-s", "-", app)
        process = subprocess.Popen([app/"Contents/MacOS/Samare", "--check-during-background"])
        try:
            events = home/"events"
            progress = wait_for(events, "Checking for updates", seconds=12)
            assert "user checked during background request" in progress, progress
            release_response.set()
            result = wait_for(events, "up to date")
            process.wait(timeout=10)
            assert result.count("user checked during background request") == result.count("up to date") == 1, result
            print("One manual check during an active background request showed immediate progress and a final result.", flush=True)
        finally:
            release_response.set()
            server.shutdown()
            if process.poll() is None: process.terminate()
            process.wait(timeout=10)
            subprocess.run(["defaults", "delete", ident], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

with tempfile.TemporaryDirectory(prefix="update-qa-", dir=root/"build") as tmp:
    test = pathlib.Path(tmp)
    key = test/"test-key"
    public_key = subprocess.check_output(["swift",root/"Updates/new-key.swift",key],text=True).strip()
    fixture = test/"runner"
    run("/usr/bin/swiftc", "-swift-version", "5", "-F", sdk, "-framework", "Sparkle", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks", root/"Native/Updates.swift", root/"Native/Tests/Update/main.swift", "-o", fixture)
    for damaged in [True, False]:
        home = test/("bad" if damaged else "good")
        home.mkdir()
        app = home/"Release Test.app"
        dest = home/"next"/app.name
        ident = "io.github.digidai.samare.update-test." + uuid.uuid4().hex
        channel = home/"channel"
        appfiles = app/"Contents"
        (appfiles/"MacOS").mkdir(parents=True)
        (appfiles/"Frameworks").mkdir()
        (appfiles/"Resources/Updates").mkdir(parents=True)
        shutil.copy2(fixture, appfiles/"MacOS/Samare")
        run("ditto", runtime, appfiles/"Resources/Runtime")
        shutil.copy2(root/"Updates/channel.py", appfiles/"Resources/Updates/channel.py")
        run("ditto", sdk/"Sparkle.framework", appfiles/"Frameworks/Sparkle.framework")
        info = plistlib.loads((root/"Info.plist").read_bytes())
        info.update(SUPublicEDKey=public_key,CFBundleIdentifier=ident, CFBundleDisplayName="Release Test", CFBundleName="Release Test", CFBundleVersion="1", CFBundleShortVersionString="1.0")
        (appfiles/"Info.plist").write_bytes(plistlib.dumps(info))
        run("/usr/bin/codesign", "-f", "-s", "-", app)
        run("ditto", app, dest)
        info.update(CFBundleVersion="2", CFBundleShortVersionString="1.1")
        (dest/"Contents/Info.plist").write_bytes(plistlib.dumps(info))
        run("/usr/bin/codesign", "-f", "-s", "-", dest)
        run(root/"Updates/package-release.py","--app",dest,"--channel",channel,"--key",key)
        if not damaged:
            check_during_background(test/"background", dest, (channel/"appcast.xml").read_bytes())
        if damaged:
            archive=next(channel.glob("Samare-2-*.zip"))
            with archive.open("r+b") as stream:
                stream.seek(30); b=stream.read(1); stream.seek(30); stream.write(bytes([b[0]^1]))
        process = subprocess.Popen([appfiles/"MacOS/Samare"], stdout=subprocess.DEVNULL)
        log=home/"events"
        try:
            if damaged:
                s=wait_for(log,"error ")
                assert "available" in s and "installing" in s and plistlib.loads((appfiles/"Info.plist").read_bytes())["CFBundleVersion"]=="1", s
                print("Tampered archive rejected, installed build still 1.", flush=True)
            else:
                s=wait_for(log,"up to date",seconds=90)
                assert "launch 1 card false" in s and "launch 2 card true" in s and "installing 99" in s,s
                time.sleep(.5)
                run("open","-n",app)
                s=wait_for(log,"up to date",count=2)
                assert "launch 2 card false" in s,s
                print("Automatic discovery, signed download, replacement, relaunch, one-shot card, same-build restart and manual up-to-date check passed.",flush=True)
        finally:
            if process.poll() is None: process.terminate()
            process.wait(timeout=10)
            subprocess.run(["defaults","delete",ident],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
