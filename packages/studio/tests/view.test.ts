/** View state (C7): applyPanelCollapse DOM + localStorage behavior in src/view.ts. */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { applyPanelCollapse, onPanelCollapse, setLayoutSelection, view } from "../src/view";

const STORAGE_KEY = "jx-studio-panel-widths";

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.removeItem(STORAGE_KEY);
  view.leftPanelCollapsed = false;
  view.rightPanelCollapsed = false;
  view.chatPanelCollapsed = false;
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
    view.chatPanelCollapsed = true;

    applyPanelCollapse();

    expect(app.classList.contains("left-collapsed")).toBe(true);
    expect(app.classList.contains("right-collapsed")).toBe(false);
    expect(app.classList.contains("chat-collapsed")).toBe(true);

    view.chatPanelCollapsed = false;
    applyPanelCollapse();
    expect(app.classList.contains("chat-collapsed")).toBe(false);
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
    view.chatPanelCollapsed = true;

    applyPanelCollapse();

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.leftCollapsed).toBe(true);
    expect(saved.rightCollapsed).toBe(true);
    expect(saved.chatCollapsed).toBe(true);
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

  test("corrupt stored JSON is swallowed and replaced, classes still applied", () => {
    const app = mountApp();
    localStorage.setItem(STORAGE_KEY, "{not valid json");
    view.leftPanelCollapsed = true;

    expect(() => applyPanelCollapse()).not.toThrow();

    expect(app.classList.contains("left-collapsed")).toBe(true);
    // An unreadable record reads as empty and is written over, rather than pinning the panel
    // Layout to whatever corrupt string happens to be in storage forever.
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.leftCollapsed).toBe(true);
  });

  test("notifies subscribers, and unsubscribing stops that", () => {
    mountApp();
    const seen = mock(() => {});
    const off = onPanelCollapse(seen);

    applyPanelCollapse();
    expect(seen).toHaveBeenCalledTimes(1);
    applyPanelCollapse();
    expect(seen).toHaveBeenCalledTimes(2);

    off();
    applyPanelCollapse();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  test("does not notify when there is no #app to lay out", () => {
    const seen = mock(() => {});
    const off = onPanelCollapse(seen);
    applyPanelCollapse();
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});

describe("view defaults", () => {
  test("exposes expected initial UI state", () => {
    expect(view.leftTab).toBeString();
    expect(view.dndCleanups).toBeArray();
    expect(view.elementsCollapsed).toBeInstanceOf(Set);
  });
});

describe("setLayoutSelection", () => {
  test("adopts and releases the canvas layout-chrome selection", () => {
    // `view.layoutSelection` shipped with a reader (the properties panel's layout panel) and no
    // Writer anywhere, so clicking a header selected nothing. This is that writer.
    expect(view.layoutSelection).toBeNull();
    const hit = {
      className: "site-header",
      layoutFile: "layouts/base.json",
      layoutPath: ["children", 0],
      rect: { height: 40, width: 800, x: 0, y: 0 },
      tagName: "header",
    };
    setLayoutSelection(hit);
    expect(view.layoutSelection).toBe(hit);
    setLayoutSelection(null);
    expect(view.layoutSelection).toBeNull();
  });
});
