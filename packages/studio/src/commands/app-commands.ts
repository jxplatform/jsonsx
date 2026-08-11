/**
 * App-commands.ts — the whole app's command set, in one bare-Bun-importable place.
 *
 * `src/studio.ts` composes the registry a RUNNING window uses, by calling each module's
 * `registerXCommands(registry, deps)` beside the state it writes. That is the right shape for the
 * app and the wrong shape for CI: `scripts/check-command-levels.ts`,
 * `scripts/check-chrome-budget.ts` and `scripts/check-shot-contract.ts` all run in a bare Bun
 * process with no DOM and no bootstrap, and each looks for one export — `defaultCommandSet()`.
 *
 * Without this module those three checks see only `commands/defaults.ts`'s sixteen records, which
 * is why plan §13.5's headline promise was not yet true: a manifest step naming `view.setActivity`
 * with a panel id the registry does not declare sailed through Lane 1, because Lane 1 could not
 * load the record that declares the enum. Every module gathered below imports cleanly with no
 * `document` and no `localStorage` write, which is the ONLY property this file requires of them —
 * and the test beside it asserts exactly that, so a future DOM read at module scope fails here
 * rather than in CI.
 *
 * **Deps are the no-op set.** Nothing here runs a command; the checks read `id`, `level`, `menus`
 * and `args`. Passing real implementations would mean importing the app.
 *
 * **What is deliberately NOT here.** `editor/shortcuts.ts` and `editor/context-menu.ts` still build
 * their OWN registries over their own contexts, and both declare `edit.copy` / `edit.cut` that the
 * other also declares (see the handoff table in `shortcuts.ts`). Listing them would put duplicate
 * ids in front of a checker that has no way to know which one wins. They join when that
 * reconciliation lands — one line each, and no script changes.
 */

import { defaultCommands, noopCommandDeps } from "./defaults";
import { panelFocusRoster } from "../panels/navigator-panels";
import { createCommandRegistry } from "./registry";
import { emptyContext } from "./context";
import { DEFAULT_INSPECTOR_TAB, shellViewCommands } from "../shell";
import { canvasViewCommands } from "../canvas/canvas-utils";
import { selectionCommands } from "../canvas/canvas-render";
import { inspectorCommands } from "../panels/properties-panel";
import { dataExplorerCommands } from "../panels/data-explorer";
import { liveElementCommands } from "../editor/context-menu";
import { signalsCommands } from "../panels/signals-panel";
import { formulaEditorCommands } from "../panels/formula-workspace";
import { styleCommands } from "../panels/style-panel";
import { gridCommands } from "../grid/grid-open";
import { settingsCommands } from "../settings/settings-document";
import { collabCommands } from "../collab/collab-commands";
import { preferencesCommands } from "../settings/preferences-dialog";
import { aboutCommands } from "../about/about-modal";
import { libraryCommands } from "../browse/library-commands";
import { sourceControlCommands } from "../panels/git-panel";
import { publishCommands } from "../publish/publish-commands";
import { gridViewCommands } from "../grid/grid-panel";
import { redirectsCommands } from "../grid/redirects-grid";
import { contentCommands } from "../content/entry-commands";
import { newProjectCommands } from "../new-project/new-project-modal";
import { registerSelectionCommands } from "../panels/block-action-bar";
import { registerTabCommands } from "../workspace/workspace";
import { derivationCommands, noopDerivationDeps } from "../workspace/pane-derive";
import type { AnyCommand } from "./registry";

/** A verb set that does nothing — the checks read declarations, never behaviour. */
const NO_OP = () => {};

/**
 * Records that are only reachable through a `registerX(registry, deps)` entry point.
 *
 * Collected by registering them into a throwaway registry and reading it back, rather than by
 * asking those modules to grow a second export. That also means these records go through
 * `register()`'s own duplicate-id, chord-conflict and placement checks on the way in, so this
 * function throws for the same reasons the app's bootstrap would.
 */
function viaRegistration(): AnyCommand[] {
  const registry = createCommandRegistry({ getContext: emptyContext });
  registerTabCommands(registry, { openFile: NO_OP, openFileInPane: NO_OP });
  registerSelectionCommands(registry, { convertToComponent: NO_OP, navigateToComponent: NO_OP });
  return [...registry.list()];
}

/**
 * Every command the app's registry holds, in bootstrap order.
 *
 * Order matches `studio.ts` so a reader comparing the two files can do it line by line.
 */
export function appCommandSet(): AnyCommand[] {
  return [
    // The panel roster is the one dependency the checks must supply for real: the ⌘1–8 records are
    // Generated from it, so an empty one would hide eight commands (and their chords) from the
    // Level check, the chrome budget and the generated keyboard sheet alike.
    ...defaultCommands({ ...noopCommandDeps(), panelRoster: panelFocusRoster() }),
    ...viaRegistration(),
    ...derivationCommands(noopDerivationDeps()),
    ...shellViewCommands({ inspectorTab: () => DEFAULT_INSPECTOR_TAB, setInspectorTab: NO_OP }),
    ...canvasViewCommands({ getCanvasMode: () => "design", setCanvasMode: NO_OP }),
    ...selectionCommands(),
    ...inspectorCommands(),
    // The element menu's eight verbs. Every one declares `menus: ["context/element", "palette"]`
    // And none reached the palette, because they were registered ONLY into the private registry
    // `editor/context-menu.ts` builds for its popover — a registry whose own docstring said it
    // Existed "until a bootstrap composes every contribution point into a single app-wide
    // Registry". This is that bootstrap; it has existed since P2.
    ...liveElementCommands(),
    ...dataExplorerCommands({ renderLeftPanel: NO_OP }),
    ...signalsCommands(),
    ...formulaEditorCommands(),
    ...gridCommands(),
    ...settingsCommands(),
    ...collabCommands(),
    ...preferencesCommands(),
    ...aboutCommands(),
    ...libraryCommands(),
    ...contentCommands(),
    ...sourceControlCommands(),
    ...publishCommands(),
    ...gridViewCommands(),
    ...redirectsCommands(),
    ...newProjectCommands(),
    ...styleCommands(),
  ];
}

/**
 * The name the three CI checks import by.
 *
 * Kept as an alias rather than renaming the scripts' contract: `commands/defaults.ts` exports the
 * same symbol, so pointing a check at either module is a `--source` flag, and a check written
 * before this file existed keeps working unchanged.
 */
export const defaultCommandSet = appCommandSet;
