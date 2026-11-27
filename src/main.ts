import { spawn, type ChildProcess } from "child_process";
import { MarkdownView, Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import {
  DEFAULT_SETTINGS,
  VOICE_COMMAND,
  type PrompterSettings,
  type Rotation,
} from "./settings";
import { PrompterView, VIEW_TYPE } from "./view";
import { firstFamily, fontStack, installedFonts } from "./fonts";
import { VoiceClient, type VoiceState } from "./voice";

export default class TeleprompterPlugin extends Plugin {
  settings: PrompterSettings = { ...DEFAULT_SETTINGS };
  voice: VoiceClient | null = null;
  private proc: ChildProcess | null = null;
  /** Device name, or the error text when the state is "error". */
  voiceDetail = "";
  private level = 0;
  private heard = "";
  /** Called on every voice state change; the settings tab uses this. */
  voiceListeners = new Set<() => void>();

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.registerView(VIEW_TYPE, (leaf) => new PrompterView(leaf, this));
    this.addSettingTab(new TeleprompterSettingTab(this.app, this));

    this.addCommand({
      id: "open",
      name: "Open teleprompter for current note",
      checkCallback: (checking) => this.openCommand(checking, false),
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

    this.app.workspace.onLayoutReady(() => this.applyVoice());
  }

  onunload(): void {
    this.stopVoice();
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
      console.log(`[teleprompter voice] ${text.trimEnd()}`);
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
  }
}

/** "43% · 1.1 of 2.5 GB" */
export function formatProgress(done: number, total: number): string {
  const gb = (n: number) => (n / 1e9).toFixed(1);
  const pct = total ? Math.floor((done / total) * 100) : 0;
  return `${pct}% · ${gb(done)} of ${gb(total)} GB`;
}

class TeleprompterSettingTab extends PluginSettingTab {
  private unsubscribe: (() => void) | null = null;

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  constructor(
    app: App,
    private plugin: TeleprompterPlugin,
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
      | "nextColor";
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

    color("Next words (voice tracking)", "nextColor");
    slider(
      "How many next words to highlight",
      "nextWords",
      0,
      10,
      1,
      "With voice tracking: the words right after the one you are saying.",
    );

    new Setting(containerEl).setName("Pacing").setHeading();
    slider("Speed", "wpm", 40, 400, 5, "Words per minute. Change live with + and −.");
    slider("Heading speed ×", "headingSpeed", 0.25, 4, 0.05);
    slider("Paragraph speed ×", "paragraphSpeed", 0.25, 4, 0.05);
    slider("List item speed ×", "listSpeed", 0.25, 4, 0.05);
    slider("Quote speed ×", "quoteSpeed", 0.25, 4, 0.05);
    slider("Pause at heading", "headingPause", 0, 5, 0.25, "Seconds the heading holds on the eye line.");
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
    const bar = model.controlEl.createEl("progress", { cls: "tp-download" });
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
