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

const result = await Bun.build({
  // Studio.ts is the editor shell; iframe-entry.ts is the slim canvas-iframe bundle (the document
  // Renderer that runs inside the iframe canvas host).
  entrypoints: ["./src/studio.ts", "./src/canvas/iframe-entry.ts"],
  outdir: "dist",
  target: "browser",
  sourcemap: "linked",
  define: {
    __JX_VERSION__: JSON.stringify(version),
    __JX_BUILD_DATE__: JSON.stringify(buildDate),
    __JX_GIT_COMMIT__: JSON.stringify(gitCommit),
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Bundle Monaco's web workers into dist/workers.
await import("./build-workers.ts");
