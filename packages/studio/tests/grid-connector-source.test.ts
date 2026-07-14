import { installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  createConnectorSource,
  DATA_PAGE_SIZE,
  kindForSqlType,
} from "../src/grid/sources/connector-source";
import type { DataRowsQuery } from "../src/types";

const COLUMNS = [
  { name: "id", pk: true, type: "integer" },
  { name: "created_at", type: "text" },
  { name: "title", type: "text" },
  { name: "views", type: "integer" },
  { name: "published", type: "boolean" },
];

interface Calls {
  rows: DataRowsQuery[];
  updates: unknown[];
  inserts: unknown[];
  deletes: unknown[];
}

function installDataPlatform(total = 120): Calls {
  const calls: Calls = { deletes: [], inserts: [], rows: [], updates: [] };
  const allRows = Array.from({ length: total }, (_, i) => ({
    created_at: "2026-01-01",
    id: i + 1,
    published: i % 2 === 0,
    title: `Title ${i + 1}`,
    views: i * 10,
  }));
  installMockPlatform({
    dataDeleteRow: async (req) => {
      calls.deletes.push(req);
      return { ok: true };
    },
    dataInsertRow: async (req) => {
      calls.inserts.push(req);
      return { row: { id: 999, ...(req as { values: Record<string, unknown> }).values } };
    },
    dataRows: async (query: DataRowsQuery) => {
      calls.rows.push(query);
      const offset = query.offset ?? 0;
      return {
        columns: COLUMNS,
        rows: allRows.slice(offset, offset + (query.limit ?? 50)),
        total,
      };
    },
    dataUpdateRow: async (req) => {
      calls.updates.push(req);
      return { row: {} };
    },
  });
  return calls;
}

beforeEach(() => {
  resetStudioState();
});

describe("kindForSqlType", () => {
  test("maps SQL type names to grid kinds", () => {
    expect(kindForSqlType("INTEGER")).toBe("number");
    expect(kindForSqlType("double precision")).toBe("number");
    expect(kindForSqlType("numeric(10,2)")).toBe("number");
    expect(kindForSqlType("boolean")).toBe("boolean");
    expect(kindForSqlType("timestamp with time zone")).toBe("date");
    expect(kindForSqlType("text")).toBe("string");
    expect(kindForSqlType("varchar(80)")).toBe("string");
  });
});

describe("columns and rows", () => {
  test("columns from introspection: pk and timestamps read-only, SQL types mapped", async () => {
    installDataPlatform();
    const source = createConnectorSource("main", "posts");
    const columns = await source.columns();
    const byField = new Map(columns.map((c) => [c.field, c]));
    expect(byField.get("id")!.kind).toBe("readonly");
    expect(byField.get("id")!.pk).toBeTrue();
    expect(byField.get("created_at")!.kind).toBe("readonly");
    expect(byField.get("title")!.kind).toBe("string");
    expect(byField.get("views")!.kind).toBe("number");
    expect(byField.get("published")!.kind).toBe("boolean");
    expect(source.capabilities.remotePaging).toBeTrue();
    expect(source.capabilities.remoteSort).toBeTrue();
  });

  test("rows pass paging/ordering straight to DataRowsQuery and key by pk", async () => {
    const calls = installDataPlatform();
    const source = createConnectorSource("main", "posts");
    const page = await source.rows({ dir: "desc", limit: 50, offset: 50, orderBy: "views" });
    expect(calls.rows.at(-1)).toEqual({
      connection: "main",
      dir: "desc",
      limit: 50,
      offset: 50,
      orderBy: "views",
      table: "posts",
    });
    expect(page.total).toBe(120);
    expect(page.rows).toHaveLength(50);
    expect(page.rows[0]!.key).toBe("51");
    expect(page.rows[0]!.cells.views).toBe(500);
  });

  test("defaults page size and omits connection when unset", async () => {
    const calls = installDataPlatform();
    const source = createConnectorSource(undefined, "posts");
    await source.rows();
    expect(calls.rows.at(-1)).toEqual({ limit: DATA_PAGE_SIZE, offset: 0, table: "posts" });
    expect(source.id).toBe("grid://data/default/posts");
  });

  test("object cell values surface as JSON text; rows without a pk key by index", async () => {
    installMockPlatform({
      dataRows: async () => ({
        columns: COLUMNS,
        rows: [{ id: null, published: false, title: "A", views: { count: 3 } }],
        total: 1,
      }),
    });
    const source = createConnectorSource("main", "posts");
    const page = await source.rows();
    expect(page.rows[0]!.key).toBe("row-0");
    expect(page.rows[0]!.cells.views).toBe('{"count":3}');
  });

  test("refresh clears cached introspection so columns re-fetch", async () => {
    const calls = installDataPlatform();
    const source = createConnectorSource("main", "posts");
    await source.columns();
    expect(calls.rows).toHaveLength(1);
    await source.columns(); // Cached — no extra introspection query.
    expect(calls.rows).toHaveLength(1);
    await source.refresh?.();
    await source.columns();
    expect(calls.rows).toHaveLength(2);
  });
});

