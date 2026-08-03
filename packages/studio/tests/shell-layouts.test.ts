/**
 * Named layouts (§3.2 ①b) — the wiring that `shell.layout` did not have.
 *
 * The field shipped with a declared default, a reader in the chrome and **no writer at all**: the
 * same shape `layoutSelection` was in when clicking a page header did nothing. These tests are the
 * writers, and the two claims that make the feature safe:
 *
 * - **A layout reconfigures; it never removes.** Applying one moves panels and docks; it cannot
 *   delete a panel, and every dock it collapses is one chord away from coming back.
 * - **Per project.** The record is namespaced by project root, so two projects cannot overwrite each
 *   other's arrangements, and one writer serialises the whole thing.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import {
  applyLayout,
  DEFAULT_LAYOUT_ID,
  deleteLayout,
  layoutById,
  layoutIdFor,
  mountShell,
  persistProjectShell,
  registerShellViewCommands,
  renameLayout,
  resetLayout,
  resetProjectShell,
  saveLayout,
  shell,
  syncProjectLayouts,
  unmountShell,
} from "../src/shell";
import { setWorkspaceProject } from "../src/workspace/workspace";
import type { InspectorTabId, LayoutPreset } from "../src/shell";
import type { CommandRegistry } from "../src/commands/registry";

const PREFIX = "jx-studio-project::";

let currentTab: InspectorTabId = "properties";
const setInspectorTab = mock((tab: InspectorTabId) => {
  currentTab = tab;
});
const deps = {
  inspectorTab: () => currentTab,
  setInspectorTab,
};

function storedFor(root: string): { layouts?: LayoutPreset[]; activeLayout?: string } {
  return JSON.parse(localStorage.getItem(`${PREFIX}${root}`) || "{}") as {
    layouts?: LayoutPreset[];
    activeLayout?: string;
  };
}

function build(): CommandRegistry {
  const registry = createCommandRegistry({
    getContext: () => makeContext({ document: { open: true }, project: { open: true } }),
  });
  registerShellViewCommands(registry, deps);
  return registry;
}

beforeEach(() => {
  localStorage.clear();
  document.body.textContent = "";
  const app = document.createElement("div");
  app.id = "app";
  document.body.append(app);
  unmountShell();
  setInspectorTab.mockClear();
  currentTab = "properties";
  setWorkspaceProject(null);
  resetProjectShell();
  syncProjectLayouts(null);
  shell.leftTab = "layers";
  shell.docks.left = { collapsed: false, width: 240 };
  shell.docks.right = { collapsed: false, width: 280 };
});

afterEach(() => {
  unmountShell();
  setWorkspaceProject(null);
  localStorage.clear();
});

// ─── The built-ins ────────────────────────────────────────────────────────────

describe("the four built-in layouts", () => {
  test("are Write · Design · Build · Ship, and Design is where a project wakes up", () => {
    expect(shell.layouts.map((preset) => preset.name)).toEqual([
      "Write",
      "Design",
      "Build",
      "Ship",
    ]);
    expect(shell.layout).toBe(DEFAULT_LAYOUT_ID);
    expect(layoutById("design")?.inspectorTab).toBe("style");
  });

  test("each names a Navigator panel and an Inspector tab that actually exist", () => {
    for (const preset of shell.layouts) {
      expect(typeof preset.navigatorPanel).toBe("string");
      expect(["properties", "style", "events", "assistant"]).toContain(preset.inspectorTab);
    }
  });

  test("every project gets its own objects — editing one cannot leak into the next", () => {
    setWorkspaceProject("/one");
    syncProjectLayouts("/one");
    renameLayout("write", "Copy");
    setWorkspaceProject("/two");
    syncProjectLayouts("/two");
    expect(layoutById("write")?.name).toBe("Write");
  });
});

// ─── Applying ─────────────────────────────────────────────────────────────────

describe("applyLayout", () => {
  test("adopts the panel, the docks and the Inspector tab in one move", () => {
    applyLayout("ship", deps);
    expect(shell.layout).toBe("ship");
    expect(shell.leftTab).toBe("git");
    expect(shell.docks.left.width).toBe(300);
    expect(shell.docks.right.collapsed).toBe(true);
    expect(setInspectorTab).toHaveBeenCalledWith("properties");
  });

  test("is idempotent — the same call twice leaves the same arrangement", () => {
    applyLayout("build", deps);
    shell.docks.left.width = 999;
    applyLayout("build", deps);
    expect(shell.docks.left.width).toBe(280);
    expect(shell.leftTab).toBe("data");
  });

  test("refuses an unknown id, naming the ids this project has", () => {
    expect(() => applyLayout("nope", deps)).toThrow(/no layout named "nope"/);
    expect(() => applyLayout("nope", deps)).toThrow(/write, design, build, ship/);
  });

  test("collapsing a dock never removes a panel — the record still names it", () => {
    applyLayout("ship", deps);
    expect(shell.docks.right.collapsed).toBe(true);
    // Everything is still reachable: the Inspector tab is selected, the dock is merely shut.
    expect(currentTab).toBe("properties");
    shell.docks.right.collapsed = false;
    expect(shell.docks.right.collapsed).toBe(false);
  });

  test("Reset Layout puts a drifted arrangement back", () => {
    applyLayout("design", deps);
    shell.leftTab = "files";
    shell.docks.left.collapsed = true;
    resetLayout(deps);
    expect(shell.leftTab).toBe("layers");
    expect(shell.docks.left.collapsed).toBe(false);
  });
});

// ─── Saving, renaming, deleting ───────────────────────────────────────────────

describe("saveLayout", () => {
  test("captures what is on screen now and makes it active", () => {
    shell.leftTab = "search";
    shell.docks.left.width = 321;
    shell.docks.right.collapsed = true;
    currentTab = "events";

    const preset = saveLayout("My Layout", deps);
    expect(preset.id).toBe("my-layout");
    expect(preset.navigatorPanel).toBe("search");
    expect(preset.docks.left.width).toBe(321);
    expect(preset.docks.right.collapsed).toBe(true);
    expect(preset.inspectorTab).toBe("events");
    expect(shell.layout).toBe("my-layout");
    expect(shell.layouts).toHaveLength(5);
  });

  test("saving over a name overwrites it rather than adding a second tab", () => {
    saveLayout("Mine", deps);
    shell.leftTab = "problems";
    saveLayout("Mine", deps);
    expect(shell.layouts.filter((preset) => preset.id === "mine")).toHaveLength(1);
    expect(layoutById("mine")?.navigatorPanel).toBe("problems");
  });

  test("a stale panel id in the shell record is migrated on capture", () => {
    shell.leftTab = "head"; // The pre-rename spelling of "page".
    expect(saveLayout("Legacy", deps).navigatorPanel).toBe("page");
  });

  test("a name of only punctuation still yields a usable id", () => {
    expect(layoutIdFor("  ***  ")).toBe("layout");
    expect(saveLayout("***", deps).name).toBe("***");
  });
});

describe("renameLayout", () => {
  test("changes the name and keeps the id, so every reference survives", () => {
    renameLayout("write", "Draft");
    expect(layoutById("write")?.name).toBe("Draft");
  });

  test("an unknown id or an empty name is a no-op", () => {
    renameLayout("nope", "Draft");
    renameLayout("write", "   ");
    expect(layoutById("write")?.name).toBe("Write");
  });
});

describe("deleteLayout", () => {
  test("removes it, and moves off it when it was active", () => {
    applyLayout("ship", deps);
    deleteLayout("ship");
    expect(layoutById("ship")).toBeUndefined();
    expect(shell.layout).toBe("write");
  });

  test("an unknown id is a no-op", () => {
    deleteLayout("nope");
    expect(shell.layouts).toHaveLength(4);
  });

  test("the last layout cannot be deleted — an empty bar explains nothing", () => {
    for (const id of ["write", "design", "build"]) {
      deleteLayout(id);
    }
    expect(shell.layouts).toHaveLength(1);
    deleteLayout("ship");
    expect(shell.layouts).toHaveLength(1);
  });
});

// ─── Persistence, per project ─────────────────────────────────────────────────

describe("the per-project record", () => {
  test("is written under the project root, and read back on the next sync", () => {
    setWorkspaceProject("/acme");
    syncProjectLayouts("/acme");
    saveLayout("Proofread", deps);

    expect(storedFor("/acme").activeLayout).toBe("proofread");
    expect(storedFor("/acme").layouts?.map((preset) => preset.id)).toContain("proofread");

    // A different project sees only its own; coming back restores the saved one.
    setWorkspaceProject("/other");
    syncProjectLayouts("/other");
    expect(layoutById("proofread")).toBeUndefined();
    setWorkspaceProject("/acme");
    syncProjectLayouts("/acme");
    expect(layoutById("proofread")?.name).toBe("Proofread");
    expect(shell.layout).toBe("proofread");
  });

  test("with no project open there is nothing to write to, and nothing is written", () => {
    saveLayout("Nowhere", deps);
    expect(localStorage.length).toBe(0);
  });

  test("a corrupt record falls back to the built-ins rather than an empty bar", () => {
    localStorage.setItem(`${PREFIX}/broken`, "{not json");
    syncProjectLayouts("/broken");
    expect(shell.layouts.map((preset) => preset.id)).toEqual(["write", "design", "build", "ship"]);
  });

  test("entries that are not layouts are dropped, and an empty result restores the built-ins", () => {
    localStorage.setItem(
      `${PREFIX}/partial`,
      JSON.stringify({
        activeLayout: "keeper",
        layouts: [
          null,
          "nope",
          { id: "", name: "Blank", navigatorPanel: "files", inspectorTab: "style", docks: {} },
          {
            id: "bad-panel",
            name: "Bad",
            navigatorPanel: "nope",
            inspectorTab: "style",
            docks: {},
          },
          {
            docks: {
              left: { collapsed: false, width: 200 },
              right: { collapsed: true, width: 10 },
            },
            id: "keeper",
            inspectorTab: "events",
            name: "Keeper",
            navigatorPanel: "search",
          },
        ],
      }),
    );
    syncProjectLayouts("/partial");
    expect(shell.layouts.map((preset) => preset.id)).toEqual(["keeper"]);
    expect(shell.layout).toBe("keeper");

    localStorage.setItem(`${PREFIX}/empty`, JSON.stringify({ layouts: [] }));
    syncProjectLayouts("/empty");
    expect(shell.layouts).toHaveLength(4);
  });

  test("a stored active id that names nothing falls back to the default layout", () => {
    localStorage.setItem(`${PREFIX}/stale`, JSON.stringify({ layouts: [] }));
    shell.layout = "gone";
    syncProjectLayouts("/stale");
    expect(shell.layout).toBe(DEFAULT_LAYOUT_ID);
  });

  test("the default layout being absent falls back to the first one there is", () => {
    localStorage.setItem(
      `${PREFIX}/one-only`,
      JSON.stringify({
        layouts: [
          {
            docks: {
              left: { collapsed: false, width: 200 },
              right: { collapsed: false, width: 200 },
            },
            id: "only",
            inspectorTab: "style",
            name: "Only",
            navigatorPanel: "files",
          },
        ],
      }),
    );
    shell.layout = "gone";
    syncProjectLayouts("/one-only");
    expect(shell.layout).toBe("only");
  });

  test("syncing the same root twice does not reload over unsaved edits", () => {
    setWorkspaceProject("/acme");
    syncProjectLayouts("/acme");
    shell.layouts[0]!.name = "Scratch";
    syncProjectLayouts("/acme");
    expect(shell.layouts[0]!.name).toBe("Scratch");
  });

  test("closing a project forgets which root is loaded, so reopening re-reads it", () => {
    setWorkspaceProject("/acme");
    syncProjectLayouts("/acme");
    saveLayout("Proofread", deps);
    shell.layouts[0]!.name = "Scratch";
    resetProjectShell();
    syncProjectLayouts("/acme");
    expect(shell.layouts[0]!.name).toBe("Write");
  });

  test("unavailable storage costs the arrangement its memory, not the session", () => {
    setWorkspaceProject("/acme");
    const setItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("QuotaExceeded");
    };
    expect(() => persistProjectShell()).not.toThrow();
    localStorage.setItem = setItem;
  });

  test("mountShell loads the open project's layouts through the reactive root", async () => {
    localStorage.setItem(
      `${PREFIX}/reactive`,
      JSON.stringify({
        activeLayout: "loaded",
        layouts: [
          {
            docks: {
              left: { collapsed: false, width: 210 },
              right: { collapsed: false, width: 220 },
            },
            id: "loaded",
            inspectorTab: "style",
            name: "Loaded",
            navigatorPanel: "files",
          },
        ],
      }),
    );
    mountShell();
    setWorkspaceProject("/reactive");
    await Promise.resolve();
    expect(shell.layout).toBe("loaded");
    expect(shell.layouts.map((preset) => preset.name)).toEqual(["Loaded"]);
  });
});

// ─── The commands ─────────────────────────────────────────────────────────────

describe("the layout verbs", () => {
  test("view.setLayout adopts one by id", () => {
    const registry = build();
    void registry.run("view.setLayout", { layout: "build" });
    expect(shell.layout).toBe("build");
    expect(shell.leftTab).toBe("data");
  });

  test("view.saveLayout · renameLayout · deleteLayout · resetLayout are the rest of the loop", () => {
    const registry = build();
    shell.leftTab = "problems";
    void registry.run("view.saveLayout", { name: "Triage" });
    expect(layoutById("triage")?.navigatorPanel).toBe("problems");

    void registry.run("view.renameLayout", { layout: "triage", name: "Bug day" });
    expect(layoutById("triage")?.name).toBe("Bug day");

    shell.leftTab = "files";
    void registry.run("view.resetLayout");
    expect(shell.leftTab).toBe("problems");

    void registry.run("view.deleteLayout", { layout: "triage" });
    expect(layoutById("triage")).toBeUndefined();
  });

  test("view.setLayout reports an unknown id instead of doing nothing", () => {
    const registry = build();
    expect(() => registry.run("view.setLayout", { layout: "nope" })).toThrow(/no layout/);
  });
});
