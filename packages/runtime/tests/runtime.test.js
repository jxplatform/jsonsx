import { GlobalRegistrator } from "@happy-dom/global-registrator";
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { reactive, ref, computed, effect, isRef } from "@vue/reactivity";
import {
  resolve,
  buildScope,
  renderNode as _renderNode,
  applyStyle,
  resolveRef,
  resolvePrototype,
  isSignal,
  camelToKebab,
  toCSSText,
  RESERVED_KEYS,
  Jx,
  setSkipServerFunctions,
} from "../src/runtime.js";

/** @type {(...args: Parameters<typeof _renderNode>) => HTMLElement} */
const renderNode = /** @type {any} */ (_renderNode);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const wait = () => new Promise((r) => setTimeout(r, 0));

// ─── isSignal ─────────────────────────────────────────────────────────────────

describe("isSignal", () => {
  test("true for ref", () => expect(isSignal(ref(0))).toBe(true));
  test("true for computed", () => expect(isSignal(computed(() => 1))).toBe(true));
  test("false for plain value", () => expect(isSignal(42)).toBe(false));
  test("false for null", () => expect(isSignal(null)).toBe(false));
  test("false for object", () => expect(isSignal({})).toBe(false));
});

// ─── camelToKebab ─────────────────────────────────────────────────────────────

describe("camelToKebab", () => {
  test("single word unchanged", () => expect(camelToKebab("color")).toBe("color"));
  test("converts camelCase", () =>
    expect(camelToKebab("backgroundColor")).toBe("background-color"));
  test("multiple humps", () => expect(camelToKebab("marginTopLeft")).toBe("margin-top-left"));
  test("already kebab", () => expect(camelToKebab("font-size")).toBe("font-size"));
});

// ─── toCSSText ────────────────────────────────────────────────────────────────

describe("toCSSText", () => {
  test("converts properties to CSS text", () => {
    expect(toCSSText({ backgroundColor: "red", fontSize: "16px" })).toBe(
      "background-color: red; font-size: 16px",
    );
  });
  test("skips nested selectors", () => {
    expect(toCSSText({ color: "blue", ":hover": { color: "red" }, ".child": {} })).toBe(
      "color: blue",
    );
  });
  test("empty object", () => expect(toCSSText({})).toBe(""));
});

// ─── RESERVED_KEYS ────────────────────────────────────────────────────────────

describe("RESERVED_KEYS", () => {
  test("is a Set", () => expect(RESERVED_KEYS).toBeInstanceOf(Set));

  const required = [
    "$schema",
    "$id",
    "state",
    "$ref",
    "$props",
    "$switch",
    "$prototype",
    "$media",
    "$map",
    "$src",
    "$export",
    "timing",
    "default",
    "tagName",
    "children",
    "style",
    "attributes",
    "items",
    "map",
    "filter",
    "sort",
    "cases",
    "body",
    "parameters",
    "arguments",
    "name",
  ];
  for (const k of required) {
    test(`contains "${k}"`, () => expect(RESERVED_KEYS.has(k)).toBe(true));
  }

  const removed = ["$handlers", "$handler", "$compute", "$deps", "signal"];
  for (const k of removed) {
    test(`does NOT contain "${k}"`, () => expect(RESERVED_KEYS.has(k)).toBe(false));
  }
});

// ─── resolveRef ───────────────────────────────────────────────────────────────

describe("resolveRef", () => {
  const state = reactive({
    count: 5,
    name: "Alice",
  });
  // Simulate a child scope with $map
  const child = Object.create(state);
  child.$map = { item: { text: "hello", nested: { deep: 42 } }, index: 3 };
  child["$map/item"] = child.$map.item;
  child["$map/index"] = child.$map.index;

  test("non-string returns as-is", () =>
    expect(resolveRef(/** @type {any} */ (42), state)).toBe(42));
  test("#/state/ prefix resolves from scope", () => {
    expect(resolveRef("#/state/count", state)).toBe(5);
  });
  test("parent#/ prefix resolves from scope", () => {
    expect(resolveRef("parent#/name", state)).toBe("Alice");
  });
  test("window#/ resolves global window property", () => {
    /** @type {any} */ (window)._testProp = "win";
    expect(resolveRef("window#/_testProp", state)).toBe("win");
    delete (/** @type {any} */ (window)._testProp);
  });
  test("document#/ resolves global document property", () => {
    /** @type {any} */ (document)._testProp = "doc";
    expect(resolveRef("document#/_testProp", state)).toBe("doc");
    delete (/** @type {any} */ (document)._testProp);
  });
  test("$map/item resolves map item", () => {
    expect(resolveRef("$map/item", child)).toEqual({ text: "hello", nested: { deep: 42 } });
  });
  test("$map/index resolves map index", () => {
    expect(resolveRef("$map/index", child)).toBe(3);
  });
  test("$map/item/text resolves nested path", () => {
    expect(resolveRef("$map/item/text", child)).toBe("hello");
  });
  test("$map/item/nested/deep resolves deep nested path", () => {
    expect(resolveRef("$map/item/nested/deep", child)).toBe(42);
  });
  test("unknown ref returns null", () => {
    expect(resolveRef("nonexistent", state)).toBeNull();
  });
  test("bare key resolves from scope", () => {
    expect(resolveRef("name", state)).toBe("Alice");
  });
});

// ─── resolve ──────────────────────────────────────────────────────────────────

