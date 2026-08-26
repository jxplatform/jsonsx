/// <reference lib="dom" />
/**
 * Studio.js — Jx Studio main application
 *
 * Phase 1: Open a Jx file, render in canvas, edit properties in the inspector, see changes live,
 * and save. Phase 2: Tree editing with drag-and-drop reordering.
 */

/*
 * Monaco is NOT imported here. It is two thirds of the studio bundle and most sessions never open a
 * code view, so `services/monaco-lazy` loads it (and `monaco-setup`'s worker + language
 * registration) on first use by source mode, the function editor, or the formula workspace.
 */
import { errorMessage } from "@jxsuite/schema/parse";
import { getPanel } from "./panels/panel-registry";

import {
  initShellRefs,
  projectState,
  registerRenderer,
  render,
  requireProjectState,
  setProjectState,
  toolbarEl,
  updateSession,
} from "./store";

import {
  PRIMARY_PANE,
  activeTab,
  closeAllTabs,
  openTab,
  paneById,
  receivingPane,
  registerTabCommands,
  setWorkspaceProject,
  workspace,
} from "./workspace/workspace";
import { derivationCommands, installDerivationEffects } from "./workspace/pane-derive";
import type { DerivationDeps } from "./workspace/pane-derive";
import { effect, effectScope } from "./reactivity";
import type { EffectScope } from "@vue/reactivity";

import {
  flushSession,
  markSessionRestored,
  mountShell,
  registerShellViewCommands,
  resetProjectShell,
  setActivityTab,
  shell,
} from "./shell";

import { isEditing } from "./editor/inline-edit";
import { applyTransform, registerCanvasViewCommands } from "./canvas/canvas-utils";
import type { CanvasSurface } from "./canvas/canvas-surface";
import {
  initCanvasRender,
  registerSelectionSetCommand,
  renderCanvas,
  renderOverlays,
  scheduleCanvasRender,
} from "./canvas/canvas-render";
import {
  canvasModeOfPane,
  canvasModeOfTab,
  stageContaining,
  surfaceForPane,
  tabOfPane,
} from "./canvas/canvas-surface";
import { consumePatchedDocument, initCanvasPatcher } from "./canvas/canvas-patcher";
import {
  setKeymapSource,
  commitActiveEditSession,
  allowAutoRequestsOnNextRender,
  getEditSnapshot,
  isCaretActive,
  postColorSchemeToLiveHosts,
  postLocaleToLiveHosts,
  setCanvasContextMenuHandler,
  setCanvasPointerDownHandler,
  setCanvasSlashHandler,
  setIframePatchEscalation,
  setFileDropHandler,
  setInsertZoneClickHandler,
  setStylebookHitHandler,
  setToolbarRefresh,
} from "./canvas/iframe-host";
import { runInsertZoneAction } from "./editor/insert-zone-action";
import { canvasSlashHandler } from "./editor/canvas-slash-bridge";
import { makeCanvasContextMenuHandler } from "./editor/canvas-context-menu";
import { mountStatusbar, renderStatusbar } from "./panels/statusbar";
import { mountJumpBar } from "./panels/jump-bar";
import { cellForPane } from "./panels/pane-grid";
import { notify } from "./services/notify";
import { beginActivity } from "./panels/activity-panel";
import { exportFile, parseSourceForPath, saveFile, serializeDocument } from "./files/file-ops";
import {
  formatForPath,
  loadFormats,
  refreshExtensionUi,
  refreshFormats,
} from "./format/format-host";
import {
  loadProject as _loadProject,
  openProject as _openProject,
  renderFilesTemplate as _renderFilesTemplate,
  findHomePage,
  loadDirectory,
  openFileInPane,
  openFileInTab,
  openLastSessionOrHome,
  registerFileTreeDnD,
  reloadCleanTab,
} from "./files/files";
import { startFsSync } from "./files/fs-events";
import { invalidateParamValues } from "./page-params";
import {
  configureCollabNotifier,
  configureCollabParser,
  configureCollabSerializer,
} from "./collab/collab-session";
import { renderImportsTemplate } from "./panels/imports-panel";
import { invalidateLayoutPickerCache, renderHeadTemplate } from "./panels/head-panel";
import { exportCemManifest as _exportCemManifest } from "./services/cem-export";
import { installAutomationHook } from "./services/automation";
import { invalidateLibrary } from "./browse/library-pane";
import { invalidateMediaCache } from "./ui/media-picker";
import { setMediaChangedHandler } from "./files/media-upload";
import { applyFileDrop } from "./editor/file-drop-action";
import {
  assistantCommands,
  isAssistantStreaming,
  isAssistantWaiting,
  seedAssistantMessages,
} from "./panels/ai-panel";
import { seedPublishConnected } from "./publish/publish-panel";

import { getPlatform, hasPlatform, registerPlatform } from "./platform";
import { parseMediaEntries } from "./utils/canvas-media";
import { resolveDefaultPlatform } from "./platforms/default-platform";
import { mountResizeEdges } from "./resize-edges";
import {
  defBadgeLabel,
  defCategory,
  registerSignalsCommands,
  renderSignalsTemplate,
} from "./panels/signals-panel";
import { loadComponentRegistry } from "./files/components";
import { ensureDependenciesInstalled } from "./packages/ensure-deps";
import { maybePromptJxsuiteUpdate } from "./packages/jxsuite-update";
import { autoSyncProjectOnOpen } from "./packages/pull-package-sync";

import { html, render as litRender } from "lit-html";

import webdata from "../data/webdata.json";
import { registerDataExplorerCommands } from "./panels/data-explorer";
import {
  cleanupGitPanel,
  cloneRepository,
  loadDiffForLens,
  registerSourceControlCommands,
  renderGitPanel,
} from "./panels/git-panel";

// ─── Spectrum Web Components ──────────────────────────────────────────────────
// Explicit class imports + registration — bare side-effect imports are tree-shaken
// By Bun's bundler despite sideEffects declarations in Spectrum's package.json.
import { components as _swc } from "./ui/spectrum";
import "./ui/panel-resize.js";
// Built-in schema-form controls (schema-builder, secret) register on import
import "./ui/form-controls.js";
import { initLayers, isModalOpen } from "./ui/layers";
import { initShortcuts, registerStudioCommands } from "./editor/shortcuts";
import type { ProjectOpenOutcome, ProjectOpenTarget } from "./editor/shortcuts";
import { createCommandRegistry } from "./commands/registry";
import { chordsInScopes } from "./commands/keymap";
import { FRAME_KEY_SCOPES } from "./canvas/iframe-keys";
import { createLiveContext } from "./commands/live-context";
import { hasAiCredentials } from "./services/ai-models";
import { mount as mountActivityBar } from "./panels/activity-bar";
import * as toolbarPanel from "./panels/toolbar";
import * as overlaysPanel from "./panels/overlays";
import * as frontmatterPanelMod from "./panels/frontmatter-panel";
import * as rightPanelMod from "./panels/right-panel";
import * as chatPanelMod from "./panels/chat-panel";
import { setProjectAdopter } from "./services/project-adoption";
import { tabBufferUnsaved } from "./services/monaco-buffer";
import * as leftPanelMod from "./panels/left-panel";
import * as tabStrip from "./panels/tab-strip";
import * as paneContext from "./panels/pane-context";
import { selectStylebookTag } from "./panels/stylebook-panel";
import { registerLayersDnD, registerComponentsDnD, registerElementsDnD } from "./panels/dnd";
import { registerCanvasDndBridge } from "./panels/canvas-dnd-bridge";
import { defaultDef } from "./panels/shared";
import { registerFormulaEditorCommands } from "./panels/formula-workspace";
import { closeFunctionEditor } from "./panels/editors";
import {
  formatCommands,
  initBlockActionBar,
  isEditChromeTarget,
  registerSelectionCommands,
  releaseBlockActionBar,
  renderBlockActionBar,
  suppressBlockActionBar,
} from "./panels/block-action-bar";
import { initCssData } from "./panels/style-utils";
import { initQuickSearch } from "./panels/quick-search";
import { hydrateAccountStatus } from "./account-status";
import { hydrateProjectList } from "./project-list";
import { addRecentProject, hydrateRecentProjects, removeRecentProject } from "./recent-projects";
import {
  hydrateSettings,
  onSettingsChanged,
  settingsSettled,
  watchRemoteSettings,
} from "./services/settings/kernel";
import { initWelcome } from "./panels/welcome-screen";
import {
  openAddRepoModal,
  openProjectPickerModal,
  platformUsesRepoPicker,
} from "./new-project/add-repo-modal";
import { openNewProjectModal, registerNewProjectCommands } from "./new-project/new-project-modal";
import { invalidatePageRouteCache, registerInspectorCommands } from "./panels/properties-panel";
import { liveElementCommands, setContextMenuNavigate } from "./editor/context-menu";
import { registerSeoCommands, renderSeoModal } from "./panels/seo-modal";
import { registerA11yCommands } from "./services/a11y-report";
import { registerStyleCommands } from "./panels/style-panel";
import { registerGridCommands } from "./grid/grid-open";
import { registerSettingsCommands } from "./settings/settings-document";
import { registerPreferencesCommands } from "./settings/preferences-dialog";
import { registerAboutCommands } from "./about/about-modal";
import { registerCollabCommands } from "./collab/collab-commands";
import { registerLibraryCommands } from "./browse/library-commands";
import { registerPublishCommands } from "./publish/publish-commands";
import { registerGridViewCommands } from "./grid/grid-panel";
import { registerRedirectsCommands } from "./grid/redirects-grid";
import { registerContentCommands } from "./content/entry-commands";
import { registerI18nCommands } from "./i18n/i18n-commands";
import { convertToComponent } from "./editor/convert-to-component";
import type { GitDiffState } from "./types";
import type { Tab } from "./tabs/tab";
import type { JxMutableNode, ProjectConfig } from "@jxsuite/schema/types";
import { setBundleBase } from "./services/bundle-base";
import { mountShellTree } from "./shell/tree";

