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
  getNodeAtPath,
  initShellRefs,
  projectState,
  registerRenderer,
  render,
  requireProjectState,
  setProjectState,
  toolbarEl,
  updateUi,
} from "./store";

import { activeTab, closeAllTabs, openTab } from "./workspace/workspace";
import { mutateUpdateDef, mutateUpdateProperty, transactDoc } from "./tabs/transact";
import { effect } from "./reactivity";

import { view } from "./view";

import { isEditableBlock, isEditing } from "./editor/inline-edit";
import { enterComponentInlineEdit, initComponentInlineEdit } from "./editor/component-inline-edit";
import { enterInlineEdit } from "./editor/content-inline-edit";
import { applyTransform, initCanvasUtils, positionZoomIndicator } from "./canvas/canvas-utils";
import { findCanvasElement, getActivePanel, initCanvasHelpers } from "./canvas/canvas-helpers";
import {
  applyCanvasMediaOverrides,
  initCanvasRender,
  renderCanvas,
  renderOverlays,
  scheduleCanvasRender,
} from "./canvas/canvas-render";
import { consumePatchedDocument, initCanvasPatcher } from "./canvas/canvas-patcher";
import { registerSubtreeDnD } from "./panels/canvas-dnd";
import { initCanvasLiveRender } from "./canvas/canvas-live-render";
import {
  mountStatusbar,
  renderStatusbar,
  setStatusbarRenderer,
  statusMessage,
} from "./panels/statusbar";
import { exportFile, parseSourceForPath, saveFile, serializeDocument } from "./files/file-ops";
import { documentExtensions, formatForPath, loadFormats } from "./format/format-host";
import {
  loadProject as _loadProject,
  openProject as _openProject,
  renderFilesTemplate as _renderFilesTemplate,
  loadDirectory,
  openFileInTab,
  openHomePage,
  registerFileTreeDnD,
  setupTreeKeyboard,
} from "./files/files";
import { renderImportsTemplate } from "./panels/imports-panel";
import { renderHeadTemplate } from "./panels/head-panel";
import { exportCemManifest as _exportCemManifest } from "./services/cem-export";

import { getPlatform, hasPlatform, registerPlatform } from "./platform";
import { parseMediaEntries } from "./utils/canvas-media";
import { createDevServerPlatform } from "./platforms/devserver";
import { mountResizeEdges } from "./resize-edges";
import { codeService } from "./services/code-services";
import { defBadgeLabel, defCategory, renderSignalsTemplate } from "./panels/signals-panel";
import { loadComponentRegistry } from "./files/components";

import { html, render as litRender } from "lit-html";

import webdata from "../data/webdata.json";
import { renderDataExplorerTemplate } from "./panels/data-explorer";
import { cloneRepository, renderGitPanel } from "./panels/git-panel";

// ─── Spectrum Web Components ──────────────────────────────────────────────────
// Explicit class imports + registration — bare side-effect imports are tree-shaken
// By Bun's bundler despite sideEffects declarations in Spectrum's package.json.
import { components as _swc } from "./ui/spectrum";
import "./ui/panel-resize.js";
import { initLayers } from "./ui/layers";
import { initShortcuts } from "./editor/shortcuts";
import { renderActivityBar, mount as mountActivityBar } from "./panels/activity-bar";
import * as toolbarPanel from "./panels/toolbar";
import * as overlaysPanel from "./panels/overlays";
import * as rightPanelMod from "./panels/right-panel";
import * as leftPanelMod from "./panels/left-panel";
import * as tabStrip from "./panels/tab-strip";
import * as tabBar from "./panels/tab-bar";
import { renderStylebookOverlays } from "./panels/stylebook-panel";
import { registerLayersDnD, registerComponentsDnD, registerElementsDnD } from "./panels/dnd";
import { defaultDef } from "./panels/shared";
import { registerFunctionCompletions } from "./panels/editors";
import { renderBlockActionBar, initBlockActionBar } from "./panels/block-action-bar";
import { initCssData } from "./panels/style-utils";
import { updateForcedPseudoPreview } from "./panels/pseudo-preview";
import { initPanelEvents } from "./panels/panel-events";
import { initQuickSearch } from "./panels/quick-search";
import { addRecentProject } from "./recent-projects";
import { initWelcome } from "./panels/welcome-screen";
import { openNewProjectModal } from "./new-project/new-project-modal";
import type { DocumentStackEntry, GitDiffState } from "./types";
import type { JxPath } from "./state";
import type { JxMutableNode, ProjectConfig } from "@jxsuite/schema/types";

void _swc;

