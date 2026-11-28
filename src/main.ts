import { spawn, type ChildProcess } from "child_process";
import { MarkdownView, Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import {
  DEFAULT_SETTINGS,
  VOICE_COMMAND,
  looksLikeOurs,
  migrateSettings,
  type MarginSide,
  type SpotlightStyle,
  type PrompterSettings,
  type Rotation,
} from "./settings";
import { SECTIONS_VIEW, SectionsView } from "./sections";
import { PrompterView, VIEW_TYPE } from "./view";
import { firstFamily, fontStack, installedFonts } from "./fonts";
import { HOOKS, type HookContext, type HookEvent, cleanHooks, hookEnv } from "./hooks";
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
  /** False while the prompter is paused: the voice process then rests. */
  private listening = true;
  /** Called on every voice state change; the settings tab uses this. */
  voiceListeners = new Set<() => void>();

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...migrateSettings(await this.loadSettingsData()) };
    this.settings.bindings = cleanBindings(this.settings.bindings);
    this.settings.hooks = cleanHooks(this.settings.hooks);
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

    // Escape in the main window (going back to editing) pauses prompters too.
    // It doesn't consume the key, so Escape keeps its normal job there.
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      for (const v of this.views()) if (v.prompter?.isPlaying) v.prompter.pause();
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

  /** Space in the prompter: pausing stops recognition (no wasted CPU/GPU). */
  setListening(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    this.voice?.setListening(on);
    this.refreshInfo();
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
        this.listening = this.views().some((v) => v.prompter?.isPlaying);
        this.voice?.setListening(this.listening);
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
        this.views().forEach((v) => v.prompter?.setLevel(rms));
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

  /** Apps started from the Dock get a minimal PATH; add the usual homes. */
  private shellEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const home = process.env.HOME ?? "";
    const PATH = [process.env.PATH, `${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"]
      .filter(Boolean)
      .join(":");
    return { ...process.env, PATH, ...extra };
  }

  /**
   * Run a lifecycle hook's command, if one is set. It never blocks the
   * prompter; output goes to the developer console, a failure to a notice.
   */
  runHook(event: HookEvent, ctx: HookContext): void {
    const command = this.settings.hooks[event]?.trim();
    if (!command) return;
    const name = HOOKS.find((h) => h.id === event)?.name ?? event;
    const proc = spawn(command, { shell: true, env: this.shellEnv(hookEnv(event, ctx)) });
    const log = (chunk: Buffer) => console.log(`[souffleur hook ${name}] ${chunk.toString().trimEnd()}`);
    proc.stdout?.on("data", log);
    proc.stderr?.on("data", log);
    proc.on("error", (e) => new Notice(`Souffleur hook "${name}" couldn't start: ${e.message}`));
    proc.on("exit", (code) => {
      if (code) new Notice(`Souffleur hook "${name}" failed (exit ${code}). See the developer console.`);
    });
  }

  private startProcess(command: string): void {
    const proc = spawn(command, { shell: true, detached: true, env: this.shellEnv() });
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
    view.prompter?.setVoiceWaiting(this.voice !== null && !this.voice.ready);
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
        if (!this.listening) return "🎙 paused (Space to listen)";
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

export class SouffleurSettingTab extends PluginSettingTab {
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
    containerEl.createEl("h4", { cls: "sf-subhead", text: "Pedals, clickers and MIDI" });
    containerEl.createEl("p", {
      cls: "sf-note-text",
      text:
        "Press Learn, then the pedal, clicker key or MIDI button. Keys work while the " +
        "prompter window is active; MIDI works whichever window is active. A learned key " +
        "replaces that key's built-in action in the prompter.",
    });
    const midiState = containerEl.createEl("p", { cls: "setting-item-description sf-note-text" });
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

  /** What's typed in the search box; kept when the page redraws. */
  private query = "";

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("sf-settings");
    const s = this.plugin.settings;
    const set = (patch: Partial<PrompterSettings>) => void this.plugin.updateSettings(patch);
    const voice = s.voiceEnabled;

    // Search: filters rows by name and description (see filter()).
    const search = new Setting(containerEl).setClass("sf-search");
    search.addSearch((q) => {
      q.setPlaceholder("Search Souffleur settings…")
        .setValue(this.query)
        .onChange((v) => {
          this.query = v;
          this.filter();
        });
    });

    // Rows go into `parent`: the current section, or a "More" fold in it.
    let parent: HTMLElement = containerEl;
    const section = (name: string) => {
      parent = containerEl.createDiv({ cls: "sf-section" });
      new Setting(parent).setName(name).setHeading();
    };
    const sub = (name: string, note = "") => {
      parent.createEl("h4", { cls: "sf-subhead", text: name });
      if (note) parent.createEl("p", { cls: "sf-note-text setting-item-description", text: note });
    };
    const more = (label: string, build: () => void) => {
      const outer = parent;
      const fold = outer.createEl("details", { cls: "sf-more" });
      fold.createEl("summary", { text: label });
      parent = fold;
      build();
      parent = outer;
    };
    // A row that only applies in one mode is greyed out in the other.
    const only = (mode: "voice" | "speed", row: Setting) => {
      if ((mode === "voice") === voice) return row;
      row.setDisabled(true).setClass("sf-off");
      row.descEl.createEl("div", {
        cls: "sf-why",
        text: mode === "voice" ? "Only when following your voice." : "Not used while following your voice.",
      });
      return row;
    };

    type NumKey = {
      [K in keyof PrompterSettings]: PrompterSettings[K] extends number ? K : never;
    }[keyof PrompterSettings];
    const slider = (name: string, key: NumKey, min: number, max: number, step: number, desc = "") =>
      new Setting(parent)
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
      new Setting(parent)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) => t.setValue(s[key]).onChange((v) => set({ [key]: v })));

    type ColorKey =
      | "textColor"
      | "backgroundColor"
      | "eyeLineColor"
      | "nextColor"
      | "heardColor"
      | "spotlightColor"
      | "unspokenColor";
    const color = (name: string, key: ColorKey, desc = "") =>
      new Setting(parent)
        .setName(name)
        .setDesc(desc)
        .addColorPicker((c) => c.setValue(s[key]).onChange((v) => set({ [key]: v })));

    // ── 1. Prompter: the rig, set once ─────────────────────────────────────
    section("Prompter");
    new Setting(parent)
      .setName("Rotation")
      .addDropdown((d) =>
        d
          .addOptions({ "0": "0°", "90": "90°", "180": "180°", "270": "270°" })
          .setValue(String(s.rotation))
          .onChange((v) => set({ rotation: Number(v) as Rotation })),
      );
    toggle("Flip horizontal", "flipH", "Mirror left↔right, for a beam-splitter glass.");
    toggle("Flip vertical", "flipV", "Mirror top↔bottom.");
    color("Background", "backgroundColor");
    slider("Eye-line position", "eyeLine", 10, 70, 1, "Percentage from the top: where you read.");
    toggle("Show eye-line markers", "showEyeLine");
    color("Eye-line marker colour", "eyeLineColor");
    toggle(
      "Status light",
      "showLight",
      "A dot top right, like a camera's tally light: red while going, a grey ring when paused, amber while voice tracking isn't ready yet.",
    );
    toggle("Show status bar", "showHud", "Toggle in the prompter with H.");
    toggle(
      "Show section timer",
      "showSectionTimer",
      "In the status bar: time in this section, and how long it normally takes at your speed.",
    );
    toggle("Keep the screen awake", "keepAwake", "While playing or listening, the display doesn't dim or sleep.");

    // ── 2. Text: how the words look ────────────────────────────────────────
    section("Text");
    const fonts = installedFonts(containerEl.doc);
    const current = firstFamily(s.fontFamily);
    let custom: HTMLInputElement | null = null;
    new Setting(parent)
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
    slider("Text width", "textWidth", 40, 100, 1, "Percentage of the prompter width.");
    new Setting(parent)
      .setName("Alignment")
      .addDropdown((d) =>
        d
          .addOptions({ left: "Left", center: "Centre" })
          .setValue(s.textAlign)
          .onChange((v) => set({ textAlign: v as "left" | "center" })),
      );
    color("Text colour", "textColor", "Italic, bold and highlight look as in your theme's reading view.");
    color("Not spoken", "unspokenColor", "Unspoken headings, margin notes, section labels and separators.");

    sub(
      "Margin notes",
      "Footnotes in your script, ^[smile] inline or [^1] with a [^1]: definition, appear in the margin level with their line. They aren't spoken. %% comments stay hidden.",
    );
    new Setting(parent)
      .setName("Margin notes position")
      .setDesc("As you read it, also when mirrored.")
      .addDropdown((d) =>
        d
          .addOptions({ before: "Before sentence", after: "After sentence", off: "Hidden" })
          .setValue(s.marginNotes)
          .onChange((v) => set({ marginNotes: v as MarginSide })),
      );
    slider("Margin width", "marginWidth", 10, 40, 1, "Percentage of the text width.");

    sub("Reading aids");
    toggle("Dim text already read", "dimRead");
    slider("Focus band", "focusBand", 0, 8, 1, "Lines kept bright from the eye line down; the rest is dimmed. 0: off.");
    toggle("Bold word starts", "boldStarts", "The first letters of each word a little bolder.");
    slider("Letter spacing", "letterSpacing", 0, 0.2, 0.01, "Extra space between letters, in em.");
    slider("Word spacing", "wordSpacing", 0, 0.6, 0.02, "Extra space between words, in em.");

    more("More text settings", () => {
      new Setting(parent)
        .setName("Font, as CSS")
        .setDesc("Or type any font-family list here.")
        .addText((t) => {
          custom = t.inputEl;
          t.setValue(s.fontFamily).onChange((v) => set({ fontFamily: v }));
        });
    });

    // ── 3. Scrolling: at a set speed, or following your voice ──────────────
    section("Scrolling");
    new Setting(parent)
      .setName("The text moves")
      .setDesc(
        voice
          ? `Following your voice. Status: ${this.plugin.voice?.state ?? "off"}. V in the prompter switches.`
          : "At a set speed. V in the prompter switches.",
      )
      .addDropdown((d) =>
        d
          .addOptions({ speed: "At a set speed", voice: "Following your voice" })
          .setValue(voice ? "voice" : "speed")
          .onChange(async (v) => {
            await this.plugin.updateSettings({ voiceEnabled: v === "voice" }, false);
            this.plugin.applyVoice();
            this.display();
            window.setTimeout(() => this.display(), 1500);
          }),
      );
    slider(
      "Speed",
      "wpm",
      40,
      400,
      5,
      "Words per minute. Change live with + and −. Also sets the 'normally' times, in both modes.",
    );
    slider("Pause at heading", "headingPause", 0, 5, 0.25, "Seconds the heading holds on the eye line.");
    only("speed", slider("Countdown before Play", "countdown", 0, 5, 1, "Seconds of 3-2-1 on screen. 0: start at once."));
    only("speed", slider("Smooth start", "smoothStart", 0, 3, 0.25, "Seconds to ease up to speed after Play. 0: full speed at once."));
    only(
      "speed",
      toggle("Stop at section break", "stopAtSection", "At a --- line, jump to the next section's start and pause. Space goes on."),
    );
    more("Speed per block type", () => {
      slider("Heading speed ×", "headingSpeed", 0.25, 4, 0.05);
      slider("Paragraph speed ×", "paragraphSpeed", 0.25, 4, 0.05);
      slider("List item speed ×", "listSpeed", 0.25, 4, 0.05);
      slider("Quote speed ×", "quoteSpeed", 0.25, 4, 0.05);
    });

    sub(
      "Following your voice",
      "A small local process listens to your microphone, recognises speech with Parakeet v3 and moves the prompter to the word you are saying. Needs uv and an Apple Silicon Mac. Space pauses and resumes listening.",
    );
    // Model download: a <progress> bar that updates while this tab is open.
    const model = only("voice", new Setting(parent).setName("Speech model"));
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

    only(
      "voice",
      new Setting(parent)
        .setName("Microphone")
        .setDesc("The list comes from the voice process, so it must be running.")
        .addDropdown((d) => {
          d.addOption("", "System default");
          if (s.voiceDevice) d.addOption(s.voiceDevice, s.voiceDevice);
          d.setValue(s.voiceDevice);
          d.onChange(async (name) => {
            await this.plugin.updateSettings({ voiceDevice: name }, false);
            this.plugin.voice?.setDevice(name);
          });
          void this.plugin.voice?.devices().then((list) => {
            for (const dev of list) {
              if (dev.name !== s.voiceDevice) d.addOption(dev.name, dev.name + (dev.default ? " (default)" : ""));
            }
          });
        }),
    );
    only(
      "voice",
      new Setting(parent)
        .setName("Language")
        .setDesc(
          "Default language of your scripts: a code such as nl, or empty to let the model decide. A note's frontmatter `language:` overrides it. Used to read numbers (2026) the way you say them.",
        )
        .addText((t) =>
          t
            .setPlaceholder("auto")
            .setValue(s.language)
            .onChange((v) => void this.plugin.updateSettings({ language: v.trim() }, false)),
        ),
    );
    only(
      "voice",
      new Setting(parent)
        .setName("Reset voice matching")
        .setDesc("If it stops following (for example, it picked the wrong language): forget what it heard and listen afresh. Also R in the prompter.")
        .addButton((b) =>
          b.setButtonText("Reset").onClick(() => {
            this.plugin.resetVoice();
            new Notice("Voice matching reset");
          }),
        ),
    );

    sub("While you speak");
    only("voice", color("Heard words", "heardColor", "Words just recognised, before they dim."));
    only("voice", slider("Keep heard words coloured", "heardHold", 0, 5, 0.25, "Seconds before a heard word dims. 0: dim at once."));
    only(
      "voice",
      new Setting(parent)
        .setName("Spotlight style")
        .setDesc("How the next words are marked. Underline keeps the text's own colours.")
        .addDropdown((d) =>
          d
            .addOptions({ underline: "Underline", colour: "Colour" })
            .setValue(s.spotlightStyle)
            .onChange((v) => set({ spotlightStyle: v as SpotlightStyle })),
        ),
    );
    only("voice", color("Spotlight colour", "spotlightColor"));
    only(
      "voice",
      slider("Spotlight words", "nextWords", 0, 15, 1, "The words right after the last one heard, where you'll be speaking. 0: off."),
    );
    only(
      "voice",
      slider("Pause helper", "pauseHint", 0, 10, 1, "When the microphone has been silent this many seconds, the spotlight words get a background. 0: off."),
    );
    only("voice", color("Pause helper colour", "nextColor"));

    sub("After a take");
    only(
      "voice",
      slider(
        "Note the last runs",
        "runsToKeep",
        0,
        9,
        1,
        "When you've read a section to the end, note its time as a %% run %% comment at the end of that section. Keeps this many, oldest first. 0: off.",
      ),
    );
    only(
      "voice",
      toggle(
        "Note what you said differently",
        "noteSaid",
        "After a read-through, what the speech model heard, with ==differences== and ~~left-out words~~ marked, in a %% said differently %% comment.",
      ),
    );

    more("Voice process", () => {
      new Setting(parent)
        .setName("Start command")
        .setDesc("Run when voice tracking turns on, stopped when it turns off. Empty: start `souffleur-voice serve` yourself, for example in a terminal to see its log.")
        .addTextArea((t) => {
          t.inputEl.rows = 3;
          t.inputEl.style.width = "100%";
          t.setPlaceholder(VOICE_COMMAND)
            .setValue(s.voiceCommand)
            .onChange((v) => void this.plugin.updateSettings({ voiceCommand: v }, false));
        });
      new Setting(parent)
        .setName("Server address")
        .addText((t) =>
          t.setValue(s.voiceUrl).onChange((v) => void this.plugin.updateSettings({ voiceUrl: v }, false)),
        );
      only(
        "voice",
        new Setting(parent)
          .setName("Restart voice tracking")
          .setDesc("Apply a changed command or address.")
          .addButton((b) =>
            b.setButtonText("Restart").onClick(() => {
              this.plugin.applyVoice();
              window.setTimeout(() => this.display(), 1500);
            }),
          ),
      );
    });

    // ── 4. Script: how the note is read ────────────────────────────────────
    section("Script");
    toggle(
      "Read headings aloud",
      "speakHeadings",
      "Off: headings are labels. They show, but aren't highlighted, matched by voice or counted in the timing.",
    );
    parent.createEl("p", {
      cls: "sf-note-text setting-item-description",
      text: "A note can override most settings for itself in its frontmatter: language: nl, and a souffleur: block with setting names, for example fontSize: 64.",
    });

    // ── 5. Controls ────────────────────────────────────────────────────────
    section("Controls");
    parent.createEl("p", {
      cls: "sf-note-text setting-item-description",
      text:
        "In the prompter: Space play/pause · N next section · P restart section (twice: previous) · " +
        "↑/↓ one line · PageUp/PageDown half screen · +/− speed · Home/End first/last section · " +
        "H status bar · F fullscreen · Esc pause · V voice tracking on/off · R reset voice matching · D diagnostics.",
    });
    this.displayInputs(parent);

    // ── 6. Advanced: folded away ───────────────────────────────────────────
    section("Advanced");
    more("Lifecycle hooks", () => {
      parent.createEl("p", {
        cls: "sf-note-text setting-item-description",
        text:
          "Run a shell command at a moment, to connect other tools (OBS, a recorder, chapter markers). " +
          "It gets SOUFFLEUR_EVENT, SOUFFLEUR_NOTE (the note's path on disk), SOUFFLEUR_SECTION (1, 2, …), " +
          "SOUFFLEUR_SECTION_TITLE and SOUFFLEUR_MODE (speed or voice). Output goes to the developer " +
          "console. Only set here, never from a note.",
      });
      for (const h of HOOKS) {
        new Setting(parent)
          .setName(`${h.name} hook`)
          .setDesc(h.when)
          .addText((t) =>
            t
              .setPlaceholder("command")
              .setValue(s.hooks[h.id])
              .onChange(
                (v) => void this.plugin.updateSettings({ hooks: { ...this.plugin.settings.hooks, [h.id]: v } }, false),
              ),
          )
          .addButton((b) =>
            b.setButtonText("Test").onClick(() => {
              if (!this.plugin.settings.hooks[h.id].trim()) return void new Notice("No command set.");
              this.plugin.runHook(h.id, {
                note: "/path/to/Videoscripts.md",
                section: 0,
                sectionTitle: "Test section",
                mode: voice ? "voice" : "speed",
                ...(h.id === "sectionDone" ? { seconds: 125, wpm: 138 } : {}),
              });
              new Notice(`Ran the ${h.name} hook. Output is in the developer console.`);
            }),
          );
      }
    });

    this.filter();
  }

  /**
   * Show only rows whose name or description contains the search text.
   * Sections without a match hide; folds with a match open; explanations and
   * sub-headings hide while searching.
   */
  private filter(): void {
    const q = this.query.trim().toLowerCase();
    const root = this.containerEl;
    for (const sec of Array.from(root.querySelectorAll<HTMLElement>(".sf-section"))) {
      let any = false;
      const rows = sec.querySelectorAll<HTMLElement>(".setting-item:not(.setting-item-heading)");
      for (const row of Array.from(rows)) {
        const name = row.querySelector(".setting-item-name")?.textContent ?? "";
        const desc = row.querySelector(".setting-item-description")?.textContent ?? "";
        // Rows in a fold also match on its name ("Speed per block type").
        const fold = row.closest("details")?.querySelector("summary")?.textContent ?? "";
        const hit = !q || `${name} ${desc} ${fold}`.toLowerCase().includes(q);
        row.toggleClass("sf-hidden", !hit);
        any ||= hit;
      }
      sec.toggleClass("sf-hidden", !any);
      for (const el of Array.from(sec.querySelectorAll<HTMLElement>(".sf-subhead, .sf-note-text"))) {
        el.toggleClass("sf-hidden", !!q);
      }
      for (const fold of Array.from(sec.querySelectorAll<HTMLDetailsElement>("details.sf-more"))) {
        const hasHit = !!fold.querySelector(".setting-item:not(.sf-hidden)");
        fold.toggleClass("sf-hidden", !!q && !hasHit);
        // Open folds with a match; close the ones the search opened when it's
        // cleared (a fold you opened yourself stays open).
        if (q && hasHit && !fold.open) {
          fold.open = true;
          fold.dataset.bySearch = "1";
        } else if (!q && fold.dataset.bySearch) {
          fold.open = false;
          delete fold.dataset.bySearch;
        }
      }
    }
  }
}
