// Markdown → teleprompter script.
//
// We only need a *small* subset of Markdown: block types (to drive scroll
// speed), inline emphasis (to render), word counts (to pace), and source line
// numbers (to open "at cursor"). A line scanner is enough for that.

export type BlockType = "heading" | "paragraph" | "list" | "quote" | "separator";

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  mark: boolean;
  strike: boolean;
}

export interface Block {
  type: BlockType;
  /** Heading level 1–6; list: 0 = bullet, n = ordered number. */
  level: number;
  runs: Run[];
  words: number;
  /** 0-based line in the source file where the block starts. */
  line: number;
  section: number;
}

export interface Section {
  /** Index of the first non-separator block of this section. */
  firstBlock: number;
  title: string;
}

export interface Script {
  blocks: Block[];
  sections: Section[];
}

const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const LIST = /^[ \t]*(?:([-*+])|(\d+)[.)])[ \t]+(?:\[.\][ \t]+)?(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;

/** Replace comments with blank lines, so line numbers stay correct. */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, "");
  return src.replace(/%%[\s\S]*?%%/g, blank).replace(/<!--[\s\S]*?-->/g, blank);
}

/** Simplify Obsidian/Markdown inline syntax to plain text plus emphasis markers. */
function simplifyInline(text: string): string {
  return text
    .replace(/!\[\[[^\]]*\]\]/g, "") // embeds
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2") // [[target|alias]]
    .replace(/\[\[([^\]#]*)(?:#[^\]]*)?\]\]/g, "$1") // [[target#heading]]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s\^[\w-]+\s*$/, "") // block ids
    .replace(/^\[![\w-]+\][+-]?\s*/, "") // callout header
    .trim();
}

const MARKERS = ["**", "__", "==", "~~", "*"] as const;
type Marker = (typeof MARKERS)[number];
const FLAG: Record<Marker, keyof Omit<Run, "text">> = {
  "**": "bold",
  __: "bold",
  "==": "mark",
  "~~": "strike",
  "*": "italic",
};

/** Split text into styled runs. A marker only opens if it is closed later. */
export function parseInline(raw: string): Run[] {
  const text = simplifyInline(raw);
  const tokens = text.split(/(\*\*|__|==|~~|\*)/).filter((t) => t !== "");
  const state = { bold: false, italic: false, mark: false, strike: false };
  const runs: Run[] = [];
  const push = (t: string) => {
    const last = runs.at(-1);
    if (
      last &&
      last.bold === state.bold &&
      last.italic === state.italic &&
      last.mark === state.mark &&
      last.strike === state.strike
    ) {
      last.text += t;
    } else {
      runs.push({ text: t, ...state });
    }
  };
  tokens.forEach((tok, i) => {
    const m = MARKERS.find((x) => x === tok);
    if (m === undefined) return push(tok);
    const flag = FLAG[m];
    if (state[flag]) {
      state[flag] = false;
    } else if (tokens.indexOf(m, i + 1) !== -1) {
      state[flag] = true;
    } else {
      push(tok); // unmatched marker: keep it literally
    }
  });
  return runs;
}

export function countWords(runs: Run[]): number {
  return runs.reduce((n, r) => n + (r.text.match(/\S+/g)?.length ?? 0), 0);
}

export function parseScript(source: string): Script {
  const lines = stripComments(source.replace(/\r\n?/g, "\n")).split("\n");
  const blocks: Block[] = [];
  const sections: Section[] = [];
  let section = 0;
  let sectionHasContent = false;

  // Skip YAML frontmatter.
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) start = end + 1;
  }

  // Accumulator for multi-line paragraphs / quotes.
  let buf: string[] = [];
  let bufType: "paragraph" | "quote" | null = null;
  let bufLine = 0;

  const add = (type: BlockType, level: number, text: string, line: number) => {
    const runs = type === "separator" ? [] : parseInline(text);
    const words = countWords(runs);
    if (type !== "separator" && words === 0) return;
    if (type !== "separator" && !sectionHasContent) {
      sections.push({ firstBlock: blocks.length, title: "" });
      sectionHasContent = true;
    }
    const sec = sections.at(-1);
    if (type === "heading" && sec && sec.title === "") {
      sec.title = runs.map((r) => r.text).join("");
    }
    blocks.push({ type, level, runs, words, line, section });
  };

  const flush = () => {
    if (bufType) add(bufType, 0, buf.join(" "), bufLine);
    buf = [];
    bufType = null;
  };

  const accumulate = (type: "paragraph" | "quote", text: string, line: number) => {
    if (bufType !== type) {
      flush();
      bufType = type;
      bufLine = line;
    }
    buf.push(text.trim());
  };

  let inFence = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (line.trim() === "") {
      flush();
      continue;
    }

    let m: RegExpMatchArray | null;
    if (HR.test(line)) {
      // `---` always means "next section" here, even right under a paragraph
      // (where CommonMark would make it a setext heading).
      flush();
      if (sectionHasContent) {
        section++;
        sectionHasContent = false;
        add("separator", 0, "", i);
      }
    } else if ((m = line.match(HEADING))) {
      flush();
      add("heading", m[1]!.length, m[2] ?? "", i);
    } else if ((m = line.match(LIST))) {
      flush();
      add("list", m[2] ? Number(m[2]) : 0, m[3] ?? "", i);
    } else if ((m = line.match(QUOTE))) {
      accumulate("quote", m[1] ?? "", i);
    } else {
      accumulate("paragraph", line, i);
    }
  }
  flush();

  // A trailing separator with nothing after it is not a section.
  if (blocks.at(-1)?.type === "separator") blocks.pop();

  return { blocks, sections };
}

/** Index of the last block starting at or before `line`. */
export function blockAtLine(script: Script, line: number): number {
  let found = 0;
  script.blocks.forEach((b, i) => {
    if (b.line <= line) found = i;
  });
  return found;
}
