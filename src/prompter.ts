// The scroll engine. Knows about the DOM, not about Obsidian, so it can also
// run in a plain browser page (see dev/index.html).
//
// Position model: `pos` is the y-coordinate *inside the text* that currently
// sits on the eye line. Scrolling = changing `pos`; rendering = translating
// the text so that `pos` lines up with the eye line.

import { blockSeconds, formatDuration, sectionLengths } from "./pacing";
import type { Run, Script } from "./parser";
import type { PrompterSettings } from "./settings";

export interface PrompterCallbacks {
  /** Called when the speed changes from the keyboard, so it can be saved. */
  onWpmChange?: (wpm: number) => void;
  /** The words as numbered on screen, after every (re)render, with the word
   * each section starts at. */
  onScript?: (words: string[], word: number, sections: number[]) => void;
  /** You jumped (N, P, Home, ...): `word` is the first word you'll say next. */
  onSeek?: (word: number) => void;
  /** V pressed in the prompter. */
  onToggleVoice?: () => void;
  /** R pressed in the prompter. */
  onResetVoice?: () => void;
  /** Voice mode: section `section` was read to its end, in `seconds`
   * (first heard word to last). */
  onSectionDone?: (section: number, seconds: number) => void;
}

const JUMP_MS = 450;
/**
 * If no animation frame arrives within this time, run the loop from a timer.
 * Some setups (macOS full screen on a DisplayLink display) stop delivering
 * requestAnimationFrame callbacks; the timer keeps the prompter moving.
 */
const FRAME_FALLBACK_MS = 50;
/** Voice mode: seconds to close ~63% of the gap to the spoken word. */
const FOLLOW_TAU = 0.35;
/** Microphone level (RMS) above which we count it as sound: about -40 dBFS,
 * above a quiet room's noise, below speech. */
const SOUND_RMS = 0.01;

interface Tween {
  from: number;
  to: number;
  start: number;
}

export class Prompter {
  private win: Window;
  private doc: Document;
  private stage: HTMLElement;
  private rotor: HTMLElement;
  private content: HTMLElement;
  private eye: HTMLElement;
  private hud: HTMLElement;
  private toastEl: HTMLElement;

  private script: Script = { blocks: [], sections: [] };
  private els: HTMLElement[] = [];
  private wordEls: HTMLElement[] = [];
  /** Margin notes: the note, its anchor in the text, and its block. */
  private notes: { el: HTMLElement; anchor: HTMLElement; block: number }[] = [];
  private notesEl: HTMLElement;
  private bandEl: HTMLElement;
  /** Index of the first word in each block. */
  private blockWord: number[] = [];
  private tops: number[] = [];
  private total = 0;

  private pos = 0;
  private playing = false;
  private dwellUntil = 0;
  private current = -1;
  private tween: Tween | null = null;
  private lastFrame = 0;
  private frame = 0;
  private frameTimer = 0;
  // Diagnostics (D key): frames per second, and how many came from the timer.
  private diag = false;
  private diagEl: HTMLElement;
  private frames = { raf: 0, timer: 0, since: 0 };
  private toastTimer = 0;
  private resizeObserver: ResizeObserver;

  // Voice mode: the voice process decides where we are.
  private voice = false;
  /** Scroll target: the word being spoken (-1 = none yet). */
  private voiceWord = -1;
  /** Words just heard, with when: they keep data-heard for `heardHold` s. */
  private heard: { word: number; at: number }[] = [];
  /** Highlight bookkeeping: words up to here carry data-said. */
  private marked = -1;
  private voiceInfo = "";

  // Time spent in the current section (counts up while playing/listening,
  // restarts at every section) and how long each section normally takes.
  private timerSection = -1;
  private elapsed = 0;
  private shownSecond = -1;
  private lengths: number[] = [];

  // Play: an optional 3-2-1, then an eased start.
  private countdownUntil = 0;
  private playStart = 0;
  private countdownEl: HTMLElement;

  private wakeLock: WakeLockSentinel | null = null;

  /** The word each section starts at. */
  private sectionStarts: number[] = [];
  /** Voice mode: the current read-through of a section. */
  private run = { section: -1, start: 0, done: false };

  /** Voice mode: when the last position arrived (pause helper). */
  private lastHeardAt = 0;
  /** Voice mode: when the microphone last picked up sound. */
  private lastSoundAt = 0;

  /** Font size in use: the setting, or fitted to "words per line". */
  private fontPx = 0;

