/**
 * Boot-time panel defaults (src/view.ts).
 *
 * `restoreCollapseState()` runs at IMPORT time, so the storage state has to be staged before the
 * module loads — which is why this lives in its own file rather than in view.test.ts.
 *
 * This is the first-run shell: the ~300px assistant column starts closed, the side panels open.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";

localStorage.removeItem("jx-studio-panel-widths");

const { view } = await import("../src/view");

describe("view boot defaults (no persisted record)", () => {
  test("the assistant column starts closed and the side panels start open", () => {
    expect(view.chatPanelCollapsed).toBe(true);
    expect(view.leftPanelCollapsed).toBe(false);
    expect(view.rightPanelCollapsed).toBe(false);
  });
});
