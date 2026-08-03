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

import {
  canvasWrap,
  getNodeAtPath,
  initShellRefs,
  projectState,
  registerRenderer,
  render,
  requireProjectState,
  setProjectState,
  toolbarEl,
  updateSession,
  updateUi,
} from "./store";

import {
  activeTab,
  closeAllTabs,
  openTab,
  registerTabCommands,
  setWorkspaceProject,
  workspace,
} from "./workspace/workspace";
import { mutateUpdateDef, mutateUpdateProperty, transactDoc } from "./tabs/transact";
import { popSubDocument, popToSubDocument } from "./tabs/tab";
import { effect } from "./reactivity";

import { view } from "./view";
import {
  mountShell,
  registerShellViewCommands,
  resetProjectShell,
  setActivityTab,
  shell,
} from "./shell";

import { isEditing } from "./editor/inline-edit";
import { applyTransform, initCanvasUtils, registerCanvasViewCommands } from "./canvas/canvas-utils";
import {
  initCanvasRender,
  registerSelectionSetCommand,
  renderCanvas,
  renderOverlays,
  scheduleCanvasRender,
} from "./canvas/canvas-render";
import { consumePatchedDocument, initCanvasPatcher } from "./canvas/canvas-patcher";
import {
  commitActiveEditSession,
  allowAutoRequestsOnNextRender,
  getEditSnapshot,
  isCaretActive,
  postColorSchemeToLiveHosts,
  setCanvasContextMenuHandler,
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
import { initCanvasLiveRender } from "./canvas/canvas-live-render";
import {
  mountStatusbar,
  renderStatusbar,
  setStatusbarRenderer,
  statusMessage,
} from "./panels/statusbar";
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
  openFileInTab,
  openHomePage,
  registerFileTreeDnD,
  reloadCleanTab,
  setupTreeKeyboard,
} from "./files/files";
import { startFsSync } from "./files/fs-events";
import {
  configureCollabNotifier,
  configureCollabParser,
  configureCollabSerializer,
} from "./collab/collab-session";
import { renderImportsTemplate } from "./panels/imports-panel";
import { renderHeadTemplate } from "./panels/head-panel";
import { exportCemManifest as _exportCemManifest } from "./services/cem-export";
import { installAutomationHook } from "./services/automation";
import { invalidateBrowseCache } from "./browse/browse";
import { invalidateMediaCache } from "./ui/media-picker";
import { setMediaChangedHandler } from "./files/media-upload";
import { applyFileDrop } from "./editor/file-drop-action";
import { seedAssistantMessages } from "./panels/ai-panel";
import { seedPublishConnected } from "./publish/publish-panel";

import { getPlatform, hasPlatform, registerPlatform } from "./platform";
import { parseMediaEntries } from "./utils/canvas-media";
import { resolveDefaultPlatform } from "./platforms/default-platform";
import { mountResizeEdges } from "./resize-edges";
import { codeService } from "./services/code-services";
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
import { registerDataExplorerCommands, renderDataExplorerTemplate } from "./panels/data-explorer";
import { cleanupGitPanel, cloneRepository, renderGitPanel } from "./panels/git-panel";

