/** View state (C7): applyPanelCollapse DOM + localStorage behavior in src/view.ts. */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyPanelCollapse, view } from "../src/view";

const STORAGE_KEY = "jx-studio-panel-widths";

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.removeItem(STORAGE_KEY);
  view.leftPanelCollapsed = false;
  view.rightPanelCollapsed = false;
});

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

function mountApp(): HTMLElement {
  const app = document.createElement("div");
  app.id = "app";
  document.body.append(app);
  return app;
}

describe("applyPanelCollapse", () => {
  test("returns silently when #app does not exist", () => {
    expect(document.querySelector("#app")).toBeNull();
    expect(() => applyPanelCollapse()).not.toThrow();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("toggles collapse classes from view state", () => {
    const app = mountApp();
    view.leftPanelCollapsed = true;
    view.rightPanelCollapsed = false;

    applyPanelCollapse();

    expect(app.classList.contains("left-collapsed")).toBe(true);
    expect(app.classList.contains("right-collapsed")).toBe(false);
  });

  test("removes classes when panels are expanded again", () => {
    const app = mountApp();
    view.leftPanelCollapsed = true;
    view.rightPanelCollapsed = true;
    applyPanelCollapse();
    expect(app.classList.contains("left-collapsed")).toBe(true);
    expect(app.classList.contains("right-collapsed")).toBe(true);

    view.leftPanelCollapsed = false;
    view.rightPanelCollapsed = false;
    applyPanelCollapse();

    expect(app.classList.contains("left-collapsed")).toBe(false);
    expect(app.classList.contains("right-collapsed")).toBe(false);
  });

  test("persists collapse flags to localStorage", () => {
    mountApp();
    view.leftPanelCollapsed = true;
    view.rightPanelCollapsed = true;

    applyPanelCollapse();

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.leftCollapsed).toBe(true);
    expect(saved.rightCollapsed).toBe(true);
  });

  test("merges with existing saved panel widths", () => {
    mountApp();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ leftWidth: 250 }));
    view.leftPanelCollapsed = false;
    view.rightPanelCollapsed = true;

    applyPanelCollapse();

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.leftWidth).toBe(250);
    expect(saved.leftCollapsed).toBe(false);
    expect(saved.rightCollapsed).toBe(true);
  });

  test("corrupt stored JSON is swallowed; classes still applied", () => {
    const app = mountApp();
    localStorage.setItem(STORAGE_KEY, "{not valid json");
    view.leftPanelCollapsed = true;

    expect(() => applyPanelCollapse()).not.toThrow();

    expect(app.classList.contains("left-collapsed")).toBe(true);
    // The save was aborted by the parse error, leaving the corrupt value in place.
    expect(localStorage.getItem(STORAGE_KEY)).toBe("{not valid json");
  });
});

describe("view defaults", () => {
  test("exposes expected initial UI state", () => {
    expect(view.leftTab).toBeString();
    expect(view.dndCleanups).toBeArray();
    expect(view.elementsCollapsed).toBeInstanceOf(Set);
    expect(view.stylebookElToTag).toBeInstanceOf(WeakMap);
  });
});
