/**
 * Context.ts — the record every `when` / `enablement` predicate closes over.
 *
 * One flat-ish record of the facts a command can be gated on (UX-REDESIGN-PLAN §5.2). Predicates
 * are plain closures over this record — the shape `services/gated-registry.ts` already ships for
 * the AI's tools — not a serialisable string DSL. §13 rejects the DSL explicitly: a `"project.open
 * && editor.kind == 'canvas'"` grammar needs a tokenizer, a parser and a reactive evaluator to buy
 * serialisability nothing in Studio consumes.
 *
 * This module owns the SHAPE and a pure builder. It deliberately imports nothing from the state
 * modules: the registry takes a `getContext()` thunk, so wiring the live sources (the reactive
 * `shell` record, `workspace`, `activeTab`) is a next-wave change to one function, and every test
 * here builds its own context with {@link makeContext} instead of standing up the app.
 *
 * `capability.*` mirrors the Platform Abstraction Layer so cloud / desktop / dev-server differences
 * stop being `if (platform.x)` scattered across templates and become one `when` clause per
 * command.
 *
 * {@link keyScopeStack} lives here for the same reason: it is a pure function of this record, so
 * the keyboard's "where am I" question is answered by the same facts every `when` predicate reads,
 * rather than by a second set of `if (canvasMode === …)` branches in the listener.
 */

import type { KeyScope } from "./levels";
import type { JxPath } from "../state";

