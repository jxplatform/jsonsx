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
const { openCsvGridTab } = await import("../src/grid/grid-open");

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
