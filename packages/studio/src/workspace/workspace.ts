import { computed, reactive, toRaw } from "../reactivity";
import { ensureCollab, rekeyCollab } from "../collab/collab-session";
import { createTab, disposeTab } from "../tabs/tab";
import type { Tab } from "../tabs/tab";

import type { ComponentEntry } from "../files/components";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";
import type { ComputedRef } from "@vue/reactivity";

interface FileEntry {
  name: string;
  path: string;
  type: string;
}

export interface Workspace {
  projectRoot: string | null;
  projectConfig: object | null;
  componentRegistry: ComponentEntry[];
  clipboard: JxMutableNode | null;
  styleClipboard: JxStyle | null;
  fileTree: {
    dirs: Map<string, FileEntry[]>;
    expanded: Set<string>;
    selectedPath: string | null;
    searchQuery: string;
  };
  tabs: Map<string, Tab>;
  tabOrder: string[];
  activeTabId: string | null;
  ui: { activityBar: string };
}

// Annotated as Workspace: Vue's UnwrapNestedRefs cannot terminate on the
// Recursive document types, and reactive() does not unwrap refs we never use.
export const workspace: Workspace = reactive({
  activeTabId: null as string | null,
  clipboard: null as JxMutableNode | null,
  componentRegistry: [] as ComponentEntry[],
  fileTree: {
    dirs: new Map<string, FileEntry[]>(),
    expanded: new Set<string>(),
    searchQuery: "",
    selectedPath: null as string | null,
  },
  projectConfig: null as object | null,
  projectRoot: null as string | null,
  styleClipboard: null as JxStyle | null,
  tabOrder: [] as string[],
  tabs: new Map<string, Tab>(),
  ui: {
    activityBar: "files",
  },
}) as unknown as Workspace;

export const activeTab = computed(() =>
  workspace.activeTabId ? (workspace.tabs.get(workspace.activeTabId) ?? null) : null,
) as unknown as ComputedRef<Tab | null>;

/**
 * Record the open project on the reactive workspace. `root` must be the absolute project root (the
 * same value `createProject` returns and the pending-agent-prompt handoff is keyed by) — not the
 * "."-relative root projectState sometimes holds. Consumers: AI session scoping, system-prompt
 * project context, and the chat panel's pending-prompt effect.
 *
 * @param {string | null} root
 * @param {object | null} [config]
 */
export function setWorkspaceProject(root: string | null, config: object | null = null) {
  workspace.projectRoot = root;
  workspace.projectConfig = config;
}

/**
 * Whether `tab` is the active tab. Identity check survives reactive-proxy wrapping (activeTab.value
 * is a proxy; callers may hold either the raw tab or a proxy of it).
 *
 * @param {Tab | null} tab
 */
export function isTabActive(tab: Tab | null): boolean {
  const active = activeTab.value;
  return (
    tab !== null && active !== null && toRaw(active as object) === toRaw(tab as unknown as object)
  );
}

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
  ensureCollab(tab);
  return tab;
}

/**
 * Close a tab and dispose its scope. Activates the last remaining tab if the closed tab was active.
 *
 * @param {string} tabId
 */
export function closeTab(tabId: string) {
  const tab = workspace.tabs.get(tabId);
  if (!tab) {
    return;
  }
  disposeTab(tab);
  workspace.tabs.delete(tabId);
  workspace.tabOrder = workspace.tabOrder.filter((id) => id !== tabId);
  if (workspace.activeTabId === tabId) {
    workspace.activeTabId = workspace.tabOrder.at(-1) || null;
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
  ensureCollab(newTab);

  for (const id of oldIds) {
    if (id === newTab.id) {
      continue;
    }
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
  if (workspace.tabs.has(tabId)) {
    workspace.activeTabId = tabId;
  }
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
  if (!tab) {
    return;
  }
  tab.id = newId;
  tab.documentPath = newDocumentPath;
  workspace.tabs.delete(oldId);
  workspace.tabs.set(newId, tab);
  workspace.tabOrder = workspace.tabOrder.map((id) => (id === oldId ? newId : id));
  if (workspace.activeTabId === oldId) {
    workspace.activeTabId = newId;
  }
  rekeyCollab(tab);
}
