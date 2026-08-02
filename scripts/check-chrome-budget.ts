// Enforces the chrome budget from packages/studio/UX-REDESIGN-PLAN.md §2, principle 9:
//
//   * At most five commands may declare `menus: ["commandbar/primary"]`.
//   * At most four tabs per dock.
//
// Chrome is earned by frequency, and a cap is the only version of that rule that survives contact
// With a deadline. Studio's current toolbar is the counter-example: its own CSS strips every
// `.tb-label` below 1140px rather than concede there are too many controls, so the fix for "one
// More button" has been "make them all anonymous". Under this check the fix is to retire a control
// To `commandbar/overflow`, where it keeps its name, its chord and its palette row.
//
// Run in the CI `checks` job: `bun scripts/check-chrome-budget.ts`
// Against a fixture:         `bun scripts/check-chrome-budget.ts --source <module.ts>`
//
// The source module exports `defaultCommandSet(): Command[]` and MAY export `dockTabs` to override
// The declared dock/tab sets. Those sets are a declaration today because `registerPanel()` (plan
// P3) does not exist yet; when it does, `DOCK_TABS` becomes a query over the panel registry and
// This script does not change.

import {
  checkChromeBudget,
  CHROME_BUDGET,
  DOCK_TABS,
} from "../packages/studio/src/commands/budget";
import type { BudgetableRecord, DockDeclaration } from "../packages/studio/src/commands/budget";

const DEFAULT_SOURCE = "../packages/studio/src/commands/app-commands.ts";

interface CommandSource {
  defaultCommandSet?: () => BudgetableRecord[];
  dockTabs?: readonly DockDeclaration[];
}

const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
if (sourceIndex !== -1 && !args[sourceIndex + 1]) {
  console.error("Usage: bun scripts/check-chrome-budget.ts [--source <module>]");
  process.exit(2);
}
const sourcePath =
  sourceIndex === -1 ? DEFAULT_SOURCE : Bun.pathToFileURL(args[sourceIndex + 1]!).href;

const source = (await import(sourcePath)) as CommandSource;
if (typeof source.defaultCommandSet !== "function") {
  console.error(`${sourcePath} does not export defaultCommandSet()`);
  process.exit(2);
}

const docks = source.dockTabs ?? DOCK_TABS;
const violations = checkChromeBudget({ commands: source.defaultCommandSet(), docks });

if (violations.length > 0) {
  console.error("Chrome budget exceeded (UX-REDESIGN-PLAN §2, principle 9):\n");
  for (const violation of violations) {
    console.error(`  ✗ ${violation.subject}: ${violation.message}`);
  }
  console.error(
    "\nRetiring a control costs a discoverable command name, a bindable chord, and usually a " +
      "status-bar or context-menu residue. Retiring without all three is deletion, not " +
      "consolidation — and raising a cap is a design decision, made in commands/budget.ts.",
  );
  process.exit(1);
}

console.log(
  `chrome-budget OK: ≤${CHROME_BUDGET.commandbarPrimary} primary command(s), ` +
    `${docks.length} dock(s) within ${CHROME_BUDGET.dockTabs} tabs each.`,
);
