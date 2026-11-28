// Run notes: after a section is read through in voice mode, its duration is
// written as a comment at the end of that section. The last `keep` runs stay,
// oldest first, newest last:
//
//   %% run: 2:15 · 2026-11-28 14:03 %%
//   %% run: 2:07 · 2026-11-28 14:20 %%
//
// They're Obsidian comments, so the prompter never shows them and they add no
// words. Lines in the earlier "%% last run: … %%" form are recognised too.

import { formatDuration } from "./pacing";
import { parseScript } from "./parser";

const RUN_LINE = /^%% (?:last )?run: .*%%\s*$/;

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}`
  );
}

export function runComment(seconds: number, date: Date): string {
  return `%% run: ${formatDuration(seconds)} · ${stamp(date)} %%`;
}

/**
 * The note's text with this run added to section `section`'s run lines,
 * keeping the last `keep` (1–9). The lines sit together at the end of the
 * section (before its `---`, after the last text), where any existing ones
 * were. Returns the text unchanged if the section doesn't exist or `keep` < 1.
 */
export function addRun(text: string, section: number, seconds: number, date: Date, keep: number): string {
  const script = parseScript(text);
  const sec = script.sections[section];
  if (!sec || keep < 1) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const start = script.blocks[sec.firstBlock]?.line ?? 0;
  // The `---` that ends this section, if any (separator blocks start each
  // following section).
  const separator = script.blocks.find((b) => b.type === "separator" && b.section === section + 1);
  const end = separator ? separator.line : lines.length;

  // Existing run lines, in order; they're rewritten in the old form's place.
  const found: number[] = [];
  for (let i = start; i < end; i++) if (RUN_LINE.test(lines[i] ?? "")) found.push(i);
  const runs = found.map((i) => (lines[i] ?? "").replace(/^%% last run:/, "%% run:"));
  runs.push(runComment(seconds, date));
  const kept = runs.slice(-keep);

  if (found.length) {
    const at = found[0]!;
    for (const i of [...found].reverse()) lines.splice(i, 1);
    lines.splice(at, 0, ...kept);
    return lines.join(eol);
  }

  // First run: after the section's last non-empty line, with a blank line before.
  let at = end;
  while (at > start && (lines[at - 1] ?? "").trim() === "") at--;
  const insert = ["", ...kept];
  if (separator && (lines[at] ?? "").trim() !== "") insert.push(""); // keep `---` apart
  lines.splice(at, 0, ...insert);
  return lines.join(eol);
}

// ── "Said differently" ────────────────────────────────────────────────────
//
//   %% said differently (2026-11-28 14:03):
//   Ik heb een manager … over hoe het proces ==niet goed== liep. Een ruwe
//   ==schatting== werd genoemd en het moest opgelost zijn ~~voor 2026.~~
//   %%
//
// The text is what the speech model heard; ==marked== where you said
// something else than the script, ~~struck~~ where you left words out.
//
// One block per section, after its run lines; replaced on each run, removed
// when a run matched the script.

export interface SaidChange {
  script: string;
  said: string;
}

/** From the voice process: what it heard for the section, and the differences. */
export interface Said {
  heard: string;
  changes: SaidChange[];
  /** The heard text with ==differences== and ~~skipped words~~ marked. */
  marked: string;
}

const SAID_START = /^%% said differently\b.*$/;

export function saidBlock({ heard, marked }: Said, date: Date): string[] {
  // "%%" inside the text would end the comment early.
  const text = (marked || heard).replace(/%%/g, "%");
  return [`%% said differently (${stamp(date)}):`, text, "%%"];
}

/** Section `section`'s block set to this run's; removed if nothing differed. */
export function setSaid(text: string, section: number, said: Said, date: Date): string {
  const { changes } = said;
  const script = parseScript(text);
  const sec = script.sections[section];
  if (!sec) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const start = script.blocks[sec.firstBlock]?.line ?? 0;
  const separator = script.blocks.find((b) => b.type === "separator" && b.section === section + 1);
  let end = separator ? separator.line : lines.length;

  // Remove an earlier block (from its first line to the closing %%).
  for (let i = start; i < end; i++) {
    if (!SAID_START.test(lines[i] ?? "")) continue;
    let j = i + 1;
    while (j < end && (lines[j] ?? "").trim() !== "%%") j++;
    const count = Math.min(j, end - 1) - i + 1;
    lines.splice(i, count);
    end -= count;
    break;
  }
  if (!changes.length) return lines.join(eol);

  // After the last run line if there is one, else after the section's text.
  let at = end;
  for (let i = end - 1; i >= start; i--) {
    if (RUN_LINE.test(lines[i] ?? "")) {
      at = i + 1;
      break;
    }
  }
  if (at === end) while (at > start && (lines[at - 1] ?? "").trim() === "") at--;
  const block = saidBlock(said, date);
  const insert = (lines[at - 1] ?? "").trim() !== "" && !RUN_LINE.test(lines[at - 1] ?? "") ? ["", ...block] : block;
  if (separator && (lines[at] ?? "").trim() !== "") insert.push("");
  lines.splice(at, 0, ...insert);
  return lines.join(eol);
}
