from souffleur_voice.said import Change, section_changes, section_said

SCRIPT = [
    "Ik",
    "heb",
    "een",
    "manager",
    "maandenlang",
    "horen",
    "klagen",
    "over",
    "hoe",
    "het",
    "proces",
    "mank",
    "liep.",
    "Een",
    "ruwe",
    "schattig",
    "werd",
    "genoemd",
    "en",
    "het",
    "moest",
    "opgelost",
    "zijn",
    "voor",
    "2026.",
]
EARLIER = "dat was de vorige video tot de volgende keer"


def test_reading_it_as_written_has_no_changes():
    said = EARLIER + " ik heb een manager maandenlang horen klagen over hoe het proces mank liep "
    said += (
        "een ruwe schattig werd genoemd en het moest opgelost zijn voor tweeduizend zesentwintig"
    )
    assert section_changes(SCRIPT, said) == []


def test_paraphrase_and_corrected_typo_are_reported():
    said = (
        EARLIER
        + " Ik heb een manager maandenlang horen klagen over hoe het proces niet goed liep. "
    )
    said += "Een ruwe schatting werd genoemd en het moest opgelost zijn voor 2026."
    assert section_changes(SCRIPT, said) == [
        Change("mank", "niet goed"),
        Change("schattig", "schatting"),
    ]


def test_added_and_skipped_words():
    said = "ik heb een manager echt maandenlang horen klagen over hoe het proces mank liep "
    said += "een ruwe schattig werd genoemd en het moest opgelost zijn"
    assert section_changes(SCRIPT, said) == [
        Change("", "echt"),
        Change("voor 2026.", ""),
    ]


def test_near_identical_words_are_not_noise():
    words = ["Dat", "is", "oké", "voor", "mij", "en", "voor", "jou."]
    assert section_changes(words, "dat is oke voor mij en voor jou") == []


def test_section_not_found():
    assert section_changes(SCRIPT, "iets heel anders gezegd vandaag") is None


def test_next_section_already_started_is_not_reported():
    said = EARLIER + " ik heb een manager maandenlang horen klagen over hoe het proces mank liep "
    said += "een ruwe schattig werd genoemd en het moest opgelost zijn voor 2026 "
    said += "hallo en welkom bij de volgende"  # you went on before the request came
    assert section_changes(SCRIPT, said) == []


def test_heard_text_is_the_section_only():
    said = (
        EARLIER
        + " Ik heb een manager maandenlang horen klagen over hoe het proces niet goed liep. "
    )
    said += "Een ruwe schatting werd genoemd en het moest opgelost zijn voor 2026. Hallo en welkom"
    found = section_said(SCRIPT, said)
    assert found is not None
    assert found.heard.startswith("Ik heb een manager")
    assert found.heard.endswith("voor 2026.")
