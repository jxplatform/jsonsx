/// <reference lib="dom" />
/**
 * Studio.js — Jx Studio main application
 *
 * Phase 1: Open a Jx file, render in canvas, edit properties in the inspector, see changes live,
 * and save. Phase 2: Tree editing with drag-and-drop reordering.
 */

import "./services/monaco-setup.js";

import {
  getNodeAtPath,
  canvasWrap,
  toolbarEl,
  registerRenderer,
  render,
  projectState,
  setProjectState,
  requireProjectState,
  updateUi,
  initShellRefs,
} from "./store";

import { activeTab, openTab, closeAllTabs } from "./workspace/workspace";
import { transactDoc, mutateUpdateDef, mutateUpdateProperty } from "./tabs/transact";
import { effect } from "./reactivity";

import { view } from "./view";

import { isEditing, isEditableBlock } from "./editor/inline-edit";
import { initComponentInlineEdit } from "./editor/component-inline-edit";
import { enterInlineEdit } from "./editor/content-inline-edit";
import { initCanvasUtils, applyTransform, positionZoomIndicator } from "./canvas/canvas-utils";
import { initCanvasHelpers, getActivePanel, findCanvasElement } from "./canvas/canvas-helpers";
import { initCanvasRender, renderCanvas } from "./canvas/canvas-render";
import { initCanvasLiveRender } from "./canvas/canvas-live-render";
import {
  renderStatusbar,
  statusMessage,
  setStatusbarRenderer,
  mountStatusbar,
} from "./panels/statusbar";
import { loadMarkdown, saveFile, exportFile, serializeDocument } from "./files/file-ops";
import {
  loadProject as _loadProject,
  openProject as _openProject,
  renderFilesTemplate as _renderFilesTemplate,
  openFileInTab,
  openHomePage,
  setupTreeKeyboard,
  registerFileTreeDnD,
  loadDirectory,
} from "./files/files";
import { renderImportsTemplate } from "./panels/imports-panel";
import { renderHeadTemplate } from "./panels/head-panel";
import { exportCemManifest as _exportCemManifest } from "./services/cem-export";

import { registerPlatform, getPlatform, hasPlatform } from "./platform";
import { parseMediaEntries } from "./utils/canvas-media";
import { createDevServerPlatform } from "./platforms/devserver";
import { mountResizeEdges } from "./resize-edges";
import { codeService } from "./services/code-services";
import { defCategory, defBadgeLabel, renderSignalsTemplate } from "./panels/signals-panel";
import { loadComponentRegistry } from "./files/components";

import { html, render as litRender } from "lit-html";

import webdata from "../data/webdata.json";
import { renderDataExplorerTemplate } from "./panels/data-explorer";
import { renderGitPanel } from "./panels/git-panel";

// ─── Spectrum Web Components ──────────────────────────────────────────────────
// Explicit class imports + registration — bare side-effect imports are tree-shaken
// by Bun's bundler despite sideEffects declarations in Spectrum's package.json.
import { components as _swc } from "./ui/spectrum";
void _swc;
import "./ui/panel-resize.js";
import { initLayers } from "./ui/layers";
import { initShortcuts } from "./editor/shortcuts";
import { renderActivityBar, mount as mountActivityBar } from "./panels/activity-bar";
import * as toolbarPanel from "./panels/toolbar";
import * as overlaysPanel from "./panels/overlays";
import * as rightPanelMod from "./panels/right-panel";
import * as leftPanelMod from "./panels/left-panel";
import * as tabStrip from "./panels/tab-strip";
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
import { cloneRepository } from "./panels/git-panel";
import type { DocumentStackEntry, GitDiffState } from "./types";
import type { JxPath } from "./state";
import type { JxMutableNode } from "@jxsuite/schema/types";

// ─── Globals ──────────────────────────────────────────────────────────────────
// These mutable variables are local to studio.js for now. As sections are extracted
// into their own modules, they will migrate to ctx in store.js.

function getCanvasMode() {
  return activeTab.value?.session.ui.canvasMode ?? "design";
}

