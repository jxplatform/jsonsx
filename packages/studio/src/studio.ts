/// <reference lib="dom" />
/**
 * Studio.js — Jx Studio main application
 *
 * Phase 1: Open a Jx file, render in canvas, edit properties in the inspector, see changes live,
 * and save. Phase 2: Tree editing with drag-and-drop reordering.
 */

import "./services/monaco-setup.js";
import { errorMessage } from "@jxsuite/schema/parse";

import {
  canvasWrap,
  chatPanelEl,
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
  setWorkspaceProject,
  workspace,
} from "./workspace/workspace";
import { mutateUpdateDef, mutateUpdateProperty, transactDoc } from "./tabs/transact";
import { effect } from "./reactivity";

import { view } from "./view";

import { isEditing } from "./editor/inline-edit";
import { applyTransform, initCanvasUtils } from "./canvas/canvas-utils";
import {
  initCanvasRender,
  renderCanvas,
  renderOverlays,
  scheduleCanvasRender,
} from "./canvas/canvas-render";
import { consumePatchedDocument, initCanvasPatcher } from "./canvas/canvas-patcher";
import {
  commitActiveEditSession,
  getEditSnapshot,
  postColorSchemeToLiveHosts,
  setCanvasContextMenuHandler,
  setCanvasSlashHandler,
  setIframePatchEscalation,
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
  documentExtensions,
  formatForPath,
  loadFormats,
  refreshExtensionUi,
  refreshFormats,
} from "./format/format-host";
import {
  loadProject as _loadProject,
  openProject as _openProject,
  renderFilesTemplate as _renderFilesTemplate,
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
import { openBrowseModal } from "./browse/browse-modal";
import { seedAssistantMessages } from "./panels/ai-panel";
import { seedPublishConnected } from "./publish/publish-panel";
import { openConnectorGrid } from "./grid/grid-open";

import { getPlatform, hasPlatform, registerPlatform } from "./platform";
import { parseMediaEntries } from "./utils/canvas-media";
import { createDevServerPlatform } from "./platforms/devserver";
import { mountResizeEdges } from "./resize-edges";
import { codeService } from "./services/code-services";
import { defBadgeLabel, defCategory, renderSignalsTemplate } from "./panels/signals-panel";
import { loadComponentRegistry } from "./files/components";
import { ensureDependenciesInstalled } from "./packages/ensure-deps";
import { maybePromptJxsuiteUpdate } from "./packages/jxsuite-update";
import { autoSyncProjectOnOpen } from "./packages/pull-package-sync";

import { html, render as litRender } from "lit-html";

import webdata from "../data/webdata.json";
import { renderDataExplorerTemplate } from "./panels/data-explorer";
import { cloneRepository, renderGitPanel } from "./panels/git-panel";

// ─── Spectrum Web Components ──────────────────────────────────────────────────
// Explicit class imports + registration — bare side-effect imports are tree-shaken
// By Bun's bundler despite sideEffects declarations in Spectrum's package.json.
import { components as _swc } from "./ui/spectrum";
import "./ui/panel-resize.js";
// Built-in schema-form controls (schema-builder, secret) register on import
import "./ui/form-controls.js";
import { initLayers, showSaveDiscardDialog } from "./ui/layers";
import { initShortcuts } from "./editor/shortcuts";
import { renderActivityBar, mount as mountActivityBar } from "./panels/activity-bar";
import * as toolbarPanel from "./panels/toolbar";
import * as overlaysPanel from "./panels/overlays";
import * as frontmatterPanelMod from "./panels/frontmatter-panel";
import * as rightPanelMod from "./panels/right-panel";
import * as chatPanelMod from "./panels/chat-panel";
import { setProjectAdopter } from "./services/project-adoption";
import * as leftPanelMod from "./panels/left-panel";
import * as tabStrip from "./panels/tab-strip";
import * as tabBar from "./panels/tab-bar";
import { selectStylebookTag } from "./panels/stylebook-panel";
import { registerLayersDnD, registerComponentsDnD, registerElementsDnD } from "./panels/dnd";
import { registerCanvasDndBridge } from "./panels/canvas-dnd-bridge";
import { defaultDef } from "./panels/shared";
import { registerFunctionCompletions } from "./panels/editors";
import { closeFormulaWorkspace } from "./panels/formula-workspace";
import {
  initBlockActionBar,
  isEditChromeTarget,
  renderBlockActionBar,
} from "./panels/block-action-bar";
import { initCssData } from "./panels/style-utils";
import { initQuickSearch, openQuickSearch } from "./panels/quick-search";
import { openSettingsModal } from "./settings/settings-modal";
import { hydrateAccountStatus } from "./account-status";
import { hydrateProjectList } from "./project-list";
import { addRecentProject, hydrateRecentProjects, removeRecentProject } from "./recent-projects";
import { hydrateSettings } from "./services/settings-store";
import { initWelcome } from "./panels/welcome-screen";
import { openAddRepoModal } from "./new-project/add-repo-modal";
import { openNewProjectModal } from "./new-project/new-project-modal";
import type { DocumentStackEntry, GitDiffState } from "./types";
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
    gitDiffState = null;
  }
  const tab = activeTab.value;
  if (tab) {
    tab.session.ui.canvasMode = mode;
  }
}

