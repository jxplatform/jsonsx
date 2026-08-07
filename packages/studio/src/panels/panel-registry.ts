/// <reference lib="dom" />
/**
 * Panel-registry.ts — one definition site per panel.
 *
 * A {@link PanelRecord} is to a surface what a `Command` is to an action: its name, the containment
 * level of the state it WRITES, the dock that hosts it, the predicate that decides whether it
 * exists at all, and the function that draws it. The rail, the panel header and the dock budget
 * become RENDERINGS of these records — plan §2 principle 1, applied to regions rather than verbs.
 *
 * It mirrors the shipped `settings/settings-modal.ts` contribution point
 * (`registerSettingsSection`) deliberately: a module-level `Map`, keyed by id, written by the
 * module that OWNS the surface. The one thing it adds is the field that makes the rail derivable —
 *
 * **`level` is required, and it is the level of the state the panel WRITES, not the state it
 * reads** (plan §2 principle 3). Insert reads the project's component registry and writes the
 * document tree, so it is `document`. Files reads documents and writes project files, so it is
 * `project`. That rule, and not intuition, is what settles every contested placement and what stops
 * the rail re-accreting: the two rail groups are two rows of
 * {@link
 * import("../commands/levels").PANEL_PLACEMENT_MATRIX}, checked at registration exactly the
 * way a command's `menus` are.
 *
 * The predecessor was an eight-item array literal inside `panels/activity-bar.ts` — `{icon, label,
 * value}` — beside an eight-branch `if` chain in `panels/left-panel.ts` and a third list in
 * `shell.ts`. Three places to keep in step, none of which recorded what a panel was FOR.
 */

import { checkPanelPlacement } from "../commands/levels";
import { emptyContext } from "../commands/context";
import { projectState } from "../store";
import { shell } from "../shell";
import { activeTab } from "../workspace/workspace";
import type { Level } from "../commands/levels";
import type { CommandContext } from "../commands/context";
import type { GitDiffState } from "../types";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../state";
import type { Tab, TabUi } from "../tabs/tab";
import type { nothing, TemplateResult } from "lit-html";
import type { renderDataExplorerTemplate } from "./data-explorer";
import type { renderGitPanel } from "./git-panel";
import type { renderHeadTemplate } from "./head-panel";
import type { renderImportsTemplate } from "./imports-panel";
import type { renderSignalsTemplate } from "./signals-panel";

/**
 * The three docks that host panels.
 *
 * A panel's dock is where its BODY is drawn, and it is independent of whether the panel has a rail
 * button: Problems is `dock: "bottom"` and rail-able, so the rail button reveals it in the Bottom
 * dock (see {@link railGroups}). The Inspector has no records yet.
 */
export type PanelDock = "navigator" | "inspector" | "bottom";

/**
 * What a Navigator panel is handed that its own module cannot import.
 *
 * This is `left-panel.ts`'s old `LeftPanelCtx`, moved to the registry because it is now the panel
 * CONTRACT rather than one orchestrator's private argument list. `studio.ts` still builds it: the
 * renderers it injects (the file tree, the head panel, the git panel) close over bootstrap state,
 * and injecting them is what keeps `panels/*` free of an import cycle back through `studio.ts`.
 */
export interface NavigatorPanelDeps {
  getCanvasMode: () => string;
  setCanvasMode: (tab: Tab | null, mode: string) => void;
  // Typed against their implementations so every call site stays checked. These are type-only
  // Imports, so they are erased — the modules themselves are never pulled in through this file.
  renderImportsTemplate: typeof renderImportsTemplate;
  renderFilesTemplate: () => TemplateResult;
  renderSignalsTemplate: typeof renderSignalsTemplate;
  renderDataExplorerTemplate: typeof renderDataExplorerTemplate;
  renderHeadTemplate: typeof renderHeadTemplate;
  renderGitPanel: typeof renderGitPanel;
  renderCanvas: () => void;
  /** Canvas re-render that also lets automatic `Request` entries fetch (Data panel Refresh). */
  refreshData: () => void;
  defCategory: (def: unknown) => string;
  defBadgeLabel: (def: unknown) => string;
  navigateToComponent: (path: string) => void;
  webdata: Record<string, unknown>;
  defaultDef: (tag: string) => Record<string, unknown>;
  registerLayersDnD: () => void;
  registerElementsDnD: () => void;
  registerComponentsDnD: () => void;
  setupTreeKeyboard: (tree: HTMLElement) => void;
  registerFileTreeDnD: (ctx: { renderLeftPanel: () => void }) => void;
  setGitDiffState: (state: GitDiffState | null) => void;
  cloneRepository?: () => void;
}

/**
 * The focused document, as a document-level panel reads it. `null` when no tab is open.
 *
 * A `level: "project"` panel must not read this — that is principle 3's corollary, and the reason
 * the Source Control badge used to vanish when the last tab closed. {@link registerPanel} cannot
 * enforce it (a closure's imports are not inspectable), so the contract is stated here and asserted
 * by `tests/panel-registry.test.ts`, which renders every project-level panel with `doc: null`.
 */
