/**
 * Two misplacements the level × placement matrix must reject:
 *
 * - A selection-level verb in the Command Bar's primary cluster (the Command Bar is not a selection
 *   surface — this is the exact regression the check exists to prevent);
 * - A project-level verb on the block action bar, which only hosts selection-scoped verbs.
 *
 * Loaded by `scripts/check-command-levels.ts --source`, never by the app.
 */

import type { AnyCommand } from "../../../src/commands/registry";

export function defaultCommandSet(): AnyCommand[] {
  return [
    {
      id: "selection.duplicate",
      title: "Duplicate",
      category: "Selection",
      level: "selection",
      menus: ["commandbar/primary", "blockbar"],
      run: () => {},
    },
    {
      id: "project.settings",
      title: "Project Settings",
      category: "Project",
      level: "project",
      menus: ["blockbar"],
      run: () => {},
    },
  ];
}
