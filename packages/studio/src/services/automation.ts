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
import { activeTab, workspace } from "../workspace/workspace";
import { applyPanelCollapse, view } from "../view";
import type { JxPath } from "../state";

/** Callbacks injected from studio.ts (module-local helpers or imports kept out of this module). */
export interface AutomationDeps {
  getCanvasMode: () => string;
  openBrowseModal: () => void;
  openNewProjectModal: () => void;
  render: () => void;
  renderActivityBar: () => void;
  setCanvasMode: (mode: string) => void;
  statusMessage: (text: string) => void;
}

export interface AutomationApi {
  editDef: (defName: string) => void;
  editFunction: (path: JxPath, eventKey: string) => void;
  openBrowse: () => void;
  openNewProject: () => void;
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
    openNewProject() {
      deps.openNewProjectModal();
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
