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
 * **Four tabs, at the documented cap.** `scripts/check-chrome-budget.ts` caps a dock at four, and
 * §12's P4 entry spends them: **Problems · Diff · Logic · Activity**, with Deploy folded into
 * Activity because a deploy is a long operation with a log. `shell.ts` declares the ids
 * ({@link BOTTOM_TAB_IDS}) so a bare Bun process can read `view.setBottomTab`'s enum; this module
 * turns them into records.
 *
 * **The tabs are panel records, so they inherit everything.** `dock: "bottom"` was already admitted
 * by `registerPanel()` and by the level × placement matrix, and `ui/regions.ts` has parsed
 * `dock.bottom` since P3 — it simply resolved to nothing, because there was no host. This is the
 * host. Every tab gets `dock.bottom/panel:<id>` for free, its title comes from the record, and
 * `when` hides the two that P8 builds (Diff and Logic) exactly the way it held the rail's Problems
 * slot through P3.
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
import {
  getPanel,
  isPanelVisible,
  listPanels,
  panelContext,
  registerPanel,
} from "./panel-registry";
import { registerActivityPanel } from "./activity-panel";
import { registerProblemsPanel } from "./problems-panel";
import { renderEmptyState } from "./empty-state";
import type { CommandContext } from "../commands/context";
import type { NavigatorPanelContext, NavigatorPanelDeps, PanelRecord } from "./panel-registry";
import type { EffectScope } from "@vue/reactivity";
import type { TemplateResult } from "lit-html";

/** The dock's host — a bare `<div id>` in index.html, like every other shell host. */
export const BOTTOM_DOCK_SELECTOR = "#bottom-dock";

/** Surfaces the design has declared and the app has not built. Registered, hidden, budgeted. */
const NOT_YET_BUILT = () => false;

/**
 * The body a declared-but-unbuilt tab would draw.
 *
 * Unreachable while `when` is false — it exists so the record is complete rather than carrying an
 * `undefined` render that would throw the first time someone deleted the predicate without reading
 * this file. The same shape `panels/navigator-panels.ts` uses, for the same reason.
 */
function nothingYet(): never {
  throw new Error(
    "This Bottom dock tab is declared but not built — its `when` predicate should have hidden it.",
  );
}

/**
 * Register the Bottom dock's four panels. Idempotent — a second call is a no-op.
 *
 * Problems first, because it is the tab the dock opens itself for. Diff and Logic are declared and
 * hidden, because P8 is the phase that moves the git diff and the formula workspace out of their
 * canvas takeovers — until then the ids are reserved, the budget counts them, and the day they ship
 * the only edit is deleting one predicate.
 */
export function registerBottomPanels(): void {
  if (listPanels("bottom").length > 0) {
    return;
  }
  registerProblemsPanel();
  registerPanel({
    id: "diff",
    title: "Diff",
    level: "document",
    dock: "bottom",
    icon: "sp-icon-brackets",
    rail: false,
    when: NOT_YET_BUILT,
    render: () => nothingYet(),
  });
  registerPanel({
    id: "logic",
    title: "Logic",
    level: "document",
    dock: "bottom",
    icon: "sp-icon-event",
    rail: false,
    when: NOT_YET_BUILT,
    render: () => nothingYet(),
  });
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
 * `doc` is `null` and `deps` is empty, and neither is an oversight: every tab this dock hosts is a
 * PROJECT-level surface (a list of problems, a log of operations), and the Navigator's `deps` are
 * that dock's own injections — the file-tree renderer, the drag registrations, the canvas hooks. A
 * Bottom dock tab that needed one would be a document-level surface in a project-level dock, which
 * is the design error the level × placement matrix exists to catch, not a gap to fill here.
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
    return;
  }
  _host.setAttribute(REGION_ATTR, "dock.bottom");
  litRender(bottomDockTemplate(), _host);
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

/** Release the effect and clear the host. Tests and a window teardown both need this. */
export function unmountBottomDock(): void {
  _scope?.stop();
  _scope = null;
  if (_host) {
    _host.removeAttribute(REGION_ATTR);
    litRender(nothing, _host);
    _host = null;
  }
}
