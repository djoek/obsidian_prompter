// Lifecycle hooks: a shell command per moment, so people can connect other
// tools (OBS, a recorder, chapter markers) without Souffleur knowing them.
// The command gets what happened as SOUFFLEUR_* environment variables.
// Hooks are machine-wide: a note's frontmatter can never set them.

export type HookEvent = "open" | "play" | "pause" | "section" | "sectionDone" | "close";

export const HOOKS: { id: HookEvent; name: string; when: string }[] = [
  { id: "open", name: "Open", when: "The prompter opens a note." },
  { id: "play", name: "Play", when: "Play is pressed, or listening resumes in voice mode." },
  { id: "pause", name: "Pause", when: "Paused (Space, Esc, or the end of the script)." },
  { id: "section", name: "Section", when: "A section starts: scrolled or jumped into, a retake, or by voice." },
  {
    id: "sectionDone",
    name: "Section done",
    when: "Voice mode: a section was read to its end. Adds SOUFFLEUR_SECONDS and SOUFFLEUR_WPM.",
  },
  { id: "close", name: "Close", when: "The prompter is closed." },
];

export type Hooks = Record<HookEvent, string>;

export const NO_HOOKS: Hooks = { open: "", play: "", pause: "", section: "", sectionDone: "", close: "" };

/** Saved hooks, keeping only known events with string commands. */
export function cleanHooks(value: unknown): Hooks {
  const out = { ...NO_HOOKS };
  if (value && typeof value === "object") {
    for (const { id } of HOOKS) {
      const v = (value as Record<string, unknown>)[id];
      if (typeof v === "string") out[id] = v;
    }
  }
  return out;
}

export interface HookContext {
  /** Full path of the note on disk (or its vault path if unknown). */
  note: string;
  /** 0-based section index, -1 if none. */
  section: number;
  sectionTitle: string;
  mode: "speed" | "voice";
  seconds?: number;
  wpm?: number;
}

/** The environment variables a hook command gets. Sections count from 1. */
export function hookEnv(event: HookEvent, ctx: HookContext): Record<string, string> {
  const env: Record<string, string> = {
    SOUFFLEUR_EVENT: event,
    SOUFFLEUR_NOTE: ctx.note,
    SOUFFLEUR_SECTION: ctx.section >= 0 ? String(ctx.section + 1) : "",
    SOUFFLEUR_SECTION_TITLE: ctx.sectionTitle,
    SOUFFLEUR_MODE: ctx.mode,
  };
  if (ctx.seconds !== undefined) env.SOUFFLEUR_SECONDS = String(Math.round(ctx.seconds));
  if (ctx.wpm !== undefined) env.SOUFFLEUR_WPM = String(Math.round(ctx.wpm));
  return env;
}
