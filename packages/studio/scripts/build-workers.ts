/**
 * Build-workers.ts — bundle Monaco's web workers into dist/workers.
 *
 * Resolves monaco-editor through node resolution (its package.json exposes a "./*" export map)
 * rather than a hardcoded "./node_modules/monaco-editor/..." path. The literal path only works when
 * bun creates a per-package symlink under packages/studio/node_modules; in CI the dependency is
 * hoisted to the repo-root node_modules and that symlink is absent, so the hardcoded path fails
 * while resolution (which walks up to the root) still succeeds.
 */

const WORKERS = [
  "monaco-editor/esm/vs/editor/editor.worker.js",
  "monaco-editor/esm/vs/language/json/json.worker.js",
  "monaco-editor/esm/vs/language/typescript/ts.worker.js",
];

for (const spec of WORKERS) {
  const entry = Bun.resolveSync(spec, import.meta.dir);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: "dist/workers",
    target: "browser",
    naming: "[name].[ext]",
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}
