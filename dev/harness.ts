// Browser harness: runs the real engine without Obsidian.
// `bun run dev`, open the URL, use the same keys as in the plugin.
import { installedFonts } from "../src/fonts";
import { parseScript } from "../src/parser";
import { Prompter } from "../src/prompter";
import { DEFAULT_SETTINGS, type PrompterSettings } from "../src/settings";
import css from "../styles.css" with { type: "text" };
import sample from "./sample.md" with { type: "text" };

// The stylesheet as Obsidian loads it: raw, not through Bun's CSS bundler
// (which reorders nested rules).
const style = document.createElement("style");
style.textContent = css;
document.head.append(style);

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
