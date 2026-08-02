/** The chrome budget (UX-REDESIGN-PLAN §2, principle 9): five primary commands, four tabs per dock. */
import { describe, expect, test } from "bun:test";
import {
  checkChromeBudget,
  CHROME_BUDGET,
  DOCK_TABS,
  primaryCommandIds,
} from "../src/commands/budget";
import type { BudgetableRecord } from "../src/commands/budget";

const primaries = (count: number): BudgetableRecord[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: `file.verb${index}`,
    menus: ["commandbar/primary", "palette"],
  }));

describe("primaryCommandIds", () => {
  test("counts only the primary cluster", () => {
    expect(
      primaryCommandIds([
        { id: "file.save", menus: ["commandbar/primary"] },
        { id: "view.zen", menus: ["commandbar/overflow"] },
        { id: "a.one" },
      ]),
    ).toEqual(["file.save"]);
  });
});

describe("checkChromeBudget", () => {
  test("the declared shell is inside both caps", () => {
    expect(checkChromeBudget({ commands: [] })).toEqual([]);
    for (const dock of DOCK_TABS) {
      expect(dock.tabs.length).toBeLessThanOrEqual(CHROME_BUDGET.dockTabs);
    }
  });

  test("exactly at the cap passes; one over fails", () => {
    expect(checkChromeBudget({ commands: primaries(CHROME_BUDGET.commandbarPrimary) })).toEqual([]);
    const violations = checkChromeBudget({
      commands: primaries(CHROME_BUDGET.commandbarPrimary + 1),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.subject).toBe("commandbar/primary");
    expect(violations[0]?.count).toBe(6);
    expect(violations[0]?.limit).toBe(5);
    // The failure names the offenders and the escape hatch, so the fix is not a guess.
    expect(violations[0]?.message).toContain("file.verb0");
    expect(violations[0]?.message).toContain("commandbar/overflow");
  });

  test("a five-tab dock fails, naming its tabs", () => {
    const violations = checkChromeBudget({
      commands: [],
      docks: [{ dock: "bottom", tabs: ["Problems", "Diff", "Logic", "Activity", "Deploy"] }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.subject).toBe("bottom");
    expect(violations[0]?.message).toContain("Deploy");
  });

  test("both caps are reported together — one run, every violation", () => {
    const violations = checkChromeBudget({
      commands: primaries(7),
      docks: [
        { dock: "inspector", tabs: ["Content", "Style", "Logic", "Assistant"] },
        { dock: "bottom", tabs: ["a", "b", "c", "d", "e"] },
      ],
    });
    expect(violations.map((v) => v.subject)).toEqual(["commandbar/primary", "bottom"]);
  });

  test("an explicitly empty dock list checks the commands only", () => {
    expect(checkChromeBudget({ commands: [], docks: [] })).toEqual([]);
  });
});