describe("resolve", () => {
  test("returns object as-is (no fetch)", async () => {
    const obj = { tagName: "div" };
    expect(await resolve(obj)).toBe(obj);
  });

  test("fetches string URL and parses JSON", async () => {
    const payload = { tagName: "span" };
    global.fetch = /** @type {any} */ (
      mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(payload),
        }),
      )
    );
    const result = await resolve("http://example.com/comp.json");
    expect(result).toEqual(payload);
  });

  test("throws on non-ok response", async () => {
    global.fetch = /** @type {any} */ (mock(() => Promise.resolve({ ok: false, status: 404 })));
    await expect(resolve("http://example.com/missing.json")).rejects.toThrow("404");
  });
});

// ─── buildScope — Five-Shape state Grammar ───────────────────────────────────

describe("buildScope", () => {
  const BASE = "http://localhost/";

  test("returns empty scope for empty doc", async () => {
    const state = await buildScope({}, {}, BASE);
    expect(Object.keys(state).length).toBe(0);
  });

  // Shape 1: Naked values → reactive property
  test("Shape 1: string → reactive property", async () => {
    const state = await buildScope({ state: { name: "hello" } }, {}, BASE);
    expect(state.name).toBe("hello");
  });

  test("Shape 1: number → reactive property", async () => {
    const state = await buildScope({ state: { count: 42 } }, {}, BASE);
    expect(state.count).toBe(42);
  });

  test("Shape 1: boolean → reactive property", async () => {
    const state = await buildScope({ state: { flag: false } }, {}, BASE);
    expect(state.flag).toBe(false);
  });

  test("Shape 1: null → reactive property", async () => {
    const state = await buildScope({ state: { x: null } }, {}, BASE);
    expect(state.x).toBeNull();
  });

  test("Shape 1: array → reactive property", async () => {
    const state = await buildScope({ state: { items: [1, 2, 3] } }, {}, BASE);
    expect(state.items).toEqual([1, 2, 3]);
  });

  test("Shape 1: plain object → reactive property", async () => {
    const state = await buildScope({ state: { cfg: { x: 1, y: 2 } } }, {}, BASE);
    expect(state.cfg).toEqual({ x: 1, y: 2 });
  });

  // Reactivity test
  test("Shape 1: reactive property tracks mutations", async () => {
    const state = await buildScope({ state: { count: 0 } }, {}, BASE);
    /** @type {any} */
    let observed;
    effect(() => {
      observed = state.count;
    });
    expect(observed).toBe(0);
    state.count = 42;
    await wait();
    expect(observed).toBe(42);
  });

  test("Shape 1: array reactive property tracks push", async () => {
    const state = await buildScope({ state: { items: [1, 2] } }, {}, BASE);
    /** @type {any} */
    let length;
    effect(() => {
      length = state.items.length;
    });
    expect(length).toBe(2);
    state.items.push(3);
    await wait();
    expect(length).toBe(3);
  });

  // Shape 2: Expanded signal with default
  test("Shape 2: object with default → reactive property initialized to default", async () => {
    const state = await buildScope({ state: { count: { type: "integer", default: 7 } } }, {}, BASE);
    expect(state.count).toBe(7);
  });

  // Shape 2b: Pure type definition
  test("Shape 2b: object with only schema keywords → skipped", async () => {
    const state = await buildScope(
      { state: { email: { type: "string", format: "email" } } },
      {},
      BASE,
    );
    expect(state.email).toBeUndefined();
  });

  // Shape 3: Template string → computed
  test("Shape 3: string with ${} → computed", async () => {
    const state = await buildScope(
      {
        state: {
          count: 5,
          label: "${state.count} items",
        },
      },
      {},
      BASE,
    );
    expect(state.label).toBe("5 items");
  });

  test("Shape 3: computed updates when dependency changes", async () => {
    const state = await buildScope(
      {
        state: {
          count: 5,
          label: "${state.count} items",
        },
      },
      {},
      BASE,
    );
    expect(state.label).toBe("5 items");
    state.count = 10;
    expect(state.label).toBe("10 items");
  });

  // Shape 4: $prototype: "Function" with body
  test("Shape 4: Function with body → callable function", async () => {
    const state = await buildScope(
      {
        state: {
          count: 0,
          increment: { $prototype: "Function", body: "state.count++" },
        },
      },
      {},
      BASE,
    );
    expect(typeof state.increment).toBe("function");
    state.increment(state);
    expect(state.count).toBe(1);
  });

  test("Shape 4: Function with return in body → computed", async () => {
    const state = await buildScope(
      {
        state: {
          n: 3,
          doubled: { $prototype: "Function", body: "return state.n * 2" },
        },
      },
      {},
      BASE,
    );
    expect(state.doubled).toBe(6);
    state.n = 5;
    expect(state.doubled).toBe(10);
  });

  test("Shape 4: Function with return + parameters → callable (not computed)", async () => {
    const state = await buildScope(
      {
        state: {
          items: { type: "array", default: [{ id: 1, text: "a" }] },
          addItem: {
            $prototype: "Function",
            parameters: ["event"],
            body: "if (event.key !== 'Enter') return; state.items.push({ id: 2, text: 'b' });",
          },
        },
      },
      {},
      BASE,
    );
    expect(typeof state.addItem).toBe("function");
  });

  test("Shape 4: Function with return + parameters is not auto-evaluated", async () => {
    const state = await buildScope(
      {
        state: {
          handler: {
            $prototype: "Function",
            parameters: ["event"],
            body: "return event.target.value;",
          },
        },
      },
      {},
      BASE,
    );
    expect(typeof state.handler).toBe("function");
    const result = state.handler(state, { target: { value: "hello" } });
    expect(result).toBe("hello");
  });

  test("Shape 4: Function with $src → computed via introspection (has return, ≤1 param)", async () => {
    const srcUrl = new URL("./_test_computed_src.js", import.meta.url).href;
    const state = await buildScope(
      {
        state: {
          items: { type: "array", default: [1, 2, 3] },
          total: { $prototype: "Function", $src: srcUrl, $export: "total" },
        },
      },
      {},
      BASE,
    );
    expect(state.total).toBe(3);
  });

  test("Shape 4: Function with $src + parameters in def → callable (not computed)", async () => {
    const srcUrl = new URL("./_test_handlers_fn.js", import.meta.url).href;
    const state = await buildScope(
      {
        state: {
          handler: { $prototype: "Function", $src: srcUrl, $export: "myFn", parameters: ["event"] },
        },
      },
      {},
      BASE,
    );
    expect(typeof state.handler).toBe("function");
  });

  test("Shape 4: Function with $src → computed when fn has return and ≤1 param", async () => {
    const srcUrl = new URL("./_test_handlers_fn.js", import.meta.url).href;
    const state = await buildScope(
      {
        state: {
          myFn: { $prototype: "Function", $src: srcUrl },
        },
      },
      {},
      BASE,
    );
    expect(state.myFn).toBe(42);
  });

  test("Shape 4: Function with both body and $src → throws", async () => {
    await expect(
      buildScope(
        {
          state: {
            bad: { $prototype: "Function", body: "return 1;", $src: "./foo.js" },
          },
        },
        {},
        BASE,
      ),
    ).rejects.toThrow("mutually exclusive");
  });

  test("Shape 4: Function with neither body nor $src → returns no-op", async () => {
    const state = await buildScope(
      {
        state: {
          empty: { $prototype: "Function" },
        },
      },
      {},
      BASE,
    );
    expect(typeof state.empty).toBe("function");
    expect(state.empty()).toBeUndefined();
  });

  // Shape 5: External class $prototype
  test("Shape 5: $prototype other than Function → resolvePrototype", async () => {
    const doc = { state: { items: { $prototype: "Set", default: [1, 2] } } };
    const state = await buildScope(doc, {}, BASE);
    expect(state.items).toBeInstanceOf(Set);
  });

  // Scope merging
  test("merges parentScope", async () => {
    const parent = { existing: "from-parent" };
    const state = await buildScope({}, parent, BASE);
    expect(state.existing).toBe("from-parent");
  });

  test("stores $media in scope", async () => {
    const doc = { $media: { "--md": "(min-width: 768px)" } };
    const state = await buildScope(doc, {}, BASE);
    expect(state["$media"]).toEqual({ "--md": "(min-width: 768px)" });
  });
});

