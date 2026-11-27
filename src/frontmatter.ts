// Per-note overrides from frontmatter. No Obsidian imports, so it is testable.
//
//   ---
//   language: nl            # or lang:, a code (nl, nl-BE) or a name (Nederlands)
//   souffleur:              # optional; any setting, by its name
//     fontSize: 64
//     wpm: 150
//     flipH: true
//   ---

import { DEFAULT_SETTINGS, type PrompterSettings } from "./settings";

/** Machine-wide settings: a note can't change these. */
const NOT_PER_NOTE = new Set<keyof PrompterSettings>([
  "voiceEnabled",
  "voiceUrl",
  "voiceDevice",
  "voiceCommand",
]);

/** Settings that only accept a few values. */
const CHOICES: Partial<Record<keyof PrompterSettings, readonly unknown[]>> = {
  rotation: [0, 90, 180, 270],
  textAlign: ["left", "center"],
};

// Language names (English, Dutch, native) for the languages the speech models
// support, mapped to ISO 639-1 codes. Codes themselves are handled separately.
const LANGUAGE_NAMES: Record<string, string> = {
  dutch: "nl", nederlands: "nl", vlaams: "nl", flemish: "nl",
  english: "en", engels: "en",
  french: "fr", frans: "fr", français: "fr", francais: "fr",
  german: "de", duits: "de", deutsch: "de",
  spanish: "es", spaans: "es", español: "es", espanol: "es",
  italian: "it", italiaans: "it", italiano: "it",
  portuguese: "pt", portugees: "pt", português: "pt", portugues: "pt",
  danish: "da", deens: "da", dansk: "da",
  swedish: "sv", zweeds: "sv", svenska: "sv",
  finnish: "fi", fins: "fi", suomi: "fi",
  polish: "pl", pools: "pl", polski: "pl",
  czech: "cs", tsjechisch: "cs",
  greek: "el", grieks: "el",
  russian: "ru", russisch: "ru",
  ukrainian: "uk", oekraïens: "uk",
};

/** "nl", "nl-BE", "NL_be", "Nederlands", "Dutch" → "nl". Unknown → null. */
export function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "auto") return null;
  const name = LANGUAGE_NAMES[v];
  if (name) return name;
  const code = v.match(/^([a-z]{2})(?:[-_][a-z]{2})?$/);
  return code ? code[1]! : null;
}

export interface NoteOverrides {
  settings: Partial<PrompterSettings>;
  /** ISO 639-1 code, or null when the note doesn't say. */
  language: string | null;
  /** Human-readable reasons for keys that were ignored. */
  problems: string[];
}

export function noteOverrides(frontmatter: unknown): NoteOverrides {
  const result: NoteOverrides = { settings: {}, language: null, problems: [] };
  if (!frontmatter || typeof frontmatter !== "object") return result;
  const fm = frontmatter as Record<string, unknown>;

  const block = fm.souffleur;
  if (block !== undefined && (typeof block !== "object" || block === null || Array.isArray(block))) {
    result.problems.push("souffleur: should be a block of settings");
  }
  const entries = block && typeof block === "object" ? Object.entries(block) : [];

  const rawLanguage =
    fm.language ?? fm.lang ?? (block as Record<string, unknown> | undefined)?.language;
  if (rawLanguage !== undefined) {
    result.language = normalizeLanguage(rawLanguage);
    if (result.language === null && String(rawLanguage).trim().toLowerCase() !== "auto") {
      result.problems.push(`language: "${String(rawLanguage)}" is not a language I know`);
    }
  }

  const settings: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (key === "language") continue;
    if (!(key in DEFAULT_SETTINGS)) {
      result.problems.push(`souffleur.${key}: no such setting`);
      continue;
    }
    const k = key as keyof PrompterSettings;
    if (NOT_PER_NOTE.has(k)) {
      result.problems.push(`souffleur.${key}: can only be set in the plugin settings`);
      continue;
    }
    const expected = typeof DEFAULT_SETTINGS[k];
    if (typeof value !== expected) {
      result.problems.push(`souffleur.${key}: should be a ${expected}`);
      continue;
    }
    const choices = CHOICES[k];
    if (choices && !choices.includes(value)) {
      result.problems.push(`souffleur.${key}: should be one of ${choices.join(", ")}`);
      continue;
    }
    settings[key] = value;
  }
  result.settings = settings as Partial<PrompterSettings>;
  return result;
}
