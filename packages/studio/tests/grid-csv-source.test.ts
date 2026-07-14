import { installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { createCsvFileSource, fieldNamesForHeaders } from "../src/grid/sources/csv-file-source";

const PRODUCTS_CSV = 'sku,name,price,tags\nw-1,Widget,"$1,234.50","red, blue"\ng-2,Gadget,9,\n';

beforeEach(() => {
  resetStudioState();
});

describe("fieldNamesForHeaders", () => {
  test("dedupes duplicates and names empty headers positionally", () => {
    expect(fieldNamesForHeaders(["a", "a", "", " b "])).toEqual(["a", "a__2", "column3", " b "]);
  });
});

describe("createCsvFileSource — load", () => {
  test("infers columns and types rows without a schema", async () => {
    installMockPlatform({}, { "data/products.csv": PRODUCTS_CSV });
    const source = createCsvFileSource("data/products.csv");
    const columns = await source.columns();
    expect(columns.map((c) => c.field)).toEqual(["sku", "name", "price", "tags"]);
    expect(columns.find((c) => c.field === "price")!.kind).toBe("number");
    expect(columns.find((c) => c.field === "sku")!.pk).toBeTrue();

    const { rows, total } = await source.rows();
    expect(total).toBe(2);
    expect(rows[0]!.key).toBe("w-1");
    expect(rows[0]!.cells.price).toBe(1234.5);
    expect(rows[0]!.cells.name).toBe("Widget");
  });

  test("uses the content-type schema when the CSV backs a collection", async () => {
    installMockPlatform({}, { "data/products.csv": PRODUCTS_CSV });
    resetStudioState({
      projectConfig: {
        content: {
          products: {
            schema: {
              properties: {
                name: { type: "string" },
                price: { type: "number" },
                tags: { items: { type: "string" }, type: "array" },
              },
              required: ["name"],
            },
            source: "./data/products.csv",
          },
        },
      },
    });
    const source = createCsvFileSource("data/products.csv");
    const columns = await source.columns();
    expect(columns.find((c) => c.field === "tags")!.kind).toBe("array");
    expect(columns.find((c) => c.field === "name")!.required).toBeTrue();
    const { rows } = await source.rows();
    expect(rows[0]!.cells.tags).toEqual(["red", "blue"]);
  });

  test("falls back to index keys when no id-chain column is unique", async () => {
    installMockPlatform({}, { "dup.csv": "id,name\nx,A\nx,B\n" });
    const source = createCsvFileSource("dup.csv");
    const { rows } = await source.rows();
    expect(rows.map((r) => r.key)).toEqual(["0", "1"]);
    const columns = await source.columns();
    expect(columns.find((c) => c.field === "id")!.pk).toBeFalse();
  });
});

describe("createCsvFileSource — commit", () => {
  test("writes edited cells canonically while preserving untouched raw text", async () => {
    const { state } = installMockPlatform({}, { "p.csv": PRODUCTS_CSV });
    const source = createCsvFileSource("p.csv");
    await source.rows();

    const result = await source.commit({
      cells: [{ baseline: "Widget", field: "name", rowKey: "w-1", value: "Widget XL" }],
      deletes: [],
      inserts: [],
    });
    expect(result.cells[0]).toEqual({ field: "name", ok: true, rowKey: "w-1" });
    const written = state.files.get("p.csv")!;
    expect(written).toContain("Widget XL");
    expect(written).toContain('"$1,234.50"'); // Untouched cell keeps its raw formatting.
    expect(written.endsWith("\n")).toBeTrue();
  });

  test("applies inserts and deletes atomically and rekeys rows afterward", async () => {
    const { state } = installMockPlatform({}, { "p.csv": PRODUCTS_CSV });
    const source = createCsvFileSource("p.csv");
    await source.rows();

    const result = await source.commit({
      cells: [],
      deletes: [{ rowKey: "g-2" }],
      inserts: [{ cells: { name: "Doodad", price: 5, sku: "d-3", tags: ["new"] }, tempKey: "t1" }],
    });
    expect(result.inserts[0]!.ok).toBeTrue();
    expect(result.deletes[0]!.ok).toBeTrue();

    const { rows } = await source.rows();
    expect(rows.map((r) => r.key)).toEqual(["w-1", "d-3"]);
    expect(state.files.get("p.csv")).toContain("d-3,Doodad,5,new");
    expect(state.files.get("p.csv")).not.toContain("Gadget");
  });

  test("aborts the whole commit as stale when the file changed on disk", async () => {
    const { state } = installMockPlatform({}, { "stale.csv": "a\n1\n" });
    const source = createCsvFileSource("stale.csv");
    await source.rows();
    state.files.set("stale.csv", "a\n1\nexternal\n");

    const result = await source.commit({
      cells: [{ baseline: "1", field: "a", rowKey: "0", value: "2" }],
      deletes: [],
      inserts: [],
    });
    expect(result.cells[0]!.ok).toBeFalse();
    expect(result.cells[0]!.stale).toBeTrue();
    expect(state.files.get("stale.csv")).toBe("a\n1\nexternal\n"); // Never clobbered.
  });

  test("a deleted-underneath file also reads as stale", async () => {
    const { state } = installMockPlatform({}, { "gone.csv": "a\n1\n" });
    const source = createCsvFileSource("gone.csv");
    await source.rows();
    state.files.delete("gone.csv");
    const result = await source.commit({
      cells: [],
      deletes: [{ rowKey: "0" }],
      inserts: [],
    });
    expect(result.deletes[0]!.stale).toBeTrue();
  });
});

describe("createCsvFileSource — auxiliary surfaces", () => {
  test("serializeForSource previews pending edits without writing", async () => {
    const { state } = installMockPlatform({}, { "s.csv": "a,b\n1,2\n" });
    const source = createCsvFileSource("s.csv");
    await source.rows();
    const text = await source.serializeForSource!({
      cells: [{ baseline: "1", field: "a", rowKey: "0", value: "9" }],
      deletes: [],
      inserts: [],
    });
    expect(text).toBe("a,b\n9,2\n");
    expect(state.files.get("s.csv")).toBe("a,b\n1,2\n");
  });

  test("refresh re-reads external changes", async () => {
    const { state } = installMockPlatform({}, { "r.csv": "a\n1\n" });
    const source = createCsvFileSource("r.csv");
    const first = await source.rows();
    expect(first.total).toBe(1);
    state.files.set("r.csv", "a\n1\n2\n");
    const cached = await source.rows();
    expect(cached.total).toBe(1); // Cached until refreshed.
    await source.refresh!();
    const refreshed = await source.rows();
    expect(refreshed.total).toBe(2);
  });

  test("backingPaths points the whole grid at the file", () => {
    installMockPlatform({}, { "x.csv": "a\n" });
    const source = createCsvFileSource("x.csv");
    expect([...source.backingPaths!()]).toEqual([["x.csv", "*"]]);
    expect(source.label).toBe("x.csv");
    expect(source.capabilities.insert).toBeTrue();
  });
});
