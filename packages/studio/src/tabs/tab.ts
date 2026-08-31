/// <reference lib="dom" />
import { effectScope, reactive } from "../reactivity";
import { formatByName, formatForPath } from "../format/format-host";
import { normalizeArrayChildren } from "../state";
import type { FormulaEditDef, FunctionEditDef, InlineEditDef, JsonValue } from "../types";
import { editorKindForMode } from "../commands/context";
import type { EditorKind } from "../commands/context";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxDocOp, JxFmOp } from "./patch-ops";

/**
 * The project's configuration file, project-relative.
 *
 * Named here rather than at the four places that used to spell it, because it is a DOCUMENT PATH —
 * `inferModes` answers `["stylebook", "source"]` for it (editor kind `config`), and
 * `tabs/project-config.ts` binds the tab at this path as the configuration document.
 */
export const PROJECT_CONFIG_PATH = "project.json";

export interface TabUi {
  rightTab: string;
  canvasMode: string;
  /** Preview toggle — composes with an edit/design canvasMode; the effective mode becomes "preview". */
  preview: boolean;
  /** Show elements inherited from the page's layout (pages with an effective layout only). */
  showLayout: boolean;
  /** Chosen literal values for dynamic route params (e.g. { sku: "mini-trencher" }). */
  previewParams: Record<string, string>;
  /**
   * Chosen test values for a component doc's props (state entries), seeded into the canvas render
   * so a non-instantiated component previews with real data (M6) — the previewParams mirror.
   */
  previewProps: Record<string, JsonValue> | null;
  zoom: number;
  /**
   * Edit-mode content zoom — browser-page-zoom semantics (content reflows at the zoomed effective
   * width while the canvas footprint stays fixed), unlike `zoom` which pan/zooms the whole canvas.
   */
  editZoom: number;
  activeMedia: string | null;
  activeSelector: string | null;
  editingFunction: FunctionEditDef | null;
  /** Logic-tab formula target ($expression editing); editingFunction wins if both are set. */
  editingFormula: FormulaEditDef | null;
  featureToggles: Record<string, boolean>;
  /**
   * Canvas color-scheme preview: follow the OS ("auto") or force a scheme. Drives the
   * data-color-scheme attribute on the canvas iframe root (spec §9.5) and, in the style sidebar,
   * which scheme layer edits target.
   */
  previewColorScheme: "auto" | "light" | "dark";
  /**
   * The locale this pane renders AS — the artboard's `lang` and `dir` (§13.4), never which file is
   * open.
   *
   * Jx has no message catalogue: a translation is a different file in a different directory, so
   * "show this page in French" is a navigation and belongs to the locale preset. This axis is the
   * other half — the rendering context a document is _drawn_ under, which is how an author sees
   * their layout mirror under an RTL locale without leaving the document they are editing.
   *
   * `null` is "the document's own language", resolved from its path at render time rather than
   * baked in here: a file moved into `pages/fr/` must change what the pane draws, and a stored tag
   * would go on claiming the language the file used to be in.
   */
  previewLocale: string | null;
  styleSections: Record<string, boolean>;
  /**
   * Which Data rows have their editor and value open, by state-entry name.
   *
   * PER TAB, and a set rather than a single name: comparing two entries means seeing both at once,
   * and coming back to a tab means finding it as you left it. It was one module-global string
   * (`expandedSignal`) plus one module-global Set (`expandedDataKeys`) — two answers to one
   * question, both shared across every open document.
   */
  dataRows: Record<string, boolean>;
  /**
   * How far each truncation marker in a Data row's value tree has been opened, keyed by tree path.
   *
   * PER TAB, for the reason `dataRows` is: the paths are entry names, and a module-global record
   * would have applied "show 50 more of `listings`" to a different document's `listings`.
   */
  dataLimits: Record<string, number>;
  inspectorSections: Record<string, boolean>;
  styleShorthands: Record<string, boolean>;
  styleFilter: string;
  pendingInlineEdit: InlineEditDef | null;
}

/**
 * A live (iframe-evaluated) expression preview retained per editing target (M6). Stored on
 * `session.canvas` beside `scope` — plain wire data (path-key → display-string pairs), rebuilt into
 * an ExpressionPreview by services/live-preview.ts on read.
 */
export interface StoredLivePreview {
  /** Serialized expression + context the values were computed for (staleness check). */
  key: string;
  values: [string, string][];
  error: string | null;
}

