import { describe, expect, test } from "bun:test";
import { actionsFor, cleanBindings, describeInput, keyInput, midiInput } from "../src/inputs";

describe("MIDI messages", () => {
  test("Note On is a press, Note Off and velocity 0 are not", () => {
    const cc = new Map<number, number>();
    expect(midiInput([0x90, 60, 100], cc)).toBe("midi:note:60");
    expect(midiInput([0x93, 60, 100], cc)).toBe("midi:note:60"); // any channel
    expect(midiInput([0x90, 60, 0], cc)).toBeNull();
    expect(midiInput([0x80, 60, 64], cc)).toBeNull();
  });

  test("a sustain pedal counts once per press", () => {
    const cc = new Map<number, number>();
    const presses = [127, 0, 127, 127, 0].map((v) => midiInput([0xb0, 64, v], cc));
    expect(presses).toEqual(["midi:cc:64", null, "midi:cc:64", null, null]);
  });

  test("a continuous controller counts when it rises past halfway", () => {
    const cc = new Map<number, number>();
    const seen = [10, 40, 63, 64, 90, 30, 70].map((v) => midiInput([0xb0, 11, v], cc));
    expect(seen).toEqual([null, null, null, "midi:cc:11", null, null, "midi:cc:11"]);
  });

  test("program change", () => {
    expect(midiInput([0xc0, 3], new Map())).toBe("midi:pc:3");
  });
});

describe("keys", () => {
  test("by physical key; modifiers alone can't be bound", () => {
    expect(keyInput({ code: "PageDown" } as KeyboardEvent)).toBe("key:PageDown");
    expect(keyInput({ code: "ShiftLeft" } as KeyboardEvent)).toBeNull();
    expect(keyInput({ code: "" } as KeyboardEvent)).toBeNull();
  });
});

describe("names and bindings", () => {
  test("readable names", () => {
    expect(describeInput("key:KeyB")).toBe("Key B");
    expect(describeInput("key:Digit3")).toBe("Key 3");
    expect(describeInput("key:ArrowDown")).toBe("Key Arrow Down");
    expect(describeInput("key:PageDown")).toBe("Key PageDown");
    expect(describeInput("midi:cc:64")).toBe("MIDI CC 64 (sustain)");
    expect(describeInput("midi:note:60")).toBe("MIDI note 60");
  });

  test("saved bindings are checked; one input can drive several actions", () => {
    const b = cleanBindings([
      { action: "toggle", input: "midi:cc:64" },
      { action: "next", input: "key:PageDown" },
      { action: "fly", input: "key:KeyF" },
      { action: "prev", input: "rm -rf" },
      null,
      { action: "resetVoice", input: "midi:cc:64" },
    ]);
    expect(b).toHaveLength(3);
    expect(actionsFor(b, "midi:cc:64")).toEqual(["toggle", "resetVoice"]);
    expect(cleanBindings("nope")).toEqual([]);
  });
});

describe("Midi (with a fake device)", () => {
  test("hears presses from devices, also ones plugged in later; stops cleanly", async () => {
    const { Midi } = await import("../src/inputs");
    type Port = { name: string; onmidimessage: ((e: { data: Uint8Array }) => void) | null };
    const inputs = new Map<string, Port>([["a", { name: "Foot switch", onmidimessage: null }]]);
    const access = { inputs, onstatechange: null as null | (() => void) };
    const nav = globalThis.navigator as unknown as { requestMIDIAccess?: () => Promise<unknown> };
    const before = nav.requestMIDIAccess;
    nav.requestMIDIAccess = async () => access;
    try {
      const midi = new Midi();
      const heard: string[] = [];
      midi.on((id) => heard.push(id));
      expect(await midi.start()).toBe(true);
      expect(midi.devices()).toEqual(["Foot switch"]);

      inputs.get("a")!.onmidimessage!({ data: new Uint8Array([0xb0, 64, 127]) });
      inputs.get("a")!.onmidimessage!({ data: new Uint8Array([0xb0, 64, 0]) });
      // A second device is plugged in.
      inputs.set("b", { name: "Pads", onmidimessage: null });
      access.onstatechange!();
      inputs.get("b")!.onmidimessage!({ data: new Uint8Array([0x99, 36, 90]) });
      expect(heard).toEqual(["midi:cc:64", "midi:note:36"]);

      midi.stop();
      expect(inputs.get("a")!.onmidimessage).toBeNull();
      expect(midi.running).toBe(false);
    } finally {
      nav.requestMIDIAccess = before;
    }
  });

  test("no MIDI support: a clear message instead of a crash", async () => {
    const { Midi } = await import("../src/inputs");
    const nav = globalThis.navigator as unknown as { requestMIDIAccess?: unknown };
    const before = nav.requestMIDIAccess;
    nav.requestMIDIAccess = undefined;
    try {
      const midi = new Midi();
      expect(await midi.start()).toBe(false);
      expect(midi.error).toContain("no MIDI support");
    } finally {
      nav.requestMIDIAccess = before;
    }
  });
});