describe("commit", () => {
  test("merges cell edits into one dataUpdateRow per row, keyed on the raw pk", async () => {
    const calls = installDataPlatform();
    const source = createConnectorSource("main", "posts");
    await source.rows();

    const result = await source.commit({
      cells: [
        { baseline: "Title 1", field: "title", rowKey: "1", value: "First!" },
        { baseline: 0, field: "views", rowKey: "1", value: 42 },
        { baseline: "Title 2", field: "title", rowKey: "2", value: "Second" },
      ],
      deletes: [],
      inserts: [],
    });
    expect(result.cells.every((c) => c.ok)).toBeTrue();
    expect(calls.updates).toHaveLength(2);
    expect(calls.updates[0]).toEqual({
      connection: "main",
      pk: 1, // Numeric pk stays numeric.
      set: { title: "First!", views: 42 },
      table: "posts",
    });
  });

  test("inserts pass non-null values and return the backend pk as newKey", async () => {
    const calls = installDataPlatform();
    const source = createConnectorSource("main", "posts");
    await source.rows();
    const result = await source.commit({
      cells: [],
      deletes: [],
      inserts: [{ cells: { published: null, title: "Born", views: 1 }, tempKey: "t1" }],
    });
    expect(calls.inserts[0]).toEqual({
      connection: "main",
      table: "posts",
      values: { title: "Born", views: 1 },
    });
    expect(result.inserts[0]).toEqual({ newKey: "999", ok: true, tempKey: "t1" });
  });

  test("deletes go per row; unknown row keys error without an API call", async () => {
    const calls = installDataPlatform();
    const source = createConnectorSource("main", "posts");
    await source.rows();
    const result = await source.commit({
      cells: [{ baseline: null, field: "title", rowKey: "ghost", value: "x" }],
      deletes: [{ rowKey: "2" }, { rowKey: "ghost" }],
      inserts: [],
    });
    expect(calls.deletes).toHaveLength(1);
    expect(calls.deletes[0]).toEqual({ connection: "main", pk: 2, table: "posts" });
    expect(result.deletes.find((d) => d.rowKey === "ghost")!.error).toContain("primary key");
    expect(result.cells[0]!.error).toContain("primary key");
    expect(calls.updates).toHaveLength(0);
  });

  test("a failing dataInsertRow surfaces as an insert error", async () => {
    installMockPlatform({
      dataInsertRow: async () => {
        throw new Error("insert exploded");
      },
      dataRows: async () => ({ columns: COLUMNS, rows: [{ id: 1, title: "A" }], total: 1 }),
    });
    const source = createConnectorSource("main", "posts");
    await source.rows();
    const result = await source.commit({
      cells: [],
      deletes: [],
      inserts: [{ cells: { title: "Nope" }, tempKey: "t1" }],
    });
    expect(result.inserts[0]).toEqual({ error: "insert exploded", ok: false, tempKey: "t1" });
  });

  test("a failing dataDeleteRow surfaces as a delete error", async () => {
    installMockPlatform({
      dataDeleteRow: async () => {
        throw new Error("locked table");
      },
      dataRows: async () => ({ columns: COLUMNS, rows: [{ id: 7, title: "A" }], total: 1 }),
    });
    const source = createConnectorSource("main", "posts");
    await source.rows(); // Seeds pk 7 into the key map.
    const result = await source.commit({ cells: [], deletes: [{ rowKey: "7" }], inserts: [] });
    expect(result.deletes[0]).toEqual({ error: "locked table", ok: false, rowKey: "7" });
  });

  test("per-row API failures surface as row errors without aborting the batch", async () => {
    installDataPlatform();
    installMockPlatform({
      dataRows: async () => ({ columns: COLUMNS, rows: [{ id: 1, title: "A" }], total: 1 }),
      dataUpdateRow: async () => {
        throw new Error("constraint violation");
      },
    });
    const source = createConnectorSource("main", "posts");
    await source.rows();
    const result = await source.commit({
      cells: [{ baseline: "A", field: "title", rowKey: "1", value: "B" }],
      deletes: [],
      inserts: [],
    });
    expect(result.cells[0]!.ok).toBeFalse();
    expect(result.cells[0]!.error).toContain("constraint violation");
  });
});
