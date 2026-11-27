import { spawn, type ChildProcess } from "child_process";
import { MarkdownView, Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import {
  DEFAULT_SETTINGS,
  VOICE_COMMAND,
  looksLikeOurs,
  migrateSettings,
  type MarginSide,
  type PrompterSettings,
  type Rotation,
} from "./settings";
import { SECTIONS_VIEW, SectionsView } from "./sections";
import { PrompterView, VIEW_TYPE } from "./view";
import { firstFamily, fontStack, installedFonts } from "./fonts";
import {
  ACTIONS,
  type Action,
  actionsFor,
  cleanBindings,
  describeInput,
  keyInput,
  Midi,
} from "./inputs";
import { VoiceClient, type VoiceState } from "./voice";

export default class SouffleurPlugin extends Plugin {
  settings: PrompterSettings = { ...DEFAULT_SETTINGS };
  voice: VoiceClient | null = null;
  midi = new Midi();
  private stopMidiListener: (() => void) | null = null;
  private proc: ChildProcess | null = null;
  /** Device name, or the error text when the state is "error". */
  voiceDetail = "";
  private level = 0;
  private heard = "";
  /** Called on every voice state change; the settings tab uses this. */
  voiceListeners = new Set<() => void>();

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...migrateSettings(await this.loadSettingsData()) };
    this.settings.bindings = cleanBindings(this.settings.bindings);
    this.midi.setDevice(this.settings.midiDevice);
    this.midi.setChannel(this.settings.midiChannel);
    this.registerView(VIEW_TYPE, (leaf) => new PrompterView(leaf, this));
    this.registerView(SECTIONS_VIEW, (leaf) => new SectionsView(leaf, this));
    this.addSettingTab(new SouffleurSettingTab(this.app, this));

    this.addCommand({
      id: "open",
      name: "Open teleprompter for current note",
      checkCallback: (checking) => this.openCommand(checking, false),
    });
    this.addCommand({
      id: "show-section-lengths",
      name: "Show section lengths",
      callback: () => void this.showSections(),
    });
    this.addCommand({
      id: "open-at-cursor",
      name: "Open teleprompter at cursor",
      checkCallback: (checking) => this.openCommand(checking, true),
    });

    // Controls usable from any window, so you can bind Obsidian hotkeys
    // (or a Stream Deck / foot pedal that sends keystrokes) to them.
    const control = (id: string, name: string, fn: (v: PrompterView) => void) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const views = this.views();
          if (views.length === 0) return false;
          if (!checking) views.forEach(fn);
          return true;
        },
      });
    control("toggle", "Play / pause", (v) => v.prompter?.toggle());
    control("next-section", "Next section", (v) => v.prompter?.nextSection());
    control("prev-section", "Previous section / restart section", (v) => v.prompter?.prevSection());
    control("faster", "Faster", (v) => v.prompter?.adjustWpm(10));
    control("slower", "Slower", (v) => v.prompter?.adjustWpm(-10));

    this.addCommand({
      id: "toggle-voice",
      name: "Toggle voice tracking",
      callback: () => void this.toggleVoice(),
    });
    this.addCommand({
      id: "reset-voice",
      name: "Reset voice matching",
      checkCallback: (checking) => {
        if (!this.voice) return false;
        if (!checking) this.resetVoice();
        return true;
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.applyVoice();
      void this.syncMidi();
    });
  }

  /**
   * Our saved data, or on the very first start, the settings of this plugin's
   * earlier version (id "teleprompter"), copied over once.
   */
  private async loadSettingsData(): Promise<unknown> {
    const data: unknown = await this.loadData();
    if (data) return data;
    const old = `${this.app.vault.configDir}/plugins/teleprompter/data.json`;
    try {
      if (!(await this.app.vault.adapter.exists(old))) return null;
      const oldData: unknown = JSON.parse(await this.app.vault.adapter.read(old));
      if (!looksLikeOurs(oldData)) return null; // e.g. lumetrium's Teleprompter
      await this.saveData(migrateSettings(oldData));
      new Notice(
        "Souffleur copied your settings from its earlier version (Teleprompter). " +
          "You can disable and remove that plugin now.",
        15_000,
      );
      return oldData;
    } catch (e) {
      console.warn("[souffleur] Could not import old settings", e);
      return null;
    }
  }

  onunload(): void {
    this.stopVoice();
    this.stopMidiListener?.();
    this.midi.stop();
  }

  // ── Voice tracking ─────────────────────────────────────────────────────

  async toggleVoice(): Promise<void> {
    await this.updateSettings({ voiceEnabled: !this.settings.voiceEnabled }, false);
    this.applyVoice();
    const text = `Voice tracking ${this.settings.voiceEnabled ? "on" : "off"}`;
    const views = this.views();
    if (views.length) views.forEach((v) => v.prompter?.toast(text));
    else new Notice(text);
  }

  /** Forget what was heard; recognition starts afresh (and re-detects the
   * language). Your place in the script stays. */
  resetVoice(): void {
    if (!this.voice) return;
    this.voice.reset();
    this.views().forEach((v) => v.prompter?.toast("Voice matching reset"));
  }

  // ── Pedals, clickers, MIDI ─────────────────────────────────────────────

  /** Run an action on one prompter, or all open ones. */
  runAction(action: Action, only?: PrompterView): void {
    if (action === "resetVoice") return this.resetVoice();
    for (const v of only ? [only] : this.views()) {
      const p = v.prompter;
      if (!p) continue;
      switch (action) {
        case "toggle":
          p.toggle();
          break;
        case "next":
          p.nextSection();
          break;
        case "prev":
          p.prevSection();
          break;
        case "faster":
          p.adjustWpm(10);
          break;
        case "slower":
          p.adjustWpm(-10);
          break;
        case "lineDown":
          p.lines(1);
          break;
        case "lineUp":
          p.lines(-1);
          break;
      }
    }
  }

  /** A key pressed in a prompter window: true if it was a learned input. */
  handleLearnedKey(e: KeyboardEvent, view: PrompterView): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const input = keyInput(e);
    const actions = input ? actionsFor(this.settings.bindings, input) : [];
    actions.forEach((a) => this.runAction(a, view));
    return actions.length > 0;
  }

  /** Listen to MIDI only while some binding uses it (no prompt otherwise). */
  async syncMidi(): Promise<void> {
    const wanted = this.settings.bindings.some((b) => b.input.startsWith("midi:"));
    if (wanted && !this.stopMidiListener) {
      if (!(await this.midi.start())) return;
      this.stopMidiListener = this.midi.on((input) =>
        actionsFor(this.settings.bindings, input).forEach((a) => this.runAction(a)),
      );
    } else if (!wanted) {
      // Also closes MIDI that was opened only for learning.
      this.stopMidiListener?.();
      this.stopMidiListener = null;
      this.midi.stop();
    }
  }

  /** (Re)start the voice process and client to match the settings. */
  applyVoice(): void {
    this.stopVoice();
    if (!this.settings.voiceEnabled) {
      this.views().forEach((v) => this.syncVoice(v));
      return;
    }
    if (this.settings.voiceCommand.trim()) this.startProcess(this.settings.voiceCommand);
    this.voice = new VoiceClient(this.settings.voiceUrl, {
      onConnect: () => {
        if (this.settings.voiceDevice) this.voice?.setDevice(this.settings.voiceDevice);
        this.views().forEach((v) => v.prompter?.announce());
      },
      onState: (state, detail) => {
        this.voiceDetail = detail;
        this.views().forEach((v) => this.syncVoice(v));
        this.voiceListeners.forEach((fn) => fn());
        if (state === "error") new Notice(`Voice tracking: ${detail}`);
      },
      onPosition: (word) => this.views().forEach((v) => v.prompter?.followWord(word)),
      onHeard: (text) => {
        this.heard = text;
        this.refreshInfo();
      },
      onLevel: (rms) => {
        this.level = rms;
        this.refreshInfo();
      },
    });
    this.views().forEach((v) => this.syncVoice(v));
    this.voiceListeners.forEach((fn) => fn());
  }

  private stopVoice(): void {
    this.voice?.close();
    this.voice = null;
    if (this.proc?.pid) {
      // Negative pid = the whole process group: the shell, uv and Python.
      try {
        process.kill(-this.proc.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    this.proc = null;
  }

  private startProcess(command: string): void {
    const home = process.env.HOME ?? "";
    // Apps started from the Dock get a minimal PATH; add the usual uv homes.
    const PATH = [process.env.PATH, `${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"]
      .filter(Boolean)
      .join(":");
    const proc = spawn(command, { shell: true, detached: true, env: { ...process.env, PATH } });
    this.proc = proc;
    let tail = "";
    const log = (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-500);
      console.log(`[souffleur voice] ${text.trimEnd()}`);
    };
    proc.stdout?.on("data", log);
    proc.stderr?.on("data", log);
    proc.on("exit", (code) => {
      if (this.proc === proc && code) {
        new Notice(`Voice process stopped (exit ${code}). See the developer console.\n${tail}`);
      }
    });
  }

  /** Give a prompter the current voice state. */
  syncVoice(view: PrompterView): void {
    view.prompter?.setVoice(this.voice?.ready ?? false);
    view.prompter?.setVoiceInfo(this.voiceLabel());
  }

  private refreshInfo(): void {
    const label = this.voiceLabel();
    this.views().forEach((v) => v.prompter?.setVoiceInfo(label));
  }

  private voiceLabel(): string {
    if (!this.voice) return "";
    const state: VoiceState = this.voice.state;
    switch (state) {
      case "offline":
        return "🎙 waiting for voice process…";
      case "downloading": {
        const d = this.voice.download;
        return d ? `🎙 downloading model ${formatProgress(d.done, d.total)}` : "🎙 downloading model…";
      }
      case "loading":
        return "🎙 loading model…";
      case "error":
        return `🎙 error: ${this.voiceDetail}`;
      case "ready": {
        // RMS → decibels → 0..5 bars (-60 dB silent, 0 dB loudest).
        const db = 20 * Math.log10(Math.max(this.level, 1e-6));
        const bars = Math.round(Math.max(0, Math.min(5, (db + 60) / 12)));
        const heard = this.heard.split(" ").slice(-5).join(" ");
        return `🎙 ${"▮".repeat(bars)}${"▯".repeat(5 - bars)} ${heard}`;
      }
    }
  }

  private openCommand(checking: boolean, atCursor: boolean): boolean {
    const md = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = md?.file ?? this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return false;
    if (checking) return true;
    const line = atCursor ? md?.editor.getCursor().line : undefined;
    void this.open(file.path, line);
    return true;
  }

  private async open(path: string, line?: number): Promise<void> {
    const { workspace } = this.app;
    // Reuse an open prompter so the window stays where you put it.
    const leaf =
      workspace.getLeavesOfType(VIEW_TYPE)[0] ??
      workspace.openPopoutLeaf({ size: { width: 1024, height: 600 } });
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { file: path, line } });
    await workspace.revealLeaf(leaf);
  }

  private async showSections(): Promise<void> {
    const { workspace } = this.app;
    const leaf = workspace.getLeavesOfType(SECTIONS_VIEW)[0] ?? workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: SECTIONS_VIEW, active: true });
    await workspace.revealLeaf(leaf);
  }

  sectionViews(): SectionsView[] {
    return this.app.workspace
      .getLeavesOfType(SECTIONS_VIEW)
      .map((l) => l.view)
      .filter((v): v is SectionsView => v instanceof SectionsView);
  }

  views(): PrompterView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map((l) => l.view)
      .filter((v): v is PrompterView => v instanceof PrompterView);
  }

  /** Save settings; optionally push them to open prompters immediately. */
  async updateSettings(patch: Partial<PrompterSettings>, apply = true): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await this.saveData(this.settings);
    if (apply) this.views().forEach((v) => v.refreshSettings());
    this.sectionViews().forEach((v) => void v.refresh());
  }
}

/** "43% · 1.1 of 2.5 GB" */
export function formatProgress(done: number, total: number): string {
  const gb = (n: number) => (n / 1e9).toFixed(1);
  const pct = total ? Math.floor((done / total) * 100) : 0;
  return `${pct}% · ${gb(done)} of ${gb(total)} GB`;
}

class SouffleurSettingTab extends PluginSettingTab {
  private unsubscribe: (() => void) | null = null;
  private stopLearning: (() => void) | null = null;

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopLearning?.();
    void this.plugin.syncMidi(); // close MIDI if it was only opened to list devices
  }

  /** Pedals, clickers and MIDI: one row per action, with Learn and remove. */
  private displayInputs(containerEl: HTMLElement): void {
    const plugin = this.plugin;
    new Setting(containerEl).setName("Pedals, clickers and MIDI").setHeading();
    containerEl.createEl("p", {
      text:
        "Press Learn, then the pedal, clicker key or MIDI button. Keys work while the " +
        "prompter window is active; MIDI works whichever window is active. A learned key " +
        "replaces that key's built-in action in the prompter.",
    });
    const midiState = containerEl.createEl("p", { cls: "setting-item-description" });
    const showMidi = () => {
      const devices = plugin.midi.devices();
      midiState.setText(
        plugin.midi.error ||
          (plugin.midi.running
            ? devices.length
              ? `MIDI inputs: ${devices.join(", ")}`
              : "MIDI is on, but no MIDI device is connected."
            : "MIDI is off until you learn a MIDI input."),
      );
    };
    showMidi();

    // Which MIDI device to listen to. The list needs MIDI to be open, which
    // may ask for permission, so it's opened on request.
    const connected = plugin.midi.devices();
    const chosen = plugin.settings.midiDevice;
    new Setting(containerEl)
      .setName("MIDI device")
      .setDesc(
        plugin.midi.running
          ? "Only this device triggers actions and is listened to when learning."
          : "Press Find devices to list your MIDI devices.",
      )
      .addDropdown((d) => {
        d.addOption("", "All MIDI devices");
        for (const name of connected) d.addOption(name, name);
        if (chosen && !connected.includes(chosen)) d.addOption(chosen, `${chosen} (not connected)`);
        d.setValue(chosen).onChange(async (name) => {
          await plugin.updateSettings({ midiDevice: name }, false);
          plugin.midi.setDevice(name);
        });
      })
      .addButton((b) =>
        b.setButtonText(plugin.midi.running ? "Refresh" : "Find devices").onClick(async () => {
          await plugin.midi.start();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("MIDI channel")
      .setDesc("Only messages on this channel trigger actions and are learned.")
      .addDropdown((d) => {
        d.addOption("0", "All channels");
        for (let ch = 1; ch <= 16; ch++) d.addOption(String(ch), `Channel ${ch}`);
        d.setValue(String(plugin.settings.midiChannel)).onChange(async (v) => {
          const channel = Number(v);
          await plugin.updateSettings({ midiChannel: channel }, false);
          plugin.midi.setChannel(channel);
        });
      });

    for (const action of ACTIONS) {
      const bound = plugin.settings.bindings.filter((b) => b.action === action.id);
      const row = new Setting(containerEl)
        .setName(action.name)
        .setDesc(bound.length ? bound.map((b) => describeInput(b.input)).join(" · ") : "Not set");
      for (const b of bound) {
        row.addExtraButton((x) =>
          x
            .setIcon("x")
            .setTooltip(`Remove ${describeInput(b.input)}`)
            .onClick(async () => {
              await plugin.updateSettings(
                { bindings: plugin.settings.bindings.filter((o) => o !== b) },
                false,
              );
              await plugin.syncMidi();
              this.display();
            }),
        );
      }
      row.addButton((btn) =>
        btn.setButtonText("Learn").onClick(() => {
          this.stopLearning?.();
          btn.setButtonText("Press a key or pedal… (Esc cancels)").setCta();
          void this.learn(action.id, () => {
            btn.setButtonText("Learn").removeCta();
            showMidi();
          });
        }),
      );
    }
  }

  /** Wait for one key or MIDI press, then bind it to `action`. */
  private async learn(action: Action, done: () => void): Promise<void> {
    const plugin = this.plugin;
    const win = this.containerEl.win;
    const finish = async (input: string | null) => {
      cleanup();
      done();
      if (input && !plugin.settings.bindings.some((b) => b.action === action && b.input === input)) {
        await plugin.updateSettings(
          { bindings: [...plugin.settings.bindings, { action, input }] },
          false,
        );
        new Notice(`${describeInput(input)} → ${ACTIONS.find((a) => a.id === action)?.name}`);
      }
      await plugin.syncMidi();
      if (input) this.display();
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return void finish(null);
      const input = keyInput(e);
      if (input) void finish(input);
    };
    win.addEventListener("keydown", onKey, { capture: true });
    // MIDI is opened for learning too; it closes again if nothing uses it.
    const midiOn = await plugin.midi.start();
    const stopMidi = midiOn ? plugin.midi.on((input) => void finish(input)) : () => {};
    const timer = win.setTimeout(() => void finish(null), 20_000);
    const cleanup = () => {
      win.removeEventListener("keydown", onKey, { capture: true });
      stopMidi();
      win.clearTimeout(timer);
      this.stopLearning = null;
    };
    this.stopLearning = () => {
      cleanup();
      done();
      void plugin.syncMidi();
    };
  }

  constructor(
    app: App,
    private plugin: SouffleurPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const set = (patch: Partial<PrompterSettings>) => void this.plugin.updateSettings(patch);

    const text = (name: string, key: "fontFamily", desc = "") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => t.setValue(s[key]).onChange((v) => set({ [key]: v })));

    type NumKey = {
      [K in keyof PrompterSettings]: PrompterSettings[K] extends number ? K : never;
    }[keyof PrompterSettings];
    const slider = (name: string, key: NumKey, min: number, max: number, step: number, desc = "") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addSlider((sl) =>
          sl
            .setLimits(min, max, step)
            .setValue(s[key] as number)
            .setDynamicTooltip()
            .onChange((v) => set({ [key]: v })),
        );

    type BoolKey = {
      [K in keyof PrompterSettings]: PrompterSettings[K] extends boolean ? K : never;
    }[keyof PrompterSettings];
    const toggle = (name: string, key: BoolKey, desc = "") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) => t.setValue(s[key]).onChange((v) => set({ [key]: v })));

    type ColorKey =
      | "textColor"
      | "backgroundColor"
      | "headingColor"
      | "markColor"
      | "eyeLineColor"
      | "nextColor"
      | "noteColor";
    const color = (name: string, key: ColorKey) =>
      new Setting(containerEl)
        .setName(name)
        .addColorPicker((c) => c.setValue(s[key]).onChange((v) => set({ [key]: v })));

    new Setting(containerEl).setName("Orientation").setHeading();
    new Setting(containerEl)
      .setName("Rotation")
      .addDropdown((d) =>
        d
          .addOptions({ "0": "0°", "90": "90°", "180": "180°", "270": "270°" })
          .setValue(String(s.rotation))
          .onChange((v) => set({ rotation: Number(v) as Rotation })),
      );
    toggle("Flip horizontal", "flipH", "Mirror left↔right, for a beam-splitter glass.");
    toggle("Flip vertical", "flipV", "Mirror top↔bottom.");

    new Setting(containerEl).setName("Text").setHeading();
    // Fonts found on this computer; dyslexia-oriented ones first.
    const fonts = installedFonts(containerEl.doc);
    const current = firstFamily(s.fontFamily);
    let custom: HTMLInputElement | null = null;
    new Setting(containerEl)
      .setName("Font")
      .setDesc(
        fonts.some((f) => f.dyslexia)
          ? "Fonts found on this computer. ★ = designed or recommended for dyslexic readers."
          : "Fonts found on this computer.",
      )
      .addDropdown((d) => {
        for (const f of fonts) d.addOption(f.name, f.dyslexia ? `★ ${f.name}` : f.name);
        if (!fonts.some((f) => f.name === current)) d.addOption(current, `${current} (custom)`);
        d.setValue(current).onChange((name) => {
          const stack = fontStack(name);
          if (custom) custom.value = stack;
          set({ fontFamily: stack });
        });
      });
    new Setting(containerEl)
      .setName("Font, as CSS")
      .setDesc("Or type any font-family list here.")
      .addText((t) => {
        custom = t.inputEl;
        t.setValue(s.fontFamily).onChange((v) => set({ fontFamily: v }));
      });
    slider("Font size", "fontSize", 16, 160, 2, "Pixels.");
    slider(
      "Words per line",
      "wordsPerLine",
      0,
      12,
      1,
      "0: use Font size. Otherwise the size follows the screen width, so about this many words fit on a line.",
    );
    slider("Line height", "lineHeight", 1, 2, 0.05);
    slider("Letter spacing", "letterSpacing", 0, 0.2, 0.01, "Extra space between letters, in em.");
    slider("Word spacing", "wordSpacing", 0, 0.6, 0.02, "Extra space between words, in em.");
    slider("Text width", "textWidth", 40, 100, 1, "Percentage of the prompter width.");
    new Setting(containerEl)
      .setName("Alignment")
      .addDropdown((d) =>
        d
          .addOptions({ left: "Left", center: "Centre" })
          .setValue(s.textAlign)
          .onChange((v) => set({ textAlign: v as "left" | "center" })),
      );

    new Setting(containerEl).setName("Colours").setHeading();
    color("Text", "textColor");
    color("Background", "backgroundColor");
    color("Headings and separators", "headingColor");
    color("==Highlight==", "markColor");
    color("Eye-line markers", "eyeLineColor");

    new Setting(containerEl).setName("Reading aids").setHeading();
    slider("Eye-line position", "eyeLine", 10, 70, 1, "Percentage from the top: where you read.");
    toggle("Show eye-line markers", "showEyeLine");
    toggle("Dim text already read", "dimRead");
    toggle("Show status bar", "showHud", "Toggle in the prompter with H.");
    toggle(
      "Show section timer",
      "showSectionTimer",
      "In the status bar: time spent in this section, and how long it normally takes at your speed.",
    );

    color("Next words (voice tracking)", "nextColor");
    color("Margin notes", "noteColor");
    slider(
      "How many next words to highlight",
      "nextWords",
      0,
      10,
      1,
      "With voice tracking: the words right after the one you are saying.",
    );

    slider(
      "Focus band",
      "focusBand",
      0,
      8,
      1,
      "Lines kept bright from the eye line down; the rest is dimmed. 0: off.",
    );
    toggle("Bold word starts", "boldStarts", "The first letters of each word a little bolder.");
    slider(
      "Pause helper",
      "pauseHint",
      0,
      10,
      1,
      "Voice tracking: after this many seconds of silence, the next words light up. 0: off.",
    );

    new Setting(containerEl).setName("Margin notes").setHeading();
    containerEl.createEl("p", {
      text:
        "Footnotes in your script appear in the margin, level with their line: " +
        "^[smile] inline, or [^1] with a [^1]: definition. They aren't spoken, so " +
        "they don't count for timing or voice tracking. %% comments stay hidden.",
    });
    new Setting(containerEl)
      .setName("Position")
      .setDesc("As you read it, also when mirrored.")
      .addDropdown((d) =>
        d
          .addOptions({ before: "Before sentence", after: "After sentence", off: "Hidden" })
          .setValue(s.marginNotes)
          .onChange((v) => set({ marginNotes: v as MarginSide })),
      );
    slider("Margin width", "marginWidth", 10, 40, 1, "Percentage of the text width.");

    new Setting(containerEl).setName("Pacing").setHeading();
    slider("Speed", "wpm", 40, 400, 5, "Words per minute. Change live with + and −.");
    slider("Heading speed ×", "headingSpeed", 0.25, 4, 0.05);
    slider("Paragraph speed ×", "paragraphSpeed", 0.25, 4, 0.05);
    slider("List item speed ×", "listSpeed", 0.25, 4, 0.05);
    slider("Quote speed ×", "quoteSpeed", 0.25, 4, 0.05);
    slider("Pause at heading", "headingPause", 0, 5, 0.25, "Seconds the heading holds on the eye line.");
    slider("Countdown before Play", "countdown", 0, 5, 1, "Seconds of 3-2-1 on screen. 0: start at once. Not used in voice mode.");
    slider("Smooth start", "smoothStart", 0, 3, 0.25, "Seconds to ease up to speed after Play. 0: full speed at once.");
    toggle("Keep the screen awake", "keepAwake", "While playing or listening, the display doesn't dim or sleep.");
    toggle(
      "Stop at section break",
      "stopAtSection",
      "At a --- line, jump to the next section's start and pause. Press Space to go on.",
    );

    new Setting(containerEl).setName("Voice tracking").setHeading();
    containerEl.createEl("p", {
      text:
        "A small local process listens to your microphone, recognises speech with " +
        "Parakeet v3, and moves the prompter to the word you are saying. Needs uv " +
        "and an Apple Silicon Mac. While on, Space pauses/resumes following.",
    });
    new Setting(containerEl)
      .setName("Enable voice tracking")
      .setDesc(`Status: ${this.plugin.voice?.state ?? "off"}`)
      .addToggle((t) =>
        t.setValue(s.voiceEnabled).onChange(async (v) => {
          await this.plugin.updateSettings({ voiceEnabled: v }, false);
          this.plugin.applyVoice();
          window.setTimeout(() => this.display(), 1500);
        }),
      );
    // Model download: a <progress> bar that updates while this tab is open.
    const model = new Setting(containerEl).setName("Speech model");
    const bar = model.controlEl.createEl("progress", { cls: "sf-download" });
    bar.max = 1;
    const showModel = () => {
      const v = this.plugin.voice;
      const d = v?.download;
      bar.hidden = !d;
      if (d) {
        bar.value = d.total ? d.done / d.total : 0;
        model.setDesc(`Downloading Parakeet v3: ${formatProgress(d.done, d.total)}`);
      } else {
        model.setDesc(
          {
            off: "Parakeet v3 (2.5 GB, downloaded on the first start).",
            offline: "Waiting for the voice process…",
            downloading: "Downloading Parakeet v3…",
            loading: "Downloaded. Loading into memory…",
            ready: "Parakeet v3, ready.",
            error: `Error: ${this.plugin.voiceDetail || "see the developer console"}`,
          }[v?.state ?? "off"],
        );
      }
    };
    showModel();
    this.unsubscribe?.();
    this.plugin.voiceListeners.add(showModel);
    this.unsubscribe = () => this.plugin.voiceListeners.delete(showModel);

    const mic = new Setting(containerEl)
      .setName("Microphone")
      .setDesc("The list comes from the voice process, so it must be running.");
    mic.addDropdown((d) => {
      d.addOption("", "System default");
      if (s.voiceDevice) d.addOption(s.voiceDevice, s.voiceDevice);
      d.setValue(s.voiceDevice);
      d.onChange(async (name) => {
        await this.plugin.updateSettings({ voiceDevice: name }, false);
        this.plugin.voice?.setDevice(name);
      });
      void this.plugin.voice?.devices().then((list) => {
        for (const dev of list) {
          if (dev.name !== s.voiceDevice) {
            d.addOption(dev.name, dev.name + (dev.default ? " (default)" : ""));
          }
        }
      });
    });
    new Setting(containerEl)
      .setName("Language")
      .setDesc(
        "Default language of your scripts: a code such as nl, or empty to let the " +
          "model decide. A note's frontmatter `language:` overrides it. Used to " +
          "read numbers (2026) the way you say them.",
      )
      .addText((t) =>
        t
          .setPlaceholder("auto")
          .setValue(s.language)
          .onChange((v) => void this.plugin.updateSettings({ language: v.trim() }, false)),
      );
    new Setting(containerEl)
      .setName("Reset voice matching")
      .setDesc(
        "If it stops following (for example, it picked the wrong language): forget " +
          "what it heard and start listening afresh. Also R in the prompter.",
      )
      .addButton((b) =>
        b.setButtonText("Reset").onClick(() => {
          this.plugin.resetVoice();
          new Notice("Voice matching reset");
        }),
      );
    new Setting(containerEl)
      .setName("Start command")
      .setDesc(
        "Run when voice tracking turns on, stopped when it turns off. Empty: start " +
          "`prompter-voice serve` yourself, for example in a terminal to see its log.",
      )
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.style.width = "100%";
        t.setPlaceholder(VOICE_COMMAND)
          .setValue(s.voiceCommand)
          .onChange((v) => void this.plugin.updateSettings({ voiceCommand: v }, false));
      });
    new Setting(containerEl)
      .setName("Server address")
      .addText((t) =>
        t
          .setValue(s.voiceUrl)
          .onChange((v) => void this.plugin.updateSettings({ voiceUrl: v }, false)),
      );
    new Setting(containerEl)
      .setName("Restart voice tracking")
      .setDesc("Apply a changed command or address.")
      .addButton((b) =>
        b.setButtonText("Restart").onClick(() => {
          this.plugin.applyVoice();
          window.setTimeout(() => this.display(), 1500);
        }),
      );

    this.displayInputs(containerEl);

    new Setting(containerEl).setName("Keys in the prompter").setHeading();
    containerEl.createEl("p", {
      text:
        "Space play/pause · N next section · P restart section (twice: previous) · " +
        "↑/↓ one line · PageUp/PageDown half screen · +/− speed · Home/End first/last section · " +
        "H status bar · F fullscreen (Esc to leave) · V voice tracking on/off · " +
        "R reset voice matching · D diagnostics.",
    });
  }
}
