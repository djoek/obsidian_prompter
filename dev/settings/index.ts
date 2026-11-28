import { SouffleurSettingTab } from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { Midi } from "../../src/inputs";

const plugin = {
  settings: { ...DEFAULT_SETTINGS },
  voice: null, voiceDetail: "", voiceListeners: new Set<() => void>(), midi: new Midi(),
  async updateSettings(patch: object) { Object.assign(this.settings, patch); },
  applyVoice() {}, resetVoice() {}, async syncMidi() {},
};
const tab = new SouffleurSettingTab({} as never, plugin as never);
document.body.append(tab.containerEl);
tab.display();
Object.assign(globalThis, { tab, plugin });