// ─── setSkipServerFunctions ──────────────────────────────────────────────────

describe("setSkipServerFunctions", () => {
  const BASE = "http://localhost/";

  test("skips timing:'server' entries when flag is true", async () => {
    setSkipServerFunctions(true);
    try {
      const state = await buildScope(
        {
          state: {
            data: {
              timing: "server",
              $src: "./nonexistent.js",
              $export: "getData",
            },
            count: 5,
          },
        },
        {},
        BASE,
      );
      expect(state.count).toBe(5);
      expect(state.data).toBeUndefined();
    } finally {
      setSkipServerFunctions(false);
    }
  });

  test("does not skip non-server state entries when flag is true", async () => {
    setSkipServerFunctions(true);
    try {
      const state = await buildScope(
        {
          state: {
            name: "hello",
            count: { type: "integer", default: 42 },
          },
        },
        {},
        BASE,
      );
      expect(state.name).toBe("hello");
      expect(state.count).toBe(42);
    } finally {
      setSkipServerFunctions(false);
    }
  });

  test("flag defaults to false (server entries would be attempted)", async () => {
    setSkipServerFunctions(false);
    const state = await buildScope(
      {
        state: {
          plain: "value",
          serverEntry: {
            timing: "server",
            $src: "./nonexistent.js",
            $export: "missing",
          },
        },
      },
      {},
      BASE,
    );
    expect(state.plain).toBe("value");
    // Server entry attempted resolution (will fail/fallback but won't be undefined like skip mode)
    // The key point: it's not skipped — resolution was attempted
    expect("serverEntry" in state).toBe(true);
  });
});

// ─── applyStyle ───────────────────────────────────────────────────────────────

