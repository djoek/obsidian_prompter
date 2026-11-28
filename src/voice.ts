// Client for the voice process (voice/ in this repo). See voice/src/prompter_voice/server.py
// for the message protocol.

import type { Said } from "./runlog";

export interface VoiceDevice {
  name: string;
  default: boolean;
}

export type VoiceState = "offline" | "downloading" | "loading" | "ready" | "error";

export interface Download {
  done: number;
  total: number;
}

export interface VoiceEvents {
  onConnect?: () => void;
  onState?: (state: VoiceState, detail: string) => void;
  onPosition?: (word: number) => void;
  onHeard?: (text: string) => void;
  onLevel?: (rms: number) => void;
}

const RETRY_MS = 2000;

export class VoiceClient {
  state: VoiceState = "offline";
  device = "";
  /** Model download progress; null when not downloading. */
  download: Download | null = null;
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  private devicesWaiting: ((d: VoiceDevice[]) => void)[] = [];
  private saidWaiting = new Map<number, (s: Said | null) => void>();

  constructor(
    private url: string,
    private events: VoiceEvents,
  ) {
    this.connect();
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  private connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.events.onConnect?.();
    ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)));
    ws.onclose = () => {
      this.ws = null;
      this.download = null;
      this.setState("offline", "");
      this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    window.clearTimeout(this.retry);
    this.retry = window.setTimeout(() => this.connect(), RETRY_MS);
  }

  private setState(state: VoiceState, detail: string): void {
    this.state = state;
    this.events.onState?.(state, detail);
  }

  private receive(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "status":
        this.device = String(msg.device ?? "");
        this.download = (msg.progress as Download | null) ?? null;
        this.setState(
          msg.state as VoiceState,
          msg.state === "error" ? String(msg.error ?? "") : this.device,
        );
        break;
      case "position":
        this.events.onPosition?.(Number(msg.word));
        break;
      case "heard":
        this.events.onHeard?.(String(msg.text ?? ""));
        break;
      case "level":
        this.events.onLevel?.(Number(msg.rms));
        break;
      case "said": {
        const resolve = this.saidWaiting.get(Number(msg.section));
        this.saidWaiting.delete(Number(msg.section));
        const changes = msg.changes as Said["changes"] | null;
        resolve?.(changes ? { heard: String(msg.heard ?? ""), changes } : null);
        break;
      }
      case "devices": {
        const list = (msg.devices as VoiceDevice[]) ?? [];
        this.devicesWaiting.splice(0).forEach((resolve) => resolve(list));
        break;
      }
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** `language`: ISO 639-1 code, or null to let the model decide.
   * `sections`: the word each section starts at. */
  sendScript(words: string[], word: number, language: string | null, sections: number[]): void {
    this.send({ type: "script", words, word, language, sections });
  }

  /** How what you said differs from words `from`..`to` of section `section`;
   * null if it can't tell (not connected, or the section wasn't found). */
  said(section: number, from: number, to: number): Promise<Said | null> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.saidWaiting.set(section, resolve);
      this.send({ type: "said", section, from, to });
      window.setTimeout(() => {
        if (this.saidWaiting.get(section) === resolve) {
          this.saidWaiting.delete(section);
          resolve(null);
        }
      }, 5000);
    });
  }

  /** Paused (false): the voice process stops recognising until resumed. */
  setListening(on: boolean): void {
    this.send({ type: "listen", on });
  }

  /** Forget what was heard and start recognition afresh; keeps your place. */
  reset(): void {
    this.send({ type: "reset" });
  }

  seek(word: number): void {
    this.send({ type: "seek", word });
  }

  setDevice(name: string): void {
    this.send({ type: "device", name: name || null });
  }

  /** Resolves with the microphone list, or [] if the process doesn't answer. */
  devices(): Promise<VoiceDevice[]> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.devicesWaiting.push(resolve);
      this.send({ type: "devices" });
      window.setTimeout(() => resolve([]), 3000);
    });
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.retry);
    this.ws?.close();
  }
}
