import { computed, reactive, toRaw } from "../reactivity";
import { ensureCollab, rekeyCollab } from "../collab/collab-session";
import { createTab, disposeTab } from "../tabs/tab";
import { projectState } from "../state";
import type { Tab, TabOrigin } from "../tabs/tab";

import type { ComponentEntry } from "../files/components";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";
import type { ComputedRef } from "@vue/reactivity";

interface FileEntry {
  name: string;
  path: string;
  type: string;
}

/** A tab that was closed, kept so `⌘⇧T` can bring it back. Only file-backed tabs qualify. */
export interface ClosedTabRecord {
  documentPath: string;
}

/** How many closed tabs `⌘⇧T` can walk back through. */
const CLOSED_TAB_LIMIT = 20;

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
  /** Left-to-right order in the strip. */
  tabOrder: string[];
  /**
   * Most-recently-used order, newest first. `⌃Tab` walks this, NOT {@link Workspace.tabOrder} — "the
   * tab I was just in" is the one people reach for, and it is rarely the one to the left.
   */
  mruOrder: string[];
  activeTabId: string | null;
  /** Newest first. `⌘⇧T` pops this. */
  closedTabs: ClosedTabRecord[];
  ui: { activityBar: string };
}

// Annotated as Workspace: Vue's UnwrapNestedRefs cannot terminate on the
// Recursive document types, and reactive() does not unwrap refs we never use.
export const workspace: Workspace = reactive({
  activeTabId: null as string | null,
  clipboard: null as JxMutableNode | null,
  closedTabs: [] as ClosedTabRecord[],
  componentRegistry: [] as ComponentEntry[],
  mruOrder: [] as string[],
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
 * Move `tabId` to the front of the MRU list.
 *
 * @param {string} tabId
 */
function promoteMru(tabId: string) {
  workspace.mruOrder = [tabId, ...workspace.mruOrder.filter((id) => id !== tabId)];
}

/*
 * ⌃Tab cycling holds a frozen snapshot of the MRU list for the duration of the cycle.
 *
 * Without it, the first ⌃Tab would promote the tab it landed on and the second press would come
 * straight back — the classic "the shortcut only ever toggles between two tabs" bug. The cycle ends
 * at {@link endTabCycle} (the modifier release) or at the next ordinary activation, and only then
 * does the tab the author settled on become the most recent.
 */
let _cycleList: string[] | null = null;

let _cycleIndex = 0;

/** Abandon any in-flight ⌃Tab cycle without promoting anything. */
function resetTabCycle() {
  _cycleList = null;
  _cycleIndex = 0;
}

/**
 * Point the file tree at the tab the author is now in.
 *
 * The tree and the strip disagreeing about "where am I" is the same class of defect as the tab id
 * disagreeing with its path: two surfaces answering one question two ways.
 *
 * @param {Tab} tab
 */
function syncTreeSelection(tab: Tab) {
  if (projectState && tab.documentPath) {
    projectState.selectedPath = tab.documentPath;
  }
}

/**
 * Make `tabId` the active tab. The one place activation happens.
 *
 * @param {string} tabId
 * @param {{ cycling?: boolean }} [opts] — `cycling` suppresses MRU promotion (see {@link cycleTab})
 */
function setActiveTab(tabId: string, opts: { cycling?: boolean } = {}) {
  const tab = workspace.tabs.get(tabId);
  if (!tab) {
    return;
  }
  workspace.activeTabId = tabId;
  if (!opts.cycling) {
    resetTabCycle();
    promoteMru(tabId);
  }
  syncTreeSelection(tab);
}

/**
 * Open a new tab and make it active.
 *
 * Re-opening an id that is already open REPLACES it: the previous tab is disposed and its slot in
 * the strip is reused. It used to be overwritten in the map while its effect scope leaked and a
 * SECOND copy of the id was pushed into `tabOrder`, which is what produced duplicate lit `repeat`
 * keys. Callers that mean "show me this file" should use `files/files.ts`'s `openFileInTab`, which
 * activates the existing tab instead.
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
export function openTab(opts: {
  id: string;
  documentPath?: string | null;
  fileHandle?: FileSystemFileHandle | null;
  document: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
  sourceFormat?: string | null;
  capabilities?: { modes?: string[] };
  openedFrom?: TabOrigin | null;
}) {
  const previous = workspace.tabs.get(opts.id);
  const tab = createTab(opts);
  if (previous) {
    disposeTab(previous);
  } else {
    workspace.tabOrder.push(tab.id);
  }
  workspace.tabs.set(tab.id, tab);
  setActiveTab(tab.id);
  ensureCollab(tab);
  return tab;
}

/**
 * Close a tab and dispose its scope. Activates the most recently used remaining tab.
 *
 * @param {string} tabId
 */
export function closeTab(tabId: string) {
  const tab = workspace.tabs.get(tabId);
  if (!tab) {
    return;
  }
  rememberClosedTab(tab);
  disposeTab(tab);
  workspace.tabs.delete(tabId);
  workspace.tabOrder = workspace.tabOrder.filter((id) => id !== tabId);
  workspace.mruOrder = workspace.mruOrder.filter((id) => id !== tabId);
  resetTabCycle();
  if (workspace.activeTabId === tabId) {
    // The MRU list, not the strip order: closing a tab should land you on the one you were in
    // Before it, which is almost never the rightmost tab in the strip.
    const next = workspace.mruOrder[0] ?? workspace.tabOrder.at(-1) ?? null;
    workspace.activeTabId = next;
    if (next) {
      setActiveTab(next);
    }
  }
}

/** Close all open tabs, disposing each. Defers reactivity until fully cleared. */
export function closeAllTabs() {
  const tabs = [...workspace.tabs.values()];
  workspace.tabs.clear();
  workspace.tabOrder = [];
  workspace.mruOrder = [];
  workspace.activeTabId = null;
  resetTabCycle();
  for (const tab of tabs) {
    disposeTab(tab);
  }
}

// ─── Reopen closed ────────────────────────────────────────────────────────────

/**
 * Record a closing tab so `⌘⇧T` can bring it back.
 *
 * Only file-backed tabs are recorded: a virtual grid tab or an untitled document has nothing to
 * re-read, so offering to reopen it would be a lie.
 *
 * @param {Tab} tab
 */
function rememberClosedTab(tab: Tab) {
  if (!tab.documentPath) {
    return;
  }
  const path = tab.documentPath;
  workspace.closedTabs = [
    { documentPath: path },
    ...workspace.closedTabs.filter((entry) => entry.documentPath !== path),
  ].slice(0, CLOSED_TAB_LIMIT);
}

/**
 * Take the most recently closed document path off the stack.
 *
 * Returns the path rather than opening it: reading and parsing a file belongs to `files/files.ts`,
 * and this module deliberately owns no I/O.
 *
 * @returns {string | undefined}
 */
export function takeClosedTabPath(): string | undefined {
  const [entry] = workspace.closedTabs;
  if (!entry) {
    return undefined;
  }
  workspace.closedTabs = workspace.closedTabs.slice(1);
  return entry.documentPath;
}

// ─── MRU cycling ──────────────────────────────────────────────────────────────

/**
 * Walk the MRU list by `step` and activate what it lands on, without reordering it.
 *
 * @param {number} step — +1 for `⌃Tab`, -1 for `⌃⇧Tab`
 * @returns {string | undefined} The id activated, or undefined with fewer than two tabs
 */
export function cycleTab(step: number): string | undefined {
  if (!_cycleList) {
    _cycleList = workspace.mruOrder.filter((id) => workspace.tabs.has(id));
    _cycleIndex = 0;
  }
  const list = _cycleList;
  if (list.length < 2) {
    return undefined;
  }
  _cycleIndex = (((_cycleIndex + step) % list.length) + list.length) % list.length;
  const id = list[_cycleIndex]!;
  setActiveTab(id, { cycling: true });
  return id;
}

/** End a ⌃Tab cycle — the modifier came up, so the tab the author settled on is now the recent one. */
export function endTabCycle() {
  const settled = workspace.activeTabId;
  resetTabCycle();
  if (settled) {
    promoteMru(settled);
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
  workspace.tabOrder = [newTab.id];
  workspace.mruOrder = [];
  resetTabCycle();
  setActiveTab(newTab.id);
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
 * Activation also points the file tree at the tab's document and promotes it in the MRU list — the
 * strip, the tree and `⌃Tab` all read the same answer to "where am I".
 *
 * @param {string} tabId
 */
export function activateTab(tabId: string) {
  setActiveTab(tabId);
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
  workspace.mruOrder = workspace.mruOrder.map((id) => (id === oldId ? newId : id));
  resetTabCycle();
  if (workspace.activeTabId === oldId) {
    workspace.activeTabId = newId;
  }
  rekeyCollab(tab);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** What the tab commands need from the rest of Studio. */
export interface TabCommandDeps {
  /** Read a file from disk and show it — `files/files.ts`'s `openFileInTab`. */
  openFile: (path: string) => void | Promise<void>;
}

/**
 * The tab-navigation commands, defined next to the model they drive.
 *
 * They live here rather than in `commands/defaults.ts` because a capability's record belongs beside
 * its implementation: the id, the chord and the `run` are one thing, and splitting them across
 * files is how a second definition site gets born.
 *
 * `⌃Tab` carries two chords on purpose. `chordFromEvent` maps the platform's primary modifier to
 * `mod`, so the SAME physical Ctrl+Tab normalises to `ctrl+tab` on a mac (where ⌘ is `mod` and ⌃
 * stays `ctrl`) and to `mod+tab` everywhere else. Each spelling is unreachable on the other
 * platform, so declaring both binds one gesture rather than two.
 *
 * @param {CommandRegistry} registry
 * @param {TabCommandDeps} deps
 */
export function registerTabCommands(registry: CommandRegistry, deps: TabCommandDeps) {
  registry.registerAll(tabCommands(deps));
}

/**
 * The tab command records. Exported for the CI placement/budget checks and for tests.
 *
 * @param {TabCommandDeps} deps
 * @returns {AnyCommand[]}
 */
export function tabCommands(deps: TabCommandDeps): AnyCommand[] {
  const twoOrMoreTabs = () => workspace.tabOrder.length > 1;
  return [
    {
      id: "document.nextTab",
      title: "Next Tab",
      category: "Document",
      level: "document",
      keybinding: ["ctrl+tab", "mod+tab"],
      menus: ["palette"],
      group: "2_navigate",
      when: (ctx) => ctx.document.open,
      enablement: twoOrMoreTabs,
      requires: "a second open document",
      run: () => {
        cycleTab(1);
      },
    },
    {
      id: "document.previousTab",
      title: "Previous Tab",
      category: "Document",
      level: "document",
      keybinding: ["ctrl+shift+tab", "mod+shift+tab"],
      menus: ["palette"],
      group: "2_navigate",
      when: (ctx) => ctx.document.open,
      enablement: twoOrMoreTabs,
      requires: "a second open document",
      run: () => {
        cycleTab(-1);
      },
    },
    {
      id: "document.reopenClosed",
      title: "Reopen Closed Document",
      category: "Document",
      level: "document",
      keybinding: "mod+shift+t",
      menus: ["context/tab", "palette"],
      group: "1_file",
      enablement: () => workspace.closedTabs.length > 0,
      requires: "a document closed in this session",
      run: async () => {
        const path = takeClosedTabPath();
        if (path) {
          await deps.openFile(path);
        }
      },
    },
  ];
}
