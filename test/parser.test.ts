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

describe("margin notes", () => {
  const SRC = `# Intro^[kijk in de lens]

Dat was het^[glimlach] voor vandaag.
Ik werk met Nvidia[^nv] kaarten.

^[pauze]

Een [^onbekend] verwijzing.

[^nv]: en-VID-ee-uh, **niet** nie-VIE-dia
    met een tweede regel
`;
  const s = parseScript(SRC);
  const notes = (i: number) => s.blocks[i]!.runs.filter((r) => r.note).map((r) => r.note);
  const text = (i: number) => s.blocks[i]!.runs.map((r) => r.text).join("");

  test("inline and reference notes become note runs, in place", () => {
    expect(notes(0)).toEqual(["kijk in de lens"]);
    expect(notes(1)).toEqual(["glimlach", "en-VID-ee-uh, niet nie-VIE-dia met een tweede regel"]);
    expect(text(1)).toBe("Dat was het voor vandaag. Ik werk met Nvidia kaarten.");
    const runs = s.blocks[1]!.runs;
    expect(runs[1]).toMatchObject({ text: "", note: "glimlach" }); // right after "het"
  });

  test("notes are not words", () => {
    expect(s.blocks[0]!.words).toBe(1);
    expect(s.blocks[1]!.words).toBe(10);
  });

  test("a note on its own line is kept, with no words", () => {
    expect(notes(2)).toEqual(["pauze"]);
    expect(s.blocks[2]!.words).toBe(0);
  });

  test("unknown references vanish; definitions are not shown", () => {
    expect(text(3)).toBe("Een  verwijzing.");
    expect(s.blocks).toHaveLength(4);
    expect(JSON.stringify(s.blocks)).not.toContain("[^");
  });

  test("the section title has no note in it", () => {
    expect(s.sections[0]!.title).toBe("Intro");
  });
});
