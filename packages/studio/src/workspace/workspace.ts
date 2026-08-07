import { computed, reactive, toRaw } from "../reactivity";
import { ensureCollab, rekeyCollab } from "../collab/collab-session";
import { createTab, disposeTab, editorKindOf, editorKindsOf, modeForEditorKind } from "../tabs/tab";
import { editorKindForMode } from "../commands/context";
import { projectState } from "../state";
import { argsSchema, booleanArg, booleanProperty } from "../commands/command-args";
import type { Tab, TabOrigin } from "../tabs/tab";

import type { ComponentEntry } from "../files/components";
import type { EditorKind } from "../commands/context";
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

/**
 * One editor pane — the unit of split, focus and zoom (§4.1).
 *
 * A tab BELONGS to a pane, and the pane is what splits; the tab strip is per-pane for the same
 * reason. This is the minimal model P3 asks for: an ordered list and an active id, with no rules
 * for derived panes and no follow behaviour (those are P8).
 */
export interface Pane {
  id: string;
  /** Left-to-right order in this pane's strip. Pinned tabs occupy the head of it. */
  tabOrder: string[];
  activeTabId: string | null;
}

export const PRIMARY_PANE = "primary";

export const SECONDARY_PANE = "secondary";

/**
 * Two, and enforced.
 *
 * Not a UI preference: every additional Canvas pane is a real `@jxsuite/runtime` render plus an
 * `iframe-channel` connection, and the risk P8 exists to manage is a performance cliff.
 */
export const MAX_PANES = 2;

/**
 * The editor kinds a pane OTHER than the primary may host.
 *
 * The cap is the whole reason the pane model can land before P8: a second live Canvas host is the
 * expensive part, so the second pane gets the cheap kinds — Code, Diff, Config, Grid, Library — and
 * `probe.idle()` already aggregates per-host state in anticipation of lifting it.
 */
export const SECONDARY_PANE_KINDS: ReadonlySet<EditorKind> = new Set<EditorKind>([
  "code",
  "diff",
  "config",
  "entry",
  "grid",
  "library",
]);

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
  /** One or two panes, `panes[0]` always the primary. The pane grid, as data. */
  panes: Pane[];
  /** Which pane the keyboard and every "the active document" read resolve through. */
  activePaneId: string;
  /**
   * Most-recently-used order, newest first, ACROSS panes. `⌃Tab` walks this, NOT
   * {@link Pane.tabOrder} — "the tab I was just in" is the one people reach for, and it is rarely
   * the one to the left. Cycling onto a tab in the other pane focuses that pane too.
   */
  mruOrder: string[];
  /** Newest first. `⌘⇧T` pops this. */
  closedTabs: ClosedTabRecord[];
  ui: { activityBar: string };
  /**
   * The focused pane's strip order.
   *
   * A derived read, not a second store: with panes, "the workspace's tab order" can only mean the
   * order of the pane you are in. Assigning to it is a type error on purpose — every write goes
   * through a pane.
   */
  readonly tabOrder: readonly string[];
  /** The focused pane's active tab. Derived from {@link Workspace.panes} for the same reason. */
  readonly activeTabId: string | null;
}

// Annotated as Workspace: Vue's UnwrapNestedRefs cannot terminate on the
// Recursive document types, and reactive() does not unwrap refs we never use.
export const workspace: Workspace = reactive({
  activePaneId: PRIMARY_PANE,
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
  panes: [{ activeTabId: null as string | null, id: PRIMARY_PANE, tabOrder: [] as string[] }],
  projectConfig: null as object | null,
  projectRoot: null as string | null,
  styleClipboard: null as JxStyle | null,
  tabs: new Map<string, Tab>(),
  ui: {
    activityBar: "files",
  },
  // The two derived reads. Defined as getters on the object reactive() wraps, so a consumer that
  // Reads `workspace.activeTabId` inside an effect tracks `panes` and `activePaneId` — the same
  // Dependency it used to have on the field these replace, with no second source of truth.
  get activeTabId(): string | null {
    return activePane().activeTabId;
  },
  get tabOrder(): readonly string[] {
    return activePane().tabOrder;
  },
}) as unknown as Workspace;

