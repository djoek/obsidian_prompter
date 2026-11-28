// A stand-in for the parts of Obsidian's API the settings page uses, so the
// real settings code can be rendered and tested in a browser. Not shipped.

type Attrs = { cls?: string; text?: string; attr?: Record<string, string> };
declare global {
  interface HTMLElement {
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: Attrs): HTMLElementTagNameMap[K];
    createDiv(o?: Attrs): HTMLDivElement;
    empty(): void;
    addClass(c: string): void;
    toggleClass(c: string, on: boolean): void;
    setText(t: string): void;
    doc: Document;
    win: Window;
  }
}
const P = HTMLElement.prototype as HTMLElement;
P.createEl = function (tag, o = {}) {
  const e = document.createElement(tag);
  if (o.cls) e.className = o.cls;
  if (o.text) e.textContent = o.text;
  for (const [k, v] of Object.entries(o.attr ?? {})) e.setAttribute(k, v);
  this.append(e);
  return e;
};
P.createDiv = function (o) { return this.createEl("div", o); };
P.empty = function () { this.replaceChildren(); };
P.addClass = function (c) { this.classList.add(c); };
P.toggleClass = function (c, on) { this.classList.toggle(c, on); };
P.setText = function (t) { this.textContent = t; };
Object.defineProperty(P, "doc", { get() { return document; } });
Object.defineProperty(P, "win", { get() { return window; } });

class Component<E extends HTMLElement> {
  constructor(public el: E) {}
  setDisabled(d: boolean) { (this.el as unknown as HTMLInputElement).disabled = d; return this; }
}
class Valued<E extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> extends Component<E> {
  get inputEl() { return this.el; }
  setValue(v: unknown) { if (this.el.type === "checkbox") (this.el as HTMLInputElement).checked = !!v; else this.el.value = String(v); return this; }
  setPlaceholder(p: string) { this.el.setAttribute("placeholder", p); return this; }
  onChange(fn: (v: any) => void) {
    this.el.addEventListener(this.el.tagName === "SELECT" || this.el.type === "checkbox" ? "change" : "input", () =>
      fn(this.el.type === "checkbox" ? (this.el as HTMLInputElement).checked : this.el.type === "range" ? Number(this.el.value) : this.el.value));
    return this;
  }
  setLimits(min: number, max: number, step: number) { Object.assign(this.el, { min, max, step }); return this; }
  setDynamicTooltip() { return this; }
  addOption(v: string, label: string) { this.el.append(new Option(label, v)); return this; }
  addOptions(o: Record<string, string>) { for (const [v, l] of Object.entries(o)) this.addOption(v, l); return this; }
}
class Button extends Component<HTMLButtonElement> {
  setButtonText(t: string) { this.el.textContent = t; return this; }
  setCta() { return this; } removeCta() { return this; }
  setIcon(i: string) { this.el.textContent = i === "x" ? "×" : "↺"; return this; }
  setTooltip(t: string) { this.el.title = t; return this; }
  onClick(fn: () => void) { this.el.addEventListener("click", fn); return this; }
}

export class Setting {
  settingEl: HTMLElement; infoEl: HTMLElement; nameEl: HTMLElement; descEl: HTMLElement; controlEl: HTMLElement;
  private parts: Component<any>[] = [];
  constructor(parent: HTMLElement) {
    this.settingEl = parent.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(n: string) { this.nameEl.textContent = n; return this; }
  setDesc(d: string) { this.descEl.textContent = d; return this; }
  setHeading() { this.settingEl.classList.add("setting-item-heading"); return this; }
  setClass(c: string) { this.settingEl.classList.add(c); return this; }
  setDisabled(d: boolean) { this.parts.forEach((p) => p.setDisabled(d)); this.settingEl.classList.toggle("is-disabled", d); return this; }
  private add<T extends Component<any>>(c: T, cb: (c: T) => unknown) { this.parts.push(c); cb(c); return this; }
  addSlider(cb: (c: Valued<HTMLInputElement>) => unknown) { const i = this.controlEl.createEl("input"); i.type = "range"; return this.add(new Valued(i), cb); }
  addToggle(cb: (c: Valued<HTMLInputElement>) => unknown) { const i = this.controlEl.createEl("input"); i.type = "checkbox"; return this.add(new Valued(i), cb); }
  addText(cb: (c: Valued<HTMLInputElement>) => unknown) { return this.add(new Valued(this.controlEl.createEl("input")), cb); }
  addSearch(cb: (c: Valued<HTMLInputElement>) => unknown) { const w = this.controlEl.createDiv({ cls: "search-input-container" }); const i = w.createEl("input"); i.type = "search"; return this.add(new Valued(i), cb); }
  addTextArea(cb: (c: Valued<HTMLTextAreaElement>) => unknown) { return this.add(new Valued(this.controlEl.createEl("textarea")), cb); }
  addColorPicker(cb: (c: Valued<HTMLInputElement>) => unknown) { const i = this.controlEl.createEl("input"); i.type = "color"; return this.add(new Valued(i), cb); }
  addDropdown(cb: (c: Valued<HTMLSelectElement>) => unknown) { return this.add(new Valued(this.controlEl.createEl("select")), cb); }
  addButton(cb: (c: Button) => unknown) { return this.add(new Button(this.controlEl.createEl("button")), cb); }
  addExtraButton(cb: (c: Button) => unknown) { return this.add(new Button(this.controlEl.createEl("button")), cb); }
}
export class PluginSettingTab { containerEl = document.createElement("div"); constructor(public app: unknown, _p: unknown) {} }
export class Notice { constructor(public text: string) { console.log("Notice:", text); } }
// Everything else main.ts imports, never used by the settings page.
export class Plugin {} export class ItemView {} export class FileSystemAdapter {} export class MarkdownView {} export class TFile {}
export const debounce = (f: () => void) => f;
