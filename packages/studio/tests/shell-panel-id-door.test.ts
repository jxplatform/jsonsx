/**
 * The lock on the door `NAVIGATOR_PANEL_IDS` describes (src/shell.ts).
 *
 * `shell.leftTab` is a `string` because it is also read back from state an older build persisted,
 * and {@link migratePanelId} is what translates one of those. What had no answer was the WRITE
 * path: `setActivityTab` took a `string`, so the Outline's empty state could call it with
 * `"blocks"` — a panel renamed to `insert` in P3.1 — and the Navigator would land on
 * `unknownPanel`'s dead body reading "No Navigator panel is registered as blocks". Three phases,
 * 8,311 passing tests, six green gates, and a control whose one job was to open a panel.
 *
 * The fix is a type: `setActivityTab(tab: NavigatorPanelId)`. That leaves exactly one gap the type
 * cannot close — an id arriving from `PanelRecord.id`, which is deliberately a `string` because the
 * same registry hosts the Bottom dock's panels — and {@link requireNavigatorPanelId} is the single
 * lock both of those callers (the rail's buttons, ⌘1–8's dispatcher) share.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";

const { isNavigatorPanelId, NAVIGATOR_PANEL_IDS, requireNavigatorPanelId } =
  await import("../src/shell");

describe("requireNavigatorPanelId", () => {
  test("every declared id passes through unchanged", () => {
    for (const id of NAVIGATOR_PANEL_IDS) {
      expect(requireNavigatorPanelId(id, "test")).toBe(id);
    }
  });

  test("a renamed id is refused, loudly, naming the caller", () => {
    // `blocks` is the exact id the Outline shipped with. A silent return would have reproduced the
    // Defect in a new spelling: the point is that the control fails where it is wrong, not where
    // It is used.
    expect(() => requireNavigatorPanelId("blocks", "the Navigator rail")).toThrow(
      /the Navigator rail: "blocks" is not a declared Navigator panel id/,
    );
  });

  test("a Bottom dock id is refused too — the docks do not share an id space", () => {
    // `problems` is a real panel and a real tab; it is not a NAVIGATOR panel, and
    // `view.setBottomTab` is its door. Accepting it here is how a rail button comes to open
    // Something at the bottom of the window.
    expect(isNavigatorPanelId("problems")).toBe(false);
    expect(() => requireNavigatorPanelId("problems", "panel.focus")).toThrow(/panel\.focus/);
  });
});