export const activeTab = computed(() =>
  workspace.activeTabId ? (workspace.tabs.get(workspace.activeTabId) ?? null) : null,
) as unknown as ComputedRef<Tab | null>;

// ─── Panes ────────────────────────────────────────────────────────────────────

/**
 * The focused pane. Never null: `panes[0]` is created with the store and is never removed, so
 * "where am I" always has an answer even with no project open.
 *
 * @returns {Pane}
 */
export function activePane(): Pane {
  const { panes } = workspace;
  return panes.find((pane) => pane.id === workspace.activePaneId) ?? panes[0]!;
}

/**
 * @param {string} paneId
 * @returns {Pane | undefined}
 */
export function paneById(paneId: string): Pane | undefined {
  return workspace.panes.find((pane) => pane.id === paneId);
}

/**
 * The pane holding `tabId`, or undefined when no pane does.
 *
 * @param {string} tabId
 * @returns {Pane | undefined}
 */
export function paneOfTab(tabId: string): Pane | undefined {
  return workspace.panes.find((pane) => pane.tabOrder.includes(tabId));
}

/**
 * Move focus to a pane. A no-op for an id no pane carries, so a stale persisted layout cannot
 * strand the keyboard in a pane that is not there.
 *
 * @param {string} paneId
 */
export function focusPane(paneId: string) {
  const pane = paneById(paneId);
  if (!pane) {
    return;
  }
  workspace.activePaneId = pane.id;
  resetTabCycle();
  const { activeTabId } = pane;
  if (activeTabId) {
    promoteMru(activeTabId);
    const tab = workspace.tabs.get(activeTabId);
    if (tab) {
      syncTreeSelection(tab);
    }
  }
}

/** Focus the pane that is not the focused one, when there is one. */
export function focusOtherPane() {
  const other = workspace.panes.find((pane) => pane.id !== workspace.activePaneId);
  if (other) {
    focusPane(other.id);
  }
}

/**
 * THE cap, as one predicate: whether a pane may host an editor kind.
 *
 * Every enforcement point below reads this and nothing else — the split ({@link capToPaneKind}),
 * the later mode switch ({@link paneOfTabCanHostMode}) and the controls that offer either ({@link
 * hostableKindsOf}). A second copy of "is it in the set" is how the two ends of a cap start
 * disagreeing.
 *
 * @param {string} paneId
 * @param {EditorKind} kind
 * @returns {boolean}
 */
export function paneCanHostKind(paneId: string, kind: EditorKind): boolean {
  return paneId === PRIMARY_PANE || SECONDARY_PANE_KINDS.has(kind);
}

/**
 * Whether `tab` can be hosted outside the primary pane — i.e. whether it supports any of
 * {@link SECONDARY_PANE_KINDS}.
 *
 * @param {Tab} tab
 * @returns {boolean}
 */
export function canOpenInSecondPane(tab: Tab): boolean {
  return editorKindsOf(tab).some((kind) => paneCanHostKind(SECONDARY_PANE, kind));
}

/**
 * The editor kinds `tab` may show WHERE IT IS — {@link editorKindsOf} narrowed by its pane's cap.
 *
 * What a control offers has to be what the app will accept, or the segment is dead: the pane
 * context bar's Editor dropdown and Canvas view group both draw from this, so a tab in the side
 * pane is never offered the Design its pane would refuse.
 *
 * @param {Tab} tab
 * @returns {EditorKind[]}
 */
export function hostableKindsOf(tab: Tab): EditorKind[] {
  const pane = paneOfTab(tab.id);
  const kinds = editorKindsOf(tab);
  return pane ? kinds.filter((kind) => paneCanHostKind(pane.id, kind)) : kinds;
}

/**
 * Whether the pane currently holding `tab` may host `mode`. A tab no pane holds is unconstrained.
 *
 * This is the half of the cap the split cannot enforce: a tab already in the side pane can be
 * switched back to Canvas from the context bar, from `canvas.setMode`, or by any other writer of
 * `session.ui.canvasMode`. Enforcing only at the split left that open, and it stays harmless only
 * for as long as the shell has ONE stage that follows focus — which P8 workstream 2 ends.
 *
 * @param {Tab} tab
 * @param {string} mode
 * @returns {boolean}
 */
