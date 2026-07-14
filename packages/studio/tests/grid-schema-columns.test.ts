import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  cellToText,
  coerceCellInput,
  columnsFromSchema,
  inferColumnsFromRows,
  kindForProp,
  titleForField,
} from "../src/grid/schema-columns";
import type { GridColumn } from "../src/grid/grid-source";

const col = (kind: GridColumn["kind"]): GridColumn => ({
  editable: true,
  field: "f",
  kind,
  title: "F",
});

describe("kindForProp", () => {
  test("dispatches like schema-field-ui detectFieldType", () => {
    expect(kindForProp({ $ref: "#/content/posts" })).toBe("reference");
    expect(kindForProp({ enum: ["a", "b"] })).toBe("enum");
    expect(kindForProp({ type: "number" })).toBe("number");
    expect(kindForProp({ type: "integer" })).toBe("number");
    expect(kindForProp({ type: "boolean" })).toBe("boolean");
    expect(kindForProp({ items: { type: "string" }, type: "array" })).toBe("array");
    expect(kindForProp({ type: "object" })).toBe("readonly");
    expect(kindForProp({ format: "image", type: "string" })).toBe("image");
    expect(kindForProp({ format: "date", type: "string" })).toBe("date");
    expect(kindForProp({ format: "date-time", type: "string" })).toBe("date");
    expect(kindForProp({ type: "string" })).toBe("string");
    expect(kindForProp({})).toBe("string");
    expect(kindForProp({ maxLength: 500, type: "string" })).toBe("text");
    expect(kindForProp({ format: "markdown", type: "string" })).toBe("text");
  });

  test("array item format does not leak into the array kind", () => {
    expect(kindForProp({ format: "image", items: { format: "image" }, type: "array" })).toBe(
      "array",
    );
  });
});

describe("titleForField", () => {
  test("humanizes camelCase and snake_case", () => {
    expect(titleForField("publishDate")).toBe("Publish Date");
    expect(titleForField("cover_image")).toBe("Cover image");
    expect(titleForField("title")).toBe("Title");
  });
});

describe("columnsFromSchema", () => {
  const schema = {
    properties: {
      cover: { format: "image", type: "string" },
      date: { format: "date", type: "string" },
      draft: { type: "boolean" },
      slug: { type: "string" },
      tags: { items: { type: "string" }, type: "array" },
      title: { type: "string" },
    },
    required: ["title", "date"],
  };

  test("orders identity, required, then the rest; keeps declaration order within ranks", () => {
    const cols = columnsFromSchema(schema, { idField: "slug" });
    expect(cols.map((c) => c.field)).toEqual(["slug", "date", "title", "cover", "draft", "tags"]);
    expect(cols[0]!.pk).toBeTrue();
    expect(cols.find((c) => c.field === "title")!.required).toBeTrue();
    expect(cols.find((c) => c.field === "cover")!.required).toBeFalse();
  });

  test("marks readonly fields non-editable and keeps schema on each column", () => {
    const cols = columnsFromSchema(schema, { readonlyFields: ["slug"] });
    const slug = cols.find((c) => c.field === "slug")!;
    expect(slug.kind).toBe("readonly");
    expect(slug.editable).toBeFalse();
    expect(cols.find((c) => c.field === "tags")!.schema).toEqual(schema.properties.tags);
  });

  test("sizes enum columns from their values and tolerates empty schemas", () => {
    const cols = columnsFromSchema({
      properties: { status: { enum: ["draft", "published-elsewhere"], type: "string" } },
    });
    expect(cols[0]!.widthHint).toBeGreaterThan(90);
    expect(columnsFromSchema(null)).toEqual([]);
    expect(columnsFromSchema({})).toEqual([]);
  });
});

describe("inferColumnsFromRows", () => {
  test("sniffs kinds from sampled values", () => {
    const rows = [
      { count: "1,200", date: "2026-01-01", flag: "true", name: "A", tags: ["x"] },
      { count: "$300", date: "2026-02-03", flag: "false", name: "B", tags: ["y", "z"] },
    ];
    const cols = inferColumnsFromRows(rows);
    const byField = Object.fromEntries(cols.map((c) => [c.field, c.kind]));
    expect(byField).toEqual({
      count: "number",
      date: "date",
      flag: "boolean",
      name: "string",
      tags: "array",
    });
  });

  test("keys appear in first-seen order across rows; empties ignored for sniffing", () => {
    const cols = inferColumnsFromRows([{ a: "x" }, { a: "", b: "long".repeat(60) }]);
    expect(cols.map((c) => c.field)).toEqual(["a", "b"]);
    expect(cols[1]!.kind).toBe("text");
  });

  test("all-empty column defaults to string; sample limit respected", () => {
    const cols = inferColumnsFromRows([{ a: "" }, { a: null }]);
    expect(cols[0]!.kind).toBe("string");
    const many = Array.from({ length: 60 }, (_, i) => ({ n: i < 50 ? "1" : "not-a-number" }));
    expect(inferColumnsFromRows(many, 50)[0]!.kind).toBe("number");
  });
});

describe("coerceCellInput", () => {
  test("numbers strip currency and localize commas; blanks and junk clear to null", () => {
    const c = col("number");
    expect(coerceCellInput("$1,234.50", c)).toBe(1234.5);
    expect(coerceCellInput(" 42 ", c)).toBe(42);
    expect(coerceCellInput(7, c)).toBe(7);
    expect(coerceCellInput("", c)).toBeNull();
    expect(coerceCellInput("abc", c)).toBeNull();
    expect(coerceCellInput(Number.NaN, c)).toBeNull();
  });

  test("booleans accept true/boolean, everything else is false", () => {
    const c = col("boolean");
    expect(coerceCellInput("true", c)).toBeTrue();
    expect(coerceCellInput("TRUE", c)).toBeTrue();
    expect(coerceCellInput(true, c)).toBeTrue();
    expect(coerceCellInput("yes", c)).toBeFalse();
  });

  test("arrays comma-split strings and pass arrays through", () => {
    const c = col("array");
    expect(coerceCellInput("a, b ,,c", c)).toEqual(["a", "b", "c"]);
    expect(coerceCellInput("", c)).toEqual([]);
    expect(coerceCellInput(["x", 1], c)).toEqual(["x", "1"]);
  });

  test("references stay plain entry-id strings; $ref objects unwrap", () => {
    const c = col("reference");
    expect(coerceCellInput("jane-doe", c)).toBe("jane-doe");
    expect(coerceCellInput({ $ref: "jane-doe" }, c)).toBe("jane-doe");
    expect(coerceCellInput({ $ref: "" }, c)).toBeNull();
    expect(coerceCellInput("", c)).toBeNull();
  });

  test("strings pass through; empty clears to null; null stays null", () => {
    const c = col("string");
    expect(coerceCellInput("hello", c)).toBe("hello");
    expect(coerceCellInput("", c)).toBeNull();
    expect(coerceCellInput(null, c)).toBeNull();
    expect(coerceCellInput(undefined, c)).toBeNull();
  });
});

describe("cellToText", () => {
  test("projects every value shape to plain text", () => {
    expect(cellToText(null)).toBe("");
    expect(cellToText("x")).toBe("x");
    expect(cellToText(3.5)).toBe("3.5");
    expect(cellToText(true)).toBe("true");
    expect(cellToText(["a", "b"])).toBe("a, b");
    expect(cellToText({ $ref: "#/content/posts/hi" })).toBe("#/content/posts/hi");
  });
});
