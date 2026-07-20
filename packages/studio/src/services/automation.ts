/// <reference lib="dom" />
/**
 * Automation hook — a small, gated scripting surface for driving Studio from a browser-automation
 * runner (see scripts/screenshots/ at the repo root). Installed as `window.__jxAutomation` only
 * when the page URL carries `?automation=1`; without the flag production behavior is untouched.
 *
 * The API mutates the same reactive state the real UI mutates (canvas mode, activity tab,
 * selection, inspector tab, function editor) instead of clicking through Spectrum shadow DOM, so
 * shot definitions stay stable across chrome refactors.
 */

import { renderOnly, updateUi } from "../store";
import { setProjectState } from "../state";
import { seedProjectList } from "../project-list";
import { activeTab, closeAllTabs, workspace } from "../workspace/workspace";
import type { ProjectListEntry } from "../types";
import { applyPanelCollapse, view } from "../view";
import { setEditZoom as applyEditZoomLevel } from "../canvas/canvas-utils";
import { collabState } from "../collab/collab-state";
import type { PeerPresence } from "../collab/collab-state";
import type { SeededAssistantMessage } from "../panels/ai-panel";
import type { PagesDeploymentInfo } from "../publish/pages-service";
import type { JxPath } from "../state";

/** Callbacks injected from studio.ts (module-local helpers or imports kept out of this module). */
export interface AutomationDeps {
  getCanvasMode: () => string;
  openBrowseModal: () => void;
  openConnectorGrid: (connection: string | undefined, table: string) => void;
  openNewProjectModal: () => void;
  openQuickSearchPalette: () => void;
  openSettingsModal: (section?: string) => void;
  render: () => void;
  renderActivityBar: () => void;
  seedAssistantMessages: (messages: SeededAssistantMessage[]) => void;
  seedPublishConnected: (options: { accountId?: string; deployment: PagesDeploymentInfo }) => void;
  setCanvasMode: (mode: string) => void;
  statusMessage: (text: string) => void;
}

export interface AutomationApi {
  editDef: (defName: string) => void;
  editFunction: (path: JxPath, eventKey: string) => void;
  openBrowse: () => void;
  openDataGrid: (options: { connection?: string; table: string }) => void;
  openNewProject: () => void;
  openQuickSearch: () => void;
  openSettings: (section?: string) => void;
  seedAssistant: (options: { messages: SeededAssistantMessage[] }) => void;
  seedCollab: (options: { peers: PeerPresence[] }) => void;
  seedPublish: (options: { accountId?: string; deployment: PagesDeploymentInfo }) => void;
  showWelcome: (options?: { projects?: ProjectListEntry[] }) => void;
  getState: () => {
    activeTabId: string | null;
    canvasMode: string;
    canvasStatus: string | null;
    leftTab: string;
  };
  select: (path: JxPath | null) => void;
  setActivity: (tab: string) => void;
  setCanvasMode: (mode: string) => void;
  setRightTab: (tab: string) => void;
  setStatus: (text: string) => void;
  setTheme: (color: string) => void;
  setZoom: (zoom: number) => void;
  setEditZoom: (zoom: number) => void;
  waitForCanvasReady: (timeoutMs?: number) => Promise<void>;
}

/** The hook is opt-in per page load: only `?automation=1` installs it. */
export function shouldInstallAutomation(search: string): boolean {
  return new URLSearchParams(search).get("automation") === "1";
}

