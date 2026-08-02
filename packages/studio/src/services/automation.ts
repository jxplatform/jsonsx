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

/**
 * What a command handler tells the runner to do next.
 *
 * INTERIM: a handful of Studio actions are still reachable only by pressing a chrome control — a
 * context-menu item, a Spectrum picker that opens on a real pointer press, a sub-navigation button
 * inside the settings modal. Those handlers resolve the control and hand its selector back so the
 * runner performs a genuine mouse press on it. Every such entry disappears the moment the action
 * exists in the command registry: the handler starts executing in-page and stops returning `click`,
 * and no manifest step changes.
 */
export interface AutomationRunResult {
  click?: { button?: "left" | "right"; selector: string };
}

/** Loosely-typed command arguments, as they arrive from a manifest step's `args` object. */
export type AutomationArgs = Record<string, unknown>;

/**
 * One entry of the id→handler table behind `run(id, args)`.
 *
 * `run` is the real thing: it mutates the same reactive state the UI mutates. `press` is the
 * interim escape hatch described on {@link AutomationRunResult} — an entry carries one or the other,
 * and Phase 2 converts every `press` into a `run` against the command registry.
 */
export interface AutomationCommand {
  run?: (api: AutomationApi, args: AutomationArgs) => void;
  press?: (args: AutomationArgs) => { button?: "left" | "right"; selector: string };
}

export interface AutomationApi {
  /**
   * Command-addressed entry point: the only thing a screenshot manifest ever names. Resolves `id`
   * against {@link AUTOMATION_COMMANDS} and runs it. Unknown ids throw rather than no-op — a
   * silently-skipped step would capture the wrong state and the docs build would accept it.
   */
  run: (id: string, args?: AutomationArgs) => AutomationRunResult;
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
  toggleActivity: (tab: string) => void;
  togglePreview: () => void;
  setAssistant: (open: boolean) => void;
  setRightPanel: (open: boolean) => void;
  waitForCanvasReady: (timeoutMs?: number) => Promise<void>;
}

// ─── Argument coercion ────────────────────────────────────────────────────────
// A manifest step's `args` is plain JSON. Coerce loudly: a mistyped argument must fail the shot,
// Never silently capture `undefined` state.

function str(args: AutomationArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new TypeError(`automation command argument "${key}" must be a string`);
  }
  return value;
}

function num(args: AutomationArgs, key: string): number {
  const value = args[key];
  if (typeof value !== "number") {
    throw new TypeError(`automation command argument "${key}" must be a number`);
  }
  return value;
}

function bool(args: AutomationArgs, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") {
    throw new TypeError(`automation command argument "${key}" must be a boolean`);
  }
  return value;
}

function optionalStr(args: AutomationArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`automation command argument "${key}" must be a string`);
  }
  return value;
}

// ─── INTERIM selector shims ───────────────────────────────────────────────────
// Everything below this banner is scaffolding, not architecture. These commands have no
// Programmatic seam yet — the only way to fire them is to press the chrome control that owns them.
// Keeping the selectors HERE (rather than in 58 manifest steps) means a chrome refactor is a
// One-file fix, and Phase 2 deletes the whole banner by swapping each `press` for a `run`.

/** An `sp-menu-item` in whatever menu/context menu is currently open, matched by its label. */
const menuItem = (label: string) => `xpath///sp-menu-item[normalize-space()="${label}"]`;

/** A panel row (signals, data explorer, layers) matched by the text of its name/label span. */
const namedRow = (rowClass: string, nameClass: string, name: string) =>
  `xpath///div[contains(@class,"${rowClass}")][.//span[contains(@class,"${nameClass}")]` +
  `[normalize-space()="${name}"]]`;

/** An `sp-action-button` inside `container`, matched by its label. */
const buttonIn = (container: string, label: string) =>
  `xpath///div[contains(@class,"${container}")]//sp-action-button[normalize-space()="${label}"]`;

/** Settings-section key → nav label. Mirrors the labels the section registry renders. */
const SETTINGS_SECTION_LABELS: Record<string, string> = { content: "Content Types" };

