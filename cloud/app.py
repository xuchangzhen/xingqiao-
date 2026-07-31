"""HTTPS/WebSocket signalling service for Xingqiao's browser-to-browser mode.

Files never pass through this process. It only relays WebRTC offers, answers and
ICE candidates; file payloads flow over encrypted WebRTC data channels.
"""
from __future__ import annotations

import json
import base64
import hashlib
import hmac
import os
import secrets
import time
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"


class SignalHub:
    def __init__(self) -> None:
        self.peers: dict[str, web.WebSocketResponse] = {}
        self.rooms: dict[str, dict[str, Any]] = {}

    def public_rooms(self) -> list[dict[str, Any]]:
        return [{"room": room, **data["meta"]} for room, data in self.rooms.items()]

    async def announce(self) -> None:
        message = json.dumps({"type": "rooms", "rooms": self.public_rooms()}, ensure_ascii=False)
        await self._send_all(message)

    async def _send_all(self, message: str) -> None:
        for peer_id, socket in list(self.peers.items()):
            if socket.closed:
                self.peers.pop(peer_id, None)
                continue
            await socket.send_str(message)

    async def remove(self, peer_id: str) -> None:
        self.peers.pop(peer_id, None)
        stale = [room for room, data in self.rooms.items() if data["owner"] == peer_id]
        for room in stale:
            self.rooms.pop(room, None)
        if stale:
            await self.announce()

    async def receive(self, peer_id: str, payload: dict[str, Any]) -> None:
        kind = payload.get("type")
        if kind == "list":
            socket = self.peers[peer_id]
            await socket.send_json({"type": "rooms", "rooms": self.public_rooms()})
            return
        if kind == "host":
            room = str(payload.get("room", ""))
            meta = payload.get("meta", {})
            if len(room) != 12 or not room.isalnum() or not isinstance(meta, dict):
                return
            self.rooms[room] = {"owner": peer_id, "meta": {
                "sender": str(meta.get("sender", "匿名设备"))[:48],
                "mode": str(meta.get("mode", "files"))[:12],
                "files": list(meta.get("files", []))[:100],
            }}
            await self.peers[peer_id].send_json({"type": "hosted", "room": room})
            await self.announce()
            return
        if kind == "leave":
            room = str(payload.get("room", ""))
            if self.rooms.get(room, {}).get("owner") == peer_id:
                self.rooms.pop(room, None)
                await self.announce()
            return
        if kind == "join":
            room = str(payload.get("room", ""))
            data = self.rooms.get(room)
            if not data or data["owner"] not in self.peers:
                return
            selected = payload.get("selected", [])
            if not isinstance(selected, list):
                return
            selected = sorted({index for index in selected if isinstance(index, int) and 0 <= index < len(data["meta"]["files"])})
            if not selected:
                return
            await self.peers[peer_id].send_json({"type": "joined", "room": room, "owner": data["owner"]})
            await self.peers[data["owner"]].send_json({"type": "peer-joined", "room": room, "peer": peer_id, "selected": selected})
            return
        if kind == "signal":
            target = str(payload.get("target", ""))
            if target in self.peers:
                await self.peers[target].send_json({"type": "signal", "from": peer_id, "room": payload.get("room"), "payload": payload.get("payload")})


HUB = SignalHub()


async def signal(request: web.Request) -> web.StreamResponse:
    socket = web.WebSocketResponse(heartbeat=25)
    await socket.prepare(request)
    peer_id = secrets.token_urlsafe(12)
    HUB.peers[peer_id] = socket
    await socket.send_json({"type": "hello", "peer": peer_id})
    await HUB.announce()
    try:
        async for message in socket:
            if message.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(message.data)
                    if isinstance(payload, dict):
                        await HUB.receive(peer_id, payload)
                except json.JSONDecodeError:
                    pass
    finally:
        await HUB.remove(peer_id)
    return socket


async def config(_: web.Request) -> web.Response:
    host = os.environ.get("TURN_HOST", "")
    secret = os.environ.get("TURN_SECRET", "")
    servers: list[dict[str, Any]] = [{"urls": "stun:stun.l.google.com:19302"}]
    if host and secret:
        # coturn REST authentication: a browser receives short-lived credentials instead
        # of the deployment secret, so the VPS TURN account cannot be reused indefinitely.
        username = f"{int(time.time()) + 3600}:xingqiao"
        credential = base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode()
        servers.append({"urls": [f"turn:{host}:3478?transport=udp", f"turn:{host}:3478?transport=tcp"], "username": username, "credential": credential})
    return web.json_response({"iceServers": servers})


async def index(_: web.Request) -> web.FileResponse:
    return web.FileResponse(WEB / "index.html")


@web.middleware
async def no_cache_client_shell(request: web.Request, handler: web.Handler) -> web.StreamResponse:
    response = await handler(request)
    if request.path == "/" or request.path.endswith((".html", ".js", ".css")):
        response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


def app() -> web.Application:
    instance = web.Application(middlewares=[no_cache_client_shell])
    instance.router.add_get("/signal", signal)
    instance.router.add_get("/api/config", config)
    instance.router.add_get("/", index)
    instance.router.add_static("/", WEB, show_index=False)
    return instance


if __name__ == "__main__":
    web.run_app(app(), host="0.0.0.0", port=8000)
