/**
 * Boot-time dock defaults (src/shell.ts).
 *
 * The record is built at IMPORT time, so the storage state has to be staged before the module loads
 * — which is why this lives in its own file rather than in shell.test.ts.
 *
 * This is the first-run shell: both docks open, and only two of them. The assistant no longer has a
 * dock to default anywhere — it is the Inspector's fourth tab.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";

localStorage.removeItem("jx-studio-panel-widths");

const { DEFAULT_INSPECTOR_TAB, shell } = await import("../src/shell");

describe("shell boot defaults (no persisted record)", () => {
  test("both side docks start open and the bottom one starts closed", () => {
    expect(shell.docks.left.collapsed).toBe(false);
    expect(shell.docks.right.collapsed).toBe(false);
    // The Bottom dock is the one that does NOT open itself: an empty Problems list and an empty
    // Activity log would spend 220px of the canvas to say nothing has gone wrong.
    expect(shell.docks.bottom.collapsed).toBe(true);
    expect(Object.keys(shell.docks).toSorted()).toEqual(["bottom", "left", "right"]);
  });

  test("widths fall back to the declared defaults", () => {
    expect(shell.docks.left.size).toBe(240);
    expect(shell.docks.right.size).toBe(280);
  });

  test("the Inspector wakes up on Content, not on the assistant", () => {
    // The assistant costs zero width as a tab, but it is still not what an editor should open on.
    expect(DEFAULT_INSPECTOR_TAB).toBe("properties");
  });
});
