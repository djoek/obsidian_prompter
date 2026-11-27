# Souffleur

*A prompter teleprompter that follows your voice.*

In the theatre, the souffleur sits out of sight and follows the actors through
the script, ready with the next line. This Obsidian plugin does the same for
video: 
it reads a note straight from your vault and shows it in a
separate window, which you drag to the prompter display (for example an Elgato
Prompter over DisplayLink) and make fullscreen.

## Install

### With BRAT (recommended: updates itself)

1. Install the community plugin **BRAT** (Obsidian42 - BRAT) and enable it.
2. Command palette → **BRAT: Add a beta plugin for testing**.
3. Paste `https://github.com/djoek/obsidian-souffleur` and confirm.
4. Enable **Souffleur** under *Settings → Community plugins*.

BRAT downloads `main.js`, `manifest.json` and `styles.css` from the latest
GitHub release, and checks for updates.

### From source

```bash
cd "<your vault>/.obsidian/plugins"
git clone https://github.com/djoek/obsidian-souffleur souffleur
cd souffleur
bun install
bun run build
```

Then enable **Souffleur** under *Settings → Community plugins*.

### Upgrading from "Teleprompter" (0.4.0 and earlier)

This plugin used to be called Teleprompter, with the id `teleprompter`. That id
belongs to another plugin, so it is now **Souffleur** (`souffleur`), and Obsidian
treats it as a new plugin:

1. Install Souffleur (BRAT or from source, as above) and enable it. On its first
   start it copies your settings from the old plugin and says so.
2. Disable and remove the old **Teleprompter** plugin.
3. If you set a custom voice start command or address: the voice process is now
   `souffleur-voice`, on port 8791. Default values are updated for you.
4. In notes, the settings block is now `souffleur:` instead of `teleprompter:`.
   A top-level `language:` is unchanged.

## Use

1. Open your script note.
2. Command palette → **Souffleur: Open teleprompter for current note**
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
| Esc | Pause (also from the main window, when you go back to editing) |
| H | Show/hide the status bar |
| F | Fullscreen on/off (Esc also leaves) |
| V | Voice tracking on/off |
| R | Reset voice matching (see below) |
| D | Diagnostics: frame rate, position, window state |
| Mouse wheel | Scroll by hand |

Play/pause, next, previous, faster and slower are also Obsidian commands, so
you can give them hotkeys that work from the main window, or trigger them from
a Stream Deck that sends those hotkeys.

If the text doesn't scroll in macOS full screen (the green button), press **D**:
`raf` counts normal animation frames and `timer` counts frames from the
fallback timer. The prompter keeps moving either way; if both counts move but
the text doesn't, please report what the overlay says.

## Pedals, clickers and MIDI

*Settings → Pedals, clickers and MIDI* lists the actions you can give your own
input: play/pause, next section, previous section (retake), faster, slower, one
line down or up, and reset voice matching. Press **Learn**, then the pedal:

