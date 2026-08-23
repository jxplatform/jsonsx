/**
 * Where the studio bundle was loaded from — the one fact a shipped asset can be located against.
 *
 * `import.meta.url` is NOT that fact, and the difference has been shipping a silent bug. Only the
 * two ENTRIES are guaranteed to be emitted at `dist/<name>.js` (studio.md §11.1 — four consumers
 * address those paths literally, so they are never hashed). Every other module is subject to
 * `splitting: true` and may be hoisted into a content-hashed chunk under `dist/chunks/` — and
 * `services/monaco-setup` was, by the code-split in 78d85ba2. Its `new URL("workers/…",
 * import.meta.url)` therefore resolved against `dist/chunks/`, while all three distribution paths
 * stage the workers beside the ENTRY. Verified in the built output: the string `workers/` appears
 * in `dist/chunks/monaco-setup-<hash>.js` and in neither `dist/studio.js` nor
 * `dist/iframe-entry.js`, and `dist/chunks/workers/` does not exist.
 *
 * The failure mode is why this is worth a module rather than a comment: a Monaco worker that 404s
 * takes the whole JSON language service with it — no schema validation, no completion, no hover —
 * and reports nothing. Nobody sees a red anything.
 *
 * So the entries publish their own location and everything else reads it. The base is the entry's
 * DIRECTORY, so `bundleUrl("workers/json.worker.js")` lands beside the entry on every host without
 * the host being asked for anything: `/packages/studio/dist/` on the repo dev server,
 * `views://studio/dist/` in the packaged app, `/__studio__/dist/` on the desktop loopback server,
 * and whatever prefix a cloud host staged the tree under.
 *
 * **Only an entry may call {@link setBundleBase}.** `tests/entry-anchors.test.ts` enforces both
 * halves — that both entries call it, and that no other module under `src/` so much as mentions
 * `import.meta.url` — because the next refactor that moves a module into a chunk must not be able
 * to reintroduce this quietly.
 */

/** The entry's directory, with a trailing slash. `undefined` until an entry sets it. */
let base: string | undefined;

/**
 * Record the calling ENTRY's own URL. Call as `setBundleBase(import.meta.url)`, first statement
 * after the imports, from `src/studio.ts` or `src/canvas/iframe-entry.ts` only.
 *
 * @param entryUrl The entry module's `import.meta.url`.
 */
export function setBundleBase(entryUrl: string): void {
  // Directory, not file: `new URL("./", <file url>)` strips the last segment.
  base = new URL("./", entryUrl).href;
}

/**
 * Resolve a path relative to the bundle's own directory.
 *
 * Throws rather than guessing, because its predecessor's whole problem was failing silently: an
 * unset base means an entry did not run, and a URL invented here would 404 somewhere the user
 * cannot see.
 *
 * @param path Bundle-relative path, e.g. `workers/json.worker.js` or `../canvas.html`.
 * @returns Absolute URL.
 * @throws {Error} When no entry has called {@link setBundleBase}.
 */
export function bundleUrl(path: string): string {
  if (base === undefined) {
    throw new Error(
      `bundleUrl(${JSON.stringify(path)}) before setBundleBase(). An entry module ` +
        `(src/studio.ts or src/canvas/iframe-entry.ts) must call setBundleBase(import.meta.url) ` +
        `first; a test needs tests/with-dom.ts, which sets one.`,
    );
  }
  return new URL(path, base).href;
}

/** Test seam: forget the recorded base. Not called by application code. */
export function resetBundleBase(): void {
  base = undefined;
}
