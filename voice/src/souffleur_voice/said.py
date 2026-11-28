"""Where what you said differs from the script, for editing before take 2.

1. Find the section in the end of the session transcript: the stretches of at
   least two words that match the script mark where it starts and ends.
2. Compare that part word by word with the script (difflib). Words are
   compared normalized, as the aligner does (case, punctuation, numbers), so
   "2026" and "tweeduizend zesentwintig" are the same.
3. Report the stretches that differ, in the script's and the transcript's
   own spelling. Pairs that only differ in where words split ("tele prompter",
   or a number said as two words) are left out. A one-letter difference is
   kept: that's often a typo you corrected while reading.

What it can't tell apart: a paraphrase, a typo you corrected while reading,
and a word the speech model misheard. The result is a list of hints.
"""

from dataclasses import dataclass
from difflib import SequenceMatcher

from souffleur_voice.normalize import normalize


@dataclass
class Said:
    heard: str  # what the speech model heard for the section
    changes: list["Change"]


@dataclass
class Change:
    script: str  # as written ("" if you added words)
    said: str  # as heard ("" if you left words out)


def _tokens(words: list[str], lang: str) -> tuple[list[str], list[str]]:
    """Normalized tokens and their original spelling, empties dropped."""
    norm, orig = [], []
    for w in words:
        n = normalize(w, lang)
        if n:
            norm.append(n)
            orig.append(w)
    return norm, orig


def section_changes(
    script_words: list[str], transcript: str, lang: str = "nl"
) -> list[Change] | None:
    """The differences, or None if the section can't be found in the transcript."""
    found = section_said(script_words, transcript, lang)
    return None if found is None else found.changes


def section_said(script_words: list[str], transcript: str, lang: str = "nl") -> Said | None:
    """What was heard for the section, and how it differs from the script;
    None if the section can't be found in the transcript."""
    script, script_orig = _tokens(script_words, lang)
    if not script:
        return Said("", [])
    heard_all = transcript.split()
    # Only the end of the transcript can hold the section just read.
    tail = heard_all[-(4 * len(script) + 50) :]
    heard, heard_orig = _tokens(tail, lang)

    blocks = [
        b
        for b in SequenceMatcher(None, script, heard, autojunk=False).get_matching_blocks()
        if b.size >= 2
    ]
    if not blocks:
        return None
    first, last = blocks[0], blocks[-1]
    # Where the section's first and last words would be, counting words. A
    # word can be said as two ("2026") or two as one, so try a few edges and
    # keep the pair whose letters match the script best.
    base_start = max(0, first.b - first.a)
    base_end = last.b + last.size + (len(script) - (last.a + last.size))
    letters = "".join(script)

    def fit(edges: tuple[int, int]) -> float:
        return SequenceMatcher(None, letters, "".join(heard[edges[0] : edges[1]])).ratio()

    starts = range(max(0, base_start - 3), base_start + 1)
    ends = range(min(len(heard), base_end), min(len(heard), base_end + 3) + 1)
    start, end = max(((a, b) for a in starts for b in ends if b > a), key=fit)
    part, part_orig = heard[start:end], heard_orig[start:end]

    changes: list[Change] = []
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, script, part, autojunk=False).get_opcodes():
        if tag == "equal" or "".join(script[i1:i2]) == "".join(part[j1:j2]):
            continue
        changes.append(Change(" ".join(script_orig[i1:i2]), " ".join(part_orig[j1:j2])))
    return Said(" ".join(part_orig), changes)
