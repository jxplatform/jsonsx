import { describe, expect, test } from "bun:test";
import { BOOLEAN_KEY, classifyToggleValue, roleOfElement } from "../src/toggle-algebra.ts";

describe("classifyToggleValue", () => {
  test("reads a state declaration", () => {
    const role = classifyToggleValue("{ open_accordion_item: null }");

    expect(role?.kind).toBe("declare");
    expect(role?.kind === "declare" && [...role.idents.keys()]).toEqual(["open_accordion_item"]);
  });

  test("reads a multi-ident declaration", () => {
    const role = classifyToggleValue("{ open: null, busy: false }");

    expect(role?.kind === "declare" && [...role.idents.keys()]).toEqual(["open", "busy"]);
  });

  test("reads the exclusive toggle a keyed accordion is built from", () => {
    const role = classifyToggleValue(
      "open_accordion_item = (open_accordion_item === 0 ? null : 0)",
    );

    expect(role).toEqual({ ident: "open_accordion_item", key: "0", kind: "assign" });
  });

  test("reads the toggle without its parentheses, and with a trailing semicolon", () => {
    expect(classifyToggleValue("open = open === 3 ? -1 : 3;")).toEqual({
      ident: "open",
      key: "3",
      kind: "assign",
    });
  });

  test("reads a boolean toggle", () => {
    expect(classifyToggleValue("show_more = !show_more")).toEqual({
      ident: "show_more",
      key: BOOLEAN_KEY,
      kind: "assign",
    });
  });

  test("reads the predicate a body is shown under", () => {
    expect(classifyToggleValue("open_accordion_item === 0 ")).toEqual({
      ident: "open_accordion_item",
      key: "0",
      kind: "compare",
    });
  });

  test("reads a bare identifier as the boolean predicate, but only once declared", () => {
    expect(classifyToggleValue("show_more", new Set(["show_more"]))).toEqual({
      ident: "show_more",
      key: BOOLEAN_KEY,
      kind: "compare",
    });
  });

  test("refuses a bare identifier that names nothing declared", () => {
    /* Read context-free this shape matches `id="x"`, `class="hero"` and `target="_blank"` - half
       the attributes on a page. Requiring the ident to be declared is the closure rule applied at
       the one place it would otherwise leak. */
    expect(classifyToggleValue("show_more")).toBeNull();
    expect(classifyToggleValue("hero", new Set(["show_more"]))).toBeNull();
  });

  test("treats a quoted key and a bare one as the same row", () => {
    const quoted = classifyToggleValue("tab === 'main'");
    const assign = classifyToggleValue("tab = (tab === 'main' ? null : 'main')");

    expect(quoted?.kind === "compare" && quoted.key).toBe("main");
    expect(assign?.kind === "assign" && assign.key).toBe("main");
  });

  test("refuses a toggle whose two keys disagree", () => {
    // `? null : 1` against `=== 0` is not a toggle of one row; it is something else.
    expect(classifyToggleValue("open = (open === 0 ? null : 1)")).toBeNull();
  });

  test("refuses ordinary content", () => {
    for (const value of [
      "",
      "hero-banner is-layout-flow",
      "https://example.com/a.jpg",
      "(max-width: 400px) 100vw, 400px",
      "{ this is not an object literal }",
    ]) {
      expect(classifyToggleValue(value)).toBeNull();
    }
  });

  test("refuses a value that merely mentions an identifier", () => {
    expect(classifyToggleValue("open === 0 && ready")).toBeNull();
    expect(classifyToggleValue("doSomething(open)")).toBeNull();
  });
});

describe("roleOfElement", () => {
  test("picks the predicate off a body carrying three directives at once", () => {
    const role = roleOfElement({
      "x-show": "open_accordion_item === 0 ",
      "x-collapse.duration.250ms": "",
      hidden: "",
    });

    expect(role).toEqual({ ident: "open_accordion_item", key: "0", kind: "compare" });
  });

  test("a declaration outranks a predicate on the same element", () => {
    const role = roleOfElement({ "x-data": "{ open: null }", ":class": "open" });

    expect(role?.kind).toBe("declare");
  });

  test("a toggle outranks a predicate, so a title is not mistaken for a panel", () => {
    const role = roleOfElement({
      "@click": "open = (open === 2 ? null : 2)",
      ":class": "{ 'active': open === 2 }",
    });

    expect(role?.kind).toBe("assign");
  });

  test("is null for an element with no directives at all", () => {
    expect(roleOfElement({ class: "accordion-item", id: "x" })).toBeNull();
    const noAttributes: Record<string, unknown> | undefined = undefined;
    expect(roleOfElement(noAttributes)).toBeNull();
  });

  test("ignores non-string attribute values", () => {
    expect(roleOfElement({ width: 400 } as unknown as Record<string, unknown>)).toBeNull();
  });
});