// ─── Spectrum Web Components ──────────────────────────────────────────────────
// Explicit class imports + registration — bare side-effect imports are tree-shaken
// By Bun's bundler despite sideEffects declarations in Spectrum's package.json.
import { components as _swc } from "./ui/spectrum";
import "./ui/panel-resize.js";
// Built-in schema-form controls (schema-builder, secret) register on import
import "./ui/form-controls.js";
import { initLayers, isModalOpen, showSaveDiscardDialog } from "./ui/layers";
import { initShortcuts, registerStudioCommands } from "./editor/shortcuts";
import { createCommandRegistry } from "./commands/registry";
import { createLiveContext } from "./commands/live-context";
import { hasAiCredentials } from "./services/ai-models";
import { mount as mountActivityBar } from "./panels/activity-bar";
import * as toolbarPanel from "./panels/toolbar";
import * as overlaysPanel from "./panels/overlays";
import * as frontmatterPanelMod from "./panels/frontmatter-panel";
import * as rightPanelMod from "./panels/right-panel";
import * as chatPanelMod from "./panels/chat-panel";
import { setProjectAdopter } from "./services/project-adoption";
import * as leftPanelMod from "./panels/left-panel";
import * as tabStrip from "./panels/tab-strip";
import * as paneContext from "./panels/pane-context";
import { selectStylebookTag } from "./panels/stylebook-panel";
import { registerLayersDnD, registerComponentsDnD, registerElementsDnD } from "./panels/dnd";
import { registerCanvasDndBridge } from "./panels/canvas-dnd-bridge";
import { defaultDef } from "./panels/shared";
import { closeFormulaWorkspace, registerFormulaEditorCommands } from "./panels/formula-workspace";
import {
  initBlockActionBar,
  isEditChromeTarget,
  registerSelectionCommands,
  renderBlockActionBar,
} from "./panels/block-action-bar";
import { initCssData } from "./panels/style-utils";
import { initQuickSearch } from "./panels/quick-search";
import { hydrateAccountStatus } from "./account-status";
import { hydrateProjectList } from "./project-list";
import { addRecentProject, hydrateRecentProjects, removeRecentProject } from "./recent-projects";
import { hydrateSettings } from "./services/settings-store";
import { initWelcome } from "./panels/welcome-screen";
import {
  openAddRepoModal,
  openProjectPickerModal,
  platformUsesRepoPicker,
} from "./new-project/add-repo-modal";
import { openNewProjectModal, registerNewProjectCommands } from "./new-project/new-project-modal";
import { registerInspectorCommands } from "./panels/properties-panel";
import { registerStyleCommands } from "./panels/style-panel";
import { registerGridCommands } from "./grid/grid-open";
import { registerSettingsCommands } from "./settings/settings-modal";
import { registerPreferencesCommands } from "./settings/preferences-dialog";
import { registerBrowseCommands } from "./browse/browse-modal";
import { convertToComponent } from "./editor/convert-to-component";
import type { GitDiffState } from "./types";
import type { Tab } from "./tabs/tab";
import type { JxPath } from "./state";
import type { JxMutableNode, ProjectConfig } from "@jxsuite/schema/types";

void _swc;

// ─── Globals ──────────────────────────────────────────────────────────────────
// These mutable variables are local to studio.js for now. As sections are extracted
// Into their own modules, they will migrate to ctx in store.js.

// Effective canvas mode: the per-tab preview toggle composes with an edit/design base mode and
// Presents as "preview" to every downstream gate (doc resolution, iframe flags, interaction
// Surfaces). Consumers needing the base mode (toolbar switcher selection, canvas host layout)
// Read tab.session.ui.canvasMode directly.
function getCanvasMode() {
  const ui = activeTab.value?.session.ui;
  const base = ui?.canvasMode ?? "design";
  return ui?.preview && (base === "edit" || base === "design") ? "preview" : base;
}

/** @param {string} mode */
function setCanvasMode(mode: string) {
  if (getCanvasMode() === "git-diff" && mode !== "git-diff") {
    shell.git.diffState = null;
  }
  const tab = activeTab.value;
  if (tab) {
    tab.session.ui.canvasMode = mode;
  }
}

// ─── Component registry ───────────────────────────────────────────────────────

/**
 * Drill into a component (or a layout) — as a REAL TAB, not a document swapped in under the current
 * tab's id.
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
 * @param {string} componentPath
 */
async function navigateToComponent(componentPath: string) {
  const from = activeTab.value;
  const alreadyOpen = [...workspace.tabs.values()].some((t) => t.documentPath === componentPath);
  await openFileInTab(componentPath);
  const opened = activeTab.value;
  if (!alreadyOpen && from && opened && opened.documentPath === componentPath) {
    opened.session.openedFrom = { documentPath: from.documentPath, tabId: from.id };
  }
  setActivityTab("layers");
}

