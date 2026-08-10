import { describe, expect, test } from "bun:test";

import {
  SCHEMA_KEYWORDS,
  bodyReturnsValue,
  childrenContainArray,
  displayTagName,
  ensureNestedStyle,
  getEventBinding,
  getNestedStyle,
  hasSchemaKeywords,
  hasStructuredBody,
  isClassDef,
  isEventBinding,
  isExpandedSignal,
  isExpressionDef,
  isFunctionDef,
  isJsonObject,
  isMappedArray,
  isNamedFormulaDef,
  isNestedStyle,
  isNodeObject,
  isPrototypeDef,
  isRef,
  isSchemaOnlyDef,
  isServerFnDef,
  isTagExpression,
  isTemplateString,
  paramNames,
  tagNameCandidates,
} from "../src/guards";
import type { JxStyle } from "../types";

/** A genuinely-undefined value (guards take required params; a literal gets autofixed away). */
const UNDEF = ([] as unknown[]).at(0);

describe("isJsonObject", () => {
  test("accepts plain objects", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ a: 1 })).toBe(true);
  });

  test("rejects null, arrays, and scalars", () => {
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject([1, 2])).toBe(false);
    expect(isJsonObject("str")).toBe(false);
    expect(isJsonObject(42)).toBe(false);
    expect(isJsonObject(true)).toBe(false);
    expect(isJsonObject(UNDEF)).toBe(false);
  });
});

describe("isRef", () => {
  test("accepts a $ref string object", () => {
    expect(isRef({ $ref: "#/$defs/foo" })).toBe(true);
  });

  test("rejects non-string $ref, missing $ref, and non-objects", () => {
    expect(isRef({ $ref: 42 })).toBe(false);
    expect(isRef({ ref: "#/$defs/foo" })).toBe(false);
    expect(isRef("#/$defs/foo")).toBe(false);
    expect(isRef(null)).toBe(false);
  });
});

describe("isFunctionDef", () => {
  test("accepts $prototype: Function", () => {
    expect(isFunctionDef({ $prototype: "Function", body: "return 1" })).toBe(true);
  });

  test("rejects other prototypes and non-objects", () => {
    expect(isFunctionDef({ $prototype: "Request" })).toBe(false);
    expect(isFunctionDef({})).toBe(false);
    expect(isFunctionDef("Function")).toBe(false);
  });
});

describe("isExpressionDef", () => {
  test("accepts an object-valued $expression", () => {
    expect(isExpressionDef({ $expression: { operator: "set", target: "#/x" } })).toBe(true);
  });

  test("rejects scalar $expression and non-objects", () => {
    expect(isExpressionDef({ $expression: "x + 1" })).toBe(false);
    expect(isExpressionDef({ $expression: null })).toBe(false);
    expect(isExpressionDef({})).toBe(false);
    expect(isExpressionDef(7)).toBe(false);
  });
});

describe("isNamedFormulaDef", () => {
  const body = { operator: "+", target: 1, value: 2 };

  test("accepts an expression entry with non-empty parameters", () => {
    expect(isNamedFormulaDef({ $expression: body, parameters: ["a"] })).toBe(true);
    expect(isNamedFormulaDef({ $expression: body, parameters: [{ name: "a" }] })).toBe(true);
  });

  test("rejects empty/missing parameters and non-expressions", () => {
    expect(isNamedFormulaDef({ $expression: body })).toBe(false);
    expect(isNamedFormulaDef({ $expression: body, parameters: [] })).toBe(false);
    expect(isNamedFormulaDef({ $expression: body, parameters: "a" })).toBe(false);
    expect(isNamedFormulaDef({ parameters: ["a"] })).toBe(false);
  });
});

describe("hasStructuredBody", () => {
  test("accepts a Function entry whose body is a statement array", () => {
    expect(
      hasStructuredBody({
        $prototype: "Function",
        body: [{ operator: "=", target: { $ref: "#/state/n" }, value: 1 }],
      }),
    ).toBe(true);
  });

  test("rejects string bodies, missing bodies, and non-Function entries", () => {
    expect(hasStructuredBody({ $prototype: "Function", body: "state.n = 1" })).toBe(false);
    expect(hasStructuredBody({ $prototype: "Function" })).toBe(false);
    expect(hasStructuredBody({ $prototype: "Request", body: [] })).toBe(false);
  });
});