export function paneOfTabCanHostMode(tab: Tab, mode: string): boolean {
  const pane = paneOfTab(tab.id);
  return !pane || paneCanHostKind(pane.id, editorKindForMode(mode));
}

/**
 * Force a tab that is MOVING into a non-primary pane onto a kind that pane may host.
 *
 * The split is one of the two enforcement points, not the only one — it is the only one that can
 * pick a replacement kind, because it runs before the tab is in the target pane. Once it is there,
 * {@link paneOfTabCanHostMode} refuses a switch back out of the capped set.
 *
 * @param {Tab} tab
 * @param {string} paneId — the pane the tab is moving INTO
 * @returns {boolean} Whether the tab is (now) hostable there
 */
function capToPaneKind(tab: Tab, paneId: string): boolean {
  if (paneCanHostKind(paneId, editorKindOf(tab))) {
    return true;
  }
  for (const kind of editorKindsOf(tab)) {
    if (!paneCanHostKind(paneId, kind)) {
      continue;
    }
    const mode = modeForEditorKind(tab, kind);
    if (mode) {
      tab.session.ui.canvasMode = mode;
      tab.session.ui.preview = false;
      return true;
    }
  }
  return false;
}

/**
 * Split the grid and move the focused tab into the new pane, which becomes focused.
 *
 * Moves rather than duplicates: one tab is one document with one undo history and one collab
 * session, and two strips claiming the same id is the duplicate-`repeat`-key bug §4.3 describes.
 *
 * @returns {Pane | null} The pane the tab landed in, or null when the split was refused
 */
export function splitRight(): Pane | null {
  const source = activePane();
  const tabId = source.activeTabId;
  const tab = tabId ? workspace.tabs.get(tabId) : null;
  if (!tabId || !tab) {
    return null;
  }
  const existing = workspace.panes.find((pane) => pane.id !== source.id) ?? null;
  if (!existing && workspace.panes.length >= MAX_PANES) {
    return null;
  }
  const targetId = existing?.id ?? SECONDARY_PANE;
  // The primary keeps the Canvas; whichever pane is NOT primary takes the capped kind.
  if (!capToPaneKind(tab, targetId)) {
    return null;
  }
  const target = existing ?? addPane(targetId);
  detachTab(tabId);
  insertIntoPane(target, tabId);
  /* Focus moves LAST, and every write above went through {@link addPane}'s reactive record.
     Publishing the focus first made the pane observable while it still showed nothing: the
     `activeTab` computed re-ran, cached null, and the jump bar, the Inspector and the toolbar all
     printed "no document" over a stage that was drawing one. The write that should have corrected
     them notified nobody, because it went through the raw literal this used to push. */
  target.activeTabId = tabId;
  workspace.activePaneId = target.id;
  resetTabCycle();
  promoteMru(tabId);
  return target;
}

/**
 * Publish a new pane and hand back the REACTIVE record.
 *
 * The pane is constructed HERE so no caller can hold the raw literal. `reactive()` wraps on READ:
 * an object pushed into the array is still the plain object the caller has a reference to, and a
 * write through that reference reaches the same fields while notifying no effect at all. Building
 * the record inside the one function that publishes it is what makes that mistake unavailable
 * rather than merely absent — see the same failure recorded for nested reactive collections.
 *
 * @param {string} paneId
 * @returns {Pane}
 */
function addPane(paneId: string): Pane {
  workspace.panes = [
    ...workspace.panes,
    { activeTabId: null as string | null, id: paneId, tabOrder: [] as string[] },
  ];
  return paneById(paneId)!;
}

/**
 * Collapse a pane, moving its tabs back into the one that remains.
 *
 * Closing a pane must never close documents — that is the difference between a layout action and a
 * destructive one, and only the second is allowed to lose work.
 *
 * @param {string} paneId
 */
