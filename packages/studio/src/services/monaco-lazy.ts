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
 * The active project's generated entry schemas, held until Monaco exists to receive them.
 *
 * These arrive at project activation — long before anyone opens a code view — and applying them
 * used to mean `import("./monaco-setup")` right then. A dynamic import that EXECUTES at startup
 * defers evaluation by a tick but still fetches: Monaco went over the wire on every cold load,
 * which is precisely what the lazy path exists to avoid. So the schemas wait here instead, and the
 * loader applies whatever is pending once an editor actually needs one.
 */
let _pendingSchemas: { project?: unknown; document?: unknown } | null = null;
let _pendingSchemasDirty = false;

/**
 * Record the active project's schemas for Monaco's JSON diagnostics.
 *
 * Applied immediately when Monaco is already loaded, otherwise on the next {@link loadMonaco}. Only
 * the LATEST set matters — reactivation and `project.json` writes both call this — so it overwrites
 * rather than queues.
 */
export function setProjectSchemasForMonaco(
  schemas: { project?: unknown; document?: unknown } | null,
): void {
  _pendingSchemas = schemas;
  _pendingSchemasDirty = true;
  if (_monaco) {
    void applyPendingSchemas();
  }
}

/** Push any pending schemas into Monaco's JSON diagnostics. No-op when nothing changed. */
async function applyPendingSchemas(): Promise<void> {
  if (!_pendingSchemasDirty) {
    return;
  }
  _pendingSchemasDirty = false;
  try {
    const { applyProjectSchemas } = await import("./monaco-setup.js");
    applyProjectSchemas(_pendingSchemas);
  } catch {
    // Editor degradation: the bundled core schemas stay in force.
  }
}

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
    // The project's schemas may have arrived long before now; register them before the first editor
    // Mounts so its very first validation pass uses the right rules.
    await applyPendingSchemas();
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

/**
 * Whether the mount started before {@link loadMonaco} is still the one the app wants.
 *
 * **The question you owe on the far side of the load, which is why it lives beside the load.** A
 * cold `loadMonaco()` is a 12.6 MB dynamic import; the user has hundreds of milliseconds inside it
 * to close the surface, retarget it, or leave the mode — and a second render has the same window to
 * start a mount of its own. Both surfaces need it and each had its own spelling of it, so the
 * source view simply did without: `renderCanvasImpl` assigns `surface.prevCanvasMode` BEFORE it
 * reaches the mount, so a second synchronous `renderCanvas()` during the load sees `modeChanged ===
 * false` and a null `view.monacoEditor`, skips the fast path and mounts again. The second mount
 * then calls `createModel` with a URI the first already registered, which real Monaco throws on
 * ("ERR: Another model with the same URI"), and `store.ts`'s `render()`/`renderOnly()` coalesce
 * nothing.
 *
 * Returning false means creating NOTHING — no model, no editor, no `automaticLayout` observer. That
 * is strictly better than creating and disposing: there is no window in which a doomed editor is
 * attached to anything, and no URI briefly claimed by a model nobody holds.
 *
 * @param {Element | null | undefined} container Where the editor was going to be created.
 * @param {unknown} existing The surface's editor handle (`view.monacoEditor` /
 *   `view.functionEditor`). Non-null means another mount already won this race.
 * @param {() => boolean} stillTargeted Whether the app still wants exactly THIS mount — the same
 *   tab, the same mode, the same editing target. Lazy: the two cheap clauses above answer first.
 * @returns {boolean}
 */
export function mountStillWanted(
  container: Element | null | undefined,
  existing: unknown,
  stillTargeted: () => boolean,
): boolean {
  if (!container?.isConnected || existing) {
    return false;
  }
  return stillTargeted();
}

/** Whether Monaco has been loaded (tests, and the odd diagnostic). */
export function isMonacoLoaded(): boolean {
  return _monaco !== null;
}

/** Reset the memo (tests only). */
export function resetMonacoLazy(): void {
  _monaco = null;
  _loading = null;
  _pendingSchemas = null;
  _pendingSchemasDirty = false;
}
