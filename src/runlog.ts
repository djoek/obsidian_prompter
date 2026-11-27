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
