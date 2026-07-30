#!/usr/bin/env python3
"""Xingqiao — a dependency-free, LAN-only, ephemeral file handoff server."""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import socket
import threading
import time
import uuid
import webbrowser
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote, unquote, urlparse, parse_qs
from email.message import Message
import tempfile

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
STORE_ROOT = ROOT / ".xingqiao-transfers"
HEARTBEAT_SECONDS = 18
MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024  # 4 GiB per file


@dataclass
class TransferFile:
    id: str
    name: str
    path: Path
    size: int
    mime: str


@dataclass
class UploadPart:
    """A multipart file staged on disk while the request is being parsed."""
    filename: str
    mime: str
    path: Path


@dataclass
class Session:
    id: str
    sender: str
    mode: str
    files: list[TransferFile]
    created_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    declined_by: set[str] = field(default_factory=set)

    @property
    def alive(self) -> bool:
        return time.time() - self.last_seen < HEARTBEAT_SECONDS


class TransferStore:
    def __init__(self, root: Path = STORE_ROOT):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.sessions: dict[str, Session] = {}
        self.lock = threading.RLock()

    def create(self, sender: str, mode: str, fields: list[UploadPart]) -> Session:
        session_id = uuid.uuid4().hex
        target = self.root / session_id
        target.mkdir(mode=0o700)
        files: list[TransferFile] = []
        try:
            for item in fields:
                if not item.filename or not item.path.is_file():
                    continue
                safe_name = Path(item.filename).name or "unnamed-file"
                file_id = uuid.uuid4().hex
                path = target / file_id
                with item.path.open("rb") as source:
                    size = self._save_limited(source, path)
                files.append(TransferFile(file_id, safe_name, path, size, item.mime or "application/octet-stream"))
            if not files:
                raise ValueError("请选择至少一个文件")
            session = Session(session_id, sender.strip()[:48] or "匿名设备",
                              mode if mode in {"photos", "files", "social"} else "files", files)
            with self.lock:
                self.sessions[session_id] = session
            return session
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            raise

    @staticmethod
    def _save_limited(source: BinaryIO, destination: Path) -> int:
        total = 0
        with destination.open("wb") as out:
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_FILE_BYTES:
                    raise ValueError("单个文件不能超过 4 GiB")
                out.write(chunk)
        return total

    def active(self, receiver: str = "") -> list[Session]:
        self.expire()
        with self.lock:
            return [s for s in self.sessions.values() if s.alive and receiver not in s.declined_by]

    def get(self, session_id: str) -> Session | None:
        self.expire()
        with self.lock:
            session = self.sessions.get(session_id)
            return session if session and session.alive else None

    def touch(self, session_id: str) -> bool:
        with self.lock:
            session = self.sessions.get(session_id)
            if not session or not session.alive:
                return False
            session.last_seen = time.time()
            return True

    def decline(self, session_id: str, device: str) -> bool:
        with self.lock:
            session = self.sessions.get(session_id)
            if not session or not session.alive:
                return False
            session.declined_by.add(device[:80])
            return True

    def delete(self, session_id: str) -> bool:
        with self.lock:
            session = self.sessions.pop(session_id, None)
        if not session:
            return False
        shutil.rmtree(self.root / session_id, ignore_errors=True)
        return True

    def clear(self) -> None:
        with self.lock:
            session_ids = list(self.sessions)
        for session_id in session_ids:
            self.delete(session_id)

    def expire(self) -> None:
        with self.lock:
            expired = [sid for sid, s in self.sessions.items() if not s.alive]
        for session_id in expired:
            self.delete(session_id)


STORE = TransferStore()


def _header_value(header: str, name: str) -> str:
    message = Message()
    message["Content-Disposition"] = header
    value = message.get_param(name, header="content-disposition") or ""
    if isinstance(value, tuple):  # RFC 2231 encoded parameter
        value = value[2]
    return str(value)


def parse_multipart(stream: BinaryIO, content_type: str) -> tuple[dict[str, str], list[UploadPart]]:
    """Small streaming multipart parser for browser and Android uploads.

    Python 3.13 removed cgi.FieldStorage.  This writes each upload to a temporary
    file and only holds normal form fields in memory, so videos do not balloon RAM.
    """
    message = Message(); message["Content-Type"] = content_type
    boundary_text = message.get_param("boundary", header="content-type")
    if not boundary_text:
        raise ValueError("请求不是 multipart/form-data")
    boundary = b"--" + str(boundary_text).encode("ascii")
    if stream.readline(1024 * 1024).strip() != boundary:
        raise ValueError("无效的 multipart 请求")
    values: dict[str, str] = {}
    files: list[UploadPart] = []
    created: list[Path] = []
    try:
        while True:
            headers: dict[str, str] = {}
            while True:
                line = stream.readline(64 * 1024)
                if not line:
                    raise ValueError("上传意外中断")
                if line in {b"\r\n", b"\n"}:
                    break
                key, separator, value = line.decode("latin-1").partition(":")
                if not separator:
                    raise ValueError("无效的 multipart 头")
                headers[key.lower()] = value.strip()
            disposition = headers.get("content-disposition", "")
            name = _header_value(disposition, "name")
            filename = _header_value(disposition, "filename")
            if not name:
                raise ValueError("上传字段缺少名称")
            tmp = tempfile.NamedTemporaryFile(prefix=".upload-", dir=STORE.root, delete=False)
            temp_path = Path(tmp.name); created.append(temp_path)
            previous: bytes | None = None
            finished = False
            try:
                while True:
                    line = stream.readline(1024 * 1024)
                    if not line:
                        raise ValueError("上传意外中断")
                    if line.startswith(boundary) and line.rstrip(b"\r\n") in {boundary, boundary + b"--"}:
                        if previous is not None:
                            tmp.write(previous[:-2] if previous.endswith(b"\r\n") else previous[:-1] if previous.endswith(b"\n") else previous)
                        finished = line.rstrip(b"\r\n") == boundary + b"--"
                        break
                    if previous is not None:
                        tmp.write(previous)
                    previous = line
            finally:
                tmp.close()
            if filename:
                files.append(UploadPart(filename, headers.get("content-type", "application/octet-stream"), temp_path))
            else:
                values[name] = temp_path.read_text("utf-8", errors="replace")
                temp_path.unlink(missing_ok=True); created.remove(temp_path)
            if finished:
                return values, files
    except Exception:
        for path in created:
            path.unlink(missing_ok=True)
        raise


