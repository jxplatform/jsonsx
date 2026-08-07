import { flush, installMockPlatform, resetStudioState, surfaceOf } from "./harness";

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import { FakeTabulator, tabulatorMockModule } from "./tabulator-mock";
import { render } from "lit-html";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import type { GridEditBatch, GridSource } from "../src/grid/grid-source";

void mock.module("tabulator-tables", () => tabulatorMockModule);
void mock.module("tabulator-tables/dist/css/tabulator.min.css", () => ({}));
void mock.module("../src/ui/layers.js", () => ({
  clearLayerSlot: () => {},
  getLayerSlot: () => document.createElement("div"),
  initLayers: () => {},
  openModal: () => ({ close: () => {}, update: () => {} }),
  renderPopover: (template: unknown) => {
    const host = document.createElement("div");
    host.className = "test-popover-host";
    document.body.append(host);
    render(template as never, host);
    return {
      dismiss: () => {
        host.remove();
      },
      host,
      update: (tpl: unknown) => render(tpl as never, host),
    };
  },
  showConfirmDialog: async () => dialogAnswers.confirm,
  showDialog: async () => null,
  showPromptDialog: async (_headline: string, opts: Record<string, unknown> = {}) => {
    lastPromptOpts = opts;
    return dialogAnswers.prompt;
  },
}));

/** What the mocked dialogs answer. Mutated per test — `mock.module` runs once, at import. */
const dialogAnswers: { confirm: boolean; prompt: string | null } = { confirm: true, prompt: null };
/** The options the last prompt was opened with, so the validator can be exercised for real. */
let lastPromptOpts: Record<string, unknown> = {};
void mock.module("../src/ui/progress-modal.js", () => ({
  showProgressModal: () => ({ done: () => {}, fail: () => {}, setStatus: () => {} }),
}));
void mock.module("../src/services/notify.js", () => notifyModule(() => {}));

const { createGridController } = await import("../src/grid/grid-controller");
const {
  detachGridPanel,
  gridPanelMounted,
  gridViewCommands,
  registerGridViewCommands,
  renderGridMode,
} = await import("../src/grid/grid-panel");
const {
  clearGridLayout,
  listSavedViews,
  loadGridLayout,
  resetGridLayout,
  saveGridLayout,
  saveViewAs,
} = await import("../src/grid/grid-layout");

function stubSource(id = "grid://collection/posts"): GridSource & { commits: GridEditBatch[] } {
  const commits: GridEditBatch[] = [];
  return {
    capabilities: { delete: true, insert: true, remotePaging: false, remoteSort: false },
    columns: async () => [{ editable: true, field: "title", kind: "string", title: "Title" }],
    async commit(batch) {
      commits.push(batch);
      return {
        cells: batch.cells.map((c) => ({ field: c.field, ok: true, rowKey: c.rowKey })),
        deletes: batch.deletes.map((d) => ({ ok: true, rowKey: d.rowKey })),
        inserts: batch.inserts.map((i) => ({ ok: true, tempKey: i.tempKey })),
      };
    },
    commits,
    id,
    label: "posts",
    rows: async () => ({ rows: [{ cells: { title: "One" }, key: "a" }], total: 1 }),
  };
}

function gridTab(id = "grid://collection/posts") {
  return openTab({
    capabilities: { modes: ["grid"] },
    document: { tagName: "div" },
    documentPath: null,
    id,
  });
}

beforeEach(() => {
  detachGridPanel("primary");
  resetStudioState();
  closeAllTabs();
  installMockPlatform();
  FakeTabulator.reset();
});

