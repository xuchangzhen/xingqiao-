"""Protocol tests for the signalling service.

Run with: ``python -m unittest -v cloud.test_app`` after installing
``cloud/requirements.txt``.
"""
from __future__ import annotations

import asyncio
import json
import unittest

from cloud.app import SignalHub


class FakeSocket:
    def __init__(self) -> None:
        self.closed = False
        self.json_messages: list[dict] = []
        self.text_messages: list[dict] = []

    async def send_json(self, message: dict) -> None:
        self.json_messages.append(message)

    async def send_str(self, message: str) -> None:
        self.text_messages.append(json.loads(message))


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
        browser = asyncio.run(scenario("anything-else"))
        self.assertEqual(android["receiver"], "android")
        self.assertEqual(browser["receiver"], "browser")


if __name__ == "__main__":
    unittest.main()