/**
 * Anchor every shipped-asset URL to THIS module's directory.
 *
 * Only an ENTRY may do this, and it must be an entry: `splitting: true` may hoist any other module
 * into a content-hashed chunk under `dist/chunks/`, where `import.meta.url` means something else
 * entirely. That is not hypothetical — it is the bug this call fixes, in `services/monaco-setup`.
 * `tests/entry-anchors.test.ts` holds the line in both directions.
 *
 * Placed before any other statement so nothing can read the base before it exists. In ESM the
 * entry's body runs AFTER its whole static import graph, so a module that called `bundleUrl()`
 * during evaluation would still throw — deliberately, and loudly. Nothing does today: Monaco is
 * reached only through the dynamic `services/monaco-lazy`, and `workerUrl` runs inside
 * `MonacoEnvironment.getWorker`.
 */
setBundleBase(import.meta.url);

void _swc;

/**
 * What the derivation's commands and follows need from the rest of Studio: an opener, and a reader
 * for the one preset whose subject is not a document at all.
 *
 * `loadDiff` is here rather than in `workspace/pane-derive.ts` because that module owns no I/O —
 * which is what lets its whole decision-making half be tested with no platform. It is the same pair
 * of reads `panels/git-panel.ts` makes for a row click; an added file has no `HEAD` copy, so its
 * "original" is the empty string rather than a `gitShow` that would throw.
 */
const derivationDeps: DerivationDeps = {
  /*
   * `fileExists` answers the locale companion's one question: the resolver computes WHERE this
   * document's copy in another language would live, and only the disk can say whether anybody has
   * written it. A read that throws is the platform's own answer for "no such file" — every backend
   * rejects rather than returning empty — so the catch is the negative case, not an error being
   * swallowed. Memoised per wanted path by `probeTranslationFor`, so it costs one read per locale a
   * pane is actually pointed at.
   */
  fileExists: async (path: string) => {
    try {
      await getPlatform().readFile(path);
      return true;
    } catch {
      return false;
    }
  },
  loadDiff: loadDiffForLens,
  openFileInPane,
};

// ─── Globals ──────────────────────────────────────────────────────────────────
// These mutable variables are local to studio.js for now. As sections are extracted
// Into their own modules, they will migrate to ctx in store.js.

// The FOCUSED pane's effective canvas mode. The composition itself (the per-tab preview toggle over
// An edit/design base) lives in `canvas/canvas-surface.ts`, beside the panes, because the answer is
// A property of a pane's tab and every other pane has its own — this is just the focused one, which
// Is what a panel drawn once for the whole shell means by "the canvas mode".
//
// It is a READ, and it is injected only into surfaces the shell draws once: the toolbar, the
// Inspector, the block bar, the overlays, the live-render context and the canvas view commands.
// `panels/pane-context.ts` used to take it too and is the reason this comment exists — a bar drawn
// Once per pane asking "what mode is the canvas in" got the answer for a pane it was not drawing,
// So the Export button appeared in BOTH bars the moment either pane entered Code. A pane-scoped
// Caller asks `canvasModeOfPane(paneId)` or `canvasModeOfTab(tab)`, and
// `scripts/check-pane-singletons.ts`'s fourth rule is what says so mechanically.
function getCanvasMode() {
  return canvasModeOfPane(workspace.activePaneId);
}

/**
 * Write a tab's BASE canvas mode. **The only writer, and it cannot find a tab on its own.**
 *
 * It used to open with `const tab = activeTab.value` and every injected `setCanvasMode` was `(mode:
 * string) => void`, which is how the pane context bar's Editor picker — drawn per pane, from
 * `tabOfPane(paneId)` — moved the FOCUSED pane's tab into Code: click "Code" in the side bar and
 * the primary became a Code editor while the side pane went on drawing Design. There is no
 * zero-argument variant anywhere in the graph now; a caller drawn once for the shell passes
 * `activeTab.value` where a reviewer can see it, and a caller drawn for a pane passes that pane's
 * tab.
 *
 * No pane check. It used to refuse a mode the tab's pane could not host, because the side pane was
 * capped to the cheap editor kinds and a cap enforced only at the split is one a context-bar click
 * walks straight back out of. Both panes host every kind, so the only thing that can refuse a mode
 * is the document not declaring it — which `canvas.setMode` checks by name.
 *
 * @param {Tab | null} tab — the tab to move. `null` is a no-op.
 * @param {string} mode
 */
function setCanvasMode(tab: Tab | null, mode: string) {
  if (!tab) {
    return;
  }
  /* THIS tab's mode, not the focused pane's. `getCanvasMode()` here meant that leaving git-diff in
     the side pane kept `shell.git.diffState` alive whenever the primary was in some other mode —
     and, worse, that changing the PRIMARY's mode cleared the diff the side pane was still showing. */
  if (canvasModeOfTab(tab) === "git-diff" && mode !== "git-diff") {
    shell.git.diffState = null;
  }
  tab.session.ui.canvasMode = mode;
}

// ─── Component registry ───────────────────────────────────────────────────────

/**
 * Drill into a component (or a layout) — as a REAL TAB, not a document swapped in under the current
 * tab's id, and BESIDE the page rather than over it.
 *
 * The old implementation rewrote `tab.documentPath` and left `tab.id` alone, and everything
 * downstream believed the id: `openFileInTab`'s dedupe stopped matching, so re-opening the page
 * from the tree called `openTab` with an id that was already in the map — overwriting the entry
 * without disposing the old tab's effect scope and pushing a SECOND copy of the id into `tabOrder`,
 * which is a duplicate lit `repeat` key and a lost document stack.
 *
 * What the drill-in keeps is the RELATIONSHIP: the new tab records the document it was opened from
 * and the strip prints it. The parent stays open, right where it was.
 *
 * Four deliberate properties, three of them new and each with a failure behind it:
 *
 * 1. **To the side.** §8.2 has promised this since P3 and it never shipped — the chain ran
 *    `openFileInTab` → `openTab` → `activePane()`, so "open the layout that wraps this page" opened
 *    it ON TOP of the page it was teaching about.
 * 2. **Focus stays in the page.** An assistant pane that takes the keyboard means the author's next
 *    keystroke edits the definition instead of the document they are looking at — and a following
 *    pane would immediately have nothing to follow.
 * 3. **A PREVIEW tab**, because drilling in is browsing: the second drill-in takes the same slot
 *    instead of littering the side strip, and an edit promotes it (`promoteDirtyPreviewTabs`).
 * 4. **An ordinary tab, not a derivation.** "Edit definition" is a commitment to edit one component; a
 *    following pane would yank to a different one on the author's next canvas click. The following
 *    form is `pane.derive { preset: "component" }`, opted into by name.
 *
 * `openedFrom` is unchanged — §14.2's relationship, which nothing pops and nothing restores from.
 *
 * @param {string} componentPath
 */
