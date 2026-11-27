"""Microphone capture with sounddevice (PortAudio, so CoreAudio on macOS)."""

import queue
from dataclasses import dataclass

import numpy as np
import sounddevice as sd

from prompter_voice.asr import resample


@dataclass
class Device:
    name: str
    default: bool


def input_devices() -> list[Device]:
    default = sd.default.device[0]
    return [
        Device(name=str(d["name"]), default=i == default)
        for i, d in enumerate(sd.query_devices())
        if int(d["max_input_channels"]) > 0
    ]


def _find(name: str | None) -> int | None:
    """Device index by exact name, then by substring; None = system default."""
    if not name:
        return None
    devices = list(enumerate(sd.query_devices()))
    inputs = [(i, str(d["name"])) for i, d in devices if int(d["max_input_channels"]) > 0]
    for i, n in inputs:
        if n == name:
            return i
    for i, n in inputs:
        if name.lower() in n.lower():
            return i
    raise ValueError(f"No input device named {name!r}")


class Microphone:
    """Opens an input device and collects audio in a thread-safe queue."""

    def __init__(self, name: str | None = None) -> None:
        index = _find(name)
        info = sd.query_devices(index, "input")
        self.name = str(info["name"])
        self.rate = int(info["default_samplerate"])
        self.chunks: queue.Queue[np.ndarray] = queue.Queue()
        self.stream = sd.InputStream(
            device=index,
            channels=1,
            samplerate=self.rate,
            dtype="float32",
            blocksize=self.rate // 10,
            callback=self._callback,
        )

    def _callback(self, indata: np.ndarray, frames: int, time, status) -> None:  # noqa: ANN001
        # Runs on PortAudio's thread: do nothing slow here, just hand it over.
        self.chunks.put(indata[:, 0].copy())

    def start(self) -> None:
        self.stream.start()

    def close(self) -> None:
        self.stream.stop()
        self.stream.close()

    def read(self) -> np.ndarray:
        """Everything captured since the last read, at 16 kHz."""
        parts = []
        while True:
            try:
                parts.append(self.chunks.get_nowait())
            except queue.Empty:
                break
        if not parts:
            return np.zeros(0, dtype=np.float32)
        return resample(np.concatenate(parts), self.rate).astype(np.float32)