describe("applyStyle", () => {
  /** @type {any} */ let el;
  beforeEach(() => {
    el = document.createElement("div");
    document.head.querySelectorAll("style").forEach((s) => s.remove());
  });

  test("sets inline style properties", () => {
    applyStyle(el, { color: "red", fontSize: "14px" });
    expect(el.style.color).toBe("red");
    expect(el.style.fontSize).toBe("14px");
  });

  test("empty style object — no side effects", () => {
    applyStyle(el, {});
    expect(el.dataset.jx).toBeUndefined();
    expect(document.head.querySelectorAll("style").length).toBe(0);
  });

  test("emits scoped <style> for :pseudo selector", () => {
    applyStyle(el, { ":hover": { color: "blue" } });
    expect(el.dataset.jx).toBeDefined();
    const uid = el.dataset.jx;
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style).not.toBeNull();
    expect(style.textContent).toContain(`[data-jx="${uid}"]:hover`);
    expect(style.textContent).toContain("color: blue");
  });

  test("emits scoped <style> for .class selector", () => {
    applyStyle(el, { ".child": { marginTop: "4px" } });
    const uid = el.dataset.jx;
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style.textContent).toContain(`[data-jx="${uid}"].child`);
  });

  test("emits scoped <style> for &.compound selector", () => {
    applyStyle(el, { "&.active": { fontWeight: "bold" } });
    const uid = el.dataset.jx;
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style.textContent).toContain(`[data-jx="${uid}"].active`);
  });

  test("emits scoped <style> for [attr] selector", () => {
    applyStyle(el, { "[disabled]": { opacity: "0.5" } });
    const uid = el.dataset.jx;
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style.textContent).toContain(`[data-jx="${uid}"][disabled]`);
  });

  test("resolves named @--breakpoint from mediaQueries", () => {
    applyStyle(el, { "@--md": { fontSize: "18px" } }, { "--md": "(min-width: 768px)" });
    const uid = el.dataset.jx;
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style.textContent).toContain("@media (min-width: 768px)");
    expect(style.textContent).toContain(`[data-jx="${uid}"]`);
    expect(style.textContent).toContain("font-size: 18px");
  });

  test("uses literal condition for @(min-width:...) keys", () => {
    applyStyle(el, { "@(min-width: 1024px)": { padding: "2rem" } });
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style.textContent).toContain("@media (min-width: 1024px)");
  });

  test("falls back to raw name when @--name not found in mediaQueries", () => {
    applyStyle(el, { "@--xl": { gap: "2rem" } }, {});
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style.textContent).toContain("@media --xl");
  });

  test("combined inline + nested + media", () => {
    applyStyle(
      el,
      { color: "green", ":focus": { outline: "2px solid blue" }, "@--sm": { color: "red" } },
      { "--sm": "(min-width: 640px)" },
    );
    expect(el.style.color).toBe("green");
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style.textContent).toContain("]:focus");
    expect(style.textContent).toContain("@media (min-width: 640px)");
  });

  test("nested selector inside media block", () => {
    applyStyle(
      el,
      { "@--md": { fontSize: "2rem", ":hover": { color: "blue" } } },
      { "--md": "(min-width: 768px)" },
    );
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    const css = style.textContent;
    // Media block flat props
    expect(css).toContain("@media (min-width: 768px)");
    expect(css).toContain("font-size: 2rem");
    // Nested selector within media
    expect(css).toMatch(
      /@media \(min-width: 768px\) \{ \[data-jx="[^"]+"\]:hover \{ color: blue \} \}/,
    );
  });

  test("& compound selector inside media block", () => {
    applyStyle(
      el,
      { "@--sm": { "&.active": { fontWeight: "bold" } } },
      { "--sm": "(min-width: 640px)" },
    );
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    const css = style.textContent;
    expect(css).toMatch(
      /@media \(min-width: 640px\) \{ \[data-jx="[^"]+"\]\.active \{ font-weight: bold \} \}/,
    );
  });
  test("sets CSS custom properties via setProperty", () => {
    applyStyle(el, { "--my-color": "red", "--spacing": "8px" });
    expect(el.style.getPropertyValue("--my-color")).toBe("red");
    expect(el.style.getPropertyValue("--spacing")).toBe("8px");
  });

  test("custom properties and regular properties coexist", () => {
    applyStyle(el, { color: "blue", "--accent": "green" });
    expect(el.style.color).toBe("blue");
    expect(el.style.getPropertyValue("--accent")).toBe("green");
  });
});

// ─── resolvePrototype ─────────────────────────────────────────────────────────

