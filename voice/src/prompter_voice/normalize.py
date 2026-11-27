"""Turn written words and heard words into the same comparable form.

The script says "2026," and "zo'n"; the speech model may hear
"tweeduizend zesentwintig" and "zon". Before comparing, both sides go through
`normalize`: lowercase, no accents, no punctuation, digits spelled out in Dutch.
"""

import re
import unicodedata

from num2words import num2words

_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
_NOT_WORD = re.compile(r"[^0-9a-z]+")


def _spell(match: re.Match[str], lang: str) -> str:
    text = match.group().replace(",", ".")
    try:
        return num2words(float(text) if "." in text else int(text), lang=lang)
    except (NotImplementedError, OverflowError, ValueError):
        return match.group()


def normalize(word: str, lang: str = "nl") -> str:
    """One token in, one comparable token out ("" if nothing speakable is left)."""
    w = unicodedata.normalize("NFKD", word.lower())
    w = "".join(c for c in w if not unicodedata.combining(c))
    w = _NUMBER.sub(lambda m: _spell(m, lang), w)
    return _NOT_WORD.sub("", w)


def normalize_text(text: str, lang: str = "nl") -> list[str]:
    """Split heard text on whitespace and normalize; drop empty tokens."""
    return [n for n in (normalize(t, lang) for t in text.split()) if n]
