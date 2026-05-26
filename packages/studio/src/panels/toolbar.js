/**
 * Toolbar panel — extracted from studio.js renderToolbar(). Owns rendering of breadcrumbs, file
 * ops, feature toggles, and mode switcher.
 */

import { html, render as litRender, nothing } from "lit-html";
import { updateSession, updateUi } from "../store.js";
import { undo as tabUndo, redo as tabRedo } from "../tabs/transact.js";
import { effect, effectScope } from "../reactivity.js";
import { activeTab } from "../workspace/workspace.js";
import { getEffectiveMedia } from "../site-context.js";
import { mediaDisplayName } from "./shared.js";
import { view, applyPanelCollapse } from "../view.js";
import { getRecentProjects } from "../recent-projects.js";
import { openQuickSearch } from "./quick-search.js";
import { getPlatform } from "../platform.js";
import { refreshGitStatus } from "./git-panel.js";
import { openBrowseModal } from "../browse/browse-modal.js";

/** @type {HTMLElement | null} */
let _rootEl = null;

/**
 * @typedef {{
 *   navigateBack: () => void;
 *   navigateToLevel: (level: number) => void;
 *   openProject: () => void;
 *   openFile?: (path: string) => void;
 *   saveFile: () => void;
 *   parseMediaEntries: (media: Record<string, string> | null | undefined) => {
 *     sizeBreakpoints: { name: string; query: string; width: number; type: string }[];
 *     featureQueries: { name: string; query: string }[];
 *     baseWidth: number;
 *   };
 *   getCanvasMode: () => string;
 *   setCanvasMode: (mode: string) => void;
 *   renderCanvas: () => void;
 *   safeRenderRightPanel: () => void;
 *   openRecentProject: (root: string) => Promise<void>;
 *   closeFunctionEditor: () => void;
 * }} ToolbarCtx
 */

/** @type {ToolbarCtx | null} */
let _ctx = null;

/** @type {import("@vue/reactivity").EffectScope | null} */
let _scope = null;

const toolbarIconMap = /** @type {Record<string, import("lit-html").TemplateResult>} */ ({
  "sp-icon-folder-open": html`<sp-icon-folder-open slot="icon"></sp-icon-folder-open>`,
  "sp-icon-save-floppy": html`<sp-icon-save-floppy slot="icon"></sp-icon-save-floppy>`,
  "sp-icon-back": html`<sp-icon-back slot="icon"></sp-icon-back>`,
  "sp-icon-undo": html`<sp-icon-undo slot="icon"></sp-icon-undo>`,
  "sp-icon-redo": html`<sp-icon-redo slot="icon"></sp-icon-redo>`,
  "sp-icon-duplicate": html`<sp-icon-duplicate slot="icon"></sp-icon-duplicate>`,
  "sp-icon-delete": html`<sp-icon-delete slot="icon"></sp-icon-delete>`,
  "sp-icon-edit": html`<sp-icon-edit slot="icon"></sp-icon-edit>`,
  "sp-icon-artboard": html`<sp-icon-artboard slot="icon"></sp-icon-artboard>`,
  "sp-icon-preview": html`<sp-icon-preview slot="icon"></sp-icon-preview>`,
  "sp-icon-code": html`<sp-icon-code slot="icon"></sp-icon-code>`,
  "sp-icon-brush": html`<sp-icon-brush slot="icon"></sp-icon-brush>`,
  "sp-icon-view-list": html`<sp-icon-view-list slot="icon"></sp-icon-view-list>`,
  "sp-icon-gears": html`<sp-icon-gears slot="icon"></sp-icon-gears>`,
  "sp-icon-document": html`<sp-icon-document slot="icon"></sp-icon-document>`,
});

/**
 * @param {string} label
 * @param {Function} onClick
 * @param {string} [iconTag]
 */
function tbBtnTpl(label, onClick, iconTag) {
  return html`
    <sp-action-button size="s" @click=${onClick}>
      ${iconTag ? toolbarIconMap[iconTag] : nothing} ${label}
    </sp-action-button>
  `;
}

/**
 * Mount the toolbar panel.
 *
 * @param {HTMLElement} rootEl
 * @param {ToolbarCtx} ctx — { navigateBack, closeFunctionEditor, openProject, openFile, saveFile,
 *   parseMediaEntries, getCanvasMode, setCanvasMode, renderCanvas, safeRenderRightPanel }
 */