interface HistorySnapshot {
  /** Full document at this state (checkpoint), or null when the ops describe the transition. */
  document: Record<string, unknown> | null;
  /** Selection after this state's transaction — the whole set, so a batch undoes back to it. */
  selection: (string | number)[][];
  /** Selection before this state's transaction (restored on surgical undo). */
  selectionBefore?: (string | number)[][];
  /** Replayable ops transforming the previous state into this one. */
  forwardOps?: JxDocOp[] | null;
  /** Replayable ops transforming this state back into the previous one. */
  inverseOps?: JxDocOp[] | null;
  /** Frontmatter key changes in this transaction (before/after values, replayed both ways). */
  fmOps?: JxFmOp[] | null;
  /**
   * Identifies a run of edits that undo as ONE step (successive text commits to the same block).
   *
   * Typing commits on every pause, so without coalescing a minute of writing would push dozens of
   * entries and evict every structural edit before it from the 100-entry ring — and ⌘Z would walk
   * back through the prose one pause at a time instead of undoing the edit.
   */
  coalesceKey?: string | null;
}

/**
 * Where a tab was drilled in FROM — a relationship, not a navigation stack.
 *
 * Drilling into a component opens a real tab of its own (see `workspace/workspace.ts`), so the old
 * "swap the document under the same tab id" breadcrumb is gone. What survives is this: the tab
 * remembers which document sent the author here, and the tab strip prints it. Nothing restores from
 * it, nothing pops it — closing the parent leaves the child perfectly usable.
 */
export interface TabOrigin {
  /** Id of the tab the author drilled in from. */
  tabId: string;
  /** That tab's document path at the moment of the drill-in — what the strip prints. */
  documentPath: string | null;
}

export interface Tab {
  id: string;
  documentPath: string | null;
  fileHandle: FileSystemFileHandle | null;
  capabilities: { modes: string[] };
  /** Pinned tabs hold the head of their pane's strip, and a preview open never takes their slot. */
  pinned: boolean;
  /**
   * A PREVIEW tab is disposable: the next preview open in the same pane replaces it, and it renders
   * italic to say so. It stops being one the moment the author commits to it — an edit, a pin, a
   * double-click. The palette's `@`/`#` modes make browsing cheap, and browsing must not litter.
   */
  preview: boolean;
  scope: {
    stop: () => void;
    run: <T>(fn: () => T) => T | undefined;
    [k: string]: unknown;
  };
  doc: {
    document: JxMutableNode;
    content: { frontmatter: Record<string, unknown> };
    mode: string;
    sourceFormat: string | null;
    handlersSource: string | null;
    dirty: boolean;
  };
  session: {
    /**
     * The selected document paths, in the order the user built them (§6.5).
     *
     * `[]` is "nothing selected" — there is no `null` state, because "no selection" and "a
     * selection of nothing" were never two different things. `selection[0]` is the anchor a
     * shift-range extends from; the LAST entry is the primary, which every single-target surface
     * reads through `tabs/selection.ts`'s `primarySelection`. **Always assign a fresh array**:
     * several render effects track this with a bare property read and would miss an in-place push.
     */
    selection: (string | number)[][];
    hover: (string | number)[] | null;
    clipboard: JxMutableNode | null;
    /** The document this tab was drilled in from, if any. Rendered by the tab strip. */
    openedFrom: TabOrigin | null;
    ui: TabUi;
    canvas: {
      status: string;
      /**
       * A Refresh is out and the snapshot below has not come back yet.
       *
       * The button used to guess: fire the re-render, then `setTimeout(…, 200)` and repaint,
       * because nothing told the panel when the values had actually changed. A fetch slower than
       * 200ms repainted the OLD values and looked like a Refresh that did nothing. The iframe posts
       * `dataScope` when the render resolves, so the honest answer is to say "refreshing" until it
       * arrives and let the arrival be the repaint.
       */
      refreshing: boolean;
      // A serializable snapshot of the iframe's resolved `$defs` (data-source values), posted over
      // The bridge as a `dataScope` message and read by the data-explorer panel. Plain data now —
      // The old live `EffectScope` (with `.stop()`) moved into the iframe realm with buildScope.
      scope: Record<string, unknown> | null;
      // Latest live (iframe-evaluated) expression previews keyed by editing-target id, stored
      // Beside `scope` the same way (services/live-preview.ts owns reads/writes).
      livePreviews: Record<string, StoredLivePreview> | null;
      error: string | null;
      pendingInlineEdit: InlineEditDef | null;
    };
  };
  history: {
    snapshots: HistorySnapshot[];
    index: number;
  };
}

