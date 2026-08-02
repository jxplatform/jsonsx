/// <reference lib="dom" />
import { effectScope, reactive } from "../reactivity";
import { formatByName, formatForPath } from "../format/format-host";
import { normalizeArrayChildren } from "../state";
import type {
  DocumentStackEntry,
  FormulaEditDef,
  FunctionEditDef,
  InlineEditDef,
  JsonValue,
} from "../types";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxDocOp, JxFmOp } from "./patch-ops";

export interface TabUi {
  rightTab: string;
  canvasMode: string;
  /** Preview toggle — composes with an edit/design canvasMode; the effective mode becomes "preview". */
  preview: boolean;
  /** Show elements inherited from the page's layout (pages with an effective layout only). */
  showLayout: boolean;
  /** Above-canvas frontmatter Properties accordion expanded (content-collection docs, edit mode). */
  frontmatterOpen: boolean;
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
  /** Full-screen formula workspace target ($expression editing); editingFunction wins if both set. */
  editingFormula: FormulaEditDef | null;
  featureToggles: Record<string, boolean>;
  /**
   * Canvas color-scheme preview: follow the OS ("auto") or force a scheme. Drives the
   * data-color-scheme attribute on the canvas iframe root (spec §9.5) and, in the style sidebar,
   * which scheme layer edits target.
   */
  previewColorScheme: "auto" | "light" | "dark";
  styleSections: Record<string, boolean>;
  inspectorSections: Record<string, boolean>;
  styleShorthands: Record<string, boolean>;
  styleFilter: string;
  styleFilterActive: boolean;
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
  /** Selection after this state's transaction. */
  selection: (string | number)[] | null;
  /** Selection before this state's transaction (restored on surgical undo). */
  selectionBefore?: (string | number)[] | null;
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

/**
 * A per-tab UI context snapshot, taken when a genuine SUB-DOCUMENT is pushed.
 *
 * The whole {@link TabUi} is captured, not just the document coordinates: popping back has to
 * restore WHERE YOU WERE — the breakpoint you were previewing (`activeMedia`), the pseudo-selector
 * you were styling (`activeSelector`), the inspector tab you had open (`rightTab`) and your `zoom`
 * — not merely which document you were looking at.
 */
export type TabUiSnapshot = TabUi;

/** One frame of the sub-document stack: the parent's document coordinates AND its UI context. */
export interface SubDocumentFrame extends DocumentStackEntry {
  ui: TabUiSnapshot;
}

/** The sub-document being entered. `$map` templates and function editors are the real cases. */
export interface SubDocument {
  document: JxMutableNode;
  documentPath: string | null;
  mode?: string | null;
  sourceFormat?: string | null;
}

export interface Tab {
  id: string;
  documentPath: string | null;
  fileHandle: FileSystemFileHandle | null;
  capabilities: { modes: string[] };
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
    selection: (string | number)[] | null;
    hover: (string | number)[] | null;
    clipboard: JxMutableNode | null;
    /**
     * Genuine sub-documents only — `$map` templates and function editors. Drilling into a component
     * is NOT one of them: it opens its own tab.
     */
    documentStack: SubDocumentFrame[];
    /** The document this tab was drilled in from, if any. Rendered by the tab strip. */
    openedFrom: TabOrigin | null;
    ui: TabUi;
    canvas: {
      status: string;
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
    frontmatterOpen: true,
    inspectorSections: {},
    pendingInlineEdit: null,
    preview,
    previewColorScheme: "auto" as const,
    previewParams: {},
    previewProps: null,
    rightTab: "properties",
    showLayout: true,
    styleFilter: "",
    styleFilterActive: false,
    styleSections: {},
    styleShorthands: {},
    zoom: 1,
  };
}

const ALL_MODES = ["edit", "design", "preview", "source", "stylebook"];

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
}: {
  id: string;
  documentPath?: string | null;
  fileHandle?: FileSystemFileHandle | null;
  document: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
  sourceFormat?: string | null;
  capabilities?: { modes?: string[] };
  openedFrom?: TabOrigin | null;
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
      snapshots: [{ document: structuredClone(document), selection: null }],
    }),
    id,
    scope,
    session: reactive({
      canvas: {
        error: null,
        livePreviews: null,
        pendingInlineEdit: null,
        scope: null,
        status: "idle",
      },
      clipboard: null,
      documentStack: [],
      hover: null,
      openedFrom,
      selection: null,
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
  if (documentPath === "project.json") {
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

// ─── Sub-documents ────────────────────────────────────────────────────────────
// A sub-document is a document that has no file of its own — a `$map` template, a function body —
// So it cannot become a tab. Everything that DOES have a file (a component, a layout) opens a real
// Tab instead; see `workspace/workspace.ts`. That split is the whole point: the stack used to be
// How drill-in worked, which is why it rewrote `tab.documentPath` and left `tab.id` behind.

/**
 * Copy a UI context out of a (reactive) tab.
 *
 * The nested records are copied too. A shallow spread would hand the frame the LIVE `previewParams`
 * / `featureToggles` objects, so editing a breakpoint toggle inside the sub-document would silently
 * rewrite the parent's snapshot — the restore would then be a no-op and the bug would read as
 * "popping back forgot my breakpoint".
 *
 * @param {TabUi} ui
 * @returns {TabUiSnapshot}
 */
export function captureTabUi(ui: TabUi): TabUiSnapshot {
  return {
    ...ui,
    featureToggles: { ...ui.featureToggles },
    inspectorSections: { ...ui.inspectorSections },
    previewParams: { ...ui.previewParams },
    previewProps: ui.previewProps ? { ...ui.previewProps } : null,
    styleSections: { ...ui.styleSections },
    styleShorthands: { ...ui.styleShorthands },
  };
}

/**
 * Write a UI snapshot back onto a tab.
 *
 * Assigns INTO the existing reactive object rather than replacing it, so every effect already
 * tracking `session.ui` sees the change.
 *
 * @param {Tab} tab
 * @param {TabUiSnapshot} snapshot
 */
export function restoreTabUi(tab: Tab, snapshot: TabUiSnapshot) {
  Object.assign(tab.session.ui, captureTabUi(snapshot));
}

/**
 * Enter a sub-document: push the current document AND UI context, then load `next`.
 *
 * @param {Tab} tab
 * @param {SubDocument} next
 * @returns {SubDocumentFrame} The frame that was pushed
 */
export function pushSubDocument(tab: Tab, next: SubDocument): SubDocumentFrame {
  const frame: SubDocumentFrame = {
    dirty: tab.doc.dirty,
    document: tab.doc.document,
    documentPath: tab.documentPath,
    mode: tab.doc.mode,
    selection: tab.session.selection,
    sourceFormat: tab.doc.sourceFormat,
    ui: captureTabUi(tab.session.ui),
  };
  tab.session.documentStack.push(frame);
  tab.doc.document = next.document;
  tab.doc.dirty = false;
  tab.doc.mode = (next.mode ?? null) as unknown as string;
  tab.doc.sourceFormat = next.sourceFormat ?? null;
  tab.documentPath = next.documentPath;
  tab.session.selection = null;
  return frame;
}

/**
 * Put a frame's document coordinates and UI context back on the tab.
 *
 * @param {Tab} tab
 * @param {SubDocumentFrame} frame
 */
function restoreFrame(tab: Tab, frame: SubDocumentFrame) {
  tab.doc.document = frame.document;
  tab.doc.dirty = Boolean(frame.dirty);
  tab.doc.mode = frame.mode as string;
  tab.doc.sourceFormat = frame.sourceFormat ?? null;
  tab.documentPath = frame.documentPath;
  tab.session.selection = frame.selection;
  restoreTabUi(tab, frame.ui);
}

/**
 * Leave the innermost sub-document, restoring the frame beneath it.
 *
 * @param {Tab} tab
 * @returns {SubDocumentFrame | undefined} The restored frame, or undefined when the stack is empty
 */
export function popSubDocument(tab: Tab): SubDocumentFrame | undefined {
  const frame = tab.session.documentStack.pop();
  if (!frame) {
    return undefined;
  }
  restoreFrame(tab, frame);
  return frame;
}

/**
 * Jump straight to a breadcrumb level, discarding every frame above it.
 *
 * @param {Tab} tab
 * @param {number} index
 * @returns {SubDocumentFrame | undefined} The restored frame, or undefined when `index` is out of
 *   range
 */
export function popToSubDocument(tab: Tab, index: number): SubDocumentFrame | undefined {
  const stack = tab.session.documentStack;
  if (index < 0 || index >= stack.length) {
    return undefined;
  }
  const frame = stack[index]!;
  tab.session.documentStack = stack.slice(0, index);
  restoreFrame(tab, frame);
  return frame;
}

/**
 * Dispose a tab — stops its effectScope, killing all effects created within it.
 *
 * @param {Tab} tab
 */
export function disposeTab(tab: Tab) {
  tab.scope.stop();
}
