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


def words(text: str) -> list[str]:
    return text.split()


# Two videos that share their opening and sign-off, as a file of 20 videos does.
VIDEOS = words(
    "Hallo en welkom bij deze video over licht . Vandaag leg ik uit hoe je een "
    "softbox plaatst en waarom dat werkt . Dat was het , tot de volgende keer . "
    "Hallo en welkom bij deze video over geluid . Vandaag leg ik uit hoe je een "
    "microfoon kiest en waar je hem zet . Dat was het , tot de volgende keer ."
)
SECOND = VIDEOS.index("Hallo", 1)
SECTIONS = [0, SECOND]


def sectioned() -> Aligner:
    return Aligner(VIDEOS, sections=SECTIONS)


def test_quiet_at_section_end_does_not_jump_ahead():
    a = sectioned()
    a.update(normalize_text("Hallo en welkom bij deze video over licht"))
    a.seek(VIDEOS.index("Dat"))
    a.update(normalize_text("dat was het tot de volgende keer"))
    end = a.word
    # Silence: the model revises its last words; the same sign-off exists
    # further on, but the next video hasn't started.
    assert a.update(normalize_text("was het tot de volgende keer")) is None
    assert a.update(normalize_text("tot de volgende keer")) is None
    assert a.word == end


def test_next_section_starts_when_its_first_words_are_heard():
    a = sectioned()
    a.seek(VIDEOS.index("Dat"))
    a.update(normalize_text("dat was het tot de volgende keer"))
    moved = a.update(normalize_text("tot de volgende keer hallo en welkom bij deze video"))
    assert moved is not None and moved >= SECOND


def test_after_a_jump_wait_for_the_first_words():
    a = sectioned()
    a.seek(SECOND)  # you pressed N
    # Words that only match deep into the section are ignored...
    assert a.update(normalize_text("microfoon kiest en waar")) is None
    assert a.word == SECOND
    # ...until the section's first words are heard.
    assert a.update(normalize_text("hallo en welkom bij deze")) is not None


def test_never_skips_a_whole_section():
    third = VIDEOS + words("Hallo en welkom bij deze video over kleur .")
    a = Aligner(third, sections=[0, SECOND, len(VIDEOS)])
    a.update(normalize_text("Hallo en welkom bij deze video over licht"))
    # The third video's opening, while still in the first: not followed.
    assert a.update(normalize_text("hallo en welkom bij deze video over kleur")) is None
    assert a.section_of(a.pos) == 0


def test_starting_mid_section_still_follows():
    a = sectioned()
    a.seek(VIDEOS.index("softbox"))  # opened at the cursor, mid-video
    assert a.update(normalize_text("softbox plaatst en waarom dat werkt")) is not None
