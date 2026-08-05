/**
 * The Inspector, Data, State, Formula and Style verbs the screenshot manifest names.
 *
 * Every record here replaces an XPath press that matched RENDERED TEXT — a signal row's name, a
 * data row's label, an accordion's `label=` attribute — which plan §13's R1 forbids outright: those
 * strings are derived, so improving how a panel labels a row broke a shot. Each one now names the
 * thing the DOCUMENT declares, and refuses a name the document does not.
 *
 * `inspector.setSection` is also the setter that empties the last of `TOGGLE_DEBT`.
 */
import { flush, resetWorkspaceWithTab } from "./harness";
import { render as litRender } from "lit-html";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import { checkPlacements } from "../src/commands/levels";
import { activeTab, closeAllTabs, openTab } from "../src/workspace/workspace";
import type { CommandContext } from "../src/commands/context";
import type { AnyCommand, CommandRegistry } from "../src/commands/registry";
import type { JxMutableNode } from "@jxsuite/schema/types";

// ─── Seams ────────────────────────────────────────────────────────────────────

void mock.module("../src/ui/media-picker.js", () => ({
  invalidateMediaCache: () => {},
  renderMediaPicker: () => "",
  uploadAndAssign: () => Promise.resolve(null),
}));

const {
  INSPECTOR_SECTION_KEYS,
  inspectorCommands,
  inspectorSectionKeys,
  registerInspectorCommands,
  setInspectorSection,
} = await import("../src/panels/properties-panel");
const {
  dataExplorerCommands,
  isDataRowExpanded,
  registerDataExplorerCommands,
  resetDataRowExpansion,
} = await import("../src/panels/data-explorer");
const { registerSignalsCommands, selectedSignal, selectSignal, signalsCommands } =
  await import("../src/panels/signals-panel");
const { formulaEditorCommands, registerFormulaEditorCommands } =
  await import("../src/panels/formula-workspace");
const {
  availableSelectors,
  registerStyleCommands,
  renderStylePanelTemplate,
  resetSelectorMenu,
  styleCommands,
} = await import("../src/panels/style-panel");

// ─── Context ──────────────────────────────────────────────────────────────────

const renderLeftPanel = mock(() => {});
const renderCanvas = mock(() => {});

let ctx: CommandContext = makeContext();
let registry: CommandRegistry;

/** A document with one expression def, one plain state entry, and a styled child. */
const DOC = {
  children: [{ style: { ":hover": { color: "red" } }, tagName: "p", textContent: "Hi" }],
  state: {
    count: { default: 0, type: "number" },
    toggle0: { $expression: { operator: "=", target: null } },
  },
  tagName: "div",
} as unknown as JxMutableNode;

function openDoc(doc: JxMutableNode = structuredClone(DOC)) {
  closeAllTabs();
  return openTab({ document: doc, documentPath: "components/card.json", id: "t1" });
}

function allRecords(): AnyCommand[] {
  return [
    ...inspectorCommands(),
    ...dataExplorerCommands({ renderLeftPanel }),
    ...signalsCommands({ renderCanvas, renderLeftPanel }),
    ...formulaEditorCommands({ renderCanvas }),
    ...styleCommands(),
  ];
}

beforeEach(() => {
  renderLeftPanel.mockClear();
  renderCanvas.mockClear();
  resetDataRowExpansion();
  resetSelectorMenu();
  selectSignal(null);
  ctx = makeContext({ document: { open: true }, selection: { count: 1 } });
  registry = createCommandRegistry({ getContext: () => ctx });
  registerInspectorCommands(registry);
  registerDataExplorerCommands(registry, { renderLeftPanel });
  registerSignalsCommands(registry, { renderCanvas, renderLeftPanel });
  registerFormulaEditorCommands(registry, { renderCanvas });
  registerStyleCommands(registry);
  openDoc();
});

describe("the records themselves", () => {
  test("satisfy the level × placement matrix", () => {
    expect(checkPlacements(allRecords())).toEqual([]);
  });

  test("register under the ids the manifest names, and none is a toggle", () => {
    expect(registry.list().map((c) => c.id)).toEqual([
      "inspector.setSection",
      "selection.findUsages",
      "data.expandRow",
      "state.selectSignal",
      "formula.openWorkspace",
      "formula.editDef",
      "formula.editEvent",
      "style.openSelectorMenu",
      "style.setSelector",
    ]);
    expect(registry.list().some((c) => /\.toggle[A-Z]/.test(c.id))).toBe(false);
  });

  test("every record that takes arguments declares a schema for them", () => {
    // The two that take none act on what is already selected or already open, so there is nothing
    // For a palette prompt or an AI tool call to supply.
    const NO_ARGUMENTS = new Set(["style.openSelectorMenu", "selection.findUsages"]);
    for (const command of registry.list()) {
      if (!NO_ARGUMENTS.has(command.id)) {
        expect(command.args).toBeDefined();
      }
    }
  });
});

