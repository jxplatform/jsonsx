import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Csv, coerceCSVRows, parseCSV, rewriteCSV } from "../src/csv";

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

/*
 * The `rewrite` capability, which exists because a CSV collection has a parser and deliberately no
 * serializer (issue 246). Everything here is a byte-level assertion on purpose: the whole promise
 * is that a rename changes one cell and leaves the file otherwise untouched, and a test comparing
 * parsed rows would pass while the quoting, the padding and the line endings were all rewritten.
 */
describe("rewriteCSV", () => {
  const SRC =
    "Title,slug,image\r\n" +
    'Cedar Lane,"cedar-lane",/images/listing-1.jpg\r\n' +
    "Harbor View,harbor-view, /images/listing-1.jpg \r\n" +
    "Lakeview,lakeview,/images/listing-10.jpg\r\n";

  test("replaces every data cell holding the value, preserving quoting, padding and CRLF", () => {
    const out = rewriteCSV(SRC, [{ from: "/images/listing-1.jpg", to: "/images/villa.jpg" }]);
    expect(out).toBe(
      "Title,slug,image\r\n" +
        'Cedar Lane,"cedar-lane",/images/villa.jpg\r\n' +
        "Harbor View,harbor-view, /images/villa.jpg \r\n" +
        "Lakeview,lakeview,/images/listing-10.jpg\r\n",
    );
  });

  test("matches the whole cell, never a substring", () => {
    // `/images/listing-1.jpg` is a prefix of `/images/listing-10.jpg`. A textual replace would
    // Corrupt the third row into `/images/villa.jpg0.jpg`.
    const out = rewriteCSV(SRC, [{ from: "/images/listing-1.jpg", to: "/images/villa.jpg" }]);
    expect(out).toContain("/images/listing-10.jpg");
  });

  test("never rewrites the header row", () => {
    // The header names columns, not files. `parse` does not expose it as a value, so an edit
    // Derived from parse output cannot legitimately name it — and renaming a column would be a
    // Data-loss bug wearing a rename's clothes.
    expect(rewriteCSV(SRC, [{ from: "image", to: "photo" }])).toBe(SRC);
  });

  test("a value that would be misread unquoted is quoted, and quotes inside it are doubled", () => {
    const out = rewriteCSV("a,b\nx,hero.jpg\n", [{ from: "hero.jpg", to: 'my, "big" hero.jpg' }]);
    expect(out).toBe('a,b\nx,"my, ""big"" hero.jpg"\n');
  });

  test("a cell that was quoted stays quoted even when it no longer needs to be", () => {
    const out = rewriteCSV('a,b\nx,"hero, one.jpg"\n', [{ from: "hero, one.jpg", to: "hero.jpg" }]);
    expect(out).toBe('a,b\nx,"hero.jpg"\n');
  });

  test("a quoted cell spanning a newline is one cell, and its row indexing survives", () => {
    const src = 'a,b\n"line\none",hero.jpg\nz,other.jpg\n';
    expect(rewriteCSV(src, [{ from: "hero.jpg", to: "villa.jpg" }])).toBe(
      'a,b\n"line\none",villa.jpg\nz,other.jpg\n',
    );
  });

  test("no matching cell, a no-op edit, and an empty edit list all return the source unchanged", () => {
    expect(rewriteCSV(SRC, [{ from: "/images/nothing.jpg", to: "/x.jpg" }])).toBe(SRC);
    expect(rewriteCSV(SRC, [{ from: "/images/listing-1.jpg", to: "/images/listing-1.jpg" }])).toBe(
      SRC,
    );
    expect(rewriteCSV(SRC, [])).toBe(SRC);
  });

  test("a file with no trailing newline, and one with only a header, are both handled", () => {
    expect(rewriteCSV("a,b\nx,hero.jpg", [{ from: "hero.jpg", to: "villa.jpg" }])).toBe(
      "a,b\nx,villa.jpg",
    );
    expect(rewriteCSV("a,b\n", [{ from: "a", to: "z" }])).toBe("a,b\n");
    expect(rewriteCSV("", [{ from: "a", to: "z" }])).toBe("");
  });

  test("Csv.rewrite is the capability entry point and defaults to no edits", () => {
    expect(Csv.rewrite(SRC, [{ from: "/images/listing-1.jpg", to: "/x.jpg" }])).toContain("/x.jpg");
    expect(Csv.rewrite(SRC)).toBe(SRC);
  });
});
