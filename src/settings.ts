import type { Binding } from "./inputs";

export type Rotation = 0 | 90 | 180 | 270;
export type MarginSide = "before" | "after" | "off";
export type SpotlightStyle = "underline" | "colour";

export interface PrompterSettings {
  // Typography
  fontFamily: string;
  fontSize: number; // px
  lineHeight: number; // unitless
  letterSpacing: number; // em
  wordSpacing: number; // em
  textWidth: number; // % of the prompter width
  textAlign: "left" | "center";
  wordsPerLine: number; // 0 = use fontSize; else the size follows the width

  // Colours
  textColor: string;
  backgroundColor: string;
  eyeLineColor: string;
  nextColor: string; // pause helper background
  spotlightColor: string; // voice: the words right after the last one heard
  spotlightStyle: SpotlightStyle; // underline keeps the text's own colours
  heardColor: string; // voice: words just heard, before they dim
  /** Shown but not spoken: unspoken headings, margin notes, separators. */
  unspokenColor: string;

  // Reading aids
  eyeLine: number; // % from the top where you read
  showEyeLine: boolean;
  dimRead: boolean;
  showHud: boolean;
  /** Status bar: time in this section, and how long it normally takes. */
  showSectionTimer: boolean;
  nextWords: number; // voice: spotlight size, the words right after the last heard
  heardHold: number; // voice: seconds heard words keep their colour; 0 = dim at once
  marginNotes: MarginSide; // where ^[notes] appear, as the reader sees it
  marginWidth: number; // % of the text width
  focusBand: number; // lines kept bright from the eye line down; 0 = off
  boldStarts: boolean; // first letters of each word a little bolder
  pauseHint: number; // voice: seconds of silence before the next words light up; 0 = off

  // Pacing
  wpm: number; // base words per minute
  headingSpeed: number; // multipliers on wpm
  paragraphSpeed: number;
  listSpeed: number;
  quoteSpeed: number;
  headingPause: number; // seconds
  speakHeadings: boolean; // headings are read aloud (else they're labels)
  stopAtSection: boolean;
  runsToKeep: number; // voice: how many run times to note per section; 0 = none
  countdown: number; // seconds of 3-2-1 before Play; 0 = none
  smoothStart: number; // seconds to ease up to speed after Play; 0 = instant
  keepAwake: boolean; // keep the screen on while playing or listening

  // Orientation
  rotation: Rotation;
  flipH: boolean;
  flipV: boolean;

  // Voice tracking
  voiceEnabled: boolean;
  /** Default script language (ISO 639-1); "" = let the model decide. A note's
   * frontmatter `language:` overrides it. */
  language: string;
  voiceUrl: string;
  voiceDevice: string; // "" = system default
  voiceCommand: string; // "" = start it yourself

  // Pedals, clickers, MIDI: learned inputs and what they do
  bindings: Binding[];
  midiDevice: string; // "" = all MIDI devices
  midiChannel: number; // 1–16, or 0 = all channels
}

export const VOICE_COMMAND =
  'uvx --from "souffleur-voice[parakeet] @ git+https://github.com/djoek/obsidian-souffleur#subdirectory=voice" souffleur-voice serve';
export const VOICE_URL = "ws://127.0.0.1:8791";

export const DEFAULT_SETTINGS: PrompterSettings = {
  fontFamily: "-apple-system, 'Helvetica Neue', Arial, sans-serif",
  fontSize: 56,
  lineHeight: 1.35,
  letterSpacing: 0,
  wordSpacing: 0,
  textWidth: 90,
  textAlign: "left",
  wordsPerLine: 0,

  textColor: "#ffffff",
  backgroundColor: "#000000",
  eyeLineColor: "#ff4d4d",
  nextColor: "#9be7a0",
  spotlightColor: "#ffffff",
  spotlightStyle: "underline",
  heardColor: "#7ee8fa",
  unspokenColor: "#a99cc9",

  eyeLine: 30,
  showEyeLine: true,
  dimRead: true,
  showHud: true,
  showSectionTimer: true,
  nextWords: 7,
  heardHold: 1.5,
  marginNotes: "before",
  marginWidth: 25,
  focusBand: 0,
  boldStarts: false,
  pauseHint: 0,

  wpm: 140,
  headingSpeed: 1,
  paragraphSpeed: 1,
  listSpeed: 0.9,
  quoteSpeed: 1,
  headingPause: 1,
  speakHeadings: false,
  stopAtSection: true,
  runsToKeep: 1,
  countdown: 3,
  smoothStart: 1,
  keepAwake: true,

  rotation: 0,
  flipH: false,
  flipV: false,

  voiceEnabled: false,
  language: "",
  voiceUrl: VOICE_URL,
  voiceDevice: "",
  voiceCommand: VOICE_COMMAND,

  bindings: [],
  midiDevice: "",
  midiChannel: 0,
};

// ── Migration from the plugin's earlier name ──────────────────────────────
//
// Up to 0.4.0 this plugin was called "teleprompter". That id belongs to
// another plugin (by lumetrium), whose settings may sit in the same folder, so
// only data that is recognisably ours is imported.

/** Settings only this plugin has. */
const OURS = [
  "headingSpeed",
  "paragraphSpeed",
  "listSpeed",
  "quoteSpeed",
  "headingPause",
  "stopAtSection",
  "eyeLine",
  "voiceEnabled",
  "voiceCommand",
] as const;

/** True if `data` looks like this plugin's settings (≥ 3 of our own keys). */
export function looksLikeOurs(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return OURS.filter((k) => k in data).length >= 3;
}

/**
 * Keep known settings with the right type, and update values that changed
 * with the rename: the voice process is now `souffleur-voice`, on port 8791,
 * in the repository djoek/obsidian-souffleur.
 */
export function migrateSettings(data: unknown): Partial<PrompterSettings> {
  if (!data || typeof data !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key in DEFAULT_SETTINGS) {
      const expected = typeof DEFAULT_SETTINGS[key as keyof PrompterSettings];
      if (typeof value === expected) out[key] = value;
    }
  }
  if (typeof out.voiceCommand === "string") {
    out.voiceCommand = out.voiceCommand
      .replace(/prompter-voice/g, "souffleur-voice")
      .replace(/djoek\/obsidian_prompter/g, "djoek/obsidian-souffleur");
  }
  if (out.voiceUrl === "ws://127.0.0.1:8765") out.voiceUrl = VOICE_URL;
  // 0.13–0.15 had an on/off "Note the last run".
  const old = data as { logRuns?: unknown };
  if (typeof old.logRuns === "boolean" && out.runsToKeep === undefined) {
    out.runsToKeep = old.logRuns ? 1 : 0;
  }
  return out as Partial<PrompterSettings>;
}