def session_data(session: Session) -> dict:
    return {
        "id": session.id, "sender": session.sender, "mode": session.mode,
        "createdAt": session.created_at,
        "expiresIn": max(0, int(HEARTBEAT_SECONDS - (time.time() - session.last_seen))),
        "files": [{"id": f.id, "name": f.name, "size": f.size, "mime": f.mime} for f in session.files],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "Xingqiao/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/sessions":
            receiver = self.headers.get("X-Xingqiao-Device", "")
            self.json(HTTPStatus.OK, {"sessions": [session_data(s) for s in STORE.active(receiver)]})
            return
        if path.startswith("/api/sessions/") and "/files/" in path:
            _, _, rest = path.partition("/api/sessions/")
            session_id, _, file_id = rest.partition("/files/")
            session = STORE.get(session_id)
            file = next((f for f in session.files if f.id == file_id), None) if session else None
            if not file or not file.path.is_file():
                self.json(HTTPStatus.GONE, {"error": "文件已被发送端删除或会话已结束"})
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", file.mime)
            self.send_header("Content-Length", str(file.size))
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{self.quote_filename(file.name)}")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with file.path.open("rb") as source:
                shutil.copyfileobj(source, self.wfile, 1024 * 1024)
            return
        self.static(path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/server/stop":
            token = parse_qs(parsed.query).get("token", [""])[0]
            if not token or token != getattr(self.server, "host_token", ""):
                self.json(HTTPStatus.FORBIDDEN, {"error": "仅协调端页面可停止服务"})
                return
            STORE.clear()
            self.json(HTTPStatus.OK, {"stopping": True})
            # Shutdown must run outside this request thread, otherwise HTTPServer deadlocks.
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if path == "/api/sessions":
            try:
                values, fields = parse_multipart(self.rfile, self.headers.get("Content-Type", ""))
                session = STORE.create(values.get("sender", ""), values.get("mode", "files"), fields)
                self.json(HTTPStatus.CREATED, session_data(session))
            except (ValueError, OSError) as error:
                self.json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            finally:
                for field in locals().get("fields", []):
                    field.path.unlink(missing_ok=True)
            return
        parts = path.strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "heartbeat":
            self.json(HTTPStatus.OK if STORE.touch(parts[2]) else HTTPStatus.GONE, {"alive": STORE.get(parts[2]) is not None})
            return
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "end":
            self.json(HTTPStatus.OK if STORE.delete(parts[2]) else HTTPStatus.GONE, {"deleted": True})
            return
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "decline":
            length = int(self.headers.get("Content-Length", "0"))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                body = {}
            ok = STORE.decline(parts[2], str(body.get("device", "此设备")))
            self.json(HTTPStatus.OK if ok else HTTPStatus.GONE, {"declined": ok})
            return
        self.json(HTTPStatus.NOT_FOUND, {"error": "未知接口"})

    def do_DELETE(self) -> None:
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "sessions"]:
            self.json(HTTPStatus.OK if STORE.delete(parts[2]) else HTTPStatus.NOT_FOUND, {"deleted": True})
            return
        self.json(HTTPStatus.NOT_FOUND, {"error": "未知接口"})

    def static(self, path: str) -> None:
        requested = "index.html" if path in {"", "/"} else unquote(path).lstrip("/")
        candidate = (WEB_ROOT / requested).resolve()
        if WEB_ROOT not in candidate.parents and candidate != WEB_ROOT:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        payload = candidate.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(candidate.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(payload)

    def json(self, status: HTTPStatus, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    @staticmethod
    def quote_filename(name: str) -> str:
        from urllib.parse import quote
        return quote(name, safe="")


def serve(host: str = "0.0.0.0", port: int = 8787, host_token: str = "") -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.host_token = host_token  # only the locally launched coordinator page receives this token
    return httpd


def lan_address() -> str | None:
    """Best-effort local interface address without sending any network traffic."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            address = probe.getsockname()[0]
            return address if not address.startswith("127.") else None
    except OSError:
        return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="启动星桥局域网文件互传服务")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--open", action="store_true", help="启动后自动在本机浏览器打开网页")
    args = parser.parse_args()
    host_token = uuid.uuid4().hex if args.open else ""
    httpd = serve(args.host, args.port, host_token)
    print(f"本机访问： http://127.0.0.1:{httpd.server_port}")
    address = lan_address()
    if address:
        print(f"局域网访问： http://{address}:{httpd.server_port}")
    print("请让其他设备连接同一 Wi‑Fi，访问局域网地址。Ctrl+C 停止并清理传输。")
    if args.open:
        webbrowser.open(f"http://127.0.0.1:{httpd.server_port}/?host={quote(host_token)}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n星桥已停止。")
    finally:
        STORE.clear()
        httpd.server_close()
