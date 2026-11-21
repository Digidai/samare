"""Serve the signed development channel on an ephemeral IPv4 loopback socket."""
import http.server
import os
import pathlib
import re
import shutil
import sys
import threading
import urllib.parse

channel = pathlib.Path(sys.argv[1])

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        name = urllib.parse.urlsplit(self.path).path[1:]
        if name not in {"appcast.xml", "appcast-intel.xml"} and not re.fullmatch(r"Samare-[0-9]+(?:-[a-f0-9]{64})?\.zip", name):
            self.send_error(404)
            return
        path = channel / name
        try:
            stream = path.open("rb")
        except OSError:
            self.send_error(404)
            return
        with stream:
            self.send_response(200)
            self.send_header("Content-Type", "application/xml" if name.endswith(".xml") else "application/zip")
            self.send_header("Content-Length", str(os.fstat(stream.fileno()).st_size))
            self.end_headers()
            shutil.copyfileobj(stream, self.wfile)

    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_port, flush=True)
threading.Thread(target=lambda: (sys.stdin.buffer.read(), server.shutdown()), daemon=True).start()
server.serve_forever()