- **A key:** foot pedals and presentation clickers act as keyboards. Works
  while the prompter window is active, and replaces that key's built-in action
  (so a clicker's PageDown can mean "next section").
- **MIDI:** Note On, Control Change (a sustain pedal, CC 64, counts once per
  press) or Program Change. Works whichever window is active.

**MIDI device** and **MIDI channel** limit which messages count, for when a
keyboard or pad controller is connected too: choose a device after **Find
devices**, and a channel 1–16 (or all). A device that's unplugged stays
selected. An action can have several inputs; the × removes one. MIDI is only opened
while learning or when a MIDI input is in use, so without MIDI there's no
permission prompt.

## Per-note settings (frontmatter)

A note can override any setting in its frontmatter. All of it is optional.

```yaml
---
language: nl          # or lang: — a code (nl, nl-BE) or a name (Nederlands)
souffleur:
  fontSize: 64
  wpm: 150
  flipH: true
  nextColor: "#ffd166"
---
```

The keys under `souffleur:` are the setting names from `src/settings.ts`
(for example `fontFamily`, `lineHeight`, `eyeLine`, `headingPause`,
`stopAtSection`, `rotation`). Wrong names or values are ignored and listed in
a notice. Voice-process settings (command, address, microphone) are
machine-wide and can't be set per note. With a `wpm` in the note, + and −
change the speed for this session only.

## How the note is read

- `---` on its own line starts a **new section** (one video). Frontmatter at the
  top is skipped. Note: a `---` directly under a line of text is also treated
  as a section break here, even though Markdown would normally make that line a
  heading.
- Headings, paragraphs, list items and `>` quotes each get their own **speed
  multiplier**.
- Headings are **labels**, not text you say: they show, but aren't highlighted,
  matched by voice tracking or counted in the timing (their pause stays). Turn
  on *Pacing → Read headings aloud* if you do say them, or per note with
  `souffleur: { speakHeadings: true }`.
- `%% comments %%` and `<!-- comments -->` are **hidden**: use them for
  directions to yourself.
- `**bold**`, `*italic*`, `==highlight==` and `~~strike~~` look the way your
  theme shows them in reading view. Souffleur only sets what makes it a
  prompter: background, text colour, font, size and spacing.
- What is shown but **not spoken** (unspoken headings, margin notes, section
  labels and `---` separators) shares one look: the *Not spoken* colour, in
  italic, so it's clear at a glance what not to say.
  Links show their text; embeds and images are left out; code blocks are skipped.
- Edits to the note show up in the prompter while it is open, and it keeps
  your place.

## How long is each video?

The status bar shows how long you've been in the current section, and how long
it normally takes at your speed: `1:12 · normally 2:05`. The timer counts up
while the prompter plays or listens, and starts again at 0:00 in every section,
also when you press P for a retake. It doesn't count down and doesn't hurry
you: if a section keeps running long, the text needs shortening.

"Normally" uses the same pacing as auto-scroll: your words per minute, the
speed per block type, and the pause at each heading. A note's own `wpm` (in its
frontmatter) counts.

**After a take:** in voice mode, when you've read a section to its end,
Souffleur writes how long it took into the note, at the end of that section:

```markdown
%% last run: 2:07 · 2026-11-28 14:03 %%
```

It's timed from the first word heard to the last (starting over, or P, starts
the clock again), and the next run replaces the line. Being a comment, it never
shows in the prompter. Turn it off with *Pacing → Note the last run*.

**While writing:** the command **Show section lengths** opens a sidebar with
every section of the note you're editing, its word count and its normal length,
plus the total. Click a section to go to it. It updates as you type and never
changes the note.

## Starting

- **Countdown:** Play shows 3, 2, 1 before the text moves (*Countdown before
  Play*, 0 to switch off). Not in voice mode, where the text waits for you.
- **Smooth start:** the text eases up to speed over a second (*Smooth start*).
- **Keep the screen awake** while playing or listening (on by default).

## Margin notes

Footnotes in your script show in the margin of the prompter, level with the
line they belong to: stage directions, pronunciation, anything you want to
see at that moment.

```markdown
Dat was het voor vandaag.^[glimlach, kort pauzeren]
Ik werk met Nvidia[^nv] kaarten.

[^nv]: en-VID-ee-uh
```

- `^[…]` is an inline note; `[^id]` refers to a `[^id]: …` definition anywhere
  in the note (indented lines continue it). Both are standard Obsidian footnotes.
- Notes aren't spoken: they don't count for the timing and voice tracking
  ignores them. A note on a line of its own (`^[pauze]`) appears at that spot.
- *Margin notes → Position*: **Before sentence** (the side where lines start)
  or **After sentence**, as you read it, also when mirrored. Or *Hidden*.
- Notes stay visible ahead of the eye line, dim with the text you've read, and
  use the *Not spoken* style.
- `%% comments %%` stay completely hidden: notes to yourself while writing.

## Reading aids

All off by default, under *Reading aids* in the settings (and per note in
`souffleur:` frontmatter):

- **Focus band:** keeps a number of lines from the eye line down bright and
  dims the rest.
- **Bold word starts:** the first letters of each word a little bolder.
- **Pause helper:** in voice mode, when the microphone has been silent for a
  few seconds, the spotlight words get a soft background so your eye finds the
  way back. It goes when you speak again.
