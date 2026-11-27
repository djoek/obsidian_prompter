// "Last run" notes: after a section is read through in voice mode, its
// duration is written as a comment at the end of that section, replacing the
// previous one:
//
//   %% last run: 2:07 · 2026-11-28 14:03 %%
//
// It's an Obsidian comment, so the prompter never shows it and it adds no words.

import { formatDuration } from "./pacing";
import { parseScript } from "./parser";

const RUN_LINE = /^%% last run: .*%%\s*$/;

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}`
  );
}

export function runComment(seconds: number, date: Date): string {
  return `%% last run: ${formatDuration(seconds)} · ${stamp(date)} %%`;
}

/**
 * The note's text with section `section`'s "last run" comment set to this run.
 * An existing one in that section is replaced; otherwise it goes at the end of
 * the section (before its `---`, after the last text). Returns the text
 * unchanged if the section doesn't exist.
 */
export function setRunComment(text: string, section: number, seconds: number, date: Date): string {
  const script = parseScript(text);
  const sec = script.sections[section];
  if (!sec) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const start = script.blocks[sec.firstBlock]?.line ?? 0;
  // The `---` that ends this section, if any (separator blocks start each
  // following section).
  const separator = script.blocks.find((b) => b.type === "separator" && b.section === section + 1);
  const end = separator ? separator.line : lines.length;
  const comment = runComment(seconds, date);

  for (let i = start; i < end; i++) {
    if (RUN_LINE.test(lines[i] ?? "")) {
      lines[i] = comment;
      return lines.join(eol);
    }
  }

  // Insert after the section's last non-empty line, with a blank line before.
  let at = end;
  while (at > start && (lines[at - 1] ?? "").trim() === "") at--;
  const insert = ["", comment];
  if (separator && (lines[at] ?? "").trim() !== "") insert.push(""); // keep `---` apart
  lines.splice(at, 0, ...insert);
  return lines.join(eol);
}