describe("isPrototypeDef", () => {
  test("accepts non-Function string prototypes", () => {
    expect(isPrototypeDef({ $prototype: "Request", $src: "/api" })).toBe(true);
    expect(isPrototypeDef({ $prototype: "LocalStorage" })).toBe(true);
  });

  test("rejects Function, missing, and non-string $prototype", () => {
    expect(isPrototypeDef({ $prototype: "Function" })).toBe(false);
    expect(isPrototypeDef({})).toBe(false);
    expect(isPrototypeDef({ $prototype: 3 })).toBe(false);
    expect(isPrototypeDef([])).toBe(false);
  });
});

describe("isServerFnDef", () => {
  const valid = { $export: "getPosts", $src: "./server/posts.ts", timing: "server" };

  test("accepts a complete server function proxy", () => {
    expect(isServerFnDef(valid)).toBe(true);
  });

  test("rejects when any required field is wrong or $prototype is set", () => {
    expect(isServerFnDef({ ...valid, timing: "client" })).toBe(false);
    expect(isServerFnDef({ ...valid, $src: 1 })).toBe(false);
    expect(isServerFnDef({ ...valid, $export: undefined })).toBe(false);
    expect(isServerFnDef({ ...valid, $prototype: "Function" })).toBe(false);
    expect(isServerFnDef(null)).toBe(false);
  });
});

describe("isExpandedSignal", () => {
  test("accepts an object with a default value", () => {
    expect(isExpandedSignal({ default: 0 })).toBe(true);
    expect(isExpandedSignal({ default: null, type: "string" })).toBe(true);
  });

  test("rejects prototype defs, expression defs, and plain type defs", () => {
    expect(isExpandedSignal({ $prototype: "Request", default: {} })).toBe(false);
    expect(isExpandedSignal({ $expression: {}, default: 1 })).toBe(false);
    expect(isExpandedSignal({ type: "string" })).toBe(false);
    expect(isExpandedSignal("default")).toBe(false);
  });
});

describe("SCHEMA_KEYWORDS", () => {
  test("contains the JSON Schema vocabulary used for shape detection", () => {
    expect(SCHEMA_KEYWORDS.has("type")).toBe(true);
    expect(SCHEMA_KEYWORDS.has("enum")).toBe(true);
    expect(SCHEMA_KEYWORDS.has("$comment")).toBe(true);
    expect(SCHEMA_KEYWORDS.has("default")).toBe(false);
    expect(SCHEMA_KEYWORDS.has("$prototype")).toBe(false);
  });
});

describe("isSchemaOnlyDef", () => {
  test("accepts objects whose keys are all schema keywords", () => {
    expect(isSchemaOnlyDef({ type: "string" })).toBe(true);
    expect(isSchemaOnlyDef({ description: "n", maximum: 10, minimum: 0, type: "number" })).toBe(
      true,
    );
    expect(isSchemaOnlyDef({})).toBe(true);
  });

  test("rejects objects with any non-keyword key and non-objects", () => {
    expect(isSchemaOnlyDef({ default: 1, type: "number" })).toBe(false);
    expect(isSchemaOnlyDef({ tagName: "div" })).toBe(false);
    expect(isSchemaOnlyDef([])).toBe(false);
    expect(isSchemaOnlyDef("type")).toBe(false);
  });
});

describe("hasSchemaKeywords", () => {
  test("true when at least one key is a schema keyword", () => {
    expect(hasSchemaKeywords({ default: 1, type: "number" })).toBe(true);
    expect(hasSchemaKeywords({ pattern: "^a" })).toBe(true);
  });

  test("false for keyword-free objects and non-objects", () => {
    expect(hasSchemaKeywords({ default: 1 })).toBe(false);
    expect(hasSchemaKeywords({})).toBe(false);
    expect(hasSchemaKeywords(null)).toBe(false);
    expect(hasSchemaKeywords(["type"])).toBe(false);
  });
});

describe("isMappedArray", () => {
  test("accepts $prototype: Array", () => {
    expect(isMappedArray({ $prototype: "Array", items: { $ref: "#/x" }, map: {} })).toBe(true);
  });

  test("rejects other shapes", () => {
    expect(isMappedArray({ $prototype: "Class" })).toBe(false);
    expect(isMappedArray([])).toBe(false);
    expect(isMappedArray({})).toBe(false);
  });
});

