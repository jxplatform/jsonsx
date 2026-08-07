/// <reference lib="dom" />
/**
 * ⑪ The Bottom dock — where long operations and lists of things-to-fix live (plan §3.2 ⑪).
 *
 * Studio had no bottom dock and at least five surfaces wanted one, so each of them took over the
 * canvas: Code mode, the git diff, the formula workspace and the Monaco function editor all replace
 * the stage, and the progress modal covers the whole app. The canvas is the one region §3 says must
 * never disappear, so this is where those surfaces go instead.
 *
 * **Under the pane grid, not under the window.** The dock occupies the pane's grid column only, so
 * opening it never narrows the Navigator or the Inspector — which is the difference between a dock
 * that is cheap to open and one that rearranges your whole workspace to show you two warnings.
 *
 * **Three tabs, under a cap of four.** `scripts/check-chrome-budget.ts` caps a dock at four, and
 * this spends three: **Problems · Logic · Activity**, with Deploy folded into Activity because a
 * deploy is a long operation with a log. Diff was the fourth until P8 gave it a pane to open into
 * instead — see {@link registerBottomPanels}. `shell.ts` declares the ids ({@link BOTTOM_TAB_IDS})
 * so a bare Bun process can read `view.setBottomTab`'s enum; this module turns them into records.
 *
 * **The tabs are panel records, so they inherit everything.** `dock: "bottom"` was already admitted
 * by `registerPanel()` and by the level × placement matrix, and `ui/regions.ts` has parsed
 * `dock.bottom` since P3 — it simply resolved to nothing, because there was no host. This is the
 * host. Every tab gets `dock.bottom/panel:<id>` for free and its title comes from the record.
 *
 * **Logic is built, and it is why this dock exists.** P8.5 moves the formula workspace and the
 * Monaco function editor out of their canvas takeovers and into this tab, so the page whose values
 * they compute stays on screen beside them. Its record is defined beside the surface
 * (`panels/formula-workspace.ts`) and registered from here, like Problems and Activity. Because a
 * takeover reveals itself by definition and a dock tab does not, {@link mountBottomDock} watches
 * for a Logic target appearing and opens the dock on it — once per target, so closing the dock over
 * an open formula keeps it closed until you open another.
 *
 * **Problems is one of them.** §7.2's table places it here ("Problems | Bottom dock ⑪, badge on the
 * rail") and this dock is its only host. It keeps a rail button and a badge — the rail groups by
 * LEVEL, not by dock — and that button reveals it HERE, which is what `panels/activity-bar.ts`
 * branches on. Its record is defined beside the notification store it renders
 * (`panels/problems-panel.ts`) and registered from here, like every other tab of this dock.
 */

import { html, render as litRender, nothing } from "lit-html";
import { effect, effectScope } from "../reactivity";
import {
  BOTTOM_TAB_IDS,
  DEFAULT_BOTTOM_TAB,
  isBottomTabId,
  registerShellSurface,
  setBottomTab,
  setDockCollapsed,
  shell,
} from "../shell";
import { bottomPanelRegion, REGION_ATTR } from "../ui/regions";
import { getPanel, isPanelVisible, listPanels, panelContext } from "./panel-registry";
import { registerActivityPanel } from "./activity-panel";
import { registerProblemsPanel } from "./problems-panel";
import { logicTarget, registerLogicPanel, revealLogicPanel } from "./formula-workspace";
import { renderEmptyState } from "./empty-state";
import type { CommandContext } from "../commands/context";
import type { NavigatorPanelContext, NavigatorPanelDeps, PanelRecord } from "./panel-registry";
import type { EffectScope } from "@vue/reactivity";
import type { TemplateResult } from "lit-html";

/** The dock's host — a bare `<div id>` in index.html, like every other shell host. */
export const BOTTOM_DOCK_SELECTOR = "#bottom-dock";

// No `NOT_YET_BUILT` placeholder here. The Navigator keeps one (`panels/navigator-panels.ts`, for
// Search) because Search exists nowhere else and a reserved rail slot is an honest promise. This
// Dock's reservation was for Diff, and Diff shipped somewhere better — see `registerBottomPanels`.

/**
 * Register the Bottom dock's three panels. Idempotent — a second call is a no-op.
 *
 * Problems first, because it is the tab the dock opens itself for.
 *
 * **Diff is not among them, and its reserved id is gone.** It was held here through P4–P7 with a
 * `when: () => false`, and the comment that held it said why it should not be here: `git-diff` is
 * the `diff` EDITOR KIND (`commands/context.ts`), a pane hosts it at pane size, and folding it into
 * a 240px dock would be a downgrade. What it owed was a pane to open into — and P8 shipped that
 * (`pane.splitRight`, `canOpenInSecondPane`), so Source Control opens a changed file as a Diff
 * editor in the side pane. A reservation whose capability shipped elsewhere is not a reservation;
 * it is an id in `view.setBottomTab`'s enum that can only ever select a hidden tab. The dock spends
 * three of its four budgeted slots and the fourth is genuinely free.
 */