/** Browse category key → filter-bar label. Mirrors CATEGORIES in browse/browse.ts. */
const BROWSE_CATEGORY_LABELS: Record<string, string> = {
  all: "All",
  components: "Components",
  content: "Content",
  layouts: "Layouts",
  media: "Media",
  pages: "Pages",
};

function labelFor(map: Record<string, string>, key: string, what: string): string {
  const label = map[key];
  if (!label) {
    throw new Error(`unknown ${what} "${key}"`);
  }
  return label;
}

/**
 * The id→handler table behind `run(id, args)`.
 *
 * Ids are `<category>.<verb>`, the shape the Studio command registry is heading for, so Phase 2 can
 * replace this table's body with a registry lookup without touching a single manifest step.
 */
export const AUTOMATION_COMMANDS: Record<string, AutomationCommand> = {
  // ── Canvas ──
  "canvas.setEditZoom": { run: (api, args) => api.setEditZoom(num(args, "zoom")) },
  "canvas.setMode": { run: (api, args) => api.setCanvasMode(str(args, "mode")) },
  "canvas.setZoom": { run: (api, args) => api.setZoom(num(args, "zoom")) },
  "canvas.togglePreview": { run: (api) => api.togglePreview() },

  // ── Content collections ──
  "collection.editInGrid": { press: () => ({ selector: menuItem("Edit Collection in Grid") }) },

  // ── Data ──
  "data.expandRow": {
    press: (args) => ({
      selector: namedRow("data-row-header", "data-name", str(args, "name")),
    }),
  },
  "data.openGrid": {
    run: (api, args) => {
      const connection = optionalStr(args, "connection");
      api.openDataGrid({ table: str(args, "table"), ...(connection ? { connection } : {}) });
    },
  },

  // ── Element actions (block action bar / context menu) ──
  "element.convertToComponent": {
    press: () => ({ selector: "sp-action-button[title='Convert to Component']" }),
  },
  "element.insertData": { press: () => ({ selector: "sp-action-button[title='Insert data']" }) },
  "element.repeat": { press: () => ({ selector: menuItem("Repeat...") }) },

  // ── Files ──
  "file.contextMenu": {
    press: (args) => ({ button: "right", selector: `[data-path='${str(args, "path")}']` }),
  },

  // ── Formulas ──
  "formula.browseCatalog": { press: () => ({ selector: ".expr-browse-catalog" }) },
  "formula.editDef": { run: (api, args) => api.editDef(str(args, "defName")) },
  "formula.editEvent": {
    run: (api, args) => {
      const { path } = args;
      if (!Array.isArray(path)) {
        throw new TypeError('automation command argument "path" must be an array');
      }
      api.editFunction(path as JxPath, str(args, "eventKey"));
    },
  },
  "formula.openWorkspace": {
    press: () => ({ selector: "sp-action-button[title='Open in formula workspace']" }),
  },

  // ── Inspector ──
  "inspector.toggleSection": {
    press: (args) => ({ selector: `sp-accordion-item[label='${str(args, "section")}']` }),
  },

  // ── Layers ──
  "layers.contextMenu": {
    press: (args) => ({
      button: "right",
      selector: namedRow("layer-row", "layer-label", str(args, "label")),
    }),
  },

  // ── Media ──
  "media.browse": { press: () => ({ selector: "sp-action-button[title='Browse media']" }) },

  // ── Project ──
  "project.browse": { run: (api) => api.openBrowse() },
  "project.new": { run: (api) => api.openNewProject() },
  "project.setBrowseCategory": {
    press: (args) => ({
      selector: buttonIn(
        "browse-filter-bar",
        labelFor(BROWSE_CATEGORY_LABELS, str(args, "category"), "browse category"),
      ),
    }),
  },
  "project.showWelcome": {
    run: (api, args) => {
      const { projects } = args;
      api.showWelcome(Array.isArray(projects) ? { projects: projects as ProjectListEntry[] } : {});
    },
  },

  // ── Search ──
  "search.openPalette": { run: (api) => api.openQuickSearch() },

  // ── Seeded fixtures (staged state a real session would have earned) ──
  "seed.assistant": {
    run: (api, args) =>
      api.seedAssistant({ messages: (args.messages ?? []) as SeededAssistantMessage[] }),
  },
  "seed.collab": {
    run: (api, args) => api.seedCollab({ peers: (args.peers ?? []) as PeerPresence[] }),
  },
  "seed.publish": {
    run: (api, args) => {
      const accountId = optionalStr(args, "accountId");
      api.seedPublish({
        deployment: args.deployment as PagesDeploymentInfo,
        ...(accountId ? { accountId } : {}),
      });
    },
  },

  // ── Selection ──
  "selection.set": {
    run: (api, args) => {
      const { path } = args;
      if (path !== null && !Array.isArray(path)) {
        throw new TypeError('automation command argument "path" must be an array or null');
      }
      api.select(path as JxPath | null);
    },
  },

  // ── Settings ──
  "settings.open": { run: (api, args) => api.openSettings(optionalStr(args, "section")) },
  "settings.selectEntry": {
    press: (args) => ({ selector: buttonIn("settings-list-panel", str(args, "name")) }),
  },
  "settings.setSection": {
    press: (args) => ({
      selector:
        `xpath///button[contains(@class,"settings-nav-item")][normalize-space()=` +
        `"${labelFor(SETTINGS_SECTION_LABELS, str(args, "section"), "settings section")}"]`,
    }),
  },

  // ── State ──
  "state.selectSignal": {
    press: (args) => ({ selector: namedRow("signal-row", "signal-name", str(args, "name")) }),
  },

  // ── Style ──
  "style.openSelectorMenu": { press: () => ({ selector: "sp-picker.selector-select" }) },

  // ── View ──
  "view.setActivity": { run: (api, args) => api.setActivity(str(args, "tab")) },
  "view.setRightTab": { run: (api, args) => api.setRightTab(str(args, "tab")) },
  "view.setStatus": { run: (api, args) => api.setStatus(str(args, "text")) },
  "view.setTheme": { run: (api, args) => api.setTheme(str(args, "color")) },
  "view.toggleActivity": { run: (api, args) => api.toggleActivity(str(args, "tab")) },
  // Idempotent by design, unlike the rail's toggleActivity. A manifest step that says "close the
  // Assistant" must mean it whichever way the default currently points — these two used to be
  // Blind toggles driven by pressing the button, so flipping `chatPanelCollapsed` to default-closed
  // Silently inverted 18 shots. `applyPanelCollapse()` notifies the toolbar via onPanelCollapse,
  // So the chrome repaints without pressing anything.
  "view.setAssistant": { run: (api, args) => api.setAssistant(bool(args, "open")) },
  "view.setRightPanel": { run: (api, args) => api.setRightPanel(bool(args, "open")) },
};

