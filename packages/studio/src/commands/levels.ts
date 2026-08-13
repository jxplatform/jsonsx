/**
 * Levels.ts — the containment taxonomy and the level × placement matrix.
 *
 * Two vocabularies live here, and keeping them apart is the whole point (UX-REDESIGN-PLAN §5.1):
 *
 * - {@link Level} answers WHAT a record acts on. It governs placement and is CI-checked.
 * - {@link KeyScope} answers WHERE a chord is live. It governs keyboard dispatch only.
 *
 * Conflating them is how "position encodes scope" degrades into unenforced prose. The clearest case
 * is inline text formatting: Bold acts on a text range inside the selected node, so its `level` is
 * `selection`, while its `keyScope` is `caret` — which is what makes the chord live only when a
 * caret exists. There is deliberately no `range` level; a fifth level would demand a fifth region
 * and there is none.
 *
 * {@link PLACEMENT_MATRIX} is the normative table: each placement declares the set of levels it
 * admits. Mixed regions are mixed IN THE TABLE, never by prose exemption — the status bar is three
 * separate single-level placements, not one "mixed" one. `scripts/check-command-levels.ts`
 * validates every registered command's `menus` against this table, and `createCommandRegistry`
 * applies the same check at registration so a violation cannot reach a running app either.
 *
 * Panel placements (the two rail groups, the navigator dock body, the bottom dock, the inspector
 * dock) are part of the same matrix in `studio-ui-guidelines.md` §12 and live here too, in
 * {@link PANEL_PLACEMENT_MATRIX}: `registerPanel()` (`panels/panel-registry.ts`) now exists, so a
 * Panel record declares a `level` for the same reason a Command does and is checked the same way.
 * The two tables are separate because their placement VOCABULARIES are disjoint — a command is
 * never "in the rail's upper group", and a panel is never "in the block action bar".
 */

/** Containment level — WHAT a record acts on. Governs placement. CI-checked. */
export const LEVELS = ["application", "project", "document", "selection"] as const;

export type Level = (typeof LEVELS)[number];

/** Keyboard dispatch scope — WHERE a chord is live. Orthogonal to {@link Level}. */
export const KEY_SCOPES = ["global", "canvas", "caret", "grid", "code", "dock", "palette"] as const;

export type KeyScope = (typeof KEY_SCOPES)[number];

