// Sidebar: every section of the note you're writing, with its word count and
// how long it normally takes at your speed. Read-only: it never changes the note.

import { ItemView, MarkdownView, TFile, debounce, type WorkspaceLeaf } from "obsidian";
import { noteOverrides } from "./frontmatter";
import type SouffleurPlugin from "./main";
import { formatDuration, sectionLengths } from "./pacing";
import { parseScript } from "./parser";

export const SECTIONS_VIEW = "souffleur-sections";

export class SectionsView extends ItemView {
  /** The last Markdown note you were in; the sidebar itself isn't a note. */
  private file: TFile | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: SouffleurPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return SECTIONS_VIEW;
  }

  getDisplayText(): string {
    return "Section lengths";
  }

  getIcon(): string {
    return "timer";
  }

  async onOpen(): Promise<void> {
    this.file = this.app.workspace.getActiveFile();
    const refresh = debounce(() => void this.refresh(), 300, true);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView && leaf.view.file) {
          this.file = leaf.view.file;
          void this.refresh();
        }
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (f) => {
        if (f.path === this.file?.path) refresh();
      }),
    );
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("sf-sections");
    const file = this.file;
    if (!file || file.extension !== "md") {
      el.createEl("p", { text: "Open a note to see its sections." });
      return;
    }

    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const pacing = { ...this.plugin.settings, ...noteOverrides(fm).settings };
    const script = parseScript(await this.app.vault.cachedRead(file));
    const lengths = sectionLengths(script, pacing);

    el.createEl("h4", { text: file.basename });
    el.createEl("p", { cls: "sf-sections-pace", text: `At ${pacing.wpm} words per minute` });

    const table = el.createEl("table");
    const head = table.createEl("thead").createEl("tr");
    for (const label of ["Section", "Words", "Normally"]) head.createEl("th", { text: label });

    const body = table.createEl("tbody");
    lengths.forEach((s, i) => {
      const row = body.createEl("tr");
      const name = row.createEl("td").createEl("button", {
        text: s.title || `Section ${i + 1}`,
        attr: { title: "Go to this section in the note" },
      });
      name.addEventListener("click", () => this.reveal(file, s.line));
      row.createEl("td", { text: String(s.words) });
      row.createEl("td", { text: formatDuration(s.seconds) });
    });

    const total = table.createEl("tfoot").createEl("tr");
    total.createEl("th", { text: `${lengths.length} sections` });
    total.createEl("td", { text: String(lengths.reduce((n, s) => n + s.words, 0)) });
    total.createEl("td", { text: formatDuration(lengths.reduce((n, s) => n + s.seconds, 0)) });
  }

  /** Put the editor's cursor on the section's first line. */
  private reveal(file: TFile, line: number): void {
    const leaf = this.app.workspace
      .getLeavesOfType("markdown")
      .find((l) => l.view instanceof MarkdownView && l.view.file?.path === file.path);
    if (!(leaf?.view instanceof MarkdownView)) return;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const editor = leaf.view.editor;
    editor.setCursor({ line, ch: 0 });
    editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
  }
}