/** PAL-derived capability keys. One `when` clause replaces a scattered `if (platform.x)`. */
export const CAPABILITIES = [
  "gitClone",
  "importSite",
  "openProjectInNewWindow",
  "dataRows",
  "windowControls",
  "findReferences",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Which shell region owns focus. Drives the keyboard scope stack and F6 region cycling. */
export type FocusRegion =
  | "rail"
  | "navigator"
  | "pane"
  | "inspector"
  | "dock"
  | "status"
  | "palette";

/** The editor kind the focused pane is rendering. */
export type EditorKind = "canvas" | "grid" | "code" | "diff" | "library" | "config" | "none";

/** The Canvas view axis — one control, three values (§4.2). */
export type CanvasView = "edit" | "design" | "preview";

/** Facts a command may be gated on. Every field is a plain value; predicates read, never write. */
export interface CommandContext {
  project: {
    open: boolean;
    isSite: boolean;
    isRepo: boolean;
  };
  git: {
    ahead: number;
    behind: number;
    dirtyCount: number;
  };
  document: {
    open: boolean;
    dirty: boolean;
    /** Format class of the open document — "json", "md", "css", … */
    mode: string;
    canUndo: boolean;
    canRedo: boolean;
  };
  editor: {
    kind: EditorKind;
  };
  canvas: {
    view: CanvasView;
  };
  pane: {
    count: number;
    derived: boolean;
  };
  selection: {
    count: number;
    /**
     * The selected document paths, in selection order — `[]` when nothing is selected (§6.5).
     *
     * The context is what `probe.state()` answers with, so this is how a script, a screenshot step
     * or the assistant READS a multi-selection back. `count` is its length; the last entry is the
     * primary, which every other fact in this group describes.
     */
    paths: JxPath[];
    /** Tag or node kind of the primary selection, "" when nothing is selected. */
    kind: string;
    isRoot: boolean;
    isComponentInstance: boolean;
    isLayoutNode: boolean;
    /**
     * Whether the selection IS a repeater — an `$prototype: "Array"` pseudo-element.
     *
     * A fact rather than a verb's precondition, in the idiom of `isComponentInstance`: a repeater
     * has no child list (its content is the single `map` template), so several structural verbs
     * mean nothing on one, and each of them used to re-derive it from the node it could not see.
     */
    isRepeater: boolean;
  };
  /**
   * Whether a live text caret owns the keyboard. Derived host-side in `iframe-host.ts` from the
   * editStart / selectionChanged / editEnd messages the canvas bridge already sends — this is the
   * fact that stops ⌘C/⌘X/⌘V being stolen from a writer mid-sentence.
   */
  caret: {
    active: boolean;
  };
  focus: {
    region: FocusRegion;
  };
  modal: {
    open: boolean;
  };
  collab: {
    attached: boolean;
    readOnly: boolean;
    sourceCanonical: boolean;
  };
  ai: {
    configured: boolean;
    streaming: boolean;
  };
  capability: Record<Capability, boolean>;
}

/** A partial context, one group at a time — what tests and call sites actually write. */
export type CommandContextPatch = {
  [K in keyof CommandContext]?: Partial<CommandContext[K]>;
};

/**
 * The zero context: no project, no document, no selection, no capabilities.
 *
 * This is the honest cold-start state, which makes it the right default for the `when` predicates
 * to be tested against — a command that is enabled here has said so deliberately.
 */
export function emptyContext(): CommandContext {
  return {
    project: { open: false, isSite: false, isRepo: false },
    git: { ahead: 0, behind: 0, dirtyCount: 0 },
    document: { open: false, dirty: false, mode: "", canUndo: false, canRedo: false },
    editor: { kind: "none" },
    canvas: { view: "design" },
    pane: { count: 1, derived: false },
    selection: {
      count: 0,
      paths: [],
      kind: "",
      isRoot: false,
      isComponentInstance: false,
      isLayoutNode: false,
      isRepeater: false,
    },
    caret: { active: false },
    focus: { region: "pane" },
    modal: { open: false },
    collab: { attached: false, readOnly: false, sourceCanonical: false },
    ai: { configured: false, streaming: false },
    capability: {
      gitClone: false,
      importSite: false,
      openProjectInNewWindow: false,
      dataRows: false,
      windowControls: false,
      findReferences: false,
    },
  };
}

/**
 * Build a context by overriding groups of {@link emptyContext}.
 *
 * Group-level merge, not a deep one: `makeContext({ selection: { count: 1 } })` keeps the other
 * selection fields at their empty defaults. One level is all the record has, and a general deep
 * merge would be a second thing to get right.
 */
export function makeContext(patch: CommandContextPatch = {}): CommandContext {
  const base = emptyContext();
  for (const key of Object.keys(patch) as (keyof CommandContext)[]) {
    const group = patch[key];
    if (group) {
      Object.assign(base[key], group);
    }
  }
  return base;
}

/**
 * An overlay owns the keyboard outright.
 *
 * This is what replaces `shortcuts.ts`'s blanket `if (isModalOpen()) return`. Expressing it as a
 * stack rather than a `!ctx.modal.open` term repeated in fourteen `when` predicates keeps the rule
 * in ONE place — and a dialog that swallows every click has to swallow every chord too, including
 * ones registered next week by a surface that never heard of dialogs. `palette` is the scope
 * overlay-owned bindings register in; nothing outside it resolves while one is up.
 */
const MODAL_STACK: readonly KeyScope[] = ["palette"];

/** A live caret shadows the canvas: app-level chords still fire, element-level ones do not. */
const CARET_STACK: readonly KeyScope[] = ["caret", "global"];

/** Focus outside the pane grid. Dock-scoped bindings, then the app's. */
const DOCK_STACK: readonly KeyScope[] = ["dock", "global"];

const CANVAS_STACK: readonly KeyScope[] = ["canvas", "global"];
const GRID_STACK: readonly KeyScope[] = ["grid", "global"];
const CODE_STACK: readonly KeyScope[] = ["code", "global"];

/** No engine owns the keyboard — only app-level chords are live. */
const GLOBAL_STACK: readonly KeyScope[] = ["global"];

/**
 * The scope stack for the current context, narrowest scope first.
 *
 * The ladder is `caret > grid/code engine > focused dock > global` (plan §5.3), and the whole point
 * is that a scope which is not on the stack cannot fire AT ALL. Three hand-written guards collapse
 * into it:
 *
 * - The blanket modal return → the `palette`-only stack;
 * - The `canvasMode === "grid" && !["o","p","s","w","z","Z"].includes(key)` allow-list → the `grid`
 *   stack, whose six survivors are precisely the `global`-scoped commands;
 * - The caret guard → the `caret` stack, which drops `canvas` so ⌘C/⌘X/⌘V/Delete stay off a sentence
 *   being typed while ⌘S still saves.
 *
 * Preview and the non-editing surfaces (the diff view, the media library, the stylebook) get the
 * bare `global` stack. Preview draws no overlays and posts no hits, so a selection carried in from
 * Design is invisible: every element-level chord there — destructive or not — acts on something the
 * author cannot see. That is one rule where `shortcuts.ts` had two ad-hoc refusal sets which
 * disagreed with each other (⌘X was refused, ⌘C was not).
 */
export function keyScopeStack(ctx: CommandContext): readonly KeyScope[] {
  if (ctx.modal.open) {
    return MODAL_STACK;
  }
  if (ctx.caret.active) {
    return CARET_STACK;
  }
  if (ctx.focus.region !== "pane") {
    return DOCK_STACK;
  }
  switch (ctx.editor.kind) {
    case "grid": {
      return GRID_STACK;
    }
    case "code": {
      return CODE_STACK;
    }
    case "canvas": {
      return ctx.canvas.view === "preview" ? GLOBAL_STACK : CANVAS_STACK;
    }
    default: {
      return GLOBAL_STACK;
    }
  }
}