/** Command categories. The palette renders rows as "<Category>: <title>". */
export const CATEGORIES = [
  "File",
  "Edit",
  "Selection",
  "Insert",
  "View",
  "Document",
  "Project",
  "Source Control",
  "Publish",
  "Assistant",
  "Collaborate",
  "Help",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Every surface a command may declare itself into. `"never"` means keyboard/API only. */
export const PLACEMENTS = [
  "commandbar/primary",
  "commandbar/overflow",
  "statusbar/project",
  "statusbar/document",
  "statusbar/selection",
  "context/element",
  "context/file",
  "context/layer",
  "context/tab",
  "context/pane",
  "blockbar",
  /**
   * The block action bar's SECOND cluster — inline formatting, shown while the caret is in text.
   *
   * A separate placement rather than a crowd inside `blockbar`, for the reason the status bar is
   * three placements and not one "mixed" region: the bar's verb cluster is capped at five, and
   * eight format verbs sharing that cap would push Bold into a `⋮` menu. Same level, same surface,
   * different budget — which is a row in the table, not an exemption in prose.
   */
  "blockbar/format",
  "outline/row",
  "palette",
  "never",
] as const;

export type Placement = (typeof PLACEMENTS)[number];

/** One row of the matrix: the levels a placement admits, plus why it is drawn that way. */
export interface PlacementRule {
  /** Levels this placement accepts. A command declaring any other level is a CI failure. */
  admits: readonly Level[];
  /** The reason, printed in the violation message so the fix is obvious from the failure. */
  note: string;
}

/**
 * The level × placement matrix — normative copy, mirrored into `studio-ui-guidelines.md` §12.
 *
 * Read a row as: "this region renders records of these levels, and nothing else."
 */
export const PLACEMENT_MATRIX: Readonly<Record<Placement, PlacementRule>> = {
  "commandbar/primary": {
    admits: ["application", "document"],
    note: "document only for Save / Undo / Redo / Open in Browser, by frequency; ≤5 total",
  },
  "commandbar/overflow": {
    admits: ["application", "project", "document"],
    note: "never selection — the Command Bar is not a selection surface",
  },
  "statusbar/project": { admits: ["project"], note: "the status bar's left field" },
  "statusbar/document": { admits: ["document"], note: "the status bar's centre field" },
  "statusbar/selection": { admits: ["selection"], note: "the status bar's right field" },
  "context/element": { admits: ["selection"], note: "the canvas element menu acts on a selection" },
  "context/file": { admits: ["project"], note: "a file row addresses the project's file set" },
  "context/layer": { admits: ["selection"], note: "an outline row IS a selection" },
  "context/tab": { admits: ["document"], note: "a tab addresses one document" },
  "context/pane": { admits: ["document"], note: "a pane hosts one document" },
  blockbar: { admits: ["selection"], note: "the floating bar owns selection-scoped verbs" },
  "blockbar/format": {
    admits: ["selection"],
    note: "the bar's inline-format cluster — a range inside the selection is still the selection",
  },
  "outline/row": { admits: ["selection"], note: "row actions act on the row's node" },
  palette: {
    admits: ["application", "project", "document", "selection"],
    note: "the level-agnostic surface; it groups rows by level",
  },
  never: {
    admits: ["application", "project", "document", "selection"],
    note: "keyboard- and API-only; no rendered surface to be misplaced in",
  },
};

// ─── Panels ───────────────────────────────────────────────────────────────────

/**
 * Every surface a Panel record may occupy.
 *
 * The rail's two level groups are SEPARATE placements, not one "mixed" region — principle 2's whole
 * point. `navigator` is the dock body below them, which hosts whichever panel the rail selected and
 * prints that panel's level in its header, so it is the one panel placement admitting two levels.
 */
export const PANEL_PLACEMENTS = [
  "rail/project",
  "rail/document",
  "navigator",
  "inspector",
  "dock.bottom",
] as const;

export type PanelPlacement = (typeof PANEL_PLACEMENTS)[number];

/**
 * The level × placement matrix for Panel records — normative copy, mirrored into
 * `studio-ui-guidelines.md` §12 beside {@link PLACEMENT_MATRIX}.
 *
 * The rail rows are what stop it re-accreting: a panel cannot be filed in the PROJECT group because
 * "it feels project-ish", only because the state it WRITES is the project's (principle 3).
 */
export const PANEL_PLACEMENT_MATRIX: Readonly<Record<PanelPlacement, PlacementRule>> = {
  "rail/project": {
    admits: ["project"],
    note: "the rail's upper group — Files, Search, Source Control, Problems",
  },
  "rail/document": {
    admits: ["document"],
    note: "the rail's lower group — Outline, Page, Data, Packages",
  },
  navigator: {
    admits: ["project", "document"],
    note: "whichever level the hosted panel declares; the panel header prints it",
  },
  inspector: { admits: ["selection"], note: "the Inspector's tabs are selection surfaces" },
  "dock.bottom": { admits: ["project", "document"], note: "the panel header states which" },
};

/** The subset of a Panel record this check reads. */
export interface PlaceablePanel {
  id: string;
  level: Level;
  /** The dock hosting the panel's body. */
  dock: "navigator" | "inspector" | "bottom";
  /** `false` for a panel with no rail button — it declares no rail-group placement. */
  rail?: boolean | undefined;
}

/** One rejected (panel, placement) pair. Shaped like {@link PlacementViolation}, keyed by panel. */
export interface PanelPlacementViolation {
  panelId: string;
  placement: string;
  level: string;
  message: string;
}

/** The dock body placement a panel's `dock` names. */
function dockPlacement(dock: PlaceablePanel["dock"]): PanelPlacement {
  return dock === "bottom" ? "dock.bottom" : dock;
}

/**
 * Every placement a Panel record occupies: its dock body, plus its rail group when it has a button.
 *
 * The rail group is DERIVED from the level rather than declared, which is what makes "grouped by
 * level with a divider" (§3.2 ②) a property of the data instead of an ordering convention in the
 * rail's template. A rail panel whose level has no group (`application`, `selection`) therefore
 * names a placement the matrix does not contain, and is rejected below.
 */
export function panelPlacements(panel: PlaceablePanel): string[] {
  const placements: string[] = [dockPlacement(panel.dock)];
  if (panel.rail !== false) {
    placements.push(`rail/${panel.level}`);
  }
  return placements;
}

/** Whether `value` is one of the {@link PANEL_PLACEMENTS}. */
export function isPanelPlacement(value: string): value is PanelPlacement {
  return (PANEL_PLACEMENTS as readonly string[]).includes(value);
}

/** Check one Panel record against {@link PANEL_PLACEMENT_MATRIX}. */
export function checkPanelPlacement(panel: PlaceablePanel): PanelPlacementViolation[] {
  const violations: PanelPlacementViolation[] = [];
  if (!isLevel(panel.level)) {
    violations.push({
      panelId: panel.id,
      placement: "—",
      level: String(panel.level),
      message:
        `declares unknown level "${String(panel.level)}" ` +
        `(expected one of: ${LEVELS.join(", ")})`,
    });
    return violations;
  }
  for (const placement of panelPlacements(panel)) {
    if (!isPanelPlacement(placement)) {
      violations.push({
        panelId: panel.id,
        placement,
        level: panel.level,
        message:
          `is level "${panel.level}" and would render in "${placement}", which is not a panel ` +
          `placement — the rail has a group for project and one for document, and nothing else`,
      });
      continue;
    }
    const rule = PANEL_PLACEMENT_MATRIX[placement];
    if (!rule.admits.includes(panel.level)) {
      violations.push({
        panelId: panel.id,
        placement,
        level: panel.level,
        message:
          `is level "${panel.level}" but "${placement}" admits only ` +
          `${rule.admits.join(", ")} — ${rule.note}`,
      });
    }
  }
  return violations;
}

/** Check a whole panel set. Empty result = the set satisfies the matrix. */
export function checkPanelPlacements(panels: readonly PlaceablePanel[]): PanelPlacementViolation[] {
  return panels.flatMap((panel) => checkPanelPlacement(panel));
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** The subset of a command record the placement check needs. */
export interface PlaceableRecord {
  id: string;
  level: Level;
  menus?: readonly Placement[] | undefined;
}

/** One rejected (command, placement) pair. */
export interface PlacementViolation {
  commandId: string;
  placement: string;
  level: string;
  /** Ready-to-print explanation: what was declared, what the row admits, and why. */
  message: string;
}

/** Whether `placement` is one of the {@link PLACEMENTS}. */
export function isPlacement(value: string): value is Placement {
  return (PLACEMENTS as readonly string[]).includes(value);
}

/** Whether `level` is one of the {@link LEVELS}. */
export function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}

/** Whether the matrix lets a `level` record render in `placement`. */
export function placementAdmits(placement: Placement, level: Level): boolean {
  return PLACEMENT_MATRIX[placement].admits.includes(level);
}

/**
 * Check one record's declared placements against the matrix.
 *
 * A record with no `menus` defaults to `["palette"]`, which admits every level, so the default is
 * always legal — a command has to opt IN to a region before it can be misplaced.
 */
export function checkRecordPlacements(record: PlaceableRecord): PlacementViolation[] {
  const violations: PlacementViolation[] = [];
  if (!isLevel(record.level)) {
    violations.push({
      commandId: record.id,
      placement: "—",
      level: String(record.level),
      message:
        `declares unknown level "${String(record.level)}" ` +
        `(expected one of: ${LEVELS.join(", ")})`,
    });
    return violations;
  }
  for (const placement of record.menus ?? []) {
    if (!isPlacement(placement)) {
      violations.push({
        commandId: record.id,
        placement: String(placement),
        level: record.level,
        message: `declares unknown placement "${String(placement)}"`,
      });
      continue;
    }
    const rule = PLACEMENT_MATRIX[placement];
    if (!rule.admits.includes(record.level)) {
      violations.push({
        commandId: record.id,
        placement,
        level: record.level,
        message:
          `is level "${record.level}" but "${placement}" admits only ` +
          `${rule.admits.join(", ")} — ${rule.note}`,
      });
    }
  }
  return violations;
}

/** Check a whole command set. Empty result = the set satisfies the matrix. */
export function checkPlacements(records: readonly PlaceableRecord[]): PlacementViolation[] {
  return records.flatMap((record) => checkRecordPlacements(record));
}
