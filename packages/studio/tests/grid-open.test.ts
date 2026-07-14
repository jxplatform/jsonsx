import { installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { closeAllTabs, workspace } from "../src/workspace/workspace";

void mock.module("tabulator-tables", () => ({}));
void mock.module("tabulator-tables/dist/css/tabulator.min.css", () => ({}));
void mock.module("../src/format/format-host.js", () => ({
  formatForPath: (path: string | null) =>
    path?.endsWith(".csv") ? { extensions: [".csv"], name: "Csv" } : null,
  loadFormats: async () => {},
}));

const { getGridController } = await import("../src/grid/grid-controller");
const {
  openCollectionGrid,
  openConnectorGrid,
  openCsvGridTab,
  openGridSourcePicker,
  openPagesGrid,
} = await import("../src/grid/grid-open");
const { initLayers } = await import("../src/ui/layers");

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

beforeEach(() => {
  resetStudioState();
  closeAllTabs();
});

describe("openCsvGridTab", () => {
  test("opens a real file tab defaulting to grid mode with a source alternate", async () => {
    installMockPlatform({}, { "data/products.csv": "sku,name\nw-1,Widget\n" });
    const tab = await openCsvGridTab("data/products.csv");

    expect(tab.id).toBe("data/products.csv");
    expect(tab.documentPath).toBe("data/products.csv");
    expect(tab.capabilities.modes).toEqual(["grid", "source"]);
    expect(tab.session.ui.canvasMode).toBe("grid");
    expect(tab.doc.sourceFormat).toBe("Csv");
    expect(workspace.activeTabId).toBe(tab.id);

    const controller = getGridController(tab)!;
    expect(controller).not.toBeNull();
    // Give the fired load() a tick and confirm rows arrived.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(controller.state.total).toBe(1);
  });

  test("re-opening the same path activates the existing tab", async () => {
    installMockPlatform({}, { "a.csv": "x\n1\n" });
    const first = await openCsvGridTab("a.csv");
    workspace.activeTabId = null;
    const second = await openCsvGridTab("a.csv");
    // Workspace hands back the reactive proxy of the same tab — compare identity via ids.
    expect(second.id).toBe(first.id);
    expect(workspace.tabs.size).toBe(1);
    expect(workspace.activeTabId as string | null).toBe("a.csv");
  });

  test("openCollectionGrid opens a deduped virtual tab bound to the collection source", async () => {
    installMockPlatform({}, { "content/posts/a.md": "---\ntitle: A\n---\n" });
    resetStudioState({
      projectConfig: {
        content: { posts: { format: "Markdown", schema: {}, source: "./content/posts/" } },
      },
    });
    const tab = openCollectionGrid("posts");
    expect(tab.id).toBe("grid://collection/posts");
    expect(tab.documentPath).toBeNull();
    expect(tab.capabilities.modes).toEqual(["grid"]);
    expect(tab.session.ui.canvasMode).toBe("grid");
    expect(getGridController(tab)).not.toBeNull();

    workspace.activeTabId = null;
    const again = openCollectionGrid("posts");
    expect(again.id).toBe(tab.id);
    expect(workspace.tabs.size).toBe(1);
    expect(workspace.activeTabId as string | null).toBe(tab.id);
  });

  test("tolerates an unavailable format registry", async () => {
    void mock.module("../src/format/format-host.js", () => ({
      formatForPath: () => null,
      loadFormats: async () => {
        throw new Error("no server");
      },
    }));
    installMockPlatform({}, { "b.csv": "x\n1\n" });
    const tab = await openCsvGridTab("b.csv");
    expect(tab.doc.sourceFormat).toBeNull();
    expect(tab.session.ui.canvasMode).toBe("grid");
  });
});

describe("virtual grid openers", () => {
  test("openPagesGrid and openConnectorGrid open deduped virtual tabs", () => {
    installMockPlatform();
    resetStudioState({ projectConfig: { content: {} } });
    const pages = openPagesGrid();
    expect(pages.id).toBe("grid://pages");
    expect(getGridController(pages)).not.toBeNull();
    expect(openPagesGrid().id).toBe(pages.id);
    expect(workspace.tabs.size).toBe(1);

    const data = openConnectorGrid("main", "users");
    expect(data.id).toBe("grid://data/main/users");
    expect(data.capabilities.modes).toEqual(["grid"]);
    expect(workspace.tabs.size).toBe(2);
  });

  test("the source picker lists pages, collections, and connector tables", async () => {
    installMockPlatform({
      dataConnections: async () => ({
        connections: [
          {
            configured: true,
            isDefault: true,
            missingSecrets: [],
            name: "main",
            provider: "sqlite",
            settings: {},
            tables: ["users"],
          },
        ],
      }),
      dataRows: async () => ({ columns: [], rows: [], total: 0 }),
    });
    resetStudioState({
      projectConfig: {
        content: { posts: { format: "Markdown", schema: {}, source: "./content/posts/" } },
      },
    });
    await openGridSourcePicker();
    const picker = document.querySelector("#layer-modal .jx-grid-picker")!;
    expect(picker).not.toBeNull();
    const items = [...picker.querySelectorAll("sp-menu-item")].map((m) => m.textContent?.trim());
    expect(items).toEqual(["Pages", "Collection: posts", "users"]);

    // Picking entries closes the dialog and opens (deduped) tabs.
    const item = (label: string) =>
      [...document.querySelectorAll("#layer-modal sp-menu-item")].find(
        (m) => m.textContent?.trim() === label,
      ) as HTMLElement;
    item("users").click();
    expect(workspace.tabs.has("grid://data/main/users")).toBeTrue();

    await openGridSourcePicker();
    item("Pages").click();
    expect(workspace.tabs.has("grid://pages")).toBeTrue();

    await openGridSourcePicker();
    item("Collection: posts").click();
    expect(workspace.tabs.has("grid://collection/posts")).toBeTrue();

    // Re-picking activates the existing tabs instead of duplicating them.
    const before = workspace.tabs.size;
    openConnectorGrid("main", "users");
    openPagesGrid();
    expect(workspace.tabs.size).toBe(before);
    document.querySelector("#layer-modal")!.replaceChildren();
  });

  test("the picker dismisses on the dialog close event", async () => {
    installMockPlatform({ dataRows: async () => ({ columns: [], rows: [], total: 0 }) });
    resetStudioState({ projectConfig: { content: {} } });
    await openGridSourcePicker();
    const dialog = document.querySelector("#layer-modal sp-dialog-wrapper")!;
    expect(dialog).not.toBeNull();
    dialog.dispatchEvent(new Event("close"));
    expect(document.querySelector("#layer-modal .jx-grid-picker")).toBeNull();
  });

  test("a failing connections fetch degrades to no connector groups", async () => {
    installMockPlatform({
      dataConnections: async () => {
        throw new Error("data surface down");
      },
      dataRows: async () => ({ columns: [], rows: [], total: 0 }),
    });
    resetStudioState({ projectConfig: { content: {} } });
    await openGridSourcePicker();
    const picker = document.querySelector("#layer-modal .jx-grid-picker")!;
    const items = [...picker.querySelectorAll("sp-menu-item")].map((m) => m.textContent?.trim());
    expect(items).toEqual(["Pages"]);
    document.querySelector("#layer-modal")!.replaceChildren();
  });
});
