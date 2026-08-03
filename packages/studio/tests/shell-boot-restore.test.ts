/**
 * Boot-time dock restore (src/shell.ts).
 *
 * Companion to shell-boot-default.test.ts: the record is built at IMPORT time, so the persisted
 * state is staged before the module loads.
 *
 * The record staged here deliberately still carries `chat`/`chatCollapsed`, because that is what a
 * build before the assistant became a tab wrote — the restore has to ignore them rather than
 * resurrect a third dock.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";

localStorage.setItem(
  "jx-studio-panel-widths",
  JSON.stringify({
    chat: 420,
    chatCollapsed: false,
    left: 300,
    leftCollapsed: true,
    right: 0,
    rightCollapsed: false,
  }),
);

const { shell } = await import("../src/shell");

describe("shell boot restore (persisted record)", () => {
  test("adopts the persisted collapse state in both directions", () => {
    // Remembered CLOSED, against an open default.
    expect(shell.docks.left.collapsed).toBe(true);
    // Remembered OPEN, which must also be adopted — a restore written as
    // `if (saved.x) { collapse() }` only ever moves one way.
    expect(shell.docks.right.collapsed).toBe(false);
  });

  test("adopts persisted widths, rejecting a non-positive one", () => {
    expect(shell.docks.left.width).toBe(300);
    // A zero width would collapse the column with no way back; the default wins.
    expect(shell.docks.right.width).toBe(280);
  });

  test("a stale chat dock in storage does not come back", () => {
    expect(Object.keys(shell.docks).toSorted()).toEqual(["left", "right"]);
  });
});