async function navigateToComponent(componentPath: string) {
  const from = activeTab.value;
  /* {@link receivingPane}, not `sidePane`: the pane beside this one may be a LENS, which owns no
     tab. The open then landed in a `tabOrder` `tabOfPane` hops straight past, so the read below got
     the SOURCE tab back, `opened.documentPath !== componentPath`, and the one relationship this
     function exists to record (§14.2) was skipped without a sound. */
  const target = receivingPane();
  const alreadyOpen = [...workspace.tabs.values()].some((t) => t.documentPath === componentPath);
  await openFileInTab(componentPath, { focus: false, paneId: target.id, preview: true });
  const opened = tabOfPane(target.id);
  if (!alreadyOpen && from && opened && opened.documentPath === componentPath) {
    opened.session.openedFrom = { documentPath: from.documentPath, tabId: from.id };
  }
  setActivityTab("layers");
}

// There is no `navigateBack` / `navigateToLevel` here any more, and no `confirmLeaveDirtyChild`
// Beneath them. All three served the sub-document stack, which nothing could push onto — see
// `tabs/tab.ts`. The dirty prompt they shared was about a POPPED frame discarding a child's edits;
// A drilled-in component is a real tab now, and `panels/tab-strip.ts` owns the prompt for closing
// One. That prompt is two-way where this was three-way — see `showSaveDiscardDialog`'s ledger entry.

// ─── Webdata: datalists for autocomplete ──────────────────────────────────────

const datalistHost = document.createElement("div");
datalistHost.style.display = "contents";
document.body.append(datalistHost);
litRender(
  html`
    <datalist id="tag-names">
      ${webdata.allTags.map((tag: string) => html`<option value=${tag}></option>`)}
    </datalist>
    <datalist id="css-props"></datalist>
  `,
  datalistHost,
);

requestIdleCallback(() => {
  const dl = document.querySelector("#css-props");
  if (!dl) {
    return;
  }
  const frag = document.createDocumentFragment();
  for (const [name] of webdata.cssProps) {
    const opt = document.createElement("option");
    opt.value = name!;
    frag.append(opt);
  }
  dl.append(frag);
});

initCssData(webdata);

// ─── Module-level UI state (must be before render() call) ─────────────────────

// ─── Bootstrap ────────────────────────────────────────────────────────────────

// Register the default platform adapter (PAL) if none was pre-registered (desktop registers its own
// On window.__jxPlatform). resolveDefaultPlatform picks cloud when the shell signalled it, creating
// The cloud adapter inside THIS bundle so collab shares studio's single yjs, else the dev server.
if (!hasPlatform()) {
  registerPlatform(resolveDefaultPlatform());
}

mountResizeEdges();

// ─── Render loop ──────────────────────────────────────────────────────────────

/* The application frame, before anything adopts a host out of it. index.html carries an empty body
   and this is the only definition — see src/shell/tree.ts for what that fixed. */
mountShellTree();

initShellRefs();
// One effect projects the dock record onto the shell grid — collapse classes and column widths.
mountShell();

// Mount extracted panel modules
toolbarPanel.mount(toolbarEl, {
  closeFunctionEditor: () => closeFunctionEditor(),
  getCanvasMode,
  openProject: () => openProject(),
  openRecentProject: (root: string) => openRecentProject(root),
  renderCanvas: () => renderCanvas(),
  safeRenderRightPanel: () => safeRenderRightPanel(),
  saveFile: () => saveFile(),
  setCanvasMode,
});

initLayers();
initQuickSearch({ openRecentProject: (root: string) => openRecentProject(root) });

/* The pane's four surfaces come from its CELL, not from `document.querySelector`.
   `panels/pane-grid.ts` mounted through `mountShell()` above, so the primary's cell exists by now;
   each of these three modules still holds one host, which is exactly right while the grid draws one
   cell and is what `mountForPane` replaces when it draws two. */
const primaryCell = cellForPane(PRIMARY_PANE);

tabStrip.mount(primaryCell?.strip ?? document.createElement("div"));

paneContext.mount(primaryCell?.chrome ?? document.createElement("div"), {
  exportFile,
  // No `getCanvasMode`: the bar is drawn once per pane and asks its own pane. See `PaneContextCtx`.
  parseMediaEntries,
  setCanvasMode,
});

overlaysPanel.mount({
  isEditing,
  renderBlockActionBar,
});

initBlockActionBar({
  getCanvasMode,
  navigateToComponent,
});
// The iframe's re-emitted selection snapshot drives the parent format toolbar refresh (4b-2).
setToolbarRefresh(renderBlockActionBar);
// The other half of that seam: a pointerdown inside a canvas frame ends the bar's suppression (the
// Canvas is in play again). It is the only signal that can, because clicking the SAME
// Already-selected element changes nothing the render path can compare.
setCanvasPointerDownHandler(releaseBlockActionBar);
// The cross-origin insertion "+" click runs the parent-realm slash-menu → mutateInsertNode flow.
setInsertZoneClickHandler(runInsertZoneAction);
// Files dragged from the OS onto a canvas: upload, then replace an image's source or insert.
setFileDropHandler(applyFileDrop);
// Every upload surface routes through uploadAssets(); refresh the three caches that list project
// Files afterwards. Injected here because all three modules import from media-upload.
setMediaChangedHandler(async (dir) => {
  invalidateMediaCache();
  invalidateLibrary();
  await loadDirectory(dir);
  renderLeftPanel();
});
// The in-iframe "/" trigger drives the parent-realm Spectrum slash menu across the bridge.
setCanvasSlashHandler(canvasSlashHandler);
// Canvas right-clicks show the parent-realm Jx element context menu across the bridge.
setCanvasContextMenuHandler(makeCanvasContextMenuHandler());
// Stylebook hits decode to a TAG in the host and route here (null = clicked chrome/empty space).
setStylebookHitHandler((tag, media) => {
  if (tag) {
    selectStylebookTag(tag, media);
  } else {
    shell.stylebook.selection = null;
    updateSession(activeTab.value, { ui: { activeSelector: null } });
  }
});
/* Two duties, one listener, because both answer the same question: intent has left the canvas.
   Pointerdowns over the canvas land inside the cross-origin iframe and never reach this listener,
   so a hit here IS parent chrome — which is why the listener can be this blunt and why it cannot
   double-fire with the iframe's own click-away commit.

   1. Commit-on-parent-click: it ends the live inline-edit session, which the iframe cannot observe
      itself (layers panel, tab strip, right panel…).
   2. The block action bar goes with it. The bar is `position: fixed` and clamped into the window,
      so it can sit over the Document Header card, the pane context bar and the docks; an author
      working in the Inspector's Logic tab reported it "blocking a part of the interface that the
      user needs to utilize". It is SUPPRESSED, not dismissed — a plain dismiss flashes back on the
      next snapshot or overlay repaint — and it comes back the moment the canvas takes a pointer or
      the selection moves. Nothing here touches the selection: the Inspector edits the selected
      node, so a click into it must keep the thing it is about to edit.

   Both spare the edit-session chrome (`isEditChromeTarget`: the bar, its `⋮` menu, the link
   popover, the slash menu) — those surfaces act ON the session and the bar rather than away from
   them. Only the suppression spares the canvas STAGE, whose margins, artboard headers and insertion
   "+" are parent-realm elements around the frame: they are the canvas, not somewhere else in the
   shell, and hiding the bar to pan or to nudge the zoom would be the app losing the author's place
   for them. */
document.addEventListener(
  "pointerdown",
  (e) => {
    if (isEditChromeTarget(e.target)) {
      return;
    }
    if (getEditSnapshot().editing) {
      commitActiveEditSession();
    }
    if (!(e.target instanceof Node) || stageContaining(e.target) === null) {
      suppressBlockActionBar();
    }
  },
  true,
);

