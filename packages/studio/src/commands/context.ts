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
export type EditorKind =
  | "canvas"
  | "grid"
  | "code"
  | "diff"
  | "library"
  | "config"
  | "entry"
  | "none";

/** The Canvas view axis — one control, three values (§4.2). */
export type CanvasView = "edit" | "design" | "preview";

/*
 * ─── Modes → the two axes ────────────────────────────────────────────────────
 *
 * `canvasMode` is ONE string conflating two orthogonal questions: WHICH EDITOR is open, and (for
 * the Canvas editor only) WHICH VIEW of it. Both maps live here, beside the types they produce and
 * beside `keyScopeStack`, because they are the same fact and there must be exactly one place to add
 * an entry to.
 *
 * They used to be two copies — one in `tabs/tab.ts` driving the pane model, one in
 * `commands/live-context.ts` driving every `when` predicate and the keyboard — each falling through
 * to its own `?? "canvas"` default. Neither learned about `settings` when Project Settings became a
 * document, so a JSON configuration object resolved into the CANVAS key scope: ⌘V over Project
 * Settings ran `edit.paste`, which inserted an element node at the root of `project.json`, through
 * the transaction log, and saved it.
 */

/** The `canvasMode` strings, mapped onto the editor each one actually names. */
const EDITOR_KIND_BY_MODE: Readonly<Record<string, EditorKind>> = {
  design: "canvas",
  edit: "canvas",
  /* The Entry editor — `content/entry-editor.ts`'s ENTRY_MODE. A form over ONE content entry's
     frontmatter, typed by its collection's schema; the same document the canvas edits the body of,
     which is why it is a mode of that tab rather than a tab of its own. */
  entry: "entry",
  "git-diff": "diff",
  grid: "grid",
  manage: "library",
  preview: "canvas",
  /* Project Settings — `settings/settings-document.ts`'s SETTINGS_MODE. A form over `project.json`,
     which is a configuration object and not a document tree; `stylebook` (Project Styles) is the
     second editor over that same document and answers `config` for the same reason. */
  settings: "config",
  source: "code",
  stylebook: "config",
};

/**
 * The editor kind a mode string names.
 *
 * An unknown mode reads as Canvas, and that default is only for modes STUDIO DOES NOT OWN: a format
 * declares its own list (`format.studio.modes`) and every mode declared that way is a view of the
 * artboard. A mode Studio itself introduces is not covered by it and belongs in the map above —
 * which is what `settings` was not.
 */
/**
 * Human names for the editor kinds, so no surface prints an enum at a reader — and so two surfaces
 * cannot print DIFFERENT words for the same kind. The status bar and the pane context bar each had
 * their own copy, and they disagreed: one said "Stylebook", the wire value, where the other said
 * "Project Styles". §16.2 exists to stop the shell contradicting itself about what is on screen.
 */
export const EDITOR_KIND_LABELS: Readonly<Record<EditorKind, string>> = {
  canvas: "Canvas",
  code: "Code",
  config: "Project Styles",
  diff: "Diff",
  entry: "Entry",
  grid: "Grid",
  library: "Library",
  none: "None",
};

export function editorKindForMode(mode: string): EditorKind {
  return EDITOR_KIND_BY_MODE[mode] ?? "canvas";
}

/** Only the three canvas modes carry a view. */
const CANVAS_VIEW_BY_MODE: Readonly<Record<string, CanvasView>> = {
  design: "design",
  edit: "edit",
  preview: "preview",
};

/**
 * The Canvas view a mode names — the neutral "design" for a mode that has none.
 *
 * Meaningful only where {@link editorKindForMode} answers `"canvas"`; every reader pairs the two.
 */
export function canvasViewForMode(mode: string): CanvasView {
  return CANVAS_VIEW_BY_MODE[mode] ?? "design";
}

/** Facts a command may be gated on. Every field is a plain value; predicates read, never write. */
export interface CommandContext {
  project: {
    open: boolean;
    isSite: boolean;
    isRepo: boolean;
    /** The project declares two or more locales — the gate on every `i18n.*` verb and surface. */
    isMultilingual: boolean;
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
    /**
     * Whether that caret is the CANVAS's, rather than a parent-realm text field's.
     *
     * `active` folds both together on purpose: for {@link keyScopeStack} they are the same fact —
     * something is being typed into, so element-level chords must not fire. For a record they are
     * not. `format.bold` acts on a run of text inside the selected node and is meaningless while
     * the caret is in the Inspector's href field or the link popover's own URL box; a record gated
     * on `active` alone would fire there, and `mod+k` would re-mount the popover the author is
     * typing into.
     *
     * Sourced from the bridge alone (`isCaretActive()`), never from `isTextEntryFocused()`.
     */
    inCanvas: boolean;
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
    /**
     * A turn is suspended on an `ask_user` question.
     *
     * Distinct from `streaming` rather than folded into it: no tokens are moving, so a surface that
     * paints a spinner on `streaming` must not paint one here — but the turn is alive and holding a
     * tool open, so Stop is enabled on the union of the two.
     */
    waiting: boolean;
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
/**
 * The three selection predicates every node-editing verb is gated on.
 *
 * Here rather than in one verb module because two of them define records: `editor/shortcuts.ts`'s
 * chord table and `editor/context-menu.ts`'s element family. Importing one from the other made a
 * cycle (`shortcuts` already imports `copyNode`/`cutNode` from `context-menu`), and re-declaring
 * them is how "an element selection" comes to mean two different things in two menus.
 */

/** The editor showing a document TREE. Every verb that addresses a node needs this. */
export const inCanvas = (ctx: CommandContext) => ctx.editor.kind === "canvas";

/** Something is selected — including the document root, which is a selection of one. */
export const hasSelection = (ctx: CommandContext) => inCanvas(ctx) && ctx.selection.count > 0;

/** A selection that is not the document element, i.e. a node with a parent to act relative to. */
export const hasElementSelection = (ctx: CommandContext) =>
  hasSelection(ctx) && !ctx.selection.isRoot;

export function emptyContext(): CommandContext {
  return {
    project: { open: false, isSite: false, isRepo: false, isMultilingual: false },
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
    caret: { active: false, inCanvas: false },
    focus: { region: "pane" },
    modal: { open: false },
    collab: { attached: false, readOnly: false, sourceCanonical: false },
    ai: { configured: false, streaming: false, waiting: false },
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
