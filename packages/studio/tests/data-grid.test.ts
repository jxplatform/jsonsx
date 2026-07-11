/**
 * Tests for src/panels/data-grid.ts — the data-surface owner console: grid modal lifecycle
 * (connection/table pickers, pagination, inline edit keyed on pk, add-row footer, two-step delete),
 * the contributed-section actions slot (Test Connection / Push Schema / Open Data Grid), the push
 * dry-run confirmation dialog, and degradation when the platform lacks the data routes.
 */
import { flush, installMockPlatform, pointer, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "lit-html";
import { initLayers } from "../src/ui/layers";
import {
  closeDataGrid,
  DATA_GRID_PAGE_SIZE,
  dataSectionActions,
  isDataGridAvailable,
  openDataGrid,
  resetDataGridState,
  startPush,
} from "../src/panels/data-grid";
import type { DataPushResult, DataRowsQuery, StudioPlatform } from "../src/types";
import type { SectionActionsContext } from "../src/settings/contributed-section";

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

function modalLayer(): HTMLElement {
  return document.querySelector("#layer-modal") as HTMLElement;
}

function gridEl(): HTMLElement | null {
  return modalLayer().querySelector(".data-grid-modal");
}

function pushDialogEl(): HTMLElement | null {
  return modalLayer().querySelector(".push-dialog");
}

function textOf(selector: string, scope: HTMLElement | null = gridEl()): string {
  return scope?.querySelector(selector)?.textContent?.trim() ?? "";
}

interface Calls {
  rows: DataRowsQuery[];
  updates: unknown[];
  inserts: unknown[];
  deletes: unknown[];
  pushes: Record<string, unknown>[];
  tests: string[];
}

const COLUMNS = [
  { name: "id", pk: true, type: "text" },
  { name: "created_at", type: "text" },
  { name: "title", type: "text" },
  { name: "views", type: "integer" },
];

function makeRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    created_at: "2026-01-01",
    id: `r${i}`,
    title: `Title ${i}`,
    views: i,
  }));
}

interface InstallOptions {
  total?: number;
  failRows?: boolean;
  failConnections?: boolean;
  dryPlan?: DataPushResult;
  overrides?: Partial<StudioPlatform>;
}

function installDataPlatform(opts: InstallOptions = {}): Calls {
  const calls: Calls = { deletes: [], inserts: [], pushes: [], rows: [], tests: [], updates: [] };
  const total = opts.total ?? 2;
  const allRows = makeRows(total);
  installMockPlatform({
    dataConnections: async () => {
      if (opts.failConnections) {
        throw new Error("no connections route");
      }
      return {
        connections: [
          {
            configured: true,
            connector: { kind: "sqlite", provider: "sqlite" },
            isDefault: true,
            missingSecrets: [],
            name: "main",
            provider: "sqlite",
            settings: {},
            tables: ["posts", "user"],
          },
          {
            configured: true,
            connector: null,
            isDefault: false,
            missingSecrets: [],
            name: "empty",
            provider: "sqlite",
            settings: {},
            tables: [],
          },
        ],
      };
    },
    dataConnectionTest: async (connection) => {
      calls.tests.push(connection);
      return connection === "main" ? { ok: true } : { error: "no db", ok: false };
    },
    dataDeleteRow: async (req) => {
      calls.deletes.push(req);
      return { ok: true };
    },
    dataInsertRow: async (req) => {
      calls.inserts.push(req);
      return { row: { id: "new", ...req.values } };
    },
    dataPush: async (pushOpts) => {
      calls.pushes.push({ ...pushOpts });
      if (pushOpts?.dryRun) {
        return (
          opts.dryPlan ?? {
            applied: false,
            plan: [{ kind: "createTable", summary: 'Create table "posts"', table: "posts" }],
            warnings: ["type drift on posts.views"],
          }
        );
      }
      return {
        applied: true,
        plan: [{ kind: "createTable", summary: 'Create table "posts"', table: "posts" }],
      };
    },
    dataRows: async (query) => {
      calls.rows.push(query);
      if (opts.failRows) {
        throw new Error("table vanished");
      }
      const offset = query.offset ?? 0;
      return {
        columns: COLUMNS,
        rows: allRows.slice(offset, offset + (query.limit ?? 50)),
        total,
      };
    },
    dataUpdateRow: async (req) => {
      calls.updates.push(req);
      const base = allRows.find((r) => r.id === (req as { pk: unknown }).pk) ?? {};
      return { row: { ...base, ...(req as { set: Record<string, unknown> }).set } };
    },
    ...opts.overrides,
  });
  return calls;
}

