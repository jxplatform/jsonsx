/// <reference lib="dom" />
/**
 * Navigator-panels.ts — the Navigator's panel set, composed once.
 *
 * The counterpart to `commands/app-commands.ts`: every record is DEFINED beside the state it
 * writes, in the module that owns the surface, and this file is the ONE place that composes them.
 * Nothing here decides what a panel is called, what level it is, or what it draws — that would be
 * the second definition site the registry exists to prevent.
 *
 * **Registration order is rail order** within a level group, so the rail reads as §3.2 ② lists it:
 * PROJECT (Files ⌘1 · Search ⌘2 · Source Control ⌘3 · Problems ⌘4) above the divider, DOCUMENT
 * (Outline ⌘5 · Page ⌘6 · Data ⌘7 · Packages ⌘8) below it. The fourth PROJECT button is Problems,
 * whose record is registered by `panels/bottom-dock.ts` because the Bottom dock is where its body
 * is drawn (§7.2) — the rail groups by LEVEL, not by dock, so it lands in its slot regardless.
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
import { registerPagePanel } from "./head-panel";
import { registerPackagesPanel } from "./imports-panel";
import { registerBottomPanels } from "./bottom-dock";
import { registerLayersPanel } from "./layers-panel";
import { registerStatePanel } from "./signals-panel";
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
  // Order has to leave this function still registering the Navigator's own nine.
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

  // ── DOCUMENT group ──────────────────────────────────────────────────────────
  registerLayersPanel();
  registerPagePanel();
  registerDataPanel();
  registerPackagesPanel();

  // ── Off-rail: reachable by command and palette, no rail button ──────────────
  registerInsertPanel();
  registerStatePanel();

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
 * Not `navigatorPanelSet()`, because the chords follow the RAIL and the rail now spans two docks —
 * ⌘4 is Problems, whose body is the Bottom dock's first tab. Not `railPanelSet()` either: Insert
 * and State have no rail button and no chord, and they still need a `Show …` command and a palette
 * row, which is the whole point of `rail: false` (a surface reachable by name, not by number).
 *
 * The Bottom dock's other three tabs are deliberately absent. Diff, Logic and Activity are `rail:
 * false` AND hosted there, so they are addressed by `view.setBottomTab` — one verb per surface, and
 * the dock's own strip is how a human picks between them.
 */
export function panelFocusRoster(): readonly PanelRecord[] {
  registerNavigatorPanels();
  return [...railPanelSet(), ...listPanels("navigator").filter((panel) => panel.rail === false)];
}

/** Drop every registration — tests only, so each case composes the set from scratch. */
export function resetNavigatorPanels(): void {
  resetPanels();
}
