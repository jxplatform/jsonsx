/// <reference lib="dom" />
/**
 * Toolbar panel — extracted from studio.js renderToolbar(). Owns rendering of breadcrumbs, file
 * ops, feature toggles, and mode switcher.
 */

import { html, render as litRender, nothing } from "lit-html";
import { openPublishPanel } from "../publish/publish-panel";
import { updateSession } from "../store";
import {
  canRedo as tabCanRedo,
  canUndo as tabCanUndo,
  redo as tabRedo,
  undo as tabUndo,
} from "../tabs/transact";
import { collabState } from "../collab/collab-state";
import { presenceChipsTemplate } from "../collab/presence-chips";
import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";
import { applyPanelCollapse, onPanelCollapse, view } from "../view";
import { clearRecentProjects, getRecentProjects, removeRecentProject } from "../recent-projects";
import { openQuickSearch } from "./quick-search";
import { getPlatform } from "../platform";
import { refreshGitStatus } from "./git-panel";
import { openBrowseModal } from "../browse/browse-modal";
import { openNewProjectModal } from "../new-project/new-project-modal";
import { canvasBaseOrigin } from "../canvas/canvas-origin";
import { getPreviewNavigateHandler } from "../canvas/preview-navigate";
import { documentUrlPattern, dynamicRouteParams } from "../page-params";
import { projectState } from "../state";
import { isModalOpen } from "../ui/layers";
import { statusMessage } from "./statusbar";
import type { Tab } from "../tabs/tab";
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

/** Test override for the mac CSD layout — happy-dom forbids redefining navigator.platform. */
let _isMacOverride: boolean | null = null;

/** Force (or restore, with null) the mac/non-mac window-control layout detection. */
export function setMacPlatformForTests(value: boolean | null): void {
  _isMacOverride = value;
}

/** True on macOS — picks the CSD window-control order (close-first, toolbar-leading). */
function isMacPlatform(): boolean {
  return _isMacOverride ?? navigator.platform.startsWith("Mac");
}

let _scope: EffectScope | null = null;

/** Drops the panel-collapse subscription registered in {@link mount}. */
let _unsubscribeCollapse: (() => void) | null = null;

