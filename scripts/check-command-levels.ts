// Enforces the level × placement matrix from packages/studio/UX-REDESIGN-PLAN.md §5.1 (normative
// Copy in specs/studio-ui-guidelines.md §12).
//
// Every Studio command declares a containment level — what it acts on — and a set of `menus`
// Placements — where it renders. Each placement admits a fixed set of levels: `blockbar` is a
// Selection surface and nothing else; `commandbar/primary` takes application and document verbs
// Only; the status bar is three separate single-level placements rather than one "mixed" region.
// Mixed regions are mixed IN THE TABLE, so there are no prose exemptions to argue about in review.
//
// This is the check that stops the rail, the toolbar and the context menus re-accreting: without
// It, "position encodes scope" is a design memo, and the first PR under deadline pressure puts a
// Selection verb in the Command Bar because there was room.
//
// Run in the CI `checks` job: `bun scripts/check-command-levels.ts`
// Against a fixture:        `bun scripts/check-command-levels.ts --source <module.ts>`
//
// The source module exports `defaultCommandSet(): Command[]`. Today that is the studio's default
// Command set; when the app bootstraps its registry from more than one contribution point, this
// Script's default source becomes whatever module composes them — the check is unchanged.

import { checkPlacements, PLACEMENT_MATRIX } from "../packages/studio/src/commands/levels";
import type { PlaceableRecord } from "../packages/studio/src/commands/levels";

const DEFAULT_SOURCE = "../packages/studio/src/commands/app-commands.ts";

interface CommandSource {
  defaultCommandSet?: () => PlaceableRecord[];
}

const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
if (sourceIndex !== -1 && !args[sourceIndex + 1]) {
  console.error("Usage: bun scripts/check-command-levels.ts [--source <module>]");
  process.exit(2);
}
const sourcePath =
  sourceIndex === -1 ? DEFAULT_SOURCE : Bun.pathToFileURL(args[sourceIndex + 1]!).href;

const source = (await import(sourcePath)) as CommandSource;
if (typeof source.defaultCommandSet !== "function") {
  console.error(`${sourcePath} does not export defaultCommandSet()`);
  process.exit(2);
}

const commands = source.defaultCommandSet();
const violations = checkPlacements(commands);

if (violations.length > 0) {
  console.error(
    "Level × placement violations (UX-REDESIGN-PLAN §5.1 / studio-ui-guidelines §12):\n",
  );
  for (const violation of violations) {
    console.error(`  ✗ ${violation.commandId} ${violation.message}`);
  }
  console.error(
    "\nEither the command's `level` is wrong (file a surface by the level of the state it " +
      "WRITES, not the state it reads) or it is declared into a region that does not host that " +
      "level. A region that genuinely needs a second level gets a new row in PLACEMENT_MATRIX, " +
      "with the reason — not an exemption in a comment.",
  );
  process.exit(1);
}

const placed = commands.filter((command) => (command.menus ?? []).length > 0).length;
console.log(
  `command-levels OK: ${commands.length} command(s), ${placed} with declared placements, ` +
    `checked against ${Object.keys(PLACEMENT_MATRIX).length} matrix rows.`,
);
