import { describe, test, expect } from "bun:test";
import {
  isClassJsonSrc,
  isSchemaOnly,
  isTemplateString,
  isDynamic,
  isNodeDynamic,
  hasAnyIsland,
  buildInitialScope,
  resolveStaticValue,
  resolveRefValue,
  evaluateStaticTemplate,
  getPathValue,
  cloneValue,
  escapeHtml,
  titleToTagName,
  tagNameToClassName,
  collectSrcImports,
  collectServerEntries,
  isRefObject,
  isComponentFullyStatic,
  buildComponentCSS,
  createCompileContext,
  buildAttrs,
  buildInner,
  compileStyles,
  renderStaticNode,
  preRenderComponentHtml,
} from "../src/shared.js";

// ─── Detection ──────────────────────────────────────────────────────────────

describe("isClassJsonSrc", () => {
  test("returns true for .class.json paths", () => {
    expect(isClassJsonSrc("./MyClass.class.json")).toBe(true);
    expect(isClassJsonSrc("@jxsuite/parser/MarkdownFile.class.json")).toBe(true);
  });

  test("returns false for non-.class.json paths", () => {
    expect(isClassJsonSrc("./MyClass.json")).toBe(false);
    expect(isClassJsonSrc("./MyClass.js")).toBe(false);
    expect(isClassJsonSrc(null)).toBe(false);
    expect(isClassJsonSrc(42)).toBe(false);
  });
});

describe("isSchemaOnly", () => {
  test("returns true for schema-only objects", () => {
    expect(isSchemaOnly({ type: "string" })).toBe(true);
    expect(isSchemaOnly({ type: "number", minimum: 0, maximum: 100 })).toBe(true);
    expect(isSchemaOnly({ type: "array", items: {} })).toBe(true);
    expect(isSchemaOnly({ description: "A field" })).toBe(true);
  });

  test("returns false when non-schema keys present", () => {
    expect(isSchemaOnly({ type: "string", default: "" })).toBe(false);
    expect(isSchemaOnly({ $prototype: "Function" })).toBe(false);
    expect(isSchemaOnly({ body: "state.count++" })).toBe(false);
  });

  test("returns true for empty objects", () => {
    expect(isSchemaOnly({})).toBe(true);
  });
});

describe("isTemplateString", () => {
  test("returns true for template strings", () => {
    expect(isTemplateString("Hello ${name}")).toBe(true);
    expect(isTemplateString("${state.count}")).toBe(true);
  });

  test("returns false for plain strings", () => {
    expect(isTemplateString("Hello world")).toBe(false);
    expect(isTemplateString("")).toBe(false);
  });

  test("returns false for non-strings", () => {
    expect(isTemplateString(42)).toBe(false);
    expect(isTemplateString(null)).toBe(false);
    expect(isTemplateString(undefined)).toBe(false);
  });
});

describe("isDynamic", () => {
  test("returns false for null/non-object", () => {
    expect(isDynamic(/** @type {any} */ (null))).toBe(false);
    expect(isDynamic("string")).toBe(false);
    expect(isDynamic(/** @type {any} */ (42))).toBe(false);
  });

  test("returns true for state with $prototype", () => {
    expect(isDynamic({ state: { counter: { $prototype: "Function", body: "state.x++" } } })).toBe(
      true,
    );
  });

  test("returns true for state with default value", () => {
    expect(isDynamic({ state: { count: { type: "number", default: 0 } } })).toBe(true);
  });

  test("returns false for schema-only state entries", () => {
    expect(isDynamic({ state: { MyType: { type: "string" } } })).toBe(false);
  });

  test("returns true for $switch", () => {
    expect(isDynamic({ $switch: { $ref: "#/state/mode" } })).toBe(true);
  });

  test("returns true for Array children", () => {
    expect(isDynamic({ children: { $prototype: "Array", items: { $ref: "#/state/list" } } })).toBe(
      true,
    );
  });

  test("returns true for $ref bindings", () => {
    expect(
      isDynamic(/** @type {any} */ ({ tagName: "span", textContent: { $ref: "#/state/label" } })),
    ).toBe(true);
  });

  test("returns true for template strings in properties", () => {
    expect(isDynamic({ tagName: "span", textContent: "Hello ${state.name}" })).toBe(true);
  });

  test("returns true for template strings in style", () => {
    expect(isDynamic({ tagName: "div", style: { color: "${state.color}" } })).toBe(true);
  });

  test("returns true for template strings in attributes", () => {
    expect(isDynamic({ tagName: "div", attributes: { "data-x": "${state.x}" } })).toBe(true);
  });

  test("returns false for purely static node", () => {
    expect(
      isDynamic({
        tagName: "div",
        style: { color: "red" },
        children: [{ tagName: "span", textContent: "hello" }],
      }),
    ).toBe(false);
  });

  test("returns true when child is dynamic", () => {
    expect(
      isDynamic(
        /** @type {any} */ ({
          tagName: "div",
          children: [{ tagName: "span", textContent: { $ref: "#/state/label" } }],
        }),
      ),
    ).toBe(true);
  });

  test("skips $site and $page state entries", () => {
    expect(isDynamic({ state: { $site: { name: "Test" }, $page: { url: "/" } } })).toBe(false);
  });

  test("skips timing: compiler entries", () => {
    expect(
      isDynamic({
        state: { data: { timing: "compiler", $src: "./data.js", $export: "getData" } },
      }),
    ).toBe(false);
  });
});

