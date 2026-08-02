/**
 * Coverage-gap tests for small service/util modules:
 *
 * - Automation `showWelcome` (staged welcome-screen state for screenshots)
 * - Cf-settings read() degradation when localStorage access throws
 * - Jx-validate no-op degradation when ajv fails to load/compile
 * - Render-critic "is not a function" / "is not a constructor" error translation
 * - Preview-format fallback when JSON.stringify throws
 */
import { resetWorkspaceWithTab } from "./harness";
import { describe, expect, mock, test } from "bun:test";
import type { AutomationDeps } from "../src/services/automation";
import type { ProjectListEntry } from "../src/types";

// Jx-validate treats ajv as an optional peer dependency: this file exercises the degraded
// Path where the compile step throws, so the mock must land before the module loads.
void mock.module("ajv/dist/2020.js", () => ({
  default: class FailingAjv {
    constructor() {
      throw new Error("ajv unavailable in this environment");
    }
  },
}));

const { createAutomationApi } = await import("../src/services/automation");
const { validateDoc } = await import("../src/services/jx-validate");
const { renderCheck } = await import("../src/services/render-critic");
const { formatPreviewValue } = await import("../src/utils/preview-format");
const { getCfAccountId, getCfToken } = await import("../src/services/cf-settings");
const { getProjectList, resetProjectList, seedProjectList } = await import("../src/project-list");
const { shell } = await import("../src/shell");
const { workspace } = await import("../src/workspace/workspace");
const state = await import("../src/state");

function makeDeps(): AutomationDeps & { render: ReturnType<typeof mock> } {
  return {
    getCanvasMode: () => "design",
    openBrowseModal: mock(() => {}),
    openConnectorGrid: mock(() => {}),
    openNewProjectModal: mock(() => {}),
    openQuickSearchPalette: mock(() => {}),
    openSettingsModal: mock(() => {}),
    render: mock(() => {}),
    seedAssistantMessages: mock(() => {}),
    seedPublishConnected: mock(() => {}),
    setCanvasMode: mock(() => {}),
    statusMessage: mock(() => {}),
  };
}

describe("automation showWelcome", () => {
  test("closes tabs, clears project state, and stages the catalogue", () => {
    resetWorkspaceWithTab();
    state.setProjectState({ expanded: new Set(), projectConfig: null } as never);
    shell.docks.chat.collapsed = false;
    const projects: ProjectListEntry[] = [
      { description: "A demo site", name: "Demo", root: "/demo" },
    ];
    const deps = makeDeps();
    createAutomationApi(deps).showWelcome({ projects });
    expect(workspace.tabs.size).toBe(0);
    expect(state.projectState).toBeNull();
    expect(shell.docks.chat.collapsed).toBe(true);
    expect(getProjectList()).toEqual(projects);
    expect(deps.render).toHaveBeenCalledTimes(1);
    resetProjectList();
  });

  test("without a staged catalogue leaves the existing one untouched", () => {
    resetWorkspaceWithTab();
    const existing: ProjectListEntry[] = [{ name: "Kept", root: "/kept" }];
    seedProjectList(existing);
    const deps = makeDeps();
    createAutomationApi(deps).showWelcome();
    expect(getProjectList()).toEqual(existing);
    expect(workspace.tabs.size).toBe(0);
    expect(deps.render).toHaveBeenCalledTimes(1);
    resetProjectList();
  });
});

describe("cf-settings storage failure", () => {
  test("read degrades to empty string when localStorage access throws", () => {
    // Happy-dom's Storage is a proxy (assigning .getItem would just store an item), so swap
    // The whole global for one that throws on access — the private-mode failure shape.
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage denied");
      },
    });
    try {
      expect(getCfToken()).toBe("");
      expect(getCfAccountId()).toBe("");
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      }
    }
  });
});

describe("jx-validate without ajv", () => {
  test("validateDoc degrades to no findings when the validator fails to compile", async () => {
    expect(await validateDoc({ tagName: "div" })).toEqual([]);
    // A second call reuses the settled loading promise (still degraded).
    expect(await validateDoc({ not: "a document" })).toEqual([]);
  });
});

describe("render-critic error translation branches", () => {
  test('"is not a function" errors get the handler-oriented fix hint', async () => {
    const doc = {
      children: [{ children: ["${state.count()}"], tagName: "span" }],
      state: { count: 5 },
      tagName: "div",
    };
    const result = await renderCheck(doc as never);
    expect(result.ok).toBe(false);
    const { error } = result as { error: string; ok: false };
    expect(error).toContain("is not a function");
    expect(error).toContain('$prototype: "Function"');
  });

  test('"is not a constructor" errors get the prototype-oriented fix hint', async () => {
    const doc = {
      children: [{ children: ["${new state.count()}"], tagName: "span" }],
      state: { count: 5 },
      tagName: "div",
    };
    const result = await renderCheck(doc as never);
    expect(result.ok).toBe(false);
    const { error } = result as { error: string; ok: false };
    expect(error).toContain("is not a constructor");
    expect(error).toContain("$export");
  });
});

describe("preview-format stringify failure", () => {
  test("falls back to String() when JSON.stringify throws", () => {
    expect(formatPreviewValue(7n)).toBe("7");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatPreviewValue(circular)).toBe("[object Object]");
  });
});