describe("renderGridMode", () => {
  test("renders the shell, then creates the engine once columns load", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab();
    const controller = createGridController(tab, stubSource());
    await controller.load();

    renderGridMode(surfaceOf(wrap), tab);
    await flush();

    expect(wrap.querySelector(".jx-grid-toolbar")).not.toBeNull();
    expect(wrap.querySelector(".jx-grid-host")).not.toBeNull();
    expect(wrap.textContent).toContain("1 row");
    expect(gridPanelMounted("primary", tab)).toBeTrue();

    const table = FakeTabulator.instances.at(-1);
    expect(table).toBeDefined();
    expect(wrap.querySelector(".jx-grid-host")!.contains(table!.host)).toBeTrue();
  });

  test("CSV file tabs lazily provision their controller from any open path", async () => {
    installMockPlatform({}, { "lazy.csv": "a,b\n1,2\n" });
    const wrap = document.createElement("div");
    document.body.append(wrap);
    // Simulates a deep-link/quick-search open: format modes gave the tab grid mode, no controller.
    const tab = openTab({
      capabilities: { modes: ["grid", "source"] },
      document: { tagName: "div" },
      documentPath: "lazy.csv",
      id: "lazy.csv",
    });
    renderGridMode(surfaceOf(wrap), tab);
    await flush();
    expect(wrap.textContent).not.toContain("no grid source");
    expect(wrap.textContent).toContain("1 row");
  });

  test("tabs without a controller render a friendly placeholder", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab("grid://collection/orphan");
    renderGridMode(surfaceOf(wrap), tab);
    await flush();
    expect(wrap.textContent).toContain("no grid source");
    expect(gridPanelMounted("primary", tab)).toBeFalse();
  });

  test("same-tab re-render is a no-op; switching tabs rebuilds the view", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tabA = gridTab("grid://collection/a");
    const controllerA = createGridController(tabA, stubSource("grid://collection/a"));
    await controllerA.load();
    renderGridMode(surfaceOf(wrap), tabA);
    await flush();
    const firstCount = FakeTabulator.instances.length;
    renderGridMode(surfaceOf(wrap), tabA);
    await flush();
    expect(FakeTabulator.instances.length).toBe(firstCount);

    const tabB = gridTab("grid://collection/b");
    const controllerB = createGridController(tabB, stubSource("grid://collection/b"));
    await controllerB.load();
    renderGridMode(surfaceOf(wrap), tabB);
    await flush();
    expect(FakeTabulator.instances.length).toBe(firstCount + 1);
    expect(FakeTabulator.instances.at(-2)!.destroyed).toBeTrue();
    expect(gridPanelMounted("primary", tabA)).toBeFalse();
    expect(gridPanelMounted("primary", tabB)).toBeTrue();
  });

  test("Save button reflects the dirty count and triggers controller.save", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab();
    const source = stubSource();
    const controller = createGridController(tab, source);
    await controller.load();
    renderGridMode(surfaceOf(wrap), tab);
    await flush();

    // Sp-button is not upgraded under happy-dom — lit's ?disabled binding lands as an attribute.
    const saveButton = wrap.querySelector("sp-button") as HTMLElement;
    expect(saveButton.textContent).not.toContain("(");
    expect(saveButton.hasAttribute("disabled")).toBeTrue();

    controller.buffer.setCell("a", "title", "Edited");
    await flush();
    expect(saveButton.textContent).toContain("Save (1)");
    expect(saveButton.hasAttribute("disabled")).toBeFalse();

    saveButton.click();
    await flush();
    expect(source.commits).toHaveLength(1);
    expect(saveButton.hasAttribute("disabled")).toBeTrue();
  });

  test("Add Row appends a pending insert through the controller", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab();
    const controller = createGridController(tab, stubSource());
    await controller.load();
    renderGridMode(surfaceOf(wrap), tab);
    await flush();

    const addButton = [...wrap.querySelectorAll("sp-action-button")].find((b) =>
      b.textContent?.includes("Add Row"),
    ) as HTMLElement;
    addButton.click();
    await flush();
    expect(controller.buffer.state.inserts.size).toBe(1);
    expect(wrap.textContent).toContain("Save (1)");
  });

  test("collection grids show the frontmatter-rewrite note; CSV grids do not", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab();
    const controller = createGridController(tab, stubSource());
    await controller.load();
    renderGridMode(surfaceOf(wrap), tab);
    await flush();
    expect(wrap.textContent).toContain("rewrites frontmatter");

    detachGridPanel("primary");
    closeAllTabs();
    const csvTab = openTab({
      capabilities: { modes: ["grid", "source"] },
      document: { tagName: "div" },
      documentPath: "data.csv",
      id: "data.csv",
    });
    const csvController = createGridController(csvTab, stubSource("data.csv"));
    await csvController.load();
    renderGridMode(surfaceOf(wrap), csvTab);
    await flush();
    expect(wrap.textContent).not.toContain("rewrites frontmatter");
  });

  test("toolbar actions drive the view: refresh, delete-selected, fill-down, search", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab();
    const controller = createGridController(tab, stubSource());
    await controller.load();
    renderGridMode(surfaceOf(wrap), tab);
    await flush();
    const table = FakeTabulator.instances.at(-1)!;
    const buttonFor = (label: string) =>
      [...wrap.querySelectorAll("sp-action-button")].find((b) =>
        b.textContent?.includes(label),
      ) as HTMLElement;

    // Search input installs a filter on the table.
    const search = wrap.querySelector("sp-search") as HTMLInputElement;
    search.value = "one";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(table.filter).not.toBeNull();
    search.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    // Fill Down without a range is a safe no-op.
    buttonFor("Fill Down").click();
    expect(controller.buffer.isDirty()).toBeFalse();

    // Delete Rows uses the view's selected keys (none selected → no-op).
    buttonFor("Delete Rows").click();
    expect(controller.buffer.isDirty()).toBeFalse();

    // Refresh reloads from the source.
    buttonFor("Refresh").click();
    await flush();
    expect(wrap.textContent).toContain("1 row");
  });

  test("a failing source surfaces its error in the toolbar", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab("grid://collection/broken");
    const source = stubSource("grid://collection/broken");
    source.rows = async () => {
      throw new Error("backend exploded");
    };
    const controller = createGridController(tab, source);
    await controller.load();
    renderGridMode(surfaceOf(wrap), tab);
    await flush();
    expect(wrap.textContent).toContain("backend exploded");
  });

  test("remote-paged sources get a working Prev/Next pager", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab("grid://data/main/users");
    const queries: unknown[] = [];
    const source = stubSource("grid://data/main/users");
    source.capabilities = { delete: true, insert: true, remotePaging: true, remoteSort: true };
    source.rows = async (q) => {
      queries.push({ ...q });
      return { rows: [{ cells: { title: "Row" }, key: `r${q?.offset ?? 0}` }], total: 120 };
    };
    const controller = createGridController(tab, source);
    await controller.load();
    renderGridMode(surfaceOf(wrap), tab);
    await flush();

    const next = [...wrap.querySelectorAll("sp-action-button")].find(
      (b) => b.getAttribute("title") === "Next page",
    ) as HTMLElement;
    const prev = [...wrap.querySelectorAll("sp-action-button")].find(
      (b) => b.getAttribute("title") === "Previous page",
    ) as HTMLElement;
    expect(next).toBeDefined();
    expect(prev.hasAttribute("disabled")).toBeTrue();
    expect(wrap.textContent).toContain("1–50");

    next.click();
    await flush();
    expect(queries.at(-1)).toEqual({ limit: 50, offset: 50 });
    expect(wrap.textContent).toContain("51–100");
    expect(prev.hasAttribute("disabled")).toBeFalse();
  });

  test("the Replace popover buffers replacements and reports the count", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab();
    const controller = createGridController(tab, stubSource());
    await controller.load();
    renderGridMode(surfaceOf(wrap), tab);
    await flush();

    const replaceButton = [...wrap.querySelectorAll("sp-action-button")].find((b) =>
      b.textContent?.includes("Replace"),
    ) as HTMLElement;
    replaceButton.click();
    await flush();

    const popover = document.querySelector(".jx-grid-replace-popover")!;
    expect(popover).not.toBeNull();
    const [findInput, replaceInput] = [...popover.querySelectorAll("input")];
    findInput!.value = "One";
    findInput!.dispatchEvent(new Event("input", { bubbles: true }));
    replaceInput!.value = "Uno";
    replaceInput!.dispatchEvent(new Event("input", { bubbles: true }));
    (popover.querySelector("sp-button") as HTMLElement).click();
    await flush();

    expect(controller.buffer.effectiveValue("a", "title")).toBe("Uno");
    expect(wrap.textContent).toContain("Save (1)");
  });

  test("detachGridPanel destroys the view and stops shell updates", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab();
    const controller = createGridController(tab, stubSource());
    await controller.load();
    renderGridMode(surfaceOf(wrap), tab);
    await flush();
    const table = FakeTabulator.instances.at(-1)!;

    detachGridPanel("primary");
    expect(table.destroyed).toBeTrue();
    expect(gridPanelMounted("primary", tab)).toBeFalse();

    controller.buffer.setCell("a", "title", "After detach");
    await flush();
    expect(wrap.textContent).not.toContain("Save (1)"); // Effect stopped.
  });
});

