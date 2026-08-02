/**
 * Boot-time dock restore (src/shell.ts).
 *
 * Companion to shell-boot-default.test.ts: the record is built at IMPORT time, so the persisted
 * state is staged before the module loads.
 *
 * The load-bearing assertion is `chatCollapsed: false`. The assistant column defaults CLOSED, so a
 * restore written as `if (saved.x) { collapse() }` would silently pin it shut forever for anyone
 * who ever opened it — the adoption has to run in both directions.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";

localStorage.setItem(
  "jx-studio-panel-widths",
  JSON.stringify({
    chatCollapsed: false,
    left: 300,
    leftCollapsed: true,
    right: 0,
    rightCollapsed: true,
  }),
);

const { shell } = await import("../src/shell");

describe("shell boot restore (persisted record)", () => {
  test("adopts the persisted collapse state in both directions", () => {
    // Remembered OPEN, against a closed default.
    expect(shell.docks.chat.collapsed).toBe(false);
    // Remembered CLOSED, against open defaults.
    expect(shell.docks.left.collapsed).toBe(true);
    expect(shell.docks.right.collapsed).toBe(true);
  });

  test("adopts persisted widths, rejecting a non-positive one", () => {
    expect(shell.docks.left.width).toBe(300);
    // A zero width would collapse the column with no way back; the default wins.
    expect(shell.docks.right.width).toBe(280);
    expect(shell.docks.chat.width).toBe(320);
  });
});