// Unsaved-changes guard: saving is explicit (no idle autosave), so warn before the window unloads
// While any open tab has unsaved edits. For collab tabs, `dirty` reflects the room-level unsaved
// State; closing loses in-memory edits that were never flushed to disk.
/*
 * `dirty` alone could not see a Monaco buffer, and quitting is the one exit no disposer follows.
 *
 * A keystroke in the source view or the dock's Logic tab reaches the document on a 600ms / 500ms
 * debounce, and nothing marks the tab dirty in the meantime — so typing the last character of a
 * handler and pressing ⌘Q left with no prompt at all. There is no flush to make here: `beforeunload`
 * cannot await, and the source view's commit parses through the format host before it assigns, so
 * the answer would arrive after the window is gone. The buffer is asked directly instead —
 * `tabBufferUnsaved` is the author's own typing that the document has not been given.
 */
export function hasUnsavedTabs(): boolean {
  for (const tab of workspace.tabs.values()) {
    if (tab.doc.dirty || tabBufferUnsaved(tab)) {
      return true;
    }
  }
  return false;
}

window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
  // The session, so a relaunch reopens what was open (§4.4). Before the prompt, not after: the
  // Author may cancel the close, and the record is the same either way.
  flushSession();
  if (hasUnsavedTabs()) {
    e.preventDefault();
    // Legacy browsers require a truthy returnValue to trigger the native confirm prompt.
    e.returnValue = "";
  }
});

/* No `initCanvasUtils` any more, and the three functions it injected are why.
   `getZoom` and `setZoomDirect` were `activeTab.value?.session.ui.zoom` — the FOCUSED pane's tab —
   while every geometry function in `canvas/canvas-utils.ts` already took an explicit
   `CanvasSurface`. So the pan and the wrap were per-stage and the SCALE was not: the unfocused pane
   drew at the focused tab's scale, the side pane's `+` zoomed the primary's document, and the side
   pane entering Design snapped the primary to whatever it had fitted itself to. `getCanvasMode`
   was the same shape one layer down. The module reaches all three through the surface it is given
   (`tabOfPane(surface.paneId)`), so there is nothing left to inject.

   No `initCanvasLiveRender` either, and it went for the same reason one layer further down again.
   `getCanvasMode` was the ONLY thing that context carried, and `resolveCanvasDocument` used it
   while ALSO reading `activeTab.value` for the document path, the layout toggle and the preview
   params — so the pane the render had already been resolved for was discarded and the focused
   pane's answers substituted for all six. It takes the tab now, and the injection point had
   nothing else in it. */
initCanvasPatcher({
  renderOverlays,
  scheduleCanvasRender,
});
// When the iframe canvas can't apply a posted patch surgically, fall back to a full render.
setIframePatchEscalation(scheduleCanvasRender);
// One global coordinator monitor drives cross-frame palette→canvas drops (Phase 4c).
registerCanvasDndBridge();
initCanvasRender({
  get gitDiffState() {
    return shell.git.diffState;
  },
  openFileFromTree,
  setCanvasMode,
  setGitDiffState: (state: GitDiffState | null) => {
    shell.git.diffState = state;
  },
});

initWelcome({
  addExistingRepo: async () => {
    const result = await openAddRepoModal();
    if (result) {
      // The catalogue gained an entry; refresh it before navigating into the project.
      void hydrateProjectList().then(() => {
        render();
      });
      void openRecentProject(result.root);
    }
  },
  cloneRepository: () => cloneRepository({ openRecentProject }),
  openNewProject: async (options) => {
    const result = await openNewProjectModal(options);
    if (result) {
      void openRecentProject(result.root);
    }
  },
  openProject: () => openProject(),
  openRecentProject: (root: string) => openRecentProject(root),
});

/* There is no stage-handover effect here any more.
   It existed because the shell had one `#canvas-wrap` and a pane is the unit of render, so "which
   pane owns the stage" had to be re-answered every time focus moved. `panels/pane-grid.ts` builds a
   cell per pane and registers its stage with it; nothing moves, and nothing has to be repainted
   because it changed hands. */

/**
 * One pane's render subscriptions.
 *
 * Effect-driven canvas rendering, split into three triggers so document changes can be
 * distinguished from mode/UI changes:
 *
 * - Doc-effect: tracks only the document root reference. Document mutations that were consumed
 *   surgically by the canvas patcher skip the full render here.
 * - Ui-effect: tracks canvas mode and UI flags; always schedules a full render.
 * - The colour-scheme post, which is a document-level attribute flip inside the iframe and
 *   deliberately never part of the ui-effect: flipping the scheme must not re-render.
 *
 * Scheduling is deduped inside `scheduleCanvasRender` (double-RAF).
 *
 * **Keyed on the PANE, not on `activeTab`, and this is what makes `⌘\` and Unsplit work at all.**
 * Both effects used to read the focused pane's tab and schedule "the" canvas. A split moves a tab
 * between panes without changing which tab is active, so neither effect re-ran: the pane the tab
 * LEFT went on displaying it, and Unsplit — where the survivor's `activeTabId` changes but
 * `activeTab` does not — left the primary showing document A while the strip, the jump bar and the
 * Inspector all said B. `tabOfPane` tracks the pane's own `activeTabId`, so the pane that changed
 * is the pane that repaints.
 *
 * @param {string} paneId
 */
function installPaneRenderEffects(paneId: string): void {
  /* The FOLLOW, in this pane's own scope so it stops when the pane leaves the grid.
     No preset subscribes nothing: `installDerivationEffects` declares this pane's own
     `activeTabId` and `tabOfPane(sourcePaneId)` for EVERY derivation, and `diff` and `breakpoint`
     are the two that add nothing beyond that — a lens follows STRUCTURALLY, through `tabOfPane`'s
     hop, which the three effects below already read. A comment here claimed the opposite of
     `pane-derive.ts`'s own docstring for a release; the inputs are listed once, at the effect that
     declares them, and this line points at it rather than restating it. */
  installDerivationEffects(paneId, derivationDeps);
  effect(() => {
    const tab = tabOfPane(paneId);
    if (tab) {
      const doc = tab.doc.document;
      if (doc && consumePatchedDocument(doc, paneId)) {
        return;
      }
    }
    scheduleCanvasRender(paneId);
  });
  effect(() => {
    const tab = tabOfPane(paneId);
    /* A derived pane's own view axes. A preset change and a breakpoint change are render inputs
       that live on the DERIVATION rather than on the tab, so without these a lens would keep
       drawing whatever it was created with. Accepted cost, stated: the shared `ui.canvasMode` read
       below means a mode flip in the source pane also re-runs the lens's ui-effect — one extra
       full render per human mode flip, which is not a per-keystroke path. */
    const derived = paneById(paneId)?.derived;
    void derived?.status;
    /* …and the SENTENCE, because the stage draws it. `canvas/canvas-render.ts` prints
       `derived.reason` for an unavailable derivation, and `status` alone does not move when the
       reason does: a diff lens that could not read its comparison, whose file the author then
       saves back to HEAD, stays `unavailable` while the sentence becomes "Nothing to compare".
       Untracked, the stage would keep the old sentence until something else repainted it. */
    void derived?.reason;
    if (derived?.kind === "lens") {
      void derived.mode;
      void derived.media;
    }
    if (tab) {
      void tab.doc.mode;
      void tab.session.ui.canvasMode;
      void tab.session.ui.editingFormula;
      void tab.session.ui.editingFunction;
      void tab.session.ui.featureToggles;
      void tab.session.ui.preview;
      void tab.session.ui.previewParams;
      void tab.session.ui.previewProps;
      void tab.session.ui.showLayout;
    }
    // Project-level render inputs: the stylebook catalogue's filters and the settings section are
    // Shell state, so a change repaints the canvas with or without a document focused.
    void shell.settingsTab;
    void shell.stylebook.tab;
    void shell.stylebook.filter;
    void shell.stylebook.customizedOnly;
    scheduleCanvasRender(paneId);
  });
  effect(() => {
    const scheme = tabOfPane(paneId)?.session.ui.previewColorScheme;
    // Scoped to THIS pane's stage: the scheme is a per-tab choice, and an unscoped post flipped
    // Both documents from one pane's control.
    postColorSchemeToLiveHosts(
      scheme === "light" || scheme === "dark" ? scheme : null,
      surfaceForPane(paneId).wrap,
    );
  });
  effect(() => {
    /*
     * The other half of `i18n.switchLocale`. Without this the control moves a chip and the artboard
     * goes on drawing the same document left-to-right, which makes the verb a label rather than a
     * rendering context. Scoped to THIS pane's stage for the reason the scheme effect above gives.
     */
    const locale = tabOfPane(paneId)?.session.ui.previewLocale ?? null;
    postLocaleToLiveHosts(locale, surfaceForPane(paneId).wrap);
  });
}

