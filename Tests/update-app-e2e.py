"""Operate independently labelled copies of the packaged application through macOS Accessibility."""
import pathlib
import plistlib
import shutil
import subprocess
import tempfile
import time
import uuid

root = pathlib.Path(__file__).resolve().parents[1]
bundle = root/"build/Samare.app"
ax = root/"build/update-ui-accessibility"
def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)
run("swiftc",root/"Native/Tests/UpdateUI/main.swift","-o",ax)
ident = "io.github.digidai.samare.ui-test." + uuid.uuid4().hex
def control(*args):
    return subprocess.run([ax,ident,*args], capture_output=True, text=True)
def wait(action, target="", timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if control(action,target).returncode==0: return
        time.sleep(.18)
    raise AssertionError(action+" "+target+"\n"+control("dump").stdout[-2800:])
with tempfile.TemporaryDirectory(prefix="packaged-update-",dir=root/"build") as temp:
    path=pathlib.Path(temp)
    key = path/"test-key"
    public_key = subprocess.check_output(["swift",root/"Updates/new-key.swift",key],text=True).strip()
    app=path/"Samare QA.app"
    new=path/"next"/app.name
    feed=path/"channel"
    feed.mkdir()
    note=path/"Update workflow.md"
    note.write_text("# Saved note\n\nKeep this paragraph through the upgrade.\n")
    server=subprocess.Popen(["/usr/bin/python3","-I","-u",root/"Updates/channel.py",feed],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
    port=int(server.stdout.readline().strip())
    try:
        run("ditto",bundle,app)
        for subdir in ["Contents/Resources/Bridge","Contents/PlugIns"]:
            shutil.rmtree(app/subdir)
        infofile=app/"Contents/Info.plist"
        info=plistlib.loads(infofile.read_bytes())
        info.update(SUPublicEDKey=public_key,CFBundleIdentifier=ident,CFBundleDisplayName="Samare QA",CFBundleName="Samare QA",CFBundleVersion="1",CFBundleShortVersionString="0.1.0",SUFeedURL=f"http://127.0.0.1:{port}/appcast.xml")
        for declaration in ["CFBundleURLTypes","CFBundleDocumentTypes","UTImportedTypeDeclarations"]:
            info.pop(declaration,None)
        infofile.write_bytes(plistlib.dumps(info))
        run("codesign","--force","--sign","-",app)
        run("ditto",app,new)
        info.update(CFBundleVersion="2",CFBundleShortVersionString="0.1.1")
        (new/"Contents/Info.plist").write_bytes(plistlib.dumps(info))
        run("codesign","--force","--sign","-",new)
        run(root/"Updates/package-release.py","--app",new,"--channel",feed,"--key",key)
        process = subprocess.Popen([app/"Contents/MacOS/Samare","--file",note])
        wait("find","Keep this paragraph")
        wait("press","Update to Samare 0.1.1")
        wait("find","What’s new in Samare",70)
        assert plistlib.loads(infofile.read_bytes())["CFBundleVersion"]=="2"
        wait("press","Close")
        wait("find","Keep this paragraph")
        wait("menu","Check for Updates")
        wait("find","up to date")
        wait("quit")
        for _ in range(80):
            if control("pid").returncode:break
            time.sleep(.1)
        run("open","-n",app)
        wait("find","Keep this paragraph")
        time.sleep(.4)
        assert control("find","What’s new in Samare").returncode!=0
        wait("menu","What’s New in Samare")
        wait("find","What’s new in Samare")
        assert note.read_text()=="# Saved note\n\nKeep this paragraph through the upgrade.\n"
        print("Packaged UI verified: automatic badge, AX click, real app replacement/relaunch, restored note, one-shot card, manual check, no repeat on reopening, Help reopens card.")
    finally:
        control("quit")
        server.stdin.close()
        server.wait(timeout=8)
        server.stdout.close()
        time.sleep(.3)
        subprocess.run(["defaults","delete",ident],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