  constructor(
    host: HTMLElement,
    private settings: PrompterSettings,
    private callbacks: PrompterCallbacks = {},
  ) {
    this.doc = host.ownerDocument;
    // Use the window this element lives in: a popout is a separate window
    // with its own animation clock.
    this.win = this.doc.defaultView ?? window;

    this.stage = this.el("div", "sf-stage", host);
    this.rotor = this.el("div", "sf-rotor", this.stage);
    this.content = this.el("article", "sf-content", this.rotor);
    this.notesEl = this.el("div", "sf-notes", this.content);
    this.bandEl = this.el("div", "sf-band", this.rotor);
    this.eye = this.el("div", "sf-eyeline", this.rotor);
    this.hud = this.el("footer", "sf-hud", this.rotor);
    this.toastEl = this.el("output", "sf-toast", this.rotor);

    this.stage.addEventListener("wheel", this.onWheel, { passive: false });
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.stage);

    this.countdownEl = this.el("output", "sf-countdown", this.rotor);
    this.countdownEl.hidden = true;
    this.doc.addEventListener("visibilitychange", this.onVisibility);
    this.diagEl = this.el("pre", "sf-diag", this.rotor);
    this.diagEl.hidden = true;
    this.applySettings(settings);
    // Web fonts change line widths once they load: lay out again then.
    void this.doc.fonts?.ready.then(() => this.layout());
    this.schedule();
  }

  /** Ask for the next frame from both sources; whichever fires first wins. */
  private schedule(): void {
    this.frame = this.win.requestAnimationFrame((t) => this.runFrame(t, "raf"));
    this.frameTimer = this.win.setTimeout(
      () => this.runFrame(this.win.performance.now(), "timer"),
      FRAME_FALLBACK_MS,
    );
  }

  private runFrame(now: number, source: "raf" | "timer"): void {
    this.win.cancelAnimationFrame(this.frame);
    this.win.clearTimeout(this.frameTimer);
    this.frames[source]++;
    this.tick(now);
    if (this.diag) this.updateDiag(now);
    this.schedule();
  }

  destroy(): void {
    this.win.cancelAnimationFrame(this.frame);
    this.win.clearTimeout(this.frameTimer);
    this.resizeObserver.disconnect();
    this.doc.removeEventListener("visibilitychange", this.onVisibility);
    void this.releaseWake();
    this.stage.remove();
  }

  // ── Content ────────────────────────────────────────────────────────────

  /** Render a script. With `keepPlace`, stay on the same block after a reload. */
  setScript(script: Script, keepPlace = false): void {
    const anchor = keepPlace ? this.anchor() : null;
    // A reload that only changed comments (e.g. a "last run" note) keeps the
    // same words: then the voice process needn't start over.
    const wordsBefore = this.words().join("\u0001");
    this.script = script;
    this.computeLengths();
    this.render();
    this.content.dataset.margin = this.notes.length ? this.settings.marginNotes : "off";
    this.geometry();
    this.measure();
    if (anchor) {
      this.pos = this.fromAnchor(anchor);
    } else {
      this.goToBlock(script.sections[0]?.firstBlock ?? 0, false);
    }
    this.current = this.blockAt(this.pos);
    // A re-render made fresh spans: restore the marks on them.
    if (this.voiceWord >= this.wordEls.length) this.voiceWord = -1;
    const marked = Math.min(this.marked, this.wordEls.length - 1);
    this.marked = -1;
    this.highlight(marked);
    this.updateRead();
    this.updateHud();
    if (!keepPlace || this.words().join("\u0001") !== wordsBefore) this.announce();
  }

  /** Tell listeners (the voice process) the words and where we are. */
  announce(): void {
    this.callbacks.onScript?.(this.words(), this.wordAtPos(), this.sectionStarts);
  }

  words(): string[] {
    return this.wordEls.map((el) => el.textContent ?? "");
  }

  private wordAtPos(): number {
    return this.blockWord[this.blockAt(this.pos)] ?? 0;
  }

  private render(): void {
    this.content.replaceChildren(this.notesEl);
    this.notesEl.replaceChildren();
    this.notes = [];
    this.els = [];
    this.wordEls = [];
    this.blockWord = [];
    this.wordIndex = 0;
    const total = this.script.sections.length;
    let sectionEl = this.el("section", "", this.content);
    sectionEl.dataset.label = this.sectionLabel(0, total);
    let list: HTMLElement | null = null;

    for (const block of this.script.blocks) {
      if (block.type !== "list") list = null;
      let el: HTMLElement;
      switch (block.type) {
        case "separator":
          el = this.el("hr", "", this.content);
          sectionEl = this.el("section", "", this.content);
          sectionEl.dataset.label = this.sectionLabel(block.section, total);
          break;
        case "heading":
          el = this.el(`h${block.level}`, "", sectionEl);
          break;
        case "list": {
          const tag = block.level > 0 ? "ol" : "ul";
          if (!list || list.tagName.toLowerCase() !== tag) list = this.el(tag, "", sectionEl);
          el = this.el("li", "", list);
          if (block.level > 0) el.setAttribute("value", String(block.level));
          break;
        }
        case "quote":
          el = this.el("blockquote", "", sectionEl);
          break;
        default:
          el = this.el("p", "", sectionEl);
      }
      this.blockWord.push(this.wordIndex);
      const spoken = block.type !== "heading" || this.settings.speakHeadings;
      this.renderRuns(el, block.runs, this.els.length, spoken);
      this.els.push(el);
    }
    this.sectionStarts = this.script.sections.map(
      (sec) => this.blockWord[sec.firstBlock] ?? this.wordEls.length,
    );
  }

  private sectionLabel(index: number, total: number): string {
    const title = this.script.sections[index]?.title;
    return `${index + 1} / ${total}${title ? ` · ${title}` : ""}`;
  }

  /** Words become <span data-w="n">: ready for voice-tracked highlighting. */
  private wordIndex = 0;
  /** `spoken` false: show the text, but not as words to say (no word spans,
   * so no highlighting and no voice matching). */
  private renderRuns(parent: HTMLElement, runs: Run[], block: number, spoken = true): void {
    for (const run of runs) {
      if (run.note !== undefined) {
        // An empty marker in the text; the note itself goes in the margin.
        const anchor = this.el("span", "sf-anchor", parent);
        const el = this.el("aside", "sf-note", this.notesEl);
        el.textContent = run.note;
        this.notes.push({ el, anchor, block });
        continue;
      }
      let target = parent;
      if (run.bold) target = this.el("strong", "", target);
      if (run.italic) target = this.el("em", "", target);
      if (run.mark) target = this.el("mark", "", target);
      if (run.strike) target = this.el("s", "", target);
      if (!spoken) {
        target.append(run.text);
        continue;
      }
      for (const part of run.text.split(/(\s+)/)) {
        if (part === "") continue;
        if (/^\s+$/.test(part)) {
          target.append(" ");
        } else {
          const span = this.el("span", "", target);
          span.dataset.w = String(this.wordIndex++);
          this.fillWord(span, part);
          this.wordEls.push(span);
        }
      }
    }
  }

  // ── Layout ─────────────────────────────────────────────────────────────

  applySettings(s: PrompterSettings): void {
    // Word numbering changes when headings start or stop being words.
    const renumber = this.settings.speakHeadings !== s.speakHeadings;
    const restyle = renumber || this.settings.boldStarts !== s.boldStarts;
    this.settings = s;
    const st = this.stage.style;
    st.setProperty("--sf-font", s.fontFamily);
    st.setProperty("--sf-size", `${s.fontSize}px`);
    st.setProperty("--sf-line", String(s.lineHeight));
    st.setProperty("--sf-letter", `${s.letterSpacing}em`);
    st.setProperty("--sf-word", `${s.wordSpacing}em`);
    st.setProperty("--sf-width", `${s.textWidth}%`);
    st.setProperty("--sf-align", s.textAlign);
    st.setProperty("--sf-fg", s.textColor);
    st.setProperty("--sf-bg", s.backgroundColor);
    st.setProperty("--sf-heading", s.headingColor);
    st.setProperty("--sf-mark", s.markColor);
    st.setProperty("--sf-eye", s.eyeLineColor);
    st.setProperty("--sf-next", s.nextColor);
    st.setProperty("--sf-heard", s.heardColor);
    st.setProperty("--sf-spotlight", s.spotlightColor);
    st.setProperty("--sf-eye-pos", `${s.eyeLine}%`);
    this.eye.hidden = !s.showEyeLine;
    this.hud.hidden = !s.showHud;
    this.stage.toggleAttribute("data-dim-read", s.dimRead);
    st.setProperty("--sf-note", s.noteColor);
    st.setProperty("--sf-italic", s.italicColor || "inherit");
    st.setProperty("--sf-bold", s.boldColor || "inherit");
    st.setProperty("--sf-band-lines", String(s.focusBand));
    this.content.dataset.margin = this.notes.length ? s.marginNotes : "off";
    this.notesEl.hidden = s.marginNotes === "off";
    this.bandEl.hidden = s.focusBand <= 0;
    if (restyle) this.rerender(renumber);
    this.computeLengths();
    this.syncWake();
    this.layout();
    this.updateHud();
  }

  /** Size and orient the rotor. Rotation by 90/270 swaps width and height. */
  private layout(): void {
    const anchor = this.anchor();
    this.geometry();
    this.measure();
    if (anchor) this.pos = this.fromAnchor(anchor);
    this.draw();
  }

  /** Rotation, flips, notes margin and font size, from the stage size. */
  private geometry(): void {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    const { rotation, flipH, flipV } = this.settings;
    const sideways = rotation === 90 || rotation === 270;
    this.rotor.style.width = `${sideways ? h : w}px`;
    this.rotor.style.height = `${sideways ? w : h}px`;
    // Read right to left: flip first (in text space), then rotate, then centre.
    this.rotor.style.transform =
      `translate(-50%, -50%) rotate(${rotation}deg) ` +
      `scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})`;
    const rotorWidth = sideways ? h : w;
    this.stage.style.setProperty("--sf-margin", `${this.marginPx(rotorWidth)}px`);
    this.fontPx = this.fitFont(rotorWidth);
    this.stage.style.setProperty("--sf-size", `${this.fontPx}px`);
  }

  /** A word, optionally with its first letters a little bolder. */
  private fillWord(span: HTMLElement, word: string): void {
    if (!this.settings.boldStarts || word.length < 2) {
      span.textContent = word;
      return;
    }
    const letters = [...word];
    const n = letters.length <= 3 ? 1 : Math.ceil(letters.length * 0.4);
    this.el("b", "sf-start", span).textContent = letters.slice(0, n).join("");
    span.append(letters.slice(n).join(""));
  }

  /** Render again in place (a setting changed how words look). With
   * `renumber`, word numbers changed: clear the marks and tell the voice
   * process the new word list. */
  private rerender(renumber = false): void {
    const anchor = this.anchor();
    const marked = renumber ? -1 : this.marked;
    const voiceWord = renumber ? -1 : this.voiceWord;
    this.heard = []; // the spans are new
    this.render();
    this.measure();
    if (anchor) this.pos = this.fromAnchor(anchor);
    this.marked = -1;
    this.highlight(marked);
    this.voiceWord = voiceWord;
    this.updateRead();
    if (renumber) this.announce();
  }

  private measure(): void {
    this.tops = this.els.map((el) => this.offsetIn(el));
    this.placeNotes();
    this.total = this.content.scrollHeight;
  }

  /** Each note level with its anchor's line, pushed down if the note above
   * would overlap it. */
  private placeNotes(): void {
    let below = 0;
    const gap = this.lineHeightPx() * 0.15;
    for (const { el, anchor } of this.notes) {
      const top = Math.max(this.offsetIn(anchor), below);
      el.style.top = `${top}px`;
      below = top + el.offsetHeight + gap;
    }
  }

  /** y of `el` relative to the content, regardless of nesting. */
  private offsetIn(el: HTMLElement): number {
    let y = 0;
    let node: HTMLElement | null = el;
    while (node && node !== this.content) {
      y += node.offsetTop;
      node = node.offsetParent as HTMLElement | null;
    }
    return y;
  }

  private eyeY(): number {
    return (this.rotor.clientHeight * this.settings.eyeLine) / 100;
  }

  private lineHeightPx(): number {
    return (this.fontPx || this.settings.fontSize) * this.settings.lineHeight;
  }

  /** Width of the notes margin: a share of the text block, if notes show. */
  private marginPx(rotorWidth: number): number {
    const s = this.settings;
    if (this.content.dataset.margin === "off" || s.marginNotes === "off") return 0;
    return (rotorWidth * s.textWidth * s.marginWidth) / 10000;
  }

  /**
   * "Words per line": measure how wide this font's letters are on average,
   * then pick the size at which that many words (about 6 characters each,
   * with the space) fill the text column.
   */
  private fitFont(rotorWidth: number): number {
    const s = this.settings;
    if (s.wordsPerLine <= 0) return s.fontSize;
    const column = (rotorWidth * s.textWidth) / 100 - this.marginPx(rotorWidth);
    const ctx = this.doc.createElement("canvas").getContext("2d");
    if (!ctx) return s.fontSize;
    ctx.font = `100px ${s.fontFamily}`;
    const sample = "Hallo en welkom, vandaag vertel ik je waarom dit zo werkt.";
    const perChar = ctx.measureText(sample).width / sample.length / 100;
    const size = column / (s.wordsPerLine * 6 * perChar);
    return Math.max(12, Math.min(300, Math.floor(size)));
  }

  private draw(): void {
    this.content.style.transform = `translateY(${this.eyeY() - this.pos}px)`;
  }

  // ── Position helpers ───────────────────────────────────────────────────

  private blockAt(pos: number): number {
    // Binary search: last block whose top is <= pos.
    let lo = 0;
    let hi = this.tops.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.tops[mid] ?? 0) <= pos) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  private blockHeight(i: number): number {
    const top = this.tops[i] ?? 0;
    const next = this.tops[i + 1] ?? this.total;
    return Math.max(1, next - top);
  }

  /** Remember "block i, fraction f" so a re-layout keeps your place. */
  private anchor(): { i: number; f: number } | null {
    if (this.tops.length === 0) return null;
    const i = this.blockAt(this.pos);
    return { i, f: (this.pos - (this.tops[i] ?? 0)) / this.blockHeight(i) };
  }

  private fromAnchor({ i, f }: { i: number; f: number }): number {
    const j = Math.min(i, this.tops.length - 1);
    return (this.tops[j] ?? 0) + f * this.blockHeight(j);
  }

  private currentSection(): number {
    return this.script.blocks[this.blockAt(this.pos)]?.section ?? 0;
  }

  // ── Animation loop ─────────────────────────────────────────────────────

  private tick = (now: number): void => {
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;

    if (this.tween) {
      const t = Math.min(1, (now - this.tween.start) / JUMP_MS);
      const ease = 1 - (1 - t) ** 3;
      this.pos = this.tween.from + (this.tween.to - this.tween.from) * ease;
      if (t >= 1) this.tween = null;
    } else if (this.countdownUntil) {
      this.runCountdown(now);
    } else if (this.voice) {
      this.follow(dt);
    } else if (this.playing && now >= this.dwellUntil) {
      this.advance(dt * this.easeIn(now), now);
    }

    const i = this.blockAt(this.pos);
    if (i !== this.current) {
      this.current = i;
      this.updateRead();
      this.updateHud();
    }
    this.updateTimer(dt);
    this.updatePauseHint(now);
    this.expireHeard(now);
    this.draw();
  };

  toggleDiag(): void {
    this.diag = !this.diag;
    this.diagEl.hidden = !this.diag;
    this.frames = { raf: 0, timer: 0, since: this.win.performance.now() };
  }

  private updateDiag(now: number): void {
    const secs = (now - this.frames.since) / 1000;
    if (secs < 0.5) return;
    const { raf, timer } = this.frames;
    const fs = this.doc.fullscreenElement ? "element" : "no";
    this.diagEl.textContent =
      `frames/s  ${((raf + timer) / secs).toFixed(0)}  (raf ${raf}, timer ${timer})\n` +
      `pos       ${this.pos.toFixed(0)} / ${this.total}\n` +
      `playing   ${this.playing}   voice ${this.voice}\n` +
      `size      ${this.stage.clientWidth}×${this.stage.clientHeight}  ` +
      `dpr ${this.win.devicePixelRatio}  fullscreen ${fs}\n` +
      `visible   ${this.doc.visibilityState}  focus ${this.doc.hasFocus()}`;
    this.frames = { raf: 0, timer: 0, since: now };
  }

  /**
   * The structure-aware part: speed is "this block's height, in the time it
   * takes to say this block's words". Short headings pass quickly, dense
   * paragraphs slowly, at the same reading pace.
   */
  private advance(dt: number, now: number): void {
    const i = this.blockAt(this.pos);
    const block = this.script.blocks[i];
    if (!block) return;

    if (i !== this.current) {
      // We just crossed into block i.
      if (block.type === "separator" && this.settings.stopAtSection) {
        this.goToSection(block.section);
        return;
      }
      if (block.type === "heading" && this.settings.headingPause > 0) {
        this.pos = this.tops[i] ?? this.pos;
        this.dwellUntil = now + this.settings.headingPause * 1000;
        return;
      }
    }

    this.pos += (this.blockHeight(i) / blockSeconds(block, this.settings)) * dt;

    if (this.pos >= this.total) {
      this.pos = this.total;
      this.pause();
    }
  }

  /** Smooth start: 0 → 1 over `smoothStart` seconds after Play (ease-in-out). */
  private easeIn(now: number): number {
    const ramp = this.settings.smoothStart * 1000;
    if (ramp <= 0) return 1;
    const t = Math.min(1, (now - this.playStart) / ramp);
    return (1 - Math.cos(Math.PI * t)) / 2;
  }

  private runCountdown(now: number): void {
    const left = Math.ceil((this.countdownUntil - now) / 1000);
    if (left > 0) {
      this.countdownEl.textContent = String(left);
      return;
    }
    this.countdownUntil = 0;
    this.countdownEl.hidden = true;
    this.playStart = now;
  }

  /**
   * Time a read-through: from the first word heard in a section to its end
   * (within its last 3 words, as a short last word is sometimes missed).
   * Starting the section over, by voice or a jump, starts the clock again.
   */
  private trackRun(i: number, at: number): void {
    const section = this.sectionOfWord(i);
    if (section !== this.run.section || i < this.marked - 3) {
      this.run = { section, start: at, done: false };
    }
    const last = (this.sectionStarts[section + 1] ?? this.wordEls.length) - 1;
    if (!this.run.done && i >= last - 2 && at - this.run.start > 1000) {
      this.run.done = true;
      this.callbacks.onSectionDone?.(section, (at - this.run.start) / 1000);
    }
  }

  private sectionOfWord(i: number): number {
    let n = 0;
    while (n + 1 < this.sectionStarts.length && (this.sectionStarts[n + 1] ?? Infinity) <= i) n++;
    return n;
  }

  /** Heard words lose their colour after `heardHold` seconds (CSS fades). */
  private expireHeard(now: number): void {
    const hold = this.settings.heardHold * 1000;
    while (this.heard.length && now - this.heard[0]!.at >= hold) {
      this.wordEls[this.heard.shift()!.word]?.removeAttribute("data-heard");
    }
  }

  private clearHeard(): void {
    for (const { word } of this.heard) this.wordEls[word]?.removeAttribute("data-heard");
    this.heard = [];
  }

  /** Voice mode: after a silence, light up the words to say next. */
  /** The microphone level, from the voice process (4× a second). */
  setLevel(rms: number): void {
    if (rms > SOUND_RMS) this.lastSoundAt = this.win.performance.now();
  }

  /**
   * Pause helper: only on a real silence. Both must be true for `pauseHint`
   * seconds: no new word recognised, and no sound from the microphone. So it
   * doesn't appear while you speak and the matching catches up.
   */
  private updatePauseHint(now: number): void {
    const wait = this.settings.pauseHint * 1000;
    const quietSince = Math.max(this.lastHeardAt, this.lastSoundAt);
    const paused =
      wait > 0 && this.voice && this.playing && this.lastHeardAt > 0 && now - quietSince > wait;
    if (paused !== this.stage.hasAttribute("data-paused")) {
      this.stage.toggleAttribute("data-paused", paused);
    }
  }

  // ── Section timer ──────────────────────────────────────────────────────

  private computeLengths(): void {
    this.lengths = sectionLengths(this.script, this.settings).map((l) => l.seconds);
  }

  /** Counts while playing or listening, never during the 3-2-1; a new
   * section (by scrolling, voice or a jump) starts again at 0:00. */
  private updateTimer(dt: number): void {
    const n = this.currentSection();
    if (n !== this.timerSection) {
      this.timerSection = n;
      this.elapsed = 0;
      this.shownSecond = -1;
    } else if (this.playing && !this.countdownUntil) {
      this.elapsed += dt;
    }
    const second = Math.floor(this.elapsed);
    if (second !== this.shownSecond) {
      this.shownSecond = second;
      this.updateHud();
    }
  }

  // ── Keep the screen awake ──────────────────────────────────────────────

  private async holdWake(): Promise<void> {
    if (!this.settings.keepAwake || this.wakeLock || this.doc.visibilityState !== "visible") return;
    try {
      this.wakeLock = await this.win.navigator.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => {
        this.wakeLock = null;
      });
    } catch {
      // Not allowed or not supported here: the screen just follows the OS.
    }
  }

  private async releaseWake(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    await lock?.release().catch(() => {});
  }

  private syncWake(): void {
    if (this.settings.keepAwake && (this.playing || this.voice)) void this.holdWake();
    else void this.releaseWake();
  }

  /** The OS drops a wake lock when the window is hidden; take it back. */
  private onVisibility = (): void => {
    if (this.doc.visibilityState === "visible") this.syncWake();
  };

  // ── Controls ───────────────────────────────────────────────────────────

  play(): void {
    if (this.pos >= this.total && !this.voice) return;
    this.playing = true;
    this.dwellUntil = 0;
    const now = this.win.performance.now();
    // The 3-2-1 is for auto-scroll; in voice mode the text waits for you.
    if (!this.voice && this.settings.countdown > 0) {
      this.countdownUntil = now + this.settings.countdown * 1000;
      this.countdownEl.textContent = String(this.settings.countdown);
      this.countdownEl.hidden = false;
    }
    this.playStart = now;
    this.syncWake();
    this.updateHud();
  }

  pause(): void {
    this.playing = false;
    this.countdownUntil = 0;
    this.countdownEl.hidden = true;
    this.syncWake();
    this.updateHud();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Jumping always pauses: you get a breath before the (re)take. */
  goToBlock(i: number, animate = true): void {
    const target = this.tops[i] ?? 0;
    // In voice mode you just start talking again, so don't pause there.
    if (!this.voice) this.pause();
    this.current = i;
    const word = this.blockWord[i] ?? 0;
    this.clearHeard();
    this.run = { section: -1, start: 0, done: false }; // a jump: no run in progress
    this.highlight(word - 1);
    this.voiceWord = -1;
    this.callbacks.onSeek?.(word);
    if (animate) {
      this.tween = { from: this.pos, to: target, start: this.win.performance.now() };
    } else {
      this.tween = null;
      this.pos = target;
    }
    this.updateRead();
    this.updateHud();
  }

  goToSection(n: number): void {
    const sec = this.script.sections[n];
    if (!sec) return;
    this.goToBlock(sec.firstBlock);
    this.timerSection = -1; // a retake of the same section starts at 0:00 too
  }

  nextSection(): void {
    const n = this.currentSection() + 1;
    if (n < this.script.sections.length) this.goToSection(n);
    else this.toast("Last section");
  }

  /**
   * Like "previous track" on a music player: if you're well into a section,
   * go back to its start (a retake); if you're at the start, go one further.
   */
  prevSection(): void {
    const n = this.currentSection();
    const start = this.tops[this.script.sections[n]?.firstBlock ?? 0] ?? 0;
    const target = this.pos - start > this.lineHeightPx() ? n : n - 1;
    this.goToSection(Math.max(0, target));
  }

  /** One line forward (n = 1) or back (n = -1). */
  lines(n: number): void {
    this.nudge(n * this.lineHeightPx());
  }

  nudge(px: number): void {
    const from = this.tween?.to ?? this.pos;
    const to = Math.max(0, Math.min(this.total, from + px));
    this.tween = { from: this.pos, to, start: this.win.performance.now() };
  }

  adjustWpm(delta: number): void {
    const wpm = Math.max(40, Math.min(400, this.settings.wpm + delta));
    this.settings = { ...this.settings, wpm };
    this.callbacks.onWpmChange?.(wpm);
    this.toast(`${wpm} wpm`);
    this.updateHud();
  }

  toggleHud(): void {
    this.hud.hidden = !this.hud.hidden;
  }

  /** Fullscreen just the stage: no tab bar, no title bar. */
  toggleFullscreen(): void {
    if (this.doc.fullscreenElement) void this.doc.exitFullscreen();
    else void this.stage.requestFullscreen();
  }

  /** Returns true when the key was handled. */
  handleKey(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const line = this.lineHeightPx();
    switch (e.key) {
      case " ":
        this.toggle();
        break;
      case "n":
      case "N":
        this.nextSection();
        break;
      case "p":
      case "P":
        this.prevSection();
        break;
      case "ArrowDown":
        this.nudge(line);
        break;
      case "ArrowUp":
        this.nudge(-line);
        break;
      case "PageDown":
        this.nudge(this.rotor.clientHeight / 2);
        break;
      case "PageUp":
        this.nudge(-this.rotor.clientHeight / 2);
        break;
      case "+":
      case "=":
        this.adjustWpm(10);
        break;
      case "-":
      case "_":
        this.adjustWpm(-10);
        break;
      case "Home":
        this.goToSection(0);
        break;
      case "End":
        this.goToSection(this.script.sections.length - 1);
        break;
      case "h":
      case "H":
        this.toggleHud();
        break;
      case "f":
      case "F":
        this.toggleFullscreen();
        break;
      case "v":
      case "V":
        this.callbacks.onToggleVoice?.();
        break;
      case "r":
      case "R":
        this.callbacks.onResetVoice?.();
        break;
      case "d":
      case "D":
        this.toggleDiag();
        break;
      default:
        return false;
    }
    e.preventDefault();
    return true;
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.tween = null;
    this.pos = Math.max(0, Math.min(this.total, this.pos + e.deltaY));
  };

  // ── Voice mode ─────────────────────────────────────────────────────────

  /** Voice tracking on/off. While on, Space pauses/resumes following. */
  setVoice(active: boolean): void {
    if (active === this.voice) return;
    this.voice = active;
    this.stage.toggleAttribute("data-voice", active);
    if (active) {
      this.play();
      this.highlight(this.marked); // place the spotlight before the first word is heard
    } else {
      this.pause();
      this.clearHeard();
      this.highlight(-1);
      this.voiceWord = -1;
    }
    this.updateHud();
  }

  /** The voice process says you're saying word `i`. */
  followWord(i: number): void {
    if (!this.voice || !this.playing || !this.wordEls[i]) return;
    const at = this.win.performance.now();
    this.trackRun(i, at);
    if (i < this.marked) {
      this.clearHeard(); // a retake: nothing stays coloured
    } else if (this.settings.heardHold > 0) {
      for (let w = Math.max(0, this.marked + 1); w <= i; w++) {
        this.wordEls[w]?.setAttribute("data-heard", "");
        this.heard.push({ word: w, at });
      }
    }
    this.highlight(i);
    this.voiceWord = i;
    this.lastHeardAt = this.win.performance.now();
  }

  setVoiceInfo(text: string): void {
    this.voiceInfo = text;
    this.updateHud();
  }

  /**
   * Ease towards the spoken word's line: each frame closes a fixed fraction
   * of the gap (exponential smoothing), so small steps look calm and big
   * corrections still arrive quickly. Measured every frame, so it stays right
   * after a resize or rotation.
   */
  private follow(dt: number): void {
    const el = this.wordEls[this.voiceWord];
    if (!el || !this.playing) return;
    const target = this.offsetIn(el);
    this.pos += (target - this.pos) * (1 - Math.exp(-dt / FOLLOW_TAU));
  }

  /**
   * Words up to `now` get data-said, later ones lose it. Only the range that
   * changed is touched, so a step of a few words costs a few DOM writes.
   */
  private highlight(now: number): void {
    const before = this.marked;
    for (let w = Math.max(0, Math.min(now, before) + 1); w <= Math.max(now, before); w++) {
      this.wordEls[w]?.toggleAttribute("data-said", w <= now);
    }
    // Spotlight: the words right after the last one heard, where you'll be
    // speaking any moment. (A handful of elements: clear and set again.)
    for (const el of this.stage.querySelectorAll("[data-next]")) el.removeAttribute("data-next");
    if (this.voice) {
      for (let w = now + 1; w <= now + this.settings.nextWords; w++) {
        this.wordEls[w]?.setAttribute("data-next", "");
      }
    }
    this.marked = now;
  }

  // ── Status display ─────────────────────────────────────────────────────

  private updateRead(): void {
    this.els.forEach((el, i) => el.toggleAttribute("data-read", i < this.current));
    for (const n of this.notes) n.el.toggleAttribute("data-read", n.block < this.current);
  }

  private updateHud(): void {
    const n = this.currentSection();
    const total = this.script.sections.length;
    const title = this.script.sections[n]?.title ?? "";
    const state = this.playing ? "▶" : "❚❚";
    const mode = this.voice ? "🎙 voice" : `${this.settings.wpm} wpm`;
    const info = this.voiceInfo ? `  ·  ${this.voiceInfo}` : "";
    const normally = this.lengths[n];
    const timer =
      this.settings.showSectionTimer && normally !== undefined
        ? `  ·  ${formatDuration(this.elapsed)} · normally ${formatDuration(normally)}`
        : "";
    this.hud.textContent = `${state}  ${mode}  ·  ${n + 1}/${total}  ${title}${timer}${info}`;
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.toggleAttribute("data-show", true);
    this.win.clearTimeout(this.toastTimer);
    this.toastTimer = this.win.setTimeout(
      () => this.toastEl.toggleAttribute("data-show", false),
      1200,
    );
  }

  private el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
    const e = this.doc.createElement(tag);
    if (cls) e.className = cls;
    parent.append(e);
    return e;
  }
}