/**
 * Subscribe every drawn pane, and unsubscribe one that leaves the grid.
 *
 * A scope per pane rather than one loop over `workspace.panes`, because the distinction the two
 * effects above draw only survives if each pane is tracked separately: an effect that read both
 * panes' documents would re-render BOTH whenever either moved, and `consumePatchedDocument` would
 * skip both whenever one was patched.
 */
const _paneRenderScopes = new Map<string, EffectScope>();

effect(() => {
  const wanted = new Set(workspace.panes.map((pane) => pane.id));
  for (const [paneId, scope] of _paneRenderScopes) {
    if (!wanted.has(paneId)) {
      scope.stop();
      _paneRenderScopes.delete(paneId);
    }
  }
  for (const paneId of wanted) {
    if (_paneRenderScopes.has(paneId)) {
      continue;
    }
    const scope = effectScope();
    _paneRenderScopes.set(paneId, scope);
    scope.run(() => {
      installPaneRenderEffects(paneId);
    });
  }
});

rightPanelMod.mount({
  getCanvasMode,
  // The Assistant tab's body is built by the Inspector and handed to the module that owns the
  // Chat. Injected rather than imported so the dependency runs one way: chat-panel.ts calls back
  // Into right-panel.ts to select its own tab, and this is what keeps that from being a cycle.
  mountAssistant: (host) => chatPanelMod.mount(host),
  navigateToComponent,
  renderCanvas: () => renderCanvas(),
});

// The Document Header card — every document with frontmatter or `$head`. It has no host of its own:
// The stage hands one over (`canvas-render.ts`), and this only starts the reactive subscription.
frontmatterPanelMod.mount();

// The assistant's create_project tool adopts freshly scaffolded projects through the same
// Flow as the recent-projects list.
setProjectAdopter(openRecentProject);

leftPanelMod.mount({
  cloneRepository: () => cloneRepository({ openRecentProject }),
  defBadgeLabel,
  defCategory,
  defaultDef,
  getCanvasMode,
  navigateToComponent,
  registerComponentsDnD,
  registerElementsDnD,
  registerFileTreeDnD,
  registerLayersDnD,
  renderCanvas: () => renderCanvas(),
  // The Data panel's Refresh: a canvas re-render that ALSO lets automatic `Request` state entries
  // Fetch. Edit/design suppress them (a full render re-resolves every entry, so authoring would
  // Refetch constantly); re-firing them on demand is what that button is for.
  refreshData: () => {
    // ONE read of the focus, shared by the arm and the render. The Data panel is a Navigator
    // Surface, so its subject genuinely is the focused pane — but `allowAutoRequestsOnNextRender()`
    // And `renderCanvas()` each used to resolve that for themselves, and two resolutions of the
    // Same fact are two facts: arming a pane and then rendering a different one is a Refresh that
    // Refreshes nothing.
    const paneId = workspace.activePaneId;
    allowAutoRequestsOnNextRender(paneId);
    // Say so BEFORE the render, and let the iframe's `dataScope` reply be what stops saying it.
    // The button used to fire and repaint 200ms later on a timer, which reported "done" over the
    // Old values for anything slower than that — a Refresh that visibly did nothing.
    const tab = activeTab.value;
    if (tab) {
      tab.session.canvas.refreshing = true;
    }
    renderCanvas(paneId);
  },
  renderFilesTemplate,
  renderGitPanel,
  renderHeadTemplate,
  renderImportsTemplate,
  renderSignalsTemplate,
  setCanvasMode,
  setGitDiffState: (state: GitDiffState | null) => {
    shell.git.diffState = state;
  },
  webdata,
});

// Register all renderers with the store so render()/renderOnly() work
// Register remaining renderers for render()/renderOnly() compat during migration
registerRenderer("leftPanel", () => leftPanelMod.render());
registerRenderer("canvas", () => renderCanvas());
registerRenderer("rightPanel", () => rightPanelMod.render());
registerRenderer("frontmatterPanel", () => frontmatterPanelMod.render());
registerRenderer("seoModal", renderSeoModal);
registerRenderer("chatPanel", () => chatPanelMod.render());
registerRenderer("overlays", () => overlaysPanel.render());
renderStatusbar();
mountStatusbar();
// ⑥ The jump bar, in the pane's own grid cell above the context bar. It renders the whole address
// — project › file › node › node — and it is the only breadcrumb in the shell: the pane context
// Bar drew a second one, and it named a sub-document stack nothing could push onto.
mountJumpBar(primaryCell?.jump ?? document.createElement("div"));
mountActivityBar();

/* The background-click deselect moved into `editor/shortcuts.ts`'s `installStageGestures`, beside
   the wheel and the middle-drag, because it is a STAGE gesture: it compared against the app's one
   `#canvas-wrap` and one `view.panzoomWrap` and cleared `activeTab`'s selection, all three of which
   name the focused pane rather than the pane that was clicked. */

function safeRenderRightPanel() {
  rightPanelMod.render();
}

/* Monaco JS completions are registered by the function editor when it mounts (see panels/editors),
   NOT here. Registering at startup would await the lazy Monaco load and pull 12.6 MB back onto the
   cold-start path — the exact cost the lazy load exists to avoid. */

// Collab sessions serialize/parse through the format host when mirroring between the structure
// Tree and the shared source text, and surface freezes via the status bar.
configureCollabSerializer(serializeDocument);
configureCollabParser(async (tab, text) => {
  if (tab.documentPath && formatForPath(tab.documentPath)) {
    const parsed = await parseSourceForPath(tab.documentPath, text);
    return { document: parsed.document as JxMutableNode, frontmatter: parsed.frontmatter };
  }
  return { document: JSON.parse(text) as JxMutableNode };
});
// The source-canonical freeze is a STATE the author is being held in, not an error: a toast that
// Says so, keyed so a run of freezes is one message rather than a stack of identical ones.
configureCollabNotifier((message) => {
  notify.warn(message, { key: "collab.freeze", source: "Collaboration" });
});

let fsUnsub: (() => void) | null = null;
/** (Re)subscribe the sidebar to backend filesystem events for the active project. */
function ensureFsSync() {
  fsUnsub?.();
  fsUnsub = startFsSync({
    /* The four caches keyed on the project's file listing. Each one is derived — the pages tree
       behind the Link-target picker, the layouts listing plus the effective layout's `$head`, the
       `$paths` value enumerations, and the context bar's own memo of the enumerations it has
       already asked for — so a file appearing or disappearing is the only event that can make any
       of them wrong, and it is the same event for all four. The bar's memo is separate from
       `page-params`' because it is keyed per DOCUMENT rather than globally; leaving it behind kept
       a stale candidate list in the picker after the collection changed. */
    invalidateDerivedCaches: () => {
      invalidatePageRouteCache();
      invalidateLayoutPickerCache();
      invalidateParamValues();
      paneContext.resetParamValues();
    },
    onContentChange: reloadCleanTab,
    renderLeftPanel,
  });
}

const _urlParams = new URLSearchParams(location.search);
const _projectParam = _urlParams.get("project") || _urlParams.get("open");

if (!_projectParam) {
  // Electrobun (and other non-?project= hosts) load their project over RPC, so the ?project= branch
  // Below — which is the only place that calls platform.activate() — is skipped. Kick off activate()
  // Here UNCONDITIONALLY so this window's loopback canvasUrl is fetched on boot (the canvas iframe
  // Needs it); a render() once it resolves lets ensureHost swap an early default iframe for the
  // Loopback one (see iframe-host ensureHost's canvasUrl-changed rebuild).
  const _bootPlatform = getPlatform();
  // oxlint-disable-next-line unicorn/prefer-top-level-await -- fire-and-forget: must not block the initial render
  void _bootPlatform
    .activate?.()
    // No project is bound yet, so this call only warms the canvasUrl; a backend that refuses it
    // Still gets the render below rather than an unhandled rejection.
    ?.catch((error: unknown) => {
      console.error("Boot activation failed:", error);
    })
    .then(() => {
      render();
    });
}

