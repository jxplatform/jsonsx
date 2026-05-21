/**
 * Studio.js — Jx Studio main application
 *
 * Phase 1: Open a Jx file, render in canvas, edit properties in the inspector, see changes live,
 * and save. Phase 2: Tree editing with drag-and-drop reordering.
 */

import {
  createState,
  selectNode,
  updateProperty,
  updateDef,
  pushDocument,
  popDocument,
  getNodeAtPath,
  pathsEqual,
  canvasWrap,
  toolbarEl,
  canvasPanels,
  registerRenderer,
  render,
  update,
  setUpdateFn,
  setGetStateFn,
  addUpdateMiddleware,
  runUpdateMiddleware,
  addPostRenderHook,
  runPostRenderHooks,
  notify,
  projectState,
  setProjectState,
  updateUi,
  setUpdateSessionFn,
  setGetDocFn,
  setGetSessionFn,
  toFlat,
  fromFlat,
} from "./store.js";

import { view } from "./view.js";

import { isEditing, isEditableBlock } from "./editor/inline-edit.js";
import {
  enterComponentInlineEdit,
  initComponentInlineEdit,
} from "./editor/component-inline-edit.js";
import { enterInlineEdit } from "./editor/content-inline-edit.js";
import {
  initCanvasUtils,
  applyTransform,
  positionZoomIndicator,
  updateActivePanelHeaders,
} from "./canvas/canvas-utils.js";
import { initCanvasHelpers, getActivePanel, findCanvasElement } from "./canvas/canvas-helpers.js";
import { initCanvasRender, renderCanvas } from "./canvas/canvas-render.js";
import { initCanvasLiveRender } from "./canvas/canvas-live-render.js";
import {
  renderStatusbar,
  statusMessage,
  setStatusbarRenderer,
  mountStatusbar,
} from "./panels/statusbar.js";
import {
  openFile as _openFile,
  loadMarkdown as _loadMarkdown,
  saveFile as _saveFile,
  exportFile as _exportFile,
} from "./files/file-ops.js";
import {
  loadProject as _loadProject,
  openProject as _openProject,
  renderFilesTemplate as _renderFilesTemplate,
  openFileFromTree as _openFileFromTree,
  setupTreeKeyboard,
} from "./files/files.js";
import { eventsSidebarTemplate as _eventsSidebarTemplate } from "./panels/events-panel.js";
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
import { renderActivityBar } from "./panels/activity-bar.js";
import * as toolbarPanel from "./panels/toolbar.js";
import * as overlaysPanel from "./panels/overlays.js";
import * as rightPanelMod from "./panels/right-panel.js";
import * as leftPanelMod from "./panels/left-panel.js";
import { renderStylebookOverlays } from "./panels/stylebook-panel.js";
import { registerLayersDnD, registerComponentsDnD, registerElementsDnD } from "./panels/dnd.js";
import { defaultDef } from "./panels/shared.js";
import { registerFunctionCompletions } from "./panels/editors.js";
import { renderBlockActionBar, initBlockActionBar } from "./panels/block-action-bar.js";
import { initCssData } from "./panels/style-utils.js";
import { updateForcedPseudoPreview } from "./panels/pseudo-preview.js";
import { initPanelEvents } from "./panels/panel-events.js";

// ─── Globals ──────────────────────────────────────────────────────────────────
// These mutable variables are local to studio.js for now. As sections are extracted
// into their own modules, they will migrate to ctx in store.js.

/** @type {any} */
let S; // current state (flat compatibility view)
/** @type {any} */
let doc = null; // doc slice (persisted, history, autosave)
/** @type {any} */
let session = null; // session slice (selection, hover, ui)

/** Creates a display:contents container appended to sp-theme or body, for floating popovers/menus. */
function createFloatingContainer() {
  const el = document.createElement("div");
  el.style.display = "contents";
  (document.querySelector("sp-theme") || document.body).appendChild(el);
  return el;
}

let canvasMode = "design";

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
    S = pushDocument(S, parsed, componentPath);
    S.dirty = false;
    ({ doc, session } = fromFlat(S));
    render();
    statusMessage(`Editing component: ${parsed.tagName || componentPath}`);
  } catch (/** @type {any} */ e) {
    const err = /** @type {any} */ (e);
    statusMessage(`Error: ${err.message}`);
  }
}

