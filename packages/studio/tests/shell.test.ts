/**
 * The reactive shell record (src/shell.ts) — dock state, the Navigator tab, the layout selection,
 * and the project-level state hoisted out of `TabUi`.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { effect, effectScope } from "../src/reactivity";
import {
  DOCK_DEFAULT_SIZES,
  DOCK_IDS,
  applyDockLayout,
  mountShell,
  persistDocks,
  resetProjectShell,
  registerShellSurface,
  resetShellSurfaces,
  setActivityTab,
  setBottomTab,
  setDockCollapsed,
  setDockSize,
  setLayoutSelection,
  shell,
  toggleActivityTab,
  toggleBottomTab,
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
  shell.docks.left = { collapsed: false, size: DOCK_DEFAULT_SIZES.left };
  shell.docks.right = { collapsed: false, size: DOCK_DEFAULT_SIZES.right };
  shell.docks.bottom = { collapsed: true, size: DOCK_DEFAULT_SIZES.bottom };
  shell.bottomTab = "problems";
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
    shell.docks.right.size = 333;

    applyDockLayout();

    expect(document.documentElement.style.getPropertyValue("--panel-w-right")).toBe("333px");
    expect(app.classList.contains("left-collapsed")).toBe(true);
    expect(app.classList.contains("right-collapsed")).toBe(false);
  });

  test("widths still apply when there is no #app to classify", () => {
    expect(document.querySelector("#app")).toBeNull();
    shell.docks.left.size = 199;
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
    setDockSize("right", 411);
    expect(document.documentElement.style.getPropertyValue("--panel-w-right")).toBe("411px");
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
    setDockSize("left", 275);
    setDockCollapsed("right", true);

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.rightCollapsed).toBe(true);
    expect(saved.left).toBe(275);
    expect(saved.leftCollapsed).toBe(false);
  });

  test("a width drag no longer erases the collapse flags", () => {
    // The predecessor had two writers of this key: persistWidths() wrote a fresh {left,right}
    // Over the collapse booleans applyPanelCollapse() had merged in, so dragging any handle
    // Reset every dock to open on the next reload.
    setDockCollapsed("right", true);
    setDockSize("right", 400);
    persistDocks();

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.right).toBe(400);
    expect(saved.rightCollapsed).toBe(true);
  });

  test("setting a dock to the state it already has leaves the state alone", () => {
    // It still WRITES: `setActivityTab` routes through here, and the remembered panel has to be
    // Persisted even when the dock was already open. What must not change is the dock itself.
    setDockCollapsed("left", false);
    expect(shell.docks.left.collapsed).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").leftCollapsed).toBe(false);
  });

  test("toggleDock flips and remembers", () => {
    toggleDock("right");
    expect(shell.docks.right.collapsed).toBe(true);
    toggleDock("right");
    expect(shell.docks.right.collapsed).toBe(false);
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

  test("the panel is remembered even when the dock was already open", () => {
    // `setDockCollapsed` only writes when the flag CHANGES, so relying on it to persist the panel
    // Would forget every selection made while the Navigator was already showing.
    setDockCollapsed("left", false);
    setActivityTab("data");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").leftTab).toBe("data");
  });
});

describe("shell surfaces", () => {
  test("a registered surface mounts and unmounts with the shell, and registers once", () => {
    resetShellSurfaces();
    const calls: string[] = [];
    const surface = {
      mount: () => {
        calls.push("mount");
      },
      unmount: () => {
        calls.push("unmount");
      },
    };
    registerShellSurface(surface);
    registerShellSurface(surface);
    mountApp();
    mountShell();
    unmountShell();
    // Once each, not twice: the dependency points from the surface to the shell, and a surface
    // That registered itself on two import paths must not be drawn twice.
    expect(calls).toEqual(["mount", "unmount"]);
    resetShellSurfaces();
  });
});

describe("the Bottom dock is a dock", () => {
  test("setBottomTab selects a tab, opens the dock and remembers both", () => {
    setDockCollapsed("bottom", true);
    setBottomTab("activity");
    expect(shell.bottomTab).toBe("activity");
    expect(shell.docks.bottom.collapsed).toBe(false);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.bottomTab).toBe("activity");
    expect(saved.bottomCollapsed).toBe(false);
  });

  test("toggleBottomTab closes the dock when the showing tab is re-picked", () => {
    setBottomTab("problems");
    toggleBottomTab("problems");
    expect(shell.docks.bottom.collapsed).toBe(true);
    expect(shell.bottomTab).toBe("problems");
  });

  test("toggleBottomTab reopens the dock when the showing tab is re-picked while closed", () => {
    setBottomTab("problems");
    setDockCollapsed("bottom", true);
    toggleBottomTab("problems");
    expect(shell.docks.bottom.collapsed).toBe(false);
    expect(shell.bottomTab).toBe("problems");
  });

  test("toggleBottomTab switching tabs opens the dock rather than closing it", () => {
    setBottomTab("problems");
    toggleBottomTab("activity");
    expect(shell.docks.bottom.collapsed).toBe(false);
    expect(shell.bottomTab).toBe("activity");
  });

  test("its size is projected onto the row track, not onto a column", () => {
    mountApp();
    shell.docks.bottom.size = 314;
    applyDockLayout();
    expect(document.documentElement.style.getPropertyValue("--dock-h-bottom")).toBe("314px");
  });
});

describe("the assistant is not a dock", () => {
  test("there are three docks, and none of them is the chat", () => {
    // The fifth grid column is gone: the assistant is the Inspector's fourth TAB, so it has no
    // Collapse flag, no size and no resize handle to keep in step with anything. The third dock
    // Is the BOTTOM one (P4.2) — a real dock, with all three of those.
    expect(Object.keys(shell.docks).toSorted()).toEqual(["bottom", "left", "right"]);
    expect(DOCK_IDS).toEqual(["left", "right", "bottom"]);
  });

  test("the persisted record carries no chat keys", () => {
    persistDocks();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(Object.keys(saved).toSorted()).toEqual([
      "bottom",
      "bottomCollapsed",
      "bottomTab",
      "left",
      "leftCollapsed",
      "leftTab",
      // The pane splitter rides in the same record as the dock geometry: it is remembered for the
      // Same reason and by the same single writer.
      "paneSplit",
      "right",
      "rightCollapsed",
    ]);
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