/**
 * @param {string} canvasMode — initial canvas mode (the tab's first allowed mode)
 * @param {boolean} preview — initial preview-toggle state
 * @returns {TabUi}
 */
function createDefaultUi(canvasMode: string, preview = false) {
  return {
    activeMedia: null,
    activeSelector: null,
    canvasMode,
    editZoom: 1,
    editingFormula: null,
    editingFunction: null,
    featureToggles: {},
    inspectorSections: {},
    pendingInlineEdit: null,
    preview,
    previewColorScheme: "auto" as const,
    previewLocale: null as string | null,
    previewParams: {},
    previewProps: null,
    rightTab: "properties",
    showLayout: true,
    styleFilter: "",
    styleSections: {},
    dataRows: {},
    dataLimits: {},
    styleShorthands: {},
    zoom: 1,
  };
}

/*
 * `git-diff` is here because a comparison is a MODE of a document, and until now nothing said so.
 * The Source Control panel reached it through the injected `setCanvasMode`, which performs no
 * capability check — so the mode worked while `editorKindsOf` could never report `diff`, the Editor
 * picker could never offer it, and `canvas.setMode { mode: "git-diff" }` threw for every document in
 * the project. Declaring it makes the palette, the assistant and the screenshot runner able to open
 * a comparison by name, and puts Diff on the Editor axis where §18.4 already says it belongs.
 */
const ALL_MODES = ["edit", "design", "preview", "source", "stylebook", "git-diff"];

/**
 * Create a new tab with reactive doc/session/history trees, owned by an effectScope.
 *
 * @param {{
 *   id: string;
 *   documentPath?: string | null;
 *   fileHandle?: FileSystemFileHandle | null;
 *   document: Record<string, unknown>;
 *   frontmatter?: Record<string, unknown>;
 *   sourceFormat?: string | null;
 *   capabilities?: { modes?: string[] };
 *   openedFrom?: TabOrigin | null;
 *   preview?: boolean;
 * }} opts
 * @returns {Tab}
 */
export function createTab({
  id,
  documentPath = null,
  fileHandle = null,
  document,
  frontmatter,
  sourceFormat = null,
  capabilities,
  openedFrom = null,
  preview: previewTab = false,
}: {
  id: string;
  documentPath?: string | null;
  fileHandle?: FileSystemFileHandle | null;
  document: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
  sourceFormat?: string | null;
  capabilities?: { modes?: string[] };
  openedFrom?: TabOrigin | null;
  preview?: boolean;
}) {
  const scope = effectScope();

  // Normalize legacy whole-children repeaters to the canonical array-member form before the doc
  // (and its first history checkpoint) are stored.
  normalizeArrayChildren(document);

  const resolvedModes = capabilities?.modes ?? inferModes(documentPath, sourceFormat);
  // A tab opens in its first allowed mode — never one the toolbar would disable.
  // Formats author mode order so the default comes first (edit, stylebook, etc.).
  // "preview" is a per-tab toggle rather than a base mode: a preview-first format opens
  // In its first non-preview mode with the toggle already on.
  const initialCanvasMode = resolvedModes.find((m) => m !== "preview") ?? "edit";
  const initialPreview = resolvedModes[0] === "preview";

  const tab = scope.run(() => ({
    capabilities: { modes: resolvedModes },
    doc: reactive({
      content: { frontmatter: frontmatter || {} },
      dirty: false,
      document,
      handlersSource: null,
      mode: inferDocumentMode(documentPath, sourceFormat),
      sourceFormat,
    }),
    documentPath,
    fileHandle,
    history: reactive({
      index: 0,
      snapshots: [{ document: structuredClone(document), selection: [] }],
    }),
    id,
    pinned: false,
    preview: previewTab,
    scope,
    session: reactive({
      canvas: {
        refreshing: false,
        error: null,
        livePreviews: null,
        pendingInlineEdit: null,
        scope: null,
        status: "idle",
      },
      clipboard: null,
      hover: null,
      openedFrom,
      selection: [],
      ui: createDefaultUi(initialCanvasMode, initialPreview),
    }),
  })) as unknown as Tab;

  return tab;
}

/**
 * Allowed modes for a document. "preview" in a format's mode list means the preview toggle is
 * Available for the tab (it is not a base canvas mode the toolbar switches to).
 *
 * @param {string | null | undefined} documentPath
 * @param {string | null} sourceFormat
 * @returns {string[]}
 */
