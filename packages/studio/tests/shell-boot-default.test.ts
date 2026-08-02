/**
 * Boot-time dock defaults (src/shell.ts).
 *
 * The record is built at IMPORT time, so the storage state has to be staged before the module loads
 * — which is why this lives in its own file rather than in shell.test.ts.
 *
 * This is the first-run shell: the ~300px assistant column starts closed, the side docks open.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";

localStorage.removeItem("jx-studio-panel-widths");

const { shell } = await import("../src/shell");

describe("shell boot defaults (no persisted record)", () => {
  test("the assistant column starts closed and the side docks start open", () => {
    expect(shell.docks.chat.collapsed).toBe(true);
    expect(shell.docks.left.collapsed).toBe(false);
    expect(shell.docks.right.collapsed).toBe(false);
  });

  test("widths fall back to the declared defaults", () => {
    expect(shell.docks.left.width).toBe(240);
    expect(shell.docks.right.width).toBe(280);
    expect(shell.docks.chat.width).toBe(320);
  });
});
