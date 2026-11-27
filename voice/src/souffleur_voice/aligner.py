"""Find where in the script the speaker is, from a few recently heard words.

The method is Smith–Waterman *local alignment*, from bioinformatics: it finds
where a short, noisy fragment (the last ~10 heard words) fits best inside a
long reference (the script). It tolerates the three kinds of noise we get:

- a word heard wrong       → a weak or negative *match* score
- a word you skipped        → a *gap* in the heard words (script word unmatched)
- a word you added / "uhm"  → a *gap* in the script (heard word unmatched)

We fill a table where cell (i, j) holds the best score of an alignment that
ends with heard word i against script word j. Every cell looks at three
neighbours (diagonal = match, up = extra heard word, left = skipped script
word) and never drops below 0. That floor at 0 is what makes it *local*: a bad
stretch earlier doesn't drag down a good match later.

Two teleprompter-specific choices on top:

1. We only search a *window* around the current position (a bit back, more
   ahead). This is faster, and stops "en dan" from matching a sentence three
   videos further down.
2. We prefer alignments that end at the *latest* heard word, because we want
   where you are now, not where you were two seconds ago.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache

from rapidfuzz.fuzz import ratio

from souffleur_voice.normalize import normalize

GAP = -1.0
MISMATCH = -1.0
# A word counts as matched if it is at least this similar (0..1).
SIMILAR = 0.8
PARTIAL = 0.6


@lru_cache(maxsize=65536)
def match_score(heard: str, written: str) -> float:
    """Longer words are stronger evidence: 'de' matching proves little,
    'teleprompter' matching proves a lot."""
    sim = ratio(heard, written) / 100
    weight = 1 + min(len(written), 6) / 6  # 1.17 .. 2.0
    if sim >= SIMILAR:
        return weight * sim
    if sim >= PARTIAL:
        return 0.5 * weight * sim
    return MISMATCH


@dataclass
class Match:
    word: int  # index in the original script words (the prompter's data-w)
    token: int  # index in Aligner.tokens
    score: float


@dataclass
class Aligner:
    """Keeps the current position and moves it as new words are heard."""

    words: Sequence[str]
    lang: str = "nl"
    back: int = 40  # how many script words behind the position we search
    ahead: int = 150  # how many ahead
    min_score: float = 4.0  # ~ two or three solid word matches
    min_score_back: float = 6.0  # going backwards needs stronger evidence
    recency: float = 0.75  # penalty per heard word left unaligned at the end
    # Hysteresis: ignore going back by this many words or fewer. The model's
    # draft words sometimes run ahead and then get corrected; following that
    # would make the screen twitch, and a few words back is the same line.
    ignore_back: int = 3

    def __post_init__(self) -> None:
        # Normalized tokens, plus where each came from in `words`. Tokens that
        # normalize to nothing (a dash, an emoji) are left out.
        self.tokens: list[str] = []
        self.origin: list[int] = []
        for i, w in enumerate(self.words):
            n = normalize(w, self.lang)
            if n:
                self.tokens.append(n)
                self.origin.append(i)
        self.pos = 0  # index into self.tokens

    @property
    def word(self) -> int:
        """Current position as an index into the original words."""
        return self.origin[self.pos] if self.origin else 0

    def seek(self, word: int) -> None:
        """Jump to an original word index (when you press N or P)."""
        self.pos = next((t for t, o in enumerate(self.origin) if o >= word), len(self.origin) - 1)
        self.pos = max(self.pos, 0)

    def _distance(self, token: int) -> int:
        """How far a candidate is from us; behind counts double, since speech
        mostly moves forward."""
        d = token - self.pos
        return d if d >= 0 else 1 - 2 * d

    def locate(self, heard: Sequence[str]) -> Match | None:
        """Best alignment of `heard` (normalized) inside the search window."""
        if not heard or not self.tokens:
            return None
        lo = max(0, self.pos - self.back)
        hi = min(len(self.tokens), self.pos + self.ahead)
        window = self.tokens[lo:hi]
        m, n = len(heard), len(window)

        prev = [0.0] * (n + 1)
        # Ranked by (score minus recency penalty, closeness to where we are).
        best_key: tuple[float, int] | None = None
        best_score, best_j = 0.0, 0
        for i in range(1, m + 1):
            cur = [0.0] * (n + 1)
            h = heard[i - 1]
            for j in range(1, n + 1):
                cur[j] = max(
                    0.0,
                    prev[j - 1] + match_score(h, window[j - 1]),
                    prev[j] + GAP,  # extra heard word
                    cur[j - 1] + GAP,  # skipped script word
                )
            # Only cells that end in a real match are candidate positions.
            for j in range(1, n + 1):
                if cur[j] <= 0 or match_score(h, window[j - 1]) <= 0:
                    continue
                key = (cur[j] - self.recency * (m - i), -self._distance(lo + j - 1))
                if best_key is None or key > best_key:
                    best_key, best_score, best_j = key, cur[j], j
            prev = cur

        if best_key is None:
            return None
        token = lo + best_j - 1
        return Match(word=self.origin[token], token=token, score=best_score)

    def update(self, heard: Sequence[str]) -> int | None:
        """Feed the latest heard words; returns the new word index if it moved."""
        found = self.locate(heard)
        if found is None:
            return None
        if self.pos - self.ignore_back <= found.token <= self.pos:
            return None
        needed = self.min_score if found.token > self.pos else self.min_score_back
        if found.score < needed:
            return None
        self.pos = found.token
        return found.word
