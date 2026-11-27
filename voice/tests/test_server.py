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

    def __init__(self, model_id: str = "fake") -> None:
        self.n = 0
        self.resets = 0
        self.languages: list[str | None] = []

    def set_language(self, language: str | None) -> None:
        self.languages.append(language)

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
        server = VoiceServer(lambda model_id: rec, model="fake", device=None)
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


def test_startup_reports_download_progress(monkeypatch):
    monkeypatch.setattr("prompter_voice.server.VoiceServer.open_mic", lambda self, name: None)

    def prepare(model_id, on_progress):
        for done in range(0, 1001, 100):
            on_progress(done, 1000)

    async def scenario() -> list[dict]:
        server = VoiceServer(FakeRecognizer, model="fake", device=None, prepare=prepare)
        server.mic = FakeMic()  # ty: ignore[invalid-assignment]
        client = FakeClient()
        server.client = client  # ty: ignore[invalid-assignment]
        await server.start()
        await asyncio.sleep(0.05)  # let scheduled sends run
        return [m for m in client.sent if m["type"] == "status"]

    statuses = asyncio.run(scenario())
    states = [s["state"] for s in statuses]
    # Every "downloading" message comes before "loading", then "ready".
    assert states[-2:] == ["loading", "ready"]
    assert set(states[:-2]) == {"downloading"}
    progress = [s["progress"]["done"] for s in statuses if s["state"] == "downloading"]
    assert progress == sorted(progress), "bar went backwards"
    assert progress[-1] == 1000, "bar must end full"
    assert all(s["progress"] is None for s in statuses if s["state"] != "downloading")


def test_language_reaches_recognizer_and_aligner():
    async def scenario() -> tuple[FakeRecognizer, VoiceServer]:
        rec = FakeRecognizer()
        server = VoiceServer(lambda model_id: rec, model="fake", device=None)
        server.recognizer = rec
        await server.on_message({"type": "script", "words": WORDS, "language": "fr"})
        await server.on_message({"type": "script", "words": WORDS})  # back to auto
        return rec, server

    rec, server = asyncio.run(scenario())
    assert rec.languages == ["fr", None]
    assert server.aligner is not None and server.aligner.lang == "nl"  # fallback for numbers


def test_reset_keeps_place_and_restarts_recognition():
    async def scenario() -> tuple[FakeRecognizer, VoiceServer]:
        rec = FakeRecognizer()
        server = VoiceServer(lambda model_id: rec, model="fake", device=None)
        server.recognizer = rec
        await server.on_message({"type": "script", "words": WORDS, "word": 4})
        await server.on_message({"type": "reset"})
        return rec, server

    rec, server = asyncio.run(scenario())
    assert rec.resets == 2  # script + reset
    assert server.aligner is not None and server.aligner.word == 4
