# Teleprompter for Obsidian

A teleprompter that reads a note straight from your vault and shows it in a
separate window, which you drag to the prompter display (for example an Elgato
Prompter over DisplayLink) and make fullscreen.

## Install

### With BRAT (recommended: updates itself)

1. Install the community plugin **BRAT** (Obsidian42 - BRAT) and enable it.
2. Command palette → **BRAT: Add a beta plugin for testing**.
3. Paste `https://github.com/djoek/obsidian_prompter` and confirm.
4. Enable **Teleprompter** under *Settings → Community plugins*.

BRAT downloads `main.js`, `manifest.json` and `styles.css` from the latest
GitHub release, and checks for updates.

### From source

```bash
cd "<your vault>/.obsidian/plugins"
git clone https://github.com/djoek/obsidian_prompter teleprompter
cd teleprompter
bun install
bun run build
```

Then enable **Teleprompter** under *Settings → Community plugins*.

## Use

1. Open your script note.
2. Command palette → **Teleprompter: Open teleprompter for current note**
   (or **…at cursor** to start at the paragraph your cursor is in).
3. A new window opens. Drag it to the prompter display, click in it, press **F**.

| Key | Action |
|---|---|
| Space | Play / pause |
| N | Next section |
| P | Back to the start of this section; press again for the previous one |
| ↑ / ↓ | One line back / forward |
| PageUp / PageDown | Half a screen back / forward |
| + / − | Speed ±10 words per minute (saved) |
| Home / End | First / last section |
| H | Show/hide the status bar |
| F | Fullscreen on/off (Esc also leaves) |
| Mouse wheel | Scroll by hand |

Play/pause, next, previous, faster and slower are also Obsidian commands, so
you can give them hotkeys that work from the main window, or trigger them from
a Stream Deck that sends those hotkeys.

## How the note is read

- `---` on its own line starts a **new section** (one video). Frontmatter at the
  top is skipped. Note: a `---` directly under a line of text is also treated
  as a section break here, even though Markdown would normally make that line a
  heading.
- Headings, paragraphs, list items and `>` quotes each get their own **speed
  multiplier**.
- `%% comments %%` and `<!-- comments -->` are **hidden**: use them for
  directions to yourself.
- `**bold**`, `*italic*`, `==highlight==` and `~~strike~~` are shown.
  Links show their text; embeds and images are left out; code blocks are skipped.
- Edits to the note show up in the prompter while it is open, and it keeps
  your place.

## How the scrolling is paced

Speed is set in **words per minute**. For the block on the eye line, the
prompter takes "number of words ÷ words per minute" as the time it should take
to pass, and scrolls that block's height in that time. So a short heading
passes quickly and a dense paragraph slowly, at the same speaking pace. On top
of that:

- each block type has a multiplier (*Heading speed ×*, …);
- headings can hold on the eye line for a moment (*Pause at heading*);
- at a section break it can stop and wait for Space (*Stop at section break*).

Jumping (N, P, Home, End) always pauses, so you get a breath before the take.

## Development

```bash
bun install
bun run dev        # the engine in a browser page, with dev/sample.md
bun run watch      # rebuild main.js on every change
bun test           # parser tests
bun run typecheck
```

### Releasing

1. Raise `version` in `manifest.json` (and `package.json`), commit, push.
2. Tag that exact version, without a `v`, and push the tag:

   ```bash
   git tag 0.1.1 && git push origin 0.1.1
   ```

`.github/workflows/release.yml` then tests, builds and publishes a release with
`main.js`, `manifest.json` and `styles.css`. It fails if the tag and the
manifest version differ, because BRAT and Obsidian compare those.

`src/parser.ts` (Markdown → blocks and sections) and `src/prompter.ts` (the
scroll engine) don't import Obsidian, so they can be tested and tried outside
of it. `src/view.ts` and `src/main.ts` are the Obsidian glue.

## Planned: voice tracking

Every word is rendered as `<span data-w="n">`. The plan is a small local
Python process that listens to a chosen microphone, transcribes with
Parakeet TDT 0.6B v3 (via `parakeet-mlx` on Apple Silicon, Dutch supported),
fuzzy-matches the recent words against the script just ahead of the current
position, and sends the matched word index to the prompter over a WebSocket.
The prompter then scrolls to and highlights that word instead of using a fixed
speed.