export function closePane(paneId: string) {
  if (workspace.panes.length < 2) {
    return;
  }
  const pane = paneById(paneId);
  const survivor = workspace.panes.find((candidate) => candidate.id !== paneId);
  if (!pane || !survivor) {
    return;
  }
  /* The ORDER is the whole of this function.
     "The active pane does not exist" must never be observable. Every reader resolves through
     `workspace.activePaneId` — the stage, `tabOfPane`, the jump bar, the Inspector — so removing
     the pane while the focus still names it publishes, for one synchronous instant, a workspace
     whose focused pane has no tab. A render scheduled in that instant tore the canvas down to its
     welcome state and NOTHING scheduled another: the focus flip that followed changed no
     `activeTab`, so both canvas effects stayed quiet and the editor was gone until a reload.
     So: the survivor takes the tabs and the focus while both panes are still in the grid, and only
     then does the closing pane leave it. */
  for (const tabId of pane.tabOrder) {
    insertIntoPane(survivor, tabId);
  }
  survivor.activeTabId = pane.activeTabId ?? survivor.activeTabId;
  workspace.activePaneId = survivor.id;
  workspace.panes = workspace.panes.filter((candidate) => candidate.id !== paneId);
  resetTabCycle();
}

/* No `togglePaneZoom`. Zoom is a view of a GRID, and there is no grid: §18.3 hands the one stage
   between panes, so the focused pane already fills the shell and the other one is not on screen to
   be zoomed away from. The state existed, both commands wrote it, and nothing that draws ever read
   it — a control whose only observable effect is on itself. It comes back with the second live
   host, and not one release earlier. */

/** Remove a tab id from whichever pane holds it, without touching the tab itself. */
function detachTab(tabId: string) {
  const emptied: string[] = [];
  for (const pane of workspace.panes) {
    if (!pane.tabOrder.includes(tabId)) {
      continue;
    }
    pane.tabOrder = pane.tabOrder.filter((id) => id !== tabId);
    if (pane.activeTabId === tabId) {
      pane.activeTabId = pane.tabOrder.at(-1) ?? null;
    }
    if (pane.id !== PRIMARY_PANE && pane.tabOrder.length === 0) {
      emptied.push(pane.id);
    }
  }
  // The same rule `closeTab` applies, applied wherever a pane empties: a pane with nothing in it is
  // A hole in the grid. `splitRight` from the side pane moves the tab back to the primary and used
  // To leave the empty pane standing with `pane.focusSecondary` still enabled on it — three
  // Keystrokes to a shell with no stage, no strip, no jump bar and two documents still open. It was
  // Not `closePane`'s ordering bug, which is fixed: "the active pane exists and has no tab"
  // Produces the identical empty shell, and only this stops it being mintable.
  for (const paneId of emptied) {
    closePane(paneId);
  }
}

/**
 * Put a tab id into a pane at the right place: after the pinned prefix for an ordinary tab, at the
 * end of it for a pinned one. Idempotent.
 */
function insertIntoPane(pane: Pane, tabId: string, index?: number) {
  if (pane.tabOrder.includes(tabId)) {
    return;
  }
  const at = index ?? defaultSlot(pane, tabId);
  pane.tabOrder = [...pane.tabOrder.slice(0, at), tabId, ...pane.tabOrder.slice(at)];
}

/** How many tabs at the head of `pane` are pinned. */
function pinnedCount(pane: Pane): number {
  let count = 0;
  for (const id of pane.tabOrder) {
    if (workspace.tabs.get(id)?.pinned !== true) {
      break;
    }
    count += 1;
  }
  return count;
}

/** The slot a newly-arriving tab takes: inside the pinned prefix if pinned, else at the end. */
function defaultSlot(pane: Pane, tabId: string): number {
  return workspace.tabs.get(tabId)?.pinned === true ? pinnedCount(pane) : pane.tabOrder.length;
}

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
 * Whether `tab` is still open.
 *
 * The question a CAPTURED tab owes before anything is written into it. Both Monaco surfaces commit
 * on a debounce, and a debounce is a promise to write into the document a tab held half a second
 * ago — by which time the tab may have been closed, so `workspace.tabs` no longer holds it and
 * nothing else will ever look at what was written. Deliberately not `isTabActive`: a commit belongs
 * to the tab its editor was mounted for whether or not that tab is the one on screen when the timer
 * fires, and resolving it through the FOCUSED tab is precisely the cross-document write this
 * replaces.
 *
 * @param {Tab | null | undefined} tab
 * @returns {boolean}
 */