function inferModes(documentPath: string | null | undefined, sourceFormat: string | null) {
  if (documentPath === PROJECT_CONFIG_PATH) {
    return ["stylebook", "source"];
  }
  const format = formatByName(sourceFormat) ?? formatForPath(documentPath);
  if (format) {
    return format.studio?.modes ?? ["edit", "design", "preview", "source"];
  }
  return ALL_MODES;
}

/**
 * Document mode for a new tab: format-class documents default to their $studio.documentMode
 * (content unless promoted to component); JSON is component.
 *
 * @param {string | null | undefined} documentPath
 * @param {string | null} sourceFormat
 * @returns {string}
 */
function inferDocumentMode(documentPath: string | null | undefined, sourceFormat: string | null) {
  const format = formatByName(sourceFormat) ?? formatForPath(documentPath);
  if (format) {
    return format.studio?.documentMode?.default ?? "content";
  }
  return "component";
}

// ─── Editor kinds ─────────────────────────────────────────────────────────────
// §4.2's first axis. `canvasMode` conflates two orthogonal questions — WHICH EDITOR is open, and
// (for the Canvas editor only) WHICH VIEW of it. The pane context bar labels them separately, and
// The pane model needs the first one on its own: the second pane is capped to non-Canvas kinds
// Until P8's `canvas-patcher` fan-out lands, because a second live `@jxsuite/runtime` host is the
// Expensive part.
//
// The mode → kind map itself is `commands/context.ts`'s `editorKindForMode`. It was duplicated
// Here, and the copy that drifted is what let a settings document resolve into the canvas key
// Scope; the pane model and the command context now read the same table.

/**
 * The editor kind a tab is currently showing. Reads the BASE mode: the preview toggle is a value on
 * the Canvas view axis, not a different editor.
 *
 * @param {Tab} tab
 * @returns {EditorKind}
 */
export function editorKindOf(tab: Tab): EditorKind {
  return editorKindForMode(tab.session.ui.canvasMode);
}

/**
 * Every editor kind this document supports, in the format's own mode order and deduplicated — the
 * dropdown's entries, so it can never contain a permanently dead one (§4.2).
 *
 * `preview` contributes nothing: it is a Canvas VIEW, and the kind it would add is already there.
 *
 * @param {Tab} tab
 * @returns {EditorKind[]}
 */
export function editorKindsOf(tab: Tab): EditorKind[] {
  const kinds: EditorKind[] = [];
  for (const mode of tab.capabilities.modes) {
    if (mode === "preview") {
      continue;
    }
    const kind = editorKindForMode(mode);
    if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  }
  return kinds;
}

/**
 * The first mode this tab supports that renders `kind`, or `undefined` when it supports none.
 *
 * The inverse of {@link editorKindOf}: choosing an editor kind has to land on a real `canvasMode`,
 * because that string is what the canvas render message carries.
 *
 * @param {Tab} tab
 * @param {EditorKind} kind
 * @returns {string | undefined}
 */
export function modeForEditorKind(tab: Tab, kind: EditorKind): string | undefined {
  return tab.capabilities.modes.find(
    (mode) => mode !== "preview" && editorKindForMode(mode) === kind,
  );
}

// ─── There is no sub-document stack ───────────────────────────────────────────
// A tab held one, and it was scaffolding for a navigation model the tab model replaced. `studio.md`
// §14.3 justified it for exactly two cases and both moved: a function body opens in the Bottom
// Dock's Logic tab (P8), and a `$map` template is a subtree of its parent document, selected in
// Place on the canvas rather than loaded as a document of its own. Everything with a file of its
// Own — a component, a layout — opens a REAL TAB with an `openedFrom` relationship (§14.1–2):
// {@link TabOrigin}, above, which nothing pops and nothing restores from.
//
// So `pushSubDocument` had no caller in `src/`, the stack was permanently `[]`, and every reader
// Below it — `popSubDocument`, `popToSubDocument`, the UI capture/restore pair, the pane-context
// Breadcrumb, the jump bar's `subdocument` segment, `document.setStackLevel`, collab's `drilled`
// Guard — was live code that could only ever take its empty branch. They are gone together: a
// Stack with no way in is not an unfinished feature, it is a shape the design moved past.

/**
 * Dispose a tab — stops its effectScope, killing all effects created within it.
 *
 * @param {Tab} tab
 */
export function disposeTab(tab: Tab) {
  tab.scope.stop();
}