/**
 * Leaving a drilled-in component discards its edits (the pop restores the parent). Because saving
 * is explicit, prompt when the child is dirty: Save writes it, Discard drops it, Cancel stays.
 * Returns false to abort navigation.
 *
 * @param {Tab} tab
 */
async function confirmLeaveDirtyChild(tab: Tab): Promise<boolean> {
  if (!tab.doc.dirty || !tab.documentPath) {
    return true;
  }
  const name = tab.documentPath.split("/").pop() || "component";
  const choice = await showSaveDiscardDialog("Unsaved Changes", `"${name}" has unsaved changes.`);
  if (choice === "cancel") {
    return false;
  }
  if (choice === "save") {
    try {
      await getPlatform().writeFile(tab.documentPath, await serializeDocument(tab));
    } catch (error) {
      statusMessage(`Save error: ${(error as Error).message}`);
      return false;
    }
  }
  // "discard": leave without writing — the child's edits are dropped with the popped frame.
  return true;
}

/** Leave the innermost sub-document ($map template, function body) and restore the frame beneath. */
async function navigateBack() {
  const tab = activeTab.value;
  if (!tab || tab.session.documentStack.length === 0) {
    return;
  }
  if (!(await confirmLeaveDirtyChild(tab))) {
    return;
  }
  popSubDocument(tab);
  setActivityTab("layers");

  render();
  statusMessage("Returned to parent document");
}

/** @param {number} targetIndex */
async function navigateToLevel(targetIndex: number) {
  const tab = activeTab.value;
  const stack = tab?.session.documentStack;
  if (!tab || !stack || targetIndex < 0 || targetIndex >= stack.length) {
    return;
  }
  if (!(await confirmLeaveDirtyChild(tab))) {
    return;
  }
  popToSubDocument(tab, targetIndex);
  setActivityTab("layers");

  render();
  statusMessage("Returned to parent document");
}

async function closeFunctionEditor() {
  const tab = activeTab.value;
  const editing =
    /** @type {{ type: string; defName?: string; path?: JxPath; eventKey?: string } | null} */ tab
      ?.session.ui.editingFunction;
  if (!editing || !tab) {
    return;
  }
  if (view.functionEditor) {
    const currentCode = view.functionEditor.getValue();
    const minResult = await codeService("minify", { code: currentCode });
    const bodyToStore = minResult?.code ?? currentCode;
    if (editing.type === "def") {
      transactDoc(tab, (t) => mutateUpdateDef(t, editing.defName as string, { body: bodyToStore }));
    } else if (editing.type === "event") {
      const node = getNodeAtPath(tab.doc.document, editing.path as JxPath);
      const current = node?.[editing.eventKey as string] || {};
      transactDoc(tab, (t) =>
        mutateUpdateProperty(t, editing.path as JxPath, editing.eventKey as string, {
          .../** @type {object} */ current,
          $prototype: "Function",
          body: bodyToStore,
        }),
      );
    }
    view.functionEditor.dispose();
    view.functionEditor = null;
  }
  updateUi("editingFunction", null);
}

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

tabStrip.mount(document.querySelector("#tab-strip") as HTMLElement);

paneContext.mount(document.querySelector("#pane-chrome") as HTMLElement, {
  closeFormulaWorkspace: () => closeFormulaWorkspace(),
  closeFunctionEditor: () => closeFunctionEditor(),
  exportFile,
  getCanvasMode,
  navigateBack: () => navigateBack(),
  navigateToLevel: (i: number) => navigateToLevel(i),
  parseMediaEntries,
  setCanvasMode,
});

overlaysPanel.mount({
  getCanvasMode,
  isEditing,
  renderBlockActionBar,
});

