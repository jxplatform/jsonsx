/**
 * Six commands in the primary Command Bar cluster (cap: five) and a five-tab dock (cap: four).
 *
 * Every placement here is legal by the level matrix, so this fixture isolates the budget: it fails
 * `scripts/check-chrome-budget.ts` and passes `scripts/check-command-levels.ts`.
 */

import type { AnyCommand } from "../../../src/commands/registry";
import type { DockDeclaration } from "../../../src/commands/budget";

export function defaultCommandSet(): AnyCommand[] {
  return ["save", "undo", "redo", "publish", "preview", "share"].map((verb, index) => ({
    id: `file.${verb}`,
    title: `Verb ${index + 1}`,
    category: "File",
    level: "document",
    menus: ["commandbar/primary"],
    run: () => {},
  }));
}

export const dockTabs: readonly DockDeclaration[] = [
  { dock: "bottom", tabs: ["Problems", "Diff", "Logic", "Activity", "Deploy"] },
];