- **Words per line** (under *Text*): the font size follows the screen width so
  about that many words fit on a line, also after rotating.

## Fonts and spacing

The **Font** setting lists the fonts it finds on your computer. Fonts designed
or often recommended for dyslexic readers are marked ★ and listed first:
OpenDyslexic, Atkinson Hyperlegible, Lexend and Andika (free downloads), and
Verdana, Tahoma, Trebuchet MS and Comic Sans MS (included with macOS).
To install one:

```bash
brew install --cask font-atkinson-hyperlegible-next
```

```bash
brew install --cask font-lexend
```

OpenDyslexic's Homebrew cask is disabled (its download server went away), but
the author's GitHub repository has the font files. This puts the four styles in
your user font folder:

```bash
for f in Regular Bold Italic BoldItalic; do curl -fL -o ~/Library/Fonts/OpenDyslexic-$f.otf "https://github.com/antijingoist/opendyslexic/raw/main/compiled/OpenDyslexic-$f.otf"; done
```

Then reopen the Souffleur settings so the new font is found.

**Letter spacing** and **word spacing** are separate settings; extra spacing
is worth trying with any font.

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

Raise `version` in `manifest.json` (and `package.json`) and push to `main`.
`.github/workflows/release.yml` sees a version without a release, then tests,
builds and publishes a release tagged with that version (no `v`, as Obsidian
and BRAT expect), with `main.js`, `manifest.json` and `styles.css`.

`src/parser.ts` (Markdown → blocks and sections) and `src/prompter.ts` (the
scroll engine) don't import Obsidian, so they can be tested and tried outside
of it. `src/view.ts` and `src/main.ts` are the Obsidian glue.

## Voice tracking

Instead of scrolling at a fixed speed, the prompter can follow your voice: it
scrolls to the word you are saying, fades what you have said, and underlines
the current word. Stop talking and it stops; start a retake with P and it
picks you up there.

It needs a small local process (in `voice/`), which uses Parakeet v3 for
speech recognition on Apple Silicon. Nothing leaves your Mac.

1. Install [uv](https://docs.astral.sh/uv/) if you don't have it.
2. *Settings → Souffleur → Voice tracking*: turn on **Enable voice tracking**.
   The plugin starts the process with the **Start command** (it is filled in
   for you). The first start downloads the model, about 2.5 GB. The
   **Speech model** row in the settings shows a progress bar, and the
   prompter's status bar shows the percentage.
3. Allow microphone access when macOS asks.
4. Choose your **Microphone**, and open the prompter.

While you speak, three things show where you are, without pinning you to one
word (the recognition is a moment behind; you track the exact word yourself):

- **Heard:** words Souffleur has heard take the *heard* colour for a moment
  (1.5 s by default), then fade to dimmed.
- **Spotlight:** the next words after those (7 by default), where you'll be
  speaking any moment: underlined (keeps italic, bold and highlight colours),
  or in the *Spotlight* colour (*Reading aids → Spotlight style*).
- **Ahead:** the rest in your normal *Text* colour. Set it a little darker than
  the spotlight (for example 90% white, `#e6e6e6`) so the spotlight stands out.

All under *Colours* and *Reading aids*.

The status bar shows a level meter and the last words heard, so you can see
that it works.

Parakeet v3 recognises the language from the first things it hears and then
sticks with it. If it picked the wrong one (or stops following for another
reason), press **R** in the prompter, use the command **Reset voice matching**,
or the **Reset** button in the settings: it forgets what it heard and starts
listening afresh. Your place in the script stays.

The **language** (from the note's frontmatter, or the default in the settings)
tells the matcher how to read numbers: `2026` is matched as *tweeduizend
zesentwintig* in Dutch, *two thousand twenty-six* in English. Parakeet itself
can't be told the language. **Space** pauses and resumes following; while paused, the voice process stops
recognising (no CPU or GPU used), and on resume it starts listening afresh. There is also a command,
**Toggle voice tracking**, for a hotkey.

How it works, how to tune it, and how to test it on your own recording:
[voice/README.md](voice/README.md).