beforeEach(() => {
  resetDataGridState();
  resetStudioState();
});

afterEach(() => {
  resetDataGridState();
});

// ─── Grid modal ───────────────────────────────────────────────────────────────

describe("data grid modal", () => {
  test("degrades to a no-op when the platform lacks dataRows", async () => {
    installMockPlatform();
    expect(isDataGridAvailable()).toBe(false);
    await openDataGrid();
    expect(gridEl()).toBeNull();
  });

  test("renders connections, tables, columns (pk badge), rows, and the range", async () => {
    installDataPlatform();
    expect(isDataGridAvailable()).toBe(true);
    await openDataGrid();
    await flush();

    const grid = gridEl()!;
    expect(grid).not.toBeNull();
    const headers = [...grid.querySelectorAll("thead th")].map((th) =>
      th.textContent?.replaceAll(/\s+/g, " ").trim(),
    );
    expect(headers.slice(0, 4)).toEqual(["id pk", "created_at", "title", "views"]);
    expect(grid.querySelector(".data-grid-pk")).not.toBeNull();
    expect(grid.querySelectorAll("tbody tr")).toHaveLength(2);
    // Pk and timestamp columns are read-only; title/views are editable inputs.
    const firstRow = grid.querySelector("tbody tr")!;
    expect(firstRow.querySelectorAll(".data-grid-readonly")).toHaveLength(2);
    expect(firstRow.querySelectorAll("input.data-grid-cell")).toHaveLength(2);
    expect(textOf(".data-grid-range")).toBe("1–2 of 2");
  });

  test("commits an inline cell edit via dataUpdateRow keyed on the pk", async () => {
    const calls = installDataPlatform();
    await openDataGrid();
    await flush();

    const cell = gridEl()!.querySelector("tbody tr input.data-grid-cell") as HTMLInputElement;
    cell.value = "Renamed";
    cell.dispatchEvent(new Event("change"));
    await flush();

    expect(calls.updates).toEqual([
      { connection: "main", pk: "r0", set: { title: "Renamed" }, table: "posts" },
    ]);
    // The grid reflects the backend's returned row without a reload.
    expect(calls.rows).toHaveLength(1);
    const firstCell = gridEl()!.querySelector("tbody tr input.data-grid-cell") as HTMLInputElement;
    expect(firstCell.value).toBe("Renamed");
  });

  test("unchanged cell edits do not hit the backend", async () => {
    const calls = installDataPlatform();
    await openDataGrid();
    await flush();
    const cell = gridEl()!.querySelector("tbody tr input.data-grid-cell") as HTMLInputElement;
    cell.dispatchEvent(new Event("change"));
    await flush();
    expect(calls.updates).toEqual([]);
  });

  test("adds a row from the footer draft", async () => {
    const calls = installDataPlatform();
    await openDataGrid();
    await flush();

    const draft = gridEl()!.querySelector("tfoot input.data-grid-draft") as HTMLInputElement;
    expect(draft.getAttribute("placeholder")).toBe("title");
    draft.value = "Fresh";
    draft.dispatchEvent(new Event("input"));
    pointer(gridEl()!.querySelector(".data-grid-add")!, "click");
    await flush();

    expect(calls.inserts).toEqual([
      { connection: "main", table: "posts", values: { title: "Fresh" } },
    ]);
    // The page reloads after an insert.
    expect(calls.rows).toHaveLength(2);
  });

  test("deletes a row behind a two-step confirm", async () => {
    const calls = installDataPlatform();
    await openDataGrid();
    await flush();

    const del = () => gridEl()!.querySelector(".data-grid-delete") as HTMLElement;
    expect(del().textContent?.trim()).toBe("Delete");
    pointer(del(), "click");
    await flush();
    expect(calls.deletes).toEqual([]);
    expect(del().textContent?.trim()).toBe("Confirm?");

    pointer(del(), "click");
    await flush();
    expect(calls.deletes).toEqual([{ connection: "main", pk: "r0", table: "posts" }]);
    expect(calls.rows).toHaveLength(2);
  });

  test("pages 50 rows at a time", async () => {
    const calls = installDataPlatform({ total: 120 });
    await openDataGrid();
    await flush();

    expect(calls.rows[0]).toMatchObject({ limit: DATA_GRID_PAGE_SIZE, offset: 0 });
    expect(textOf(".data-grid-range")).toBe("1–50 of 120");
    expect(gridEl()!.querySelector(".data-grid-prev")!.hasAttribute("disabled")).toBe(true);

    pointer(gridEl()!.querySelector(".data-grid-next")!, "click");
    await flush();
    expect(calls.rows[1]).toMatchObject({ limit: DATA_GRID_PAGE_SIZE, offset: 50 });
    expect(textOf(".data-grid-range")).toBe("51–100 of 120");

    pointer(gridEl()!.querySelector(".data-grid-prev")!, "click");
    await flush();
    expect(calls.rows[2]).toMatchObject({ offset: 0 });
  });

  test("switching table and connection resets paging and reloads", async () => {
    const calls = installDataPlatform();
    await openDataGrid();
    await flush();

    const tables = gridEl()!.querySelector(".data-grid-tables") as HTMLInputElement;
    tables.value = "user";
    tables.dispatchEvent(new Event("change"));
    await flush();
    expect(calls.rows.at(-1)).toMatchObject({ connection: "main", table: "user" });

    const connections = gridEl()!.querySelector(".data-grid-connection") as HTMLInputElement;
    connections.value = "empty";
    connections.dispatchEvent(new Event("change"));
    await flush();
    // The empty connection has no tables: the grid explains instead of querying.
    expect(textOf(".data-grid-empty")).toContain("No tables");
  });

  test("surfaces row-load errors and recovers state on close", async () => {
    installDataPlatform({ failRows: true });
    await openDataGrid();
    await flush();
    expect(textOf(".data-grid-error")).toBe("table vanished");
    closeDataGrid();
    expect(gridEl()).toBeNull();
  });

  test("honors preselect and ignores a second open while one is up", async () => {
    const calls = installDataPlatform();
    await openDataGrid({ connection: "main", table: "user" });
    await flush();
    expect(calls.rows[0]).toMatchObject({ table: "user" });
    await openDataGrid({ table: "posts" });
    expect(calls.rows).toHaveLength(1);
  });

  test("a failing connections route leaves an explanatory empty grid", async () => {
    installDataPlatform({ failConnections: true });
    await openDataGrid();
    await flush();
    expect(textOf(".data-grid-empty")).toContain("No tables");
  });
});