// ─── Globals ──────────────────────────────────────────────────────────────────
// These mutable variables are local to studio.js for now. As sections are extracted
// Into their own modules, they will migrate to ctx in store.js.

function getCanvasMode() {
  return activeTab.value?.session.ui.canvasMode ?? "design";
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

async function navigateBack() {
  const tab = activeTab.value;
  if (!tab?.session.documentStack || tab.session.documentStack.length === 0) {
    return;
  }
  if (tab.doc.dirty && tab.documentPath) {
    try {
      const platform = getPlatform();
      await platform.writeFile(tab.documentPath, await serializeDocument(tab));
    } catch (error) {
      const err = error as Error;
      statusMessage(`Save error: ${err.message}`);
    }
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
  if (tab.doc.dirty && tab.documentPath) {
    try {
      const platform = getPlatform();
      await platform.writeFile(tab.documentPath, await serializeDocument(tab));
    } catch (error) {
      const err = error as Error;
      statusMessage(`Save error: ${err.message}`);
    }
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
initQuickSearch();

tabStrip.mount(document.querySelector("#tab-strip") as HTMLElement);

tabBar.mount(document.querySelector("#tab-bar") as HTMLElement, {
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

initComponentInlineEdit({ findCanvasElement });
initCanvasHelpers({
  getCanvasMode,
  getZoom: () => activeTab.value?.session.ui.zoom ?? 1,
});
initCanvasUtils({
  getCanvasMode,
  getZoom: () => activeTab.value?.session.ui.zoom ?? 1,
  renderStylebookOverlays,
  setZoomDirect: (zoom) => {
    if (activeTab.value) {
      activeTab.value.session.ui.zoom = zoom;
    }
  },
});
initPanelEvents({
  enterInlineEdit,
  getCanvasMode,
  navigateToComponent,
});
initCanvasLiveRender({
  getCanvasMode,
});
initCanvasPatcher({
  applyCanvasMediaOverrides,
  enterComponentInlineEdit,
  getCanvasMode,
  registerSubtreeDnD,
  renderOverlays,
  scheduleCanvasRender,
  updateForcedPseudoPreview,
});
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
    void tab.session.ui.editingFunction;
    void tab.session.ui.featureToggles;
    void tab.session.ui.settingsTab;
    void tab.session.ui.stylebookTab;
    void tab.session.ui.stylebookFilter;
    void tab.session.ui.stylebookCustomizedOnly;
  }
  scheduleCanvasRender();
});

rightPanelMod.mount({
  getCanvasMode,
  navigateToComponent,
  renderCanvas: () => renderCanvas(),
  updateForcedPseudoPreview,
});

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

const _urlParams = new URLSearchParams(location.search);
const _projectParam = _urlParams.get("project") || _urlParams.get("open");

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
}

// ─── Left panel: delegated to panels/left-panel.js ───────────────────────────

function renderLeftPanel() {
  leftPanelMod.render();
}

function loadProject() {
  return _loadProject();
}
function openProject() {
  return _openProject({
    renderActivityBar: () => renderActivityBar(),
    renderLeftPanel,
  });
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
  } catch (error) {
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
  componentInlineEdit: view.componentInlineEdit,
  enterEditOnPath(path) {
    requestAnimationFrame(() => {
      const activePanel = getActivePanel();
      if (activePanel) {
        const el = findCanvasElement(path, activePanel.canvas);
        if (el && isEditableBlock(el)) {
          enterInlineEdit(el, path);
        }
      }
    });
  },
  openProject,
  panX: view.panX,
  panY: view.panY,
  positionZoomIndicator,
  saveFile,
  setPan: (x, y) => {
    view.panX = x;
    view.panY = y;
    view.needsCenter = false;
  },
}));

// ─── Autosave (registered as update middleware) ──────────────────────────────

const AUTO_SAVE_DELAY = 2000;

function scheduleAutosave() {
  const tab = activeTab.value;
  if (!tab?.fileHandle || !tab.doc.dirty) {
    return;
  }
  if (view.autosaveTimer) {
    clearTimeout(view.autosaveTimer);
  }
  view.autosaveTimer = setTimeout(async () => {
    const t = activeTab.value;
    if (t?.fileHandle && t.doc.dirty && "createWritable" in t.fileHandle) {
      try {
        const writable = await t.fileHandle.createWritable();
        await writable.write(await serializeDocument(t));
        await writable.close();
        t.doc.dirty = false;
        statusMessage("Auto-saved");
      } catch {}
    }
  }, AUTO_SAVE_DELAY);
}

effect(() => {
  if (activeTab.value?.doc.dirty) {
    scheduleAutosave();
  }
});