if (_projectParam) {
  // ?project= mode: skip normal loadProject, set up site context from the path
  const isAbsPath =
    _projectParam.startsWith("/") ||
    _projectParam.startsWith("~") ||
    /^[A-Za-z]:[/\\]/.test(_projectParam);
  if (!isAbsPath) {
    notify.error(`?project= requires an absolute path (got "${_projectParam}").`, {
      key: "startup.projectParam",
      source: "Startup",
    });
    render();
  } else {
    render();
    const platform = getPlatform();
    // oxlint-disable-next-line unicorn/prefer-top-level-await -- deliberate fire-and-forget: project probing must not block the initial render
    void (async () => {
      // Hoisted out of the try so the failure can NAME what it failed to open. The catch used to
      // Report a bare `Error: <message>` because the only identifying fact was still block-scoped.
      let fileRelPath = _urlParams.get("file") || _projectParam;
      try {
        const siteCtx = platform.resolveSiteContext
          ? await platform.resolveSiteContext(_projectParam)
          : { sitePath: null };

        if (siteCtx.sitePath) {
          // Set PAL project root to absolute path so file ops work
          if (siteCtx.sitePath) {
            platform.projectRoot = siteCtx.sitePath;
            // Await activation so the server resolves project-relative static files
            if (platform.activate) {
              await platform.activate();
            }
          }

          setProjectState({
            dirs: new Map(),
            expanded: new Set(),
            isSiteProject: true,
            name: siteCtx.projectConfig?.name || "Project",
            projectConfig: siteCtx.projectConfig || null,
            projectDirs: [],
            projectRoot: siteCtx.sitePath,
            root: siteCtx.sitePath,
            searchQuery: "",
            selectedPath: siteCtx.fileRelPath || null,
          });
          setWorkspaceProject(siteCtx.sitePath, siteCtx.projectConfig || null);

          refreshExtensionUi(platform);
          await autoSyncProjectOnOpen();
          await ensureDependenciesInstalled();
          await loadComponentRegistry();

          // Load directory tree and populate projectDirs from conventional dirs found
          const conventionalDirs = new Set([
            "pages",
            "layouts",
            "components",
            "content",
            "data",
            "public",
            "styles",
          ]);
          const dirEntries = await platform.listDirectory(".");
          requireProjectState().dirs.set(".", dirEntries);
          const foundDirs = [];
          for (const e of dirEntries) {
            if (e.type === "directory" && conventionalDirs.has(e.name)) {
              foundDirs.push(e.name);
              requireProjectState().expanded.add(e.path || e.name);
              const sub = await platform.listDirectory(e.path || e.name);
              requireProjectState().dirs.set(e.path || e.name, sub);
            }
          }
          requireProjectState().projectDirs = foundDirs;
          void maybePromptJxsuiteUpdate(siteCtx.sitePath);
        }

        /*
         * THE SESSION — unless the URL named a document.
         *
         * A named document is an instruction and wins, whether it came from `?file=` or from a
         * `?project=` that pointed INTO the project. A bare `?project=<dir>` is "open this
         * project", and what that means is the documents it was last left with (§4.4) — the
         * `project.json → home page` redirect below is the answer this replaces.
         *
         * This branch opens inline and never went near `openHomePage`, so it was the one door of
         * four the session work would have missed, and it is the door a browser reload comes
         * through.
         *
         * It returns when something LANDED — a restored session, or the home page
         * `openLastSessionOrHome` falls back to. A project with neither (no session, no
         * `pages/index.*`) falls through to the inline open below, which is what opens
         * `project.json` itself for a project that has nothing else to show.
         */
        const named =
          _urlParams.get("file") ||
          (siteCtx.fileRelPath && !siteCtx.fileRelPath.endsWith("project.json")
            ? siteCtx.fileRelPath
            : null);
        if (!named) {
          await openLastSessionOrHome();
          if (activeTab.value) {
            render();
            renderLeftPanel();
            return;
          }
        }

        // Read and open the file
        fileRelPath = named ?? siteCtx.fileRelPath ?? _projectParam;

        // When opening project.json, default to home page instead (listing-based, no 404 probes).
        if (fileRelPath === "project.json" || fileRelPath.endsWith("/project.json")) {
          fileRelPath = (await findHomePage()) ?? "project.json";
        }

        const content = await platform.readFile(fileRelPath);
        if (content) {
          let frontmatter;
          let parsedDoc;
          let parsedMode;
          await loadFormats();
          const fileFormat = formatForPath(fileRelPath);
          if (fileFormat || !fileRelPath.endsWith(".json")) {
            // ParseSourceForPath throws a descriptive error when no format class claims the
            // Extension (better than letting JSON.parse choke on non-JSON source).
            const result = await parseSourceForPath(fileRelPath, content);
            parsedDoc = result.document;
            ({ frontmatter } = result);
            parsedMode = result.mode;
          } else {
            parsedDoc = JSON.parse(content) as JxMutableNode;
          }

          // Open in a tab
          openTab({
            id: fileRelPath,
            documentPath: fileRelPath,
            document: parsedDoc as JxMutableNode,
            ...(frontmatter != null && { frontmatter }),
            sourceFormat: fileFormat?.name ?? null,
          });

          if (parsedMode === "content" && activeTab.value) {
            activeTab.value.doc.mode = "content";
          }
          if (fileRelPath === "project.json" && activeTab.value) {
            activeTab.value.session.ui.canvasMode = "stylebook";
          }

          render();
          // Opening a file is stated by the tab strip and the status bar's DOCUMENT field.
        }
        /* This window may now write its session (§4.4). The `?file=` branch above opens inline and
           never reaches `openLastSessionOrHome`, which is the other place that says this — so
           without it a window opened at a named file would restore other windows' sessions and
           never record its own. */
        markSessionRestored(workspace.projectRoot);
      } catch (error) {
        notify.error(`Could not open ${fileRelPath || "the project"}.`, {
          detail: errorMessage(error),
          path: fileRelPath,
          source: "Open File",
        });
      }
    })();
  }
} else {
  // Normal mode: probe for project at server root
  void loadProject();
  render();
  ensureFsSync();
}

// Hydrate the recent-projects list from the backend store (desktop/chromium), then refresh the
// Toolbar dropdown + welcome screen, both of which read it synchronously.
// oxlint-disable-next-line unicorn/prefer-top-level-await -- deliberate fire-and-forget: hydration must not block initial render
void hydrateRecentProjects().then(() => {
  toolbarPanel.render();
  render();
});

// Hydrate the platform's project catalogue (dev server sites, cloud projects), then refresh the
// Welcome screen, which reads it synchronously. No-op on platforms without listProjects.
// oxlint-disable-next-line unicorn/prefer-top-level-await -- deliberate fire-and-forget: hydration must not block initial render
void hydrateProjectList().then(() => {
  render();
});

// Hydrate the account onboarding status (GitHub-App installation coverage on cloud), then refresh
// The welcome screen's install prompt. No-op on platforms without getAccountStatus.
// oxlint-disable-next-line unicorn/prefer-top-level-await -- deliberate fire-and-forget: hydration must not block initial render
void hydrateAccountStatus().then(() => {
  render();
});

// Hydrate user settings (AI connection parameters) from the backend store, then re-render so
// Key-gated surfaces (assistant gate, New Project Import/Agent tabs) see the stored key.
// oxlint-disable-next-line unicorn/prefer-top-level-await -- deliberate fire-and-forget: hydration must not block initial render
void hydrateSettings().then(() => {
  render();
});

/*
 * A setting changing repaints, wherever the change came from — this window's Preferences, or
 * hydration landing after boot. Key-gated surfaces (the assistant's setup notice, the New Project
 * gates, the Accounts list) read the store on the render path rather than caching a copy, so this
 * one subscription is what keeps every one of them honest.
 */
onSettingsChanged(() => {
  render();
});

/*
 * Another window changing a setting is news this one wants. Nothing is lost without it — a patch
 * cannot clobber a key it does not name — but a second window would otherwise show a provider that
 * had been reconfigured somewhere else until it was restarted.
 */
