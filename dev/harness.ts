// Browser harness: runs the real engine without Obsidian.
// `bun run dev`, open the URL, use the same keys as in the plugin.
import { installedFonts } from "../src/fonts";
import { parseScript } from "../src/parser";
import { Prompter } from "../src/prompter";
import { DEFAULT_SETTINGS, type PrompterSettings } from "../src/settings";
import sample from "./sample.md" with { type: "text" };

const params = new URLSearchParams(location.search);
const settings: PrompterSettings = {
  ...DEFAULT_SETTINGS,
  rotation: Number(params.get("rotation") ?? 0) as PrompterSettings["rotation"],
  flipH: params.has("flipH"),
  flipV: params.has("flipV"),
};

const host = document.querySelector("main")!;
const prompter = new Prompter(host, settings);
prompter.setScript(parseScript(sample));
document.addEventListener("keydown", (e) => prompter.handleKey(e));
Object.assign(globalThis, { prompter, installedFonts });
