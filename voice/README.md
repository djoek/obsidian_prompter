# souffleur-voice

A small local process that listens to your microphone and tells the
teleprompter which word of the script you are saying. Nothing leaves your Mac.

```
microphone ─► sounddevice ─► Parakeet v3 (MLX) ─► aligner ─► WebSocket ─► Obsidian
   48 kHz        16 kHz        "…vandaag vertel     word 9    {"type":"position",
                                ik je waarom"                  "word": 9}
```

Requires an Apple Silicon Mac and [uv](https://docs.astral.sh/uv/).

## Run it

The plugin can start it for you (Settings → Souffleur → Voice tracking).
The default start command is:

```bash
uvx --from "souffleur-voice[parakeet] @ git+https://github.com/djoek/obsidian_prompter#subdirectory=voice" souffleur-voice serve
```

`uvx` installs it into a cached, isolated environment; nothing to clone.
The first start downloads the model (about 2.5 GB) to `~/.cache/huggingface`.

To see the log, run it in a terminal instead, and clear the start command in
the plugin settings:

```bash
uvx --from "souffleur-voice[parakeet] @ git+https://github.com/djoek/obsidian_prompter#subdirectory=voice" souffleur-voice serve --device "MacBook Pro Microphone"
```

macOS asks for microphone permission the first time, for whichever app
started the process: Obsidian, or your terminal.

### Commands

| Command | What it does |
|---|---|
| `souffleur-voice serve [--device NAME] [--port 8791]` | Listen and serve the prompter (default) |
| `souffleur-voice devices` | List microphones; `*` marks the default |
| `souffleur-voice bench recording.wav script.md` | Run a recording through the pipeline; prints speed and positions |

`--device` takes the full name or a part of it. The plugin's microphone
setting overrides it.

## How it decides where you are

The speech model does not have to be perfect, because it does not have to
write down what you said. It only has to give the aligner enough to find
*where in a text it already has* you are. That is a much easier problem.

1. **Recognise.** Every 0.25 s the newest audio goes into Parakeet in
   streaming mode. It returns *finalized* words (won't change) and *draft*
   words (best guess for the last fraction of a second). We take the last
   12 of both together.
2. **Normalize.** Both the script and the heard words are lowercased,
   stripped of accents and punctuation, and digits are spelled out in Dutch:
   `2026` → `tweeduizendzesentwintig`, `zo'n` → `zon`.
3. **Align.** Smith–Waterman local alignment (from bioinformatics, where it
   finds a short DNA read in a genome) finds where those words fit best in a
   window of the script: 40 words back, 150 ahead. Misheard words score
   low, skipped and extra words cost a small penalty, and similar words count
   partly (`prompter` vs `teleprompter`). Long words count more than short
   ones: matching *de* proves little, matching *opstelling* proves a lot.
4. **Decide.** The position only moves on enough evidence (two or three solid
   words). Going back needs more evidence than going forward. Going back by
   three words or fewer is ignored: that is the model revising its draft, not
   you going back, and it would make the screen twitch.

When you press N, P, Home or End in the prompter, the plugin tells this
process, which jumps there and forgets what it heard before.

## Tuning with `bench`

Record yourself reading part of a script (QuickTime → New Audio Recording,
then export, or any 16-bit WAV), and run:

```bash
uvx --from "souffleur-voice[parakeet] @ git+https://github.com/djoek/obsidian_prompter#subdirectory=voice" souffleur-voice bench take.wav script.md
```

It prints each position change with its time in the recording, then:

- **Real-time factor**: compute time ÷ audio time. Must stay well below 1.0,
  or the prompter falls behind.
- **Slowest step**: the worst delay for one 0.25 s step.
- **Reached word**: how far it got.

## Protocol

JSON over WebSocket on `ws://127.0.0.1:8791`. See the docstring at the top of
`src/souffleur_voice/server.py`.

## Development

```bash
cd voice
uv sync
uv run pytest
uv run ruff check . && uv run ruff format .
uv run ty check src tests
```

The tests use fakes for the microphone and model, so they run anywhere.
`--portable` makes the model avoid a Metal-only kernel and Apple's bfloat16,
so it can run (slowly) on a Linux CPU: `uv pip install "mlx[cpu]" parakeet-mlx`.

### Adding another model

`asr.py` defines a `Recognizer` protocol: `feed(audio) -> recent words` and
`reset()`. A Voxtral Realtime recognizer (via `mlx-audio`) would implement
those two methods; nothing else changes.
