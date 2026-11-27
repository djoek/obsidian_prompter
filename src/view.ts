import {
  ItemView,
  Notice,
  TFile,
  debounce,
  type ViewStateResult,
  type WorkspaceLeaf,
} from "obsidian";
import { noteOverrides, type NoteOverrides } from "./frontmatter";
import type SouffleurPlugin from "./main";
import { blockAtLine, parseScript, type Script } from "./parser";
import { Prompter } from "./prompter";
import type { PrompterSettings } from "./settings";

export const VIEW_TYPE = "souffleur";

interface State {
  file?: string;
  /** Source line to start at (from the editor cursor). */
  line?: number;
}

export class PrompterView extends ItemView {
  prompter: Prompter | null = null;
  private filePath: string | null = null;
  private script: Script | null = null;
  private overrides: NoteOverrides = { settings: {}, language: null, problems: [] };
  private shownProblems = "";

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: SouffleurPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    const name = this.filePath?.split("/").pop()?.replace(/\.md$/, "");
    return name ? `Souffleur: ${name}` : "Souffleur";
  }

  getIcon(): string {
    return "scroll-text";
  }

  /** Plugin settings with this note's frontmatter overrides on top. */
  settings(): PrompterSettings {
    return { ...this.plugin.settings, ...this.overrides.settings };
  }

  /** The script's language: the note's, else the plugin default, else null. */
  language(): string | null {
    return this.overrides.language ?? (this.plugin.settings.language || null);
  }

  /** Re-apply settings after the plugin settings or the frontmatter changed. */
  refreshSettings(): void {
    this.prompter?.applySettings(this.settings());
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.prompter = new Prompter(this.contentEl, this.settings(), {
      onWpmChange: (wpm) => {
        // A note that sets its own speed keeps +/− to this session.
        if (this.overrides.settings.wpm === undefined) {
          void this.plugin.updateSettings({ wpm }, false);
        }
      },
      onScript: (words, word, sections) =>
        this.plugin.voice?.sendScript(words, word, this.language(), sections),
      onSeek: (word) => this.plugin.voice?.seek(word),
      onToggleVoice: () => void this.plugin.toggleVoice(),
      onResetVoice: () => this.plugin.resetVoice(),
    });
    this.plugin.syncVoice(this);

    // Keys go to whichever window this view lives in (the popout).
    this.registerDomEvent(
      this.contentEl.win,
      "keydown",
      (e: KeyboardEvent) => {
        if (this.app.workspace.getActiveViewOfType(PrompterView) !== this) return;
        const t = e.target as HTMLElement | null;
        if (t?.isContentEditable || t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;
        // Learned pedal/clicker keys first, so they can override built-in keys.
        if (this.plugin.handleLearnedKey(e, this) || this.prompter?.handleKey(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      { capture: true },
    );

    // Live reload: edit the note in the main window, the prompter follows.
    // "changed" fires once Obsidian has re-read the note's frontmatter;
    // reading on "modify" could still see the old frontmatter.
    const reload = debounce(() => void this.loadScript(true), 300, true);
    this.registerEvent(
      this.app.metadataCache.on("changed", (f) => {
        if (f.path === this.filePath) reload();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        if (oldPath === this.filePath) {
          this.filePath = f.path;
        }
      }),
    );
  }

  async onClose(): Promise<void> {
    this.prompter?.destroy();
    this.prompter = null;
  }

  getState(): Record<string, unknown> {
    return { file: this.filePath };
  }

  async setState(state: State, result: ViewStateResult): Promise<void> {
    if (state.file) this.filePath = state.file;
    await this.loadScript(false);
    if (this.script && state.line !== undefined) {
      this.prompter?.goToBlock(blockAtLine(this.script, state.line), false);
    }
    await super.setState(state, result);
  }

  private async loadScript(keepPlace: boolean): Promise<void> {
    if (!this.filePath || !this.prompter) return;
    const file = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!(file instanceof TFile)) return;

    // Frontmatter first: the language travels with the script below.
    this.overrides = noteOverrides(this.app.metadataCache.getFileCache(file)?.frontmatter);
    this.reportProblems();
    this.refreshSettings();

    this.script = parseScript(await this.app.vault.cachedRead(file));
    this.prompter.setScript(this.script, keepPlace);
  }

  /** Say once (per distinct set) which frontmatter keys were ignored. */
  private reportProblems(): void {
    const text = this.overrides.problems.join("\n");
    if (text && text !== this.shownProblems) {
      new Notice(`Souffleur ignored some frontmatter:\n${text}`, 10_000);
    }
    this.shownProblems = text;
  }
}