const toolbarIconMap = {
  "sp-icon-artboard": html`<sp-icon-artboard slot="icon"></sp-icon-artboard>`,
  "sp-icon-brush": html`<sp-icon-brush slot="icon"></sp-icon-brush>`,
  "sp-icon-code": html`<sp-icon-code slot="icon"></sp-icon-code>`,
  "sp-icon-delete": html`<sp-icon-delete slot="icon"></sp-icon-delete>`,
  "sp-icon-document": html`<sp-icon-document slot="icon"></sp-icon-document>`,
  "sp-icon-duplicate": html`<sp-icon-duplicate slot="icon"></sp-icon-duplicate>`,
  "sp-icon-edit": html`<sp-icon-edit slot="icon"></sp-icon-edit>`,
  "sp-icon-export": html`<sp-icon-export slot="icon"></sp-icon-export>`,
  "sp-icon-folder-open": html`<sp-icon-folder-open slot="icon"></sp-icon-folder-open>`,
  "sp-icon-gears": html`<sp-icon-gears slot="icon"></sp-icon-gears>`,
  "sp-icon-preview": html`<sp-icon-preview slot="icon"></sp-icon-preview>`,
  "sp-icon-redo": html`<sp-icon-redo slot="icon"></sp-icon-redo>`,
  "sp-icon-save-floppy": html`<sp-icon-save-floppy slot="icon"></sp-icon-save-floppy>`,
  "sp-icon-undo": html`<sp-icon-undo slot="icon"></sp-icon-undo>`,
  "sp-icon-view-grid": html`<sp-icon-view-grid slot="icon"></sp-icon-view-grid>`,
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

// ─── View: Open in Browser ───────────────────────────────────────────────────

/** Where `View: Open in Browser` would go, or the sentence explaining why it cannot go anywhere. */
export type BrowserTarget = { url: string } | { reason: string };

/**
 * Resolve the active document's built page to a URL on the server already serving this project.
 *
 * The origin is the canvas's own ({@link canvasBaseOrigin}) — the one a Preview link click resolves
 * against — and the path mirrors the compiler's `routeToOutputPath` exactly, so `/blog/hello/` asks
 * for `dist/blog/hello/index.html` under `trailingSlash: "always"` and `dist/blog/hello.html` under
 * `"never"`. Every server Studio runs against (the monorepo dev server via its active-project
 * fallback, `jx dev` via its root, the desktop loopback project server) serves that path.
 *
 * Everything that is not a page resolves to a REASON rather than to nothing: a disabled control the
 * user can hover is discoverable, an absent one is not.
 */
export function openInBrowserTarget(tab: Tab | null): BrowserTarget {
  const documentPath = tab?.documentPath?.replace(/^\.\//, "");
  if (!documentPath) {
    return { reason: "Open a page to view it in a browser." };
  }
  if (!projectState?.isSiteProject) {
    return { reason: "This project does not build a site." };
  }
  if (!documentPath.startsWith("pages/")) {
    return { reason: `Only pages have a route — ${documentPath} is not under pages/.` };
  }
  let route = documentUrlPattern(documentPath);
  if (route.includes("*")) {
    return { reason: "Catch-all routes match many pages — open a generated one instead." };
  }
  const params = dynamicRouteParams(documentPath);
  if (params.length > 0) {
    const chosen = (tab?.session.ui.previewParams ?? {}) as Record<string, string>;
    const missing = params.filter((name) => !chosen[name]);
    if (missing.length > 0) {
      const names = missing.map((name) => `:${name}`).join(", ");
      return { reason: `Pick a value for ${names} to open one of this route's pages.` };
    }
    route = route.replaceAll(/:(\w+)/g, (_m, name: string) => encodeURIComponent(chosen[name]!));
  }
  const origin = canvasBaseOrigin();
  if (!origin.startsWith("http://") && !origin.startsWith("https://")) {
    return { reason: "No local server is serving this project yet." };
  }
  const trailingSlash = projectState.projectConfig?.build?.trailingSlash ?? "always";
  const output =
    route === "/"
      ? "/index.html"
      : trailingSlash === "always"
        ? `${route}/index.html`
        : `${route}.html`;
  return { url: `${origin}/dist${output}` };
}

/**
 * Hand a URL to the user's real browser.
 *
 * Reuses the seam the desktop launchers already register for Preview link clicks
 * (`canvas/preview-navigate.ts`), which routes through the OS rather than navigating a webview with
 * no address bar; the browser build falls back to a new tab.
 */
function openUrlExternally(url: string) {
  const override = getPreviewNavigateHandler();
  if (override) {
    override(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Run `View: Open in Browser`, reporting the blocking reason when there is one. */
function runOpenInBrowser() {
  const target = openInBrowserTarget(activeTab.value ?? null);
  if ("url" in target) {
    openUrlExternally(target.url);
    return;
  }
  statusMessage(target.reason);
}

/**
 * The Open in Browser control. Never absent: with no page resolvable it renders disabled and states
 * why in its tooltip, because "the button is missing" is not a thing a user can act on.
 */
function openInBrowserTpl(tab: Tab | null) {
  const target = openInBrowserTarget(tab);
  const reason = "reason" in target ? target.reason : null;
  return html`
    <sp-action-button
      size="s"
      title=${reason ? `Open in Browser — ${reason}` : "Open in Browser (⌘⇧O)"}
      ?disabled=${Boolean(reason)}
      @click=${runOpenInBrowser}
    >
      ${toolbarIconMap["sp-icon-export"]}<span class="tb-label">Open in Browser</span>
    </sp-action-button>
  `;
}

/** ⌘⇧O / Ctrl+Shift+O. Shift makes `e.key` "O", so the ⌘O in editor/shortcuts.ts never sees it. */
function onToolbarKeydown(e: KeyboardEvent) {
  if (isModalOpen() || !(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== "o") {
    return;
  }
  e.preventDefault();
  runOpenInBrowser();
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
  document.addEventListener("keydown", onToolbarKeydown);
  /* The effect below can only track REACTIVE state, and `view` is a plain object — so flipping a
     dock from anywhere but this module's own click handlers (the automation runner, the New
     Project agent hand-off, the boot-time restore) repositioned the panels and left the rail/chat
     icons showing the opposite state. Subscribe to the change instead. RESIDUE FOR P2: when
     `shell.ts` owns dock visibility reactively, this subscription and the explicit render() calls
     in the two toggle handlers all go away. */
  _unsubscribeCollapse = onPanelCollapse(render);
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
        // Open in Browser needs a value for every route param before it can resolve a page.
        void tab.session.ui.previewParams;
        void tab.session.ui.rightTab;
        void tab.session.ui.gitStatus;
        void tab.history.index;
        void tab.history.snapshots.length;
        void collabState(tab).status;
        void collabState(tab).peers.length;
      }
      render();
    });
  });
}

export function unmount() {
  document.removeEventListener("keydown", onToolbarKeydown);
  _unsubscribeCollapse?.();
  _unsubscribeCollapse = null;
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
          ${
            recentProjects.length > 0
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
              : nothing
          }
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
    ${openInBrowserTpl(null)}
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
      ${
        view.rightPanelCollapsed
          ? html`<sp-icon-rail-right-open slot="icon"></sp-icon-rail-right-open>`
          : html`<sp-icon-rail-right-close slot="icon"></sp-icon-rail-right-close>`
      }
    </sp-action-button>
    ${chatToggleTpl()} ${csdTpl}
  `;
}

/** Toggle for the persistent AI chat sidebar (selected = open). Shared by both layouts. */
function chatToggleTpl() {
  return html`
    <sp-action-button
      quiet
      size="s"
      title="Toggle Assistant"
      ?selected=${!view.chatPanelCollapsed}
      @click=${() => {
        view.chatPanelCollapsed = !view.chatPanelCollapsed;
        applyPanelCollapse();
        render();
      }}
    >
      <sp-icon-chat slot="icon"></sp-icon-chat>
    </sp-action-button>
  `;
}

const modes = [
  { iconTag: "sp-icon-edit", key: "edit", label: "Edit" },
  { iconTag: "sp-icon-artboard", key: "design", label: "Design" },
  { iconTag: "sp-icon-view-grid", key: "grid", label: "Grid" },
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
  const canUndo = tabCanUndo(tab);
  const canRedo = tabCanRedo(tab);
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
  const isMac = isMacPlatform();
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
    ${tbBtnTpl("Publish", openPublishPanel)}
    <sp-action-button size="s" title="Save" ?disabled=${!canSave} @click=${ctx.saveFile}>
      ${toolbarIconMap["sp-icon-save-floppy"]}<span class="tb-label">Save</span>
    </sp-action-button>
    ${openInBrowserTpl(tab)}
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
    ${presenceChipsTemplate(tab)}
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
    ${
      (activeTab.value?.session.ui.gitStatus?.behind ?? 0) > 0
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
        : nothing
    }
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
      ${
        view.rightPanelCollapsed
          ? html`<sp-icon-rail-right-open slot="icon"></sp-icon-rail-right-open>`
          : html`<sp-icon-rail-right-close slot="icon"></sp-icon-rail-right-close>`
      }
    </sp-action-button>
    ${chatToggleTpl()} ${isMac ? nothing : csdTpl}
  `;
}