describe("childrenContainArray", () => {
  const arr = { $prototype: "Array", items: { $ref: "#/x" }, map: { tagName: "li" } };

  test("true for a bare whole-children mapped array (legacy form)", () => {
    expect(childrenContainArray(arr)).toBe(true);
  });

  test("true when a mapped array is a member among siblings", () => {
    expect(childrenContainArray([{ tagName: "li" }, arr, "text"])).toBe(true);
  });

  test("false for a plain children array with no mapped arrays", () => {
    expect(childrenContainArray([{ tagName: "li" }, "text"])).toBe(false);
  });

  test("false for absent/non-array children", () => {
    expect(childrenContainArray()).toBe(false);
    expect(childrenContainArray(null)).toBe(false);
    expect(childrenContainArray("text")).toBe(false);
  });
});

describe("isClassDef", () => {
  test("accepts $prototype: Class", () => {
    expect(isClassDef({ $prototype: "Class", title: "MarkdownFile" })).toBe(true);
  });

  test("rejects other shapes", () => {
    expect(isClassDef({ $prototype: "Array" })).toBe(false);
    expect(isClassDef(null)).toBe(false);
    expect(isClassDef("Class")).toBe(false);
  });
});

describe("isNodeObject", () => {
  test("accepts element-shaped objects", () => {
    expect(isNodeObject({ tagName: "div" })).toBe(true);
    expect(isNodeObject({})).toBe(true);
  });

  test("rejects bare string/number children and arrays", () => {
    expect(isNodeObject("hello")).toBe(false);
    expect(isNodeObject(3)).toBe(false);
    expect(isNodeObject([{ tagName: "li" }])).toBe(false);
    expect(isNodeObject(null)).toBe(false);
  });
});

describe("isTemplateString", () => {
  test("accepts strings containing ${", () => {
    expect(isTemplateString("${count}")).toBe(true);
    expect(isTemplateString("Total: ${a + b}!")).toBe(true);
  });

  test("rejects plain strings, undefined, and non-strings", () => {
    expect(isTemplateString("count")).toBe(false);
    expect(isTemplateString("$count")).toBe(false);
    expect(isTemplateString()).toBe(false);
    expect(isTemplateString(42)).toBe(false);
  });
});

describe("bodyReturnsValue", () => {
  test("detects a return statement (computed vs handler)", () => {
    expect(bodyReturnsValue("return state.count + 1")).toBe(true);
    expect(bodyReturnsValue("const x = 1;\n  return x")).toBe(true);
  });

  test("does not match identifiers that merely contain 'return'", () => {
    expect(bodyReturnsValue("const returned = fetchData()")).toBe(false);
    expect(bodyReturnsValue("state.count++")).toBe(false);
  });

  test("a bare return is an early-exit guard, not a value", () => {
    // Reading a guard clause as a value return classified the whole handler as a computed, so the
    // Binding that invoked it found a value where it expected a function. This body is
    // Examples/components/todo-app.json's `toggleItem`.
    expect(
      bodyReturnsValue(
        "const index = state.$map?.index ?? -1; if (index < 0) return; state.items[index].done = !state.items[index].done;",
      ),
    ).toBe(false);
    expect(bodyReturnsValue("if (!x) { return; }\n  doThing();")).toBe(false);
    expect(bodyReturnsValue("return;")).toBe(false);
    expect(bodyReturnsValue("return")).toBe(false);
  });

  test("a value must follow on the same line, since a newline is an ASI bare return", () => {
    expect(bodyReturnsValue("return\n  x")).toBe(false);
    expect(bodyReturnsValue("return x")).toBe(true);
  });

  test("a value return needs no space before it", () => {
    expect(bodyReturnsValue("return(state.a + 1)")).toBe(true);
    expect(bodyReturnsValue("return{ a: 1 }")).toBe(true);
  });
});

describe("isNestedStyle", () => {
  test("accepts nested style objects", () => {
    expect(isNestedStyle({ color: "red" })).toBe(true);
    expect(isNestedStyle({})).toBe(true);
  });

  test("rejects scalar CSS values and undefined", () => {
    expect(isNestedStyle("red")).toBe(false);
    expect(isNestedStyle(4)).toBe(false);
    expect(isNestedStyle(UNDEF as undefined)).toBe(false);
  });
});

describe("getNestedStyle", () => {
  test("returns the nested block when present", () => {
    const style: JxStyle = { ":hover": { color: "blue" }, color: "red" };
    expect(getNestedStyle(style, ":hover")).toEqual({ color: "blue" });
  });

  test("returns undefined for scalar values, missing keys, and missing style", () => {
    const style: JxStyle = { color: "red" };
    expect(getNestedStyle(style, "color")).toBeUndefined();
    expect(getNestedStyle(style, ":hover")).toBeUndefined();
    expect(getNestedStyle(undefined, ":hover")).toBeUndefined();
  });
});

