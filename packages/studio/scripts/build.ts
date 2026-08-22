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
import { STUDIO_DIR, STUDIO_ENTRYPOINTS, studioBundleOptions } from "./build-config.ts";
import pkg from "../package.json" with { type: "json" };

const outdir = join(STUDIO_DIR, "dist");

const { version } = pkg as { version: string };
const buildDate = new Date().toISOString();

// Dist is generated, never curated: wipe it so a renamed entrypoint or a one-off `bun build` cannot
// Leave an orphan behind that `package.json`'s `files` then publishes. (This repo shipped a stale
// 12 MB `dist/studio.ts` and a duplicate `dist/canvas/iframe-entry.js` that way.) Safe to do first —
// The Monaco workers are rebuilt below.
await rm(outdir, { force: true, recursive: true });

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

// One pass per entrypoint: a single multi-entry build roots its output at the entrypoints' common
// Ancestor (src/), which would nest the iframe bundle under dist/canvas/ and break canvas.html's flat
// `./dist/iframe-entry.js` import. The bundler contract itself is shared with the dev-server watcher
// Via build-config.ts, so the two paths cannot drift.
for (const entry of STUDIO_ENTRYPOINTS) {
  const result = await Bun.build({
    ...studioBundleOptions,
    define,
    entrypoints: [entry],
    outdir: "dist",
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

/*
 * The two package-root documents, and the manifest.
 *
 * index.html is GENERATED, not authored. It was authored, and so was a copy of it in every host
 * that served the shell — jx-platform rewrote three prefixes and surgically replaced the entry's
 * script tag, and when studio 2.1.0 split the chrome into ./styles/*.css the rewrite list missed it
 * and the cloud shipped seven dead stylesheet links under a green build. The document is now one
 * function of one list, so a stylesheet added to `styles/` and to STUDIO_STYLESHEETS reaches every
 * host at once, and one added to only the first is caught by check-studio-package.ts.
 *
 * canvas.html stays hand-authored: its <style> block establishes the fixed-size query container the
 * runtime transposes viewport units against, and that has to apply before the iframe's first paint.
 *
 * The committed index.html is what the repo dev server serves and what `git diff --exit-code` in
 * the checks job compares against, so writing it here is what keeps the two honest.
 */
const { studioShellHtml } = await import("../src/hosting/document.ts");
const { writeAssetManifest } = await import("../src/hosting/stage.ts");
await Bun.write(join(STUDIO_DIR, "index.html"), studioShellHtml());
await writeAssetManifest(STUDIO_DIR);
