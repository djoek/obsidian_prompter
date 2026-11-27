"""Run a recording through recognizer + aligner, as if it came from the mic.

Shows how fast the model is on this machine (real-time factor: compute time
divided by audio time; below 1.0 keeps up) and how the position moves.
"""

import re
import time
import wave
from pathlib import Path

import numpy as np

from prompter_voice.aligner import Aligner
from prompter_voice.asr import SAMPLE_RATE, Recognizer, resample
from prompter_voice.normalize import normalize_text


def script_words(markdown: str) -> list[str]:
    """Rough Markdown → words, close to what the plugin shows."""
    text = re.sub(r"\A---\n.*?\n---\n", "", markdown, flags=re.S)  # frontmatter
    text = re.sub(r"%%.*?%%|<!--.*?-->", " ", text, flags=re.S)  # comments
    text = re.sub(r"^\s*(#{1,6}|[-*+]|\d+[.)]|>)\s+", "", text, flags=re.M)
    text = re.sub(r"^\s*([-*_])(\s*\1){2,}\s*$", "", text, flags=re.M)  # ---
    text = re.sub(r"\*\*|__|==|~~|\*|`", "", text)
    return text.split()


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        if w.getsampwidth() != 2:
            raise ValueError("Use a 16-bit PCM WAV file")
        audio = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        if w.getnchannels() > 1:
            audio = audio.reshape(-1, w.getnchannels()).mean(axis=1)
        return resample(audio, w.getframerate()).astype(np.float32)


def bench(recognizer: Recognizer, audio: np.ndarray, words: list[str], tick: float = 0.25) -> None:
    aligner = Aligner(words)
    step = int(SAMPLE_RATE * tick)
    total = worst = 0.0
    for start in range(0, len(audio), step):
        t0 = time.perf_counter()
        heard = recognizer.feed(audio[start : start + step])
        moved = aligner.update(normalize_text(" ".join(heard)))
        spent = time.perf_counter() - t0
        total += spent
        worst = max(worst, spent)
        if moved is not None:
            at = start / SAMPLE_RATE
            context = " ".join(words[max(0, moved - 4) : moved + 1])
            print(f"{at:6.2f}s  word {moved:4d}  …{context}")
    seconds = len(audio) / SAMPLE_RATE
    print()
    print(f"Model:            {recognizer.name}")
    print(f"Audio:            {seconds:.1f} s")
    print(f"Real-time factor: {total / seconds:.2f}  (below 1.0 keeps up)")
    print(f"Slowest step:     {worst * 1000:.0f} ms for {tick * 1000:.0f} ms of audio")
    print(f"Reached word:     {aligner.word} of {len(words) - 1}")
