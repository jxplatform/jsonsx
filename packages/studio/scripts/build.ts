/**
 * Build.ts — bundle the studio app with build-time metadata injected.
 *
 * The browser bundle can't read package.json at runtime, so version/build info is injected as
 * compile-time constants (consumed by src/version.ts). After the main bundle, the Monaco web
 * workers are built via build-workers.ts. Desktop's pre-build shells out to `bun run build`, so
 * this injection covers both the dev-server and desktop targets.
 */

import { $ } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BunPlugin } from "bun";
import pkg from "../package.json" with { type: "json" };

const studioDir = join(import.meta.dir, "..");
const outdir = join(studioDir, "dist");

const { version } = pkg as { version: string };
const buildDate = new Date().toISOString();

// Dist is generated, never curated: wipe it so a renamed entrypoint or a one-off `bun build` cannot
// Leave an orphan behind that `package.json`'s `files` then publishes. (This repo shipped a stale
// 12 MB `dist/studio.ts` and a duplicate `dist/canvas/iframe-entry.js` that way.) Safe to do first —
// The Monaco workers are rebuilt below.
await rm(outdir, { force: true, recursive: true });

/**
 * Resolve EVERY `monaco-editor` specifier from the studio package, so all consumers share one
 * module identity.
 *
 * Without this, studio's own `monaco-editor/esm/...` resolves through
 * `packages/studio/node_modules/monaco-editor` (a symlink into `node_modules/.bun/…`) while
 * `y-monaco`'s bare `monaco-editor` resolves to the separate physical copy hoisted at the workspace
 * root. Same version, two paths, so the bundler emits Monaco twice — 5.1 MB, 27% of the bundle.
 * Delegating to `Bun.resolveSync` from a fixed base keeps this correct across install re-layouts,
 * which a version pin or an `overrides` entry would not (both copies are already 0.55.1).
 */
const dedupeMonaco: BunPlugin = {
  name: "dedupe-monaco",
  setup(build) {
    build.onResolve({ filter: /^monaco-editor(\/|$)/ }, (args) => ({
      path: Bun.resolveSync(args.path, studioDir),
    }));
  },
};

let gitCommit = "unknown";
try {
  const out = await $`git rev-parse --short HEAD`.quiet().text();
  gitCommit = out.trim() || "unknown";
} catch {
  // No git available (e.g. published tarball) — leave the fallback.
}

const define = {
  __JX_VERSION__: JSON.stringify(version),
  __JX_BUILD_DATE__: JSON.stringify(buildDate),
  __JX_GIT_COMMIT__: JSON.stringify(gitCommit),
};

// Build the editor shell and the slim canvas-iframe bundle in SEPARATE passes. A single multi-entry
// Build roots its output at the entrypoints' common ancestor (src/), which would nest the iframe
// Bundle under dist/canvas/ and break canvas.html's flat `./dist/iframe-entry.js` import. Two
// Single-entry builds each emit flat at dist/<name>.js.
for (const entry of ["./src/studio.ts", "./src/canvas/iframe-entry.ts"]) {
  const result = await Bun.build({
    define,
    entrypoints: [entry],
    outdir: "dist",
    plugins: [dedupeMonaco],
    sourcemap: "linked",
    target: "browser",
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

// Bundle Monaco's web workers into dist/workers.
const { buildMonacoWorkers } = await import("./build-workers.ts");
await buildMonacoWorkers();
