// Which fonts are installed? Browsers have no API that lists them, so we
// measure: text drawn in "Font X, monospace" has a different width from text
// drawn in plain monospace, unless Font X is missing (then the fallback is
// used and the widths match). We test against two fallbacks, so a font that
// happens to have monospace-like widths is still found.

export interface FontChoice {
  name: string;
  /** Designed for, or commonly recommended for, dyslexic readers. */
  dyslexia: boolean;
}

// Dyslexia-oriented first. OpenDyslexic, Lexend, Atkinson Hyperlegible and
// Andika are free downloads; Verdana, Tahoma, Trebuchet MS and Comic Sans MS
// come with macOS and are named in the British Dyslexia Association's style
// guide among clear sans-serif fonts.
const CANDIDATES: FontChoice[] = [
  { name: "OpenDyslexic", dyslexia: true },
  { name: "OpenDyslexic3", dyslexia: true },
  { name: "Atkinson Hyperlegible Next", dyslexia: true },
  { name: "Atkinson Hyperlegible", dyslexia: true },
  { name: "Lexend", dyslexia: true },
  { name: "Andika", dyslexia: true },
  { name: "Dyslexie", dyslexia: true },
  { name: "Verdana", dyslexia: true },
  { name: "Tahoma", dyslexia: true },
  { name: "Trebuchet MS", dyslexia: true },
  { name: "Comic Sans MS", dyslexia: true },
  { name: "SF Pro Display", dyslexia: false },
  { name: "Helvetica Neue", dyslexia: false },
  { name: "Avenir Next", dyslexia: false },
  { name: "Arial", dyslexia: false },
  { name: "Inter", dyslexia: false },
  { name: "Georgia", dyslexia: false },
  { name: "Menlo", dyslexia: false },
];

const SAMPLE = "mmmmmmmmmmlli1IO0 Wwqgpb";

export function installedFonts(doc: Document = document): FontChoice[] {
  const ctx = doc.createElement("canvas").getContext("2d");
  if (!ctx) return [];
  const width = (font: string) => {
    ctx.font = `72px ${font}`;
    return ctx.measureText(SAMPLE).width;
  };
  const bases = ["monospace", "serif"].map((b) => [b, width(b)] as const);
  return CANDIDATES.filter((f) => bases.some(([b, w]) => width(`"${f.name}", ${b}`) !== w));
}

/** CSS font-family value for a choice, with a sensible fallback. */
export function fontStack(name: string): string {
  return `"${name}", -apple-system, "Helvetica Neue", Arial, sans-serif`;
}

/** The first family name in a CSS font-family list, without quotes. */
export function firstFamily(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}
