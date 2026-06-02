import { reactive, computed } from "../reactivity";
import { createTab, disposeTab } from "../tabs/tab";
import type { Tab } from "../tabs/tab";

import type { ComponentEntry } from "../files/components";
import type { JxStyle, JxMutableNode } from "@jxsuite/schema/types";

interface FileEntry {
  name: string;
  path: string;
  type: string;
}

export const workspace = reactive({
  /** @type {string | null} */
  projectRoot: null as string | null,
  /** @type {object | null} */
  projectConfig: null as object | null,
  /** @type {ComponentEntry[]} */
  componentRegistry: [] as ComponentEntry[],
  /** @type {JxMutableNode | null} */
  clipboard: null as JxMutableNode | null,
  /** @type {JxStyle | null} */
  styleClipboard: null as JxStyle | null,
  fileTree: {
    /** @type {Map<string, FileEntry[]>} */
    dirs: new Map<string, FileEntry[]>(),
    /** @type {Set<string>} */
    expanded: new Set<string>(),
    /** @type {string | null} */
    selectedPath: null as string | null,
    searchQuery: "",
  },
  /** @type {Map<string, Tab>} */
  tabs: new Map<string, Tab>(),
  /** @type {string[]} */
  tabOrder: [] as string[],
  /** @type {string | null} */
  activeTabId: null as string | null,
  ui: {
    activityBar: "files",
  },
});

export const activeTab = computed(() =>
  workspace.activeTabId ? (workspace.tabs.get(workspace.activeTabId) ?? null) : null,
) as unknown as import("@vue/reactivity").ComputedRef<Tab | null>;

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
export function openTab(opts: {
  id: string;
  documentPath?: string | null;
  fileHandle?: FileSystemFileHandle | null;
  document: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
  sourceFormat?: string | null;
  capabilities?: { modes?: string[] };
}) {
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
export function closeTab(tabId: string) {
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
export function replaceAllTabs(newTabOpts: {
  id: string;
  documentPath?: string | null;
  document: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
  sourceFormat?: string | null;
}) {
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
export function activateTab(tabId: string) {
  if (workspace.tabs.has(tabId)) workspace.activeTabId = tabId;
}

/**
 * Re-key a tab after its backing file has been renamed. Preserves all tab state including unsaved
 * changes.
 *
 * @param {string} oldId
 * @param {string} newId
 * @param {string} newDocumentPath
 */
export function renameTab(oldId: string, newId: string, newDocumentPath: string) {
  const tab = workspace.tabs.get(oldId);
  if (!tab) return;
  tab.id = newId;
  tab.documentPath = newDocumentPath;
  workspace.tabs.delete(oldId);
  workspace.tabs.set(newId, tab);
  workspace.tabOrder = workspace.tabOrder.map((id) => (id === oldId ? newId : id));
  if (workspace.activeTabId === oldId) workspace.activeTabId = newId;
}
