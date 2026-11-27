import { describe, expect, test } from "bun:test";
import { blockSeconds, formatDuration, MIN_BLOCK_SECONDS, sectionLengths } from "../src/pacing";
import { parseScript } from "../src/parser";
import { DEFAULT_SETTINGS } from "../src/settings";

// 120 wpm = 2 words per second makes the arithmetic easy to check.
const P = { ...DEFAULT_SETTINGS, wpm: 120, headingSpeed: 1, paragraphSpeed: 1, listSpeed: 1, quoteSpeed: 1, headingPause: 1, speakHeadings: true };

const SCRIPT = parseScript(`# Eerste video

een twee drie vier vijf zes zeven acht negen tien

---

## Tweede

een twee drie vier
`);

describe("pacing", () => {
  test("a block takes its words at your speed", () => {
    const p = SCRIPT.blocks[1]!; // 10 words
    expect(blockSeconds(p, P)).toBe(5);
    expect(blockSeconds(p, { ...P, paragraphSpeed: 2 })).toBe(2.5);
  });

  test("tiny blocks get a minimum", () => {
    expect(blockSeconds({ ...SCRIPT.blocks[1]!, words: 0 }, P)).toBe(MIN_BLOCK_SECONDS);
  });

  test("section lengths include heading pauses, not separators", () => {
    const [a, b] = sectionLengths(SCRIPT, P);
    // "# Eerste video": 2 words = 1 s, + 1 s pause, + paragraph 5 s
    expect(a).toEqual({ title: "Eerste video", words: 12, seconds: 7, line: 0 });
    // "## Tweede": 1 word = 0.5 s, + 1 s pause, + paragraph 2 s
    expect(b?.words).toBe(5);
    expect(b?.seconds).toBeCloseTo(3.5);
    expect(b?.line).toBe(6);
  });

  test("unspoken headings: no words, minimum time, pause stays", () => {
    const [a, b] = sectionLengths(SCRIPT, { ...P, speakHeadings: false });
    // heading 0.4 s minimum + 1 s pause + paragraph 5 s
    expect(a?.words).toBe(10);
    expect(a?.seconds).toBeCloseTo(6.4);
    expect(b?.words).toBe(4);
  });

  test("format", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65.4)).toBe("1:05");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});