// ─── Saved views (plan §12 P7.2) ─────────────────────────────────────────────

const VIEW_GRID = "grid://collection/views";

/** Three columns and three rows, so hiding, sorting and grouping all have something to bite on. */
function viewSource(): GridSource {
  return {
    capabilities: { delete: false, insert: true, remotePaging: false, remoteSort: false },
    columns: async () => [
      { editable: true, field: "title", kind: "string", title: "Title" },
      { editable: true, field: "status", kind: "string", title: "Status" },
      { editable: true, field: "body", kind: "text", title: "Body" },
    ],
    commit: async () => ({ cells: [], deletes: [], inserts: [] }),
    id: VIEW_GRID,
    label: "views",
    rows: async () => ({
      rows: [
        { cells: { body: "b", status: "draft", title: "Beta" }, key: "b" },
        { cells: { body: "a", status: "live", title: "Alpha" }, key: "a" },
      ],
      total: 2,
    }),
  };
}

async function mountViewGrid() {
  const wrap = document.createElement("div");
  document.body.append(wrap);
  const tab = gridTab(VIEW_GRID);
  const controller = createGridController(tab, viewSource());
  await controller.load();
  renderGridMode(surfaceOf(wrap), tab);
  await flush();
  return { controller, tab, wrap };
}

const viewButton = (wrap: HTMLElement) =>
  wrap.querySelector(".jx-grid-view-button") as HTMLElement | null;