export function registerBottomPanels(): void {
  if (listPanels("bottom").length > 0) {
    return;
  }
  registerProblemsPanel();
  registerLogicPanel();
  registerActivityPanel();
}

/**
 * The dock's tabs, in strip order.
 *
 * Ordered by {@link BOTTOM_TAB_IDS} rather than by registration order, because the strip's order is
 * a design decision (§3.2 ⑪ names it) and `shell.ts` is where a bare Bun process can read it. An id
 * with no record is skipped rather than throwing: the list is also the `args` enum, and a command
 * enum naming a surface that has not registered yet must be inert, not fatal.
 */
export function bottomPanelSet(): PanelRecord[] {
  registerBottomPanels();
  const records: PanelRecord[] = [];
  for (const id of BOTTOM_TAB_IDS) {
    const panel = getPanel(id);
    if (panel) {
      records.push(panel);
    }
  }
  return records;
}

/** The tabs a given context admits — `when`-filtered, exactly as the rail is. */
export function visibleBottomPanels(ctx: CommandContext = panelContext()): PanelRecord[] {
  return bottomPanelSet().filter((panel) => isPanelVisible(panel, ctx));
}

/**
 * The tab to draw as selected: the stored one when it is visible, else the first that is.
 *
 * `null` when the dock has no visible tab at all, which is a real state (every tab gated off) and
 * renders as an empty state rather than as a blank box.
 */
export function activeBottomPanel(ctx: CommandContext = panelContext()): PanelRecord | null {
  const visible = visibleBottomPanels(ctx);
  const stored = isBottomTabId(shell.bottomTab) ? shell.bottomTab : DEFAULT_BOTTOM_TAB;
  return visible.find((panel) => panel.id === stored) ?? visible[0] ?? null;
}

/**
 * The context a Bottom dock panel's `render` is called with.
 *
 * `doc` is `null` and `deps` is empty, and neither is an oversight. `deps` are the NAVIGATOR's own
 * injections — the file-tree renderer, the drag registrations, the canvas hooks — and a Bottom dock
 * tab that needed one would be reaching across docks for a surface it does not host.
 *
 * `doc` is null because this dock has no no-document empty state to drive: Problems and Activity
 * are project-level lists, and Logic is document-level but addresses a document POSITION rather
 * than the focused document — it reads `activeTab` itself, and its `when` is what takes it off the
 * strip when there is nothing open in it.
 */
function bottomContext(): NavigatorPanelContext {
  return {
    deps: {} as NavigatorPanelDeps,
    doc: null,
    rerender: renderBottomDock,
  };
}

/** One tab's label — the record's title, with its badge appended as §3.1 draws it ("Problems 2"). */
export function bottomTabLabel(panel: PanelRecord, ctx: CommandContext): string {
  const badge = panel.badge?.(ctx) ?? null;
  return badge === null || badge === 0 || badge === "" ? panel.title : `${panel.title} ${badge}`;
}

/** The dock, as a template. Exported so a test can render it without a host. */
export function bottomDockTemplate(ctx: CommandContext = panelContext()): TemplateResult {
  const panels = visibleBottomPanels(ctx);
  const active = activeBottomPanel(ctx);
  const body = active
    ? active.render(bottomContext())
    : renderEmptyState({ message: "Nothing to show here yet." });
  return html`
    <div class="bd-strip">
      <sp-tabs
        class="bd-tabs"
        quiet
        size="s"
        selected=${active?.id ?? ""}
        @change=${(e: Event & { target: { selected: string } }) => {
          const { selected } = e.target;
          if (selected && selected !== active?.id) {
            setBottomTab(selected);
          }
        }}
      >
        ${panels.map(
          (panel) => html`<sp-tab value=${panel.id} label=${bottomTabLabel(panel, ctx)}></sp-tab>`,
        )}
      </sp-tabs>
      <button
        class="bd-close"
        title="Close the Bottom dock"
        aria-label="Close the Bottom dock"
        @click=${() => {
          setDockCollapsed("bottom", true);
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
    ${
      active
        ? html`<div class="bd-body" data-jx-region=${bottomPanelRegion(active.id)}>${body}</div>`
        : html`<div class="bd-body">${body}</div>`
    }
  `;
}

let _scope: EffectScope | null = null;

let _host: HTMLElement | null = null;

/**
 * The Logic target the dock has already revealed itself for.
 *
 * This effect answers ONE of the two events that put Logic on screen: **a target appeared** — a tab
 * switch, a restored session, anything that changes what Logic would show without anyone asking to
 * see it. It fires when the target appears or changes and never again, because collapsing the dock
 * over an open formula must leave it closed (§16.3) and a dock you cannot shut is worse than the
 * takeover it replaced.
 *
 * The other event is **the user asked for this surface**, and it cannot be derived from this one: a
 * second click on the same button changes no target at all, so a key comparison sees nothing to do
 * and the collapsed dock stayed shut under a button that looked broken. That event belongs to the
 * gesture, and `formula-workspace.ts`'s `openLogicTarget` is where every opener says it.
 */