// ─── Section actions ──────────────────────────────────────────────────────────

function mountActions(sectionKey: string, selected: string | null) {
  const actions = dataSectionActions(sectionKey);
  expect(actions).not.toBeNull();
  const container = document.createElement("div");
  const ctx: SectionActionsContext = {
    rerender: () => render(actions!(ctx), container),
    sectionKey,
    selected,
  };
  render(actions!(ctx), container);
  return container;
}

describe("data section actions", () => {
  test("only data-domain sections with a data-capable platform get actions", () => {
    installDataPlatform();
    expect(dataSectionActions("content")).toBeNull();
    expect(dataSectionActions("connections")).not.toBeNull();
    expect(dataSectionActions("data")).not.toBeNull();
    installMockPlatform();
    expect(dataSectionActions("connections")).toBeNull();
  });

  test("Test Connection is selection-scoped and reports the probe result", async () => {
    const calls = installDataPlatform();
    const none = mountActions("connections", null);
    expect(none.querySelector(".data-action-test")!.hasAttribute("disabled")).toBe(true);

    const container = mountActions("connections", "main");
    const testButton = container.querySelector(".data-action-test")!;
    expect(testButton.hasAttribute("disabled")).toBe(false);
    pointer(testButton, "click");
    await flush();
    expect(calls.tests).toEqual(["main"]);
    const result = container
      .querySelector(".data-test-result.ok")!
      .textContent!.replaceAll(/\s+/g, " ")
      .trim();
    expect(result).toBe("main: connected");
  });

  test("failed probes render the error", async () => {
    installDataPlatform();
    const container = mountActions("connections", "empty");
    pointer(container.querySelector(".data-action-test")!, "click");
    await flush();
    expect(container.querySelector(".data-test-result.failed")!.textContent).toContain("no db");
  });

  test("the data section offers Push and Open Data Grid without Test", async () => {
    installDataPlatform();
    const container = mountActions("data", null);
    expect(container.querySelector(".data-action-test")).toBeNull();
    expect(container.querySelector(".data-action-push")).not.toBeNull();
    pointer(container.querySelector(".data-action-grid")!, "click");
    await flush();
    expect(gridEl()).not.toBeNull();
  });
});

