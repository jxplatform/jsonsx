/**
 * Command-args — the runtime half of every command's `args` JSON Schema.
 *
 * The assertions that matter are the MESSAGES, not the throws: plan §13.5's headline failure
 * ("names panel 'head'; the registry declares 'page'") is only a sentence a reader can act on
 * because {@link enumArg} prints the declared set. A test that only asserted `toThrow()` would let
 * that regress silently, so every refusal here is matched against its text.
 */

import { describe, expect, test } from "bun:test";
import {
  argsSchema,
  booleanArg,
  booleanProperty,
  boundedNumberArg,
  enumArg,
  enumProperty,
  nullablePathArg,
  numberArg,
  numberProperty,
  optionalStringArg,
  pathArg,
  pathProperty,
  stringArg,
  stringProperty,
} from "../src/commands/command-args";

describe("stringArg", () => {
  test("returns a non-empty string", () => {
    expect(stringArg("x.y", { name: "posts" }, "name")).toBe("posts");
  });

  test("refuses a missing value by name, and says which command asked", () => {
    expect(() => stringArg("data.expandRow", {}, "name")).toThrow(
      'command "data.expandRow" argument "name": expected a non-empty string, got missing',
    );
  });

  test("refuses the empty string — an unset field is not a value", () => {
    expect(() => stringArg("x.y", { name: "" }, "name")).toThrow("expected a non-empty string");
  });

  test("quotes back a wrong-typed value with its type", () => {
    expect(() => stringArg("x.y", { name: 7 }, "name")).toThrow("got number 7");
  });
});

describe("optionalStringArg", () => {
  test("undefined stays undefined", () => {
    expect(optionalStringArg("x.y", {}, "section")).toBeUndefined();
  });

  test("a present value is validated like a required one", () => {
    expect(optionalStringArg("x.y", { section: "head" }, "section")).toBe("head");
    expect(() => optionalStringArg("x.y", { section: null }, "section")).toThrow(
      "expected a non-empty string",
    );
  });
});

describe("numberArg", () => {
  test("accepts finite numbers, including zero and negatives", () => {
    expect(numberArg("x.y", { zoom: 0 }, "zoom")).toBe(0);
    expect(numberArg("x.y", { zoom: -1.5 }, "zoom")).toBe(-1.5);
  });

  test("refuses NaN and Infinity — neither is a zoom", () => {
    expect(() => numberArg("x.y", { zoom: Number.NaN }, "zoom")).toThrow(
      "expected a finite number",
    );
    expect(() => numberArg("x.y", { zoom: Number.POSITIVE_INFINITY }, "zoom")).toThrow(
      "expected a finite number",
    );
  });

  test("refuses a numeric string — coercion is what hides a mistyped step", () => {
    expect(() => numberArg("canvas.setZoom", { zoom: "0.8" }, "zoom")).toThrow('got "0.8"');
  });
});

describe("boundedNumberArg", () => {
  test("passes a value inside the interval through, endpoints included", () => {
    expect(boundedNumberArg("x.y", { zoom: 0.05 }, "zoom", 0.05, 5)).toBe(0.05);
    expect(boundedNumberArg("x.y", { zoom: 5 }, "zoom", 0.05, 5)).toBe(5);
  });

  test("REJECTS rather than clamping, and names the range", () => {
    expect(() => boundedNumberArg("canvas.setZoom", { zoom: 10 }, "zoom", 0.05, 5)).toThrow(
      'command "canvas.setZoom" argument "zoom": 10 is outside the supported range 0.05–5',
    );
    expect(() => boundedNumberArg("canvas.setZoom", { zoom: 0 }, "zoom", 0.05, 5)).toThrow(
      "outside the supported range",
    );
  });
});

describe("booleanArg", () => {
  test("false is a value, not an absence", () => {
    expect(booleanArg("view.setAssistant", { open: false }, "open")).toBe(false);
    expect(booleanArg("view.setAssistant", { open: true }, "open")).toBe(true);
  });

  test("refuses a missing flag — a setter with a default is a toggle in disguise", () => {
    expect(() => booleanArg("view.setAssistant", {}, "open")).toThrow(
      'command "view.setAssistant" argument "open": expected a boolean, got missing',
    );
  });

  test('refuses the string "false"', () => {
    expect(() => booleanArg("x.y", { open: "false" }, "open")).toThrow('got "false"');
  });
});