describe("resolvePrototype", () => {
  test("Request: returns ref, starts null, fetches and sets data", async () => {
    global.fetch = /** @type {any} */ (
      mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 1 }),
        }),
      )
    );
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype(
      { $prototype: "Request", url: "/api/test" },
      state,
      "data",
    );
    state.data = result;
    expect(isRef(result)).toBe(true);
    await wait();
    expect(state.data).toEqual({ id: 1 });
  });

  test("Request: manual:true does not auto-fetch", async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    global.fetch = /** @type {any} */ (fetchMock);
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    await resolvePrototype({ $prototype: "Request", url: "/api/x", manual: true }, state, "x");
    await wait();
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("Request: sets error on non-ok response", async () => {
    global.fetch = /** @type {any} */ (
      mock(() =>
        Promise.resolve({
          ok: false,
          statusText: "Not Found",
          json: () => Promise.resolve({}),
        }),
      )
    );
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype({ $prototype: "Request", url: "/api/z" }, state, "z");
    state.z = result;
    await wait();
    expect(state.z).toHaveProperty("error");
  });

  test("Request: POST with headers and body", async () => {
    let captured = /** @type {any} */ (undefined);
    global.fetch = /** @type {any} */ (
      mock((_url, opts) => {
        captured = opts;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      })
    );
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    await resolvePrototype(
      { $prototype: "Request", url: "/api", method: "POST", headers: { x: "1" }, body: { a: 1 } },
      state,
      "r",
    );
    await wait();
    expect(captured.method).toBe("POST");
    expect(captured.headers).toEqual({ x: "1" });
    expect(captured.body).toBe('{"a":1}');
  });

  test("URLSearchParams: returns computed ref", async () => {
    const state = reactive({ q: "hello" });
    const result = await resolvePrototype(
      { $prototype: "URLSearchParams", q: { $ref: "#/state/q" } },
      state,
      "params",
    );
    expect(isRef(result)).toBe(true);
  });

  test("LocalStorage: reads existing value", async () => {
    localStorage.setItem("lsKey", JSON.stringify(99));
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype(
      { $prototype: "LocalStorage", key: "lsKey" },
      state,
      "ls",
    );
    state.ls = result;
    expect(state.ls).toBe(99);
    localStorage.removeItem("lsKey");
  });

  test("LocalStorage: defaults to def.default when key absent", async () => {
    localStorage.removeItem("lsMissing");
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype(
      { $prototype: "LocalStorage", key: "lsMissing", default: "fallback" },
      state,
      "ls",
    );
    state.ls = result;
    expect(state.ls).toBe("fallback");
  });

  test("LocalStorage: assignment persists to storage", async () => {
    localStorage.removeItem("lsPersist");
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype(
      { $prototype: "LocalStorage", key: "lsPersist", default: 0 },
      state,
      "ls",
    );
    state.ls = result;
    state.ls = 123;
    await wait();
    expect(JSON.parse(/** @type {string} */ (localStorage.getItem("lsPersist")))).toBe(123);
    localStorage.removeItem("lsPersist");
  });

  test("SessionStorage: reads and writes session storage", async () => {
    sessionStorage.setItem("ssKey", JSON.stringify("hello"));
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype(
      { $prototype: "SessionStorage", key: "ssKey" },
      state,
      "ss",
    );
    state.ss = result;
    expect(state.ss).toBe("hello");
    state.ss = "world";
    await wait();
    expect(JSON.parse(/** @type {string} */ (sessionStorage.getItem("ssKey")))).toBe("world");
    sessionStorage.removeItem("ssKey");
  });

  test("Cookie: reads, writes cookie", async () => {
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype(
      {
        $prototype: "Cookie",
        name: "testCookie",
        default: null,
        maxAge: 3600,
        path: "/",
      },
      state,
      "ck",
    );
    state.ck = result;
    expect(state.ck).toBeNull();
    state.ck = { user: "bob" };
    await wait();
    expect(state.ck).toEqual({ user: "bob" });
  });

  test("IndexedDB: returns ref", async () => {
    const fakeReq = { onupgradeneeded: null, onsuccess: null, onerror: null };
    global.indexedDB = /** @type {any} */ ({ open: () => fakeReq });
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype(
      {
        $prototype: "IndexedDB",
        database: "testDB",
        store: "items",
      },
      state,
      "db",
    );
    expect(isRef(result)).toBe(true);
    delete (/** @type {any} */ (global).indexedDB);
  });

  test("Set: returns a Set", async () => {
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype({ $prototype: "Set" }, state, "s");
    state.s = result;
    expect(state.s).toBeInstanceOf(Set);
    expect(state.s.size).toBe(0);
  });

  test("Set: default values", async () => {
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype({ $prototype: "Set", default: [1, 2] }, state, "s");
    state.s = result;
    expect(state.s.has(1)).toBe(true);
  });

  test("Map: returns a Map", async () => {
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype({ $prototype: "Map" }, state, "m");
    state.m = result;
    expect(state.m).toBeInstanceOf(Map);
  });

  test("Map: default object", async () => {
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype({ $prototype: "Map", default: { a: 1 } }, state, "m");
    state.m = result;
    expect(state.m.get("a")).toBe(1);
  });

  test("FormData: returns FormData", async () => {
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype(
      { $prototype: "FormData", fields: { name: "Alice" } },
      state,
      "fd",
    );
    expect(result).toBeInstanceOf(FormData);
    expect(/** @type {any} */ (result).get("name")).toBe("Alice");
  });

  test("Blob: returns Blob", async () => {
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype(
      { $prototype: "Blob", parts: ["hello"], type: "text/plain" },
      state,
      "b",
    );
    expect(result).toBeInstanceOf(Blob);
  });

  test("ReadableStream: returns null", async () => {
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = await resolvePrototype({ $prototype: "ReadableStream" }, state, "rs");
    expect(result).toBeNull();
  });

  test("unknown $prototype: warns and returns ref(null)", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const state = reactive(/** @type {Record<string, any>} */ ({}));
    const result = /** @type {any} */ (
      await resolvePrototype({ $prototype: "Unknown" }, state, "u")
    );
    expect(isRef(result)).toBe(true);
    expect(result.value).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unknown"));
    warn.mockRestore();
  });
});

// ─── renderNode ───────────────────────────────────────────────────────────────

