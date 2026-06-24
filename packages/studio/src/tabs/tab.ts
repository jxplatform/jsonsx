/// <reference lib="dom" />
import { effectScope, reactive } from "../reactivity";
import { formatByName, formatForPath } from "../format/format-host";
import { normalizeArrayChildren } from "../state";
import type {
  DocumentStackEntry,
  FunctionEditDef,
  GitBranchesResult,
  GitDiffState,
  GitStatusResult,
  InlineEditDef,
} from "../types";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxDocOp } from "./patch-ops";

export interface TabUi {
  rightTab: string;
  canvasMode: string;
  zoom: number;
  activeMedia: string | null;
  activeSelector: string | null;
  editingFunction: FunctionEditDef | null;
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
      scope: { stop: () => void; [k: string]: unknown } | null;
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
 * @returns {TabUi}
 */
function createDefaultUi(canvasMode: string) {
  return {
    activeMedia: null,
    activeSelector: null,
    canvasMode,
    editingFunction: null,
    featureToggles: {},
    gitBranches: null,
    gitCommitMessage: "",
    gitDiffState: null,
    gitError: null,
    gitLoading: false,
    gitStatus: null,
    inspectorSections: {},
    pendingInlineEdit: null,
    rightTab: "properties",
    settingsTab: "stylebook",
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
  const initialCanvasMode = resolvedModes[0] ?? "edit";

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
        pendingInlineEdit: null,
        scope: null,
        status: "idle",
      },
      clipboard: null,
      documentStack: [],
      hover: null,
      selection: null,
      ui: createDefaultUi(initialCanvasMode),
    }),
  })) as unknown as Tab;

  return tab;
}

/**
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
