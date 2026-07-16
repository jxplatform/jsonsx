/// <reference lib="dom" />
import { effectScope, reactive } from "../reactivity";
import { formatByName, formatForPath } from "../format/format-host";
import { normalizeArrayChildren } from "../state";
import type {
  DocumentStackEntry,
  FormulaEditDef,
  FunctionEditDef,
  GitBranchesResult,
  GitDiffState,
  GitStatusResult,
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
  styleSections: Record<string, boolean>;
  inspectorSections: Record<string, boolean>;
  styleShorthands: Record<string, boolean>;
  styleFilter: string;
  styleFilterActive: boolean;
  stylebookSelection: string | null;
  stylebookTab: string;
  stylebookFilter: string;
  stylebookCustomizedOnly: boolean;
  settingsTab: string;
  gitStatus: GitStatusResult | null;
  gitBranches: GitBranchesResult | null;
  gitCommitMessage: string;
  gitLoading: boolean;
  gitError: string | null;
  gitDiffState: GitDiffState | null;
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
    documentStack: DocumentStackEntry[];
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
    gitBranches: null,
    gitCommitMessage: "",
    gitDiffState: null,
    gitError: null,
    gitLoading: false,
    gitStatus: null,
    inspectorSections: {},
    pendingInlineEdit: null,
    preview,
    previewParams: {},
    previewProps: null,
    rightTab: "properties",
    settingsTab: "stylebook",
    showLayout: true,
    styleFilter: "",
    styleFilterActive: false,
    styleSections: {},
    styleShorthands: {},
    stylebookCustomizedOnly: false,
    stylebookFilter: "",
    stylebookSelection: null,
    stylebookTab: "elements",
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
}: {
  id: string;
  documentPath?: string | null;
  fileHandle?: FileSystemFileHandle | null;
  document: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
  sourceFormat?: string | null;
  capabilities?: { modes?: string[] };
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

/**
 * Dispose a tab — stops its effectScope, killing all effects created within it.
 *
 * @param {Tab} tab
 */
export function disposeTab(tab: Tab) {
  tab.scope.stop();
}
