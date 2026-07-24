/**
 * Packaged-bundle completeness check, run from the electrobun postBuild hook (post-build.ts).
 *
 * The Bun bundler only inlines the JS module graph into app/bun/index.js; every static data
 * directory the bundled code reads off disk (create templates, starter sites, staged studio assets)
 * must be placed by electrobun.config.ts `build.copy` — and electrobun's copy step only logs a
 * missing source and continues. This check turns any omission into a hard build failure instead of
 * a runtime ENOENT on the tester's machine.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Paths every packaged app-code dir must contain (relative to the bundle's app/ dir). */
export const REQUIRED = [
  "bun/index.js",
  // @jxsuite/create resolves these next to its bundled module (app/bun/).
  "bun/template/gitignore",
  "bun/template/layouts/base.json",
  "bun/template/pages/index.md",
  "bun/templates/mobile-app/layouts/base.json",
  // @jxsuite/starters reads the registry the same way; per-starter trees are checked against it.
  "bun/registry.json",
  // Staged studio assets — a missing one 404s the packaged shell or canvas iframe at boot.
  "views/studio/index.html",
  "views/studio/canvas.html",
  "views/studio/dist/iframe-entry.js",
  "views/studio/dist/init.js",
  "views/studio/dist/studio.js",
  "views/studio/dist/studio.css",
];

/** @returns Missing required paths (relative to appDir); empty array means the bundle is complete. */
export function verifyBundle(appDir: string): string[] {
  const missing = REQUIRED.filter((rel) => !existsSync(join(appDir, rel)));

  // Every starter listed in the staged registry must have its project tree staged too, or the
  // New Project starter gallery offers clones that fail. Deriving ids from the registry keeps
  // Future starters covered automatically.
  const registryPath = join(appDir, "bun", "registry.json");
  if (existsSync(registryPath)) {
    const starters = JSON.parse(readFileSync(registryPath, "utf8")) as { id: string }[];
    for (const { id } of starters) {
      if (!existsSync(join(appDir, "bun", "sites", id, "project.json"))) {
        missing.push(`bun/sites/${id}/project.json`);
      }
    }
  }
  return missing;
}