initBlockActionBar({
  getCanvasMode,
  navigateToComponent,
});
// The iframe's re-emitted selection snapshot drives the parent format toolbar refresh (4b-2).
setToolbarRefresh(renderBlockActionBar);
// The cross-origin insertion "+" click runs the parent-realm slash-menu → mutateInsertNode flow.
setInsertZoneClickHandler(runInsertZoneAction);
// Files dragged from the OS onto a canvas: upload, then replace an image's source or insert.
setFileDropHandler(applyFileDrop);
// Every upload surface routes through uploadAssets(); refresh the three caches that list project
// Files afterwards. Injected here because all three modules import from media-upload.
setMediaChangedHandler(async (dir) => {
  invalidateMediaCache();
  invalidateBrowseCache();
  await loadDirectory(dir);
  renderLeftPanel();
});
// The in-iframe "/" trigger drives the parent-realm Spectrum slash menu across the bridge.
setCanvasSlashHandler(canvasSlashHandler);
// Canvas right-clicks show the parent-realm Jx element context menu across the bridge.
setCanvasContextMenuHandler(makeCanvasContextMenuHandler({ navigateToComponent }));
// Stylebook hits decode to a TAG in the host and route here (null = clicked chrome/empty space).
setStylebookHitHandler((tag, media) => {
  if (tag) {
    selectStylebookTag(tag, media);
  } else {
    shell.stylebook.selection = null;
    updateSession({ ui: { activeSelector: null } });
  }
});
// Commit-on-parent-click: a pointerdown in PARENT chrome outside the edit-session chrome (format
// Toolbar / link popover / slash menu) ends the live inline-edit session — the iframe can't observe
// Parent-realm pointer events (layers panel, tab strip, right panel…). Pointerdowns over the canvas
// Land inside the cross-origin iframe and never reach this listener, so it can't double-fire with
// The iframe's own click-away commit.
document.addEventListener(
  "pointerdown",
  (e) => {
    if (getEditSnapshot().editing && !isEditChromeTarget(e.target)) {
      commitActiveEditSession();
    }
  },
  true,
);

// Unsaved-changes guard: saving is explicit (no idle autosave), so warn before the window unloads
// While any open tab has unsaved edits. For collab tabs, `dirty` reflects the room-level unsaved
// State; closing loses in-memory edits that were never flushed to disk.
export function hasUnsavedTabs(): boolean {
  for (const tab of workspace.tabs.values()) {
    if (tab.doc.dirty) {
      return true;
    }
  }
  return false;
}

window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
  if (hasUnsavedTabs()) {
    e.preventDefault();
    // Legacy browsers require a truthy returnValue to trigger the native confirm prompt.
    e.returnValue = "";
  }
});

