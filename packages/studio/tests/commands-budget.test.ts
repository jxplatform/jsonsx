/** The chrome budget (UX-REDESIGN-PLAN §2, principle 9): five primary commands, four tabs per dock. */
import { describe, expect, test } from "bun:test";
import {
  checkChromeBudget,
  CHROME_BUDGET,
  DECLARED_DOCK_TABS,
  dockTabs,
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
    for (const dock of DECLARED_DOCK_TABS) {
      expect(dock.tabs.length).toBeLessThanOrEqual(CHROME_BUDGET.dockTabs);
    }
  });

  test("a ninth inline-format verb is a design decision, not an append", () => {
    /* The bar's verb cluster and its format cluster are two placements over one surface, with two
       caps, because eight format verbs sharing the cluster's cap of five would have pushed Bold
       behind a `⋮`. The vocabulary is `data/elements-meta.json`'s eight; a ninth has to be argued
       for HERE, in `commands/budget.ts`, the way every other cap is. */
    const formats = (count: number): BudgetableRecord[] =>
      Array.from({ length: count }, (_unused, index) => ({
        id: `format.verb${index}`,
        menus: ["blockbar/format", "palette"],
      }));
    expect(checkChromeBudget({ commands: formats(CHROME_BUDGET.blockbarFormat) })).toEqual([]);
    const over = checkChromeBudget({ commands: formats(CHROME_BUDGET.blockbarFormat + 1) });
    expect(over).toHaveLength(1);
    expect(over[0]?.subject).toBe("blockbar/format");
    expect(over[0]?.count).toBe(CHROME_BUDGET.blockbarFormat + 1);
    expect(over[0]?.message).toContain("the palette");
  });

  test("the Inspector's row is the tab list itself, not a copy of it", () => {
    // Wave A wrote the four tab titles out by hand. They now come from `commands/defaults.ts`'s
    // `INSPECTOR_TABS` — the list the dock renders and ⌘⇧1–4 address — so a fifth tab fails this
    // Check in the commit that adds it.
    const inspector = DECLARED_DOCK_TABS.find((dock) => dock.dock === "inspector");
    expect(inspector?.tabs).toEqual(["Content", "Style", "Logic", "Assistant"]);
  });

  test("dockTabs joins the observed rail groups onto the declared docks", () => {
    // The rails arrive as an argument, because `budget.ts` must stay loadable in a bare Bun
    // Process and `panel-registry.ts` reaches the DOM. `check-chrome-budget.ts` is the one joiner.
    expect(dockTabs().map((dock) => dock.dock)).toEqual(["inspector", "bottom"]);
    expect(dockTabs([{ dock: "rail/project", tabs: ["Files"] }]).map((dock) => dock.dock)).toEqual([
      "inspector",
      "bottom",
      "rail/project",
    ]);
  });

  test("an over-budget rail group fails through the same door", () => {
    const violations = checkChromeBudget({
      commands: [],
      docks: dockTabs([{ dock: "rail/project", tabs: ["A", "B", "C", "D", "E"] }]),
    });
    expect(violations.map((violation) => violation.subject)).toEqual(["rail/project"]);
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
