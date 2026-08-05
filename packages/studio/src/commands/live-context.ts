/// <reference lib="dom" />
/**
 * Live-context.ts — the running app's answer to `getContext()`.
 *
 * `context.ts` owns the SHAPE and refuses to import a state module, which is what lets the CI
 * checks load the command set in a bare Bun process. This file is the other half: it reads the
 * three places state actually lives — the reactive `shell` record, `workspace` / `activeTab`, and
 * `projectState` — and projects them onto that shape, once per predicate evaluation.
 *
 * **A fresh snapshot per call, deliberately.** The registry calls `getContext()` inside
 * `visible()`, `isEnabled()` and `run()`, so a surface that repaints from an effect reads
 * `shell.focusRegion`, `activeTab.value` and the tab's session THROUGH this builder while that
 * effect is collecting dependencies — the effect therefore tracks them and re-runs when they
 * change. Caching the record would be the one change that breaks that, and there is nothing to
 * cache: every field is a property read or a `typeof fn === "function"` test.
 *
 * The recorded pitfall for reactive state — build nested collections complete BEFORE inserting
 * them, because writes through a raw ref skip effects — does not bite here for the same reason: the
 * returned record is a plain, complete, throwaway object. It is never made reactive and never
 * mutated after construction.
 *
 * Four facts arrive by injection rather than by import: the canvas mode (owned by `studio.ts`), the
 * caret and modal flags (`canvas/iframe-host.ts`, `ui/layers.ts`) and the platform. Injecting them
 * keeps this module free of the import cycle studio.ts → shortcuts.ts → live-context.ts →
 * studio.ts, and lets a test state a context without standing up the app.
 */

import { componentRegistry } from "../files/components";
import { getNodeAtPath, projectState } from "../store";
import { shell } from "../shell";
import { activeTab, workspace } from "../workspace/workspace";
import { primarySelection } from "../tabs/selection";
import { canRedo, canUndo } from "../tabs/transact";
import { collabState } from "../collab/collab-state";

import { canvasViewForMode, editorKindForMode, emptyContext } from "./context";
import type { CommandContext, FocusRegion } from "./context";
import type { StudioPlatform } from "../types";

/** Elements that own the keyboard while focused. Matches the old listener's target test exactly. */
const TEXT_ENTRY =
  "input, textarea, select, sp-textfield, sp-search, sp-number-field, sp-picker, [contenteditable=true]";

/**
 * Whether a parent-realm text control has focus.
 *
 * The old listener asked this of `e.target`; asking it of `document.activeElement` is the same
 * answer — a keydown's target IS the focused element, and shadow-DOM retargeting maps the inner
 * `<input>` of an `sp-textfield` onto the host in both cases — but it makes the fact part of the
 * CONTEXT instead of part of the event, so a `when` predicate can read it too.
 */
export function isTextEntryFocused(doc: Document = document): boolean {
  const el = doc.activeElement;
  return el instanceof HTMLElement && el.matches(TEXT_ENTRY);
}

/** The facts this module cannot reach without an import cycle or a DOM/platform singleton. */
export interface LiveContextSources {
  /** `studio.ts`'s `getCanvasMode()` — the per-tab preview toggle already composed in. */
  canvasMode: () => string;
  /** `canvas/iframe-host.ts`'s bridge-derived caret flag (P1). */
  isCaretActive: () => boolean;
  /** `ui/layers.ts`'s `isModalOpen()`. */
  isModalOpen: () => boolean;
  /** The registered platform, or null before one is registered. */
  platform: () => StudioPlatform | null;
  /** Whether the assistant has usable credentials (`services/ai-models`). */
  aiConfigured: () => boolean;
  /**
   * Whether the assistant is mid-stream. `panels/ai-panel.ts` keeps its `DocumentAssistant` module-
   * private, so there is nothing to read yet; the caller passes a probe when one exists.
   */
  aiStreaming?: () => boolean;
}

