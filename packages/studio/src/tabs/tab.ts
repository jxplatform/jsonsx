/// <reference lib="dom" />
import { reactive, effectScope } from "../reactivity";
import type {
  GitDiffState,
  InlineEditDef,
  FunctionEditDef,
  DocumentStackEntry,
  GitStatusResult,
  GitBranchesResult,
} from "../types";
import type { JxMutableNode } from "@jxsuite/schema/types";

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
  document: Record<string, unknown>;
  selection: (string | number)[] | null;
}

export interface Tab {
  id: string;
  documentPath: string | null;
  fileHandle: FileSystemFileHandle | null;
  capabilities: { modes: string[] };
  scope: { stop(): void; run<T>(fn: () => T): T | undefined; [k: string]: unknown };
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
      scope: { stop(): void; [k: string]: unknown } | null;
      error: string | null;
      pendingInlineEdit: InlineEditDef | null;
    };
  };
  history: {
    snapshots: HistorySnapshot[];
    index: number;
  };
}

/** @returns {TabUi} */
function createDefaultUi() {
  return {
    rightTab: "properties",
    canvasMode: "edit",
    zoom: 1,
    activeMedia: null,
    activeSelector: null,
    editingFunction: null,
    featureToggles: {},
    styleSections: {},
    inspectorSections: {},
    styleShorthands: {},
    styleFilter: "",
    styleFilterActive: false,
    stylebookSelection: null,
    stylebookTab: "elements",
    stylebookFilter: "",
    stylebookCustomizedOnly: false,
    settingsTab: "stylebook",
    gitStatus: null,
    gitBranches: null,
    gitCommitMessage: "",
    gitLoading: false,
    gitError: null,
    gitDiffState: null,
    pendingInlineEdit: null,
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

  const resolvedModes = capabilities?.modes ?? inferModes(documentPath, sourceFormat);

  const tab = scope.run(() => ({
    id,
    documentPath,
    fileHandle,
    capabilities: { modes: resolvedModes },
    scope,
    doc: reactive({
      document,
      sourceFormat,
      content: { frontmatter: frontmatter || {} },
      mode:
        sourceFormat === "md" ? "content" : documentPath?.endsWith(".md") ? "content" : "component",
      handlersSource: null,
      dirty: false,
    }),
    session: reactive({
      selection: null,
      hover: null,
      clipboard: null,
      documentStack: [],
      ui: createDefaultUi(),
      canvas: { status: "idle", scope: null, error: null, pendingInlineEdit: null },
    }),
    history: reactive({
      snapshots: [{ document: structuredClone(document), selection: null }],
      index: 0,
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
  if (documentPath === "project.json") return ["stylebook", "source"];
  if (sourceFormat === "md" || documentPath?.endsWith(".md"))
    return ["edit", "design", "preview", "source"];
  return ALL_MODES;
}

/**
 * Dispose a tab — stops its effectScope, killing all effects created within it.
 *
 * @param {Tab} tab
 */
export function disposeTab(tab: Tab) {
  tab.scope.stop();
}
