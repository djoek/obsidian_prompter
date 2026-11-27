"""WebSocket server the Obsidian plugin connects to.

Messages are JSON objects with a "type".

Plugin → server
  {"type": "script", "words": [...], "word": n}   the words, as numbered on screen
  {"type": "seek", "word": n}                     you jumped (N, P, Home, ...)
  {"type": "devices"}                             list microphones
  {"type": "device", "name": "..." | null}        switch microphone (null = default)

Server → plugin
  {"type": "status", "state": "downloading"|"loading"|"ready"|"error", "device": ...,
   "model": ..., "error": ..., "progress": {"done": bytes, "total": bytes} | null}
  {"type": "devices", "devices": [{"name": ..., "default": bool}], "current": ...}
  {"type": "position", "word": n}                 you are saying word n
  {"type": "heard", "text": "..."}                the last words the model heard
  {"type": "level", "rms": 0..1}                  microphone level, for a meter
"""

import asyncio
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

import numpy as np
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from prompter_voice.aligner import Aligner
from prompter_voice.asr import Recognizer

if TYPE_CHECKING:
    from prompter_voice.audio import Microphone
from prompter_voice.normalize import normalize_text

log = logging.getLogger("prompter_voice")
TICK = 0.25  # seconds between recognition steps


class VoiceServer:
    def __init__(
        self,
        make_recognizer,  # noqa: ANN001  () -> Recognizer
        device: str | None,
        lang: str = "nl",
        prepare=None,  # noqa: ANN001  (on_progress) -> None: fetch the model files
    ) -> None:
        self.make_recognizer = make_recognizer
        self.prepare = prepare
        self.progress: tuple[int, int] | None = None
        self._progress_sent = 0.0
        self.device_name = device
        self.lang = lang
        self.recognizer: Recognizer | None = None
        self.mic: Microphone | None = None
        self.aligner: Aligner | None = None
        self.client: ServerConnection | None = None
        self.state = "loading"
        self.error: str | None = None
        self.last_heard = ""
        # One thread for all model work.
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr")

    # ── plumbing ─────────────────────────────────────────────────────────

    async def run_in_worker(self, fn, *args):  # noqa: ANN001, ANN002
        return await asyncio.get_running_loop().run_in_executor(self.worker, fn, *args)

    async def send(self, **msg: Any) -> None:
        if self.client is None:
            return
        try:
            await self.client.send(json.dumps(msg))
        except ConnectionClosed:
            self.client = None

    async def send_status(self) -> None:
        await self.send(**self.status())

    def status(self) -> dict[str, Any]:
        return dict(
            type="status",
            state=self.state,
            device=self.mic.name if self.mic else None,
            model=self.recognizer.name if self.recognizer else None,
            error=self.error,
            progress=(
                {"done": self.progress[0], "total": self.progress[1]}
                if self.state == "downloading" and self.progress
                else None
            ),
        )

    def open_mic(self, name: str | None) -> None:
        from prompter_voice.audio import Microphone  # loads PortAudio

        if self.mic:
            self.mic.close()
            self.mic = None
        self.mic = Microphone(name)
        self.mic.start()
        self.device_name = name
        log.info("Listening on %s (%d Hz)", self.mic.name, self.mic.rate)

    # ── lifecycle ────────────────────────────────────────────────────────

    def _on_progress(self, done: int, total: int) -> None:
        """Called on the worker thread while downloading; hands over to the
        event loop, which sends at most 4 updates a second (plus the last)."""

        def apply() -> None:
            if total <= 1:  # already cached: nothing to show
                return
            self.state, self.progress = "downloading", (done, total)
            now = time.monotonic()
            if done >= total or now - self._progress_sent >= 0.25:
                self._progress_sent = now
                # Build the message now: by the time it is sent, the download
                # has moved on, and we want this update's numbers.
                asyncio.ensure_future(self.send(**self.status()))

        self.loop.call_soon_threadsafe(apply)

    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        # A microphone problem shouldn't stop the model from downloading:
        # you can pick another microphone in the settings later.
        try:
            self.open_mic(self.device_name)
        except Exception as e:
            self.error = f"Microphone: {e}"
            log.warning("Could not open microphone: %s", e)
        try:
            if self.prepare:
                await self.run_in_worker(self.prepare, self._on_progress)
            self.state = "loading"
            await self.send_status()
            log.info("Loading model ...")
            self.recognizer = await self.run_in_worker(self.make_recognizer)
            self.state = "ready" if self.mic else "error"
            log.info("Ready: %s", self.recognizer.name)
        except Exception as e:  # report to the plugin instead of dying
            self.state, self.error = "error", str(e)
            log.exception("Startup failed")
        await self.send_status()

    async def listen(self) -> None:
        while True:
            await asyncio.sleep(TICK)
            if not self.mic:
                continue
            audio = self.mic.read()
            if audio.size == 0:
                continue
            await self.send(type="level", rms=round(float(np.sqrt(np.mean(audio**2))), 4))
            recognizer, aligner = self.recognizer, self.aligner
            if recognizer is None or aligner is None or self.client is None:
                continue
            try:
                words = await self.run_in_worker(recognizer.feed, audio)
            except Exception:
                log.exception("Recognition failed; continuing")
                continue
            heard = " ".join(words)
            if heard != self.last_heard:
                self.last_heard = heard
                await self.send(type="heard", text=heard)
            moved = aligner.update(normalize_text(heard, self.lang))
            if moved is not None:
                await self.send(type="position", word=moved)

    # ── messages ─────────────────────────────────────────────────────────

    async def handle(self, ws: ServerConnection) -> None:
        # Only one prompter at a time; a new connection takes over.
        self.client = ws
        log.info("Prompter connected")
        await self.send_status()
        try:
            async for raw in ws:
                await self.on_message(json.loads(raw))
        except ConnectionClosed:
            pass
        finally:
            if self.client is ws:
                self.client = None
                log.info("Prompter disconnected")

    async def on_message(self, msg: dict[str, Any]) -> None:
        match msg.get("type"):
            case "script":
                self.aligner = Aligner(msg["words"], lang=self.lang)
                self.aligner.seek(int(msg.get("word", 0)))
                await self.reset_recognizer()
                log.info("Script: %d words", len(msg["words"]))
            case "seek" if self.aligner:
                self.aligner.seek(int(msg["word"]))
                await self.reset_recognizer()
            case "devices":
                from prompter_voice.audio import input_devices

                await self.send(
                    type="devices",
                    devices=[asdict(d) for d in input_devices()],
                    current=self.mic.name if self.mic else None,
                )
            case "device":
                try:
                    self.open_mic(msg.get("name") or None)
                    self.error = None
                    if self.recognizer:
                        self.state = "ready"
                except Exception as e:
                    self.error = str(e)
                    log.warning("Could not open %r: %s", msg.get("name"), e)
                await self.send_status()
            case other:
                log.debug("Ignored message %r", other)

    async def reset_recognizer(self) -> None:
        """After a jump, old heard words would pull us back: forget them."""
        self.last_heard = ""
        if self.mic:
            self.mic.read()  # drop audio from before the jump
        if self.recognizer:
            await self.run_in_worker(self.recognizer.reset)


async def serve_forever(server: VoiceServer, host: str, port: int) -> None:
    async with serve(server.handle, host, port):
        log.info("Waiting for the prompter on ws://%s:%d", host, port)
        await asyncio.gather(server.start(), server.listen())
