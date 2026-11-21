"""Exercise the local document bridge with an isolated temporary home and documents."""
import concurrent.futures
from contextlib import closing
import errno
import importlib.machinery
import importlib.util
import plistlib
from unittest.mock import patch
import json
import fcntl
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
import os
from pathlib import Path
import sqlite3
import signal
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit

BRIDGE = Path(__file__).resolve().parents[1] / "Bridge" / "samare"


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        home = root / "integrations"
        self.env = dict(os.environ, HOME=str(home), CFFIXED_USER_HOME=str(home),
                        PATH="/usr/bin:/bin", SAMARE_DETECTED_CLIENTS="",
                        SAMARE_BRIDGE_HOME=str(root / "db"), SAMARE_INTEGRATION_HOME=str(home))
        self.doc = root / "A note (例).md"
        self.doc.write_bytes(b"\xef\xbb\xbf# Notes\r\n\r\nTwo lines.\r\n")
        self.addCleanup(self.cli, "stop")
        self.cli("enable")
        self.link = self.cli("url", str(self.doc))
        parts = urlsplit(self.link)
        self.origin = parts.scheme + "://" + parts.netloc
        self.id = parts.path.split("/")[-1]
        self.api = self.origin + "/api/" + self.id

    def cli(self, *args):
        return subprocess.check_output([sys.executable, str(BRIDGE), *args], env=self.env, text=True).strip()

    def request(self, url, data=None, **headers):
        if data is not None:
            data = json.dumps(data).encode()
            headers.setdefault("Content-Type", "application/json")
        try:
            reply = urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=5)
        except urllib.error.HTTPError as exc:
            reply = exc
        with reply:
            return reply.status, reply.read()

    def test_open_in_app_requires_the_document_origin_and_registered_file(self):
        endpoint = self.origin + "/api/docs/" + self.id + "/open-in-app"
        self.assertEqual(self.request(endpoint, {})[0], 403)
        self.assertEqual(self.request(endpoint, {}, Origin="https://example.org")[0], 403)
        self.assertEqual(self.request(endpoint, {}, Origin=self.origin, Host="example.org")[0], 403)
        self.assertEqual(self.request(endpoint, {"path": str(self.doc)}, Origin=self.origin)[0], 400)
        unknown = endpoint.replace(self.id, "0" * 32)
        self.assertEqual(self.request(unknown, {}, Origin=self.origin)[0], 404)
        renamed = self.doc.with_suffix(".old")
        self.doc.rename(renamed)
        self.assertEqual(self.request(endpoint, {}, Origin=self.origin)[0], 404)
        self.doc.symlink_to(renamed)
        self.assertEqual(self.request(endpoint, {}, Origin=self.origin)[0], 404)

    def test_display_path_and_restored_registered_document(self):
        workspace = self.doc.parent / "workspace"
        folder = workspace / "notes" / "nested"
        folder.mkdir(parents=True)
        note = folder / "Sample.md"
        note.write_text("# Local sample")
        link = self.cli("url", str(note), "--asset-root", str(workspace))
        api = link.replace("/d/", "/api/")
        data = json.loads(self.request(api)[1])
        self.assertEqual(data["displayPath"], "nested/Sample.md")
        previous = folder / "elsewhere"
        note.rename(previous)
        self.assertEqual(self.request(api)[0], 404)
        self.assertEqual(self.request(api, {"text": "Draft", "version": data["version"]}, Origin=self.origin)[0], 404)
        self.assertFalse(note.exists())
        previous.rename(note)
        self.assertEqual(self.request(api, **{"If-None-Match": '"' + data["version"] + '"'})[0], 304)
        self.assertEqual(self.cli("url", str(note)), link)

    @unittest.skipUnless(os.environ.get("PLAYWRIGHT_MODULE"), "set PLAYWRIGHT_MODULE to enable the real Chrome fixture")
    def test_browser_lifecycle(self):
        folder = self.doc.parent / "notes"
        folder.mkdir()
        note = folder / "Lifecycle Study.md"
        note.write_text("# Synthetic\n\nFixture paragraph.\n")
        link = self.cli("url", str(note))
        fixture = Path(__file__).with_name("bridge-lifecycle.cjs")
        subprocess.run(["node", str(fixture)], input=json.dumps({"url": link, "file": str(note)}),
                       text=True, check=True, timeout=75)

    @unittest.skipUnless(os.environ.get("PLAYWRIGHT_MODULE"), "set PLAYWRIGHT_MODULE for data-link editing")
    def test_agent_data_links_save_in_browser(self):
        inputs = {"csv": "Name,Value\nAlpha,1\n", "json": '{"name":"Alpha"}\n', "jsonl": '{"name":"Alpha"}\n{"name":"Alpha"}\n'}
        cases = []
        for ext, text in inputs.items():
            doc = self.doc.parent / ("table sample." + ext)
            doc.write_text(text)
            cases.append(dict(kind=ext, path=str(doc), url=self.cli("url", str(doc)), initial=text))
        subprocess.run(["node", str(Path(__file__).with_name("bridge-data-links.cjs"))],
                       input=json.dumps(cases), text=True, check=True, timeout=110)

    @unittest.skipUnless(os.environ.get("PLAYWRIGHT_MODULE"), "set PLAYWRIGHT_MODULE to enable the real Chrome fixture")
    def test_browser_reader_controls(self):
        files = {}
        docs = {
            "Alpha.md": "---\ntags: [fixture]\n---\n\n# Alpha Study\n\nAlpha alpha ALPHA. 中文测试。\n\n## Second\n\n[Go to Beta](Beta.md) and [[Beta]].\n",
            "Beta.md": "# Beta Study\n\n" + ("A sentence.\n\n" * 130) + "## Destination\n\nFinal words here.\n",
            "Gamma.md": "# Gamma Study\n\nA new branch.\n",
            "Long.md": "# Long study\n\n" + "A sample paragraph.\n\n" * 1100 + "The distant needle.\n",
            "Large source.md": "Line at a time.\n" * 20400 + "Faraway [needle].\n",

            "Table.csv": "Task,Owner\n" + "".join(f'Task {n},Echo' + (' echo eCHO' if n == 291 else '') + '\n' for n in range(1,302)),
        }
        for name, content in docs.items():
            file = self.doc.parent / name
            file.write_text(content)
            files[name] = {"url": self.cli("url", str(file)), "path": str(file)}
        fixture = Path(__file__).with_name("bridge-reader.cjs")
        subprocess.run(["node", str(fixture)], input=json.dumps(files), text=True, check=True, timeout=100)

    @unittest.skipUnless(os.environ.get("PLAYWRIGHT_MODULE"), "set PLAYWRIGHT_MODULE to enable the real Chrome fixture")
    def test_browser_merge_review(self):
        note = self.doc.parent / "Merge sample.md"
        note.write_text("# Trial")
        fixture = Path(__file__).with_name("bridge-merge.cjs")
        subprocess.run(["node", str(fixture)], input=json.dumps({"url": self.cli("url", str(note)), "file": str(note)}),
                       text=True, check=True, timeout=90)

    @unittest.skipUnless(os.environ.get("PLAYWRIGHT_MODULE"), "set PLAYWRIGHT_MODULE for the real Chrome search fixture")
    def test_progressive_find_during_first_paint(self):
        note = self.doc.parent / "Progressive.md"
        block = "A common sample with *visible emphasis* and more ordinary words for measuring early query input. " * 4
        note.write_text("# Progressive reading\n\n" + (block.strip() + "\n\n")*4500 + "A unique **formatted** needle.\n")
        fixture = Path(__file__).with_name("bridge-find.cjs")
        subprocess.run(["node", str(fixture)], input=json.dumps({"url":self.cli("url",str(note)),"file":str(note)}),
                       text=True, check=True, timeout=115)

    def test_occupied_port_renews_only_the_document_origin(self):
        self.cli("stop")
        port = urlsplit(self.link).port

        class Occupant(BaseHTTPRequestHandler):
            stop_requests = 0

            def do_GET(self):
                self.send_error(503)

            def do_POST(self):
                Occupant.stop_requests += 1
                self.send_error(405)

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", port), Occupant) as occupant:
            worker = threading.Thread(target=occupant.serve_forever, daemon=True)
            worker.start()
            try:
                state = json.loads(self.cli("doctor", "--json"))
                self.assertFalse(state["running"])
                self.assertEqual(state["port"], port)
                self.cli("stop")
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    urls = list(pool.map(lambda _: self.cli("url", str(self.doc)), range(4)))
                self.assertEqual(len(set(urls)), 1)
                renewed = urlsplit(urls[0])
                previous = urlsplit(self.link)
                self.assertEqual((renewed.scheme, renewed.hostname, renewed.path),
                                 (previous.scheme, previous.hostname, previous.path))
                self.assertNotEqual(renewed.port, previous.port)
                state = json.loads(self.cli("doctor", "--json"))
                self.assertEqual(state["savedPort"], port)
                self.assertEqual(state["servingPorts"], [renewed.port])
                self.assertEqual(state["portConflict"]["port"], port)
                self.assertEqual(state["portConflict"].get("pid"), os.getpid())
                self.assertTrue(state["portConflict"].get("process"))
                api = urls[0].replace("/d/", "/api/")
                base = json.loads(self.request(api)[1])
                self.assertEqual(self.request(api, {"text": "Saved through new port", "version": base["version"]},
                                              Origin=renewed.scheme + "://" + renewed.netloc)[0], 200)
                self.assertIn(b"Saved through new port", self.doc.read_bytes())
                self.assertEqual(self.request(self.origin + "/fixture-still-listening")[0], 503)
                self.assertEqual(Occupant.stop_requests, 0)
            finally:
                occupant.shutdown()
                worker.join()
        # No new command, new link, restart or app-open is needed to reclaim the saved origin.
        for _ in range(50):
            try:
                if self.request(self.api)[0] == 200:
                    break
            except urllib.error.URLError:
                pass
            time.sleep(.1)
        self.assertEqual(self.request(self.api)[0], 200)
        state = json.loads(self.cli("doctor", "--json"))
        self.assertEqual(set(state["servingPorts"]), {port, renewed.port})
        self.assertIsNone(state["portConflict"])
        self.assertEqual(self.cli("url", str(self.doc)), self.link)
        self.cli("stop")
        self.assertEqual(self.cli("url", str(self.doc)), self.link)
        self.assertEqual(json.loads(self.request(api)[1])["text"], json.loads(self.request(self.api)[1])["text"])

    def test_old_helper_upgrade_and_wake(self):
        self.cli("stop")
        prior = self.doc.parent / "prior"
        prior.mkdir()
        old = prior / "samare"
        code = BRIDGE.read_text().replace('{"running": True, "build": SERVICE_BUILD,', '{"running": True,')
        old.write_text(code)
        (prior / "references.py").write_bytes(BRIDGE.with_name("references.py").read_bytes())
        old_process = subprocess.Popen([sys.executable, str(old), "serve"], env=self.env)
        def cleanup():
            if old_process.poll() is None:
                old_process.terminate()
                old_process.wait(5)
        self.addCleanup(cleanup)
        for _ in range(60):
            if json.loads(self.cli("doctor", "--json"))["running"]:
                break
            time.sleep(.04)
        self.assertIsNone(old_process.poll())
        self.cli("app-open")
        self.assertEqual(old_process.wait(5), 0)
        self.assertEqual(self.request(self.api)[0], 200)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: self.cli("app-open"), range(4)))
        self.assertEqual(self.cli("url", str(self.doc)), self.link)
        self.assertEqual(self.cli("resolve", self.id), str(self.doc.resolve()))

    def test_suspended_owned_helper_resumes_without_changing_links(self):
        self.cli("stop")
        with subprocess.Popen([sys.executable, str(BRIDGE), "serve"], env=self.env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as service:
            try:
                for _ in range(40):
                    if json.loads(self.cli("doctor", "--json"))["running"]:
                        break
                    time.sleep(.05)
                self.assertEqual(self.request(self.api)[0], 200)
                service.send_signal(signal.SIGSTOP)
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    wake = pool.submit(self.cli, "app-open")
                    time.sleep(.85)
                    service.send_signal(signal.SIGCONT)
                    wake.result(timeout=8)
                self.assertIsNone(service.poll())
                self.assertEqual(self.cli("url", str(self.doc)), self.link)
                data = json.loads(self.request(self.api)[1])
                self.assertEqual(self.request(self.api, {"text":"After wake", "version":data["version"]},
                                              Origin=self.origin)[0], 200)
                self.assertIn(b"After wake", self.doc.read_bytes())
            finally:
                if service.poll() is None:
                    service.send_signal(signal.SIGCONT)
                    self.cli("stop")
                    if service.poll() is None:
                        service.terminate()

    def test_review_close_cannot_overwrite_a_newer_revision(self):
        session = "ab"*16
        old = json.loads(self.request(self.api)[1])
        self.assertEqual(self.request(self.api, {"text":old["text"], "version":old["version"],
                                                "reviewSession":session,"preparedReview":"old conflict"}, Origin=self.origin)[0], 200)
        self.doc.write_text("Other writer")
        self.assertEqual(self.request(self.api, {"finishReview":True,"reviewSession":session}, Origin=self.origin)[0], 409)
        self.assertEqual(self.request(self.api, {"version":old["version"],"reviewSession":session,
                                                "reviewPatch":{"from":0,"to":0,"text":"old draft"}}, Origin=self.origin)[0], 409)
        self.assertEqual(self.doc.read_text(),"Other writer")

    def test_lifecycle_and_conflict(self):
        self.assertEqual(self.cli("url", str(self.doc)), self.link)
        self.assertEqual(self.cli("resolve", self.id), str(self.doc.resolve()))
        self.assertEqual(json.loads(self.cli("doctor","--json"))["running"], True)
        self.assertEqual(self.request(self.link)[0],200)
        code,body = self.request(self.api)
        self.assertEqual(code,200)
        row = json.loads(body)
        self.assertEqual(row["name"], self.doc.name)
        self.assertNotIn(str(self.doc.parent), body.decode())
        change = dict(version=row["version"], text="Replacement\n")
        self.assertEqual(self.request(self.api, change)[0],403)
        self.assertEqual(self.request(self.api, change, Origin="https://example.org")[0],403)
        self.assertEqual(self.request(self.api, Host="example.org")[0],403)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            replies=list(pool.map(lambda _: self.request(self.api, change, Origin=self.origin)[0], range(2)))
        self.assertEqual(sorted(replies),[200,409])
        self.assertEqual(self.doc.read_bytes(),b"\xef\xbb\xbfReplacement\r\n")
        self.assertEqual(self.request(self.origin+"/api/"+"0"*32)[0],404)
        self.assertEqual(self.request(self.origin+"/private-file.txt")[0],404)
        self.assertEqual(self.request(self.origin+"/editor.js")[0],200)
        self.assertEqual(self.request(self.origin+"/vendor/mermaid.min.js")[0],200)
        self.cli("app-close")
        self.assertFalse(json.loads(self.cli("doctor","--json"))["running"])
        self.cli("app-open")
        self.assertTrue(json.loads(self.cli("doctor","--json"))["running"])
        self.cli("disable")
        self.cli("app-open")
        self.assertFalse(json.loads(self.cli("doctor","--json"))["running"])
        disabled = subprocess.run([sys.executable,str(BRIDGE),"url",str(self.doc)],env=self.env,capture_output=True)
        self.assertNotEqual(disabled.returncode,0)
        self.cli("enable")
        self.assertEqual(self.cli("url",str(self.doc)),self.link)


    @unittest.skipUnless((BRIDGE.parents[1] / "build/native-save-fixture").is_file(), "build native-save-fixture to run the two-process race")
    def test_native_and_browser_writes_share_a_lock(self):
        fixture = BRIDGE.parents[1] / "build/native-save-fixture"
        root = self.doc.parent
        docs = root / "race-documents"
        docs.mkdir()
        path = docs / "race.md"
        outcomes = set()
        for attempt in range(8):
            base = "Common revision " + str(attempt)
            browser = "Browser revision " + str(attempt)
            native = "Mac revision " + str(attempt)
            path.write_text(base)
            parts = urlsplit(self.cli("url", str(path)))
            url = self.origin + parts.path.replace("/d/", "/api/")
            version = json.loads(self.request(url)[1])["version"]
            ready, gate = root / ("ready-" + str(attempt)), root / ("gate-" + str(attempt))
            dispatched = threading.Event()

            def browser_save():
                conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=10)
                try:
                    conn.request("POST", urlsplit(url).path, json.dumps({"version":version, "text":browser}), {"Origin":self.origin, "Content-Type":"application/json"})
                    dispatched.set()
                    reply = conn.getresponse()
                    reply.read()
                    return reply.status
                finally:
                    conn.close()

            lockfd = os.open(str(docs), os.O_RDONLY | os.O_DIRECTORY)
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                child = None
                try:
                    fcntl.flock(lockfd, fcntl.LOCK_EX)
                    child = subprocess.Popen([str(fixture), str(path), base, native, str(ready), str(gate)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    until = time.monotonic() + 8
                    while not ready.exists() and child.poll() is None and time.monotonic() < until:
                        time.sleep(.01)
                    self.assertTrue(ready.exists(), "Native writer did not reach the gate")
                    if attempt % 2:
                        gate.touch()
                        time.sleep(.08)
                    future = pool.submit(browser_save)
                    self.assertTrue(dispatched.wait(5))
                    if not gate.exists():
                        time.sleep(.08)
                        gate.touch()
                    time.sleep(.08)
                    self.assertIsNone(child.poll(), "Native writer ignored the held directory lock")
                    self.assertFalse(future.done(), "Bridge writer ignored the held directory lock")
                    self.assertEqual(path.read_text(), base)
                finally:
                    os.close(lockfd)
                    if child is not None and not gate.exists():
                        gate.touch()
                try:
                    _, native_error = child.communicate(timeout=12)
                    status = future.result(timeout=6)
                    pair = (child.returncode, status)
                    self.assertIn(pair, ((0,409),(2,200)), native_error)
                    self.assertEqual(path.read_text(), native if pair[0] == 0 else browser)
                    outcomes.add(pair)
                finally:
                    if child is not None and child.poll() is None:
                        child.kill()
                        child.communicate()
        self.assertEqual(outcomes, {(0,409), (2,200)})


    def test_scoped_raster_and_registered_note_references(self):
        workspace = self.doc.parent / "workspace"
        docs, media = workspace / "notes", workspace / "media"
        docs.mkdir(parents=True)
        media.mkdir()
        valid = b"\x89PNG\r\n\x1a\n" + b"dummy pixel data"
        (media / "Test Figure.png").write_bytes(valid)
        (media / "unmentioned.png").write_bytes(valid)
        (media / "inactive.png").write_bytes(valid)
        (media / "wrong-format.png").write_text("<svg></svg>")
        (media / "vector.svg").write_text("<svg></svg>")
        outside = self.doc.parent / "outside.png"
        outside.write_bytes(valid)
        (media / "escape.png").symlink_to(outside)
        source = docs / "Source.md"
        source.write_text("# My note\n![figure](<../media/Test Figure.png>)\n![](../media/escape.png)\n![](../../outside.png)\n![](../media/vector.svg)\n![](../media/wrong-format.png)\n```md\n![](../media/inactive.png)\n```\n[[Target#Chapter]] · [missing](Unlinked.md)\n")
        linked = docs / "Target.md"; linked.write_text("# Chapter")
        (docs / "Unlinked.md").write_text("unregistered")
        linked_id = self.cli("url", str(linked)).split("/")[-1]
        source_id = self.cli("url","--asset-root",str(workspace),str(source)).split("/")[-1]
        def call(endpoint, ref):
            return self.request(self.origin + "/" + endpoint + "/" + source_id + "?ref=" + quote(ref,safe=""))
        self.assertEqual(call("image","../media/Test Figure.png"),(200, valid))
        for target in ("../media/unmentioned.png","../media/inactive.png","../media/wrong-format.png","../media/vector.svg","../../outside.png","../media/escape.png","../media"):
            self.assertEqual(call("image",target)[0],404,target)
        status,body=call("link","Target#Chapter")
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body),{"id":linked_id,"heading":"Chapter"})
        self.assertEqual(call("link","Unlinked.md")[0],404)
        self.assertEqual(call("link","Source.md")[0],404)


    def test_link_id_with_leading_dash(self):
        database = Path(self.env["SAMARE_BRIDGE_HOME"]) / "bridge.sqlite3"
        with closing(sqlite3.connect(str(database))) as conn:
            identifier = "-" + "a" * 31
            conn.execute("UPDATE documents SET id=? WHERE id=?", (identifier, self.id))
            conn.commit()
        self.assertEqual(self.cli("resolve", identifier), str(self.doc.resolve()))


    def test_browser_document_larger_than_two_megabytes(self):
        large = self.doc.with_name("large.txt")
        text = "文档 line\n" * 250000
        large.write_text(text)
        link = self.cli("url", str(large)).replace("/d/", "/api/")
        status, data = self.request(link)
        self.assertEqual(status, 200)
        payload = json.loads(data)
        self.assertEqual(payload["text"], text)
        self.assertGreater(len(text.encode()), 2 * 1024 * 1024)
        update = dict(version=payload["version"], text=text + "end")
        self.assertEqual(self.request(link, update, Origin=self.origin)[0], 200)
        self.assertTrue(large.read_bytes().endswith(b"end"))


class IntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        loader = importlib.machinery.SourceFileLoader("samare_bridge_test", str(BRIDGE))
        self.bridge = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
        with patch.object(sys, "dont_write_bytecode", True), patch.object(sys, "path", [str(BRIDGE.parent), *sys.path]):
            loader.exec_module(self.bridge)
        self.bridge.STATE = root / "state"
        self.bridge.INTEGRATION_HOME = root / "home"
        self.bridge.prepare()

    def test_wake_waits_for_the_existing_helper_without_spawning(self):
        bridge = self.bridge
        env = dict(os.environ, SAMARE_BRIDGE_HOME=str(bridge.STATE),
                   SAMARE_INTEGRATION_HOME=str(bridge.INTEGRATION_HOME))
        bridge.set_value("enabled", "1")
        with subprocess.Popen([sys.executable, str(BRIDGE), "serve"], env=env) as service:
            try:
                deadline = time.monotonic() + 5
                while not bridge.control("status"):
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(.04)
                service.send_signal(signal.SIGSTOP)
                # A suspended process retains the exclusive service lock, even
                # after its initial HTTP health check has timed out.
                with patch.object(bridge, "spawn_service", side_effect=AssertionError("duplicate service startup")):
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                        result = pool.submit(bridge.start_service)
                        time.sleep(1.5)
                        service.send_signal(signal.SIGCONT)
                        self.assertEqual(result.result(timeout=6)["pid"], service.pid)
            finally:
                if service.poll() is None:
                    service.send_signal(signal.SIGCONT)
                    service.terminate()

    def test_bind_errors_other_than_occupancy_are_reported(self):
        b = self.bridge
        denied = PermissionError(errno.EACCES, "Permission denied by test")
        with patch.object(b, "ThreadingHTTPServer", side_effect=denied) as bind:
            with self.assertRaisesRegex(PermissionError, "Permission denied by test"):
                b.bind_server(17001)
            bind.assert_called_once_with((b.HOST, 17001), b.Handler)

        # Exercise real spawn, stderr redirection, process exit, and the offset
        # that isolates this attempt's diagnostic from an earlier log entry.
        (b.STATE / "service.log").write_text("Bridge: stale diagnostic from an earlier launch\n")
        failing_helper = b.STATE / "bind-failure-fixture.py"
        failing_helper.write_text("import sys\nprint('Bridge: [Errno 13] Permission denied by test', file=sys.stderr)\nsys.exit(1)\n")
        with patch.object(b, "__file__", str(failing_helper)):
            with self.assertRaisesRegex(ValueError, "Errno 13.*Permission denied by test"):
                b.start_service()

    def test_skill_clients(self):
        b = self.bridge
        for client in b.CLIENT_DIRS:
            self.assertFalse(b.integrations()[client])
            b.change_skill(client, True)
            self.assertTrue(b.integrations()[client])
            skill = b.skill_path(client)
            self.assertIn("samare", skill.read_text())
            original = skill.read_text()
            skill.write_text(original + "private customization")
            with self.assertRaises(ValueError):
                b.change_skill(client, False)
            self.assertTrue(skill.exists())
            skill.write_text(original)
            b.change_skill(client, False)
            self.assertFalse(skill.exists())

    def test_setup_cli_and_managed_launchers(self):
        home = Path(self.tmp.name) / "isolated home"
        state = home / "Library/Application Support/Samare/Bridge"
        env = dict(os.environ, HOME=str(home), CFFIXED_USER_HOME=str(home),
                   SAMARE_INTEGRATION_HOME=str(home), SAMARE_BRIDGE_HOME=str(state),
                   SAMARE_DETECTED_CLIENTS="", PATH=str(home/".local/bin") + ":/usr/bin:/bin")

        def run(*args, via=None, code=0):
            argv = [str(via)] if via else [sys.executable, str(BRIDGE)]
            result = subprocess.run([*argv, *args], capture_output=True, text=True, env=env, timeout=12)
            self.assertEqual(result.returncode, code, result.stderr)
            return result.stdout

        def status():
            return json.loads(run("doctor", "--json"))

        def skill(client):
            return home / client / "skills/samare/SKILL.md"

        self.addCleanup(run, "stop")
        self.assertFalse(status()["enabled"])
        run("app-open")
        self.assertFalse(state.exists())
        for client in (".codex", ".claude"):
            (home/client).mkdir(parents=True)
        run("enable")
        info = status()
        self.assertTrue(info["running"] and info["enabled"] and info["commandOnPath"])
        self.assertTrue(info["commandInstalled"] and info["fallbackInstalled"])
        self.assertEqual(info["clients"], {"codex": True, "claude": True, "cursor": False})
        self.assertFalse(info["clientDetails"]["cursor"]["detected"])
        launcher, fallback = map(Path, (info["commandPath"], info["fallbackPath"]))
        for exe in (launcher, fallback, "samare"):
            self.assertTrue(json.loads(run("doctor", "--json", via=exe))["commandInstalled"])
        content = run("print-skill")
        for client in (".codex", ".claude"):
            self.assertEqual(skill(client).read_text(), content)
        for phrase in ("absolute path", "exact returned URL", "once per document", "authorization", "doctor", "available port"):
            self.assertIn(phrase, content)
        self.assertFalse(skill(".agents").exists())
        launcher.chmod(0o600)
        self.assertEqual(status()["commandStatus"], "outdated")
        run("repair")
        self.assertTrue(os.access(launcher, os.X_OK))
        original = launcher.read_bytes()
        launcher.write_bytes(b"# user command\n")
        run("remove-command", code=1)
        self.assertEqual(status()["commandStatus"], "modified")
        self.assertTrue(fallback.exists())
        launcher.write_bytes(original)
        run("remove-command")
        self.assertFalse(launcher.exists() or fallback.exists())
        self.assertTrue(status()["running"])
        run("install-command")
        skill(".codex").write_text("User customization\n")
        run("repair", code=1)
        info = status()
        self.assertEqual(info["clientDetails"]["codex"]["status"], "modified")
        self.assertTrue(info["issues"])
        self.assertEqual(skill(".codex").read_text(), "User customization\n")
        run("install-skill", "shared")
        self.assertEqual(skill(".agents").read_text(), content)
        # A manual print-skill installation has no installer receipt.
        run("remove-skill", "claude")
        skill(".claude").parent.mkdir()
        skill(".claude").write_text(content)
        self.assertTrue(status()["clientDetails"]["claude"]["installed"])
        cursor = skill(".cursor")
        cursor.parent.parent.mkdir(parents=True)
        cursor.parent.symlink_to(skill(".agents").parent, target_is_directory=True)
        self.assertTrue(status()["clientDetails"]["cursor"]["usingFallback"])
        run("remove-skill", "cursor", code=1)
        self.assertTrue(skill(".agents").exists())
        run("remove-skill", "shared")
        self.assertFalse(status()["clientDetails"]["cursor"]["installed"])
        run("background", "enable")
        self.assertTrue(status()["background"])
        run("app-close")
        self.assertTrue(status()["running"])
        run("background", "disable")
        self.assertFalse(status()["background"])
        self.assertTrue(status()["running"])
        run("background", "enable")
        run("disable")
        self.assertFalse(status()["running"] or status()["background"] or status()["enabled"])
        run("app-open")
        self.assertFalse(status()["running"])
        run("url", str(home/"sample.md"), code=78)

    def test_partial_repair_and_disabled_cleanup(self):
        b = self.bridge
        public = b.command_path()
        public.parent.mkdir(parents=True)
        public.write_text("Custom launcher\n")
        with self.assertRaises(ValueError):
            b.change_command(True)
        self.assertTrue(b.doctor()["fallbackInstalled"])
        self.assertEqual(public.read_text(), "Custom launcher\n")
        self.assertEqual(b.doctor()["commandStatus"], "modified")
        b.set_value("enabled", "1")
        b.generated_write(b.agent_plist(), b"Fixture", "background-plist")
        with patch.object(sys, "argv", ["bridge", "disable"]), \
             patch.object(b, "change_background", side_effect=ValueError("mock bootout failure")), \
             patch.object(b, "stop_service") as stop:
            with self.assertRaisesRegex(ValueError, "mock bootout"):
                b.main()
            stop.assert_called_once_with()
        self.assertFalse(b.bridge_enabled())

    def test_isolated_login_agent(self):
        b = self.bridge
        b.set_value("enabled", "1")
        calls = []
        loaded = set()
        def fake(*args, check=True):
            calls.append(args)
            if args[0] == "print":
                return 0 if loaded else 1
            if args[0] == "bootstrap":
                loaded.add(args[2])
            if args[0] == "bootout":
                loaded.clear()
            return 0
        with patch.dict(os.environ), patch.object(b, "launchctl", side_effect=fake), patch.object(b, "start_service") as foreground:
            os.environ.pop("SAMARE_INTEGRATION_HOME", None)
            self.assertFalse(b.integrations()["background"])
            b.change_background(True)
            self.assertTrue(b.integrations()["background"])
            self.assertTrue(loaded)
            config = plistlib.loads(b.agent_plist().read_bytes())
            self.assertEqual(config["Label"], b.SERVICE_LABEL)
            self.assertTrue(config["RunAtLoad"])
            self.assertEqual(config["EnvironmentVariables"]["SAMARE_BRIDGE_HOME"],str(b.STATE))
            b.change_background(False)
            self.assertFalse(b.agent_plist().exists())
            self.assertFalse(loaded)
            foreground.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
