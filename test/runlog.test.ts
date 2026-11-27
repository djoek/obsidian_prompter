import { describe, expect, test } from "bun:test";
import { parseScript } from "../src/parser";
import { runComment, setRunComment } from "../src/runlog";

const WHEN = new Date(2026, 10, 28, 14, 3);
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

describe("last run comments", () => {
  test("format", () => {
    expect(runComment(127.4, WHEN)).toBe("%% last run: 2:07 · 2026-11-28 14:03 %%");
  });

  test("inserted at the end of the section, before its ---", () => {
    const out = setRunComment(NOTE, 1, 65, WHEN);
    expect(out).toContain("Met twee regels.\n\n%% last run: 1:05 · 2026-11-28 14:03 %%\n\n---\n\n# Video 3");
  });

  test("the last section gets it at the end of the note", () => {
    const out = setRunComment(NOTE, 2, 12, WHEN);
    expect(out.trimEnd().endsWith("Laatste.\n\n%% last run: 0:12 · 2026-11-28 14:03 %%")).toBe(true);
  });

  test("a second run replaces the first; other sections are untouched", () => {
    const once = setRunComment(NOTE, 1, 65, WHEN);
    const twice = setRunComment(once, 1, 70, new Date(2026, 10, 28, 15, 0));
    expect(twice.match(/last run/g)).toHaveLength(1);
    expect(twice).toContain("%% last run: 1:10 · 2026-11-28 15:00 %%");
    const both = setRunComment(twice, 0, 5, WHEN);
    expect(both.match(/last run/g)).toHaveLength(2);
  });

  test("the comment changes nothing the prompter shows", () => {
    const out = setRunComment(setRunComment(NOTE, 0, 5, WHEN), 2, 9, WHEN);
    const words = (t: string) => parseScript(t).blocks.map((b) => b.words);
    expect(words(out)).toEqual(words(NOTE));
    expect(parseScript(out).sections).toHaveLength(3);
  });

  test("unknown section: unchanged; Windows line ends are kept", () => {
    expect(setRunComment(NOTE, 9, 5, WHEN)).toBe(NOTE);
    const crlf = NOTE.replace(/\n/g, "\r\n");
    const out = setRunComment(crlf, 0, 5, WHEN);
    expect(out.includes("\r\n%% last run")).toBe(true);
    expect(/[^\r]\n/.test(out)).toBe(false);
  });
});