describe("ensureNestedStyle", () => {
  test("returns the existing block in place", () => {
    const hover: JxStyle = { color: "blue" };
    const style: JxStyle = { ":hover": hover };
    expect(ensureNestedStyle(style, ":hover")).toBe(hover);
  });

  test("creates an empty block when absent", () => {
    const style: JxStyle = {};
    const created = ensureNestedStyle(style, "@--md");
    expect(created).toEqual({});
    expect(style["@--md"]).toBe(created);
  });

  test("replaces a scalar value with an empty block", () => {
    const style: JxStyle = { color: "red" };
    const created = ensureNestedStyle(style, "color");
    expect(created).toEqual({});
    expect(style.color).toBe(created);
  });
});

describe("isEventBinding", () => {
  test("accepts refs, function defs, and expression defs", () => {
    expect(isEventBinding({ $ref: "#/$defs/onClick" })).toBe(true);
    expect(isEventBinding({ $prototype: "Function", body: "x()" })).toBe(true);
    expect(isEventBinding({ $expression: { operator: "toggle", target: "#/open" } })).toBe(true);
  });

  test("rejects strings, plain objects, and non-objects", () => {
    expect(isEventBinding("onClick")).toBe(false);
    expect(isEventBinding({ handler: "x" })).toBe(false);
    expect(isEventBinding(null)).toBe(false);
  });
});

describe("getEventBinding", () => {
  test("returns the binding stored under an on* key", () => {
    const node = { onclick: { $ref: "#/$defs/handle" }, tagName: "button" };
    expect(getEventBinding(node, "onclick")).toEqual({ $ref: "#/$defs/handle" });
  });

  test("returns undefined for non-binding values and missing keys", () => {
    const node = { onclick: "not-a-binding", tagName: "button" };
    expect(getEventBinding(node, "onclick")).toBeUndefined();
    expect(getEventBinding(node, "onchange")).toBeUndefined();
  });
});

describe("paramNames", () => {
  test("resolves bare strings and CEM objects to names", () => {
    expect(paramNames(["event", { name: "value", type: { text: "string" } }])).toEqual([
      "event",
      "value",
    ]);
  });

  test("returns [] for undefined and empty parameter lists", () => {
    expect(paramNames(UNDEF as undefined)).toEqual([]);
    expect(paramNames([])).toEqual([]);
  });
});

describe("the tag-name helpers", () => {
  /*
   * ONE enumeration, shared by the runtime, three compiler targets and the studio — because four
   * surfaces each writing their own is four chances to disagree about what an element can be, and
   * disagreeing about that is how a `${…}` tagName shipped a page whose prerendered markup and
   * client render used different elements.
   */
  const conditional = { $expression: { initial: "div", operator: "?:", target: {}, value: "a" } };
  const multiway = {
    $expression: { cases: { "1": "h1", "2": "h2" }, default: "p", operator: "switch", target: {} },
  };

  test("isTagExpression tells a choice from a name", () => {
    expect(isTagExpression(conditional)).toBe(true);
    expect(isTagExpression(multiway)).toBe(true);
    expect(isTagExpression("div")).toBe(false);
    expect(isTagExpression(null)).toBe(false);
    expect(isTagExpression({ notAnExpression: 1 })).toBe(false);
  });

  test("candidates enumerate every branch, deduplicated, with the fallback", () => {
    expect(tagNameCandidates(conditional)).toEqual(["a", "div"]);
    expect(tagNameCandidates(multiway)).toEqual(["h1", "h2", "p"]);
    // A name is its own single candidate, so callers can treat both forms alike.
    expect(tagNameCandidates("section")).toEqual(["section"]);
    expect(tagNameCandidates(null)).toEqual([]);
    // Both arms the same is one candidate, not two.
    expect(
      tagNameCandidates({
        $expression: { initial: "a", operator: "?:", target: {}, value: "a" },
      }),
    ).toEqual(["a"]);
  });

  test("displayTagName is honest about not knowing which", () => {
    // The Outline draws one row per node. `a|div` says "one element, tag chosen" — showing the
    // First candidate would have been a quieter lie, and every structural lookup in the studio
    // (void elements, landmarks, component ids) correctly fails to match this string.
    expect(displayTagName(conditional)).toBe("a|div");
    expect(displayTagName("section")).toBe("section");
    expect(displayTagName(null)).toBe("");
  });
});
