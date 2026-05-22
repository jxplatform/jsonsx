/**
 * Studio.js — Jx Studio main application
 *
 * Phase 1: Open a Jx file, render in canvas, edit properties in the inspector, see changes live,
 * and save. Phase 2: Tree editing with drag-and-drop reordering.
 */

import {
  getNodeAtPath,
  canvasWrap,
  toolbarEl,
  registerRenderer,
  render,
  projectState,
  setProjectState,
  updateUi,
} from "./store.js";

import { activeTab, openTab, replaceAllTabs } from "./workspace/workspace.js";
import { transactDoc, mutateUpdateDef, mutateUpdateProperty } from "./tabs/transact.js";
import { effect } from "./reactivity.js";

import { view } from "./view.js";

import { isEditing, isEditableBlock } from "./editor/inline-edit.js";
import { initComponentInlineEdit } from "./editor/component-inline-edit.js";
import { enterInlineEdit } from "./editor/content-inline-edit.js";
import { initCanvasUtils, applyTransform, positionZoomIndicator } from "./canvas/canvas-utils.js";
import { initCanvasHelpers, getActivePanel, findCanvasElement } from "./canvas/canvas-helpers.js";
import { initCanvasRender, renderCanvas } from "./canvas/canvas-render.js";
import { initCanvasLiveRender } from "./canvas/canvas-live-render.js";
import {
  renderStatusbar,
  statusMessage,
  setStatusbarRenderer,
  mountStatusbar,
} from "./panels/statusbar.js";
import { loadMarkdown, saveFile, exportFile, serializeDocument } from "./files/file-ops.js";
import {
  loadProject as _loadProject,
  openProject as _openProject,
  renderFilesTemplate as _renderFilesTemplate,
  openFileInTab,
  setupTreeKeyboard,
  loadDirectory,
} from "./files/files.js";
import { renderImportsTemplate } from "./panels/imports-panel.js";
import { renderHeadTemplate } from "./panels/head-panel.js";
import { exportCemManifest as _exportCemManifest } from "./services/cem-export.js";

import { registerPlatform, getPlatform, hasPlatform } from "./platform.js";
import { parseMediaEntries } from "./utils/canvas-media.js";
import { createDevServerPlatform } from "./platforms/devserver.js";
import { codeService } from "./services/code-services.js";
import { defCategory, defBadgeLabel, renderSignalsTemplate } from "./panels/signals-panel.js";
import { loadComponentRegistry } from "./files/components.js";

import { html, render as litRender } from "lit-html";

import webdata from "../data/webdata.json";
import { renderDataExplorerTemplate } from "./panels/data-explorer.js";
import { renderGitPanel } from "./panels/git-panel.js";

// ─── Spectrum Web Components ──────────────────────────────────────────────────
// Explicit class imports + registration — bare side-effect imports are tree-shaken
// by Bun's bundler despite sideEffects declarations in Spectrum's package.json.
import { components as _swc } from "./ui/spectrum.js"; // eslint-disable-line no-unused-vars
import "./ui/panel-resize.js";
import { initShortcuts } from "./editor/shortcuts.js";
import { renderActivityBar, mount as mountActivityBar } from "./panels/activity-bar.js";
import * as toolbarPanel from "./panels/toolbar.js";
import * as overlaysPanel from "./panels/overlays.js";
import * as rightPanelMod from "./panels/right-panel.js";
import * as leftPanelMod from "./panels/left-panel.js";
import * as tabStrip from "./panels/tab-strip.js";
import { renderStylebookOverlays } from "./panels/stylebook-panel.js";
import { registerLayersDnD, registerComponentsDnD, registerElementsDnD } from "./panels/dnd.js";
import { defaultDef } from "./panels/shared.js";
import { registerFunctionCompletions } from "./panels/editors.js";
import { renderBlockActionBar, initBlockActionBar } from "./panels/block-action-bar.js";
import { initCssData } from "./panels/style-utils.js";
import { updateForcedPseudoPreview } from "./panels/pseudo-preview.js";
import { initPanelEvents } from "./panels/panel-events.js";
import { initQuickSearch } from "./panels/quick-search.js";
import { addRecentProject } from "./recent-projects.js";

// ─── Globals ──────────────────────────────────────────────────────────────────
// These mutable variables are local to studio.js for now. As sections are extracted
// into their own modules, they will migrate to ctx in store.js.

/** Creates a display:contents container appended to sp-theme or body, for floating popovers/menus. */
function createFloatingContainer() {
  const el = document.createElement("div");
  el.style.display = "contents";
  (document.querySelector("sp-theme") || document.body).appendChild(el);
  return el;
}

