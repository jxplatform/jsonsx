import { reactive, effectScope } from "../reactivity.js";

/**
 * @typedef {{
 *   leftTab: string;
 *   rightTab: string;
 *   zoom: number;
 *   activeMedia: string | null;
 *   activeSelector: string | null;
 *   editingFunction: object | null;
 *   featureToggles: Record<string, boolean>;
 *   styleSections: Record<string, boolean>;
 *   inspectorSections: Record<string, boolean>;
 *   styleShorthands: Record<string, boolean>;
 *   styleFilter: string;
 *   styleFilterActive: boolean;
 *   stylebookSelection: string | null;
 *   stylebookTab: string;
 *   stylebookFilter: string;
 *   stylebookCustomizedOnly: boolean;
 *   settingsTab: string;
 *   gitStatus: object | null;
 *   gitBranches: object | null;
 *   gitCommitMessage: string;
 *   gitLoading: boolean;
 *   gitError: string | null;
 *   pendingInlineEdit: object | null;
 * }} TabUi
 */

/**
 * @typedef {{
 *   document: Record<string, any>;
 *   selection: (string | number)[] | null;
 * }} HistorySnapshot
 */

/**
 * @typedef {{
 *   id: string;
 *   documentPath: string | null;
 *   fileHandle: FileSystemFileHandle | null;
 *   scope: { stop(): void; run<T>(fn: () => T): T | undefined; [k: string]: any };
 *   doc: {
 *     document: Record<string, any>;
 *     content: { frontmatter: Record<string, unknown> };
 *     mode: string;
 *     sourceFormat: string | null;
 *     handlersSource: string | null;
 *     dirty: boolean;
 *   };
 *   session: {
 *     selection: (string | number)[] | null;
 *     hover: (string | number)[] | null;
 *     clipboard: object | null;
 *     documentStack: object[];
 *     ui: TabUi;
 *     canvas: {
 *       status: string;
 *       scope: { stop(): void; [k: string]: any } | null;
 *       error: string | null;
 *       pendingInlineEdit: object | null;
 *     };
 *   };
 *   history: {
 *     snapshots: HistorySnapshot[];
 *     index: number;
 *   };
 * }} Tab
 */

/** @returns {TabUi} */
function createDefaultUi() {
  return {
    leftTab: "layers",
    rightTab: "properties",
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
    pendingInlineEdit: null,
  };
}

/**
 * Create a new tab with reactive doc/session/history trees, owned by an effectScope.
 *
 * @param {{
 *   id: string;
 *   documentPath?: string | null;
 *   fileHandle?: FileSystemFileHandle | null;
 *   document: Record<string, any>;
 *   frontmatter?: Record<string, unknown>;
 *   sourceFormat?: string | null;
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
}) {
  const scope = effectScope();

  const tab = /** @type {Tab} */ (
    scope.run(() => ({
      id,
      documentPath,
      fileHandle,
      scope,
      doc: reactive({
        document,
        sourceFormat,
        content: { frontmatter: frontmatter || {} },
        mode:
          sourceFormat === "md"
            ? "content"
            : documentPath?.endsWith(".md")
              ? "content"
              : "component",
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
    }))
  );

  return tab;
}

/**
 * Dispose a tab — stops its effectScope, killing all effects created within it.
 *
 * @param {Tab} tab
 */
export function disposeTab(tab) {
  tab.scope.stop();
}
