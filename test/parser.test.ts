import { describe, expect, test } from "bun:test";
import { blockAtLine, parseInline, parseScript } from "../src/parser";

const SAMPLE = `---
tags: [video]
---
# Video 1: Intro

Hallo en welkom.
Dit is een **tweede** regel.

%% regie: kijk naar camera %%

- punt een
- punt twee

---

## Video 2

> Een citaat
> over twee regels

---
---

Laatste stuk.

---
`;

describe("parseScript", () => {
  const s = parseScript(SAMPLE);

  test("skips frontmatter and splits sections on ---", () => {
    expect(s.sections.length).toBe(3);
    expect(s.sections.map((x) => x.title)).toEqual(["Video 1: Intro", "Video 2", ""]);
  });

  test("block types and order", () => {
    expect(s.blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "separator",
      "heading",
      "quote",
      "separator",
      "paragraph",
    ]);
  });

  test("joins paragraph lines and counts words", () => {
    const p = s.blocks[1]!;
    expect(p.words).toBe(8);
    expect(p.line).toBe(5);
  });

  test("comments are hidden", () => {
    expect(JSON.stringify(s.blocks)).not.toContain("regie");
  });

  test("sections point at their first content block", () => {
    for (const sec of s.sections) {
      expect(s.blocks[sec.firstBlock]!.type).not.toBe("separator");
    }
  });

  test("blockAtLine finds the block under the cursor", () => {
    expect(s.blocks[blockAtLine(s, 12)]!.type).toBe("list");
  });
});

describe("parseInline", () => {
  test("emphasis", () => {
    expect(parseInline("a **b** *c* ==d==")).toEqual([
      { text: "a ", bold: false, italic: false, mark: false, strike: false },
      { text: "b", bold: true, italic: false, mark: false, strike: false },
      { text: " ", bold: false, italic: false, mark: false, strike: false },
      { text: "c", bold: false, italic: true, mark: false, strike: false },
      { text: " ", bold: false, italic: false, mark: false, strike: false },
      { text: "d", bold: false, italic: false, mark: true, strike: false },
    ]);
  });

  test("unmatched markers stay literal", () => {
    expect(parseInline("5 * 3")[0]!.text).toBe("5 * 3");
  });

  test("links and wikilinks become text", () => {
    expect(parseInline("zie [[Notitie|deze notitie]] en [site](https://x.be)")[0]!.text).toBe(
      "zie deze notitie en site",
    );
  });
});
