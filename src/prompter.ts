// The scroll engine. Knows about the DOM, not about Obsidian, so it can also
// run in a plain browser page (see dev/index.html).
//
// Position model: `pos` is the y-coordinate *inside the text* that currently
// sits on the eye line. Scrolling = changing `pos`; rendering = translating
// the text so that `pos` lines up with the eye line.

import type { Block, Run, Script } from "./parser";
import type { PrompterSettings } from "./settings";

export interface PrompterCallbacks {
  /** Called when the speed changes from the keyboard, so it can be saved. */
  onWpmChange?: (wpm: number) => void;
  /** The words as numbered on screen, after every (re)render. */
  onScript?: (words: string[], word: number) => void;
  /** You jumped (N, P, Home, ...): `word` is the first word you'll say next. */
  onSeek?: (word: number) => void;
  /** V pressed in the prompter. */
  onToggleVoice?: () => void;
  /** R pressed in the prompter. */
  onResetVoice?: () => void;
}

const MIN_BLOCK_SECONDS = 0.4;
const JUMP_MS = 450;
/**
 * If no animation frame arrives within this time, run the loop from a timer.
 * Some setups (macOS full screen on a DisplayLink display) stop delivering
 * requestAnimationFrame callbacks; the timer keeps the prompter moving.
 */
