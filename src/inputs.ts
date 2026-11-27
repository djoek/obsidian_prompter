// Pedals, clickers and MIDI controllers: learn any input, bind it to an action.
//
// An input is a string id:
//   "key:KeyB"        a keyboard key (pedals and clickers act as keyboards),
//                     by KeyboardEvent.code, so it doesn't depend on layout
//   "midi:note:64"    MIDI Note On, any channel
//   "midi:cc:64"      MIDI Control Change, counted when it rises past 64
//   "midi:pc:3"       MIDI Program Change
//
// Keys work while the prompter window has focus. MIDI works regardless of
// focus: handy for a foot switch while you look at the camera.

export type Action =
  | "toggle"
  | "next"
  | "prev"
  | "faster"
  | "slower"
  | "lineDown"
  | "lineUp"
  | "resetVoice";

export const ACTIONS: { id: Action; name: string }[] = [
  { id: "toggle", name: "Play / pause" },
  { id: "next", name: "Next section" },
  { id: "prev", name: "Previous section / retake" },
  { id: "faster", name: "Faster" },
  { id: "slower", name: "Slower" },
  { id: "lineDown", name: "One line down" },
  { id: "lineUp", name: "One line up" },
  { id: "resetVoice", name: "Reset voice matching" },
];

export interface Binding {
  action: Action;
  input: string;
}

const ACTION_IDS = new Set<string>(ACTIONS.map((a) => a.id));
const INPUT_ID = /^(key:[A-Za-z0-9]+|midi:(note|cc|pc):\d{1,3})$/;

/** Keep only well-formed bindings (saved data is not trusted blindly). */
export function cleanBindings(value: unknown): Binding[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (b): b is Binding =>
      !!b &&
      typeof b === "object" &&
      ACTION_IDS.has((b as Binding).action) &&
      typeof (b as Binding).input === "string" &&
      INPUT_ID.test((b as Binding).input),
  );
}

export function keyInput(e: KeyboardEvent): string | null {
  // Modifier keys alone, and unidentified keys, can't be bound.
  if (!e.code || /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(e.code)) return null;
  return `key:${e.code}`;
}

/**
 * Turn a raw MIDI message into an input id when it is a "press", else null.
 * `cc` remembers the last value per controller, to see a CC rise past 64
 * once (a sustain pedal sends one message down and one up).
 */
export function midiInput(data: ArrayLike<number>, cc: Map<number, number>): string | null {
  const status = data[0] ?? 0;
  const kind = status & 0xf0;
  const a = data[1] ?? 0;
  const b = data[2] ?? 0;
  switch (kind) {
    case 0x90: // Note On; velocity 0 means Note Off
      return b > 0 ? `midi:note:${a}` : null;
    case 0xb0: {
      const before = cc.get(a) ?? 0;
      cc.set(a, b);
      return before < 64 && b >= 64 ? `midi:cc:${a}` : null;
    }
    case 0xc0:
      return `midi:pc:${a}`;
    default:
      return null;
  }
}

const CC_NAMES: Record<number, string> = { 64: "sustain", 65: "portamento", 66: "sostenuto", 67: "soft" };

/** "Key B", "MIDI note 64", "MIDI CC 64 (sustain)", "MIDI program 3". */
export function describeInput(id: string): string {
  const [kind, a, b] = id.split(":");
  if (kind === "key" && a) {
    return "Key " + a.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit/, "").replace(/^Arrow/, "Arrow ");
  }
  if (kind === "midi" && b !== undefined) {
    const n = Number(b);
    if (a === "note") return `MIDI note ${n}`;
    if (a === "cc") return `MIDI CC ${n}` + (CC_NAMES[n] ? ` (${CC_NAMES[n]})` : "");
    if (a === "pc") return `MIDI program ${n}`;
  }
  return id;
}

export function actionsFor(bindings: Binding[], input: string): Action[] {
  return bindings.filter((b) => b.input === input).map((b) => b.action);
}

// ── MIDI access (browser) ─────────────────────────────────────────────────

/**
 * Listens to every MIDI input, including ones plugged in later. `onInput`
 * gets the input id of each press.
 */
export class Midi {
  private access: MIDIAccess | null = null;
  private cc = new Map<number, number>();
  private listeners = new Set<(input: string) => void>();
  error = "";

  async start(): Promise<boolean> {
    if (this.access) return true;
    if (!navigator.requestMIDIAccess) {
      this.error = "This version of Obsidian has no MIDI support.";
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess();
    } catch (e) {
      this.error = `MIDI was refused: ${e instanceof Error ? e.message : String(e)}`;
      return false;
    }
    this.error = "";
    this.attachAll();
    this.access.onstatechange = () => this.attachAll();
    return true;
  }

  stop(): void {
    if (!this.access) return;
    this.access.onstatechange = null;
    for (const input of this.access.inputs.values()) input.onmidimessage = null;
    this.access = null;
  }

  get running(): boolean {
    return this.access !== null;
  }

  /** Names of the connected MIDI inputs. */
  devices(): string[] {
    return this.access ? [...this.access.inputs.values()].map((i) => i.name ?? "MIDI input") : [];
  }

  on(fn: (input: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private attachAll(): void {
    for (const input of this.access?.inputs.values() ?? []) {
      input.onmidimessage = (e) => {
        if (!e.data) return;
        const id = midiInput(e.data, this.cc);
        if (id) this.listeners.forEach((fn) => fn(id));
      };
    }
  }
}