let _revealedLogicKey: string | null = null;

/** A stable identity for the open formula/function, or `null` when the Logic tab has no target. */
function logicKey(): string | null {
  const target = logicTarget();
  return target ? `${target.surface} ${JSON.stringify(target.editing)}` : null;
}

/**
 * Paint the dock, and stamp the region iff it is on screen.
 *
 * The stamp is conditional on purpose. `REGION_FOR_FOCUS.dock` has pointed at `dock.bottom` since
 * P3, so F6 and `regions.resolve()` will find whatever carries it — and a COLLAPSED dock is a
 * `display: none` box that focus must not land in and a shot must not crop. A closed dock therefore
 * resolves to nothing, and `view.setBottomDock { open: true }` is what makes it addressable, which
 * is exactly what an idempotent setter is for.
 */
export function renderBottomDock(): void {
  if (!_host) {
    return;
  }
  if (shell.docks.bottom.collapsed) {
    _host.removeAttribute(REGION_ATTR);
    litRender(nothing, _host);
    runAfterRender(_host);
    return;
  }
  _host.setAttribute(REGION_ATTR, "dock.bottom");
  litRender(bottomDockTemplate(), _host);
  runAfterRender(_host.querySelector<HTMLElement>(".bd-body") ?? _host);
}

/**
 * Run every tab's `afterRender` against whatever was just painted — showing or not.
 *
 * `panels/left-panel.ts` runs the hook for the ACTIVE panel only, and can: no Navigator panel owns
 * anything that outlives its own markup. Logic does — a live Monaco instance — and the three ways
 * to stop showing it (select another tab, collapse the dock, close the target) all leave that
 * instance attached to DOM lit has already thrown away. Handing every tab the painted element turns
 * "am I still on screen?" into a question each surface can answer for itself, which is what
 * `syncFunctionEditor` does with it, and keeps the dock from having to know that Logic is special.
 *
 * @param {HTMLElement} painted The dock body, or the host itself when the dock is collapsed.
 */
function runAfterRender(painted: HTMLElement): void {
  const ctx = bottomContext();
  for (const panel of bottomPanelSet()) {
    panel.afterRender?.(ctx, painted);
  }
}

/**
 * Mount the Bottom dock. Idempotent, and inert when its host is absent.
 *
 * Called by `shell.ts`'s `mountShell()`, beside the effect that projects the dock record onto the
 * grid: the dock's visibility and its size are shell state, and mounting it anywhere else would be
 * a second place the shell's layout is decided.
 */
export function mountBottomDock(): void {
  if (_scope) {
    return;
  }
  _host = document.querySelector<HTMLElement>(BOTTOM_DOCK_SELECTOR);
  if (!_host) {
    return;
  }
  _scope = effectScope();
  _scope.run(() => {
    // Reveal BEFORE the render effect, and in an effect of its own: it reads the Logic target and
    // Writes `shell.bottomTab`, which the render effect reads — one effect doing both would
    // Re-enter itself on every reveal.
    effect(() => {
      const key = logicKey();
      if (key !== null && key !== _revealedLogicKey) {
        revealLogicPanel();
      }
      _revealedLogicKey = key;
    });
    effect(() => {
      // Tracked: whether the dock is open, which tab it shows, and the two reactive stores its
      // Tabs render — so a problem raised or an operation started repaints the strip's badge
      // Without this module knowing which panel produced it.
      void shell.docks.bottom.collapsed;
      void shell.bottomTab;
      renderBottomDock();
    });
  });
}

/**
 * Attach to the shell's lifecycle.
 *
 * The dependency points this way — the dock knows about the shell, and the shell knows only that
 * something wants mounting — because the reverse is a cycle, and because it puts the knowledge
 * "this surface is a dock" in the module that IS the dock.
 */
registerShellSurface({ mount: mountBottomDock, unmount: unmountBottomDock });

/**
 * Release the effect and clear the host. Tests and a window teardown both need this.
 *
 * The `runAfterRender` is not symmetry for its own sake. Blanking the host is the fourth way the
 * Logic tab stops being on screen, and it is the one nothing else covers: `renderBottomDock`'s
 * collapsed branch runs the hook, a tab switch runs it, closing the target runs it — this path used
 * to `litRender(nothing)` and stop, leaving a live Monaco instance (a text model, its change
 * listeners and an `automaticLayout` ResizeObserver) parked on `view.functionEditor` and attached
 * to DOM that no longer exists. The canvas-side dispose that used to mop it up went away with the
 * takeover; handing the emptied host to every tab is what replaces it, and it keeps the dock from
 * having to know that Logic is the special one.
 */
export function unmountBottomDock(): void {
  _scope?.stop();
  _scope = null;
  _revealedLogicKey = null;
  if (_host) {
    _host.removeAttribute(REGION_ATTR);
    litRender(nothing, _host);
    runAfterRender(_host);
    _host = null;
  }
}
