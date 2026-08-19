/// <reference lib="dom" />
/**
 * Navigator-panels.ts — the Navigator's panel set, composed once.
 *
 * The counterpart to `commands/app-commands.ts`: every record is DEFINED beside the state it
 * writes, in the module that owns the surface, and this file is the ONE place that composes them.
 * Nothing here decides what a panel is called, what level it is, or what it draws — that would be
 * the second definition site the registry exists to prevent.
 *
 * **Registration order is rail order** within a level group: PROJECT (Files ⌘1 · Search ⌘2 · Source
 * Control ⌘3) above the divider, DOCUMENT (Outline ⌘4 · Page ⌘5 · Data ⌘6 · Packages ⌘7) below it.
 *
 * **Every rail button opens the Navigator.** Problems used to hold the fourth PROJECT slot while
 * its body was drawn in the Bottom dock, and paying for that took a per-dock branch in three
 * separate places. A permanent button that opens something somewhere else is also a standing
 * advertisement, in the shell's own furniture, for a place to find things wrong with the product.
 * The count reaches the user from the status bar the moment there is one.
 *
 * **Search is declared and hidden.** It is a surface a later phase builds (P3.3's palette index),
 * and it holds a rail slot §3.2 has already spent. A `when: () => false` record is the honest way
 * to say "this exists in the design and not yet in the app": the id is reserved, the budget already
 * counts it, and the day it ships the only edit is deleting one predicate — as opposed to a stub
 * button that lies to whoever clicks it.
 */

import { registerFilesPanel } from "../files/files";
import { registerDataPanel } from "./data-explorer";
import { registerInsertPanel } from "./elements-panel";
import { registerGitPanel } from "./git-panel";
import { registerI18nPanel } from "./i18n-panel";
import { registerPagePanel } from "./head-panel";
import { registerPackagesPanel } from "./imports-panel";
import { registerBottomPanels } from "./bottom-dock";
import { registerLayersPanel } from "./layers-panel";
import { getPanel, listPanels, railPanelSet, registerPanel, resetPanels } from "./panel-registry";
import type { PanelRecord } from "./panel-registry";

/** Surfaces the design has declared and the app has not built. Registered, hidden, budgeted. */
const NOT_YET_BUILT = () => false;

/**
 * Register every Navigator panel, in rail order. Idempotent — a second call is a no-op.
 *
 * Idempotence matters because `registerPanel` throws on a duplicate id: the Navigator mounts once
 * per window in the app, but a test suite mounts it per case.
 */
export function registerNavigatorPanels(): void {
  // Keyed on Files rather than on `listPanels("navigator")`, because the Bottom dock composes
  // Itself independently (`bottomPanelSet()` calls `registerBottomPanels()` directly) and either
  // Order has to leave this function still registering the Navigator's own eight.
  if (getPanel("files")) {
    return;
  }

  // ── PROJECT group ───────────────────────────────────────────────────────────
  registerFilesPanel();
  registerPanel({
    id: "search",
    title: "Search",
    level: "project",
    dock: "navigator",
    icon: "sp-icon-search",
    when: NOT_YET_BUILT,
    render: () => nothingYet(),
  });
  registerGitPanel();
  /* Off the rail, and registered in the PROJECT group anyway: registration order is roster order,
     so this is what puts Languages beside the panels it belongs with in the palette and in
     `panel.focus.*`. Its `when` is `project.isMultilingual` — a project written in one language
     never sees it. */
  registerI18nPanel();

  // ── DOCUMENT group ──────────────────────────────────────────────────────────
  registerLayersPanel();
  registerPagePanel();
  registerDataPanel();
  registerPackagesPanel();

  // ── Off-rail: reachable by command and palette, no rail button ──────────────
  registerInsertPanel();

  // ── The Bottom dock's tabs (§3.2 ⑪): Problems · Diff · Logic · Activity ──────
  // Composed here, in the one place panel records are gathered, so the shell has ONE composition
  // Site rather than one per dock. Importing the module is also what attaches the dock to the
  // Shell's mount lifecycle — see its `registerShellSurface` call. Problems arrives with them and
  // Still takes the rail's fourth PROJECT slot, because the rail groups by level, not by dock.
  registerBottomPanels();
}

/**
 * The body a declared-but-unbuilt panel would draw.
 *
 * Unreachable while `when` is false — it exists so the record is complete rather than carrying an
 * `undefined` render that would throw the first time someone deleted the predicate without reading
 * this file.
 */
function nothingYet(): never {
  throw new Error(
    "This Navigator panel is declared but not built — its `when` predicate should have hidden it.",
  );
}

/** Every panel the Navigator dock DRAWS, in registration order. */
export function navigatorPanelSet(): readonly PanelRecord[] {
  registerNavigatorPanels();
  return listPanels("navigator");
}

/**
 * The roster `panel.focus.*` is generated from: rail order first, then the rail-less Navigator
 * panels.
 *
 * Not `railPanelSet()`: Insert and State have no rail button and no chord, and they still need a
 * `Show …` command and a palette row, which is the whole point of `rail: false` (a surface
 * reachable by name, not by number).
 *
 * The Bottom dock's four tabs are deliberately absent — Problems as of this change, and Diff, Logic
 * and Activity all along. Each is `rail: false` AND hosted there, so each is addressed by
 * `view.setBottomTab`: one verb per surface, and the dock's own strip is how a human picks between
 * them. That is also why the filter here is by DOCK and not merely by `rail`, and why Problems
 * leaving the rail removed `panel.focus.problems` rather than demoting it to a chordless row.
 */
export function panelFocusRoster(): readonly PanelRecord[] {
  registerNavigatorPanels();
  return [...railPanelSet(), ...listPanels("navigator").filter((panel) => panel.rail === false)];
}

/** Drop every registration — tests only, so each case composes the set from scratch. */
export function resetNavigatorPanels(): void {
  resetPanels();
}
