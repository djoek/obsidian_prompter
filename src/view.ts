import { ItemView, TFile, debounce, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type TeleprompterPlugin from "./main";
import { blockAtLine, parseScript, type Script } from "./parser";
import { Prompter } from "./prompter";

export const VIEW_TYPE = "teleprompter";

interface State {
  file?: string;
  /** Source line to start at (from the editor cursor). */
  line?: number;
}

export class PrompterView extends ItemView {
  prompter: Prompter | null = null;
  private filePath: string | null = null;
  private script: Script | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TeleprompterPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    const name = this.filePath?.split("/").pop()?.replace(/\.md$/, "");
    return name ? `Prompter: ${name}` : "Teleprompter";
  }

  getIcon(): string {
    return "scroll-text";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.prompter = new Prompter(this.contentEl, this.plugin.settings, {
      onWpmChange: (wpm) => void this.plugin.updateSettings({ wpm }, false),
    });

    // Keys go to whichever window this view lives in (the popout).
    this.registerDomEvent(this.contentEl.win, "keydown", (e: KeyboardEvent) => {
      if (this.app.workspace.getActiveViewOfType(PrompterView) !== this) return;
      const t = e.target as HTMLElement | null;
      if (t?.isContentEditable || t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;
      if (this.prompter?.handleKey(e)) e.stopPropagation();
    }, { capture: true });

    // Live reload: edit the note in the main window, the prompter follows.
    const reload = debounce(() => void this.loadScript(true), 300, true);
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
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
    this.script = parseScript(await this.app.vault.cachedRead(file));
    this.prompter.setScript(this.script, keepPlace);
  }
}
