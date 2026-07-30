import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def multipart(files, fields):
    boundary = "----XingqiaoTestBoundary"
    body = io.BytesIO()
    for name, value in fields.items():
        body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    for filename, data, mime in files:
        body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n".encode())
        body.write(data); body.write(b"\r\n")
    body.write(f"--{boundary}--\r\n".encode())
    return body.getvalue(), f"multipart/form-data; boundary={boundary}"


class TransferServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        server.STORE = server.TransferStore(Path(self.tmp.name))
        self.httpd = server.serve("127.0.0.1", 0, "test-coordinator-token")
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True); self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown(); self.httpd.server_close(); self.tmp.cleanup()

    def request(self, url, data=None, method="GET", headers=None):
        request = Request(self.base + url, data=data, method=method, headers=headers or {})
        return urlopen(request, timeout=5)

    def test_upload_receive_decline_and_sender_end(self):
        payload, content_type = multipart([("你好.txt", b"private LAN payload", "text/plain")], {"sender": "Mac mini", "mode": "files"})
        with self.request("/api/sessions", payload, "POST", {"Content-Type": content_type}) as response:
            self.assertEqual(response.status, 201); created = json.load(response)
        session_id = created["id"]; file_id = created["files"][0]["id"]
        with self.request("/api/sessions") as response:
            self.assertEqual(json.load(response)["sessions"][0]["sender"], "Mac mini")
        with self.request(f"/api/sessions/{session_id}/files/{file_id}") as response:
            self.assertEqual(response.read(), b"private LAN payload")
            self.assertIn("attachment", response.headers["Content-Disposition"])
        with self.request(f"/api/sessions/{session_id}/decline", b'{"device":"android-test"}', "POST", {"Content-Type": "application/json"}) as response:
            self.assertTrue(json.load(response)["declined"])
        with self.request("/api/sessions", headers={"X-Xingqiao-Device": "android-test"}) as response:
            self.assertEqual(json.load(response)["sessions"], [])
        with self.request(f"/api/sessions/{session_id}/end", b"", "POST") as response:
            self.assertTrue(json.load(response)["deleted"])
        with self.assertRaises(HTTPError) as gone:
            self.request(f"/api/sessions/{session_id}/files/{file_id}")
        self.assertEqual(gone.exception.code, 410)

    def test_static_client_is_served(self):
        with self.request("/") as response:
            html = response.read().decode()
        self.assertIn("星桥", html)
        self.assertIn("app.js", html)

    def test_only_coordinator_can_stop_server(self):
        with self.assertRaises(HTTPError) as forbidden:
            self.request("/api/server/stop?token=wrong", b"", "POST")
        self.assertEqual(forbidden.exception.code, 403)
        with self.request("/api/server/stop?token=test-coordinator-token", b"", "POST") as response:
            self.assertTrue(json.load(response)["stopping"])
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())

if __name__ == "__main__":
    unittest.main(verbosity=2)