// ─── Push dialog ──────────────────────────────────────────────────────────────

describe("push dialog", () => {
  test("dry-runs first, shows the plan + warnings, and applies only on confirm", async () => {
    const calls = installDataPlatform();
    const container = mountActions("connections", "main");
    pointer(container.querySelector(".data-action-push")!, "click");
    await flush();

    const dialog = pushDialogEl()!;
    expect(dialog).not.toBeNull();
    expect(calls.pushes).toEqual([{ connection: "main", dryRun: true }]);
    const steps = [...dialog.querySelectorAll(".push-step")].map((s) => s.textContent?.trim());
    expect(steps).toEqual(['Create table "posts"']);
    expect(textOf(".push-dialog-warning", dialog)).toContain("type drift");

    pointer(dialog.querySelector(".push-apply")!, "click");
    await flush();
    expect(calls.pushes).toEqual([{ connection: "main", dryRun: true }, { connection: "main" }]);
    expect(textOf(".push-dialog-status", pushDialogEl())).toBe("Schema applied.");

    pointer(pushDialogEl()!.querySelector(".push-cancel")!, "click");
    expect(pushDialogEl()).toBeNull();
  });

  test("an empty plan reads as nothing-to-push with no Apply", async () => {
    const calls = installDataPlatform({ dryPlan: { applied: false, plan: [] } });
    await startPush(undefined, () => {});
    await flush();
    const dialog = pushDialogEl()!;
    expect(textOf(".push-dialog-status", dialog)).toContain("Nothing to push");
    expect(dialog.querySelector(".push-apply")).toBeNull();
    expect(calls.pushes).toEqual([{ dryRun: true }]);
    pointer(dialog.querySelector(".push-cancel")!, "click");
    expect(pushDialogEl()).toBeNull();
  });

  test("dry-run errors surface in the dialog and only one dialog opens at a time", async () => {
    installDataPlatform({
      dryPlan: { applied: false, errors: ["remote: unreachable"], plan: [] },
    });
    await startPush(undefined, () => {});
    await startPush(undefined, () => {});
    await flush();
    expect(modalLayer().querySelectorAll(".push-dialog")).toHaveLength(1);
    expect(textOf(".push-dialog-error", pushDialogEl())).toBe("remote: unreachable");
  });
});
