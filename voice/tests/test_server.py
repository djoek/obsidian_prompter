"""The server loop with a fake microphone, recognizer and prompter."""

import asyncio
import json

import numpy as np

from prompter_voice.server import VoiceServer

WORDS = ["Hallo", "welkom", "bij", "deze", "video", "vandaag", "vertel", "ik", "je", "waarom"]


class FakeMic:
    name = "Fake mic"

    def read(self) -> np.ndarray:
        return np.full(4000, 0.1, dtype=np.float32)


class FakeRecognizer:
    """'Hears' one more word of the script on every call."""

    name = "fake"

    def __init__(self) -> None:
        self.n = 0
        self.resets = 0

    def feed(self, audio: np.ndarray) -> list[str]:
        self.n += 1
        return WORDS[: self.n][-10:]

    def reset(self) -> None:
        self.resets += 1
        self.n = 0


class FakeClient:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))


def test_listen_sends_positions(monkeypatch):
    monkeypatch.setattr("prompter_voice.server.TICK", 0.001)

    async def scenario() -> list[dict]:
        rec = FakeRecognizer()
        server = VoiceServer(lambda: rec, device=None)
        server.mic = FakeMic()  # ty: ignore[invalid-assignment]
        server.recognizer = rec
        server.state = "ready"
        client = FakeClient()
        server.client = client  # ty: ignore[invalid-assignment]
        await server.on_message({"type": "script", "words": WORDS, "word": 0})
        assert rec.resets == 1
        task = asyncio.create_task(server.listen())
        await asyncio.sleep(0.2)
        task.cancel()
        return client.sent

    sent = asyncio.run(scenario())
    positions = [m["word"] for m in sent if m["type"] == "position"]
    assert positions, sent
    assert positions == sorted(positions)
    assert positions[-1] == len(WORDS) - 1
    assert any(m["type"] == "level" for m in sent)
    assert any(m["type"] == "heard" for m in sent)
