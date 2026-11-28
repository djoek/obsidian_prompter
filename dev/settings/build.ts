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
console.log("built", out.outputs.map((o) => o.path.split("/").pop()).join(", "));
