export type Rotation = 0 | 90 | 180 | 270;

export interface PrompterSettings {
  // Typography
  fontFamily: string;
  fontSize: number; // px
  lineHeight: number; // unitless
  letterSpacing: number; // em
  wordSpacing: number; // em
  textWidth: number; // % of the prompter width
  textAlign: "left" | "center";

  // Colours
  textColor: string;
  backgroundColor: string;
  headingColor: string;
  markColor: string;
  eyeLineColor: string;
  nextColor: string;

  // Reading aids
  eyeLine: number; // % from the top where you read
  showEyeLine: boolean;
  dimRead: boolean;
  showHud: boolean;
  nextWords: number; // voice tracking: how many words after the current one stand out

  // Pacing
  wpm: number; // base words per minute
  headingSpeed: number; // multipliers on wpm
  paragraphSpeed: number;
  listSpeed: number;
  quoteSpeed: number;
  headingPause: number; // seconds
  stopAtSection: boolean;

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

  textColor: "#ffffff",
  backgroundColor: "#000000",
  headingColor: "#ffd166",
  markColor: "#ffd166",
  eyeLineColor: "#ff4d4d",
  nextColor: "#7ee8fa",

  eyeLine: 30,
  showEyeLine: true,
  dimRead: true,
  showHud: true,
  nextWords: 4,

  wpm: 140,
  headingSpeed: 1,
  paragraphSpeed: 1,
  listSpeed: 0.9,
  quoteSpeed: 1,
  headingPause: 1,
  stopAtSection: true,

  rotation: 0,
  flipH: false,
  flipV: false,

  voiceEnabled: false,
  language: "",
  voiceUrl: VOICE_URL,
  voiceDevice: "",
  voiceCommand: VOICE_COMMAND,
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
  return out as Partial<PrompterSettings>;
}