function getCanvasMode() {
  return activeTab.value?.session.ui.canvasMode ?? "design";
}

/** @param {string} mode */
function setCanvasMode(mode) {
  if (getCanvasMode() === "git-diff" && mode !== "git-diff") {
    gitDiffState = null;
  }
  const tab = activeTab.value;
  if (tab) tab.session.ui.canvasMode = mode;
}

/** @type {any} */
let gitDiffState = null;

// ─── Component registry ───────────────────────────────────────────────────────

/** @param {any} componentPath */
async function navigateToComponent(componentPath) {
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
    tab.doc.mode = /** @type {any} */ (null);
    tab.doc.sourceFormat = null;
    tab.documentPath = componentPath;
    tab.session.selection = null;
    view.leftTab = "layers";
    tab.session.ui.activeMedia = null;
    tab.session.ui.activeSelector = null;

    render();
    statusMessage(`Editing component: ${parsed.tagName || componentPath}`);
  } catch (/** @type {any} */ e) {
    const err = /** @type {any} */ (e);
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
    } catch (/** @type {any} */ e) {
      const err = /** @type {any} */ (e);
      statusMessage(`Save error: ${err.message}`);
    }
  }

  // Pop the stack
  const frame = /** @type {any} */ (tab.session.documentStack.pop());
  if (!frame) return;
  tab.doc.document = frame.document;
  tab.doc.dirty = frame.dirty;
  tab.doc.mode = frame.mode;
  tab.doc.sourceFormat = frame.sourceFormat;
  tab.documentPath = frame.documentPath;
  tab.session.selection = frame.selection;
  view.leftTab = "layers";

  render();
  statusMessage("Returned to parent document");
}