describe("isNodeDynamic", () => {
  test("does not recurse into children", () => {
    expect(
      isNodeDynamic(
        /** @type {any} */ ({
          tagName: "div",
          children: [{ tagName: "span", textContent: { $ref: "#/state/x" } }],
        }),
      ),
    ).toBe(false);
  });

  test("detects $switch on node", () => {
    expect(isNodeDynamic({ $switch: { $ref: "#/state/mode" } })).toBe(true);
  });

  test("detects template string in attributes as dynamic", () => {
    expect(
      isNodeDynamic({
        tagName: "div",
        attributes: { "data-id": "${$item.get()}" },
      }),
    ).toBe(true);
  });

  test("attributes without template strings is not dynamic", () => {
    expect(
      isNodeDynamic({
        tagName: "div",
        attributes: { "data-id": "static-value" },
      }),
    ).toBe(false);
  });
});

describe("hasAnyIsland", () => {
  test("returns true if root is dynamic", () => {
    expect(hasAnyIsland({ state: { count: { default: 0 } } })).toBe(true);
  });

  test("returns true if any descendant is dynamic", () => {
    expect(
      hasAnyIsland(
        /** @type {any} */ ({
          tagName: "div",
          children: [
            { tagName: "p", textContent: "static" },
            { tagName: "span", textContent: { $ref: "#/state/x" } },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("returns false for fully static tree", () => {
    expect(
      hasAnyIsland({
        tagName: "div",
        children: [{ tagName: "p", textContent: "hello" }],
      }),
    ).toBe(false);
  });
});

// ─── Scope / value resolution ───────────────────────────────────────────────

describe("buildInitialScope", () => {
  test("scalar values are set directly", () => {
    const scope = buildInitialScope({ count: 0, name: "Alice", active: true });
    expect(scope.count).toBe(0);
    expect(scope.name).toBe("Alice");
    expect(scope.active).toBe(true);
  });

  test("objects with default use the default value", () => {
    const scope = buildInitialScope({ count: { type: "number", default: 42 } });
    expect(scope.count).toBe(42);
  });

  test("array values are cloned", () => {
    const items = [1, 2, 3];
    const scope = buildInitialScope(/** @type {any} */ ({ items }));
    expect(scope.items).toEqual([1, 2, 3]);
    expect(scope.items).not.toBe(items);
  });

  test("template strings become lazy computed values", () => {
    const scope = buildInitialScope({ count: 5, doubled: "${state.count * 2}" });
    expect(scope.doubled).toBe(10);
  });

  test("Function $prototype with body creates function", () => {
    const scope = buildInitialScope({
      count: 0,
      inc: { $prototype: "Function", body: "state.count++" },
    });
    expect(typeof scope.inc).toBe("function");
  });

  test("Function $prototype with returning body creates getter", () => {
    const scope = buildInitialScope({
      count: 5,
      doubled: { $prototype: "Function", body: "return state.count * 2" },
    });
    expect(scope.doubled).toBe(10);
  });

  test("schema-only entries are not set", () => {
    const scope = buildInitialScope({ MyType: { type: "string", description: "A type" } });
    expect(scope.MyType).toBeUndefined();
  });

  test("inherits from parent scope", () => {
    const parent = { shared: "hello" };
    const scope = buildInitialScope({ local: 42 }, parent);
    expect(scope.local).toBe(42);
    expect(scope.shared).toBe("hello");
  });

  test("Storage $prototype uses default value", () => {
    const scope = buildInitialScope({
      prefs: { $prototype: "LocalStorage", default: { theme: "dark" } },
    });
    expect(scope.prefs).toEqual({ theme: "dark" });
  });
});

describe("createCompileContext", () => {
  test("builds context with scope from state", () => {
    const raw = { state: { count: 0 } };
    const ctx = createCompileContext(raw);
    expect(ctx.scope.count).toBe(0);
    expect(ctx.scopeDefs).toEqual({});
    expect(ctx.media).toEqual({});
  });

  test("uses parent scope when no state", () => {
    const parent = { shared: "x" };
    const ctx = createCompileContext({}, parent);
    expect(ctx.scope.shared).toBe("x");
  });
});

describe("resolveStaticValue", () => {
  test("passes through plain values", () => {
    expect(resolveStaticValue("hello", {})).toBe("hello");
    expect(resolveStaticValue(42, {})).toBe(42);
    expect(resolveStaticValue(null, {})).toBe(null);
  });

  test("resolves $ref objects", () => {
    const scope = { count: 42 };
    expect(resolveStaticValue({ $ref: "#/state/count" }, scope)).toBe(42);
  });

  test("evaluates template strings", () => {
    const scope = { name: "World" };
    expect(resolveStaticValue("Hello ${state.name}", scope)).toBe("Hello World");
  });
});

describe("isRefObject", () => {
  test("returns true for ref objects", () => {
    expect(isRefObject({ $ref: "#/state/count" })).toBe(true);
  });

  test("returns false for non-ref objects", () => {
    expect(isRefObject({ type: "string" })).toBe(false);
    expect(isRefObject(null)).toBe(false);
    expect(isRefObject("string")).toBe(false);
  });
});

describe("resolveRefValue", () => {
  test("resolves #/state/ references", () => {
    expect(resolveRefValue("#/state/count", { count: 42 })).toBe(42);
  });

  test("resolves nested #/state/ paths", () => {
    expect(resolveRefValue("#/state/user/name", { user: { name: "Alice" } })).toBe("Alice");
  });

  test("resolves $map/ references", () => {
    const scope = { $map: { item: { text: "hello" } } };
    expect(resolveRefValue("$map/item/text", scope)).toBe("hello");
  });

  test("resolves plain scope keys", () => {
    expect(resolveRefValue("count", { count: 10 })).toBe(10);
  });

  test("returns null for missing keys", () => {
    expect(resolveRefValue("missing", {})).toBe(null);
  });
});

describe("evaluateStaticTemplate", () => {
  test("evaluates single expression preserving type", () => {
    expect(evaluateStaticTemplate("${state.count}", { count: 42 })).toBe(42);
    expect(evaluateStaticTemplate("${state.active}", { active: true })).toBe(true);
  });

  test("evaluates interpolated string", () => {
    expect(evaluateStaticTemplate("Hello ${state.name}!", { name: "World" })).toBe("Hello World!");
  });

  test("returns null on error", () => {
    expect(evaluateStaticTemplate("${invalidSyntax.}", {})).toBe(null);
  });
});

describe("getPathValue", () => {
  test("returns base for empty path", () => {
    expect(getPathValue({ a: 1 }, "")).toEqual({ a: 1 });
  });

  test("navigates nested paths", () => {
    expect(getPathValue({ a: { b: { c: 42 } } }, "a/b/c")).toBe(42);
  });

  test("returns undefined for missing paths", () => {
    expect(getPathValue({ a: 1 }, "x/y")).toBeUndefined();
  });
});

describe("cloneValue", () => {
  test("clones objects deeply", () => {
    const obj = { a: { b: 1 } };
    const clone = /** @type {any} */ (cloneValue(obj));
    expect(clone).toEqual(obj);
    expect(clone).not.toBe(obj);
    expect(clone.a).not.toBe(obj.a);
  });

  test("passes through primitives", () => {
    expect(cloneValue(42)).toBe(42);
    expect(cloneValue("hello")).toBe("hello");
    expect(cloneValue(null)).toBe(null);
    expect(cloneValue(true)).toBe(true);
  });
});

// ─── HTML building ──────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  test("escapes all special characters", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  test("passes through safe strings", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

// ─── Utilities ──────────────────────────────────────────────────────────────

describe("titleToTagName", () => {
  test("converts title to hyphenated tag name", () => {
    expect(titleToTagName("My Component")).toBe("my-component");
    expect(titleToTagName("Todo App")).toBe("todo-app");
  });

  test("adds jx- prefix when no hyphen", () => {
    expect(titleToTagName("Counter")).toBe("jx-counter");
  });

  test("handles special characters", () => {
    expect(titleToTagName("Hello World!")).toBe("hello-world");
  });

  test("strips leading/trailing hyphens", () => {
    expect(titleToTagName(" Test ")).toBe("jx-test");
  });
});

describe("tagNameToClassName", () => {
  test("converts kebab-case to PascalCase", () => {
    expect(tagNameToClassName("my-component")).toBe("MyComponent");
    expect(tagNameToClassName("todo-app")).toBe("TodoApp");
    expect(tagNameToClassName("jx-counter")).toBe("JxCounter");
  });
});

describe("collectSrcImports", () => {
  test("collects $src from Function $prototype entries", () => {
    const doc = {
      state: {
        handler: { $prototype: "Function", $src: "./handler.js" },
        count: 0,
      },
    };
    expect(collectSrcImports(doc)).toEqual(["./handler.js"]);
  });

  test("deduplicates entries", () => {
    const doc = {
      state: {
        a: { $prototype: "Function", $src: "./utils.js" },
        b: { $prototype: "Function", $src: "./utils.js" },
      },
    };
    expect(collectSrcImports(doc)).toHaveLength(1);
  });

  test("recurses into children", () => {
    const doc = {
      children: [{ state: { fn: { $prototype: "Function", $src: "./child.js" } } }],
    };
    expect(collectSrcImports(doc)).toEqual(["./child.js"]);
  });

  test("returns empty for docs without $src", () => {
    expect(collectSrcImports({ state: { count: 0 } })).toEqual([]);
  });
});

describe("collectServerEntries", () => {
  test("collects timing: server entries", () => {
    const doc = {
      state: {
        data: { timing: "server", $src: "./api.js", $export: "getData" },
      },
    };
    const entries = collectServerEntries(doc);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ key: "data", exportName: "getData", src: "./api.js" });
  });

  test("skips entries without $export", () => {
    const doc = {
      state: {
        data: { timing: "server", $src: "./api.js" },
      },
    };
    expect(collectServerEntries(doc)).toHaveLength(0);
  });

  test("skips entries with $prototype", () => {
    const doc = {
      state: {
        data: { timing: "server", $src: "./api.js", $export: "getData", $prototype: "Function" },
      },
    };
    expect(collectServerEntries(doc)).toHaveLength(0);
  });

  test("deduplicates by export name", () => {
    const doc = {
      state: {
        a: { timing: "server", $src: "./api.js", $export: "getData" },
        b: { timing: "server", $src: "./api2.js", $export: "getData" },
      },
    };
    expect(collectServerEntries(doc)).toHaveLength(1);
  });
});

// ─── Component pre-rendering ────────────────────────────────────────────────

describe("isComponentFullyStatic", () => {
  test("returns true for static node", () => {
    expect(isComponentFullyStatic({ tagName: "div", children: [{ tagName: "p" }] })).toBe(true);
  });

  test("returns false for event handlers", () => {
    expect(isComponentFullyStatic({ tagName: "button", onclick: { $ref: "#/state/fn" } })).toBe(
      false,
    );
  });

  test("returns false for $prototype in state", () => {
    expect(
      isComponentFullyStatic({ state: { fn: { $prototype: "Function", body: "state.x++" } } }),
    ).toBe(false);
  });

  test("returns false for dynamic children", () => {
    expect(
      isComponentFullyStatic({
        children: { $prototype: "Array", items: { $ref: "#/state/items" } },
      }),
    ).toBe(false);
  });
});

describe("buildComponentCSS", () => {
  test("generates CSS for flat styles", () => {
    const css = buildComponentCSS("my-comp", { color: "red", fontSize: "16px" });
    expect(css).toContain("my-comp {");
    expect(css).toContain("color: red;");
    expect(css).toContain("font-size: 16px;");
  });

  test("skips pseudo-selectors from host rules but emits them as CSS rules", () => {
    const css = buildComponentCSS("my-comp", {
      color: "red",
      ":hover": { color: "blue" },
      "@--md": { fontSize: "20px" },
    });
    expect(css).toContain("color: red;");
    expect(css).toContain(":hover");
    expect(css).toContain("@media");
  });

  test("skips template strings", () => {
    const css = buildComponentCSS("my-comp", { color: "${state.color}" });
    expect(css).toBe("");
  });

  test("returns empty for null/undefined style", () => {
    expect(buildComponentCSS("my-comp", null)).toBe("");
    expect(buildComponentCSS("my-comp", /** @type {any} */ (undefined))).toBe("");
  });
});

// ─── buildAttrs ────────────────────────────────────────────────────────────

describe("buildAttrs", () => {
  test("returns empty string for no attributes", () => {
    expect(buildAttrs({}, /** @type {any} */ (null))).toBe("");
  });

  test("builds id attribute", () => {
    expect(buildAttrs({ id: "main" }, /** @type {any} */ (null))).toBe(' id="main"');
  });

  test("builds className as class attribute", () => {
    expect(buildAttrs({ className: "card active" }, /** @type {any} */ (null))).toBe(
      ' class="card active"',
    );
  });

  test("builds hidden attribute", () => {
    expect(buildAttrs({ hidden: true }, /** @type {any} */ (null))).toContain("hidden");
  });

  test("builds tabIndex attribute", () => {
    expect(buildAttrs({ tabIndex: 0 }, /** @type {any} */ (null))).toBe(' tabindex="0"');
  });

  test("builds title, lang, dir", () => {
    const result = buildAttrs({ title: "Tip", lang: "en", dir: "ltr" }, /** @type {any} */ (null));
    expect(result).toContain('title="Tip"');
    expect(result).toContain('lang="en"');
    expect(result).toContain('dir="ltr"');
  });

  test("no longer emits inline style (styles are in CSS rules)", () => {
    const result = buildAttrs(
      { style: { color: "red", fontSize: "16px" } },
      /** @type {any} */ (null),
    );
    expect(result).not.toContain("style=");
  });

  test("excludes pseudo-selectors from output", () => {
    const result = buildAttrs(
      { style: { color: "red", ":hover": { color: "blue" } } },
      /** @type {any} */ (null),
    );
    expect(result).not.toContain("style=");
    expect(result).not.toContain(":hover");
  });

  test("excludes media-overridden properties from inline style", () => {
    const result = buildAttrs(
      { style: { fontSize: "14px", "@(min-width: 768px)": { fontSize: "18px" } } },
      /** @type {any} */ (null),
    );
    expect(result).not.toContain("font-size: 14px");
  });

  test("builds custom attributes", () => {
    const result = buildAttrs(
      { attributes: { "data-id": "123", role: "button" } },
      /** @type {any} */ (null),
    );
    expect(result).toContain('data-id="123"');
    expect(result).toContain('role="button"');
  });

  test("escapes HTML in attribute values", () => {
    const result = buildAttrs({ id: '<script>"alert"</script>' }, /** @type {any} */ (null));
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&quot;alert&quot;");
  });

  test("builds $static marker attribute", () => {
    const result = buildAttrs({ $static: true }, /** @type {any} */ (null));
    expect(result).toContain("data-jx-static");
  });

  test("builds $prerendered marker attribute", () => {
    const result = buildAttrs({ $prerendered: true }, /** @type {any} */ (null));
    expect(result).toContain("data-jx-prerendered");
  });

  test("resolves scope values in attributes", () => {
    const scope = buildInitialScope({ color: "blue" });
    const result = buildAttrs(
      { id: "test", attributes: { "data-color": "${state.color}" } },
      scope,
    );
    expect(result).toContain('data-color="blue"');
  });
});

// ─── buildInner ────────────────────────────────────────────────────────────

describe("buildInner", () => {
  test("returns escaped textContent", () => {
    const def = { textContent: "Hello <world>" };
    const context = { scope: /** @type {any} */ (null), scopeDefs: {}, media: {} };
    expect(buildInner(def, null, context, () => "")).toBe("Hello &lt;world&gt;");
  });

  test("returns innerHTML directly", () => {
    const def = { innerHTML: "<b>Bold</b>" };
    const context = { scope: /** @type {any} */ (null), scopeDefs: {}, media: {} };
    expect(buildInner(def, null, context, () => "")).toBe("<b>Bold</b>");
  });

  test("compiles children with childCompiler", () => {
    const def = { children: [{ tagName: "p" }, { tagName: "span" }] };
    const context = { scope: /** @type {any} */ (null), scopeDefs: {}, media: {} };
    const compiler = (/** @type {any} */ d) => `<${d.tagName}>`;
    const result = buildInner(def, null, context, compiler);
    expect(result).toContain("<p>");
    expect(result).toContain("<span>");
  });

  test("returns empty for no content", () => {
    const def = /** @type {any} */ ({});
    const context = { scope: /** @type {any} */ (null), scopeDefs: {}, media: {} };
    expect(buildInner(def, null, context, () => "")).toBe("");
  });

  test("uses raw node when provided", () => {
    const def = { textContent: "override" };
    const raw = { textContent: "original" };
    const context = { scope: /** @type {any} */ (null), scopeDefs: {}, media: {} };
    expect(buildInner(def, raw, context, () => "")).toBe("original");
  });
});

// ─── compileStyles ─────────────────────────────────────────────────────────

describe("compileStyles", () => {
  test("returns empty for doc with no styles", () => {
    const result = compileStyles({ tagName: "div", children: [] });
    expect(result).toBe("");
  });

  test("generates media query rules", () => {
    const doc = {
      tagName: "div",
      id: "box",
      style: {
        color: "red",
        "@(min-width: 768px)": { color: "blue" },
      },
      children: [],
    };
    const result = compileStyles(doc);
    expect(result).toContain("<style>");
    expect(result).toContain("@media (min-width: 768px)");
    expect(result).toContain("color: blue");
  });

  test("generates pseudo-class rules", () => {
    const doc = {
      tagName: "div",
      id: "btn",
      style: {
        color: "red",
        ":hover": { color: "blue" },
      },
      children: [],
    };
    const result = compileStyles(doc);
    expect(result).toContain("#btn:hover");
    expect(result).toContain("color: blue");
  });

  test("auto-generates className for elements needing CSS", () => {
    const doc = {
      tagName: "div",
      style: {
        "@media (min-width: 1024px)": { display: "flex" },
      },
      children: [],
    };
    compileStyles(doc);
    expect(/** @type {any} */ (doc).className).toMatch(/^jx-\d+$/);
  });

  test("resolves custom media queries via mediaQueries map", () => {
    const doc = {
      tagName: "div",
      id: "test",
      style: {
        "@--md": { fontSize: "20px" },
      },
      children: [],
    };
    const mediaQueries = { "--md": "(min-width: 768px)" };
    const result = compileStyles(doc, mediaQueries);
    expect(result).toContain("@media (min-width: 768px)");
  });

  test("emits projectStyle custom properties on :root", () => {
    const doc = { tagName: "div", children: [] };
    const projectStyle = { "--bg": "#000", "--fg": "#fff" };
    const result = compileStyles(doc, {}, /** @type {any} */ (projectStyle));
    expect(result).toContain(":root {");
    expect(result).toContain("--bg: #000");
    expect(result).toContain("--fg: #fff");
  });

  test("emits projectStyle regular properties on body", () => {
    const doc = { tagName: "div", children: [] };
    const projectStyle = { margin: "0", padding: "0" };
    const result = compileStyles(doc, {}, /** @type {any} */ (projectStyle));
    expect(result).toContain("body {");
    expect(result).toContain("margin: 0");
  });

  test("emits projectStyle media blocks on body", () => {
    const doc = { tagName: "div", children: [] };
    const projectStyle = { "@(prefers-color-scheme: dark)": { backgroundColor: "#111" } };
    const result = compileStyles(doc, {}, /** @type {any} */ (projectStyle));
    expect(result).toContain("@media (prefers-color-scheme: dark)");
    expect(result).toContain("body {");
  });

  test("emits projectStyle standalone selectors", () => {
    const doc = { tagName: "div", children: [] };
    const projectStyle = { ".dark": { backgroundColor: "#000" } };
    const result = compileStyles(doc, {}, /** @type {any} */ (projectStyle));
    expect(result).toContain(".dark {");
    expect(result).toContain("background-color: #000");
  });

  test("emits projectStyle element selectors with object values", () => {
    const doc = { tagName: "div", children: [] };
    const projectStyle = { html: { margin: "0" }, "*": { boxSizing: "border-box" } };
    const result = compileStyles(doc, {}, /** @type {any} */ (projectStyle));
    expect(result).toContain("html {");
    expect(result).toContain("margin: 0");
    expect(result).toContain("* {");
    expect(result).toContain("box-sizing: border-box");
  });

  test("emits base CSS rule for media-overridden properties", () => {
    const doc = {
      tagName: "div",
      id: "responsive",
      style: {
        fontSize: "14px",
        "@(min-width: 768px)": { fontSize: "18px" },
      },
      children: [],
    };
    const result = compileStyles(doc);
    expect(result).toContain("font-size: 14px;");
    expect(result).toContain("@media (min-width: 768px)");
    expect(result).toContain("font-size: 18px");
  });
});

// ─── renderStaticNode ──────────────────────────────────────────────────────

describe("renderStaticNode", () => {
  test("renders text string escaped", () => {
    expect(renderStaticNode("Hello <world>", /** @type {any} */ (null))).toBe(
      "Hello &lt;world&gt;",
    );
  });

  test("renders number", () => {
    expect(renderStaticNode(/** @type {any} */ (42), /** @type {any} */ (null))).toBe("42");
  });

  test("renders boolean", () => {
    expect(renderStaticNode(/** @type {any} */ (true), /** @type {any} */ (null))).toBe("true");
  });

  test("renders array of nodes", () => {
    const result = renderStaticNode(
      /** @type {any} */ ([
        { tagName: "p", textContent: "One" },
        { tagName: "p", textContent: "Two" },
      ]),
      /** @type {any} */ (null),
    );
    expect(result).toContain("<p>One</p>");
    expect(result).toContain("<p>Two</p>");
  });

  test("returns empty for null/undefined", () => {
    expect(renderStaticNode(/** @type {any} */ (null), /** @type {any} */ (null))).toBe("");
    expect(renderStaticNode(/** @type {any} */ (undefined), /** @type {any} */ (null))).toBe("");
  });

  test("renders basic element with textContent", () => {
    const node = { tagName: "p", textContent: "Hello" };
    expect(renderStaticNode(node, /** @type {any} */ (null))).toBe("<p>Hello</p>");
  });

  test("renders self-closing tags", () => {
    expect(renderStaticNode({ tagName: "br" }, /** @type {any} */ (null))).toBe("<br>");
    expect(renderStaticNode({ tagName: "img" }, /** @type {any} */ (null))).toBe(
      '<img loading="lazy" decoding="async">',
    );
    expect(renderStaticNode({ tagName: "input" }, /** @type {any} */ (null))).toBe("<input>");
    expect(renderStaticNode({ tagName: "hr" }, /** @type {any} */ (null))).toBe("<hr>");
  });

  test("renders innerHTML directly", () => {
    const node = { tagName: "div", innerHTML: "<b>Bold</b>" };
    expect(renderStaticNode(node, /** @type {any} */ (null))).toBe("<div><b>Bold</b></div>");
  });

  test("renders nested children", () => {
    const node = {
      tagName: "div",
      children: [
        { tagName: "p", textContent: "Child 1" },
        { tagName: "span", textContent: "Child 2" },
      ],
    };
    const result = renderStaticNode(node, /** @type {any} */ (null));
    expect(result).toContain("<div>");
    expect(result).toContain("<p>Child 1</p>");
    expect(result).toContain("<span>Child 2</span>");
    expect(result).toContain("</div>");
  });

  test("replaces slot with slotContent", () => {
    const node = { tagName: "slot" };
    expect(renderStaticNode(node, /** @type {any} */ (null), "<p>Slotted</p>")).toBe(
      "<p>Slotted</p>",
    );
  });

  test("renders slot normally when no slotContent", () => {
    const node = { tagName: "slot" };
    expect(renderStaticNode(node, /** @type {any} */ (null), null)).toBe("<slot></slot>");
  });

  test("skips $prototype Array nodes", () => {
    const node = { $prototype: "Array", items: {} };
    expect(renderStaticNode(/** @type {any} */ (node), /** @type {any} */ (null))).toBe("");
  });

  test("renders with id and className attributes", () => {
    const node = { tagName: "div", id: "app", className: "container" };
    const result = renderStaticNode(node, /** @type {any} */ (null));
    expect(result).toContain('id="app"');
    expect(result).toContain('class="container"');
  });

  test("resolves state values in textContent", () => {
    const scope = buildInitialScope({ name: "World" });
    const node = { tagName: "span", textContent: "${state.name}" };
    expect(renderStaticNode(node, scope)).toBe("<span>World</span>");
  });

  test("resolves template strings in children array", () => {
    const scope = buildInitialScope({ status: "idle" });
    const node = {
      tagName: "button",
      children: ["${state.status === 'submitting' ? 'Sending...' : 'Submit'}"],
    };
    expect(renderStaticNode(node, scope)).toBe("<button>Submit</button>");
  });
});

// ─── preRenderComponentHtml ────────────────────────────────────────────────

describe("preRenderComponentHtml", () => {
  test("returns empty for doc with no children", () => {
    expect(preRenderComponentHtml({})).toBe("");
    expect(preRenderComponentHtml({ state: {} })).toBe("");
  });

  test("renders children with state", () => {
    const doc = {
      state: { label: "Click me" },
      children: [{ tagName: "button", textContent: "${state.label}" }],
    };
    const result = preRenderComponentHtml(doc);
    expect(result).toBe("<button>Click me</button>");
  });

  test("overrides state with propsOverride", () => {
    const doc = {
      state: { count: { default: 0 } },
      children: [{ tagName: "span", textContent: "${state.count}" }],
    };
    const result = preRenderComponentHtml(doc, { count: 42 });
    expect(result).toBe("<span>42</span>");
  });

  test("adds new props from propsOverride", () => {
    const doc = {
      state: { existing: "hello" },
      children: [{ tagName: "p", textContent: "${state.extra}" }],
    };
    const result = preRenderComponentHtml(doc, { extra: "world" });
    expect(result).toBe("<p>world</p>");
  });

  test("replaces slot with slotContent", () => {
    const doc = {
      children: [{ tagName: "div", children: [{ tagName: "slot" }] }],
    };
    const result = preRenderComponentHtml(doc, null, "<p>Inserted</p>");
    expect(result).toContain("<p>Inserted</p>");
  });

  test("renders multiple children joined by newline", () => {
    const doc = {
      children: [
        { tagName: "h1", textContent: "Title" },
        { tagName: "p", textContent: "Body" },
      ],
    };
    const result = preRenderComponentHtml(doc);
    expect(result).toContain("<h1>Title</h1>");
    expect(result).toContain("<p>Body</p>");
  });
});

// ─── @starting-style and non-media at-rules ─────────────────────────────────

describe("compileStyles — non-media at-rules", () => {
  test("@starting-style emits without @media wrapper", () => {
    const doc = {
      tagName: "div",
      id: "panel",
      style: {
        transform: "translateX(100%)",
        "@starting-style": {
          ":popover-open": { transform: "translateX(100%)" },
        },
      },
      children: [],
    };
    const result = compileStyles(doc);
    expect(result).toContain("@starting-style");
    expect(result).not.toContain("@media starting-style");
    expect(result).toContain("#panel:popover-open");
    expect(result).toContain("transform: translateX(100%)");
  });

  test("@starting-style with multiple nested selectors", () => {
    const doc = {
      tagName: "div",
      id: "menu",
      style: {
        "@starting-style": {
          ":popover-open": { opacity: "0" },
          "&:popover-open::backdrop": { opacity: "0" },
        },
      },
      children: [],
    };
    const result = compileStyles(doc);
    expect(result).toContain("@starting-style { #menu:popover-open { opacity: 0 } }");
    expect(result).toContain("@starting-style { #menu:popover-open::backdrop { opacity: 0 } }");
  });

  test("@starting-style does not emit empty base rule", () => {
    const doc = {
      tagName: "div",
      id: "x",
      style: {
        "@starting-style": {
          ":popover-open": { opacity: "1" },
        },
      },
      children: [],
    };
    const result = compileStyles(doc);
    expect(result).not.toContain("@starting-style { #x {  } }");
    expect(result).not.toContain("@starting-style { #x { } }");
  });

  test("@supports emits as-is without @media wrapper", () => {
    const doc = {
      tagName: "div",
      id: "s",
      style: {
        "@supports (display: grid)": { display: "grid" },
      },
      children: [],
    };
    const result = compileStyles(doc);
    expect(result).toContain("@supports (display: grid) { #s { display: grid } }");
    expect(result).not.toContain("@media");
  });

  test("@(condition) shorthand still emits as @media", () => {
    const doc = {
      tagName: "div",
      id: "m",
      style: {
        "@(max-width: 600px)": { fontSize: "14px" },
      },
      children: [],
    };
    const result = compileStyles(doc);
    expect(result).toContain("@media (max-width: 600px)");
    expect(result).toContain("font-size: 14px");
  });

  test("@--breakpoint still resolves from mediaQueries map", () => {
    const doc = {
      tagName: "div",
      id: "b",
      style: {
        "@--lg": { fontSize: "20px" },
      },
      children: [],
    };
    const result = compileStyles(doc, { "--lg": "(min-width: 1024px)" });
    expect(result).toContain("@media (min-width: 1024px)");
    expect(result).toContain("font-size: 20px");
  });
});

describe("compileStyles — :popover-open and ::backdrop pseudo selectors", () => {
  test(":popover-open emits correct selector", () => {
    const doc = {
      tagName: "div",
      id: "pop",
      style: {
        ":popover-open": { transform: "translateX(0)" },
      },
      children: [],
    };
    const result = compileStyles(doc);
    expect(result).toContain("#pop:popover-open { transform: translateX(0) }");
  });

  test("::backdrop emits correct selector", () => {
    const doc = {
      tagName: "div",
      id: "pop",
      style: {
        "::backdrop": { backgroundColor: "rgba(0,0,0,0.5)" },
      },
      children: [],
    };
    const result = compileStyles(doc);
    expect(result).toContain("#pop::backdrop { background-color: rgba(0,0,0,0.5) }");
  });

  test("&:popover-open::backdrop emits compound selector", () => {
    const doc = {
      tagName: "div",
      id: "pop",
      style: {
        "&:popover-open::backdrop": { opacity: "1" },
      },
      children: [],
    };
    const result = compileStyles(doc);
    expect(result).toContain("#pop:popover-open::backdrop { opacity: 1 }");
  });
});

describe("buildComponentCSS — $media propagation", () => {
  test("resolves @--md breakpoint from provided mediaQueries", () => {
    const doc = {
      tagName: "my-nav",
      style: { display: "block" },
      children: [
        {
          tagName: "button",
          style: {
            display: "none",
            "@--md": { display: "block" },
          },
        },
      ],
    };
    const css = buildComponentCSS("my-nav", doc.style, doc, {
      "--md": "(max-width: 768px)",
    });
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain("display: block");
  });

  test("handles @starting-style in child elements", () => {
    const doc = {
      tagName: "my-menu",
      style: {},
      children: [
        {
          tagName: "nav",
          id: "flyout",
          style: {
            "@starting-style": {
              ":popover-open": { transform: "translateX(100%)" },
            },
          },
        },
      ],
    };
    const css = buildComponentCSS("my-menu", doc.style, doc, {});
    expect(css).toContain(
      "@starting-style { #flyout:popover-open { transform: translateX(100%) } }",
    );
    expect(css).not.toContain("@media");
  });
});
