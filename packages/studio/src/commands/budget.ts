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
 * {@link DOCK_TABS} is a declaration, not an observation: `registerPanel()` (plan P3) does not
 * exist yet, so the tab sets are written out here from §3.2 and checked. When the panel registry
 * lands, this constant is replaced by a query over it — the check and its threshold do not change.
 */

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
 * The tabbed regions of the shell, at the documented cap.
 *
 * The Bottom dock folds Deploy into Activity precisely to stay inside it; the Navigator rail's two
 * level groups are four each with a divider between them.
 */
export const DOCK_TABS: readonly DockDeclaration[] = [
  { dock: "inspector", tabs: ["Content", "Style", "Logic", "Assistant"] },
  { dock: "bottom", tabs: ["Problems", "Diff", "Logic", "Activity"] },
  { dock: "rail/project", tabs: ["Files", "Search", "Source Control", "Problems"] },
  { dock: "rail/document", tabs: ["Outline", "Page", "Data", "Packages"] },
];

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
 * @param input.docks The shell's tabbed regions. Defaults to {@link DOCK_TABS}.
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
  for (const dock of input.docks ?? DOCK_TABS) {
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
