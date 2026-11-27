import argparse
import asyncio
import contextlib
import logging
from pathlib import Path

from souffleur_voice.asr import PARAKEET as DEFAULT_MODEL

# 8765 is taken by the Teleprompter Plus plugin.
DEFAULT_PORT = 8791


def main() -> None:
    p = argparse.ArgumentParser(prog="souffleur-voice", description=__doc__)
    sub = p.add_subparsers(dest="cmd")

    serve = sub.add_parser("serve", help="listen and serve the prompter (default)")
    serve.add_argument("--device", help="microphone name (or part of it); default: system")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)

    sub.add_parser("devices", help="list microphones")

    b = sub.add_parser("bench", help="run a WAV recording through the pipeline")
    b.add_argument("audio", type=Path, help="16-bit WAV of you reading the script")
    b.add_argument("script", type=Path, help="the script, as .md or .txt")
    b.add_argument(
        "--speak-headings",
        action="store_true",
        help="count headings as spoken (like the plugin's 'Read headings aloud')",
    )

    for sp in (serve, b):
        sp.add_argument(
            "--model",
            default=DEFAULT_MODEL,
            help="Hugging Face id of a Parakeet model",
        )
        sp.add_argument("--lang", default="nl", help="language for spelling out numbers")
        sp.add_argument(
            "--portable",
            action="store_true",
            help="avoid the Metal-only attention kernel (testing on non-Mac)",
        )
    p.add_argument("-v", "--verbose", action="store_true")

    args = p.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(message)s",
        datefmt="%H:%M:%S",
    )

    match args.cmd:
        case "devices":
            from souffleur_voice.audio import input_devices

            for d in input_devices():
                print(("* " if d.default else "  ") + d.name)
        case "bench":
            from souffleur_voice.asr import make_recognizer
            from souffleur_voice.bench import bench, read_wav, script_words

            recognizer = make_recognizer(args.model, portable=args.portable)
            words = script_words(args.script.read_text(encoding="utf-8"), args.speak_headings)
            bench(recognizer, read_wav(args.audio), words)
        case _:
            from souffleur_voice.asr import make_recognizer
            from souffleur_voice.download import download
            from souffleur_voice.server import VoiceServer, serve_forever

            portable = getattr(args, "portable", False)
            server = VoiceServer(
                lambda model_id: make_recognizer(model_id, portable=portable),
                model=getattr(args, "model", DEFAULT_MODEL),
                device=getattr(args, "device", None),
                lang=getattr(args, "lang", "nl"),
                prepare=download,
            )
            with contextlib.suppress(KeyboardInterrupt):
                asyncio.run(
                    serve_forever(
                        server,
                        getattr(args, "host", "127.0.0.1"),
                        getattr(args, "port", DEFAULT_PORT),
                    )
                )


if __name__ == "__main__":
    main()
