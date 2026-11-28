import { describe, expect, test } from "bun:test";
import { parseScript } from "../src/parser";
import { addRun, runComment, setSaid } from "../src/runlog";

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

describe("said differently", () => {
  const CHANGES = {
    heard: "Dat liep niet goed, echt",
    marked: "Dat liep ==niet goed==, ==echt== ~~voor 2026.~~",
    changes: [
      { script: "mank", said: "niet goed" },
      { script: "", said: "echt" },
      { script: "voor 2026.", said: "" },
    ],
  };

  test("block after the run lines, before the ---", () => {
    const withRun = addRun(NOTE, 1, 65, at(14, 3), 1);
    const out = setSaid(withRun, 1, CHANGES, at(14, 3));
    expect(out).toContain(
      [
        "%% run: 1:05 · 2026-11-28 14:03 %%",
        "%% said differently (2026-11-28 14:03):",
        "Dat liep ==niet goed==, ==echt== ~~voor 2026.~~",
        "%%",
        "",
        "---",
      ].join("\n"),
    );
  });

  test("replaced on the next run; removed when you read it as written", () => {
    let text = setSaid(NOTE, 0, CHANGES, at(14, 0));
    text = setSaid(text, 0, { heard: "b", marked: "==b==", changes: [{ script: "a", said: "b" }] }, at(15, 0));
    expect(text.match(/said differently/g)).toHaveLength(1);
    expect(text).toContain("\n==b==\n");
    expect(text).not.toContain("niet goed");
    text = setSaid(text, 0, { heard: "as written", marked: "as written", changes: [] }, at(16, 0));
    expect(text).not.toContain("said differently");
  });

  test("a %% in what was heard can't end the comment early", () => {
    const out = setSaid(NOTE, 0, { heard: "", marked: "==50%% korting==", changes: [{ script: "x", said: "y" }] }, at(14, 0));
    expect(out).toContain("\n==50% korting==\n");
  });

  test("the prompter shows the same words", () => {
    const out = setSaid(addRun(NOTE, 2, 9, at(14, 0), 2), 2, CHANGES, at(14, 0));
    const words = (t: string) => parseScript(t).blocks.map((b) => b.words);
    expect(words(out)).toEqual(words(NOTE));
  });
});
