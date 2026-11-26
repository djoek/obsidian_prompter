export type Rotation = 0 | 90 | 180 | 270;

export interface PrompterSettings {
  // Typography
  fontFamily: string;
  fontSize: number; // px
  lineHeight: number; // unitless
  textWidth: number; // % of the prompter width
  textAlign: "left" | "center";

  // Colours
  textColor: string;
  backgroundColor: string;
  headingColor: string;
  markColor: string;
  eyeLineColor: string;

  // Reading aids
  eyeLine: number; // % from the top where you read
  showEyeLine: boolean;
  dimRead: boolean;
  showHud: boolean;

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
}

export const DEFAULT_SETTINGS: PrompterSettings = {
  fontFamily: "-apple-system, 'Helvetica Neue', Arial, sans-serif",
  fontSize: 56,
  lineHeight: 1.35,
  textWidth: 90,
  textAlign: "left",

  textColor: "#ffffff",
  backgroundColor: "#000000",
  headingColor: "#ffd166",
  markColor: "#ffd166",
  eyeLineColor: "#ff4d4d",

  eyeLine: 30,
  showEyeLine: true,
  dimRead: true,
  showHud: true,

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
};