export function createAutomationApi(deps: AutomationDeps): AutomationApi {
  return {
    editDef(defName: string) {
      updateUi("editingFunction", { defName, type: "def" });
      deps.render();
    },
    editFunction(path: JxPath, eventKey: string) {
      updateUi("editingFunction", { eventKey, path, type: "event" });
      deps.render();
    },
    openBrowse() {
      deps.openBrowseModal();
    },
    openDataGrid(options: { connection?: string; table: string }) {
      deps.openConnectorGrid(options.connection, options.table);
    },
    openNewProject() {
      deps.openNewProjectModal();
    },
    openQuickSearch() {
      deps.openQuickSearchPalette();
    },
    openSettings(section?: string) {
      deps.openSettingsModal(section);
    },
    seedAssistant(options: { messages: SeededAssistantMessage[] }) {
      deps.seedAssistantMessages(options.messages);
    },
    seedCollab(options: { peers: PeerPresence[] }) {
      // Stage a live co-editing session on the active tab: the toolbar's presence chips and the
      // Canvas peer-selection boxes both read this same reactive store.
      const tab = activeTab.value;
      if (!tab) {
        return;
      }
      const state = collabState(tab);
      state.status = "synced";
      state.active = true;
      state.peers = options.peers.map((peer) => ({
        ...peer,
        state: {
          ...peer.state,
          focusedPath: peer.state.focusedPath ?? tab.documentPath,
        },
      }));
      deps.render();
    },
    seedPublish(options: { accountId?: string; deployment: PagesDeploymentInfo }) {
      deps.seedPublishConnected(options);
    },
    showWelcome(options?: { projects?: ProjectListEntry[] }) {
      // The devserver platform auto-opens the repo-root project on boot; the welcome
      // Screen only renders with no project and no tabs, so stage that state directly.
      // A staged catalogue replaces the real one (screenshots must not leak local paths).
      closeAllTabs();
      setProjectState(null);
      if (options?.projects) {
        seedProjectList(options.projects);
      }
      view.chatPanelCollapsed = true;
      applyPanelCollapse();
      deps.render();
    },
    getState() {
      return {
        activeTabId: workspace.activeTabId,
        canvasMode: deps.getCanvasMode(),
        canvasStatus: activeTab.value?.session.canvas.status ?? null,
        leftTab: view.leftTab,
      };
    },
    select(path: JxPath | null) {
      const tab = activeTab.value;
      if (tab) {
        tab.session.selection = path;
      }
      deps.render();
    },
    setActivity(tab: string) {
      view.leftTab = tab;
      view.leftPanelCollapsed = false;
      applyPanelCollapse();
      renderOnly("leftPanel");
      deps.renderActivityBar();
    },
    setCanvasMode(mode: string) {
      deps.setCanvasMode(mode);
      deps.render();
    },
    setRightTab(tab: string) {
      // "assistant" now lives in the persistent chat sidebar, not the right panel — keep the
      // Screenshot-manifest verb working by opening that sidebar instead.
      if (tab === "assistant") {
        view.chatPanelCollapsed = false;
        applyPanelCollapse();
        renderOnly("chatPanel");
        deps.render();
        return;
      }
      updateUi("rightTab", tab);
      deps.render();
    },
    setStatus(text: string) {
      deps.statusMessage(text);
    },
    setTheme(color: string) {
      document.querySelector("sp-theme")?.setAttribute("color", color);
    },
    setZoom(zoom: number) {
      updateUi("zoom", zoom);
      deps.render();
    },
    setEditZoom(zoom: number) {
      // Deliberately NOT deps.render(): live edit zoom must never re-render the canvas (it would
      // Rebuild the iframe DOM) — setEditZoom applies bare style writes, matching production paths.
      applyEditZoomLevel(zoom);
    },
    waitForCanvasReady(timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          if (activeTab.value?.session.canvas.status === "ready") {
            resolve();
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`canvas not ready after ${timeoutMs}ms`));
            return;
          }
          setTimeout(tick, 50);
        };
        tick();
      });
    },
  };
}

/**
 * Install the hook on globalThis when the current URL opts in. Returns whether it installed, so
 * callers (and tests) can assert the gate.
 */
export function installAutomationHook(deps: AutomationDeps): boolean {
  if (!shouldInstallAutomation(location.search)) {
    return false;
  }
  (globalThis as Record<string, unknown>).__jxAutomation = createAutomationApi(deps);
  return true;
}
