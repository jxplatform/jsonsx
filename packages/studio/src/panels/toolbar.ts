/// <reference lib="dom" />
/**
 * Toolbar panel — extracted from studio.js renderToolbar(). Owns rendering of breadcrumbs, file
 * ops, feature toggles, and mode switcher.
 */

import { html, render as litRender, nothing } from "lit-html";
import { updateSession } from "../store";
import { redo as tabRedo, undo as tabUndo } from "../tabs/transact";
import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";
import { applyPanelCollapse, view } from "../view";
import { clearRecentProjects, getRecentProjects, removeRecentProject } from "../recent-projects";
import { openQuickSearch } from "./quick-search";
import { getPlatform } from "../platform";
import { refreshGitStatus } from "./git-panel";
import { openBrowseModal } from "../browse/browse-modal";
import { openNewProjectModal } from "../new-project/new-project-modal";
import type { EffectScope } from "@vue/reactivity";
import type { TemplateResult } from "lit-html";

interface ToolbarCtx {
  openProject: () => void;
  openFile?: (path: string) => void;
  saveFile: () => void;
  getCanvasMode: () => string;
  setCanvasMode: (mode: string) => void;
  renderCanvas: () => void;
  safeRenderRightPanel: () => void;
  openRecentProject: (root: string) => Promise<void>;
  closeFunctionEditor: () => void;
}

let _rootEl: HTMLElement | null = null;

let _ctx: ToolbarCtx | null = null;

let _scope: EffectScope | null = null;

const toolbarIconMap = {
  "sp-icon-artboard": html`<sp-icon-artboard slot="icon"></sp-icon-artboard>`,
  "sp-icon-brush": html`<sp-icon-brush slot="icon"></sp-icon-brush>`,
  "sp-icon-code": html`<sp-icon-code slot="icon"></sp-icon-code>`,
  "sp-icon-delete": html`<sp-icon-delete slot="icon"></sp-icon-delete>`,
  "sp-icon-document": html`<sp-icon-document slot="icon"></sp-icon-document>`,
  "sp-icon-duplicate": html`<sp-icon-duplicate slot="icon"></sp-icon-duplicate>`,
  "sp-icon-edit": html`<sp-icon-edit slot="icon"></sp-icon-edit>`,
  "sp-icon-folder-open": html`<sp-icon-folder-open slot="icon"></sp-icon-folder-open>`,
  "sp-icon-gears": html`<sp-icon-gears slot="icon"></sp-icon-gears>`,
  "sp-icon-preview": html`<sp-icon-preview slot="icon"></sp-icon-preview>`,
  "sp-icon-redo": html`<sp-icon-redo slot="icon"></sp-icon-redo>`,
  "sp-icon-save-floppy": html`<sp-icon-save-floppy slot="icon"></sp-icon-save-floppy>`,
  "sp-icon-undo": html`<sp-icon-undo slot="icon"></sp-icon-undo>`,
  "sp-icon-view-list": html`<sp-icon-view-list slot="icon"></sp-icon-view-list>`,
} as Record<string, TemplateResult>;

/**
 * @param {string} label
 * @param {() => void} onClick
 * @param {string} [iconTag]
 */
