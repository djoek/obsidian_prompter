import argparse
import asyncio
import contextlib
import logging
from pathlib import Path

DEFAULT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"


def main() -> None:
    p = argparse.ArgumentParser(prog="prompter-voice", description=__doc__)
    sub = p.add_subparsers(dest="cmd")

    serve = sub.add_parser("serve", help="listen and serve the prompter (default)")
    serve.add_argument("--device", help="microphone name (or part of it); default: system")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)

    sub.add_parser("devices", help="list microphones")

    b = sub.add_parser("bench", help="run a WAV recording through the pipeline")
    b.add_argument("audio", type=Path, help="16-bit WAV of you reading the script")
    b.add_argument("script", type=Path, help="the script, as .md or .txt")

    for sp in (serve, b):
        sp.add_argument("--model", default=DEFAULT_MODEL)
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
            from prompter_voice.audio import input_devices

            for d in input_devices():
                print(("* " if d.default else "  ") + d.name)
        case "bench":
            from prompter_voice.asr import ParakeetRecognizer
            from prompter_voice.bench import bench, read_wav, script_words

            recognizer = ParakeetRecognizer(args.model, portable=args.portable)
            words = script_words(args.script.read_text(encoding="utf-8"))
            bench(recognizer, read_wav(args.audio), words)
        case _:
            from prompter_voice.asr import ParakeetRecognizer
            from prompter_voice.server import VoiceServer, serve_forever

            server = VoiceServer(
                lambda: ParakeetRecognizer(args.model, portable=getattr(args, "portable", False)),
                device=getattr(args, "device", None),
                lang=getattr(args, "lang", "nl"),
            )
            with contextlib.suppress(KeyboardInterrupt):
                asyncio.run(
                    serve_forever(
                        server, getattr(args, "host", "127.0.0.1"), getattr(args, "port", 8765)
                    )
                )


if __name__ == "__main__":
    main()