async function navigateBack() {
  if (!S.documentStack || S.documentStack.length === 0) return;
  if (S.dirty && S.documentPath) {
    try {
      const platform = getPlatform();
      await platform.writeFile(S.documentPath, JSON.stringify(S.document, null, 2));
    } catch (/** @type {any} */ e) {
      const err = /** @type {any} */ (e);
      statusMessage(`Save error: ${err.message}`);
    }
  }
  S = popDocument(S);
  ({ doc, session } = fromFlat(S));
  render();
  statusMessage("Returned to parent document");
}

async function closeFunctionEditor() {
  const editing = S.ui.editingFunction;
  if (!editing) return;
  if (view.functionEditor) {
    const currentCode = view.functionEditor.getValue();
    const minResult = await codeService("minify", { code: currentCode });
    const bodyToStore = minResult?.code ?? currentCode;
    if (editing.type === "def") {
      update(updateDef(S, editing.defName, { body: bodyToStore }));
    } else if (editing.type === "event") {
      const node = getNodeAtPath(S.document, editing.path);
      const current = node?.[editing.eventKey] || {};
      update(
        updateProperty(S, editing.path, editing.eventKey, {
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

S = createState(structuredClone(EMPTY_DOC));
({ doc, session } = fromFlat(S));

// ─── Render loop ──────────────────────────────────────────────────────────────

// Mount extracted panel modules
toolbarPanel.mount(toolbarEl, {
  navigateBack: () => navigateBack(),
  closeFunctionEditor: () => closeFunctionEditor(),
  openProject: () => openProject(),
  openFile: () => openFile(),
  saveFile: () => saveFile(),
  parseMediaEntries,
  getCanvasMode: () => canvasMode,
  setCanvasMode: (/** @type {string} */ m) => {
    // Clear gitDiffState when exiting diff mode via toolbar
    if (canvasMode === "git-diff" && m !== "git-diff") {
      gitDiffState = null;
    }
    canvasMode = m;
  },
  renderCanvas: () => renderCanvas(),
  safeRenderRightPanel: () => safeRenderRightPanel(),
});

overlaysPanel.mount({
  getCanvasMode: () => canvasMode,
  isEditing,
  renderBlockActionBar,
});

initBlockActionBar({
  getCanvasMode: () => canvasMode,
  navigateToComponent,
  createFloatingContainer,
});

initComponentInlineEdit({ findCanvasElement });
initCanvasHelpers({ getCanvasMode: () => canvasMode });
initCanvasUtils({
  getCanvasMode: () => canvasMode,
  getZoom: () => S.ui.zoom,
  setZoomDirect: (zoom) => {
    session = { ...session, ui: { ...session.ui, zoom } };
    S = toFlat(doc, session);
  },
  renderStylebookOverlays,
});
initPanelEvents({
  getState: () => S,
  setState: (s) => {
    S = s;
    ({ doc, session } = fromFlat(S));
  },
  getCanvasMode: () => canvasMode,
  enterInlineEdit,
  navigateToComponent,
});
initCanvasLiveRender({
  getState: () => S,
  getCanvasMode: () => canvasMode,
});
initCanvasRender({
  getCanvasMode: () => canvasMode,
  setCanvasMode: (/** @type {string} */ mode) => {
    // Clear gitDiffState when exiting diff mode
    if (canvasMode === "git-diff" && mode !== "git-diff") {
      gitDiffState = null;
    }
    canvasMode = mode;
  },
  getState: () => S,
  update,
  openFileFromTree,
  exportFile,
  gitDiffState,
  setGitDiffState: (/** @type {any} */ state) => {
    gitDiffState = state;
  },
});

rightPanelMod.mount({
  navigateToComponent,
  getCanvasMode: () => canvasMode,
  renderCanvas: () => renderCanvas(),
  updateForcedPseudoPreview,
});

leftPanelMod.mount({
  getCanvasMode: () => canvasMode,
  setCanvasMode: (/** @type {string} */ mode) => {
    canvasMode = mode;
  },
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
});

// Register all renderers with the store so render()/renderOnly() work
registerRenderer("toolbar", () => toolbarPanel.render());
registerRenderer("activityBar", () => renderActivityBar(S));
registerRenderer("leftPanel", () => leftPanelMod.render());
registerRenderer("canvas", () => renderCanvas());
registerRenderer("rightPanel", () => rightPanelMod.render());
registerRenderer("overlays", () => overlaysPanel.render());
registerRenderer("statusbar", () => renderStatusbar(S));
setStatusbarRenderer(() => renderStatusbar(S));
mountStatusbar();

// Clicking on the canvas-wrap background (outside any canvas panel) deselects the current element
canvasWrap.addEventListener("click", (/** @type {any} */ e) => {
  if (e.target !== canvasWrap && e.target !== view.panzoomWrap) return;
  if (!S.selection) return;
  update(selectNode(S, null));
});

function safeRenderLeftPanel() {
  leftPanelMod.render();
}

function safeRenderRightPanel() {
  rightPanelMod.render();
}

// Register the update implementation with the store
setGetStateFn(() => S);
setUpdateFn(function _update(/** @type {any} */ newState) {
  const prev = S;
  const prevDoc = S.document;
  const prevSel = S.selection;
  S = newState;

  // Keep doc/session slices in sync with flat S
  ({ doc, session } = fromFlat(S));

  const docChanged = prevDoc !== S.document;
  const selChanged = !pathsEqual(prevSel, S.selection);
  const modeChanged = prev.mode !== S.mode;
  const uiChanged = prev.ui !== S.ui;

  const canvasUiChanged =
    uiChanged &&
    (prev.ui?.editingFunction !== S.ui?.editingFunction ||
      prev.ui?.settingsTab !== S.ui?.settingsTab ||
      prev.ui?.stylebookTab !== S.ui?.stylebookTab ||
      prev.ui?.stylebookFilter !== S.ui?.stylebookFilter ||
      prev.ui?.stylebookCustomizedOnly !== S.ui?.stylebookCustomizedOnly ||
      prev.ui?.featureToggles !== S.ui?.featureToggles);
  const leftUiChanged =
    uiChanged && (prev.ui?.leftTab !== S.ui?.leftTab || prev.ui?.settingsTab !== S.ui?.settingsTab);

  if (docChanged || modeChanged || canvasUiChanged) {
    try {
      renderCanvas();
    } catch (e) {
      console.error("renderCanvas error:", e);
    }
    safeRenderLeftPanel();
  } else if (selChanged || leftUiChanged) {
    safeRenderLeftPanel();
  }

  if (uiChanged && prev.ui?.activeMedia !== S.ui?.activeMedia) {
    updateActivePanelHeaders();
  }

  runPostRenderHooks(prevDoc, prevSel);
  runUpdateMiddleware(S);

  notify({
    doc: docChanged,
    selection: selChanged,
    hover: false,
    ui: uiChanged,
    mode: modeChanged,
  });
});

// Register session dispatch — lightweight path for selection/hover/ui changes
setGetDocFn(() => doc);
setGetSessionFn(() => session);
setUpdateSessionFn(function _updateSession(/** @type {any} */ patch) {
  const prev = session;
  session = { ...session, ...patch };
  if (patch.ui) {
    session.ui = { ...prev.ui, ...patch.ui };
  }
  if (patch.canvas) {
    session.canvas = { ...prev.canvas, ...patch.canvas };
  }
  S = toFlat(doc, session);

  const selChanged = !pathsEqual(prev.selection, session.selection);
  const uiChanged = prev.ui !== session.ui;
  const canvasChanged = prev.canvas !== session.canvas;

  const canvasUiChanged =
    uiChanged &&
    (prev.ui?.editingFunction !== session.ui?.editingFunction ||
      prev.ui?.settingsTab !== session.ui?.settingsTab ||
      prev.ui?.stylebookTab !== session.ui?.stylebookTab ||
      prev.ui?.stylebookFilter !== session.ui?.stylebookFilter ||
      prev.ui?.stylebookCustomizedOnly !== session.ui?.stylebookCustomizedOnly ||
      prev.ui?.featureToggles !== session.ui?.featureToggles);
  const leftUiChanged =
    uiChanged &&
    (prev.ui?.leftTab !== session.ui?.leftTab || prev.ui?.settingsTab !== session.ui?.settingsTab);

  if (canvasUiChanged) {
    try {
      renderCanvas();
    } catch (e) {
      console.error("renderCanvas error:", e);
    }
    safeRenderLeftPanel();
  } else if (selChanged || leftUiChanged) {
    safeRenderLeftPanel();
  }

  if (uiChanged && prev.ui?.activeMedia !== session.ui?.activeMedia) {
    updateActivePanelHeaders();
  }

  // Process pending inline edit when canvas becomes ready
  if (canvasChanged && session.canvas.status === "ready" && session.ui?.pendingInlineEdit) {
    const { path, mediaName: mn } = session.ui.pendingInlineEdit;
    updateUi("pendingInlineEdit", null);
    const targetPanel =
      canvasPanels.find((/** @type {any} */ p) => p.mediaName === mn) || canvasPanels[0];
    if (targetPanel) {
      const el = findCanvasElement(path, targetPanel.canvas);
      if (el) enterComponentInlineEdit(el, path);
    }
  }

  runPostRenderHooks(doc.document, prev.selection);

  const hoverChanged = prev.hover !== session.hover;
  notify({ doc: false, selection: selChanged, hover: hoverChanged, ui: uiChanged, mode: false });
});

// Register post-render hook for pseudo-state preview
addPostRenderHook(() => updateForcedPseudoPreview());

// Now that renderers and update are registered, bootstrap
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
          if (fileRelPath.endsWith(".md")) {
            await loadMarkdown(content, null);
            S.documentPath = fileRelPath;
          } else {
            const parsed = JSON.parse(content);
            S = createState(parsed);
            S.documentPath = fileRelPath;
          }
          S.dirty = false;
          S.ui = { ...S.ui, leftTab: "files" };
          ({ doc, session } = fromFlat(S));
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

// ─── Toolbar (delegated to panels/toolbar.js) ────────────────────────────────

function renderToolbar() {
  toolbarPanel.render();
}

// ─── File Operations (delegated to file-ops.js) ─────────────────────────────

function fileOpsCtx() {
  return {
    S,
    commit: (/** @type {any} */ ns) => {
      S = ns;
      ({ doc, session } = fromFlat(S));
      render();
    },
    renderToolbar,
  };
}
function openFile() {
  return _openFile(fileOpsCtx());
}
async function loadMarkdown(/** @type {any} */ source, /** @type {any} */ fileHandle) {
  const ns = await _loadMarkdown(source, fileHandle);
  S = ns;
  ({ doc, session } = fromFlat(S));
}
function saveFile() {
  return _saveFile(fileOpsCtx());
}
function exportFile() {
  return _exportFile(fileOpsCtx());
}

// ─── File tree (delegated to files.js) ───────────────────────────────────────

function loadProject() {
  return _loadProject();
}
function openProject() {
  return _openProject({
    S,
    commit: (/** @type {any} */ ns) => {
      S = ns;
      ({ doc, session } = fromFlat(S));
    },
    renderActivityBar: () => renderActivityBar(S),
    renderLeftPanel,
  });
}
function renderFilesTemplate() {
  return _renderFilesTemplate({ openProject, openFileFromTree, renderLeftPanel });
}
function openFileFromTree(/** @type {any} */ path) {
  return _openFileFromTree(
    {
      get S() {
        return S;
      },
      set S(v) {
        S = v;
      },
      commit: (/** @type {any} */ ns) => {
        S = ns;
        ({ doc, session } = fromFlat(S));
      },
      render,
      loadMarkdown,
    },
    path,
  );
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
initShortcuts(() => ({
  S,
  setS: (ns) => {
    S = ns;
    ({ doc, session } = fromFlat(S));
  },
  canvasMode,
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
  if (!S.fileHandle || !S.dirty) return;
  clearTimeout(view.autosaveTimer);
  view.autosaveTimer = setTimeout(async () => {
    if (S.fileHandle && S.dirty && "createWritable" in S.fileHandle) {
      try {
        const writable = await S.fileHandle.createWritable();
        await writable.write(JSON.stringify(S.document, null, 2));
        await writable.close();
        update({ ...S, dirty: false });
        statusMessage("Auto-saved");
      } catch {}
    }
  }, AUTO_SAVE_DELAY);
}

addUpdateMiddleware((/** @type {any} */ state) => {
  if (state.dirty) scheduleAutosave();
});
