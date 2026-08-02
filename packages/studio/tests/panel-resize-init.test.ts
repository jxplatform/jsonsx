import "./harness";
import { expect, test } from "bun:test";

// Covers the import-time fallback paths that the main panel-resize.test.ts (which imports with
// Valid saved state and the handles present) cannot reach in the same process: corrupt
// LocalStorage JSON, and missing resize-handle elements.
localStorage.setItem("jx-studio-panel-widths", "{not json");
document.body.innerHTML = "";

const { shell } = await import("../src/shell");
await import("../src/ui/panel-resize");

test("corrupt saved state is ignored and the docks stay at their defaults", () => {
  expect(shell.docks.left.width).toBe(240);
  expect(shell.docks.right.width).toBe(280);
  expect(shell.docks.chat.width).toBe(320);
  expect(shell.docks.left.collapsed).toBe(false);
  expect(shell.docks.right.collapsed).toBe(false);
  // The assistant column's default IS collapsed — corrupt storage leaves it there.
  expect(shell.docks.chat.collapsed).toBe(true);
});

test("missing handles leave the document inert (no listeners bound)", () => {
  expect(document.querySelector("#resize-left")).toBeNull();
  expect(document.querySelector("#resize-right")).toBeNull();
  expect(document.querySelector("#resize-chat")).toBeNull();
});