initCanvasUtils({
  getCanvasMode,
  getZoom: () => activeTab.value?.session.ui.zoom ?? 1,
  setZoomDirect: (zoom) => {
    if (activeTab.value) {
      activeTab.value.session.ui.zoom = zoom;
    }
  },
});
initCanvasLiveRender({
  getCanvasMode,
});
initCanvasPatcher({
  getCanvasMode,
  renderOverlays,
  scheduleCanvasRender,
});
// When the iframe canvas can't apply a posted patch surgically, fall back to a full render.
setIframePatchEscalation(scheduleCanvasRender);
// One global coordinator monitor drives cross-frame palette→canvas drops (Phase 4c).
registerCanvasDndBridge();
initCanvasRender({
  getCanvasMode,
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

// Effect-driven canvas rendering, split into two triggers so document changes can be
// Distinguished from mode/UI changes:
// - doc-effect: tracks only the document root reference. Document mutations that were
//   Consumed surgically by the canvas patcher skip the full render here.
// - ui-effect: tracks canvas mode and UI flags; always schedules a full render.
// Scheduling is deduped inside scheduleCanvasRender (double-RAF).
effect(() => {
  const tab = activeTab.value;
  if (tab) {
    const doc = tab.doc.document;
    if (doc && consumePatchedDocument(doc)) {
      return;
    }
  }
  scheduleCanvasRender();
});
effect(() => {
  const tab = activeTab.value;
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
  scheduleCanvasRender();
});
// Color-scheme preview is a document-level attribute flip inside the iframe — deliberately its
// Own effect, never part of the ui-effect above: flipping the scheme must not re-render.
effect(() => {
  const s = activeTab.value?.session.ui.previewColorScheme;
  postColorSchemeToLiveHosts(s === "light" || s === "dark" ? s : null);
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
    allowAutoRequestsOnNextRender();
    renderCanvas();
  },
  renderDataExplorerTemplate,
  renderFilesTemplate,
  renderGitPanel,
  renderHeadTemplate,
  renderImportsTemplate,
  renderSignalsTemplate,
  setCanvasMode,
  setGitDiffState: (state: GitDiffState | null) => {
    shell.git.diffState = state;
  },
  setupTreeKeyboard,
  webdata,
});

// Register all renderers with the store so render()/renderOnly() work
// Register remaining renderers for render()/renderOnly() compat during migration
registerRenderer("leftPanel", () => leftPanelMod.render());
registerRenderer("canvas", () => renderCanvas());
registerRenderer("rightPanel", () => rightPanelMod.render());
registerRenderer("frontmatterPanel", () => frontmatterPanelMod.render());
registerRenderer("chatPanel", () => chatPanelMod.render());
registerRenderer("overlays", () => overlaysPanel.render());
setStatusbarRenderer(() => renderStatusbar());
mountStatusbar();
mountActivityBar();

// Clicking on the canvas-wrap background (outside any canvas panel) deselects the current element
canvasWrap.addEventListener("click", (e: MouseEvent) => {
  if (e.target !== canvasWrap && e.target !== view.panzoomWrap) {
    return;
  }
  if (!activeTab.value?.session.selection) {
    return;
  }
  activeTab.value.session.selection = null;
});

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
configureCollabNotifier(statusMessage);

let fsUnsub: (() => void) | null = null;
/** (Re)subscribe the sidebar to backend filesystem events for the active project. */
function ensureFsSync() {
  fsUnsub?.();
  fsUnsub = startFsSync({ onContentChange: reloadCleanTab, renderLeftPanel });
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
    statusMessage(`Error: ?project= requires an absolute path (got "${_projectParam}")`);
    render();
  } else {
    render();
    const platform = getPlatform();
    // oxlint-disable-next-line unicorn/prefer-top-level-await -- deliberate fire-and-forget: project probing must not block the initial render
    void (async () => {
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

        // Read and open the file
        const _fileParam = _urlParams.get("file");
        let fileRelPath = _fileParam || siteCtx.fileRelPath || _projectParam;

        // When opening project.json, default to home page instead (listing-based, no 404 probes).
        if (fileRelPath === "project.json" || fileRelPath.endsWith("/project.json")) {
          fileRelPath = (await findHomePage()) ?? "project.json";
        }

        const content = await platform.readFile(fileRelPath);
        if (content) {
          let frontmatter, parsedDoc, parsedMode;
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
          statusMessage(`Opened ${fileRelPath}`);
        }
      } catch (error) {
        statusMessage(`Error: ${errorMessage(error)}`);
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

// ─── Left panel: delegated to panels/left-panel.js ───────────────────────────

function renderLeftPanel() {
  leftPanelMod.render();
}

function loadProject() {
  return _loadProject();
}
async function openProject() {
  // Repo-list platforms (cloud) pick from the user's writable repositories instead of a
  // Backend dialog; the choice opens through the same path as a recent project.
  if (platformUsesRepoPicker()) {
    const picked = await openProjectPickerModal();
    if (picked) {
      // The catalogue may have gained an entry; refresh it before navigating into the project.
      void hydrateProjectList().then(() => {
        render();
      });
      void openRecentProject(picked.root);
    }
    return;
  }
  const result = await _openProject({ renderLeftPanel });
  ensureFsSync();
  return result;
}
async function openRecentProject(root: string) {
  try {
    const platform = getPlatform();

    // Multi-window (desktop): if this window already holds a project, open the chosen one in a new
    // Window (focusing an existing window if it's already open) rather than replacing this project.
    if (projectState && platform.openProjectInNewWindow) {
      await platform.openProjectInNewWindow(root);
      return;
    }

    // Multi-window (desktop): bind THIS window's backend to the project before reading from it. If
    // The project is already open in another window, that window is focused and we bail here.
    if (platform.setWindowProject) {
      const res = await platform.setWindowProject(root);
      if (res.deduped) {
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

    await autoSyncProjectOnOpen();
    await ensureDependenciesInstalled();
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
    statusMessage(`Opened project: ${requireProjectState().name}`);

    await openHomePage();
    ensureFsSync();
    void maybePromptJxsuiteUpdate(root);
  } catch (error) {
    // The project likely moved or was deleted — drop the stale entry so it stops cluttering the
    // List, and refresh the dropdown + welcome screen.
    removeRecentProject(root);
    toolbarPanel.render();
    render();
    statusMessage(`Error: ${errorMessage(error)}`);
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

/** Pointer/pan state, read fresh on every gesture. */
const pointerContext = () => ({
  applyTransform,
  canvasMode: getCanvasMode(),
  panX: view.panX,
  panY: view.panY,
  setPan: (x: number, y: number) => {
    view.panX = x;
    view.panY = y;
    view.needsCenter = false;
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
    canvasMode: getCanvasMode,
    isCaretActive,
    isModalOpen,
    platform: () => (hasPlatform() ? getPlatform() : null),
  }),
});

registerStudioCommands(
  commandRegistry,
  {
    openInBrowser: () => {
      const target = toolbarPanel.openInBrowserTarget(activeTab.value ?? null);
      if ("url" in target) {
        window.open(target.url, "_blank", "noopener,noreferrer");
        return;
      }
      statusMessage(target.reason);
    },
    openProject,
    saveDocument: saveFile,
  },
  pointerContext,
);

// Tab navigation (⌃Tab MRU cycling, ⌘⇧T reopen-closed) is defined beside the tab model it drives.
registerTabCommands(commandRegistry, { openFile: openFileInTab });

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
  inspectorTab: () => rightPanelMod.inspectorTab(),
  setInspectorTab: (tab) => rightPanelMod.setInspectorTab(tab),
});
registerCanvasViewCommands(commandRegistry, { getCanvasMode, setCanvasMode });
registerSelectionSetCommand(commandRegistry);
registerInspectorCommands(commandRegistry);
registerDataExplorerCommands(commandRegistry, { renderLeftPanel });
registerSignalsCommands(commandRegistry, {
  renderCanvas: () => renderCanvas(),
  renderLeftPanel,
});
registerFormulaEditorCommands(commandRegistry, { renderCanvas: () => renderCanvas() });
registerGridCommands(commandRegistry);
registerSettingsCommands(commandRegistry);
registerPreferencesCommands(commandRegistry);
registerBrowseCommands(commandRegistry);
registerNewProjectCommands(commandRegistry);
registerStyleCommands(commandRegistry);
/*
 * The structural selection verbs — Move Up/Down/In/Out, Convert to Component, Edit Component.
 *
 * They were already defined in `panels/block-action-bar.ts` beside the mutations they perform, but
 * only ever registered into that panel's OWN registry, so the palette, the keyboard and
 * `__jxAutomation` could not see them. `commandTargetPath()` falls back to the current selection
 * when no menu is open, which is precisely the app-wide meaning of these verbs.
 */
registerSelectionCommands(commandRegistry, { convertToComponent, navigateToComponent });

initShortcuts(commandRegistry, pointerContext);

// The gated scripting surface (`?automation=1` only) is a PROJECTION of the registry above, so it
// Installs after it — still inside this module's synchronous body, which is what the screenshot
// Runner's `waitForFunction(() => window.__jxAutomation)` and every deferred project load depend on.
installAutomationHook({ registry: commandRegistry, seedAssistantMessages, seedPublishConnected });