function tbBtnTpl(label: string, onClick: () => void, iconTag?: string) {
  return html`
    <sp-action-button size="s" title=${label} @click=${onClick}>
      ${iconTag ? toolbarIconMap[iconTag] : nothing}<span class="tb-label">${label}</span>
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
export function mount(rootEl: HTMLElement, ctx: ToolbarCtx) {
  _rootEl = rootEl;
  _ctx = ctx;
  if (
    (globalThis as unknown as { __jxPlatform?: { windowControls?: unknown } }).__jxPlatform
      ?.windowControls
  ) {
    rootEl.classList.add("electrobun-webkit-app-region-drag");
  }
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (tab) {
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
        void tab.history.index;
        void tab.history.snapshots.length;
      }
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
  if (!_rootEl || !_ctx) {
    return;
  }
  try {
    litRender(toolbarTemplate(), _rootEl);
  } catch (error) {
    console.error("toolbar render error:", error);
  }
}

async function handleNewProject() {
  const result = await openNewProjectModal();
  if (result && _ctx) {
    await _ctx.openRecentProject(result.root);
  }
}

/**
 * The chevron dropdown beside "Open Project": New Project, the recent-projects list (each with a
 * remove affordance), and a clear-all action. Shared by both the minimal and full toolbars.
 *
 * @param {ToolbarCtx} ctx
 */
function recentMenuTpl(ctx: ToolbarCtx) {
  const recentProjects = getRecentProjects();
  return html`
    <overlay-trigger placement="bottom-start" triggered-by="click">
      <sp-action-button size="s" slot="trigger" title="Recent projects" class="tb-split-trigger">
        <sp-icon-chevron-down slot="icon"></sp-icon-chevron-down>
      </sp-action-button>
      <sp-popover slot="click-content" tip>
        <sp-menu
          @change=${(e: Event) => {
            const val = (e.target as unknown as HTMLInputElement).value;
            if (val === "__new__") {
              void handleNewProject();
            } else if (val === "__clear__") {
              clearRecentProjects();
              render();
            } else {
              void ctx.openRecentProject(val);
            }
          }}
        >
          <sp-menu-item value="__new__">New Project…</sp-menu-item>
          ${recentProjects.length > 0
            ? html`
                <sp-menu-divider></sp-menu-divider>
                ${recentProjects.map(
                  (p) => html`
                    <sp-menu-item value=${p.root} title=${p.root}>
                      ${p.name}
                      <sp-action-button
                        slot="end"
                        quiet
                        size="s"
                        title="Remove from recent"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          removeRecentProject(p.root);
                          render();
                        }}
                      >
                        <sp-icon-close slot="icon"></sp-icon-close>
                      </sp-action-button>
                    </sp-menu-item>
                  `,
                )}
                <sp-menu-divider></sp-menu-divider>
                <sp-menu-item value="__clear__">Clear recent projects</sp-menu-item>
              `
            : nothing}
        </sp-menu>
      </sp-popover>
    </overlay-trigger>
  `;
}

/** @param {ToolbarCtx} ctx */
function minimalToolbarTemplate(ctx: ToolbarCtx) {
  const recentProjectsTpl = recentMenuTpl(ctx);

  const windowControls = (
    globalThis as unknown as {
      __jxPlatform?: {
        windowControls?: {
          minimize: () => void;
          maximize: () => void;
          close: () => void;
        };
      };
    }
  ).__jxPlatform?.windowControls;
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

  return html`
    <div class="tb-split-btn">
      <sp-action-button
        size="s"
        class="tb-split-main"
        title="Open Project"
        @click=${ctx.openProject}
      >
        ${toolbarIconMap["sp-icon-folder-open"]}<span class="tb-label">Open Project</span>
      </sp-action-button>
      ${recentProjectsTpl}
    </div>
    ${tbBtnTpl("Manage", openBrowseModal, "sp-icon-view-list")}
    <sp-action-button size="s" title="Save" disabled>
      ${toolbarIconMap["sp-icon-save-floppy"]}<span class="tb-label">Save</span>
    </sp-action-button>
    <sp-action-group compact size="s">
      <sp-action-button size="s" title="Undo" disabled>
        ${toolbarIconMap["sp-icon-undo"]}<span class="tb-label">Undo</span>
      </sp-action-button>
      <sp-action-button size="s" title="Redo" disabled>
        ${toolbarIconMap["sp-icon-redo"]}<span class="tb-label">Redo</span>
      </sp-action-button>
    </sp-action-group>
    <div class="tb-spacer"></div>
    <sp-action-button
      class="tb-search-trigger"
      size="s"
      quiet
      title="Search files (⌘P)"
      @click=${openQuickSearch}
    >
      <sp-icon-search slot="icon"></sp-icon-search>
      <span class="tb-search-label">Search files… <kbd>⌘P</kbd></span>
    </sp-action-button>
    <div class="tb-spacer"></div>
    <sp-action-group selects="single" size="s" compact>
      ${modes.map(
        (m) => html`
          <sp-action-button size="s" title=${m.label} disabled ?selected=${m.key === "design"}>
            ${toolbarIconMap[m.iconTag]}<span class="tb-label">${m.label}</span>
          </sp-action-button>
        `,
      )}
    </sp-action-group>
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

const modes = [
  { iconTag: "sp-icon-edit", key: "edit", label: "Edit" },
  { iconTag: "sp-icon-artboard", key: "design", label: "Design" },
  { iconTag: "sp-icon-code", key: "source", label: "Code" },
  { iconTag: "sp-icon-brush", key: "stylebook", label: "Stylebook" },
];