/** The hook is opt-in per page load: only `?automation=1` installs it. */
export function shouldInstallAutomation(search: string): boolean {
  return new URLSearchParams(search).get("automation") === "1";
}

export function createAutomationApi(deps: AutomationDeps): AutomationApi {
  const api: AutomationApi = {
    run(id: string, args: AutomationArgs = {}) {
      const command = AUTOMATION_COMMANDS[id];
      if (!command) {
        throw new Error(`unknown automation command "${id}"`);
      }
      command.run?.(api, args);
      const press = command.press?.(args);
      return press ? { click: press } : {};
    },
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
    setAssistant(open: boolean) {
      view.chatPanelCollapsed = !open;
      applyPanelCollapse();
      renderOnly("chatPanel");
      deps.render();
    },
    setRightPanel(open: boolean) {
      view.rightPanelCollapsed = !open;
      applyPanelCollapse();
      deps.render();
    },
    toggleActivity(tab: string) {
      // Mirrors the activity bar's own sp-tabs @change handler: re-picking the open tab collapses
      // The left panel rather than reselecting it.
      if (tab === view.leftTab && !view.leftPanelCollapsed) {
        view.leftPanelCollapsed = true;
        applyPanelCollapse();
      } else {
        view.leftTab = tab;
        view.leftPanelCollapsed = false;
        applyPanelCollapse();
        renderOnly("leftPanel");
      }
      deps.renderActivityBar();
    },
    togglePreview() {
      // Matches the tab bar's Preview button, which relies on reactivity alone to repaint.
      updateUi("preview", !activeTab.value?.session.ui.preview);
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
  return api;
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
