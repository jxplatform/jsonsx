import { computed, reactive, toRaw } from "../reactivity";
import { commitTabBuffers } from "../services/monaco-buffer";
import { ensureCollab, rekeyCollab } from "../collab/collab-session";
import { createTab, disposeTab } from "../tabs/tab";
import { projectState } from "../state";
import { argsSchema, booleanArg, booleanProperty } from "../commands/command-args";
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
 * Not a UI preference and not a placeholder: every additional Canvas pane is a real
 * `@jxsuite/runtime` render, an `iframe-channel` connection and a structured clone of the resolved
 * document, all on one main thread. Two is a budget that was measured; three is a cliff.
 *
 * This is the ONE cap left. `SECONDARY_PANE_KINDS` used to sit beside it — Code, Diff, Config,
 * Entry, Grid, Library, the cheap kinds — because a second LIVE host was unaffordable while the
 * shell had one stage to hand between panes and one app-wide render generation to invalidate.
 * Neither is true: `canvas/surface-registry.ts` gives every pane its own panels, mode, pan, Monaco
 * and generation, and `panels/pane-grid.ts` gives every pane its own stage. A Canvas in the side
 * pane is now the same object the primary has always had, so the kind cap has nothing left to
 * protect and every predicate that read it is deleted with it — including the one that FLIPPED a
 * splitting Design tab to Code on its way across.
 */
export const MAX_PANES = 2;

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

/*
 * There is no `paneCanHostKind`, no `canOpenInSecondPane`, no `hostableKindsOf`, no
 * `paneOfTabCanHostMode` and no `capToPaneKind`.
 *
 * Five predicates, one cap: "a pane other than the primary may only host Code, Diff, Config, Entry,
 * Grid or Library". Two of them enforced it (the split, and every later write of
 * `session.ui.canvasMode`), one picked the replacement kind, and two narrowed what the controls
 * offered so no dropdown could contain an entry the app would refuse.
 *
 * The cap existed because a second LIVE canvas host was unaffordable, and it is gone because
 * workstream 1 made it affordable — see {@link MAX_PANES}. Its LAST act was a bug: `capToPaneKind`
 * flipped a splitting Design tab to `source` before focus moved, so `⌘\` on a page you were
 * designing silently became "open this as Code somewhere else".
 *
 * What replaces them is `tabs/tab.ts`'s `editorKindsOf` — the kinds a DOCUMENT declares — which is
 * the only narrowing left and the only one that was ever about the document rather than about what
 * the shell could afford to draw.
 */

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
  /* The tab moves AS IT IS. `capToPaneKind` used to run here and rewrite `session.ui.canvasMode`
     when the target pane could not host the tab's kind — which, for a Design tab, meant `⌘\`
     silently reopened your page as Code in the pane you had just made. Both panes host every kind
     now, so a split is a move and nothing else. */
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
  /* The document you were LOOKING AT follows you; the one you were not does not replace it.
     This was `pane.activeTabId ?? survivor.activeTabId` unconditionally, so Unsplit run from the
     primary — which closes the SIDE pane, never the focused one — swapped the primary's document
     for the side pane's: focused=primary showing=a became focused=primary showing=b, and the only
     way back was the tab strip. Nothing is lost either way, because the closing pane's tabs have
     just been moved into the survivor above; this only decides which of them is on screen. */
  survivor.activeTabId =
    workspace.activePaneId === paneId
      ? (pane.activeTabId ?? survivor.activeTabId)
      : (survivor.activeTabId ?? pane.activeTabId);
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
    /* The PRIMARY is exempt HERE and only here. `splitRight` moves the tab out of the source pane
       through this function, so a lone document split from the primary empties it — and that state
       is the one the author just asked for, a welcome screen beside the document they sent across.
       Closing a document is a different request, and `closeTab` collapses on both sides. */
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
    collapseEmptiedPane(paneId);
  }
}

/**
 * Collapse a pane that has just emptied — whichever side of the splitter it is on.
 *
 * §18.1 rule 3 held on ONE side only: the primary was exempted from the collapse, so closing its
 * last tab while split left a welcome screen sitting beside a live document, in a grid the author
 * had asked to be rid of. The exemption was defending something real, though — `PRIMARY_PANE` is
 * the id nine screenshots crop and the one `resolveRegion("pane")` canonicalises onto, so the
 * primary must never be the pane that LEAVES. Both are satisfied by collapsing in the other
 * direction: the side pane is the one removed, and `closePane` hands its tabs to the primary, whose
 * `activeTabId` is null and therefore adopts the side pane's.
 *
 * @param {string} paneId The pane that just lost its last tab.
 */
