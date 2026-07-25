/**
 * Build.ts — bundle the studio app with build-time metadata injected.
 *
 * The browser bundle can't read package.json at runtime, so version/build info is injected as
 * compile-time constants (consumed by src/version.ts). After the main bundle, the Monaco web
 * workers are built via build-workers.ts. Desktop's pre-build shells out to `bun run build`, so
 * this injection covers both the dev-server and desktop targets.
 */

import { $ } from "bun";
import pkg from "../package.json" with { type: "json" };

const { version } = pkg as { version: string };
const buildDate = new Date().toISOString();

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
    entrypoints: [entry],
    outdir: "dist",
    target: "browser",
    sourcemap: "linked",
    define,
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
