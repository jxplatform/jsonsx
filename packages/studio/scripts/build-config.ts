/**
 * The studio bundle contract, shared by every build path.
 *
 * There are TWO of those paths, which is the whole reason this file exists:
 *
 * - `scripts/build.ts` — the release build. Feeds the npm tarball, the desktop app bundle, and the
 *   cloud platform's static assets.
 * - The repo dev server (`server.js` → `@jxsuite/server`'s `builds` watcher) — rebuilds
 *   `packages/studio/dist` on every source change while you work.
 *
 * They used to disagree. The dev watcher had its own inline config with no Monaco de-duplication
 * and no code splitting, so `bun run dev` served an 18.8 MB bundle with Monaco in it twice while
 * `bun run build` produced 3.3 MB — and since the watcher overwrites `dist/` on the next keystroke,
 * a developer never saw the built output at all. Both paths now spread {@link studioBundleOptions},
 * so a change to the contract cannot reach one and miss the other.
 */

import { join } from "node:path";
import type { BuildConfig } from "bun";

/** The studio package root, derived from this file's location. */
export const STUDIO_DIR = join(import.meta.dir, "..");

/*
 * THERE IS NO MONACO DE-DUPLICATION PLUGIN HERE ANY MORE, and the reason is worth keeping.
 *
 * A `dedupe-monaco` `onResolve` hook used to force every `monaco-editor` specifier through
 * `Bun.resolveSync` from this package — because there were TWO importers with two resolutions:
 * studio's own `monaco-editor/esm/...` went through `packages/studio/node_modules/monaco-editor`
 * (a symlink into `node_modules/.bun/…`) while `y-monaco`'s bare `monaco-editor` resolved to the
 * physically separate copy hoisted at the workspace root. Same version, two paths, so the bundler
 * emitted Monaco TWICE — 5.1 MB, 27% of the bundle.
 *
 * Replacing y-monaco with the first-party binding (`src/collab/monaco-binding.ts`) left exactly one
 * importer, so the hook became an identity transform. Verified rather than reasoned: a `bun build
 * --metafile` pass, which does NOT install this plugin, reports **one** physical
 * `monaco-editor` root in the input graph, and removing the plugin left the emitted bundle
 * byte-identical.
 *
 * If a second consumer of `monaco-editor` is ever added, check the metafile before assuming this
 * stays true.
 */

/**
 * Bundler options every studio build must use. Spread into a `Bun.build` call (or into a
 * `@jxsuite/server` `builds` entry, which forwards unknown keys to `Bun.build`).
 *
 * Entrypoints and `outdir` are deliberately absent — the caller owns those, and each entry must be
 * built in its OWN pass: a single multi-entry build roots its output at the entrypoints' common
 * ancestor (`src/`), which nests the iframe bundle under `dist/canvas/` and breaks `canvas.html`'s
 * flat `./dist/iframe-entry.js` import.
 */
export const studioBundleOptions = {
  format: "esm",
  /*
   * Naming is a CONTRACT, not a detail. Entries stay at flat, unhashed `dist/<name>.js` because four
   * consumers address them by fixed path: `index.html`, `canvas.html`,
   * `packages/desktop/scripts/stage-studio-assets.ts`, and the platform's `scripts/build-assets.ts`.
   * Split chunks are content-hashed (they are only ever reached through an import in an entry) and
   * land in `dist/chunks/`, which those consumers copy wholesale.
   */
  naming: {
    asset: "[name].[ext]",
    chunk: "chunks/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  sourcemap: "linked",
  /*
   * Splitting is what makes the ~18 `await import()` sites in studio src defer PAYLOAD rather than
   * just evaluation — without it Bun inlines them all into the entry, so Monaco, yjs, ajv and
   * pragmatic-dnd's element adapter ship on every cold start regardless.
   */
  splitting: true,
  target: "browser",
} satisfies Partial<BuildConfig>;

/** The two studio entrypoints, relative to the studio package root, in build order. */
export const STUDIO_ENTRYPOINTS = ["./src/studio.ts", "./src/canvas/iframe-entry.ts"] as const;