/** @param {string} mode */
function setCanvasMode(mode: string) {
  if (getCanvasMode() === "git-diff" && mode !== "git-diff") {
    gitDiffState = null;
  }
  const tab = activeTab.value;
  if (tab) tab.session.ui.canvasMode = mode;
}

let gitDiffState: GitDiffState | null = null;

// ─── Component registry ───────────────────────────────────────────────────────

/** @param {string} componentPath */
async function navigateToComponent(componentPath: string) {
  try {
    const platform = getPlatform();
    const content = await platform.readFile(componentPath);
    if (!content) return;
    const parsed = JSON.parse(content);
    const tab = activeTab.value;
    if (!tab) return;

    // Push current state onto the document stack
    const frame = {
      document: tab.doc.document,
      selection: tab.session.selection,
      documentPath: tab.documentPath,
      dirty: tab.doc.dirty,
      mode: tab.doc.mode,
      sourceFormat: tab.doc.sourceFormat,
    };
    if (!tab.session.documentStack) tab.session.documentStack = [];
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
  } catch (e) {
    const err = e as Error;
    statusMessage(`Error: ${err.message}`);
  }
}

async function navigateBack() {
  const tab = activeTab.value;
  if (!tab?.session.documentStack || tab.session.documentStack.length === 0) return;
  if (tab.doc.dirty && tab.documentPath) {
    try {
      const platform = getPlatform();
      await platform.writeFile(tab.documentPath, serializeDocument(tab));
    } catch (e) {
      const err = e as Error;
      statusMessage(`Save error: ${err.message}`);
    }
  }

  // Pop the stack
  const frame = tab.session.documentStack.pop() as Record<string, unknown> | undefined;
  if (!frame) return;
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
  if (!stack || targetIndex < 0 || targetIndex >= stack.length) return;
  if (tab.doc.dirty && tab.documentPath) {
    try {
      const platform = getPlatform();
      await platform.writeFile(tab.documentPath, serializeDocument(tab));
    } catch (e) {
      const err = e as Error;
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
    /** @type {{ type: string; defName?: string; path?: JxPath; eventKey?: string } | null} */ (
      tab?.session.ui.editingFunction
    );
  if (!editing || !tab) return;
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
          .../** @type {object} */ (current),
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
document.body.appendChild(datalistHost);
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
  const dl = document.getElementById("css-props");
  if (!dl) return;
  const frag = document.createDocumentFragment();
  for (const [name] of webdata.cssProps) {
    const opt = document.createElement("option");
    opt.value = name;
    frag.appendChild(opt);
  }
  dl.appendChild(frag);
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
  navigateBack: () => navigateBack(),
  navigateToLevel: (i: number) => navigateToLevel(i),
  closeFunctionEditor: () => closeFunctionEditor(),
  openProject: () => openProject(),
  openRecentProject: (root: string) => openRecentProject(root),
  saveFile: () => saveFile(),
  parseMediaEntries,
  getCanvasMode,
  setCanvasMode,
  renderCanvas: () => renderCanvas(),
  safeRenderRightPanel: () => safeRenderRightPanel(),
});

initLayers();
initQuickSearch();

tabStrip.mount(document.querySelector("#tab-strip") as HTMLElement);

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
  setZoomDirect: (zoom) => {
    if (activeTab.value) activeTab.value.session.ui.zoom = zoom;
  },
  renderStylebookOverlays,
});
initPanelEvents({
  getCanvasMode,
  enterInlineEdit,
  navigateToComponent,
});
initCanvasLiveRender({
  getCanvasMode,
});
initCanvasRender({
  getCanvasMode,
  setCanvasMode,
  openFileFromTree,
  exportFile,
  closeFunctionEditor: () => closeFunctionEditor(),
  get gitDiffState() {
    return gitDiffState;
  },
  setGitDiffState: (state: GitDiffState | null) => {
    gitDiffState = state;
  },
});

initWelcome({
  openProject: () => openProject(),
  openRecentProject: (root: string) => openRecentProject(root),
  openNewProject: async () => {
    const result = await openNewProjectModal();
    if (result) openRecentProject(result.root);
  },
  cloneRepository: () => cloneRepository({ openRecentProject }),
});