export interface NavigatorDocument {
  document: JxMutableNode;
  mode: string;
  /** The whole selection SET the navigator/inspector panels render against (§6.5). */
  selection: JxPath[];
  canvas: Record<string, unknown> | null;
  content?: { frontmatter?: Record<string, unknown> } | undefined;
  documentPath?: string | null | undefined;
  ui: TabUi;
}

/** Everything a panel's `render` receives. One argument, so a record stays a one-liner. */
export interface NavigatorPanelContext {
  deps: NavigatorPanelDeps;
  /** The focused document, or `null`. Document-level panels render their empty state on `null`. */
  doc: NavigatorDocument | null;
  /** Repaint the Navigator — `left-panel.ts`'s scheduler, not a synchronous re-render. */
  rerender: () => void;
}

/** A panel's rendered body. `nothing` is legal — an empty panel is a state, not a bug. */
export type PanelBody = TemplateResult | typeof nothing;

/** One panel, defined once. */
export interface PanelRecord {
  /** Lowercase, stable, and the value `view.setActivity` accepts — renaming one is a shot break. */
  id: string;
  /** The human name. The rail label AND the panel header, so there is one place it is spelled. */
  title: string;
  /** REQUIRED. The level of the state this panel WRITES. Checked against the panel matrix. */
  level: Level;
  dock: PanelDock;
  /** Icon key, resolved through `activity-bar.ts`'s `tabIcon()` map. */
  icon: string;
  /**
   * `false` for a panel with no rail button.
   *
   * Not a hiding mechanism — a rail-less panel is still reachable by `view.setActivity`, by the
   * palette and by another surface linking to it. It is how a record survives the interval between
   * losing its rail slot and gaining its real home (Insert becomes an overlay in P3.5; State folds
   * into Data). Declaring it `false` also removes the panel's `rail/<level>` placement, which is
   * what keeps the rail inside its four-per-group budget.
   */
  rail?: boolean;
  /**
   * The sentence a document-level panel shows instead of its body when no document is open.
   *
   * Said in the words of the thing the panel needs ("Open a page to see the elements it is built
   * from."), so the ring collapses to a sentence rather than to an empty box. Absent means the
   * panel renders with `doc: null` — Insert does, because an element palette is meaningful before
   * you have chosen where to put anything.
   */
  requiresDocument?: string;
  /** Hide entirely — for a surface that does not exist yet. Default: always present. */
  when?: (ctx: CommandContext) => boolean;
  /** The rail badge, e.g. Source Control's changed-file count. `null`/`0` renders nothing. */
  badge?: (ctx: CommandContext) => number | string | null;
  render: (ctx: NavigatorPanelContext) => PanelBody;
  /**
   * Imperative work that needs the painted DOM — drag registrations, tree keyboard wiring.
   *
   * The eight `if (tab === …)` post-render branches `left-panel.ts` carried, moved onto the records
   * that caused them, so adding a panel cannot forget to drain the previous one's registrations.
   */
  afterRender?: (ctx: NavigatorPanelContext, host: HTMLElement) => void;
}

/**
 * The context a panel's `when` and `badge` are evaluated against.
 *
 * A SUBSET of the command context, built from the two records a panel predicate has ever needed:
 * the reactive `shell` (project-level source control, hoisted off `TabUi` for exactly this reason)
 * and `projectState`. Reading it inside a rendering effect is what makes the rail repaint when the
 * working tree changes, because both reads are tracked.
 *
 * It is deliberately not `createLiveContext()`: that builder needs four facts only `studio.ts` can
 * inject (the canvas mode, the caret, the modal flag, the platform), and a rail that imported the
 * bootstrap to draw a badge would be the import cycle `live-context.ts` documents avoiding. When
 * the bootstrap wires panels the same way it wires commands, this function is what it replaces.
 */
export function panelContext(): CommandContext {
  const ctx = emptyContext();
  ctx.project.open = projectState !== null;
  ctx.git.dirtyCount = shell.git.status?.files?.length ?? 0;
  ctx.document.open = activeTab.value !== null;
  return ctx;
}

/** `[a-z]` then word characters — the same shape `navigator/panel:<id>` is matched by. */
const PANEL_ID_PATTERN = /^[a-z][\w-]*$/;

const panelRegistry = new Map<string, PanelRecord>();

/**
 * Define a panel. Throws on a duplicate id, a malformed id, or a matrix violation.
 *
 * Failing at registration is the same bet `createCommandRegistry.register` makes: a misplaced
 * surface is a design error, and a design error that only shows up as a wrong-looking rail is a
 * design error nobody fixes.
 *
 * @param {PanelRecord} panel
 */
