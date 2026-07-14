import { flush, installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
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
    };
  },
  showConfirmDialog: async () => true,
  showDialog: async () => null,
}));
void mock.module("../src/ui/progress-modal.js", () => ({
  showProgressModal: () => ({ done: () => {}, fail: () => {}, setStatus: () => {} }),
}));
void mock.module("../src/panels/statusbar.js", () => ({ statusMessage: () => {} }));

const { createGridController } = await import("../src/grid/grid-controller");
const { detachGridPanel, gridPanelMounted, renderGridMode } =
  await import("../src/grid/grid-panel");

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
  detachGridPanel();
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

    renderGridMode(wrap, tab);
    await flush();

    expect(wrap.querySelector(".jx-grid-toolbar")).not.toBeNull();
    expect(wrap.querySelector(".jx-grid-host")).not.toBeNull();
    expect(wrap.textContent).toContain("1 row");
    expect(gridPanelMounted(tab)).toBeTrue();

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
    renderGridMode(wrap, tab);
    await flush();
    expect(wrap.textContent).not.toContain("no grid source");
    expect(wrap.textContent).toContain("1 row");
  });

  test("tabs without a controller render a friendly placeholder", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab("grid://collection/orphan");
    renderGridMode(wrap, tab);
    await flush();
    expect(wrap.textContent).toContain("no grid source");
    expect(gridPanelMounted(tab)).toBeFalse();
  });

  test("same-tab re-render is a no-op; switching tabs rebuilds the view", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tabA = gridTab("grid://collection/a");
    const controllerA = createGridController(tabA, stubSource("grid://collection/a"));
    await controllerA.load();
    renderGridMode(wrap, tabA);
    await flush();
    const firstCount = FakeTabulator.instances.length;
    renderGridMode(wrap, tabA);
    await flush();
    expect(FakeTabulator.instances.length).toBe(firstCount);

    const tabB = gridTab("grid://collection/b");
    const controllerB = createGridController(tabB, stubSource("grid://collection/b"));
    await controllerB.load();
    renderGridMode(wrap, tabB);
    await flush();
    expect(FakeTabulator.instances.length).toBe(firstCount + 1);
    expect(FakeTabulator.instances.at(-2)!.destroyed).toBeTrue();
    expect(gridPanelMounted(tabA)).toBeFalse();
    expect(gridPanelMounted(tabB)).toBeTrue();
  });

  test("Save button reflects the dirty count and triggers controller.save", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab();
    const source = stubSource();
    const controller = createGridController(tab, source);
    await controller.load();
    renderGridMode(wrap, tab);
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
    renderGridMode(wrap, tab);
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
    renderGridMode(wrap, tab);
    await flush();
    expect(wrap.textContent).toContain("rewrites frontmatter");

    detachGridPanel();
    closeAllTabs();
    const csvTab = openTab({
      capabilities: { modes: ["grid", "source"] },
      document: { tagName: "div" },
      documentPath: "data.csv",
      id: "data.csv",
    });
    const csvController = createGridController(csvTab, stubSource("data.csv"));
    await csvController.load();
    renderGridMode(wrap, csvTab);
    await flush();
    expect(wrap.textContent).not.toContain("rewrites frontmatter");
  });

  test("toolbar actions drive the view: refresh, delete-selected, fill-down, search", async () => {
    const wrap = document.createElement("div");
    document.body.append(wrap);
    const tab = gridTab();
    const controller = createGridController(tab, stubSource());
    await controller.load();
    renderGridMode(wrap, tab);
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
    renderGridMode(wrap, tab);
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
    renderGridMode(wrap, tab);
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
    renderGridMode(wrap, tab);
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
    renderGridMode(wrap, tab);
    await flush();
    const table = FakeTabulator.instances.at(-1)!;

    detachGridPanel();
    expect(table.destroyed).toBeTrue();
    expect(gridPanelMounted(tab)).toBeFalse();

    controller.buffer.setCell("a", "title", "After detach");
    await flush();
    expect(wrap.textContent).not.toContain("Save (1)"); // Effect stopped.
  });
});