// Effect-driven canvas rendering: auto-triggers renderCanvas when reactive deps change.
// Uses double-RAF so the canvas render yields to higher-priority panel paints first.
let _canvasRafId = 0;
effect(() => {
  const tab = activeTab.value;
  if (tab) {
    void tab.doc.document;
    void tab.doc.mode;
    void tab.session.ui.canvasMode;
    void tab.session.ui.editingFunction;
    void tab.session.ui.featureToggles;
    void tab.session.ui.settingsTab;
    void tab.session.ui.stylebookTab;
    void tab.session.ui.stylebookFilter;
    void tab.session.ui.stylebookCustomizedOnly;
  }
  if (!_canvasRafId) {
    _canvasRafId = requestAnimationFrame(() => {
      _canvasRafId = requestAnimationFrame(() => {
        _canvasRafId = 0;
        try {
          renderCanvas();
        } catch (e) {
          console.error("renderCanvas error:", e);
        }
      });
    });
  }
});

rightPanelMod.mount({
  navigateToComponent,
  getCanvasMode,
  renderCanvas: () => renderCanvas(),
  updateForcedPseudoPreview,
});

leftPanelMod.mount({
  getCanvasMode,
  setCanvasMode,
  renderImportsTemplate,
  renderFilesTemplate,
  renderSignalsTemplate,
  renderDataExplorerTemplate,
  renderHeadTemplate,
  renderGitPanel,
  renderCanvas: () => renderCanvas(),
  defCategory,
  defBadgeLabel,
  navigateToComponent,
  webdata,
  defaultDef,
  registerLayersDnD,
  registerElementsDnD,
  registerComponentsDnD,
  setupTreeKeyboard,
  registerFileTreeDnD,
  cloneRepository: () => cloneRepository({ openRecentProject }),
  setGitDiffState: (state: GitDiffState | null) => {
    gitDiffState = state;
  },
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
  if (e.target !== canvasWrap && e.target !== view.panzoomWrap) return;
  if (!activeTab.value?.session.selection) return;
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
    (async () => {
      try {
        const siteCtx = platform.resolveSiteContext
          ? await platform.resolveSiteContext(_projectParam)
          : { sitePath: null };

        if (siteCtx.sitePath) {
          // Set PAL project root to absolute path so file ops work
          if (siteCtx.sitePath) {
            platform.projectRoot = siteCtx.sitePath;
            // Await activation so the server resolves project-relative static files
            if (platform.activate) await platform.activate();
          }

          setProjectState({
            root: siteCtx.sitePath,
            name: siteCtx.projectConfig?.name || "Project",
            projectRoot: siteCtx.sitePath,
            isSiteProject: true,
            projectConfig: siteCtx.projectConfig || null,
            projectDirs: [],
            dirs: new Map(),
            expanded: new Set(),
            selectedPath: siteCtx.fileRelPath || null,
            searchQuery: "",
          });

          await loadComponentRegistry();

          // Load directory tree and populate projectDirs from conventional dirs found
          const conventionalDirs = [
            "pages",
            "layouts",
            "components",
            "content",
            "data",
            "public",
            "styles",
          ];
          const dirEntries = await platform.listDirectory(".");
          requireProjectState().dirs.set(".", dirEntries);
          const foundDirs = [];
          for (const e of dirEntries) {
            if (e.type === "directory" && conventionalDirs.includes(e.name)) {
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
          for (const candidate of ["pages/index.md", "pages/index.json"]) {
            try {
              await platform.readFile(candidate);
              fileRelPath = candidate;
              opened = true;
              break;
            } catch {}
          }
          if (!opened) fileRelPath = "project.json";
        }

        const content = await platform.readFile(fileRelPath);
        if (content) {
          let parsedDoc, frontmatter;
          const isMd = fileRelPath.endsWith(".md");
          if (isMd) {
            const result = await loadMarkdown(content);
            parsedDoc = result.document;
            frontmatter = result.frontmatter;
          } else {
            parsedDoc = JSON.parse(content);
          }

          // Open in a tab
          openTab({
            id: fileRelPath,
            documentPath: fileRelPath,
            document: parsedDoc,
            ...(frontmatter != null && { frontmatter }),
            sourceFormat: isMd ? "md" : null,
          });

          if (isMd && activeTab.value) activeTab.value.doc.mode = "content";
          if (fileRelPath === "project.json" && activeTab.value) {
            activeTab.value.session.ui.canvasMode = "stylebook";
          }

          render();
          statusMessage(`Opened ${fileRelPath}`);
        }
      } catch (e) {
        statusMessage(`Error: ${(e as Error).message}`);
      }
    })();
  }
} else {
  // Normal mode: probe for project at server root
  loadProject();
  render();
}

// ─── Left panel: delegated to panels/left-panel.js ───────────────────────────

function renderLeftPanel() {
  leftPanelMod.render();
}

// ─── DnD registration: delegated to panels/dnd.js ───────────────────────────

// ─── Stylebook ───────────────────────────────────────────────────────────────
// Extracted to panels/stylebook-panel.js

// ─── Inspector ────────────────────────────────────────────────────────────────
// Extracted to panels/properties-panel.js

// ─── Style Sidebar (metadata-driven) ───────────────────────────────────────────

// UNIT_RE — imported from ui/unit-selector.js

// inferInputType — imported from studio-utils.js

// ─── Style panel ────────────────────────────────────────────────────────────
// Extracted to panels/style-utils.js, panels/style-inputs.js, panels/style-panel.js

// ─── Source/Function editors: delegated to panels/editors.js ─────────────────

// ─── File tree (delegated to files.js) ───────────────────────────────────────

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
    platform.projectRoot = root;
    const content = await platform.readFile("project.json");
    const config = JSON.parse(content);

    closeAllTabs();

    setProjectState({
      ...projectState,
      projectRoot: root,
      isSiteProject: true,
      projectConfig: config,
      name: config.name || root.split("/").pop(),
      dirs: new Map(),
      expanded: new Set(),
      selectedPath: null,
      searchQuery: "",
    });

    await loadDirectory(".");
    await loadComponentRegistry();

    const conventionalDirs = [
      "pages",
      "layouts",
      "components",
      "content",
      "data",
      "public",
      "styles",
    ];
    const entries = requireProjectState().dirs.get(".") || [];
    for (const e of entries) {
      if (e.type === "directory" && conventionalDirs.includes(e.name)) {
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
  } catch (e) {
    statusMessage(`Error: ${(e as Error).message}`);
  }
}
function renderFilesTemplate() {
  return _renderFilesTemplate({ openProject, openFileFromTree, renderLeftPanel });
}
function openFileFromTree(path: string) {
  return openFileInTab(path);
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
initShortcuts(() => ({
  canvasMode: getCanvasMode(),
  panX: view.panX,
  panY: view.panY,
  setPan: (x, y) => {
    view.panX = x;
    view.panY = y;
    view.needsCenter = false;
  },
  applyTransform,
  positionZoomIndicator,
  componentInlineEdit: view.componentInlineEdit,
  saveFile,
  openProject,
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
}));

// ─── Autosave (registered as update middleware) ──────────────────────────────

const AUTO_SAVE_DELAY: number = 2000;

function scheduleAutosave() {
  const tab = activeTab.value;
  if (!tab?.fileHandle || !tab.doc.dirty) return;
  if (view.autosaveTimer) clearTimeout(view.autosaveTimer);
  view.autosaveTimer = setTimeout(async () => {
    const t = activeTab.value;
    if (t?.fileHandle && t.doc.dirty && "createWritable" in t.fileHandle) {
      try {
        const writable = await t.fileHandle.createWritable();
        await writable.write(serializeDocument(t));
        await writable.close();
        t.doc.dirty = false;
        statusMessage("Auto-saved");
      } catch {}
    }
  }, AUTO_SAVE_DELAY);
}

effect(() => {
  if (activeTab.value?.doc.dirty) scheduleAutosave();
});