watchRemoteSettings();

/*
 * Settings are written on a queue that coalesces a burst into one send, so a change made in the
 * last moments before the window closes may still be in flight. Draining it here is the difference
 * between "your provider was saved" and a settings file that never heard about it.
 */
globalThis.addEventListener("beforeunload", () => {
  void settingsSettled();
});

// ─── Left panel: delegated to panels/left-panel.js ───────────────────────────

function renderLeftPanel() {
  leftPanelMod.render();
}

function loadProject() {
  return _loadProject();
}
/**
 * Open a project, in the window the user asked for, and report what actually happened.
 *
 * THE TARGET IS HONOURED HERE OR NOWHERE. `openProjectFlow` asks the question and this is the
 * bootstrap's side of that contract — which it did not hold up: the hook was wired as `openProject:
 * () => openProject()` against a function that took no target, so "New Window" was collected,
 * dropped on the floor, and fell through to the line below that re-roots THIS window. The dialog
 * worked, the answer was discarded, and picking a project in the file browser replaced the project
 * the user had just said to keep.
 */
async function openProject(target: ProjectOpenTarget = "thisWindow"): Promise<ProjectOpenOutcome> {
  // Repo-list platforms (cloud) pick from the user's writable repositories instead of a
  // Backend dialog; the choice opens through the same path as a recent project.
  if (platformUsesRepoPicker()) {
    const picked = await openProjectPickerModal();
    if (!picked) {
      return "cancelled";
    }
    // The catalogue may have gained an entry; refresh it before navigating into the project.
    void hydrateProjectList().then(() => {
      render();
    });
    void openRecentProject(picked.root);
    return "opened";
  }
  const platform = getPlatform();
  // ELSEWHERE, and nothing here closes: no `confirmCloseAll`, no `replaceAllTabs`, no re-rooting.
  // `pickProject` exists precisely so this branch can ask which project without `openProject()`'s
  // Side effect of binding the asking window to the answer. The window that opens loads it, adds
  // Its own recent-projects entry, and this one carries on untouched.
  if (target === "newWindow" && platform.pickProject && platform.openProjectInNewWindow) {
    const picked = await platform.pickProject();
    if (!picked) {
      return "cancelled";
    }
    const { focused } = await platform.openProjectInNewWindow(picked.root);
    return focused ? "focused" : "newWindow";
  }
  // The SECOND destroyer, and it was ungated for as long as the first one was. `openRecentProject`
  // Below asks `confirmCloseAll` and then calls `closeAllTabs`; this branch reaches
  // `files.ts`'s `replaceAllTabs`, which throws the same documents away by a different name — so an
  // Enumeration of "who calls closeAllTabs" reported the matrix complete while ⌘O, the toolbar
  // Button and the welcome screen all discarded unsaved work in silence. `platformUsesRepoPicker()`
  // Is true only for the cloud platform, so desktop and browser both arrived here.
  if (!(await tabStrip.confirmCloseAll("Opening another project"))) {
    return "cancelled";
  }
  const opened = await _openProject({ renderLeftPanel });
  ensureFsSync();
  return opened ? "opened" : "cancelled";
}
async function openRecentProject(root: string) {
  // One entry for the whole sequence, not three surfaces for its three phases. Opening a project
  // Used to chain a blocking spinner (dependencies), a transient status line (git sync) and a
  // Confirm-plus-spinner (@jxsuite update), none of them cancellable and none of them surviving
  // The frame they were drawn in — so an open that took forty seconds was indistinguishable from
  // One that had silently failed. Spec studio.md §16.4.
  const activity = beginActivity({
    title: `Opening ${root.split("/").pop() || root}`,
    source: "Open Project",
    steps: [
      "Sync with the remote",
      "Install dependencies",
      "Read the project",
      "Open the home page",
    ],
  });
  try {
    const platform = getPlatform();

    // Multi-window (desktop): if this window already holds a project, open the chosen one in a new
    // Window (focusing an existing window if it's already open) rather than replacing this project.
    if (projectState && platform.openProjectInNewWindow) {
      await platform.openProjectInNewWindow(root);
      activity.done("Opened in another window");
      return;
    }

    /* THE LAST UNGUARDED DESTROYER, and it is the biggest one.
       Past this point the window replaces its project, and `closeAllTabs()` below disposes every
       open document — dirty or not, with no prompt anywhere on the path. ⌘W, the tab ×, quitting
       and the preview slot's replacement each acquired a gate; this one, which throws away the
       whole workspace at once, never had one.
       Asked HERE rather than lower down because everything below it is one-way: `setWindowProject`
       binds this window's backend to the new root, `platform.projectRoot` moves the base every
       relative path resolves against, and `resetProjectShell` drops the surfaces that describe the
       project being left. A prompt after any of those can be answered "keep editing" and leave the
       app pointing at a project it is not showing. The one cost of asking first is the
       already-open-elsewhere case just below, where the switch turns out to be a window focus and
       nothing is closed: a redundant question, and never a lost document. */
    if (!(await tabStrip.confirmCloseAll("Opening another project"))) {
      activity.done("Kept the current project");
      return;
    }

    // Multi-window (desktop): bind THIS window's backend to the project before reading from it. If
    // The project is already open in another window, that window is focused and we bail here.
    if (platform.setWindowProject) {
      const res = await platform.setWindowProject(root);
      if (res.deduped) {
        activity.done("Already open in another window");
        return;
      }
    }

    platform.projectRoot = root;
    // Source control, the stylebook selection and the settings tab describe the project being
    // Left behind; carrying them over showed the previous repository's branch and file count
    // Under the new project's name. The poll timer is re-armed by the panel's next render.
    cleanupGitPanel();
    resetProjectShell();
    // The format registry is cached per project — the previous root's registry (often empty on a
    // Fresh desktop launch) must not answer for this project, or non-JSON documents fail with
    // "No format class imported" until a reload. Mirrors openProject in files.ts.
    refreshFormats();
    void loadFormats();
    refreshExtensionUi(platform);
    const content = await platform.readFile("project.json");
    const config = JSON.parse(content) as ProjectConfig;

    closeAllTabs();

    setProjectState({
      ...projectState,
      dirs: new Map(),
      expanded: new Set(),
      isSiteProject: true,
      name: config.name || root.split("/").pop()!,
      projectConfig: config,
      projectRoot: root,
      searchQuery: "",
      selectedPath: null,
    });
    setWorkspaceProject(root, config);

    activity.step("Sync with the remote");
    await autoSyncProjectOnOpen();
    activity.step("Install dependencies");
    await ensureDependenciesInstalled();
    activity.step("Read the project");
    await loadDirectory(".");
    await loadComponentRegistry();

    const conventionalDirs = new Set([
      "pages",
      "layouts",
      "components",
      "content",
      "data",
      "public",
      "styles",
    ]);
    const entries = requireProjectState().dirs.get(".") || [];
    for (const e of entries) {
      if (e.type === "directory" && conventionalDirs.has(e.name)) {
        requireProjectState().expanded.add(e.path || e.name);
        await loadDirectory(e.path || e.name);
      }
    }

    addRecentProject(requireProjectState().name, root);
    setActivityTab("files");
    renderLeftPanel();
    // The project's name is now permanent state in the status bar's PROJECT field.

    activity.step("Open the home page");
    await openLastSessionOrHome();
    ensureFsSync();
    activity.done(`Opened ${requireProjectState().name}`);
    void maybePromptJxsuiteUpdate(root);
  } catch (error) {
    // The project likely moved or was deleted — drop the stale entry so it stops cluttering the
    // List, and refresh the dropdown + welcome screen.
    removeRecentProject(root);
    toolbarPanel.render();
    render();
    // `fail` raises the Problem, so this path does NOT also notify: an operation with an Activity
    // Entry reports once (`studio-ui-guidelines.md` §13.3 rule 3).
    activity.log(errorMessage(error));
    activity.fail(`Could not open the project at ${root}.`, { path: root });
  }
}
function renderFilesTemplate() {
  return _renderFilesTemplate({
    openFileFromTree,
    openProject,
    renderLeftPanel,
  });
}
function openFileFromTree(path: string) {
  return openFileInTab(path);
}

