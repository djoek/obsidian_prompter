from souffleur_voice.aligner import Aligner
from souffleur_voice.normalize import normalize, normalize_text

SCRIPT = [
    "Hallo,",
    "welkom",
    "bij",
    "deze",
    "video.",
    "Vandaag",
    "vertel",
    "ik",
    "je",
    "waarom",
    "ik",
    "met",
    "een",
    "teleprompter",
    "werk,",
    "en",
    "hoe",
    "je",
    "er",
    "zelf",
    "meteen",
    "mee",
    "aan",
    "de",
    "slag",
    "kan.",
    "In",
    "2026",
    "kost",
    "zo'n",
    "opstelling",
    "ongeveer",
    "350",
    "euro.",
    "—",
    "Dat",
    "was",
    "het",
    "voor",
    "vandaag.",
    "Tot",
    "de",
    "volgende",
    "keer!",
]


def idx(word: str) -> int:
    return next(i for i, w in enumerate(SCRIPT) if w.strip(".,!") == word)


def test_normalize():
    assert normalize("Zo'n") == "zon"
    assert normalize("video.") == "video"
    assert normalize("2026") == "tweeduizendzesentwintig"
    assert normalize("—") == ""
    assert normalize_text("Één, twee!") == ["een", "twee"]


def test_follows_clean_speech():
    a = Aligner(SCRIPT)
    assert a.update(normalize_text("hallo welkom bij deze video")) == idx("video")
    assert a.update(normalize_text("vandaag vertel ik je waarom")) == idx("waarom")


def test_tolerates_misheard_and_filler_words():
    a = Aligner(SCRIPT)
    heard = normalize_text("uhm vandaag vertelt ik u waarom ik met een tele prompter")
    # "prompter" is 80% similar to "teleprompter": close enough to count.
    assert a.update(heard) == idx("teleprompter")


def test_one_common_word_is_not_enough():
    a = Aligner(SCRIPT)
    assert a.update(normalize_text("de")) is None
    assert a.word == 0


def test_spoken_numbers():
    a = Aligner(SCRIPT)
    a.seek(idx("zelf"))
    heard = normalize_text("in tweeduizend zesentwintig kost zon opstelling")
    assert a.update(heard) == idx("opstelling")


def test_seek_and_retake():
    a = Aligner(SCRIPT)
    a.seek(idx("zelf"))
    a.update(normalize_text("zelf meteen mee aan de slag kan"))
    # You fumble and restart the sentence: going back needs strong evidence...
    assert a.update(normalize_text("en hoe")) is None
    # ...which a longer restart provides.
    assert a.update(normalize_text("en hoe je er zelf")) == idx("zelf")


def test_repeated_phrase_prefers_nearest_ahead():
    words = [
        "en",
        "dan",
        "nog",
        "dit",
        ".",
        "en",
        "dan",
        "nog",
        "dat",
        ".",
        "en",
        "dan",
        "nog",
        "iets",
    ]
    a = Aligner(words)
    a.seek(5)
    assert a.update(normalize_text("en dan nog")) == 7


def test_small_corrections_backwards_are_ignored():
    # Seen with real Parakeet output: at 5.75 s the draft words reached word 17
    # ("je"), at 6.00 s the revised words ended at word 15 ("en").
    a = Aligner(SCRIPT)
    a.seek(idx("teleprompter"))
    assert a.update(normalize_text("met een teleprompter werk en hoe je")) == 17
    assert a.update(normalize_text("ik met een teleprompter werk en")) is None
    assert a.word == 17


def test_bench_script_words_skip_margin_notes():
    from souffleur_voice.bench import script_words

    md = "Dat was het^[glimlach] voor vandaag[^1].\n\n[^1]: niet\n    uitspreken\n"
    assert script_words(md) == ["Dat", "was", "het", "voor", "vandaag."]


def test_bench_script_words_skip_headings_unless_spoken():
    from souffleur_voice.bench import script_words

    md = "# Video 1\n\nHallo daar.\n"
    assert script_words(md) == ["Hallo", "daar."]
    assert script_words(md, speak_headings=True) == ["Video", "1", "Hallo", "daar."]
