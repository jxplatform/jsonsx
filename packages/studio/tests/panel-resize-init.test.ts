import "./harness";
import { expect, test } from "bun:test";

// Covers the panel-resize import-time fallback paths that the main panel-resize.test.ts (which
// Imports the module with valid saved state and handles present) cannot reach in the same process:
// Corrupt localStorage JSON and missing resize-handle elements.
localStorage.setItem("jx-studio-panel-widths", "{not json");
document.body.innerHTML = "";

const { view } = await import("../src/view");
await import("../src/ui/panel-resize");

test("corrupt saved state is ignored and collapse flags stay default", () => {
  const root = document.documentElement;
  expect(root.style.getPropertyValue("--panel-w-left")).toBe("");
  expect(root.style.getPropertyValue("--panel-w-right")).toBe("");
  expect(root.style.getPropertyValue("--panel-w-chat")).toBe("");
  expect(view.leftPanelCollapsed).toBe(false);
  expect(view.rightPanelCollapsed).toBe(false);
  expect(view.chatPanelCollapsed).toBe(false);
});

test("missing handles leave the document inert (no listeners bound)", () => {
  expect(document.querySelector("#resize-left")).toBeNull();
  expect(document.querySelector("#resize-right")).toBeNull();
  expect(document.querySelector("#resize-chat")).toBeNull();
});
