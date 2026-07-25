/**
 * Build-workers.ts — bundle Monaco's web workers into dist/workers.
 *
 * Resolves monaco-editor through node resolution (its package.json exposes a "./*" export map)
 * rather than a hardcoded "./node_modules/monaco-editor/..." path. The literal path only works when
 * bun creates a per-package symlink under packages/studio/node_modules; in CI the dependency is
 * hoisted to the repo-root node_modules and that symlink is absent, so the hardcoded path fails
 * while resolution (which walks up to the root) still succeeds.
 */

import { resolve } from "node:path";

const WORKERS = [
  "monaco-editor/esm/vs/editor/editor.worker.js",
  "monaco-editor/esm/vs/language/json/json.worker.js",
  "monaco-editor/esm/vs/language/typescript/ts.worker.js",
];

/**
 * Where the workers land — `packages/studio/dist/workers`, resolved off this script's own location
 * rather than the cwd so importers (the dev server) get the same output as `bun run build`.
 * src/services/monaco-setup.ts loads them from here, relative to the studio document.
 */
export const WORKER_OUTDIR = resolve(import.meta.dir, "..", "dist", "workers");

/**
 * Bundle Monaco's web workers into {@link WORKER_OUTDIR}. One Bun.build per worker: a single
 * multi-entry build roots its output at the entrypoints' common ancestor (`esm/vs`) and would nest
 * them under `editor/` and `language/json/`, which the flat `dist/workers/<name>.worker.js` lookup
 * in monaco-setup.ts does not expect.
 *
 * @returns {Promise<void>} Resolves once all three workers are written
 */
export async function buildMonacoWorkers(): Promise<void> {
  for (const spec of WORKERS) {
    const entry = Bun.resolveSync(spec, import.meta.dir);
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: WORKER_OUTDIR,
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
}

// Direct invocation (`bun run scripts/build-workers.ts`) still builds; importers call the export.
if (import.meta.main) {
  await buildMonacoWorkers();
}
