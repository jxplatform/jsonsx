/**
 * Budget.ts — chrome is earned by frequency and capped by a build check.
 *
 * Plan §2, principle 9: at most five commands may declare `menus: ["commandbar/primary"]`, and at
 * most four tabs per dock. `scripts/check-chrome-budget.ts` fails CI otherwise, which is what turns
 * "we should keep the toolbar small" from a code-review opinion into a build error.
 *
 * The cap is not arbitrary. The toolbar's own CSS already admits it is over budget — a container
 * query at 1140px strips every `.tb-label` rather than conceding there are too many controls — and
 * an unlabelled icon is a control the user has to hover to identify. A hard number is what makes
 * "retire this control, keep its name and its chord" the cheap option.
 *
 * The dock/tab sets used to be a flat declaration — written out from §3.2 because `registerPanel()`
 * did not exist. It does now, so the two `rail/*` rows are a QUERY over `railDeclarations()`
 * ({@link dockTabs}) and adding a ninth rail panel fails this check without anyone remembering to
 * update a list. The two rows that remain declared are the docks that have no registry yet: the
 * Inspector's four tabs come from `commands/defaults.ts`'s `INSPECTOR_TABS`, and the bottom dock
 * does not exist at all. Each becomes a query the same way, in the phase that builds it.
 */

import { INSPECTOR_TABS } from "./defaults";

/** The caps. Raising either one is a design decision, so it happens here, in one place. */
export const CHROME_BUDGET = {
  /** Commands allowed in the Command Bar's primary verb cluster. */
  commandbarPrimary: 5,
  /** Tabs allowed in any one dock (or rail group). */
  dockTabs: 4,
} as const;

/** One tabbed region and what it currently hosts. */
export interface DockDeclaration {
  /** Region key as §3.2 names it. Rail groups count separately — they are separate placements. */
  dock: string;
  tabs: readonly string[];
}

/**
 * The tabbed regions that are still WRITTEN DOWN rather than observed.
 *
 * The Inspector's row is a query in all but name — `INSPECTOR_TABS` is the list `right-panel.ts`
 * renders and `⌘⇧1–4` address, so a fifth inspector tab fails this check in the commit that adds
 * it. The Bottom dock has nothing to observe: it does not exist, and it is here so that the phase
 * that builds it inherits the cap instead of discovering it (Deploy folds into Activity precisely
 * to stay inside four).
 *
 * The rail's two groups are NOT here. They come from `panels/panel-registry.ts`'s
 * `railDeclarations()` and are joined on by {@link dockTabs} — the registry is the single source of
 * what a panel is called and which group it sits in, and a duplicate list here was the last place
 * those could disagree.
 */
export const DECLARED_DOCK_TABS: readonly DockDeclaration[] = [
  { dock: "inspector", tabs: INSPECTOR_TABS.map((tab) => tab.title) },
  { dock: "bottom", tabs: ["Problems", "Diff", "Logic", "Activity"] },
];

/**
 * Every tabbed region: the declared ones plus the rail groups the panel registry observes.
 *
 * The rails arrive as an ARGUMENT rather than by import so this module keeps the property that lets
 * three CI checks load it in a bare Bun process — `panel-registry.ts` reaches the DOM, the shell
 * record and the workspace. `scripts/check-chrome-budget.ts` is the one place that joins them.
 *
 * @param rails `railDeclarations()`, or `[]` where no registry has been populated.
 */
export function dockTabs(rails: readonly DockDeclaration[] = []): DockDeclaration[] {
  return [...DECLARED_DOCK_TABS, ...rails];
}

/** The subset of a command record the budget check reads. */
export interface BudgetableRecord {
  id: string;
  menus?: readonly string[] | undefined;
}

/** One exceeded cap. */
export interface BudgetViolation {
  /** What was counted: a placement key, or a dock key. */
  subject: string;
  count: number;
  limit: number;
  message: string;
}

/** Commands declaring the primary Command Bar cluster. */
export function primaryCommandIds(commands: readonly BudgetableRecord[]): string[] {
  return commands
    .filter((command) => (command.menus ?? []).includes("commandbar/primary"))
    .map((command) => command.id);
}

/**
 * Check both caps.
 *
 * @param input.commands Every registered command record.
 * @param input.docks The shell's tabbed regions. Defaults to {@link dockTabs} with no rails.
 */
export function checkChromeBudget(input: {
  commands: readonly BudgetableRecord[];
  docks?: readonly DockDeclaration[];
}): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  const primary = primaryCommandIds(input.commands);
  if (primary.length > CHROME_BUDGET.commandbarPrimary) {
    violations.push({
      subject: "commandbar/primary",
      count: primary.length,
      limit: CHROME_BUDGET.commandbarPrimary,
      message:
        `${primary.length} commands declare menus:["commandbar/primary"], the cap is ` +
        `${CHROME_BUDGET.commandbarPrimary} — ${primary.join(", ")}. Retire one to ` +
        `"commandbar/overflow": it keeps its name, its chord and its palette row.`,
    });
  }
  for (const dock of input.docks ?? dockTabs()) {
    if (dock.tabs.length > CHROME_BUDGET.dockTabs) {
      violations.push({
        subject: dock.dock,
        count: dock.tabs.length,
        limit: CHROME_BUDGET.dockTabs,
        message:
          `dock "${dock.dock}" declares ${dock.tabs.length} tabs, the cap is ` +
          `${CHROME_BUDGET.dockTabs} — ${dock.tabs.join(", ")}. Fold two together or move one ` +
          `to another dock.`,
      });
    }
  }
  return violations;
}
