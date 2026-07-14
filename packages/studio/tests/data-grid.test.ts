/**
 * Tests for src/panels/data-grid.ts — the data-surface owner console actions: the
 * contributed-section actions slot (Test Connection / Push Schema / Open Data Grid — now the
 * grid-tab source picker), the push dry-run confirmation dialog, and degradation when the platform
 * lacks the data routes. Table editing itself is covered by the grid tests (grid-connector-source
 * and friends).
 */
import { flush, installMockPlatform, pointer, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "lit-html";
import { initLayers } from "../src/ui/layers";
import {
  dataSectionActions,
  isDataGridAvailable,
  resetDataGridState,
  startPush,
} from "../src/panels/data-grid";
import { closeAllTabs } from "../src/workspace/workspace";
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

function pushDialogEl(): HTMLElement | null {
  return modalLayer().querySelector(".push-dialog");
}

function textOf(selector: string, scope: HTMLElement | null): string {
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
  closeAllTabs();
});

afterEach(() => {
  resetDataGridState();
});

// ─── Grid modal ───────────────────────────────────────────────────────────────

describe("grid opening", () => {
  test("availability tracks the platform's dataRows member", () => {
    installMockPlatform();
    expect(isDataGridAvailable()).toBe(false);
    installDataPlatform();
    expect(isDataGridAvailable()).toBe(true);
  });

  test("Open Data Grid opens the grid-tab source picker listing connections' tables", async () => {
    installDataPlatform();
    resetStudioState({ projectConfig: { content: {} } });
    const actions = dataSectionActions("data")!;
    const host = document.createElement("div");
    document.body.append(host);
    render(
      actions({ rerender: () => {}, selected: null } as unknown as SectionActionsContext),
      host,
    );
    await flush();

    (host.querySelector(".data-action-grid") as HTMLElement).click();
    await flush();
    const picker = modalLayer().querySelector(".jx-grid-picker");
    expect(picker).not.toBeNull();
    const items = [...picker!.querySelectorAll("sp-menu-item")].map((m) => m.textContent?.trim());
    expect(items).toContain("Pages");
    expect(items).toContain("posts");
    expect(items).toContain("user");
    expect(items).toContain("No tables — push a schema first");
    host.remove();
    modalLayer().replaceChildren();
  });
});

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
    expect(modalLayer().querySelector(".jx-grid-picker")).not.toBeNull();
    modalLayer().replaceChildren();
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
