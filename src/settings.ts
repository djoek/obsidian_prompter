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
  'uvx --from "prompter-voice[parakeet] @ git+https://github.com/djoek/obsidian_prompter#subdirectory=voice" prompter-voice serve';

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
  voiceUrl: "ws://127.0.0.1:8765",
  voiceDevice: "",
  voiceCommand: VOICE_COMMAND,
};
