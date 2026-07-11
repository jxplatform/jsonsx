import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Csv, coerceCSVRows, parseCSV } from "../src/csv";

const TMP = resolve(import.meta.dir, "__test-csv__");

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

describe("parseCSV", () => {
  test("parses simple rows with header mapping", () => {
    const rows = parseCSV("sku,name,price\nA-1,Widget,9.99\nB-2,Gadget,19.99");
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ name: "Widget", price: "9.99", sku: "A-1" });
  });

  test("handles quoted fields with commas", () => {
    const rows = parseCSV('name,desc\n"Widget, blue",Nice');
    expect(rows[0]!.name).toBe("Widget, blue");
  });

  test("handles quoted newlines and escaped quotes", () => {
    const rows = parseCSV('name,desc\n"Line1\nLine2",Simple\n"Has ""quotes""",Plain');
    expect(rows.length).toBe(2);
    expect(rows[0]!.name).toBe("Line1\nLine2");
    expect(rows[1]!.name).toBe('Has "quotes"');
  });

  test("handles CRLF line endings", () => {
    const rows = parseCSV("a,b\r\n1,2\r\n3,4");
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(parseCSV("")).toEqual([]);
  });
});

describe("coerceCSVRows", () => {
  const schema = {
    properties: {
      active: { type: "boolean" },
      price: { type: "number" },
      tags: { type: "array" },
    },
  };

  test("coerces numbers, stripping currency symbols and commas", () => {
    const entries = coerceCSVRows([{ id: "x", price: "$1,234.50" }], schema);
    expect(entries[0]!.data.price).toBe(1234.5);
  });

  test("empty number cells become null", () => {
    const entries = coerceCSVRows([{ id: "x", price: "" }], schema);
    expect(entries[0]!.data.price).toBeNull();
  });

  test("non-numeric number cells become null", () => {
    const entries = coerceCSVRows([{ id: "x", price: "n/a" }], schema);
    expect(entries[0]!.data.price).toBeNull();
  });

  test("coerces booleans — only 'true' is true", () => {
    const entries = coerceCSVRows(
      [
        { active: "true", id: "a" },
        { active: "yes", id: "b" },
      ],
      schema,
    );
    expect(entries[0]!.data.active).toBe(true);
    expect(entries[1]!.data.active).toBe(false);
  });

  test("coerces arrays — comma split, trimmed, empties dropped", () => {
    const entries = coerceCSVRows([{ id: "a", tags: "one, two , ,three" }], schema);
    expect(entries[0]!.data.tags).toEqual(["one", "two", "three"]);
  });

  test("id fallback chain: id → sku → slug → Slug → index", () => {
    expect(coerceCSVRows([{ id: "i", sku: "s" }])[0]!.id).toBe("i");
    expect(coerceCSVRows([{ sku: "s", slug: "sl" }])[0]!.id).toBe("s");
    expect(coerceCSVRows([{ slug: "sl" }])[0]!.id).toBe("sl");
    expect(coerceCSVRows([{ Slug: "SL" }])[0]!.id).toBe("SL");
    expect(coerceCSVRows([{ name: "n" }])[0]!.id).toBe("0");
  });

  test("explicit idField wins over the fallback chain", () => {
    const entries = coerceCSVRows([{ code: "c", id: "i" }], undefined, "code");
    expect(entries[0]!.id).toBe("c");
  });
});

describe("Csv.parse", () => {
  test("parses and coerces in one step", () => {
    const entries = Csv.parse("sku,name,price\nWIDGET-1,Blue Widget,9.99", {
      schema: { properties: { price: { type: "number" } } },
    });
    expect(entries.length).toBe(1);
    expect(entries[0]!.id).toBe("WIDGET-1");
    expect(entries[0]!.data.price).toBe(9.99);
    expect(entries[0]!.body).toBeNull();
  });
});

describe("Csv.discover / Csv.load / resolve", () => {
  mkdirSync(resolve(TMP, "data"), { recursive: true });
  writeFileSync(resolve(TMP, "data/catalog.csv"), "sku,name,price\nA-1,Widget,9.99");
  writeFileSync(resolve(TMP, "data/extra.csv"), "sku,name\nB-2,Gadget");
  writeFileSync(resolve(TMP, "data/notes.txt"), "not csv");

  test("discover lists .csv files in a directory", async () => {
    const files = await Csv.discover("./data", { baseDir: TMP });
    expect(files.length).toBe(2);
    expect(files.every((f) => f.endsWith(".csv"))).toBe(true);
  });

  test("discover returns a single existing file as-is", async () => {
    const files = await Csv.discover("./data/catalog.csv", { baseDir: TMP });
    expect(files.length).toBe(1);
    expect(files[0]!.endsWith("catalog.csv")).toBe(true);
  });

  test("discover returns [] for a missing path", async () => {
    const files = await Csv.discover("./data/missing.csv", { baseDir: TMP });
    expect(files).toEqual([]);
  });

  test("load reads a file into coerced entries", async () => {
    const entries = await Csv.load(resolve(TMP, "data/catalog.csv"), {
      schema: { properties: { price: { type: "number" } } },
    });
    expect(entries[0]!.id).toBe("A-1");
    expect(entries[0]!.data.price).toBe(9.99);
  });

  test("instance resolve loads the configured source", async () => {
    const csv = new Csv({ basePath: TMP, src: "./data/catalog.csv" });
    const entries = await csv.resolve();
    expect(entries.length).toBe(1);
    expect(entries[0]!.data.name).toBe("Widget");
  });
});