describe("inspector.setSection — the setter that replaces inspector.toggleSection", () => {
  test("opens and closes the same section from either starting state", () => {
    void registry.run("inspector.setSection", { open: true, section: "__element" });
    expect(activeTab.value?.session.ui.inspectorSections.__element).toBe(true);
    void registry.run("inspector.setSection", { open: true, section: "__element" });
    expect(activeTab.value?.session.ui.inspectorSections.__element).toBe(true);
    void registry.run("inspector.setSection", { open: false, section: "__element" });
    expect(activeTab.value?.session.ui.inspectorSections.__element).toBe(false);
  });

  test('refuses a LABEL where a key belongs — the old step passed "Element"', () => {
    expect(() => registry.run("inspector.setSection", { open: true, section: "Element" })).toThrow(
      'command "inspector.setSection" argument "section": "Element" is not a section this ' +
        "document declares",
    );
  });

  test("the refusal lists the fixed keys", () => {
    expect(() => registry.run("inspector.setSection", { open: true, section: "nope" })).toThrow(
      INSPECTOR_SECTION_KEYS.join(", "),
    );
  });

  test("a schema-contributed section becomes addressable once it has been recorded", () => {
    setInspectorSection("content", true);
    expect(inspectorSectionKeys()).toContain("content");
    void registry.run("inspector.setSection", { open: false, section: "content" });
    expect(activeTab.value?.session.ui.inspectorSections.content).toBe(false);
  });

  test("writing with no tab open is a no-op, not a crash", () => {
    closeAllTabs();
    expect(() => setInspectorSection("__element", true)).not.toThrow();
    expect(inspectorSectionKeys()).toEqual([...INSPECTOR_SECTION_KEYS]);
  });
});

describe("data.expandRow", () => {
  test("expands a row the document defines, and repaints the Navigator", () => {
    void registry.run("data.expandRow", { name: "count" });
    expect(isDataRowExpanded("count")).toBe(true);
    expect(renderLeftPanel).toHaveBeenCalled();
  });

  test("is idempotent — running it twice leaves the row expanded", () => {
    void registry.run("data.expandRow", { name: "count" });
    void registry.run("data.expandRow", { name: "count" });
    expect(isDataRowExpanded("count")).toBe(true);
  });

  test("`expanded: false` collapses through the same record rather than a second id", () => {
    void registry.run("data.expandRow", { expanded: true, name: "count" });
    void registry.run("data.expandRow", { expanded: false, name: "count" });
    expect(isDataRowExpanded("count")).toBe(false);
  });

  test("refuses a name the document does not define, listing what it does", () => {
    expect(() => registry.run("data.expandRow", { name: "posts" })).toThrow(
      'command "data.expandRow" argument "name": "posts" is not defined by this document — ' +
        "it defines: count, toggle0",
    );
  });

  test("a document with no state says so", () => {
    openDoc({ children: [], tagName: "div" } as unknown as JxMutableNode);
    expect(() => registry.run("data.expandRow", { name: "count" })).toThrow("it defines: nothing");
  });
});

describe("state.selectSignal", () => {
  test("expands the named entry's editor", () => {
    void registry.run("state.selectSignal", { name: "toggle0" });
    expect(selectedSignal()).toBe("toggle0");
    expect(renderLeftPanel).toHaveBeenCalled();
  });

  test("refuses an entry the document does not define", () => {
    expect(() => registry.run("state.selectSignal", { name: "ghost" })).toThrow(
      '"ghost" is not a state entry this document defines — it defines: count, toggle0',
    );
    expect(selectedSignal()).toBeNull();
  });
});

describe("formula.openWorkspace", () => {
  test("defaults its target to the selected entry — the button it replaces lives in that editor", () => {
    void registry.run("state.selectSignal", { name: "toggle0" });
    void registry.run("formula.openWorkspace");
    expect(activeTab.value?.session.ui.editingFormula).toEqual({
      defName: "toggle0",
      type: "def",
    });
    expect(renderCanvas).toHaveBeenCalled();
  });

  test("takes an explicit defName", () => {
    void registry.run("formula.openWorkspace", { defName: "toggle0" });
    expect(activeTab.value?.session.ui.editingFormula).toEqual({
      defName: "toggle0",
      type: "def",
    });
  });

  test("refuses with no target at all", () => {
    expect(() => registry.run("formula.openWorkspace")).toThrow(
      'command "formula.openWorkspace" needs a target: pass "defName", or select a state entry ' +
        "first with state.selectSignal",
    );
  });

  test("refuses an entry that holds no formula — the workspace edits expressions", () => {
    expect(() => registry.run("formula.openWorkspace", { defName: "count" })).toThrow(
      'command "formula.openWorkspace" argument "defName": "count" holds no $expression',
    );
    expect(activeTab.value?.session.ui.editingFormula).toBeNull();
  });

  test("refuses an entry the document does not define", () => {
    expect(() => registry.run("formula.openWorkspace", { defName: "ghost" })).toThrow(
      "is not a state entry this document defines",
    );
  });

  test("with no tab open the target cannot be resolved", () => {
    selectSignal("toggle0");
    closeAllTabs();
    expect(() => registry.run("formula.openWorkspace")).toThrow(
      "is not a state entry this document defines",
    );
  });
});