async function closeFunctionEditor() {
  const tab = activeTab.value;
  const editing = /** @type {any} */ (tab?.session.ui.editingFunction);
  if (!editing) return;
  if (view.functionEditor) {
    const currentCode = view.functionEditor.getValue();
    const minResult = await codeService("minify", { code: currentCode });
    const bodyToStore = minResult?.code ?? currentCode;
    if (editing.type === "def") {
      transactDoc(tab, (t) => mutateUpdateDef(t, editing.defName, { body: bodyToStore }));
    } else if (editing.type === "event") {
      const node = getNodeAtPath(tab.doc.document, editing.path);
      const current = node?.[editing.eventKey] || {};
      transactDoc(tab, (t) =>
        mutateUpdateProperty(t, editing.path, editing.eventKey, {
          ...current,
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
      ${webdata.allTags.map((/** @type {any} */ tag) => html`<option value=${tag}></option>`)}
    </datalist>
    <datalist id="css-props">
      ${webdata.cssProps.map((/** @type {any} */ [name]) => html`<option value=${name}></option>`)}
    </datalist>
  `,
  datalistHost,
);

initCssData(webdata);

// ─── Module-level UI state (must be before render() call) ─────────────────────

// ─── Bootstrap ────────────────────────────────────────────────────────────────

// Register the dev server platform adapter (PAL) as default if none pre-registered
if (!hasPlatform()) {
  registerPlatform(createDevServerPlatform());
}

const EMPTY_DOC = {
  tagName: "div",
  style: { padding: "2rem", fontFamily: "system-ui, sans-serif" },
  children: [
    { tagName: "h1", textContent: "New Component" },
    { tagName: "p", textContent: "Open a Jx file or start editing." },
  ],
};

// Create the initial reactive tab — the canonical state container.
openTab({ id: "initial", document: structuredClone(EMPTY_DOC) });

// ─── Render loop ──────────────────────────────────────────────────────────────

// Mount extracted panel modules
toolbarPanel.mount(toolbarEl, {
  navigateBack: () => navigateBack(),
  closeFunctionEditor: () => closeFunctionEditor(),
  openProject: () => openProject(),
  openRecentProject: (/** @type {string} */ root) => openRecentProject(root),
  saveFile: () => saveFile(),
  parseMediaEntries,
  getCanvasMode,
  setCanvasMode,
  renderCanvas: () => renderCanvas(),
  safeRenderRightPanel: () => safeRenderRightPanel(),
});

initQuickSearch();

tabStrip.mount(/** @type {HTMLElement} */ (document.querySelector("#tab-strip")));

overlaysPanel.mount({
  getCanvasMode,
  isEditing,
  renderBlockActionBar,
});

initBlockActionBar({
  getCanvasMode,
  navigateToComponent,
  createFloatingContainer,
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
  get gitDiffState() {
    return gitDiffState;
  },
  setGitDiffState: (/** @type {any} */ state) => {
    gitDiffState = state;
  },
});

// Effect-driven canvas rendering: auto-triggers renderCanvas when reactive deps change
let _canvasRenderScheduled = false;
effect(() => {
  const tab = activeTab.value;
  if (!tab) return;
  void tab.doc.document;
  void tab.doc.mode;
  void tab.session.ui.canvasMode;
  void tab.session.ui.editingFunction;
  void tab.session.ui.featureToggles;
  void tab.session.ui.settingsTab;
  void tab.session.ui.stylebookTab;
  void tab.session.ui.stylebookFilter;
  void tab.session.ui.stylebookCustomizedOnly;
  if (!_canvasRenderScheduled) {
    _canvasRenderScheduled = true;
    queueMicrotask(() => {
      _canvasRenderScheduled = false;
      try {
        renderCanvas();
      } catch (e) {
        console.error("renderCanvas error:", e);
      }
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
  setGitDiffState: (/** @type {any} */ state) => {
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
canvasWrap.addEventListener("click", (/** @type {any} */ e) => {
  if (e.target !== canvasWrap && e.target !== view.panzoomWrap) return;
  if (!activeTab.value?.session.selection) return;
  activeTab.value.session.selection = null;
});

function safeRenderRightPanel() {
  rightPanelMod.render();
}

// Now that renderers are registered, bootstrap
registerFunctionCompletions();

const _openParam = new URLSearchParams(location.search).get("open");

if (_openParam) {
  // ?open= mode: skip normal loadProject, set up site context from the path
  const isAbsPath =
    _openParam.startsWith("/") || _openParam.startsWith("~") || /^[A-Za-z]:[/\\]/.test(_openParam);
  if (!isAbsPath) {
    statusMessage(`Error: ?open= requires an absolute path (got "${_openParam}")`);
    render();
  } else {
    render();
    const platform = getPlatform();
    (async () => {
      try {
        const siteCtx = platform.resolveSiteContext
          ? await platform.resolveSiteContext(_openParam)
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
            projectConfig: siteCtx.projectConfig,
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
          projectState.dirs.set(".", dirEntries);
          const foundDirs = [];
          for (const e of dirEntries) {
            if (e.type === "directory" && conventionalDirs.includes(e.name)) {
              foundDirs.push(e.name);
              projectState.expanded.add(e.path || e.name);
              const sub = await platform.listDirectory(e.path || e.name);
              projectState.dirs.set(e.path || e.name, sub);
            }
          }
          projectState.projectDirs = foundDirs;
        }

        // Read and open the file
        const _fileParam = new URLSearchParams(location.search).get("file");
        const fileRelPath = _fileParam || siteCtx.fileRelPath || _openParam;
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

          // Open in a tab (replaces initial tab)
          const { closeTab } = await import("./workspace/workspace.js");
          closeTab("initial");
          openTab({
            id: fileRelPath,
            documentPath: fileRelPath,
            document: parsedDoc,
            frontmatter,
            sourceFormat: isMd ? "md" : null,
          });

          if (isMd && activeTab.value) activeTab.value.doc.mode = "content";
          view.leftTab = "files";

          render();
          statusMessage(`Opened ${_openParam}`);
        }
      } catch (/** @type {any} */ e) {
        statusMessage(`Error: ${e.message}`);
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
async function openRecentProject(/** @type {string} */ root) {
  try {
    const platform = getPlatform();
    platform.projectRoot = root;
    const content = await platform.readFile("project.json");
    const config = JSON.parse(content);

    replaceAllTabs({ id: "initial", document: { tagName: "div", children: [] } });

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
    const entries = projectState.dirs.get(".") || [];
    for (const e of entries) {
      if (e.type === "directory" && conventionalDirs.includes(e.name)) {
        projectState.expanded.add(e.path || e.name);
        await loadDirectory(e.path || e.name);
      }
    }

    addRecentProject(projectState.name, root);
    view.leftTab = "files";
    renderActivityBar();
    renderLeftPanel();
    statusMessage(`Opened project: ${projectState.name}`);
  } catch (/** @type {any} */ e) {
    statusMessage(`Error: ${e.message}`);
  }
}
function renderFilesTemplate() {
  return _renderFilesTemplate({ openProject, openFileFromTree, renderLeftPanel });
}
function openFileFromTree(/** @type {any} */ path) {
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

/** @type {any} */
const AUTO_SAVE_DELAY = 2000;

function scheduleAutosave() {
  const tab = activeTab.value;
  if (!tab?.fileHandle || !tab.doc.dirty) return;
  clearTimeout(view.autosaveTimer);
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
