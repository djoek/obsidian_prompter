import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, VOICE_COMMAND, VOICE_URL, looksLikeOurs, migrateSettings } from "../src/settings";

// What 0.4.0 saved, with the defaults of that time.
const OLD = {
  fontSize: 72,
  headingSpeed: 1,
  paragraphSpeed: 1.1,
  eyeLine: 25,
  stopAtSection: true,
  voiceEnabled: true,
  voiceUrl: "ws://127.0.0.1:8765",
  voiceCommand:
    'uvx --from "prompter-voice[parakeet] @ git+https://github.com/djoek/obsidian_prompter#subdirectory=voice" prompter-voice serve',
};

describe("migration from the old 'teleprompter' id", () => {
  test("recognises our old settings, not another plugin's", () => {
    expect(looksLikeOurs(OLD)).toBe(true);
    // A different plugin with the same id: none of our own keys.
    expect(looksLikeOurs({ speed: 18, fontSize: 40, flipX: false })).toBe(false);
    expect(looksLikeOurs(null)).toBe(false);
  });

  test("keeps your values, moves command and address to the new names", () => {
    const m = migrateSettings(OLD);
    expect(m.fontSize).toBe(72);
    expect(m.paragraphSpeed).toBe(1.1);
    expect(m.voiceCommand).toBe(VOICE_COMMAND);
    expect(m.voiceUrl).toBe(VOICE_URL);
  });

  test("a custom command keeps its own options", () => {
    const m = migrateSettings({ voiceCommand: "~/bin/prompter-voice serve --device USB" });
    expect(m.voiceCommand).toBe("~/bin/souffleur-voice serve --device USB");
  });

  test("unknown keys and wrong types are dropped", () => {
    const m = migrateSettings({ fontSize: "huge", speed: 18, wpm: 150 });
    expect(m).toEqual({ wpm: 150 });
  });

  test("the new defaults are already migrated", () => {
    expect(migrateSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});
