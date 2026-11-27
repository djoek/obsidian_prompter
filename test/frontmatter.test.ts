import { describe, expect, test } from "bun:test";
import { noteOverrides, normalizeLanguage } from "../src/frontmatter";

describe("normalizeLanguage", () => {
  test.each([
    ["nl", "nl"],
    ["NL", "nl"],
    ["nl-BE", "nl"],
    ["nl_NL", "nl"],
    ["Nederlands", "nl"],
    ["Dutch", "nl"],
    ["Vlaams", "nl"],
    ["Français", "fr"],
    ["auto", null],
    ["", null],
    ["Klingon", null],
    [42, null],
  ])("%p → %p", (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });
});

describe("noteOverrides", () => {
  test("nothing in, nothing out", () => {
    expect(noteOverrides(undefined)).toEqual({ settings: {}, language: null, problems: [] });
    expect(noteOverrides({ tags: ["video"] }).problems).toEqual([]);
  });

  test("top-level language and lang", () => {
    expect(noteOverrides({ language: "nl" }).language).toBe("nl");
    expect(noteOverrides({ lang: "English" }).language).toBe("en");
    expect(noteOverrides({ souffleur: { language: "de" } }).language).toBe("de");
  });

  test("valid settings are applied", () => {
    const o = noteOverrides({
      souffleur: { fontSize: 64, flipH: true, rotation: 180, textAlign: "center" },
    });
    expect(o.settings).toEqual({ fontSize: 64, flipH: true, rotation: 180, textAlign: "center" });
    expect(o.problems).toEqual([]);
  });

  test("wrong values are skipped and reported, never applied", () => {
    const o = noteOverrides({
      language: "Klingon",
      souffleur: {
        fontSize: "big",
        rotation: 45,
        colour: "red",
        voiceCommand: "rm -rf /",
        wpm: 150,
      },
    });
    expect(o.settings).toEqual({ wpm: 150 });
    expect(o.language).toBeNull();
    expect(o.problems).toHaveLength(5);
  });

  test("a souffleur: that isn't a block is reported", () => {
    expect(noteOverrides({ souffleur: "yes" }).problems).toHaveLength(1);
  });
});