describe("renderNode", () => {
  test("creates element with correct tagName", () => {
    const el = renderNode({ tagName: "section" }, reactive({}));
    expect(el.tagName.toLowerCase()).toBe("section");
  });

  test("defaults tagName to div", () => {
    const el = renderNode({}, reactive({}));
    expect(el.tagName.toLowerCase()).toBe("div");
  });

  test("sets plain string property", () => {
    const el = renderNode({ tagName: "p", textContent: "Hello" }, reactive({}));
    expect(el.textContent).toBe("Hello");
  });

  test("sets plain boolean property", () => {
    const el = renderNode({ tagName: "button", disabled: true }, reactive({}));
    expect(/** @type {any} */ (el).disabled).toBe(true);
  });

  test("sets reactive property from $ref", async () => {
    const state = reactive({ msg: "initial" });
    const el = renderNode({ tagName: "span", textContent: { $ref: "#/state/msg" } }, state);
    expect(el.textContent).toBe("initial");
    state.msg = "updated";
    await wait();
    expect(el.textContent).toBe("updated");
  });

  test("sets non-reactive property from plain value $ref", () => {
    const state = reactive({ label: "static" });
    const el = renderNode({ tagName: "span", textContent: { $ref: "#/state/label" } }, state);
    expect(el.textContent).toBe("static");
  });

  test("protected id property: set once, not reactive", () => {
    const state = reactive({ myId: "my-id" });
    const el = renderNode({ tagName: "div", id: { $ref: "#/state/myId" } }, state);
    expect(el.id).toBe("my-id");
  });

  test("binds event handler via onclick $ref", async () => {
    const state = reactive({ count: 0 });
    /** @type {any} */ (state).clickHandler = function (/** @type {any} */ state) {
      state.count++;
    };
    const el = renderNode({ tagName: "button", onclick: { $ref: "#/state/clickHandler" } }, state);
    el.dispatchEvent(new Event("click"));
    expect(state.count).toBe(1);
  });

  test("ignores handler $ref when not a function", () => {
    const state = reactive({ notFn: 42 });
    expect(() =>
      renderNode({ tagName: "div", onclick: { $ref: "#/state/notFn" } }, state),
    ).not.toThrow();
  });

  test("applies attributes", () => {
    const el = renderNode({ tagName: "div", attributes: { "data-x": "val" } }, reactive({}));
    expect(el.getAttribute("data-x")).toBe("val");
  });

  test("applies reactive attribute from $ref", async () => {
    const state = reactive({ cls: "a" });
    const el = renderNode(
      { tagName: "div", attributes: { "data-cls": { $ref: "#/state/cls" } } },
      state,
    );
    expect(el.getAttribute("data-cls")).toBe("a");
    state.cls = "b";
    await wait();
    expect(el.getAttribute("data-cls")).toBe("b");
  });

  test("applies static attribute from plain $ref", () => {
    const state = reactive({ val: "hello" });
    const el = renderNode(
      { tagName: "div", attributes: { "aria-label": { $ref: "#/state/val" } } },
      state,
    );
    expect(el.getAttribute("aria-label")).toBe("hello");
  });

  // Template string ${} tests
  test("${} template string in textContent renders reactively", async () => {
    const state = reactive({ count: 5 });
    const el = renderNode({ tagName: "span", textContent: "${state.count} items" }, state);
    expect(el.textContent).toBe("5 items");
    state.count = 10;
    await wait();
    expect(el.textContent).toBe("10 items");
  });

  test("${} template string in className", async () => {
    const state = reactive({ active: true });
    const el = renderNode(
      { tagName: "div", className: '${state.active ? "active" : "inactive"}' },
      state,
    );
    expect(el.className).toBe("active");
    state.active = false;
    await wait();
    expect(el.className).toBe("inactive");
  });

  test("renders children recursively", () => {
    const el = renderNode(
      {
        tagName: "ul",
        children: [
          { tagName: "li", textContent: "A" },
          { tagName: "li", textContent: "B" },
        ],
      },
      reactive({}),
    );
    expect(el.children.length).toBe(2);
    expect(el.children[0].textContent).toBe("A");
    expect(el.children[1].textContent).toBe("B");
  });

  test("$switch renders correct case", () => {
    const state = reactive({ route: "about" });
    const el = renderNode(
      {
        tagName: "div",
        $switch: { $ref: "#/state/route" },
        cases: {
          home: { tagName: "section", textContent: "Home" },
          about: { tagName: "section", textContent: "About" },
        },
      },
      state,
    );
    expect(el.textContent).toBe("About");
  });

  test("$switch reacts to change", async () => {
    const state = reactive({ route: "home" });
    const el = renderNode(
      {
        tagName: "div",
        $switch: { $ref: "#/state/route" },
        cases: {
          home: { tagName: "div", textContent: "Home" },
          about: { tagName: "div", textContent: "About" },
        },
      },
      state,
    );
    expect(el.textContent).toBe("Home");
    state.route = "about";
    await wait();
    expect(el.textContent).toBe("About");
  });

  test("$switch with missing case renders empty", () => {
    const state = reactive({ route: "404" });
    const el = renderNode(
      {
        tagName: "div",
        $switch: { $ref: "#/state/route" },
        cases: { home: { tagName: "div", textContent: "Home" } },
      },
      state,
    );
    expect(el.textContent).toBe("");
  });

  test("Array map renders static items", () => {
    const el = renderNode(
      {
        tagName: "ul",
        children: {
          $prototype: "Array",
          items: [{ id: 1, label: "X" }],
          map: { tagName: "li" },
        },
      },
      reactive({}),
    );
    expect(el.children.length).toBe(1);
  });

  test("Array map re-renders on reactive change", async () => {
    const state = reactive({ list: [{ v: "a" }, { v: "b" }] });
    const el = renderNode(
      {
        tagName: "ul",
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/list" },
          map: { tagName: "li" },
        },
      },
      state,
    );
    expect(el.children.length).toBe(2);
    state.list = [{ v: "x" }];
    await wait();
    expect(el.children.length).toBe(1);
  });

  test("Array map grows with push", async () => {
    const state = reactive({ list: [1, 2] });
    const el = renderNode(
      {
        tagName: "div",
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/list" },
          map: { tagName: "span" },
        },
      },
      state,
    );
    expect(el.children.length).toBe(2);
    state.list.push(3);
    await wait();
    expect(el.children.length).toBe(3);
  });

  test("Array map with filter", () => {
    const state = reactive({
      list: [1, 2, 3, 4],
      isEven: (/** @type {any} */ x) => x % 2 === 0,
    });
    const el = renderNode(
      {
        tagName: "div",
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/list" },
          filter: { $ref: "#/state/isEven" },
          map: { tagName: "span" },
        },
      },
      state,
    );
    expect(el.children.length).toBe(2);
  });

  test("Array map with sort", () => {
    const state = reactive({
      list: [3, 1, 2],
      sortAsc: (/** @type {any} */ a, /** @type {any} */ b) => a - b,
    });
    const el = renderNode(
      {
        tagName: "div",
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/list" },
          sort: { $ref: "#/state/sortAsc" },
          map: { tagName: "span" },
        },
      },
      state,
    );
    expect(el.children.length).toBe(3);
  });

  test("Array map: items not an array returns empty", () => {
    const state = reactive({ list: null });
    const el = renderNode(
      {
        tagName: "div",
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/list" },
          map: { tagName: "span" },
        },
      },
      state,
    );
    expect(el.children.length).toBe(0);
  });

  test("Array map with computed signal items updates reactively", async () => {
    const allItems = reactive([
      { id: 1, text: "alpha" },
      { id: 2, text: "beta" },
      { id: 3, text: "gamma" },
    ]);
    const filterTerm = ref("");
    const filteredItems = computed(() => {
      const term = filterTerm.value.toLowerCase();
      if (!term) return allItems;
      return allItems.filter((i) => i.text.includes(term));
    });
    const state = reactive({ filteredItems });
    const el = renderNode(
      {
        tagName: "div",
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/filteredItems" },
          map: { tagName: "div", textContent: "${$map.item.text}" },
        },
      },
      state,
    );
    expect(el.children.length).toBe(3);
    filterTerm.value = "alph";
    await wait();
    expect(el.children.length).toBe(1);
    expect(el.children[0].textContent).toBe("alpha");
  });

  test("Array map with paginated computed slice", async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
    const page = ref(1);
    const perPage = 10;
    const paginatedItems = computed(() => {
      const start = (page.value - 1) * perPage;
      return items.slice(start, start + perPage);
    });
    const state = reactive({ paginatedItems });
    const el = renderNode(
      {
        tagName: "div",
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/paginatedItems" },
          map: { tagName: "div" },
        },
      },
      state,
    );
    expect(el.children.length).toBe(10);
    page.value = 3;
    await wait();
    expect(el.children.length).toBe(5);
  });

  test("$props merges into scope", () => {
    const state = reactive({ count: 10 });
    const def = {
      tagName: "span",
      $props: { val: { $ref: "#/state/count" } },
      textContent: "ok",
    };
    const el = renderNode(def, state);
    expect(el.textContent).toBe("ok");
  });

  test("style object applied", () => {
    const el = renderNode({ tagName: "div", style: { color: "green" } }, reactive({}));
    expect(el.style.color).toBe("green");
  });
});

