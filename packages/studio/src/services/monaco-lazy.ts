/**
 * Lazy Monaco.
 *
 * Monaco is 12.6 MB of the studio bundle — two thirds of it — and most sessions never open a code
 * view. It used to be pulled in by a static `import * as monaco` in three modules plus a
 * side-effect `import "./services/monaco-setup.js"` from `studio.ts`, so every cold start
 * downloaded, parsed and evaluated the editor, its TypeScript/JSON/JavaScript language
 * contributions, and a `flattenSchema` pass over a 497 KB schema before first paint.
 *
 * Loading is deferred to the first code surface that actually needs it: source mode, the function
 * editor, the formula workspace. `loadMonaco()` is memoized, so concurrent callers share one import
 * and the language contributions register exactly once.
 *
 * Two accessors, deliberately:
 *
 * - {@link loadMonaco} for code that MOUNTS an editor. Those call sites are lit `ref()` DOM-attach
 *   callbacks or already-async paths, so awaiting is free.
 * - {@link loadedMonaco} for code that can only run once an editor exists (setting markers on a
 *   model, comparing a live editor's model URI). Returning the already-resolved namespace
 *   synchronously keeps those paths sync — no async ripple through the render tree for a module
 *   that is provably present.
 */

import type * as monacoNs from "monaco-editor";

export type Monaco = typeof monacoNs;

let _monaco: Monaco | null = null;
let _loading: Promise<Monaco> | null = null;

/**
 * Load Monaco and its Jx configuration (workers, JSON schemas, TS/JS contributions). Memoized.
 *
 * The `monaco-setup` import is what registers the language contributions and the worker factory, so
 * it must resolve before an editor is created — hence both imports awaited here rather than left to
 * whichever module happens to be evaluated first.
 */
export function loadMonaco(): Promise<Monaco> {
  if (_monaco) {
    return Promise.resolve(_monaco);
  }
  // Not `async`: an async function wraps the memo in a fresh promise per call, so concurrent callers
  // Could not observe that they share one in-flight load. Returning `_loading` itself makes the
  // Load-once guarantee visible (and testable) rather than merely true.
  _loading ??= (async () => {
    const [monaco] = await Promise.all([
      import("monaco-editor/esm/vs/editor/editor.api.js"),
      import("./monaco-setup.js"),
    ]);
    _monaco = monaco as unknown as Monaco;
    return _monaco;
  })();
  return _loading;
}

/**
 * The loaded Monaco namespace, or null when no code surface has opened yet.
 *
 * For call sites reachable ONLY with a live editor in hand — they cannot observe null in practice,
 * but they must not force the module to load either.
 */
export function loadedMonaco(): Monaco | null {
  return _monaco;
}

/** Whether Monaco has been loaded (tests, and the odd diagnostic). */
export function isMonacoLoaded(): boolean {
  return _monaco !== null;
}

/** Reset the memo (tests only). */
export function resetMonacoLazy(): void {
  _monaco = null;
  _loading = null;
}