export function registerPanel(panel: PanelRecord): void {
  if (!PANEL_ID_PATTERN.test(panel.id)) {
    throw new Error(
      `Panel id "${panel.id}" is malformed — expected /^[a-z][\\w-]*$/, because the id is also ` +
        `the region "navigator/panel:${panel.id}" and the value view.setActivity accepts.`,
    );
  }
  if (panelRegistry.has(panel.id)) {
    throw new Error(
      `Panel "${panel.id}" is already registered — a second definition site is the defect this ` +
        `registry exists to prevent.`,
    );
  }
  const violations = checkPanelPlacement({
    id: panel.id,
    level: panel.level,
    dock: panel.dock,
    rail: panel.rail,
  });
  if (violations.length > 0) {
    const detail = violations.map((violation) => `  ✗ ${panel.id} ${violation.message}`).join("\n");
    throw new Error(`Panel "${panel.id}" violates the level × placement matrix:\n${detail}`);
  }
  panelRegistry.set(panel.id, panel);
}

/** Remove a panel — the contributed-extension path, and the reset every test needs. */
export function unregisterPanel(id: string): void {
  panelRegistry.delete(id);
}

/** Drop every registration. Tests only; the app registers once, at mount. */
export function resetPanels(): void {
  panelRegistry.clear();
}

/** One panel by id, or `undefined`. */
export function getPanel(id: string): PanelRecord | undefined {
  return panelRegistry.get(id);
}

/** Every registered panel, in registration order — which is rail order. */
export function listPanels(dock?: PanelDock): readonly PanelRecord[] {
  const all = [...panelRegistry.values()];
  return dock ? all.filter((panel) => panel.dock === dock) : all;
}

/** Whether a panel's `when` admits it in this context. A record with no `when` always does. */
export function isPanelVisible(panel: PanelRecord, ctx: CommandContext): boolean {
  return panel.when ? panel.when(ctx) : true;
}

/** One rail group: the level it hosts, its heading, and the panels in it. */
export interface RailGroup {
  level: Level;
  /** The group's accessible name — "Project" / "Document", the levels said out loud. */
  label: string;
  panels: readonly PanelRecord[];
}

/** The rail's two groups, in shell order. `application` and `selection` have no group. */
const RAIL_GROUP_LEVELS: readonly { level: Level; label: string }[] = [
  { level: "project", label: "Project" },
  { level: "document", label: "Document" },
];

/**
 * Every panel that has a rail button, whatever dock draws its body.
 *
 * The rail is NOT the Navigator's tab strip. `panelPlacements()` has always awarded `rail/<level>`
 * on `rail !== false` alone — the dock is a separate placement — and Problems is the panel that
 * proves it: its body is the Bottom dock's first tab (plan §7.2), and it still owns a rail slot and
 * a badge, because "how many things need fixing" is a question you ask without opening anything.
 * Filtering this by `dock === "navigator"` is what would put the same list in two hosts at once.
 */
function railablePanels(): readonly PanelRecord[] {
  return listPanels().filter((panel) => panel.rail !== false);
}

/**
 * The rail, as data: every rail-able panel, grouped by level, `when`-filtered.
 *
 * Empty groups are dropped, so the divider between them is never drawn against nothing.
 *
 * @param {CommandContext} ctx
 */
export function railGroups(ctx: CommandContext): RailGroup[] {
  const railable = railablePanels();
  return RAIL_GROUP_LEVELS.map(({ level, label }) => ({
    level,
    label,
    panels: railable.filter((panel) => panel.level === level && isPanelVisible(panel, ctx)),
  })).filter((group) => group.panels.length > 0);
}

/**
 * The rail's panels flattened into rail order — PROJECT group, then DOCUMENT group.
 *
 * This is the order ⌘1–8 follow, and it is derived from the same two rows the rail draws rather
 * than from registration order, so a panel registered by its dock's module (Problems, from
 * `panels/bottom-dock.ts`) still lands in the slot its LEVEL gives it. `when` is not applied: a
 * chord roster that changed length with context would move every chord after the hidden panel.
 */
export function railPanelSet(): PanelRecord[] {
  const railable = railablePanels();
  return RAIL_GROUP_LEVELS.flatMap(({ level }) =>
    railable.filter((panel) => panel.level === level),
  );
}

/** One tabbed region and what it declares, in `commands/budget.ts`'s shape. */
export interface PanelDockDeclaration {
  dock: string;
  tabs: readonly string[];
}

/**
 * The rail's two groups as budget declarations — the `rail/*` rows `scripts/check-chrome-budget.ts`
 * counts, observed rather than written down. `commands/budget.ts` no longer carries a copy.
 *
 * `when` is deliberately NOT applied: the budget caps what the shell may GROW to, not what happens
 * to be visible in one context. Search is registered and hidden today, and it still spends its rail
 * slot — which is the point, because its arrival must not silently push the rail to five.
 */
export function railDeclarations(): PanelDockDeclaration[] {
  const railable = railablePanels();
  return RAIL_GROUP_LEVELS.map(({ level }) => ({
    dock: `rail/${level}`,
    tabs: railable.filter((panel) => panel.level === level).map((panel) => panel.title),
  })).filter((declaration) => declaration.tabs.length > 0);
}
