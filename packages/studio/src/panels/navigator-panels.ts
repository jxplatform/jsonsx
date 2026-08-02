/// <reference lib="dom" />
/**
 * Navigator-panels.ts — the Navigator's panel set, composed once.
 *
 * The counterpart to `commands/app-commands.ts`: every record is DEFINED beside the state it
 * writes, in the module that owns the surface, and this file is the ONE place that composes them.
 * Nothing here decides what a panel is called, what level it is, or what it draws — that would be
 * the second definition site the registry exists to prevent.
 *
 * **Registration order is rail order**, so the two groups read exactly as §3.2 ② lists them:
 * PROJECT (Files ⌘1 · Search ⌘2 · Source Control ⌘3 · Problems ⌘4) above the divider, DOCUMENT
 * (Outline ⌘5 · Page ⌘6 · Data ⌘7 · Packages ⌘8) below it.
 *
 * **Search and Problems are declared and hidden.** Both are surfaces later phases build (P3.3's
 * palette index and P4.2's Problems dock), and both hold a rail slot §3.2 has already spent. A
 * `when: () => false` record is the honest way to say "this exists in the design and not yet in the
 * app": the id is reserved, the budget already counts it, and the day it ships the only edit is
 * deleting one predicate — as opposed to a stub button that lies to whoever clicks it.
 */

import { registerFilesPanel } from "../files/files";
import { registerDataPanel } from "./data-explorer";
import { registerInsertPanel } from "./elements-panel";
import { registerGitPanel } from "./git-panel";
import { registerPagePanel } from "./head-panel";
import { registerPackagesPanel } from "./imports-panel";
import { registerLayersPanel } from "./layers-panel";
import { registerStatePanel } from "./signals-panel";
import { listPanels, registerPanel, resetPanels } from "./panel-registry";
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
  if (listPanels("navigator").length > 0) {
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
  registerPanel({
    id: "problems",
    title: "Problems",
    level: "project",
    dock: "navigator",
    icon: "sp-icon-alert",
    when: NOT_YET_BUILT,
    render: () => nothingYet(),
  });

  // ── DOCUMENT group ──────────────────────────────────────────────────────────
  registerLayersPanel();
  registerPagePanel();
  registerDataPanel();
  registerPackagesPanel();

  // ── Off-rail: reachable by command and palette, no rail button ──────────────
  registerInsertPanel();
  registerStatePanel();
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

/** Every Navigator panel record, in rail order. */
export function navigatorPanelSet(): readonly PanelRecord[] {
  registerNavigatorPanels();
  return listPanels("navigator");
}

/** Drop every registration — tests only, so each case composes the set from scratch. */
export function resetNavigatorPanels(): void {
  resetPanels();
}