describe("enumArg", () => {
  const panels = ["files", "layers", "page"] as const;

  test("returns a declared value", () => {
    expect(enumArg("view.setActivity", { tab: "layers" }, "tab", panels)).toBe("layers");
  });

  test("the refusal prints the declared set — this is §13.5's headline message", () => {
    expect(() => enumArg("view.setActivity", { tab: "head" }, "tab", panels)).toThrow(
      'command "view.setActivity" argument "tab": "head" is not declared — declared: ' +
        "files, layers, page",
    );
  });

  test("a missing value is refused the same way", () => {
    expect(() => enumArg("view.setActivity", {}, "tab", panels)).toThrow(
      "missing is not declared — declared: files, layers, page",
    );
  });
});

describe("pathArg", () => {
  test("the empty array is the document root and is legal", () => {
    expect(pathArg("selection.set", { path: [] }, "path")).toEqual([]);
  });

  test("accepts mixed keys and indexes", () => {
    expect(pathArg("selection.set", { path: ["children", 0] }, "path")).toEqual(["children", 0]);
  });

  test("refuses a non-array", () => {
    expect(() => pathArg("selection.set", { path: "children/0" }, "path")).toThrow(
      "expected an array of path segments",
    );
  });

  test("refuses an array holding a non-segment", () => {
    expect(() => pathArg("selection.set", { path: ["children", {}] }, "path")).toThrow(
      "expected an array of path segments",
    );
  });
});

describe("nullablePathArg", () => {
  test("null clears the selection", () => {
    expect(nullablePathArg("selection.set", { path: null }, "path")).toBeNull();
  });

  test("anything else goes through pathArg", () => {
    expect(nullablePathArg("selection.set", { path: [1] }, "path")).toEqual([1]);
    expect(() => nullablePathArg("selection.set", { path: 3 }, "path")).toThrow(
      "expected an array of path segments",
    );
  });
});

describe("schema fragments", () => {
  test("argsSchema requires every property by default and forbids extras", () => {
    const schema = argsSchema({ tab: enumProperty(["a", "b"], "Which tab.") });
    expect(schema).toEqual({
      additionalProperties: false,
      properties: { tab: { description: "Which tab.", enum: ["a", "b"], type: "string" } },
      required: ["tab"],
      type: "object",
    });
  });

  test("argsSchema takes an explicit required list for optional arguments", () => {
    const schema = argsSchema({ section: stringProperty("A section.") }, []) as {
      required: string[];
    };
    expect(schema.required).toEqual([]);
  });

  test("enumProperty copies the declared array — the schema cannot alias live state", () => {
    const declared = ["a", "b"];
    const prop = enumProperty(declared, "d") as { enum: string[] };
    declared.push("c");
    expect(prop.enum).toEqual(["a", "b"]);
  });

  test("numberProperty carries the bounds the coercion enforces", () => {
    expect(numberProperty("Zoom.", { maximum: 5, minimum: 0.05 })).toEqual({
      description: "Zoom.",
      maximum: 5,
      minimum: 0.05,
      type: "number",
    });
    expect(numberProperty("Zoom.")).toEqual({ description: "Zoom.", type: "number" });
  });

  test("booleanProperty carries the sense in its description", () => {
    expect(booleanProperty("True to open.")).toEqual({
      description: "True to open.",
      type: "boolean",
    });
  });

  test("pathProperty is an array of segments, and nullable on request", () => {
    expect(pathProperty("A path.")).toEqual({
      description: "A path.",
      items: { type: ["string", "number"] },
      type: "array",
    });
    expect(pathProperty("A path.", true)).toEqual({
      description: "A path.",
      oneOf: [{ items: { type: ["string", "number"] }, type: "array" }, { type: "null" }],
    });
  });

  test("stringProperty is a plain string with its sentence", () => {
    expect(stringProperty("A name.")).toEqual({ description: "A name.", type: "string" });
  });
});