describe("formula.editDef / formula.editEvent", () => {
  test("editDef opens the code editor over a declared entry", () => {
    void registry.run("formula.editDef", { defName: "count" });
    expect(activeTab.value?.session.ui.editingFunction).toEqual({
      defName: "count",
      type: "def",
    });
    expect(renderCanvas).toHaveBeenCalled();
  });

  test("editDef refuses an undeclared entry", () => {
    expect(() => registry.run("formula.editDef", { defName: "ghost" })).toThrow(
      '"ghost" is not a state entry this document defines — it defines: count, toggle0',
    );
  });

  test("editDef refuses with no document open", () => {
    closeAllTabs();
    expect(() => registry.run("formula.editDef", { defName: "count" })).toThrow(
      'command "formula.editDef" needs an open document',
    );
  });

  test("editEvent opens the code editor over an element's binding", () => {
    void registry.run("formula.editEvent", { eventKey: "onclick", path: ["children", 0] });
    expect(activeTab.value?.session.ui.editingFunction).toEqual({
      eventKey: "onclick",
      path: ["children", 0],
      type: "event",
    });
  });

  test("editEvent refuses a path that addresses nothing", () => {
    expect(() =>
      registry.run("formula.editEvent", { eventKey: "onclick", path: ["children", 9] }),
    ).toThrow("[children, 9] addresses no node in components/card.json");
  });

  test("editEvent refuses with no document open", () => {
    closeAllTabs();
    expect(() => registry.run("formula.editEvent", { eventKey: "onclick", path: [] })).toThrow(
      'command "formula.editEvent" needs an open document',
    );
  });
});

describe("style.openSelectorMenu", () => {
  test("opens the menu the Target Line's own template captured", async () => {
    activeTab.value!.session.selection = [["children", 0]];
    const host = document.createElement("div");
    document.body.append(host);
    // Render the REAL Style sidebar: the handle comes from the Target Line's `ref`, which is the
    // Whole point — no selector crosses the boundary, in the manifest or in this test.
    litRender(renderStylePanelTemplate({ getCanvasMode: () => "design" }), host);
    await flush();

    const trigger = host.querySelector("overlay-trigger") as
      | (HTMLElement & { open?: string })
      | null;
    expect(trigger).not.toBeNull();
    void registry.run("style.openSelectorMenu");
    expect(trigger?.open).toBe("click");
    host.remove();
  });

  test("refuses when the Style tab is not rendered, rather than pressing nothing", () => {
    resetSelectorMenu();
    expect(() => registry.run("style.openSelectorMenu")).toThrow(
      'command "style.openSelectorMenu" needs the Inspector\'s Style tab rendered; its selector ' +
        "menu is not in the document",
    );
  });

  test("is hidden with no selection", () => {
    ctx = makeContext({ document: { open: true } });
    expect(registry.isVisible("style.openSelectorMenu")).toBe(false);
  });
});

describe("style.setSelector", () => {
  test("writes the active selector", () => {
    void registry.run("style.setSelector", { selector: ":hover" });
    expect(activeTab.value?.session.ui.activeSelector).toBe(":hover");
  });

  test("null returns to the base context", () => {
    void registry.run("style.setSelector", { selector: ":hover" });
    void registry.run("style.setSelector", { selector: null });
    expect(activeTab.value?.session.ui.activeSelector).toBeNull();
  });

  test("refuses something that is not a nested selector", () => {
    expect(() => registry.run("style.setSelector", { selector: "hover" })).toThrow(
      'command "style.setSelector" argument "selector": "hover" is not a nested selector — it ' +
        'must start with ":", ".", "&" or "["',
    );
  });

  test("refuses a missing selector", () => {
    expect(() => registry.run("style.setSelector", {})).toThrow("expected a non-empty string");
  });

  test("clearing with no tab open is a no-op", () => {
    closeAllTabs();
    expect(() => registry.run("style.setSelector", { selector: null })).not.toThrow();
  });

  test("setting with no tab open refuses", () => {
    closeAllTabs();
    expect(() => registry.run("style.setSelector", { selector: ":hover" })).toThrow(
      'command "style.setSelector" needs an open document',
    );
  });
});

describe("availableSelectors", () => {
  test("is the common set plus what the selected element declares", () => {
    activeTab.value!.session.selection = [["children", 0]];
    expect(availableSelectors()).toContain(":hover");
  });

  test("includes the active selector even when nothing declares it yet", () => {
    activeTab.value!.session.selection = [["children", 0]];
    activeTab.value!.session.ui.activeSelector = "[open]";
    expect(availableSelectors()).toContain("[open]");
  });

  test("with nothing selected it is just the common set", () => {
    activeTab.value!.session.selection = [];
    expect(availableSelectors()).toContain(":focus");
  });

  test("with no tab open it still answers", () => {
    closeAllTabs();
    expect(availableSelectors().length).toBeGreaterThan(0);
  });
});

describe("the harness document works with these verbs", () => {
  test("a harness tab has no state entries, so data.expandRow refuses", () => {
    resetWorkspaceWithTab();
    expect(() => registry.run("data.expandRow", { name: "count" })).toThrow("it defines: nothing");
  });
});
