/**
 * The reactive shell record (src/shell.ts) — dock state, the Navigator tab, the layout selection,
 * and the project-level state hoisted out of `TabUi`.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { effect, effectScope } from "../src/reactivity";
import {
  DOCK_DEFAULT_WIDTHS,
  applyDockLayout,
  mountShell,
  persistDocks,
  resetProjectShell,
  setActivityTab,
  setDockCollapsed,
  setDockWidth,
  setLayoutSelection,
  shell,
  toggleActivityTab,
  toggleDock,
  unmountShell,
} from "../src/shell";

const STORAGE_KEY = "jx-studio-panel-widths";

function mountApp(): HTMLElement {
  const app = document.createElement("div");
  app.id = "app";
  document.body.append(app);
  return app;
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.removeItem(STORAGE_KEY);
  unmountShell();
  shell.leftTab = "layers";
  shell.docks.left = { collapsed: false, width: DOCK_DEFAULT_WIDTHS.left };
  shell.docks.right = { collapsed: false, width: DOCK_DEFAULT_WIDTHS.right };
  shell.docks.chat = { collapsed: true, width: DOCK_DEFAULT_WIDTHS.chat };
  resetProjectShell();
});

afterEach(() => {
  unmountShell();
  localStorage.removeItem(STORAGE_KEY);
});

describe("applyDockLayout", () => {
  test("writes widths as CSS custom properties and collapse flags as #app classes", () => {
    const app = mountApp();
    shell.docks.left.collapsed = true;
    shell.docks.chat.collapsed = true;
    shell.docks.right.width = 333;

    applyDockLayout();

    expect(document.documentElement.style.getPropertyValue("--panel-w-right")).toBe("333px");
    expect(app.classList.contains("left-collapsed")).toBe(true);
    expect(app.classList.contains("right-collapsed")).toBe(false);
    expect(app.classList.contains("chat-collapsed")).toBe(true);
  });

  test("widths still apply when there is no #app to classify", () => {
    expect(document.querySelector("#app")).toBeNull();
    shell.docks.left.width = 199;
    expect(() => applyDockLayout()).not.toThrow();
    expect(document.documentElement.style.getPropertyValue("--panel-w-left")).toBe("199px");
  });
});

describe("mountShell", () => {
  test("a dock flip repositions the grid with no explicit repaint call", () => {
    const app = mountApp();
    mountShell();
    expect(app.classList.contains("right-collapsed")).toBe(false);

    // This is the whole point of the split: one state write, no render() beside it.
    toggleDock("right");

    expect(app.classList.contains("right-collapsed")).toBe(true);
  });

  test("a width change follows the same path", () => {
    mountApp();
    mountShell();
    setDockWidth("chat", 411);
    expect(document.documentElement.style.getPropertyValue("--panel-w-chat")).toBe("411px");
  });

  test("is idempotent, and unmount stops tracking", () => {
    const app = mountApp();
    mountShell();
    mountShell();
    unmountShell();
    shell.docks.left.collapsed = true;
    expect(app.classList.contains("left-collapsed")).toBe(false);
  });
});

describe("dock mutators", () => {
  test("setDockCollapsed persists the whole record, widths included", () => {
    setDockWidth("left", 275);
    setDockCollapsed("right", true);

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.rightCollapsed).toBe(true);
    expect(saved.left).toBe(275);
    expect(saved.chatCollapsed).toBe(true);
  });

  test("a width drag no longer erases the collapse flags", () => {
    // The predecessor had two writers of this key: persistWidths() wrote a fresh {chat,left,right}
    // Over the three collapse booleans applyPanelCollapse() had merged in, so dragging any handle
    // Reset every dock to open on the next reload.
    setDockCollapsed("chat", false);
    setDockWidth("chat", 400);
    persistDocks();

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.chat).toBe(400);
    expect(saved.chatCollapsed).toBe(false);
  });

  test("setting a dock to the state it already has is a no-op", () => {
    localStorage.removeItem(STORAGE_KEY);
    setDockCollapsed("left", false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("toggleDock flips and remembers", () => {
    toggleDock("chat");
    expect(shell.docks.chat.collapsed).toBe(false);
    toggleDock("chat");
    expect(shell.docks.chat.collapsed).toBe(true);
  });

  test("unwritable storage is swallowed", () => {
    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      expect(() => persistDocks()).not.toThrow();
    } finally {
      localStorage.setItem = original;
    }
  });
});

describe("the Navigator tab", () => {
  test("setActivityTab selects the panel and opens the dock", () => {
    shell.docks.left.collapsed = true;
    setActivityTab("files");
    expect(shell.leftTab).toBe("files");
    expect(shell.docks.left.collapsed).toBe(false);
  });

  test("toggleActivityTab closes the dock when the showing panel is re-picked", () => {
    setActivityTab("git");
    toggleActivityTab("git");
    expect(shell.docks.left.collapsed).toBe(true);
    expect(shell.leftTab).toBe("git");
  });

  test("toggleActivityTab reopens the dock when the showing panel is re-picked while closed", () => {
    setActivityTab("git");
    setDockCollapsed("left", true);
    toggleActivityTab("git");
    expect(shell.docks.left.collapsed).toBe(false);
  });

  test("a rail selection is observable by an effect, with no renderer wiring", () => {
    const seen: string[] = [];
    const scope = effectScope();
    scope.run(() => {
      effect(() => {
        seen.push(shell.leftTab);
      });
    });
    setActivityTab("data");
    scope.stop();
    expect(seen).toEqual(["layers", "data"]);
  });
});

describe("setLayoutSelection", () => {
  test("adopts and releases the canvas layout-chrome selection", () => {
    // The field shipped with a reader (the properties panel's layout panel) and no writer anywhere,
    // So clicking a header selected nothing. This is that writer.
    expect(shell.layoutSelection).toBeNull();
    const hit = {
      className: "site-header",
      layoutFile: "layouts/base.json",
      layoutPath: ["children", 0],
      rect: { height: 40, width: 800, x: 0, y: 0 },
      tagName: "header",
    };
    setLayoutSelection(hit);
    expect(shell.layoutSelection).toEqual(hit);
    setLayoutSelection(null);
    expect(shell.layoutSelection).toBeNull();
  });
});

describe("resetProjectShell", () => {
  test("drops source control, the stylebook selection and the settings tab", () => {
    shell.git.status = {
      ahead: 0,
      behind: 0,
      branch: "main",
      files: [{ path: "a.json", staged: false, status: "M" }],
      isRepo: true,
      remotes: [],
    };
    shell.git.branches = { branches: ["main"], current: "main" };
    shell.git.commitMessage = "wip";
    shell.git.error = "boom";
    shell.git.loading = true;
    shell.git.logEntries = [{ author: "a", date: "d", hash: "abc", message: "m" }];
    shell.git.subTab = "history";
    shell.git.lastUpdated = 1;
    shell.stylebook.selection = "h1";
    shell.stylebook.filter = "head";
    shell.settingsTab = "fonts";

    resetProjectShell();

    expect(shell.git.status).toBeNull();
    expect(shell.git.branches).toBeNull();
    expect(shell.git.commitMessage).toBe("");
    expect(shell.git.error).toBeNull();
    expect(shell.git.loading).toBe(false);
    expect(shell.git.logEntries).toBeNull();
    // The two module-level leaks the hoist closes: the previous project's History selection and
    // Its "last updated" stamp used to survive into the next project.
    expect(shell.git.subTab).toBe("changes");
    expect(shell.git.lastUpdated).toBeNull();
    expect(shell.stylebook.selection).toBeNull();
    expect(shell.stylebook.filter).toBe("");
    expect(shell.settingsTab).toBe("stylebook");
  });

  test("keeps the workspace arrangement — docks, layout preset and rail panel", () => {
    setActivityTab("files");
    setDockCollapsed("right", true);
    shell.layout = "write";

    resetProjectShell();

    expect(shell.leftTab).toBe("files");
    expect(shell.docks.right.collapsed).toBe(true);
    expect(shell.layout).toBe("write");
  });
});
