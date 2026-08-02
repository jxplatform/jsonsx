/**
 * Boot-time panel restore (src/view.ts).
 *
 * Companion to view-boot-default.test.ts: `restoreCollapseState()` runs at IMPORT time, so the
 * persisted record is staged before the module loads.
 *
 * The load-bearing assertion is `chatCollapsed: false`. The assistant column defaults CLOSED, so a
 * restore written as `if (saved.x) { collapse() }` would silently pin it shut forever for anyone
 * who ever opened it — the adoption has to run in both directions.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";

localStorage.setItem(
  "jx-studio-panel-widths",
  JSON.stringify({ chatCollapsed: false, left: 240, leftCollapsed: true, rightCollapsed: true }),
);

const { view } = await import("../src/view");

describe("view boot restore (persisted record)", () => {
  test("adopts the persisted state in both directions", () => {
    // Remembered OPEN, against a closed default.
    expect(view.chatPanelCollapsed).toBe(false);
    // Remembered CLOSED, against open defaults.
    expect(view.leftPanelCollapsed).toBe(true);
    expect(view.rightPanelCollapsed).toBe(true);
  });
});
