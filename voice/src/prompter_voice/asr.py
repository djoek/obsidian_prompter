"""Speech recognizers. Each one takes audio and returns the latest heard words.

Parakeet TDT v3 (parakeet-mlx) is implemented. Other models can plug in by
implementing the `Recognizer` protocol and adding a case to `make_recognizer`.
"""

import logging
from typing import Protocol

import numpy as np

SAMPLE_RATE = 16_000
log = logging.getLogger("prompter_voice")

PARAKEET = "mlx-community/parakeet-tdt-0.6b-v3"


def resample(audio: np.ndarray, rate: int) -> np.ndarray:
    """To 16 kHz. Integer ratios (48k, 32k) average blocks, which also filters
    out frequencies the lower rate can't represent; others interpolate."""
    if rate == SAMPLE_RATE:
        return audio
    if rate % SAMPLE_RATE == 0:
        k = rate // SAMPLE_RATE
        n = len(audio) // k * k
        return audio[:n].reshape(-1, k).mean(axis=1)
    n = round(len(audio) * SAMPLE_RATE / rate)
    return np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio)


class Recognizer(Protocol):
    name: str

    def feed(self, audio: np.ndarray) -> list[str]:
        """Add 16 kHz mono float32 audio; return the most recent heard words."""
        ...

    def reset(self) -> None:
        """Forget everything heard (after a jump in the script)."""
        ...

    def set_language(self, language: str | None) -> None:
        """ISO 639-1 code, or None to let the model decide."""
        ...


def make_recognizer(model_id: str, portable: bool = False) -> Recognizer:
    return ParakeetRecognizer(model_id, portable=portable)


class ParakeetRecognizer:
    """Parakeet TDT v3 through parakeet-mlx, in streaming mode.

    Streaming mode keeps an encoder cache, so each call only processes the new
    audio. It returns two kinds of tokens: *finalized* (won't change any more)
    and *draft* (the best guess for the last fraction of a second). We use both,
    because a teleprompter cares more about "now" than about "certain".
    """

    def __init__(
        self,
        model_id: str = PARAKEET,
        context: tuple[int, int] = (256, 256),
        keep_words: int = 12,
        portable: bool = False,
    ) -> None:
        # Imported here so the rest of the package works without MLX.
        import mlx.core as mx
        from parakeet_mlx import from_pretrained

        self.name = model_id
        # bfloat16 is native on Apple GPUs but emulated (slow) on other CPUs.
        self.model = from_pretrained(model_id, dtype=mx.float32 if portable else mx.bfloat16)
        self.context = context
        self.keep_words = keep_words
        # `portable` avoids a Metal-only attention kernel; for testing off-Mac.
        self.portable = portable
        self._stream = None
        self.reset()

    def reset(self) -> None:
        if self._stream is not None:
            self._stream.__exit__(None, None, None)
        self._stream = self.model.transcribe_stream(
            context_size=self.context, keep_original_attention=self.portable
        ).__enter__()

    def feed(self, audio: np.ndarray) -> list[str]:
        import mlx.core as mx

        s = self._stream
        assert s is not None
        s.add_audio(mx.array(audio.astype(np.float32)))
        # Finalized tokens grow forever over an hour of recording; we only ever
        # need the tail, so trim them (the decoder keeps its own state).
        if len(s.finalized_tokens) > 200:
            del s.finalized_tokens[:-100]
        text = "".join(t.text for t in s.finalized_tokens + s.draft_tokens)
        return text.split()[-self.keep_words :]

    def set_language(self, language: str | None) -> None:
        # Parakeet v3 has no language input: it guesses from the audio.
        if language:
            log.info("Parakeet v3 can't be told the language (%s); it detects it.", language)

    def close(self) -> None:
        if self._stream is not None:
            self._stream.__exit__(None, None, None)
            self._stream = None