/** `capability.*` is presence-of-method on the PAL — the check every call site does by hand today. */
function capabilities(platform: StudioPlatform | null): CommandContext["capability"] {
  const has = (key: keyof StudioPlatform) => typeof platform?.[key] === "function";
  return {
    dataRows: has("dataRows"),
    // The real member now, not the `codeService` stand-in it was minted against: the usage query is
    // Its own route over the rename refactor's walker, and cloud computes it server-side.
    findReferences: has("findReferences"),
    gitClone: has("gitClone"),
    importSite: has("importSite"),
    openProjectInNewWindow: has("openProjectInNewWindow"),
    // Multi-window is a desktop-only family; `newWindow` is the one every member implies.
    windowControls: has("newWindow"),
  };
}

/**
 * Build the live `getContext` thunk.
 *
 * @returns A function the registry calls per predicate evaluation.
 */
export function createLiveContext(sources: LiveContextSources): () => CommandContext {
  return () => {
    const ctx = emptyContext();
    const tab = activeTab.value ?? null;
    const project = projectState;
    const mode = sources.canvasMode();

    ctx.project.open = project !== null;
    ctx.project.isSite = project?.isSiteProject === true;
    // A project is a repository once git has answered for it. Before the first refresh the honest
    // Answer is "not yet", and Source Control's own commands are the ones that refresh it.
    ctx.project.isRepo = shell.git.status?.isRepo === true;
    ctx.git.ahead = shell.git.status?.ahead ?? 0;
    ctx.git.behind = shell.git.status?.behind ?? 0;
    ctx.git.dirtyCount = shell.git.status?.files.length ?? 0;

    ctx.document.open = tab !== null;
    ctx.document.dirty = tab?.doc.dirty === true;
    ctx.document.mode = tab?.doc.mode ?? "";
    ctx.document.canUndo = tab ? canUndo(tab) : false;
    ctx.document.canRedo = tab ? canRedo(tab) : false;

    ctx.editor.kind = tab ? editorKindForMode(mode) : "none";
    ctx.canvas.view = canvasViewForMode(mode);
    // Panes land in P3; until then the grid is one pane showing the focused tab.
    ctx.pane.count = workspace.tabOrder.length > 0 ? 1 : 0;

    const paths = tab?.session.selection ?? [];
    const selection = primarySelection(paths);
    if (selection) {
      const node = getNodeAtPath(tab!.doc.document, selection);
      ctx.selection.count = paths.length;
      ctx.selection.paths = paths.map((path) => [...path]);
      // Every remaining fact describes the PRIMARY — the one node a single-target verb addresses —
      // Except `isRoot`, which is the batch's own gate: a batch containing the document element
      // Cannot be deleted or duplicated any more than that element could be on its own.
      ctx.selection.kind = typeof node?.tagName === "string" ? node.tagName : "";
      // A path of fewer than two segments addresses the document element itself — the same test
      // `shortcuts.ts` spelled as `selection.length >= 2` at four separate call sites.
      ctx.selection.isRoot = paths.some((path) => path.length < 2);
      ctx.selection.isComponentInstance = componentRegistry.some(
        (c) => c.tagName === node?.tagName,
      );
      ctx.selection.isRepeater = node?.$prototype === "Array";
    }
    // Layout chrome is NOT a document selection: the node is not in the open page at all.
    ctx.selection.isLayoutNode = shell.layoutSelection !== null;

    // A parent-realm text field owns the keyboard exactly as a canvas caret does. Folding both into
    // One key is what lets `keyScopeStack` stay a pure function of the context.
    ctx.caret.active = sources.isCaretActive() || isTextEntryFocused();
    ctx.focus.region = shell.focusRegion as FocusRegion;
    ctx.modal.open = sources.isModalOpen();

    if (tab) {
      const collab = collabState(tab);
      ctx.collab.attached = collab.active;
      ctx.collab.readOnly = collab.readOnly;
      ctx.collab.sourceCanonical = collab.sourceCanonical;
    }

    ctx.ai.configured = sources.aiConfigured();
    ctx.ai.streaming = sources.aiStreaming?.() ?? false;
    ctx.capability = capabilities(sources.platform());
    return ctx;
  };
}