let gitDiffState: GitDiffState | null = null;

// ─── Component registry ───────────────────────────────────────────────────────

/** @param {string} componentPath */
async function navigateToComponent(componentPath: string) {
  try {
    const platform = getPlatform();
    const content = await platform.readFile(componentPath);
    if (!content) {
      return;
    }
    const parsed = JSON.parse(content) as JxMutableNode;
    const tab = activeTab.value;
    if (!tab) {
      return;
    }

    // Push current state onto the document stack
    const frame = {
      dirty: tab.doc.dirty,
      document: tab.doc.document,
      documentPath: tab.documentPath,
      mode: tab.doc.mode,
      selection: tab.session.selection,
      sourceFormat: tab.doc.sourceFormat,
    };
    if (!tab.session.documentStack) {
      tab.session.documentStack = [];
    }
    tab.session.documentStack.push(frame);

    // Load the component
    tab.doc.document = parsed;
    tab.doc.dirty = false;
    tab.doc.mode = null as unknown as string;
    tab.doc.sourceFormat = null;
    tab.documentPath = componentPath;
    tab.session.selection = null;
    view.leftTab = "layers";
    tab.session.ui.activeMedia = null;
    tab.session.ui.activeSelector = null;

    render();
    statusMessage(`Editing component: ${parsed.tagName || componentPath}`);
  } catch (error) {
    const err = error as Error;
    statusMessage(`Error: ${err.message}`);
  }
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

async function navigateBack() {
  const tab = activeTab.value;
  if (!tab?.session.documentStack || tab.session.documentStack.length === 0) {
    return;
  }
  if (!(await confirmLeaveDirtyChild(tab))) {
    return;
  }

  // Pop the stack
  const frame = tab.session.documentStack.pop() as Record<string, unknown> | undefined;
  if (!frame) {
    return;
  }
  tab.doc.document = frame.document as JxMutableNode;
  tab.doc.dirty = frame.dirty as boolean;
  tab.doc.mode = frame.mode as string;
  tab.doc.sourceFormat = frame.sourceFormat as string | null;
  tab.documentPath = frame.documentPath as string | null;
  tab.session.selection = frame.selection as JxPath | null;
  view.leftTab = "layers";

  render();
  statusMessage("Returned to parent document");
}

/** @param {number} targetIndex */
async function navigateToLevel(targetIndex: number) {
  const tab = activeTab.value;
  const stack = tab?.session.documentStack;
  if (!stack || targetIndex < 0 || targetIndex >= stack.length) {
    return;
  }
  if (!(await confirmLeaveDirtyChild(tab))) {
    return;
  }

  const frame = stack[targetIndex] as DocumentStackEntry;
  tab.session.documentStack = stack.slice(0, targetIndex);
  tab.doc.document = frame.document as JxMutableNode;
  tab.doc.dirty = frame.dirty as boolean;
  tab.doc.mode = frame.mode as string;
  tab.doc.sourceFormat = frame.sourceFormat as string | null;
  tab.documentPath = frame.documentPath as string | null;
  tab.session.selection = frame.selection as JxPath | null;
  view.leftTab = "layers";

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

// Register the dev server platform adapter (PAL) as default if none pre-registered
if (!hasPlatform()) {
  registerPlatform(createDevServerPlatform());
}

// Screenshot/automation runners (scripts/screenshots/) await window.__jxAutomation right after
// Navigation, so the gated hook must install before the async deep-link project load below.
installAutomationHook({
  getCanvasMode,
  openBrowseModal,
  openConnectorGrid,
  openNewProjectModal,
  openQuickSearchPalette: openQuickSearch,
  openSettingsModal,
  render,
  renderActivityBar,
  seedAssistantMessages,
  seedPublishConnected,
  setCanvasMode,
  statusMessage,
});

mountResizeEdges();

// ─── Render loop ──────────────────────────────────────────────────────────────

initShellRefs();

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

tabBar.mount(document.querySelector("#tab-bar") as HTMLElement, {
  closeFormulaWorkspace: () => closeFormulaWorkspace(),
  closeFunctionEditor: () => closeFunctionEditor(),
  exportFile,
  getCanvasMode,
  navigateBack: () => navigateBack(),
  navigateToLevel: (i: number) => navigateToLevel(i),
  parseMediaEntries,
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
// The in-iframe "/" trigger drives the parent-realm Spectrum slash menu across the bridge.
setCanvasSlashHandler(canvasSlashHandler);
// Canvas right-clicks show the parent-realm Jx element context menu across the bridge.
setCanvasContextMenuHandler(makeCanvasContextMenuHandler({ navigateToComponent }));
// Stylebook hits decode to a TAG in the host and route here (null = clicked chrome/empty space).
setStylebookHitHandler((tag, media) => {
  if (tag) {
    selectStylebookTag(tag, media);
  } else {
    updateSession({ ui: { activeSelector: null, stylebookSelection: null } });
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
    return gitDiffState;
  },
  openFileFromTree,
  setCanvasMode,
  setGitDiffState: (state: GitDiffState | null) => {
    gitDiffState = state;
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
  openNewProject: async () => {
    const result = await openNewProjectModal();
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
    void tab.session.ui.settingsTab;
    void tab.session.ui.showLayout;
    void tab.session.ui.stylebookTab;
    void tab.session.ui.stylebookFilter;
    void tab.session.ui.stylebookCustomizedOnly;
  }
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
  navigateToComponent,
  renderCanvas: () => renderCanvas(),
});

// Above-canvas frontmatter Properties panel (content-collection docs, edit mode).
frontmatterPanelMod.mount({ getCanvasMode });

// The persistent AI chat sidebar — mounts once, available with or without a project/document.
chatPanelMod.mount(chatPanelEl);
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
  renderDataExplorerTemplate,
  renderFilesTemplate,
  renderGitPanel,
  renderHeadTemplate,
  renderImportsTemplate,
  renderSignalsTemplate,
  setCanvasMode,
  setGitDiffState: (state: GitDiffState | null) => {
    gitDiffState = state;
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

// Now that renderers are registered, bootstrap
registerFunctionCompletions();

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
  void _bootPlatform.activate?.()?.then(() => {
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

        // When opening project.json, default to home page instead
        if (fileRelPath === "project.json" || fileRelPath.endsWith("/project.json")) {
          let opened = false;
          await loadFormats();
          const homeCandidates = [
            ...documentExtensions("page").map((ext) => `pages/index${ext}`),
            "pages/index.json",
          ];
          for (const candidate of homeCandidates) {
            try {
              await platform.readFile(candidate);
              fileRelPath = candidate;
              opened = true;
              break;
            } catch {}
          }
          if (!opened) {
            fileRelPath = "project.json";
          }
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
  const result = await _openProject({
    renderActivityBar: () => renderActivityBar(),
    renderLeftPanel,
  });
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
    view.leftTab = "files";
    renderActivityBar();
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

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
initShortcuts(() => ({
  applyTransform,
  canvasMode: getCanvasMode(),
  openProject,
  panX: view.panX,
  panY: view.panY,
  saveFile,
  setPan: (x, y) => {
    view.panX = x;
    view.panY = y;
    view.needsCenter = false;
  },
}));
