// Bundle the settings page with the Obsidian stand-in in place of "obsidian".
const out = await Bun.build({
  entrypoints: [`${import.meta.dir}/index.ts`],
  outdir: `${import.meta.dir}/out`,
  target: "browser",
  plugins: [{
    name: "obsidian-mock",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: `${import.meta.dir}/obsidian-mock.ts` }));
      b.onResolve({ filter: /^child_process$/ }, () => ({ path: "child_process", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const spawn = () => { throw new Error('not here'); };", loader: "js" }));
    },
  }],
});
if (!out.success) { console.error(out.logs); process.exit(1); }

// The page: the plugin's real stylesheet, and a few stand-in Obsidian styles.
await Bun.write(`${import.meta.dir}/out/styles.css`, Bun.file(`${import.meta.dir}/../../styles.css`));
await Bun.write(
  `${import.meta.dir}/out/index.html`,
  `<!doctype html><meta charset="utf-8"><title>Settings check</title>
<link rel="stylesheet" href="styles.css">
<style>
  body { font: 14px system-ui; background: #1e1e1e; color: #ddd; max-width: 760px; margin: 20px auto;
    --text-muted: #999; --background-modifier-border: #444; --font-ui-medium: 15px; }
  .setting-item { display: flex; gap: 12px; padding: 8px 0; border-top: 1px solid #333; align-items: center; }
  .setting-item-info { flex: 1; } .setting-item-name { font-weight: 600; }
  .setting-item-description { color: #999; font-size: 12px; }
  .setting-item-heading .setting-item-name { font-size: 18px; margin-top: 14px; }
  .is-disabled { pointer-events: none; }
</style>
<body><script src="index.js"></script></body>
`,
);
console.log("built", out.outputs.map((o) => o.path.split("/").pop()).join(", "));
