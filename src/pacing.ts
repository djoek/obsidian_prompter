// How long the script takes at your speed. One model, shared by the scroll
// engine (how fast to move), the prompter's status bar and the sidebar (how
// long a section normally takes), so the three always agree.

import type { Block, Script } from "./parser";
import type { PrompterSettings } from "./settings";

/** Even a one-word block stays on the eye line this long. */
export const MIN_BLOCK_SECONDS = 0.4;

export type Pacing = Pick<
  PrompterSettings,
  | "wpm"
  | "headingSpeed"
  | "paragraphSpeed"
  | "listSpeed"
  | "quoteSpeed"
  | "headingPause"
  | "speakHeadings"
>;

/** Words you say in a block: headings are labels unless you read them aloud. */
export function spokenWords(block: Block, p: Pacing): number {
  return block.type === "heading" && !p.speakHeadings ? 0 : block.words;
}

/** The speed multiplier for a block's type. */
export function speedFor(block: Block, p: Pacing): number {
  switch (block.type) {
    case "heading":
      return p.headingSpeed;
    case "list":
      return p.listSpeed;
    case "quote":
      return p.quoteSpeed;
    default:
      return p.paragraphSpeed;
  }
}

/** Seconds to say one block (separators take no time). */
export function blockSeconds(block: Block, p: Pacing): number {
  if (block.type === "separator") return 0;
  return Math.max(MIN_BLOCK_SECONDS, (spokenWords(block, p) / (p.wpm * speedFor(block, p))) * 60);
}

export interface SectionLength {
  title: string;
  words: number;
  /** At your speed, including the pause at each heading. */
  seconds: number;
  /** Source line of the section's first block, for jumping to it. */
  line: number;
}

/** Expected length of every section, in order. */
export function sectionLengths(script: Script, p: Pacing): SectionLength[] {
  const out: SectionLength[] = script.sections.map((s) => ({
    title: s.title,
    words: 0,
    seconds: 0,
    line: script.blocks[s.firstBlock]?.line ?? 0,
  }));
  for (const block of script.blocks) {
    const sec = out[block.section];
    if (!sec || block.type === "separator") continue;
    sec.words += spokenWords(block, p);
    sec.seconds += blockSeconds(block, p);
    if (block.type === "heading") sec.seconds += p.headingPause;
  }
  return out;
}

/** 125 → "2:05"; 3725 → "1:02:05". Rounded to whole seconds. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