function toolbarTemplate() {
  const tab = activeTab.value;
  if (!_ctx) {
    return html``;
  }
  const ctx = _ctx;

  if (!tab) {
    return minimalToolbarTemplate(ctx);
  }

  const allowedModes = new Set(tab.capabilities.modes);
  const canUndo = tab.history.index > 0;
  const canRedo = tab.history.index < tab.history.snapshots.length - 1;
  const canSave = tab.doc.dirty;

  const S = {
    dirty: tab.doc.dirty,
    fileHandle: tab.fileHandle,
    mode: tab.doc.mode,
    selection: tab.session.selection,
    ui: tab.session.ui,
  };
  // Base mode, not the effective mode: the switcher keeps Edit/Design highlighted while the
  // Tab-bar preview toggle is on (preview is no longer a switchable mode).
  const { canvasMode } = tab.session.ui;

  const modeSwitcherTpl = html`
    <sp-action-group selects="single" size="s" compact>
      ${modes.map(
        (m) => html`
          <sp-action-button
            size="s"
            title=${m.label}
            ?selected=${canvasMode === m.key}
            ?disabled=${!allowedModes.has(m.key)}
            @click=${() => {
              if (canvasMode === m.key) {
                return;
              }
              if (!allowedModes.has(m.key)) {
                return;
              }
              if (S.ui.editingFunction && view.functionEditor) {
                view.functionEditor.dispose();
                view.functionEditor = null;
              }
              ctx.setCanvasMode(m.key);
              view.panX = 0;
              view.panY = 0;
              /** @type {{ editingFunction: null; rightTab?: string }} */
              const uiPatch: { editingFunction: null; rightTab?: string } = {
                editingFunction: null,
              };
              if (m.key === "stylebook") {
                uiPatch.rightTab = "style";
              }
              updateSession({ ui: uiPatch });
              ctx.renderCanvas();
              ctx.safeRenderRightPanel();
            }}
          >
            ${toolbarIconMap[m.iconTag]}<span class="tb-label">${m.label}</span>
          </sp-action-button>
        `,
      )}
    </sp-action-group>
  `;

  const windowControls = (
    globalThis as unknown as {
      __jxPlatform?: {
        windowControls?: {
          minimize: () => void;
          maximize: () => void;
          close: () => void;
        };
      };
    }
  ).__jxPlatform?.windowControls;
  const isMac = navigator.platform.startsWith("Mac");
  const csdTpl = windowControls
    ? isMac
      ? html`
          <sp-action-group class="window-controls mac" size="s">
            <sp-action-button
              quiet
              size="s"
              title="Close"
              class="csd-close"
              @click=${() => windowControls.close()}
            >
              <sp-icon-close slot="icon"></sp-icon-close>
            </sp-action-button>
            <sp-action-button
              quiet
              size="s"
              title="Minimize"
              class="csd-minimize"
              @click=${() => windowControls.minimize()}
            >
              <sp-icon-remove slot="icon"></sp-icon-remove>
            </sp-action-button>
            <sp-action-button
              quiet
              size="s"
              title="Maximize"
              class="csd-maximize"
              @click=${() => windowControls.maximize()}
            >
              <sp-icon-rectangle slot="icon"></sp-icon-rectangle>
            </sp-action-button>
          </sp-action-group>
        `
      : html`
          <sp-action-group class="window-controls" size="s">
            <sp-action-button
              quiet
              size="s"
              title="Minimize"
              class="csd-minimize"
              @click=${() => windowControls.minimize()}
            >
              <sp-icon-remove slot="icon"></sp-icon-remove>
            </sp-action-button>
            <sp-action-button
              quiet
              size="s"
              title="Maximize"
              class="csd-maximize"
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

  const recentProjectsTpl = recentMenuTpl(ctx);

  return html`
    ${isMac ? csdTpl : nothing}
    <div class="tb-split-btn">
      <sp-action-button
        size="s"
        class="tb-split-main"
        title="Open Project"
        @click=${ctx.openProject}
      >
        ${toolbarIconMap["sp-icon-folder-open"]}<span class="tb-label">Open Project</span>
      </sp-action-button>
      ${recentProjectsTpl}
    </div>
    ${tbBtnTpl("Manage", openBrowseModal, "sp-icon-view-list")}
    <sp-action-button size="s" title="Save" ?disabled=${!canSave} @click=${ctx.saveFile}>
      ${toolbarIconMap["sp-icon-save-floppy"]}<span class="tb-label">Save</span>
    </sp-action-button>
    <sp-action-group compact size="s">
      <sp-action-button
        size="s"
        title="Undo"
        ?disabled=${!canUndo}
        @click=${() => tabUndo(activeTab.value!)}
      >
        ${toolbarIconMap["sp-icon-undo"]}<span class="tb-label">Undo</span>
      </sp-action-button>
      <sp-action-button
        size="s"
        title="Redo"
        ?disabled=${!canRedo}
        @click=${() => tabRedo(activeTab.value!)}
      >
        ${toolbarIconMap["sp-icon-redo"]}<span class="tb-label">Redo</span>
      </sp-action-button>
    </sp-action-group>
    <div class="tb-spacer"></div>
    <sp-action-button
      class="tb-search-trigger"
      size="s"
      quiet
      title="Search files (⌘P)"
      @click=${openQuickSearch}
    >
      <sp-icon-search slot="icon"></sp-icon-search>
      <span class="tb-search-label">Search files… <kbd>⌘P</kbd></span>
    </sp-action-button>
    ${(activeTab.value?.session.ui.gitStatus?.behind ?? 0) > 0
      ? html`<sp-action-button
          size="s"
          title="Sync Project"
          @click=${async () => {
            await getPlatform().gitPull();
            await refreshGitStatus();
          }}
        >
          <sp-icon-download slot="icon"></sp-icon-download>
          <span class="tb-label">Sync Project</span>
        </sp-action-button>`
      : nothing}
    <div class="tb-spacer"></div>
    ${modeSwitcherTpl}
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
    ${isMac ? nothing : csdTpl}
  `;
}