export function tabIsLive(tab: Tab | null | undefined): boolean {
  if (!tab) {
    return false;
  }
  const held = workspace.tabs.get(tab.id);
  return held !== undefined && toRaw(held as object) === toRaw(tab as unknown as object);
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
  const pane = paneOfTab(tabId);
  if (!tab || !pane) {
    return;
  }
  pane.activeTabId = tabId;
  workspace.activePaneId = pane.id;
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
 * `preview: true` opens a DISPOSABLE tab (§4.3): single-clicking through the tree or the palette is
 * browsing, and browsing must not litter, so the next preview open in the same pane takes its slot.
 * It is opt-in rather than the default because only the CALLER knows whether the author was
 * browsing or committing — an author who typed a new file name has committed, and silently
 * discarding that tab on their next click is the one failure a preview tab must never have.
 * {@link promoteTab} records a commitment made after the fact.
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
export function openTab(opts: {
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
  const previous = workspace.tabs.get(opts.id);
  const preview = opts.preview === true && previous?.pinned !== true;
  const tab = createTab({ ...opts, preview });
  const pane = activePane();
  let slot: number | undefined;
  if (previous) {
    tab.pinned = previous.pinned;
    disposeTab(previous);
  } else {
    // A preview open takes the pane's existing preview slot rather than adding a chip beside it.
    const replaced = preview ? previewTabIn(pane) : null;
    if (replaced) {
      slot = pane.tabOrder.indexOf(replaced);
      closeTab(replaced);
    }
    insertIntoPane(pane, tab.id, slot);
  }
  workspace.tabs.set(tab.id, tab);
  setActiveTab(tab.id);
  ensureCollab(tab);
  return tab;
}

/** The pane's one preview tab, or null. */
function previewTabIn(pane: Pane): string | null {
  return pane.tabOrder.find((id) => workspace.tabs.get(id)?.preview === true) ?? null;
}

/**
 * Commit to a tab: it stops being replaceable and starts rendering upright.
 *
 * @param {string} tabId
 */
export function promoteTab(tabId: string) {
  const tab = workspace.tabs.get(tabId);
  if (tab?.preview === true) {
    tab.preview = false;
  }
}

/**
 * Promote every preview tab that now has unsaved changes.
 *
 * An edit is the least ambiguous commitment there is, and the alternative — silently discarding
 * someone's typing because they clicked another file — is the one failure a preview tab must never
 * have. Called from the strip's tracking effect, which already reads every tab's `dirty` flag.
 */
export function promoteDirtyPreviewTabs() {
  for (const [id, tab] of workspace.tabs) {
    if (tab.preview && tab.doc.dirty) {
      promoteTab(id);
    }
  }
}

/**
 * Pin or unpin a tab, moving it to the boundary of the pinned prefix so the head of the strip is
 * always exactly the pinned set.
 *
 * @param {string} tabId
 * @param {boolean} pinned
 */
export function setTabPinned(tabId: string, pinned: boolean) {
  const tab = workspace.tabs.get(tabId);
  const pane = paneOfTab(tabId);
  if (!tab || !pane) {
    return;
  }
  tab.pinned = pinned;
  if (pinned) {
    tab.preview = false;
  }
  const without = pane.tabOrder.filter((id) => id !== tabId);
  const boundary = without.filter((id) => workspace.tabs.get(id)?.pinned === true).length;
  pane.tabOrder = [...without.slice(0, boundary), tabId, ...without.slice(boundary)];
}

/**
 * Drag-reorder within a pane. `toIndex` is clamped into the region the tab's pinned state allows,
 * so a drag can never interleave a pinned tab with an unpinned one.
 *
 * @param {string} tabId
 * @param {number} toIndex — the index in the pane's order the tab should end up at
 */
export function moveTab(tabId: string, toIndex: number) {
  const tab = workspace.tabs.get(tabId);
  const pane = paneOfTab(tabId);
  if (!tab || !pane) {
    return;
  }
  const without = pane.tabOrder.filter((id) => id !== tabId);
  const boundary = without.filter((id) => workspace.tabs.get(id)?.pinned === true).length;
  const lower = tab.pinned ? 0 : boundary;
  const upper = tab.pinned ? boundary : without.length;
  const at = Math.min(Math.max(toIndex, lower), upper);
  pane.tabOrder = [...without.slice(0, at), tabId, ...without.slice(at)];
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
  const pane = paneOfTab(tabId);
  const wasActive = pane?.activeTabId === tabId;
  rememberClosedTab(tab);
  disposeTab(tab);
  workspace.tabs.delete(tabId);
  detachTab(tabId);
  workspace.mruOrder = workspace.mruOrder.filter((id) => id !== tabId);
  resetTabCycle();
  // Emptying the second pane collapses it: a pane with nothing in it is a hole in the grid, and
  // The author asked to close a document, not to keep a slot open for one.
  if (pane && pane.id !== PRIMARY_PANE && pane.tabOrder.length === 0) {
    closePane(pane.id);
  }
  if (!wasActive) {
    return;
  }
  // The MRU list, not the strip order: closing a tab should land you on the one you were in before
  // It, which is almost never the rightmost tab in the strip. `detachTab` has already put the
  // Rightmost there as the safe default, so this only ever improves on it.
  const survivor = activePane();
  const next =
    workspace.mruOrder.find((id) => survivor.tabOrder.includes(id)) ??
    survivor.tabOrder.at(-1) ??
    null;
  if (next) {
    setActiveTab(next);
  }
}

/** Close all open tabs, disposing each. Defers reactivity until fully cleared. */
export function closeAllTabs() {
  const tabs = [...workspace.tabs.values()];
  workspace.tabs.clear();
  resetPanes();
  workspace.mruOrder = [];
  resetTabCycle();
  for (const tab of tabs) {
    disposeTab(tab);
  }
}

/** Back to one empty primary pane — the state the store boots in. */
function resetPanes() {
  workspace.panes = [{ activeTabId: null, id: PRIMARY_PANE, tabOrder: [] }];
  workspace.activePaneId = PRIMARY_PANE;
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
  resetPanes();
  workspace.panes[0]!.tabOrder = [newTab.id];
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
  for (const pane of workspace.panes) {
    pane.tabOrder = pane.tabOrder.map((id) => (id === oldId ? newId : id));
    if (pane.activeTabId === oldId) {
      pane.activeTabId = newId;
    }
  }
  workspace.mruOrder = workspace.mruOrder.map((id) => (id === oldId ? newId : id));
  resetTabCycle();
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
  registry.registerAll([...tabCommands(deps), ...paneCommands()]);
}

/**
 * The tab command records. Exported for the CI placement/budget checks and for tests.
 *
 * @param {TabCommandDeps} deps
 * @returns {AnyCommand[]}
 */
export function tabCommands(deps: TabCommandDeps): AnyCommand[] {
  // The MRU list is workspace-wide, so cycling is available whenever a second document is open —
  // In either pane, not just the focused one's strip.
  const twoOrMoreTabs = () => workspace.tabs.size > 1;
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
    {
      id: "document.togglePinned",
      title: "Pin / Unpin Document",
      category: "Document",
      level: "document",
      menus: ["context/tab", "palette"],
      group: "1_file",
      when: (ctx) => ctx.document.open,
      requires: "an open document",
      run: () => {
        const id = workspace.activeTabId;
        const tab = id ? workspace.tabs.get(id) : null;
        if (id && tab) {
          setTabPinned(id, !tab.pinned);
        }
      },
    },
    {
      args: argsSchema({
        pinned: booleanProperty("True to pin the active document's tab, false to unpin it."),
      }),
      id: "document.setPinned",
      title: "Set Document Pinned",
      category: "Document",
      level: "document",
      menus: ["palette"],
      group: "1_file",
      when: (ctx) => ctx.document.open,
      requires: "an open document",
      run: (_ctx, args) => {
        const id = workspace.activeTabId;
        if (id && workspace.tabs.get(id)) {
          setTabPinned(id, booleanArg("document.setPinned", args, "pinned"));
        }
      },
    },
    {
      id: "document.keepOpen",
      title: "Keep Document Open",
      category: "Document",
      level: "document",
      menus: ["context/tab", "palette"],
      group: "1_file",
      when: (ctx) => ctx.document.open,
      enablement: () => {
        const id = workspace.activeTabId;
        return id !== null && workspace.tabs.get(id)?.preview === true;
      },
      requires: "a preview document — one opened by a single click",
      run: () => {
        const id = workspace.activeTabId;
        if (id) {
          promoteTab(id);
        }
      },
    },
  ];
}

/**
 * The pane commands.
 *
 * They live beside the pane model for the same reason the tab commands do, and they are the whole
 * user-facing surface of §4.1's Pane transport: split, focus, unsplit, zoom.
 *
 * **`⌘0` / `⌘⌥0` are not both bound yet.** `⌘0` is `canvas.zoomReset` (`editor/shortcuts.ts`),
 * registered into the same registry, so claiming it here would throw at bootstrap on the chord
 * conflict the keymap exists to catch. `⌘⌥0` is free and is bound. The plan puts the zoom cluster
 * into the floating canvas chrome (§3.2 ⑩) and re-binds ⌘0 in P8 workstream 2; until then
 * `pane.focusPrimary` is palette- and API-reachable and prints no chord it does not have.
 *
 * @returns {AnyCommand[]}
 */
export function paneCommands(): AnyCommand[] {
  const twoPanes = () => workspace.panes.length > 1;
  return [
    {
      id: "pane.splitRight",
      title: "Split Right",
      category: "View",
      level: "document",
      keybinding: "mod+\\",
      menus: ["context/pane", "context/tab", "palette"],
      group: "5_pane",
      when: (ctx) => ctx.document.open,
      enablement: () => {
        const id = workspace.activeTabId;
        const tab = id ? workspace.tabs.get(id) : null;
        if (!tab) {
          return false;
        }
        // Already split: moving the tab across is always allowed back into the primary.
        if (workspace.panes.length > 1) {
          return workspace.activePaneId === PRIMARY_PANE ? canOpenInSecondPane(tab) : true;
        }
        return canOpenInSecondPane(tab);
      },
      // Not "beside the canvas": §18.3 has one stage, handed to whichever pane has focus. The side
      // Pane is a second place to BE, not a second thing on screen — and a `requires` string is
      // Printed verbatim in every refusal, tooltip and palette row, so it may only promise what a
      // Reader will actually see.
      requires: "a document that can open as Code, Config, Diff, Grid or Library in a second pane",
      undo: "none",
      run: () => {
        splitRight();
      },
    },
    {
      id: "pane.focusPrimary",
      title: "Focus Primary Pane",
      category: "View",
      level: "document",
      menus: ["palette"],
      group: "5_pane",
      enablement: twoPanes,
      requires: "a split pane grid",
      undo: "none",
      run: () => {
        focusPane(PRIMARY_PANE);
      },
    },
    {
      id: "pane.focusSecondary",
      title: "Focus Side Pane",
      category: "View",
      level: "document",
      keybinding: "mod+alt+0",
      menus: ["palette"],
      group: "5_pane",
      enablement: twoPanes,
      requires: "a split pane grid",
      undo: "none",
      run: () => {
        focusPane(SECONDARY_PANE);
      },
    },
    {
      id: "pane.unsplit",
      title: "Unsplit",
      category: "View",
      level: "document",
      menus: ["context/pane", "palette"],
      group: "5_pane",
      enablement: twoPanes,
      requires: "a split pane grid",
      undo: "none",
      run: () => {
        closePane(
          workspace.activePaneId === PRIMARY_PANE ? SECONDARY_PANE : workspace.activePaneId,
        );
      },
    },
  ];
}