// ─── Integration: computed $src functions + Array map (fetch-demo pattern) ────

describe("computed $src + Array map integration", () => {
  const BASE = "http://localhost/";

  test("computed function filters items for Array map rendering", async () => {
    const srcUrl = new URL("./_test_computed_src.js", import.meta.url).href;
    const doc = {
      state: {
        allPosts: {
          type: "array",
          default: [
            { id: 1, title: "Hello World", body: "first" },
            { id: 2, title: "Goodbye", body: "second" },
            { id: 3, title: "Hello Again", body: "third" },
          ],
        },
        searchTerm: { type: "string", default: "" },
        filteredPosts: { $prototype: "Function", $src: srcUrl },
      },
      tagName: "div",
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/filteredPosts" },
        map: { tagName: "div", textContent: "${$map.item.title}" },
      },
    };
    const state = await buildScope(doc, {}, BASE);
    expect(state.filteredPosts).toHaveLength(3);

    const el = renderNode(doc, state);
    expect(el.children.length).toBe(3);
    expect(el.children[0].textContent).toBe("Hello World");

    state.searchTerm = "hello";
    await wait();
    expect(state.filteredPosts).toHaveLength(2);
    expect(el.children.length).toBe(2);
    expect(el.children[0].textContent).toBe("Hello World");
    expect(el.children[1].textContent).toBe("Hello Again");
  });

  test("computed function paginates items reactively", async () => {
    const srcUrl = new URL("./_test_computed_src.js", import.meta.url).href;
    const doc = {
      state: {
        allItems: {
          type: "array",
          default: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}` })),
        },
        currentPage: { type: "integer", default: 1 },
        perPage: { type: "integer", default: 5 },
        paginatedItems: { $prototype: "Function", $src: srcUrl },
      },
      tagName: "div",
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/paginatedItems" },
        map: { tagName: "span", textContent: "${$map.item.name}" },
      },
    };
    const state = await buildScope(doc, {}, BASE);
    const el = renderNode(doc, state);
    expect(el.children.length).toBe(5);
    expect(el.children[0].textContent).toBe("Item 1");

    state.currentPage = 2;
    await wait();
    expect(el.children.length).toBe(5);
    expect(el.children[0].textContent).toBe("Item 6");

    state.currentPage = 3;
    await wait();
    expect(el.children.length).toBe(2);
    expect(el.children[0].textContent).toBe("Item 11");
  });

  test("event handler with parameters + return is callable, not computed", async () => {
    const doc = {
      state: {
        items: { type: "array", default: [] },
        addItem: {
          $prototype: "Function",
          parameters: ["event"],
          body: "if (!event.text) return; state.items = [...state.items, { text: event.text }]; return true;",
        },
      },
      tagName: "div",
    };
    const state = await buildScope(doc, {}, BASE);
    expect(typeof state.addItem).toBe("function");
    expect(state.items).toHaveLength(0);
    const result = state.addItem(state, { text: "new item" });
    expect(result).toBe(true);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].text).toBe("new item");
  });
});

// ─── Jx (top-level mount) ─────────────────────────────────────────────────

describe("Jx", () => {
  test("mounts object doc into target", async () => {
    const target = document.createElement("div");
    await Jx({ tagName: "span", textContent: "mounted" }, target);
    expect(target.children[0].tagName.toLowerCase()).toBe("span");
    expect(target.children[0].textContent).toBe("mounted");
  });

  test("returns scope with naked value property", async () => {
    const target = document.createElement("div");
    const state = await Jx({ tagName: "div", state: { x: 1 } }, target);
    expect(state.x).toBe(1);
  });

  test("returns scope with expanded signal property", async () => {
    const target = document.createElement("div");
    const state = await Jx({ tagName: "div", state: { x: { default: 5 } } }, target);
    expect(state.x).toBe(5);
  });

  test("calls onMount if present in scope", async () => {
    const target = document.createElement("div");
    const srcUrl = new URL("./_test_handlers.js", import.meta.url).href;
    await Jx(
      {
        tagName: "div",
        state: {
          onMount: { $prototype: "Function", $src: srcUrl },
        },
      },
      target,
    );
    await wait();
    expect(/** @type {any} */ (globalThis)._testMounted).toBe(true);
    delete (/** @type {any} */ (globalThis)._testMounted);
  });

  test("fetches string source", async () => {
    const doc = { tagName: "article" };
    global.fetch = /** @type {any} */ (
      mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(doc),
        }),
      )
    );
    const target = document.createElement("div");
    await Jx("http://example.com/test.json", target);
    expect(target.children[0].tagName.toLowerCase()).toBe("article");
  });

  test("defaults target to document.body", async () => {
    const before = document.body.children.length;
    await Jx({ tagName: "div" });
    expect(document.body.children.length).toBe(before + 1);
  });
});

// ─── $media inheritance in buildScope ───────────────────────────────────────

describe("buildScope — $media inheritance", () => {
  const BASE = "http://localhost/";

  test("sets $media on state when doc has $media", async () => {
    const state = await buildScope(
      { $media: { "--md": "(max-width: 768px)" }, state: {} },
      {},
      BASE,
    );
    expect(state.$media).toEqual({ "--md": "(max-width: 768px)" });
  });

  test("inherits $media from parentScope when doc has no $media", async () => {
    const parentScope = { $media: { "--sm": "(max-width: 640px)" } };
    const state = await buildScope({ state: {} }, parentScope, BASE);
    expect(state.$media).toEqual({ "--sm": "(max-width: 640px)" });
  });

  test("doc $media overrides inherited $media", async () => {
    const parentScope = { $media: { "--md": "(max-width: 768px)" } };
    const state = await buildScope(
      { $media: { "--md": "(max-width: 900px)" }, state: {} },
      parentScope,
      BASE,
    );
    expect(state.$media).toEqual({ "--md": "(max-width: 900px)" });
  });

  test("does not add $media to empty doc state when _rootMedia is empty", async () => {
    const state = await buildScope({}, {}, BASE);
    expect(Object.keys(state).length).toBe(0);
  });
});

// ─── applyStyle — non-media at-rules ────────────────────────────────────────

describe("applyStyle — non-media at-rules", () => {
  /** @type {HTMLElement} */
  let el;
  beforeEach(() => {
    el = document.createElement("div");
    document.head.querySelectorAll("style").forEach((s) => s.remove());
  });

  test("@starting-style emits without @media wrapper", () => {
    applyStyle(el, {
      "@starting-style": {
        ":popover-open": { transform: "translateX(100%)" },
      },
    });
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style.textContent).toContain("@starting-style");
    expect(style.textContent).not.toContain("@media starting-style");
    expect(style.textContent).toContain(":popover-open");
    expect(style.textContent).toContain("transform: translateX(100%)");
  });

  test("@supports emits as-is", () => {
    applyStyle(el, {
      "@supports (display: grid)": { display: "grid" },
    });
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style.textContent).toContain("@supports (display: grid)");
    expect(style.textContent).not.toContain("@media");
  });

  test("@(condition) emits as @media shorthand", () => {
    applyStyle(el, {
      "@(max-width: 600px)": { fontSize: "14px" },
    });
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style.textContent).toContain("@media (max-width: 600px)");
  });

  test("@--breakpoint still resolves from mediaQueries", () => {
    applyStyle(el, { "@--lg": { fontSize: "20px" } }, { "--lg": "(min-width: 1024px)" });
    const style = /** @type {HTMLStyleElement} */ (document.head.querySelector("style"));
    expect(style.textContent).toContain("@media (min-width: 1024px)");
  });
});
