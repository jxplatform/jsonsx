/**
 * A minimal command set that satisfies both CI checks — the passing half of the
 * `scripts/check-command-levels.ts` / `scripts/check-chrome-budget.ts` fixtures.
 *
 * Loaded by the checks with `--source`, never by the app.
 */

import type { AnyCommand } from "../../../src/commands/registry";
import type { DockDeclaration } from "../../../src/commands/budget";

export function defaultCommandSet(): AnyCommand[] {
  return [
    {
      id: "file.save",
      title: "Save",
      category: "File",
      level: "document",
      menus: ["commandbar/primary", "palette"],
      run: () => {},
    },
    {
      id: "selection.duplicate",
      title: "Duplicate",
      category: "Selection",
      level: "selection",
      menus: ["blockbar", "context/element"],
      run: () => {},
    },
    {
      id: "project.open",
      title: "Open Project…",
      category: "Project",
      level: "project",
      menus: ["statusbar/project", "commandbar/overflow"],
      run: () => {},
    },
  ];
}

export const dockTabs: readonly DockDeclaration[] = [
  { dock: "inspector", tabs: ["Content", "Style", "Logic", "Assistant"] },
];