function collapseEmptiedPane(paneId: string): void {
  if (workspace.panes.length < 2) {
    return;
  }
  if (paneId !== PRIMARY_PANE) {
    closePane(paneId);
    return;
  }
  const other = workspace.panes.find((candidate) => candidate.id !== PRIMARY_PANE);
  if (other) {
    closePane(other.id);
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
    /* A preview open takes the pane's existing preview slot rather than adding a chip beside it —
       but only after the sitting tab has been given the chance to become ineligible.
       `promoteDirtyPreviewTabs` is the gate: an edited preview tab stops being replaceable. It
       reads `doc.dirty`, which is a fact a buffer's armed commit has not established yet, so the
       flush has to come BEFORE the victim is chosen. Choosing first and flushing after — which is
       what this did — ran the gate against the state of half a second ago and then destroyed the
       tab the gate would have saved. */
    if (preview) {
      const sitting = previewTabIn(pane);
      const sittingTab = sitting ? workspace.tabs.get(sitting) : null;
      if (sittingTab) {
        void commitTabBuffers(sittingTab);
      }
      promoteDirtyPreviewTabs();
    }
    const replaced = preview ? previewTabIn(pane) : null;
    if (replaced) {
      slot = pane.tabOrder.indexOf(replaced);
      /* THE EIGHTH WAY OUT OF A MONACO BUFFER, and the only one nobody asked for.
         `services/monaco-buffer.ts` lists seven exits: the disposers flush five, and
         `commitTabBuffers` covers ⌘W and quitting. This is the eighth — the author single-clicked
         another page, so the tab they were typing in is destroyed by a gesture that is not a close
         and shows no dialog. Anything the flush above carried has already promoted this tab out of
         the preview slot, so reaching here means the buffer had nothing of the author's in it.
         The flush is not awaited and cannot be: `openTab` is synchronous, its callers hold the
         `Tab` it returns, and `slot` is computed against the strip as it stands. The dock's body
         write is synchronous and therefore counts; the source view's parse is a format round trip
         and does not. That one resolves into a tab that is already gone and its own `tabIsLive`
         re-check drops it — the correct answer to "write into a destroyed tab", and the reason a
         source buffer is the one case this ordering still cannot rescue. */
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
  // Emptying EITHER pane collapses the grid: a pane with nothing in it is a hole in it, and the
  // Author asked to close a document, not to keep a slot open for one. `detachTab` above has
  // Usually done this already; this is the belt to its braces, and it goes through the same helper
  // So the primary can never be the pane that leaves.
  if (pane && pane.tabOrder.length === 0) {
    collapseEmptiedPane(pane.id);
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

/**
 * Close all open tabs, disposing each. Defers reactivity until fully cleared.
 *
 * **Deliberately no gate and no `commitTabBuffers`, unlike `openTab`'s preview replacement and
 * `requestClose` — and that is now a statement about this function's CALLERS rather than a hole.**
 * It is the destructive half of a decision somebody else makes: the only caller in `src/` is the
 * project switch, and `panels/tab-strip.ts`'s `confirmCloseAll` runs both halves of the discipline
 * for it — commit every tab's buffers, then prompt once for the whole set — before the switch
 * begins, because everything the switch does after that point is one-way. Putting either half here
 * would put an `await` and a dialog inside a synchronous teardown that the test harness and
 * `resetStudioState` also call, which is exactly how a reset would start prompting.
 */
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
 * `⌘0` and `⌘⌥0` are a PAIR, and they are both bound. `⌘0` was `canvas.zoomReset`, which held it
 * for the one verb of the zoom cluster that also has a button in the floating zoom pod (§3.2 ⑩) —
 * so the chord was the second way to reach a control that is already on screen, while focusing a
 * pane had no way at all. The zoom keeps its pod button and gives up the key.
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
      /* One condition, and it is the one the `when` already states: there has to be a document to
         move. The enablement used to ask `canOpenInSecondPane` — whether the tab declared any of
         the six kinds the side pane was allowed to host — and refuse a Design-only page outright.
         Both panes draw a live Canvas now, so the only thing that can refuse a split is having
         nothing to split. */
      enablement: () => workspace.activeTabId !== null,
      // A `requires` string is printed verbatim in every refusal, tooltip and palette row, so it
      // May only promise what a reader will actually see.
      requires: "an open document",
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
      keybinding: "mod+0",
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
