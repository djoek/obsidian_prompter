"""WebSocket server the Obsidian plugin connects to.

Messages are JSON objects with a "type".

Plugin → server
  {"type": "script", "words": [...], "word": n, "language": "nl" | null,
   "sections": [n, ...]}                          the words, as numbered on screen, and
                                                  the word each section starts at
  {"type": "seek", "word": n}                     you jumped (N, P, Home, ...)
  {"type": "devices"}                             list microphones
  {"type": "device", "name": "..." | null}        switch microphone (null = default)
  {"type": "reset"}                               forget what was heard, start recognition
                                                  afresh (Parakeet re-detects the language)
  {"type": "listen", "on": bool}                  pause (Space) stops recognition; resuming
                                                  starts it afresh

Server → plugin
  {"type": "status", "state": "downloading"|"loading"|"ready"|"error", "device": ...,
   "model": ..., "error": ..., "progress": {"done": bytes, "total": bytes} | null}
  {"type": "devices", "devices": [{"name": ..., "default": bool}], "current": ...}
  {"type": "position", "word": n}                 you are saying word n
  {"type": "heard", "text": "..."}                the last words the model heard
  {"type": "level", "rms": 0..1}                  microphone level, for a meter
"""

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

import numpy as np
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from souffleur_voice.aligner import Aligner
from souffleur_voice.asr import Recognizer

if TYPE_CHECKING:
    from souffleur_voice.audio import Microphone
from souffleur_voice.normalize import normalize_text

log = logging.getLogger("souffleur_voice")
TICK = 0.25  # seconds between recognition steps


class VoiceServer:
    def __init__(
        self,
        make_recognizer: Callable[[str], Recognizer],
        model: str,
        device: str | None,
        lang: str = "nl",
        prepare: Callable[[str, Callable[[int, int], None]], None] | None = None,
    ) -> None:
        self.make_recognizer = make_recognizer
        self.prepare = prepare  # (model id, on_progress): fetch the model files
        self.model_id = model
        self._model_lock = asyncio.Lock()
        # Language of the current script (None: let the model decide). `lang`
        # is the fallback for spelling out numbers.
        self.language: str | None = None
        self._latest: tuple[int, int] | None = None
        self._progress_changed = asyncio.Event()
        self.progress: tuple[int, int] | None = None
        self.device_name = device
        self.lang = lang
        self.recognizer: Recognizer | None = None
        self.mic: Microphone | None = None
        self.aligner: Aligner | None = None
        self.client: ServerConnection | None = None
        self.state = "loading"
        self.error: str | None = None
        self.last_heard = ""
        # Paused in the prompter: the mic stays open (resuming is instant), but
        # its audio is dropped and the model does nothing.
        self.listening = True
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
            model=self.model_id,
            error=self.error,
            progress=(
                {"done": self.progress[0], "total": self.progress[1]}
                if self.state == "downloading" and self.progress
                else None
            ),
        )

    def open_mic(self, name: str | None) -> None:
        from souffleur_voice.audio import Microphone  # loads PortAudio

        if self.mic:
            self.mic.close()
            self.mic = None
        self.mic = Microphone(name)
        self.mic.start()
        self.device_name = name
        log.info("Listening on %s (%d Hz)", self.mic.name, self.mic.rate)

    # ── lifecycle ────────────────────────────────────────────────────────

    def _on_progress(self, done: int, total: int) -> None:
        """Called on the worker thread while downloading.

        It stores the numbers directly (replacing a tuple is atomic in Python)
        and only *wakes* the event loop. Callbacks queued from this thread can
        be handled after the download has already returned, so nothing may
        depend on them arriving in time: `_download` reads `_latest` itself.
        """
        if total > 1:  # (1, 1) means "was already cached"
            self._latest = (done, total)
            self.loop.call_soon_threadsafe(self._progress_changed.set)

    def latest_progress(self) -> tuple[int, int] | None:
        """What the worker thread last reported (it writes `_latest`)."""
        return self._latest

    async def _report_progress(self) -> None:
        """While downloading: send the latest progress, at most 4× a second."""
        while True:
            await self._progress_changed.wait()
            self._progress_changed.clear()
            if self._latest:
                self.state, self.progress = "downloading", self._latest
                await self.send_status()
            await asyncio.sleep(0.25)

    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        # A microphone problem shouldn't stop the model from downloading:
        # you can pick another microphone in the settings later.
        try:
            self.open_mic(self.device_name)
        except Exception as e:
            self.error = f"Microphone: {e}"
            log.warning("Could not open microphone: %s", e)
        await self.load_model(self.model_id)

    async def _download(self, model_id: str) -> None:
        assert self.prepare is not None
        self._latest = None
        self._progress_changed = asyncio.Event()
        reporter = asyncio.create_task(self._report_progress())
        try:
            await self.run_in_worker(self.prepare, model_id, self._on_progress)
        finally:
            reporter.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reporter
        latest = self.latest_progress()  # written by the worker thread meanwhile
        if latest:  # it really downloaded: end on a full bar
            total = latest[1]
            self.state, self.progress = "downloading", (total, total)
            await self.send_status()

    async def load_model(self, model_id: str) -> None:
        """Download (with progress) and load a model; replaces the current one."""
        async with self._model_lock:
            self.model_id = model_id
            self.recognizer = None  # listening pauses while switching
            self.progress = None
            try:
                if self.prepare:
                    await self._download(model_id)
                self.state = "loading"
                await self.send_status()
                log.info("Loading %s ...", model_id)
                recognizer = await self.run_in_worker(self.make_recognizer, model_id)
                await self.run_in_worker(recognizer.set_language, self.language)
                self.recognizer = recognizer
                self.state = "ready" if self.mic else "error"
                log.info("Ready: %s", model_id)
            except Exception as e:  # report to the plugin instead of dying
                self.state, self.error = "error", str(e)
                log.exception("Loading %s failed", model_id)
            await self.send_status()

    async def listen(self) -> None:
        while True:
            await asyncio.sleep(TICK)
            if not self.mic:
                continue
            audio = self.mic.read()
            if audio.size == 0 or not self.listening:
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
            moved = aligner.update(normalize_text(heard, aligner.lang))
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
                language = msg.get("language") or None
                self.aligner = Aligner(
                    msg["words"],
                    lang=language or self.lang,
                    sections=[int(n) for n in msg.get("sections") or []],
                )
                self.aligner.seek(int(msg.get("word", 0)))
                if language != self.language:
                    self.language = language
                    if self.recognizer:
                        await self.run_in_worker(self.recognizer.set_language, language)
                await self.reset_recognizer()
                log.info("Script: %d words, language %s", len(msg["words"]), language or "auto")
            case "seek" if self.aligner:
                self.aligner.seek(int(msg["word"]))
                await self.reset_recognizer()
            case "listen":
                on = bool(msg.get("on", True))
                if on and not self.listening:
                    await self.reset_recognizer()  # nothing from the pause is matched
                if on != self.listening:
                    log.info("Listening %s", "resumed" if on else "paused")
                self.listening = on
            case "reset":
                # Your place in the script stays; only what was heard is dropped.
                log.info("Reset requested: restarting recognition")
                await self.reset_recognizer()
            case "devices":
                from souffleur_voice.audio import input_devices

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