export function mount(rootEl, ctx) {
  _rootEl = rootEl;
  _ctx = ctx;
  if (
    /** @type {{ __jxPlatform?: { windowControls?: unknown } }} */ (
      /** @type {unknown} */ (globalThis)
    ).__jxPlatform?.windowControls
  ) {
    rootEl.classList.add("electrobun-webkit-app-region-drag");
  }
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (!tab) return;
      // Read reactive properties to establish tracking
      void tab.doc.document;
      void tab.doc.dirty;
      void tab.doc.mode;
      void tab.session.selection;
      void tab.session.ui.canvasMode;
      void tab.session.ui.editingFunction;
      void tab.session.ui.featureToggles;
      void tab.session.ui.rightTab;
      void tab.session.ui.gitStatus;
      render();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  _rootEl = null;
  _ctx = null;
}

export function render() {
  if (!_rootEl || !_ctx) return;
  try {
    litRender(toolbarTemplate(), _rootEl);
  } catch (e) {
    console.error("toolbar render error:", e);
  }
}

function toolbarTemplate() {
  const tab = activeTab.value;
  if (!tab || !_ctx) return html``;
  const ctx = _ctx;
  const S = {
    document: tab.doc.document,
    ui: tab.session.ui,
    mode: tab.doc.mode,
    selection: tab.session.selection,
    dirty: tab.doc.dirty,
    documentPath: tab.documentPath,
    fileHandle: tab.fileHandle,
    documentStack: tab.session.documentStack,
  };
  const canvasMode = ctx.getCanvasMode();
  const hasStack = S.documentStack && S.documentStack.length > 0;

  const breadcrumbTpl = hasStack
    ? html`
        <div class="breadcrumb">
          <sp-action-button size="s" title="Return to parent document" @click=${ctx.navigateBack}>
            ${toolbarIconMap["sp-icon-back"]}Back
          </sp-action-button>
          ${S.documentStack.map(
            (/** @type {{ documentPath?: string }} */ frame, /** @type {number} */ i) => html`
              <span class="breadcrumb-item clickable" @click=${() => ctx.navigateToLevel(i)}
                >${frame.documentPath?.split("/").pop() || "untitled"}</span
              >
              <span class="breadcrumb-sep"> › </span>
            `,
          )}
          <span class="breadcrumb-item current">
            ${S.documentPath?.split("/").pop() || S.document.tagName || "document"}
          </span>
        </div>
      `
    : nothing;

  const { featureQueries } = ctx.parseMediaEntries(getEffectiveMedia(S.document.$media));
  const togglesTpl =
    featureQueries.length > 0
      ? html`
          <sp-action-group compact size="s">
            ${featureQueries.map(
              (/** @type {{ name: string; query: string }} */ { name, query }) => html`
                <sp-action-button
                  toggles
                  size="s"
                  title=${query}
                  ?selected=${!!S.ui.featureToggles[name]}
                  @click=${() => {
                    const newToggles = {
                      ...S.ui.featureToggles,
                      [name]: !S.ui.featureToggles[name],
                    };
                    updateUi("featureToggles", newToggles);
                  }}
                >
                  ${mediaDisplayName(name)}
                </sp-action-button>
              `,
            )}
          </sp-action-group>
        `
      : nothing;

  const modes = [
    { key: "edit", label: "Edit", iconTag: "sp-icon-edit" },
    { key: "design", label: "Design", iconTag: "sp-icon-artboard" },
    { key: "preview", label: "Preview", iconTag: "sp-icon-preview" },
    { key: "source", label: "Code", iconTag: "sp-icon-code" },
    { key: "stylebook", label: "Stylebook", iconTag: "sp-icon-brush" },
  ];

  const isProjectFile = S.documentPath === "project.json";
  const allowedModes = isProjectFile ? new Set(["stylebook", "source"]) : null;

  const modeSwitcherTpl = html`
    <sp-action-group selects="single" size="s" compact>
      ${modes.map(
        (m) => html`
          <sp-action-button
            size="s"
            ?selected=${canvasMode === m.key}
            ?disabled=${allowedModes && !allowedModes.has(m.key)}
            @click=${() => {
              if (canvasMode === m.key) return;
              if (allowedModes && !allowedModes.has(m.key)) return;
              if (S.ui.editingFunction) {
                if (view.functionEditor) {
                  view.functionEditor.dispose();
                  view.functionEditor = null;
                }
              }
              ctx.setCanvasMode(m.key);
              view.panX = 0;
              view.panY = 0;
              /** @type {{ editingFunction: null; rightTab?: string }} */
              const uiPatch = { editingFunction: null };
              if (m.key === "stylebook") uiPatch.rightTab = "style";
              updateSession({ ui: uiPatch });
              ctx.renderCanvas();
              ctx.safeRenderRightPanel();
            }}
          >
            ${toolbarIconMap[m.iconTag]}${m.label}
          </sp-action-button>
        `,
      )}
    </sp-action-group>
  `;

  const windowControls = /**
   * @type {{
   *   __jxPlatform?: {
   *     windowControls?: { minimize: () => void; maximize: () => void; close: () => void };
   *   };
   * }}
   */ (/** @type {unknown} */ (globalThis)).__jxPlatform?.windowControls;
  const csdTpl = windowControls
    ? html`
        <sp-action-group class="window-controls" size="s">
          <sp-action-button
            quiet
            size="s"
            title="Minimize"
            @click=${() => windowControls.minimize()}
          >
            <sp-icon-remove slot="icon"></sp-icon-remove>
          </sp-action-button>
          <sp-action-button
            quiet
            size="s"
            title="Maximize"
            @click=${() => windowControls.maximize()}
          >
            <sp-icon-rectangle slot="icon"></sp-icon-rectangle>
          </sp-action-button>
          <sp-action-button
            quiet
            size="s"
            title="Close"
            class="csd-close"
            @click=${() => windowControls.close()}
          >
            <sp-icon-close slot="icon"></sp-icon-close>
          </sp-action-button>
        </sp-action-group>
      `
    : nothing;

  const recentProjects = getRecentProjects();
  const recentProjectsTpl = recentProjects.length
    ? html`
        <overlay-trigger placement="bottom-start" triggered-by="click">
          <sp-action-button size="s" slot="trigger" title="Recent projects">
            <sp-icon-chevron-down slot="icon"></sp-icon-chevron-down>
          </sp-action-button>
          <sp-popover slot="click-content" tip>
            <sp-menu
              @change=${(/** @type {Event} */ e) =>
                ctx.openRecentProject(
                  /** @type {HTMLInputElement} */ (/** @type {unknown} */ (e.target)).value,
                )}
            >
              ${recentProjects.map(
                (p) => html`<sp-menu-item value=${p.root}>${p.name}</sp-menu-item>`,
              )}
            </sp-menu>
          </sp-popover>
        </overlay-trigger>
      `
    : nothing;

  return html`
    ${tbBtnTpl("Open Project", ctx.openProject, "sp-icon-folder-open")} ${recentProjectsTpl}
    ${tbBtnTpl("Manage", openBrowseModal, "sp-icon-view-list")}
    ${tbBtnTpl("Save", ctx.saveFile, "sp-icon-save-floppy")}
    <sp-action-group compact size="s">
      ${tbBtnTpl("Undo", () => tabUndo(activeTab.value), "sp-icon-undo")}
      ${tbBtnTpl("Redo", () => tabRedo(activeTab.value), "sp-icon-redo")}
    </sp-action-group>
    <div class="tb-spacer"></div>
    <sp-action-button class="tb-search-trigger" size="s" quiet @click=${openQuickSearch}>
      <sp-icon-search slot="icon"></sp-icon-search>
      <span class="tb-search-label">Search files… <kbd>⌘P</kbd></span>
    </sp-action-button>
    ${(/** @type {{ behind?: number }} */ (activeTab.value?.session.ui.gitStatus)?.behind ?? 0) > 0
      ? html`<sp-action-button
          size="s"
          @click=${async () => {
            await getPlatform().gitPull();
            await refreshGitStatus();
          }}
        >
          <sp-icon-download slot="icon"></sp-icon-download>
          Sync Project
        </sp-action-button>`
      : nothing}
    <div class="tb-spacer"></div>
    ${breadcrumbTpl} ${togglesTpl} ${modeSwitcherTpl}
    <sp-action-button
      quiet
      size="s"
      title="Toggle Right Panel"
      @click=${() => {
        view.rightPanelCollapsed = !view.rightPanelCollapsed;
        applyPanelCollapse();
        render();
      }}
    >
      ${view.rightPanelCollapsed
        ? html`<sp-icon-rail-right-open slot="icon"></sp-icon-rail-right-open>`
        : html`<sp-icon-rail-right-close slot="icon"></sp-icon-rail-right-close>`}
    </sp-action-button>
    ${csdTpl}
  `;
}
