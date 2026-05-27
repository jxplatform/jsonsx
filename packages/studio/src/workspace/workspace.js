import { reactive, computed } from "../reactivity.js";
import { createTab, disposeTab } from "../tabs/tab.js";

/**
 * @typedef {import("../tabs/tab.js").Tab} Tab
 *
 * @typedef {import("../files/components.js").ComponentEntry} ComponentEntry
 *
 * @typedef {{ name: string; path: string; type: string }} FileEntry
 */

export const workspace = reactive({
  /** @type {string | null} */
  projectRoot: null,
  /** @type {object | null} */
  projectConfig: null,
  /** @type {ComponentEntry[]} */
  componentRegistry: [],
  /** @type {JxMutableNode | null} */
  clipboard: null,
  /** @type {JxStyle | null} */
  styleClipboard: null,
  fileTree: {
    /** @type {Map<string, FileEntry[]>} */
    dirs: new Map(),
    /** @type {Set<string>} */
    expanded: new Set(),
    /** @type {string | null} */
    selectedPath: null,
    searchQuery: "",
  },
  /** @type {Map<string, Tab>} */
  tabs: new Map(),
  /** @type {string[]} */
  tabOrder: [],
  /** @type {string | null} */
  activeTabId: null,
  ui: {
    activityBar: "files",
  },
});

/** @type {import("@vue/reactivity").ComputedRef<Tab>} */
export const activeTab = /** @type {import("@vue/reactivity").ComputedRef<Tab>} */ (
  /** @type {unknown} */ (
    computed(() =>
      workspace.activeTabId ? (workspace.tabs.get(workspace.activeTabId) ?? null) : null,
    )
  )
);

/**
 * Open a new tab and make it active.
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
export function openTab(opts) {
  const tab = createTab(opts);
  workspace.tabs.set(tab.id, tab);
  workspace.tabOrder.push(tab.id);
  workspace.activeTabId = tab.id;
  return tab;
}

/**
 * Close a tab and dispose its scope. Activates the last remaining tab if the closed tab was active.
 *
 * @param {string} tabId
 */
export function closeTab(tabId) {
  const tab = workspace.tabs.get(tabId);
  if (!tab) return;
  disposeTab(tab);
  workspace.tabs.delete(tabId);
  workspace.tabOrder = workspace.tabOrder.filter((id) => id !== tabId);
  if (workspace.activeTabId === tabId) {
    workspace.activeTabId = workspace.tabOrder[workspace.tabOrder.length - 1] || null;
  }
}

/** Close all open tabs, disposing each. Defers reactivity until fully cleared. */
export function closeAllTabs() {
  const tabs = [...workspace.tabs.values()];
  workspace.tabs.clear();
  workspace.tabOrder = [];
  workspace.activeTabId = null;
  for (const tab of tabs) {
    disposeTab(tab);
  }
}

/**
 * Replace all existing tabs with a new one atomically. Ensures activeTab is never null during the
 * transition.
 *
 * @param {{
 *   id: string;
 *   documentPath?: string | null;
 *   document: Record<string, unknown>;
 *   frontmatter?: Record<string, unknown>;
 *   sourceFormat?: string | null;
 * }} newTabOpts
 * @returns {import("../tabs/tab.js").Tab}
 */
export function replaceAllTabs(newTabOpts) {
  const oldIds = [...workspace.tabs.keys()];
  const oldTabs = [...workspace.tabs.values()];

  const newTab = createTab(newTabOpts);
  workspace.tabs.set(newTab.id, newTab);
  workspace.activeTabId = newTab.id;
  workspace.tabOrder = [newTab.id];

  for (const id of oldIds) {
    if (id === newTab.id) continue;
    workspace.tabs.delete(id);
  }
  for (const tab of oldTabs) {
    disposeTab(tab);
  }

  return newTab;
}

/**
 * Switch to an existing tab.
 *
 * @param {string} tabId
 */
export function activateTab(tabId) {
  if (workspace.tabs.has(tabId)) workspace.activeTabId = tabId;
}
