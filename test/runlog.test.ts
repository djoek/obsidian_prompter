import { describe, expect, test } from "bun:test";
import { parseScript } from "../src/parser";
import { addRun, runComment } from "../src/runlog";

const at = (h: number, m: number) => new Date(2026, 10, 28, h, m);
const NOTE = `---
tags: [video]
---
# Video 1

Hallo en welkom.

---

# Video 2

Tweede video.
Met twee regels.

---

# Video 3

Laatste.
`;
const runsIn = (text: string) => text.match(/%% run: [^%]*%%/g) ?? [];

describe("run notes", () => {
  test("format", () => {
    expect(runComment(127.4, at(14, 3))).toBe("%% run: 2:07 · 2026-11-28 14:03 %%");
  });

  test("first run: at the end of the section, before its ---", () => {
    const out = addRun(NOTE, 1, 65, at(14, 3), 1);
    expect(out).toContain("Met twee regels.\n\n%% run: 1:05 · 2026-11-28 14:03 %%\n\n---\n\n# Video 3");
  });

  test("the last section gets it at the end of the note", () => {
    const out = addRun(NOTE, 2, 12, at(14, 3), 1);
    expect(out.trimEnd().endsWith("Laatste.\n\n%% run: 0:12 · 2026-11-28 14:03 %%")).toBe(true);
  });

  test("keep 1: each run replaces the previous one", () => {
    const twice = addRun(addRun(NOTE, 1, 65, at(14, 3), 1), 1, 70, at(15, 0), 1);
    expect(runsIn(twice)).toEqual(["%% run: 1:10 · 2026-11-28 15:00 %%"]);
  });

  test("keep 3: oldest first, the oldest drops off", () => {
    let text = NOTE;
    [60, 61, 62, 63].forEach((s, i) => (text = addRun(text, 1, s, at(14, i), 3)));
    expect(runsIn(text)).toEqual([
      "%% run: 1:01 · 2026-11-28 14:01 %%",
      "%% run: 1:02 · 2026-11-28 14:02 %%",
      "%% run: 1:03 · 2026-11-28 14:03 %%",
    ]);
    // Together, still before the section's ---.
    expect(text).toContain("14:03 %%\n\n---\n\n# Video 3");
  });

  test("lowering keep trims the history on the next run", () => {
    let text = NOTE;
    [60, 61, 62].forEach((s, i) => (text = addRun(text, 0, s, at(14, i), 5)));
    text = addRun(text, 0, 70, at(15, 0), 2);
    expect(runsIn(text)).toEqual(["%% run: 1:02 · 2026-11-28 14:02 %%", "%% run: 1:10 · 2026-11-28 15:00 %%"]);
  });

  test("the old '%% last run' line is counted and converted", () => {
    const old = NOTE.replace("Hallo en welkom.", "Hallo en welkom.\n\n%% last run: 0:30 · 2026-11-27 10:00 %%");
    const out = addRun(old, 0, 31, at(14, 0), 2);
    expect(out).not.toContain("last run");
    expect(runsIn(out)).toEqual(["%% run: 0:30 · 2026-11-27 10:00 %%", "%% run: 0:31 · 2026-11-28 14:00 %%"]);
  });

  test("other sections untouched; the prompter shows the same words", () => {
    let text = NOTE;
    for (let i = 0; i < 3; i++) text = addRun(text, i, 5 + i, at(14, i), 9);
    const words = (t: string) => parseScript(t).blocks.map((b) => b.words);
    expect(words(text)).toEqual(words(NOTE));
    expect(runsIn(text)).toHaveLength(3);
  });

  test("keep 0 or an unknown section: unchanged; Windows line ends are kept", () => {
    expect(addRun(NOTE, 0, 5, at(14, 0), 0)).toBe(NOTE);
    expect(addRun(NOTE, 9, 5, at(14, 0), 1)).toBe(NOTE);
    const out = addRun(NOTE.replace(/\n/g, "\r\n"), 0, 5, at(14, 0), 1);
    expect(out.includes("\r\n%% run:")).toBe(true);
    expect(/[^\r]\n/.test(out)).toBe(false);
  });
});