const popover = () => document.querySelector(".jx-grid-view-popover") as HTMLElement | null;

async function openViews(wrap: HTMLElement) {
  viewButton(wrap)!.click();
  await flush();
  return popover()!;
}

describe("saved views", () => {
  beforeEach(() => {
    clearGridLayout(VIEW_GRID);
    dialogAnswers.confirm = true;
    dialogAnswers.prompt = null;
    for (const host of document.querySelectorAll(".test-popover-host")) {
      host.remove();
    }
  });

  test("the button says View until a view is applied, then names it and flags drift", async () => {
    const { wrap } = await mountViewGrid();
    expect(viewButton(wrap)!.textContent!.trim()).toBe("View");

    dialogAnswers.prompt = "Recent";
    const box = await openViews(wrap);
    (
      [...box.querySelectorAll("sp-button")].find((b) =>
        b.textContent!.includes("Save view"),
      ) as HTMLElement
    ).click();
    await flush();
    expect(listSavedViews(VIEW_GRID).map((v) => v.name)).toEqual(["Recent"]);
    expect(viewButton(wrap)!.textContent!.trim()).toBe("Recent");

    saveGridLayout(VIEW_GRID, { hidden: ["body"] });
    viewButton(wrap)!.click(); // Re-open: the toolbar re-renders on the popover's bump.
    await flush();
    expect(viewButton(wrap)!.textContent!.trim()).toBe("Recent •");
  });

  test("hiding a column persists it and rebuilds the engine without that column", async () => {
    const { wrap } = await mountViewGrid();
    const before = FakeTabulator.instances.at(-1)!;
    const box = await openViews(wrap);

    const bodyBox = box.querySelector('input[data-field="body"]') as HTMLInputElement;
    expect(bodyBox.checked).toBeTrue();
    bodyBox.checked = false;
    bodyBox.dispatchEvent(new Event("change"));
    await flush();

    expect(loadGridLayout(VIEW_GRID)?.hidden).toEqual(["body"]);
    expect(before.destroyed).toBeTrue();
    const after = FakeTabulator.instances.at(-1)!;
    expect(after).not.toBe(before);
    const fields = (after.options.columns as { field?: string }[]).map((c) => c.field);
    expect(fields).toEqual(["title", "status"]);

    // And back: re-checking restores the column.
    const reopened = await openViews(wrap);
    const again = reopened.querySelector('input[data-field="body"]') as HTMLInputElement;
    expect(again.checked).toBeFalse();
    again.checked = true;
    again.dispatchEvent(new Event("change"));
    await flush();
    expect(loadGridLayout(VIEW_GRID)?.hidden).toEqual([]);
  });

  test("the sort and group selects drive the controller and persist", async () => {
    const { controller, wrap } = await mountViewGrid();
    const box = await openViews(wrap);

    const field = box.querySelector(".jx-grid-sort-field") as HTMLSelectElement;
    field.value = "title";
    field.dispatchEvent(new Event("change"));
    await flush();
    expect(controller.state.query).toEqual({ dir: "asc", orderBy: "title" });
    expect(loadGridLayout(VIEW_GRID)?.sort).toEqual({ dir: "asc", field: "title" });

    const dir = (popover()!.querySelector(".jx-grid-sort-dir") as HTMLSelectElement)!;
    expect(dir.hasAttribute("disabled")).toBeFalse();
    dir.value = "desc";
    dir.dispatchEvent(new Event("change"));
    await flush();
    expect(controller.state.query.dir).toBe("desc");

    const group = popover()!.querySelector(".jx-grid-group-field") as HTMLSelectElement;
    group.value = "status";
    group.dispatchEvent(new Event("change"));
    await flush();
    expect(controller.state.grouping).toBe("status");
    expect(loadGridLayout(VIEW_GRID)?.groupBy).toBe("status");
    expect(wrap.textContent).toContain("Grouped by Status · 2 groups");

    group.value = "";
    group.dispatchEvent(new Event("change"));
    await flush();
    expect(controller.state.grouping).toBeNull();
  });

  test("clearing the sort back to source order is reachable from the same select", async () => {
    const { controller, wrap } = await mountViewGrid();
    saveGridLayout(VIEW_GRID, { sort: { dir: "asc", field: "title" } });
    const box = await openViews(wrap);
    const field = box.querySelector(".jx-grid-sort-field") as HTMLSelectElement;
    field.value = "";
    field.dispatchEvent(new Event("change"));
    await flush();
    expect(loadGridLayout(VIEW_GRID)?.sort).toBeNull();
    expect(controller.state.query.orderBy).toBeUndefined();
  });

  test("the direction select does nothing while there is no sort to redirect", async () => {
    const { controller, wrap } = await mountViewGrid();
    const box = await openViews(wrap);
    const dir = box.querySelector(".jx-grid-sort-dir") as HTMLSelectElement;
    dir.value = "desc";
    dir.dispatchEvent(new Event("change"));
    await flush();
    expect(controller.state.query.dir).toBeUndefined();
  });

  test("applying a saved view puts every facet back at once", async () => {
    const { controller, wrap } = await mountViewGrid();
    saveGridLayout(VIEW_GRID, {
      filter: "alpha",
      groupBy: "status",
      hidden: ["body"],
      sort: { dir: "desc", field: "title" },
    });
    saveViewAs(VIEW_GRID, "Everything");
    // Now put the grid somewhere else entirely, then come back through the saved view.
    resetGridLayout(VIEW_GRID);
    controller.setGrouping(null);
    await controller.setSort(null);

    const box = await openViews(wrap);
    const row = box.querySelector(".jx-grid-view-name") as HTMLElement;
    expect(row.textContent!.trim()).toBe("Everything");
    row.click();
    await flush();

    expect(controller.state.grouping).toBe("status");
    expect(controller.state.query).toEqual({ dir: "desc", orderBy: "title" });
    expect(loadGridLayout(VIEW_GRID)?.hidden).toEqual(["body"]);
    const table = FakeTabulator.instances.at(-1)!;
    expect((table.options.columns as { field?: string }[]).map((c) => c.field)).toEqual([
      "title",
      "status",
    ]);
    expect(popover()).toBeNull(); // Applying closes the popover.
  });

  test("Reset forgets the layout and keeps the named views", async () => {
    const { controller, wrap } = await mountViewGrid();
    saveGridLayout(VIEW_GRID, { groupBy: "status", hidden: ["body"] });
    saveViewAs(VIEW_GRID, "Kept");
    controller.setGrouping("status");

    const box = await openViews(wrap);
    (
      [...box.querySelectorAll("sp-button")].find(
        (b) => b.textContent!.trim() === "Reset",
      ) as HTMLElement
    ).click();
    await flush();

    expect(loadGridLayout(VIEW_GRID)).toEqual({});
    expect(listSavedViews(VIEW_GRID).map((v) => v.name)).toEqual(["Kept"]);
    expect(controller.state.grouping).toBeNull();
  });

  test("deleting a view asks first, and a refusal keeps it", async () => {
    const { wrap } = await mountViewGrid();
    saveGridLayout(VIEW_GRID, {});
    saveViewAs(VIEW_GRID, "Doomed");

    dialogAnswers.confirm = false;
    const box = await openViews(wrap);
    (box.querySelector(".jx-grid-view-row sp-action-button") as HTMLElement).click();
    await flush();
    expect(listSavedViews(VIEW_GRID)).toHaveLength(1);

    dialogAnswers.confirm = true;
    (popover()!.querySelector(".jx-grid-view-row sp-action-button") as HTMLElement).click();
    await flush();
    expect(listSavedViews(VIEW_GRID)).toHaveLength(0);
  });

  test("an empty list says so instead of showing nothing", async () => {
    const { wrap } = await mountViewGrid();
    const box = await openViews(wrap);
    expect(box.textContent).toContain("No saved views yet");
  });

  test("cancelling the name prompt saves nothing", async () => {
    const { wrap } = await mountViewGrid();
    dialogAnswers.prompt = null;
    const box = await openViews(wrap);
    (
      [...box.querySelectorAll("sp-button")].find((b) =>
        b.textContent!.includes("Save view"),
      ) as HTMLElement
    ).click();
    await flush();
    expect(listSavedViews(VIEW_GRID)).toEqual([]);
  });

  test("the filter box persists and is restored with the rest of the view", async () => {
    const { wrap } = await mountViewGrid();
    const search = wrap.querySelector("sp-search") as HTMLInputElement;
    search.value = "alpha";
    search.dispatchEvent(new Event("input"));
    await flush();
    expect(loadGridLayout(VIEW_GRID)?.filter).toBe("alpha");
    expect(FakeTabulator.instances.at(-1)!.filter).not.toBeNull();
  });

  test("a stored sort, grouping and filter are applied when the engine first appears", async () => {
    saveGridLayout(VIEW_GRID, {
      filter: "beta",
      groupBy: "status",
      sort: { dir: "desc", field: "title" },
    });
    const { controller } = await mountViewGrid();
    expect(controller.state.query).toEqual({ dir: "desc", orderBy: "title" });
    expect(controller.state.grouping).toBe("status");
    expect(FakeTabulator.instances.at(-1)!.filter).not.toBeNull();
  });
});

