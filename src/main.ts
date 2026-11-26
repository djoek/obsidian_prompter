import { MarkdownView, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import { DEFAULT_SETTINGS, type PrompterSettings, type Rotation } from "./settings";
import { PrompterView, VIEW_TYPE } from "./view";

export default class TeleprompterPlugin extends Plugin {
  settings: PrompterSettings = { ...DEFAULT_SETTINGS };

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
    if (apply) this.views().forEach((v) => v.prompter?.applySettings(this.settings));
  }
}

class TeleprompterSettingTab extends PluginSettingTab {
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

    type ColorKey = "textColor" | "backgroundColor" | "headingColor" | "markColor" | "eyeLineColor";
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
    text("Font", "fontFamily", "Any CSS font-family list.");
    slider("Font size", "fontSize", 16, 160, 2, "Pixels.");
    slider("Line height", "lineHeight", 1, 2, 0.05);
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

    new Setting(containerEl).setName("Keys in the prompter").setHeading();
    containerEl.createEl("p", {
      text:
        "Space play/pause · N next section · P restart section (twice: previous) · " +
        "↑/↓ one line · PageUp/PageDown half screen · +/− speed · Home/End first/last section · " +
        "H status bar · F fullscreen (Esc to leave).",
    });
  }
}