// ─── Commands and the keyboard ────────────────────────────────────────────────

/**
 * Pointer/pan state for ONE pane's stage, read fresh on every gesture.
 *
 * Takes the surface rather than resolving `view.panX` / `getCanvasMode()`, both of which answered
 * for the focused pane: a wheel over the side pane wrote the primary's pan offsets and asked the
 * primary's mode whether panning was even allowed.
 */
const stageContext = (surface: CanvasSurface) => ({
  applyTransform: () => applyTransform(surface),
  canvasMode: canvasModeOfPane(surface.paneId),
  panX: surface.panX,
  panY: surface.panY,
  setPan: (x: number, y: number) => {
    surface.panX = x;
    surface.panY = y;
    surface.needsCenter = false;
  },
});

/**
 * The registry the keyboard dispatches through.
 *
 * Built here, in the bootstrap, because `createCommandRegistry` deliberately has no module-level
 * singleton: the context it closes over is this window's, and a second window gets its own.
 */
const commandRegistry = createCommandRegistry({
  getContext: createLiveContext({
    aiConfigured: hasAiCredentials,
    // The probe `live-context.ts` declared optional and nobody ever passed, so `ctx.ai.streaming`
    // Read false forever. `assistant.stop` is gated on it.
    aiStreaming: isAssistantStreaming,
    aiWaiting: isAssistantWaiting,
    canvasMode: getCanvasMode,
    isCaretActive,
    isModalOpen,
    platform: () => (hasPlatform() ? getPlatform() : null),
  }),
});

registerStudioCommands(
  commandRegistry,
  {
    // The toolbar owns this, and the difference matters on the desktop: its `openUrlExternally`
    // Hands the URL to the launcher's preview-navigate handler — the OS browser — where a bare
    // `window.open` would open a webview with no address bar. The browser build falls back to a
    // New tab either way.
    openInBrowser: () => toolbarPanel.runOpenInBrowser(),
    openProject,
    // Wrapped rather than passed by reference: `saveFile` takes an optional tab and reports
    // Whether the bytes landed, and a hook that neither supplies one nor reads the answer must not
    // Silently forward its own first argument as the tab to save.
    saveDocument: async () => {
      await saveFile();
    },
  },
  stageContext,
);

// Tab navigation (⌃Tab MRU cycling, ⌘⇧T reopen-closed) is defined beside the tab model it drives.
registerTabCommands(commandRegistry, { openFile: openFileInTab, openFileInPane });

/* The derivation's own two verbs (§18.4), beside the `PaneDerivation` they read and write rather
   than in `paneCommands()`. `tests/app-commands-composition.test.ts` is the guard that this line
   and `appCommandSet()`'s entry stay in step. */
commandRegistry.registerAll(derivationCommands(derivationDeps));

/*
 * The rest of the app's contribution points, each defined beside the state it writes.
 *
 * This block is the bootstrap's whole share of plan §13's registry work: every record below lives
 * in the module that implements it, and this is the ONE place that composes them into the registry
 * `__jxAutomation.run` projects. Nothing here decides what a command is called, when it is
 * available or what it does — that would be the second definition site the design exists to
 * prevent (plan §2, principle 1).
 */
registerShellViewCommands(commandRegistry, {
  // The registry's own answer, so a gated-off panel cannot be persisted as a showing tab.
  panelAvailable: (id) => {
    const panel = getPanel(id);
    return panel ? (panel.when?.(commandRegistry.context()) ?? true) : true;
  },
  inspectorTab: () => rightPanelMod.inspectorTab(),
  setInspectorTab: (tab) => rightPanelMod.setInspectorTab(tab),
});
registerCanvasViewCommands(commandRegistry, {
  getCanvasMode,
  renderPane: renderCanvas,
  setCanvasMode,
  setResolvingOpen: paneContext.setResolvingOpen,
});
registerSelectionSetCommand(commandRegistry);
registerInspectorCommands(commandRegistry);
/* Search appearance, behind one record with two buttons: the Document Header card's and the Page
   panel's. A surface that IS the capability is one the palette cannot reach. */
registerSeoCommands(commandRegistry);
registerA11yCommands(commandRegistry);
/* The element menu's eight verbs, in the APP registry rather than only in the popover's own. They
   have always declared `menus: ["context/element", "palette"]`; the palette has never listed one,
   because the only registry holding them was the one `editor/context-menu.ts` builds for itself.
   Their target falls back to the selection when no menu is open (`commandTarget`), which is what
   makes "Paste Style" a keyboard-reachable verb rather than a right-click-only one. */
commandRegistry.registerAll(liveElementCommands());
/* …and the navigation seam for the popover's FALLBACK registry, which it uses only in the window
   before this line runs (`contextMenuRegistry()` returns the app's registry once one exists). A
   fallback holding a no-op where navigation belongs is a registry that lies. */
setContextMenuNavigate(navigateToComponent);
registerDataExplorerCommands(commandRegistry, { renderLeftPanel });
registerSignalsCommands(commandRegistry);
registerFormulaEditorCommands(commandRegistry);
registerGridCommands(commandRegistry);
registerSettingsCommands(commandRegistry);
registerPreferencesCommands(commandRegistry);
registerLibraryCommands(commandRegistry);
registerContentCommands(commandRegistry);
/* The four translation verbs: open a sibling translation, create the missing one, show the
   Languages panel, declare a language. `i18n.switchLocale` is deliberately not among them — it sets
   a rendering context, so it lives with the other axis-3 verbs in `canvasViewCommands`. */
registerI18nCommands(commandRegistry);
registerNewProjectCommands(commandRegistry);
registerStyleCommands(commandRegistry);
registerSourceControlCommands(commandRegistry);
registerPublishCommands(commandRegistry);
registerGridViewCommands(commandRegistry);
registerRedirectsCommands(commandRegistry);
registerAboutCommands(commandRegistry);
registerCollabCommands(commandRegistry);
/* The `Assistant:` family (§11.1) — Focus Composer, New Chat, Chat History, Attach Selection, Retry
   and Stop. Every one existed as a button in the chat view and as nothing else, so the category held
   zero records and none of them was in the palette, bindable, or reachable by name. The chat header
   and the error row render these ids through the registry now, which is what makes this line the
   definition site rather than a second copy. */
commandRegistry.registerAll(assistantCommands());
/*
 * The structural selection verbs — Move Up/Down/In/Out, Convert to Component, Edit Component.
 *
 * They were already defined in `panels/block-action-bar.ts` beside the mutations they perform, but
 * only ever registered into that panel's OWN registry, so the palette, the keyboard and
 * `__jxAutomation` could not see them. `commandTargetPath()` falls back to the current selection
 * when no menu is open, which is precisely the app-wide meaning of these verbs.
 */
registerSelectionCommands(commandRegistry, { convertToComponent, navigateToComponent });
/* The format family — Bold, Italic, Code, Link and the four with no chord.
   Same story as the structural verbs above, one wave later: they were the block action bar's own,
   as a hand-written keydown switch rather than records, and the switch returned early whenever
   focus was inside the canvas iframe — which is the only place a canvas caret can be. */
commandRegistry.registerAll(formatCommands());

initShortcuts(commandRegistry, stageContext);

/* Hand the canvas frames the chord table.
   The iframe cannot see the registry, so it used to answer "does the parent want this keystroke?"
   from three hand-written lists that disagreed with the registry in both directions — ⌘A forwarded
   and prevented with nothing to run it, ⌘B withheld for an engine that never handled it. It
   resolves against this table instead, and `publishKeymap()` reposts it whenever a rebinding lands,
   which is what makes Preferences › Keyboard reach inside the page. */
setKeymapSource(
  () => ({
    chords: chordsInScopes(commandRegistry.keymap, FRAME_KEY_SCOPES),
    mac: commandRegistry.keymap.mac,
  }),
  (listener) => commandRegistry.keymap.onChange(listener),
);

// The gated scripting surface (`?automation=1` only) is a PROJECTION of the registry above, so it
// Installs after it — still inside this module's synchronous body, which is what the screenshot
// Runner's `waitForFunction(() => window.__jxAutomation)` and every deferred project load depend on.
installAutomationHook({ registry: commandRegistry, seedAssistantMessages, seedPublishConnected });