describe("saved-view commands", () => {
  beforeEach(() => {
    clearGridLayout(VIEW_GRID);
    dialogAnswers.confirm = true;
    dialogAnswers.prompt = null;
  });

  const byId = (id: string) => gridViewCommands().find((command) => command.id === id)!;

  test("every record is a document-level palette verb", () => {
    const records = gridViewCommands();
    expect(records.map((r) => r.id).toSorted()).toEqual([
      "grid.applyView",
      "grid.deleteView",
      "grid.resetView",
      "grid.saveView",
    ]);
    for (const record of records) {
      expect(record.level).toBe("document");
      expect(record.menus).toEqual(["palette"]);
      expect(record.requires).toBe("a grid on screen");
      // Visible only inside a project, and enabled only with a grid on screen — two questions,
      // Asked separately, so a closed project hides the row and an open one explains the refusal.
      expect(record.when!({ project: { open: true } } as never)).toBeTrue();
      expect(record.when!({ project: { open: false } } as never)).toBeFalse();
      expect(record.enablement!({} as never)).toBeFalse();
    }
  });

  test("they are disabled, and refuse, when no grid is on screen", async () => {
    detachGridPanel("primary");
    const record = byId("grid.resetView");
    expect(record.enablement!({} as never)).toBeFalse();
    expect(() => record.run({} as never, undefined as never)).toThrow("needs a grid on screen");
  });

  test("save, apply, delete and reset go through the same store as the popover", async () => {
    const { controller, wrap } = await mountViewGrid();
    expect(byId("grid.saveView").enablement!({} as never)).toBeTrue();

    saveGridLayout(VIEW_GRID, { hidden: ["body"] });
    dialogAnswers.prompt = "By command";
    await byId("grid.saveView").run({} as never, undefined as never);
    expect(listSavedViews(VIEW_GRID).map((v) => v.name)).toEqual(["By command"]);

    resetGridLayout(VIEW_GRID);
    await byId("grid.applyView").run({} as never, { name: "By command" } as never);
    await flush();
    expect(loadGridLayout(VIEW_GRID)?.hidden).toEqual(["body"]);
    expect(wrap.querySelector(".jx-grid-view-button")!.textContent!.trim()).toBe("By command");

    await byId("grid.resetView").run({} as never, undefined as never);
    expect(loadGridLayout(VIEW_GRID)).toEqual({});
    expect(controller.state.grouping).toBeNull();

    await byId("grid.deleteView").run({} as never, { name: "By command" } as never);
    expect(listSavedViews(VIEW_GRID)).toEqual([]);
  });

  test("an unknown view name is refused by name, listing what the grid has", async () => {
    await mountViewGrid();
    saveGridLayout(VIEW_GRID, {});
    saveViewAs(VIEW_GRID, "Real");
    expect(() => byId("grid.applyView").run({} as never, { name: "ghost" } as never)).toThrow(
      /"ghost" is not a saved view of views — it has: Real/,
    );
  });

  test("registerGridViewCommands puts all four into a registry", () => {
    const ids: string[] = [];
    registerGridViewCommands({
      registerAll: (commands: readonly { id: string }[]) => ids.push(...commands.map((c) => c.id)),
    } as never);
    expect(ids).toHaveLength(4);
  });
});

