// Client for the voice process (voice/ in this repo). See voice/src/prompter_voice/server.py
// for the message protocol.

export interface VoiceDevice {
  name: string;
  default: boolean;
}

export type VoiceState = "offline" | "loading" | "ready" | "error";

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
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  private devicesWaiting: ((d: VoiceDevice[]) => void)[] = [];

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

  sendScript(words: string[], word: number): void {
    this.send({ type: "script", words, word });
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
