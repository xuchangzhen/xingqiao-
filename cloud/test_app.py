"""Protocol tests for the signalling service.

Run with: ``python -m unittest -v cloud.test_app`` after installing
``cloud/requirements.txt``.
"""
from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer

from cloud.app import SignalHub, app, config


class FakeSocket:
    def __init__(self) -> None:
        self.closed = False
        self.json_messages: list[dict] = []
        self.text_messages: list[dict] = []
        self.binary_messages: list[bytes] = []

    async def send_json(self, message: dict) -> None:
        self.json_messages.append(message)

    async def send_str(self, message: str) -> None:
        self.text_messages.append(json.loads(message))

    async def send_bytes(self, message: bytes) -> None:
        self.binary_messages.append(message)


class SignalHubTest(unittest.TestCase):
    def test_host_is_acknowledged_and_listed_for_other_devices(self) -> None:
        async def scenario() -> tuple[FakeSocket, FakeSocket]:
            hub = SignalHub()
            owner, receiver = FakeSocket(), FakeSocket()
            hub.peers = {"owner": owner, "receiver": receiver}
            hosted = {
                "type": "host",
                "room": "abc123def456",
                "meta": {
                    "sender": "发送设备",
                    "mode": "files",
                    "files": [{"name": "example.txt", "size": 12, "mime": "text/plain"}],
                },
            }
            await hub.receive("owner", hosted)
            await hub.receive("receiver", {"type": "list"})
            return owner, receiver

        owner, receiver = asyncio.run(scenario())
        self.assertIn({"type": "hosted", "room": "abc123def456"}, owner.json_messages)
        listed = receiver.json_messages[-1]
        self.assertEqual(listed["type"], "rooms")
        self.assertEqual(listed["rooms"][0]["room"], "abc123def456")
        self.assertEqual(listed["rooms"][0]["files"][0]["name"], "example.txt")

    def test_join_forwards_receiver_capacity_without_trusting_other_values(self) -> None:
        async def scenario(receiver: str) -> dict:
            hub = SignalHub()
            owner, joining = FakeSocket(), FakeSocket()
            hub.peers = {"owner": owner, "joining": joining}
            await hub.receive("owner", {"type": "host", "room": "abc123def456", "meta": {"files": [{"name": "video.mp4"}]}})
            await hub.receive("joining", {"type": "join", "room": "abc123def456", "selected": [0], "receiver": receiver})
            return owner.json_messages[-1]

        android = asyncio.run(scenario("android"))
        desktop = asyncio.run(scenario("desktop"))
        browser = asyncio.run(scenario("anything-else"))
        self.assertEqual(android["receiver"], "android")
        self.assertEqual(desktop["receiver"], "desktop")
        self.assertEqual(browser["receiver"], "browser")

    def test_binary_relay_requires_join_and_preserves_payload(self) -> None:
        async def scenario() -> tuple[FakeSocket, FakeSocket]:
            hub = SignalHub()
            owner, receiver = FakeSocket(), FakeSocket()
            hub.peers = {"owner": owner, "receiver": receiver}
            await hub.receive("owner", {"type": "host", "room": "abc123def456", "meta": {"files": [{"name": "sample"}]}})
            frame = bytes((1, len("receiver"))) + b"receiver" + b"\x00\xfffile"
            await hub.relay_binary("owner", frame)
            self.assertEqual(receiver.binary_messages, [])
            await hub.receive("receiver", {"type": "join", "room": "abc123def456", "selected": [0]})
            await hub.relay_binary("owner", frame)
            await hub.receive("owner", {"type": "relay-control", "target": "receiver", "room": "abc123def456", "data": '{"type":"file-end"}'})
            await hub.receive("owner", {"type": "leave", "room": "abc123def456"})
            await hub.relay_binary("owner", frame)
            return owner, receiver

        _, receiver = asyncio.run(scenario())
        self.assertEqual(receiver.binary_messages, [b"\x01\x05owner\x00\xfffile"])
        self.assertIn({"type": "relay-control", "from": "owner", "room": "abc123def456", "data": '{"type":"file-end"}'}, receiver.json_messages)

    def test_config_uses_deployed_turn_for_stun(self) -> None:
        with patch.dict("os.environ", {"TURN_HOST": "turn.example.com", "TURN_SECRET": "test-secret"}):
            response = asyncio.run(config(None))
        servers = json.loads(response.text)["iceServers"]
        self.assertEqual(servers[0]["urls"], "stun:turn.example.com:3478")
        self.assertIn("turn:turn.example.com:3478?transport=tcp", servers[1]["urls"])

    def test_websocket_relay_forwards_binary_after_join(self) -> None:
        async def next_json(ws, kind: str) -> dict:
            for _ in range(10):
                message = await ws.receive(timeout=2)
                if message.type == WSMsgType.TEXT:
                    data = json.loads(message.data)
                    if data.get("type") == kind:
                        return data
            self.fail(f"did not receive {kind}")

        async def scenario() -> bytes:
            with patch("cloud.app.HUB", SignalHub()):
                async with TestClient(TestServer(app())) as client:
                    owner = await client.ws_connect("/signal")
                    owner_id = (await next_json(owner, "hello"))["peer"]
                    receiver = await client.ws_connect("/signal")
                    receiver_id = (await next_json(receiver, "hello"))["peer"]
                    await owner.send_json({"type": "host", "room": "abc123def456", "meta": {"files": [{"name": "sample"}]}})
                    await next_json(owner, "hosted")
                    await receiver.send_json({"type": "join", "room": "abc123def456", "selected": [0]})
                    await next_json(owner, "peer-joined")
                    await owner.send_bytes(bytes((1, len(receiver_id))) + receiver_id.encode() + b"actual-file-payload")
                    for _ in range(10):
                        message = await receiver.receive(timeout=2)
                        if message.type == WSMsgType.BINARY:
                            await owner.close()
                            await receiver.close()
                            return message.data
            self.fail("did not receive relay payload")

        frame = asyncio.run(scenario())
        self.assertEqual(frame[0], 1)
        self.assertEqual(frame[2 + frame[1]:], b"actual-file-payload")


if __name__ == "__main__":
    unittest.main()