describe("saved views — the awkward corners", () => {
  beforeEach(() => {
    clearGridLayout(VIEW_GRID);
    dialogAnswers.confirm = true;
    dialogAnswers.prompt = null;
    for (const host of document.querySelectorAll(".test-popover-host")) {
      host.remove();
    }
  });

  test("the name field refuses a blank in the dialog, not after it", async () => {
    const { wrap } = await mountViewGrid();
    dialogAnswers.prompt = "Named";
    const box = await openViews(wrap);
    (
      [...box.querySelectorAll("sp-button")].find((b) =>
        b.textContent!.includes("Save view"),
      ) as HTMLElement
    ).click();
    await flush();
    const validate = lastPromptOpts.validate as (candidate: string) => string;
    expect(validate("   ")).toBe("Name the view.");
    expect(validate("Named")).toBe("");
    expect(lastPromptOpts.message).toContain("saved for views");
  });

  test("a name storage cannot keep is reported, not silently dropped", async () => {
    const { wrap } = await mountViewGrid();
    // The dialog answered with something `saveViewAs` refuses — the same shape a storage-disabled
    // Browser produces, and the one path where the author must be told the view is not remembered.
    dialogAnswers.prompt = "   ";
    const box = await openViews(wrap);
    (
      [...box.querySelectorAll("sp-button")].find((b) =>
        b.textContent!.includes("Save view"),
      ) as HTMLElement
    ).click();
    await flush();
    expect(listSavedViews(VIEW_GRID)).toEqual([]);
    expect(wrap.querySelector(".jx-grid-view-button")!.textContent!.trim()).toBe("View");
  });

  test("one group is one group, not one groups", async () => {
    const { controller, wrap } = await mountViewGrid();
    controller.buffer.setCell("b", "status", "live");
    controller.setGrouping("status");
    await flush();
    expect(wrap.textContent).toContain("Grouped by Status · 1 group");
  });

  test("the search box's submit is swallowed so the shell is not navigated away", async () => {
    const { wrap } = await mountViewGrid();
    const search = wrap.querySelector("sp-search")!;
    const event = new Event("submit", { cancelable: true });
    search.dispatchEvent(event);
    expect(event.defaultPrevented).toBeTrue();
  });

  test("applying a view with the panel detached does not throw", async () => {
    const { wrap } = await mountViewGrid();
    saveGridLayout(VIEW_GRID, { hidden: ["body"] });
    saveViewAs(VIEW_GRID, "Detached");
    const box = await openViews(wrap);
    detachGridPanel("primary");
    (box.querySelector(".jx-grid-view-name") as HTMLElement).click();
    await flush();
    expect(loadGridLayout(VIEW_GRID)?.hidden).toEqual(["body"]);
  });
});
