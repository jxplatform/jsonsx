/**
 * The containment taxonomy and the level × placement matrix (UX-REDESIGN-PLAN §5.1).
 *
 * No DOM: `levels.ts` is pure data plus three predicates, and keeping it that way is what lets the
 * CI checks import it in a bare Bun process.
 */
import { describe, expect, test } from "bun:test";
import {
  CATEGORIES,
  checkPlacements,
  checkRecordPlacements,
  isLevel,
  isPlacement,
  KEY_SCOPES,
  LEVELS,
  PLACEMENT_MATRIX,
  PLACEMENTS,
  placementAdmits,
} from "../src/commands/levels";
import type { PlaceableRecord } from "../src/commands/levels";

describe("the vocabularies", () => {
  test("level and keyScope are separate axes", () => {
    // Plan §5.1: conflating them is how "position encodes scope" degrades into unenforced prose.
    // "caret" is a dispatch scope with no level, "application" a level with no dispatch meaning.
    expect(KEY_SCOPES).toContain("caret");
    expect(LEVELS).not.toContain("caret");
    expect(LEVELS).toContain("application");
    expect(KEY_SCOPES).not.toContain("application");
  });

  test("there is no fifth `range` level", () => {
    // Inline formatting is level "selection" + keyScope "caret". A fifth level would demand a
    // Fifth region and there is none (plan §13).
    expect([...LEVELS]).toEqual(["application", "project", "document", "selection"]);
  });

  test("every placement has a matrix row, and every row admits at least one level", () => {
    expect(Object.keys(PLACEMENT_MATRIX).toSorted()).toEqual([...PLACEMENTS].toSorted());
    for (const placement of PLACEMENTS) {
      const rule = PLACEMENT_MATRIX[placement];
      expect(rule.admits.length).toBeGreaterThan(0);
      expect(rule.note.length).toBeGreaterThan(0);
      for (const level of rule.admits) {
        expect(LEVELS).toContain(level);
      }
    }
  });

  test("the status bar is three single-level placements, not one mixed region", () => {
    expect(PLACEMENT_MATRIX["statusbar/project"].admits).toEqual(["project"]);
    expect(PLACEMENT_MATRIX["statusbar/document"].admits).toEqual(["document"]);
    expect(PLACEMENT_MATRIX["statusbar/selection"].admits).toEqual(["selection"]);
  });

  test("the categories are the twelve the palette groups by", () => {
    expect(CATEGORIES).toContain("Source Control");
    expect(CATEGORIES).toHaveLength(12);
  });
});

describe("guards", () => {
  test("isPlacement / isLevel accept only members", () => {
    expect(isPlacement("blockbar")).toBe(true);
    expect(isPlacement("context/canvas")).toBe(false);
    expect(isLevel("selection")).toBe(true);
    expect(isLevel("range")).toBe(false);
  });

  test("placementAdmits reads one cell of the matrix", () => {
    expect(placementAdmits("commandbar/primary", "document")).toBe(true);
    expect(placementAdmits("commandbar/primary", "selection")).toBe(false);
    expect(placementAdmits("palette", "selection")).toBe(true);
  });
});

describe("checkRecordPlacements", () => {
  const record = (over: Partial<PlaceableRecord>): PlaceableRecord => ({
    id: "test.command",
    level: "document",
    ...over,
  });

  test("a record with no menus is legal at every level", () => {
    for (const level of LEVELS) {
      expect(checkRecordPlacements(record({ level }))).toEqual([]);
    }
  });

  test("a legal placement passes", () => {
    expect(checkRecordPlacements(record({ level: "selection", menus: ["blockbar"] }))).toEqual([]);
  });

  test("a selection verb in the Command Bar is rejected, with the reason", () => {
    const [violation] = checkRecordPlacements(
      record({ id: "selection.duplicate", level: "selection", menus: ["commandbar/primary"] }),
    );
    expect(violation?.commandId).toBe("selection.duplicate");
    expect(violation?.placement).toBe("commandbar/primary");
    expect(violation?.message).toContain("admits only application, document");
    // The matrix note travels with the failure so the fix does not need the plan open.
    expect(violation?.message).toContain("by frequency");
  });

  test("an unknown placement is rejected by name", () => {
    const [violation] = checkRecordPlacements(record({ menus: ["context/canvas" as never] }));
    expect(violation?.message).toContain('unknown placement "context/canvas"');
  });

  test("an unknown level is rejected before its placements are read", () => {
    const violations = checkRecordPlacements(
      record({ level: "range" as never, menus: ["blockbar"] }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('unknown level "range"');
  });

  test("every declared placement is reported, not just the first", () => {
    const violations = checkRecordPlacements(
      record({ level: "project", menus: ["blockbar", "outline/row", "commandbar/overflow"] }),
    );
    expect(violations.map((v) => v.placement)).toEqual(["blockbar", "outline/row"]);
  });
});

describe("checkPlacements", () => {
  test("flattens across a whole set", () => {
    const violations = checkPlacements([
      { id: "a.one", level: "selection", menus: ["blockbar"] },
      { id: "b.two", level: "project", menus: ["blockbar"] },
      { id: "c.three", level: "document", menus: ["statusbar/selection"] },
    ]);
    expect(violations.map((v) => v.commandId)).toEqual(["b.two", "c.three"]);
  });

  test("an empty set is legal", () => {
    expect(checkPlacements([])).toEqual([]);
  });
});
