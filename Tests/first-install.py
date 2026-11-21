"""Mount the installer, copy to an empty Applications directory, and exercise first use."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import time
from urllib.request import urlopen
import uuid


ROOT = Path(__file__).resolve().parents[1]
AX = ROOT / 'build/update-ui-accessibility'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs).stdout.strip()


@contextlib.contextmanager
def mounted(image, mountpoint):
    mountpoint.mkdir()
    run('hdiutil', 'attach', '-quiet', '-readonly', '-nobrowse', '-mountpoint', mountpoint, image)
    try:
        yield mountpoint
    finally:
        run('diskutil', 'eject', mountpoint)


def wait_for(check, description, seconds=20):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(.15)
    raise AssertionError('Timed out waiting for ' + description)


def fresh_environment(folder):
    home = folder / 'home'
    home.mkdir()
    for client in ['.codex', '.claude', '.cursor']:
        (home / client).mkdir()
    state = home / 'Library/Application Support/Samare/Bridge'
    forbidden = folder / 'system-python'
    forbidden.mkdir()
    marker = folder / 'external-python-invoked'
    shim = forbidden / 'python3'
    shim.write_text('#!/bin/sh\n/usr/bin/touch "$SAMARE_PYTHON_PROBE"\nexit 90\n')
    shim.chmod(0o755)
    return home, dict(os.environ, HOME=str(home), CFFIXED_USER_HOME=str(home),
        SAMARE_BRIDGE_HOME=str(state), SAMARE_INTEGRATION_HOME=str(home),
        PATH=str(forbidden) + ':/usr/bin:/bin:/usr/sbin:/sbin', DEVELOPER_DIR=str(folder/'no-CLT'),
        SAMARE_PYTHON_PROBE=str(marker)), marker


def doctor(helper, env):
    return json.loads(run(helper, 'doctor', '--json', env=env))


def test_agent(app, folder):
    home, env, marker = fresh_environment(folder)
    resources = app / 'Contents/Resources'
    helper = resources / 'Bridge/samare'
    state = Path(env['SAMARE_BRIDGE_HOME'])
    assert not state.exists() and not (home/'.local').exists()
    run(helper, 'app-open', env=env)
    assert not doctor(helper, env)['enabled'] and not state.exists()
    note = home / 'first note.md'
    note.write_text('# First note\n\nAn unmodified document.\n')
    try:
        run(helper, 'enable', env=env)
        status = doctor(helper, env)
        assert status['running'] and status['commandInstalled'] and all(status['clients'].values())
        for details in status['clientDetails'].values():
            assert 'samare' in Path(details['path']).read_text()
        launcher = home / '.local/bin/samare'
        link = run(launcher, 'url', note, env=env)
        page = link.replace('/d/', '/api/')
        with urlopen(page, timeout=5) as response:
            assert json.load(response)['text'] == note.read_text()
        run(helper, 'app-close', env=env)
        assert not doctor(helper, env)['running']
        run(helper, 'app-open', env=env)
        assert doctor(helper, env)['running'] and run(launcher, 'url', note, env=env) == link
        with urlopen(page, timeout=5) as response:
            assert json.load(response)['text'] == note.read_text()
        assert not marker.exists()
        print('Mounted installer: clean Bridge, command, 3 skills, original link survives close/reopen, external Python trap untouched.', flush=True)
    finally:
        run(helper, 'stop', env=env)


def label_qa_copy(app, target):
    # cfprefsd is per login user and ignores CFFIXED_USER_HOME for preference domains.
    # Use a temporary domain to protect an existing installation while retaining product executable bytes.
    run('ditto', app, target)
    info = target / 'Contents/Info.plist'
    config = plistlib.loads(info.read_bytes())
    ident = 'io.github.digidai.samare.clean-fixture.' + uuid.uuid4().hex
    config['CFBundleIdentifier'] = ident
    for key in ['CFBundleURLTypes', 'CFBundleDocumentTypes', 'UTImportedTypeDeclarations']:
        config.pop(key, None)
    info.write_bytes(plistlib.dumps(config))
    plugin = next((target/'Contents/PlugIns').glob('*.appex'))
    plugin_info = plugin/'Contents/Info.plist'
    data = plistlib.loads(plugin_info.read_bytes())
    data['CFBundleIdentifier'] = ident + '.preview'
    plugin_info.write_bytes(plistlib.dumps(data))
    run('codesign', '-f', '-s', '-', '--entitlements', ROOT/'Native/QuickLook/Entitlements.plist', plugin)
    run('codesign', '-f', '-s', '-', target)
    return ident


def test_ui(app, folder, first_file):
    qa = folder/'Samare QA.app'
    ident = label_qa_copy(app, qa)
    home, env, marker = fresh_environment(folder)
    note = home/'First File.md'
    note.write_text('# First file\n\nDocument supplied at first launch.\n')
    helper = qa/'Contents/Resources/Bridge/samare'
    launch_services = False
    def control(op, label=''):
        target = str(process.pid) if process and process.poll() is None and not launch_services else ident
        return subprocess.run([AX,target,op,label], capture_output=True).returncode == 0
    def until(op,label=''):
        try:
            wait_for(lambda: control(op,label),op + ' ' + label)
        except AssertionError:
            target = str(process.pid) if process and process.poll() is None and not launch_services else ident
            print(run(AX,target,'dump')[:4500],flush=True)
            raise
    process = None
    def launch(document=None):
        nonlocal process, launch_services
        launch_services = document is not None
        command = [qa/'Contents/MacOS/Samare']
        if document is not None:
            # Deliver a real macOS open-documents event to a process that has never opened a window.
            command = ['/usr/bin/open','-W','-n','-a',qa]
            for key in ['HOME','CFFIXED_USER_HOME','SAMARE_BRIDGE_HOME','SAMARE_INTEGRATION_HOME','PATH','DEVELOPER_DIR','SAMARE_PYTHON_PROBE']:
                command.extend(['--env',key+'='+env[key]])
            command.append(document)
        process = subprocess.Popen(command, env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def close():
        if process and process.poll() is None:
            until('quit'); process.wait(timeout=20)
    try:
        launch(note if first_file else None)
        expected = 'Document supplied at first launch' if first_file else 'Edit Markdown and data files in place.'
        until('find',expected)
        assert not control('find','What’s new in Samare')
        assert not doctor(helper,env)['enabled']
        assert not (home/'Library/Application Support/Samare/Samples').exists()
        if not first_file:
            until('find','Add workspace')
            until('press','Add workspace'); until('press','Cancel'); until('find',expected)
            time.sleep(.55)  # Allow the native open panel's dismissal animation to finish.
            until('menu','Settings'); until('find','Install Samare in Applications')
            until('press','Enable Use in Agent')
            wait_for(lambda: doctor(helper,env)['commandInstalled'], 'in-app installation')
            assert all(doctor(helper,env)['clients'].values())
            until('menu','Check for Updates')
            has_feed = 'SUFeedURL' in plistlib.loads((app/'Contents/Info.plist').read_bytes())
            until('find','up to date' if has_feed else 'no update feed configured')
            print('Clean first launch: home, no upgrade card, Settings enables command and 3 client skills; update menu reports the build’s configuration.',flush=True)
        close(); launch(); until('find',expected)
        assert not control('find','What’s new in Samare') and not marker.exists()
        if not first_file: assert doctor(helper,env)['running']
        assert note.read_text() == '# First file\n\nDocument supplied at first launch.\n'
        print('Initial document and restored session passed.' if first_file else 'Empty home and Bridge setting survived restart.', flush=True)
    finally:
        if process and process.poll() is None:
            if not control('quit'): process.terminate()
            process.wait(timeout=20)
        subprocess.run([helper,'stop'],env=env,capture_output=True)
        subprocess.run(['defaults','delete',ident],capture_output=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('dmg', nargs='?', type=Path, default=ROOT/'build/Samare.dmg')
    parser.add_argument('--without-ui', action='store_true')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='first-install-') as tmp:
        path=Path(tmp)
        installed=path/'Applications/Samare.app'
        with mounted(args.dmg.resolve(),path/'volume') as vol:
            assert (vol/'Applications').readlink() == Path('/Applications')
            run('ditto',vol/'Samare.app',installed)
        run('codesign','--verify','--deep','--strict',installed)
        agent=path/'agent'; agent.mkdir(); test_agent(installed,agent)
        if not args.without_ui:
            run('swiftc',ROOT/'Native/Tests/UpdateUI/main.swift','-o',AX)
            for first_file in [False,True]:
                folder=path/('file' if first_file else 'empty'); folder.mkdir()
                test_ui(installed,folder,first_file)