const FRAME_FALLBACK_MS = 50;
/** Voice mode: seconds to close ~63% of the gap to the spoken word. */
const FOLLOW_TAU = 0.35;

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
  /** Highlight bookkeeping: words up to here carry data-said. */
  private marked = -1;
  private voiceInfo = "";

  constructor(
    host: HTMLElement,
    private settings: PrompterSettings,
    private callbacks: PrompterCallbacks = {},
  ) {
    this.doc = host.ownerDocument;
    // Use the window this element lives in: a popout is a separate window
    // with its own animation clock.
    this.win = this.doc.defaultView ?? window;

    this.stage = this.el("div", "tp-stage", host);
    this.rotor = this.el("div", "tp-rotor", this.stage);
    this.content = this.el("article", "tp-content", this.rotor);
    this.eye = this.el("div", "tp-eyeline", this.rotor);
    this.hud = this.el("footer", "tp-hud", this.rotor);
    this.toastEl = this.el("output", "tp-toast", this.rotor);

    this.stage.addEventListener("wheel", this.onWheel, { passive: false });
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.stage);

    this.diagEl = this.el("pre", "tp-diag", this.rotor);
    this.diagEl.hidden = true;
    this.applySettings(settings);
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
    this.stage.remove();
  }

  // ── Content ────────────────────────────────────────────────────────────

  /** Render a script. With `keepPlace`, stay on the same block after a reload. */
  setScript(script: Script, keepPlace = false): void {
    const anchor = keepPlace ? this.anchor() : null;
    this.script = script;
    this.render();
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
    this.highlight(marked, marked === this.voiceWord);
    this.updateRead();
    this.updateHud();
    this.announce();
  }

  /** Tell listeners (the voice process) the words and where we are. */
  announce(): void {
    this.callbacks.onScript?.(this.words(), this.wordAtPos());
  }

  words(): string[] {
    return this.wordEls.map((el) => el.textContent ?? "");
  }

  private wordAtPos(): number {
    return this.blockWord[this.blockAt(this.pos)] ?? 0;
  }

  private render(): void {
    this.content.replaceChildren();
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
      this.renderRuns(el, block.runs);
      this.els.push(el);
    }
  }

  private sectionLabel(index: number, total: number): string {
    const title = this.script.sections[index]?.title;
    return `${index + 1} / ${total}${title ? ` · ${title}` : ""}`;
  }

  /** Words become <span data-w="n">: ready for voice-tracked highlighting. */
  private wordIndex = 0;
  private renderRuns(parent: HTMLElement, runs: Run[]): void {
    for (const run of runs) {
      let target = parent;
      if (run.bold) target = this.el("strong", "", target);
      if (run.italic) target = this.el("em", "", target);
      if (run.mark) target = this.el("mark", "", target);
      if (run.strike) target = this.el("s", "", target);
      for (const part of run.text.split(/(\s+)/)) {
        if (part === "") continue;
        if (/^\s+$/.test(part)) {
          target.append(" ");
        } else {
          const span = this.el("span", "", target);
          span.dataset.w = String(this.wordIndex++);
          span.textContent = part;
          this.wordEls.push(span);
        }
      }
    }
  }

  // ── Layout ─────────────────────────────────────────────────────────────

  applySettings(s: PrompterSettings): void {
    this.settings = s;
    const st = this.stage.style;
    st.setProperty("--tp-font", s.fontFamily);
    st.setProperty("--tp-size", `${s.fontSize}px`);
    st.setProperty("--tp-line", String(s.lineHeight));
    st.setProperty("--tp-letter", `${s.letterSpacing}em`);
    st.setProperty("--tp-word", `${s.wordSpacing}em`);
    st.setProperty("--tp-width", `${s.textWidth}%`);
    st.setProperty("--tp-align", s.textAlign);
    st.setProperty("--tp-fg", s.textColor);
    st.setProperty("--tp-bg", s.backgroundColor);
    st.setProperty("--tp-heading", s.headingColor);
    st.setProperty("--tp-mark", s.markColor);
    st.setProperty("--tp-eye", s.eyeLineColor);
    st.setProperty("--tp-next", s.nextColor);
    st.setProperty("--tp-eye-pos", `${s.eyeLine}%`);
    this.eye.hidden = !s.showEyeLine;
    this.hud.hidden = !s.showHud;
    this.stage.toggleAttribute("data-dim-read", s.dimRead);
    this.layout();
    this.updateHud();
  }

  /** Size and orient the rotor. Rotation by 90/270 swaps width and height. */
  private layout(): void {
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
    const anchor = this.anchor();
    this.measure();
    if (anchor) this.pos = this.fromAnchor(anchor);
    this.draw();
  }

  private measure(): void {
    this.tops = this.els.map((el) => this.offsetIn(el));
    this.total = this.content.scrollHeight;
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
    return this.settings.fontSize * this.settings.lineHeight;
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
    } else if (this.voice) {
      this.follow(dt);
    } else if (this.playing && now >= this.dwellUntil) {
      this.advance(dt, now);
    }

    const i = this.blockAt(this.pos);
    if (i !== this.current) {
      this.current = i;
      this.updateRead();
      this.updateHud();
    }
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

    const seconds = Math.max(
      MIN_BLOCK_SECONDS,
      (block.words / (this.settings.wpm * this.speedFor(block))) * 60,
    );
    this.pos += (this.blockHeight(i) / seconds) * dt;

    if (this.pos >= this.total) {
      this.pos = this.total;
      this.pause();
    }
  }

  private speedFor(block: Block): number {
    const s = this.settings;
    switch (block.type) {
      case "heading":
        return s.headingSpeed;
      case "list":
        return s.listSpeed;
      case "quote":
        return s.quoteSpeed;
      default:
        return s.paragraphSpeed;
    }
  }

  // ── Controls ───────────────────────────────────────────────────────────

  play(): void {
    if (this.pos >= this.total && !this.voice) return;
    this.playing = true;
    this.dwellUntil = 0;
    this.updateHud();
  }

  pause(): void {
    this.playing = false;
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
    this.highlight(word - 1, false);
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
    if (sec) this.goToBlock(sec.firstBlock);
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
    if (active) this.play();
    else {
      this.pause();
      this.highlight(-1, false);
      this.voiceWord = -1;
    }
    this.updateHud();
  }

  /** The voice process says you're saying word `i`. */
  followWord(i: number): void {
    if (!this.voice || !this.playing || !this.wordEls[i]) return;
    this.highlight(i, true);
    this.voiceWord = i;
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
  private highlight(now: number, showNow: boolean): void {
    const before = this.marked;
    for (let w = Math.max(0, Math.min(now, before) + 1); w <= Math.max(now, before); w++) {
      this.wordEls[w]?.toggleAttribute("data-said", w <= now);
    }
    this.stage.querySelector("[data-now]")?.removeAttribute("data-now");
    if (showNow) this.wordEls[now]?.setAttribute("data-now", "");
    // The few words you are about to say. (A handful of elements: just
    // clear and set them again.)
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
  }

  private updateHud(): void {
    const n = this.currentSection();
    const total = this.script.sections.length;
    const title = this.script.sections[n]?.title ?? "";
    const state = this.playing ? "▶" : "❚❚";
    const mode = this.voice ? "🎙 voice" : `${this.settings.wpm} wpm`;
    const info = this.voiceInfo ? `  ·  ${this.voiceInfo}` : "";
    this.hud.textContent = `${state}  ${mode}  ·  ${n + 1}/${total}  ${title}${info}`;
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
