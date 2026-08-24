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
import { STUDIO_ASSETS, STUDIO_WORKERS } from "@jxsuite/studio/hosting/layout";

/**
 * Paths every packaged app-code dir must contain, relative to the bundle's `app/` dir.
 *
 * The studio half is DERIVED from `@jxsuite/studio`'s manifest rather than listed here. It used to
 * be listed, and it was the third copy of the same list — after `stage-studio-assets.ts` and
 * `electrobun.config.ts`'s copy block — so it could only ever assert what someone had remembered to
 * write in all three. `dist/codicon.ttf` was in none of them.
 *
 * `dist/workers` is expanded to its three filenames rather than collapsed to a directory check, and
 * that granularity is load-bearing: a worker that is absent does not 404 loudly, it leaves the
 * packaged code view with no JSON language service at all.
 */
const STUDIO_REQUIRED = STUDIO_ASSETS.filter((a) => a.required).flatMap((a) =>
  a.path === "dist/workers"
    ? STUDIO_WORKERS.map((w) => `views/studio/dist/workers/${w}`)
    : [`views/studio/${a.path}`],
);

export const REQUIRED = [
  "bun/index.js",
  // @jxsuite/create resolves these next to its bundled module (app/bun/).
  "bun/template/gitignore",
  "bun/template/layouts/base.json",
  "bun/template/pages/index.md",
  "bun/templates/mobile-app/layouts/base.json",
  // @jxsuite/starters reads the registry the same way; per-starter trees are checked against it.
  "bun/registry.json",
  ...STUDIO_REQUIRED,
  /* The launcher's own PAL-init bundle, which is the one studio-tree file the manifest does NOT
     know about: the desktop builds it and stages it into studio's dist/. Without it the packaged
     app boots with no platform registered. */
  "views/studio/dist/init.js",
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
