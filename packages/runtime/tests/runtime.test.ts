import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
} from "../src/runtime";
import { evaluateExpression, isMutating } from "../src/expression";
import type { JxDocument, JxElement } from "@jxsuite/schema/types";

/** Read a scope member as a callable — tests poke the dynamic scope directly. */
const fnOf = (scope: Record<string, unknown>, key: string) =>
  scope[key] as (...args: unknown[]) => unknown;
/** Read a scope member as an array. */
const arrOf = (scope: Record<string, unknown>, key: string) => scope[key] as unknown[];
try {
  GlobalRegistrator.register();
} catch {
  /* Already registered */
}

const renderNode: (...args: Parameters<typeof _renderNode>) => HTMLElement = _renderNode as any;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const wait = () =>
  new Promise((r) => {
    setTimeout(r, 0);
  });

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
    expect(toCSSText({ ".child": {}, ":hover": { color: "red" }, color: "blue" })).toBe(
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
  child.$map = { index: 3, item: { nested: { deep: 42 }, text: "hello" } };
  child["$map/item"] = child.$map.item;
  child["$map/index"] = child.$map.index;

  test("non-string returns as-is", () =>
    expect(resolveRef(42 as unknown as string, state)).toBe(42));
  test("#/state/ prefix resolves from scope", () => {
    expect(resolveRef("#/state/count", state)).toBe(5);
  });
  test("parent#/ prefix resolves from scope", () => {
    expect(resolveRef("parent#/name", state)).toBe("Alice");
  });
  test("window#/ resolves global window property", () => {
    (window as any)._testProp = "win";
    expect(resolveRef("window#/_testProp", state)).toBe("win");
    delete (window as any)._testProp;
  });
  test("document#/ resolves global document property", () => {
    (document as any)._testProp = "doc";
    expect(resolveRef("document#/_testProp", state)).toBe("doc");
    delete (document as any)._testProp;
  });
  test("$map/item resolves map item", () => {
    expect(resolveRef("$map/item", child)).toEqual({
      nested: { deep: 42 },
      text: "hello",
    });
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
    global.fetch = mock(() =>
      Promise.resolve({
        json: () => Promise.resolve(payload),
        ok: true,
      }),
    ) as any;
    const result = await resolve("http://example.com/comp.json");
    expect(result).toEqual(payload);
  });

  test("throws on non-ok response", async () => {
    global.fetch = mock(() => Promise.resolve({ ok: false, status: 404 })) as any;
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
    let observed: unknown;
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
    let length: unknown;
    effect(() => {
      ({ length } = arrOf(state, "items"));
    });
    expect(length).toBe(2);
    arrOf(state, "items").push(3);
    await wait();
    expect(length).toBe(3);
  });

  // Shape 2: Expanded signal with default
  test("Shape 2: object with default → reactive property initialized to default", async () => {
    const state = await buildScope({ state: { count: { default: 7, type: "integer" } } }, {}, BASE);
    expect(state.count).toBe(7);
  });

  // Shape 2b: Pure type definition
  test("Shape 2b: object with only schema keywords → skipped", async () => {
    const state = await buildScope(
      { state: { email: { format: "email", type: "string" } } },
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
    fnOf(state, "increment")(state);
    expect(state.count).toBe(1);
  });

  test("Shape 4: Function with return in body → computed", async () => {
    const state = await buildScope(
      {
        state: {
          doubled: { $prototype: "Function", body: "return state.n * 2" },
          n: 3,
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
          addItem: {
            $prototype: "Function",
            body: "if (event.key !== 'Enter') return; state.items.push({ id: 2, text: 'b' });",
            parameters: ["event"],
          },
          items: { default: [{ id: 1, text: "a" }], type: "array" },
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
            body: "return event.target.value;",
            parameters: ["event"],
          },
        },
      },
      {},
      BASE,
    );
    expect(typeof state.handler).toBe("function");
    const result = fnOf(state, "handler")(state, { target: { value: "hello" } });
    expect(result).toBe("hello");
  });

  test("Shape 4: Function with $src → computed via introspection (has return, ≤1 param)", async () => {
    const srcUrl = new URL("_test_computed_src.js", import.meta.url).href;
    const state = await buildScope(
      {
        state: {
          items: { default: [1, 2, 3], type: "array" },
          total: { $export: "total", $prototype: "Function", $src: srcUrl },
        },
      },
      {},
      BASE,
    );
    expect(state.total).toBe(3);
  });

  test("Shape 4: Function with $src + parameters in def → callable (not computed)", async () => {
    const srcUrl = new URL("_test_handlers_fn.js", import.meta.url).href;
    const state = await buildScope(
      {
        state: {
          handler: {
            $export: "myFn",
            $prototype: "Function",
            $src: srcUrl,
            parameters: ["event"],
          },
        },
      },
      {},
      BASE,
    );
    expect(typeof state.handler).toBe("function");
  });

  test("Shape 4: Function with $src → computed when fn has return and ≤1 param", async () => {
    const srcUrl = new URL("_test_handlers_fn.js", import.meta.url).href;
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
            bad: {
              $prototype: "Function",
              $src: "./foo.js",
              body: "return 1;",
            },
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
    expect(fnOf(state, "empty")()).toBeUndefined();
  });

  // Shape 5: External class $prototype
  test("Shape 5: $prototype other than Function → resolvePrototype", async () => {
    const doc = { state: { items: { $prototype: "Set", default: [1, 2] } } };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
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
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
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
            count: 5,
            data: {
              $export: "getData",
              $src: "./nonexistent.js",
              timing: "server",
            },
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
            count: { default: 42, type: "integer" },
            name: "hello",
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
            $export: "missing",
            $src: "./nonexistent.js",
            timing: "server",
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
  let el: HTMLElement;
  beforeEach(() => {
    el = document.createElement("div");
    for (const s of document.head.querySelectorAll("style")) {
      s.remove();
    }
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
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style).not.toBeNull();
    expect(style.textContent).toContain(`[data-jx="${uid}"]:hover`);
    expect(style.textContent).toContain("color: blue");
  });

  test("emits scoped <style> for .class selector", () => {
    applyStyle(el, { ".child": { marginTop: "4px" } });
    const uid = el.dataset.jx;
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style.textContent).toContain(`[data-jx="${uid}"].child`);
  });

  test("emits scoped <style> for &.compound selector", () => {
    applyStyle(el, { "&.active": { fontWeight: "bold" } });
    const uid = el.dataset.jx;
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style.textContent).toContain(`[data-jx="${uid}"].active`);
  });

  test("emits scoped <style> for [attr] selector", () => {
    applyStyle(el, { "[disabled]": { opacity: "0.5" } });
    const uid = el.dataset.jx;
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style.textContent).toContain(`[data-jx="${uid}"][disabled]`);
  });

  test("resolves named @--breakpoint from mediaQueries", () => {
    applyStyle(el, { "@--md": { fontSize: "18px" } }, { "--md": "(min-width: 768px)" });
    const uid = el.dataset.jx;
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style.textContent).toContain("@media (min-width: 768px)");
    expect(style.textContent).toContain(`[data-jx="${uid}"]`);
    expect(style.textContent).toContain("font-size: 18px");
  });

  test("uses literal condition for @(min-width:...) keys", () => {
    applyStyle(el, { "@(min-width: 1024px)": { padding: "2rem" } });
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style.textContent).toContain("@media (min-width: 1024px)");
  });

  test("falls back to raw name when @--name not found in mediaQueries", () => {
    applyStyle(el, { "@--xl": { gap: "2rem" } }, {});
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style.textContent).toContain("@media --xl");
  });

  test("combined inline + nested + media", () => {
    applyStyle(
      el,
      {
        ":focus": { outline: "2px solid blue" },
        "@--sm": { color: "red" },
        color: "green",
      },
      { "--sm": "(min-width: 640px)" },
    );
    // Color is in stylesheet (not inline) because it's overridden by a media query
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style.textContent).toContain("color: green");
    expect(style.textContent).toContain("]:focus");
    expect(style.textContent).toContain("@media (min-width: 640px)");
  });

  test("nested selector inside media block", () => {
    applyStyle(
      el,
      { "@--md": { ":hover": { color: "blue" }, fontSize: "2rem" } },
      { "--md": "(min-width: 768px)" },
    );
    const style = document.head.querySelector("style") as HTMLStyleElement;
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
    const style = document.head.querySelector("style") as HTMLStyleElement;
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
    applyStyle(el, { "--accent": "green", color: "blue" });
    expect(el.style.color).toBe("blue");
    expect(el.style.getPropertyValue("--accent")).toBe("green");
  });
});

// ─── resolvePrototype ─────────────────────────────────────────────────────────

describe("resolvePrototype", () => {
  test("Request: returns ref, starts null, fetches and sets data", async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        json: () => Promise.resolve({ id: 1 }),
        ok: true,
      }),
    ) as any;
    const state = reactive({} as Record<string, unknown>);
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
    const fetchMock = mock(() => Promise.resolve({ json: () => Promise.resolve({}), ok: true }));
    global.fetch = fetchMock as any;
    const state = reactive({} as Record<string, unknown>);
    await resolvePrototype({ $prototype: "Request", manual: true, url: "/api/x" }, state, "x");
    await wait();
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("Request: sets error on non-ok response", async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        json: () => Promise.resolve({}),
        ok: false,
        statusText: "Not Found",
      }),
    ) as any;
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype({ $prototype: "Request", url: "/api/z" }, state, "z");
    state.z = result;
    await wait();
    expect(state.z).toHaveProperty("error");
  });

  test("Request: POST with headers and body", async () => {
    let captured = undefined as any;
    global.fetch = mock((_url, opts) => {
      captured = opts;
      return Promise.resolve({ json: () => Promise.resolve({}), ok: true });
    }) as any;
    const state = reactive({} as Record<string, unknown>);
    await resolvePrototype(
      {
        $prototype: "Request",
        body: { a: 1 },
        headers: { x: "1" },
        method: "POST",
        url: "/api",
      },
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
    const state = reactive({} as Record<string, unknown>);
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
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype(
      { $prototype: "LocalStorage", default: "fallback", key: "lsMissing" },
      state,
      "ls",
    );
    state.ls = result;
    expect(state.ls).toBe("fallback");
  });

  test("LocalStorage: assignment persists to storage", async () => {
    localStorage.removeItem("lsPersist");
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype(
      { $prototype: "LocalStorage", default: 0, key: "lsPersist" },
      state,
      "ls",
    );
    state.ls = result;
    state.ls = 123;
    await wait();
    expect(JSON.parse(localStorage.getItem("lsPersist") as string)).toBe(123);
    localStorage.removeItem("lsPersist");
  });

  test("SessionStorage: reads and writes session storage", async () => {
    sessionStorage.setItem("ssKey", JSON.stringify("hello"));
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype(
      { $prototype: "SessionStorage", key: "ssKey" },
      state,
      "ss",
    );
    state.ss = result;
    expect(state.ss).toBe("hello");
    state.ss = "world";
    await wait();
    expect(JSON.parse(sessionStorage.getItem("ssKey") as string)).toBe("world");
    sessionStorage.removeItem("ssKey");
  });

  test("Cookie: reads, writes cookie", async () => {
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype(
      {
        $prototype: "Cookie",
        default: null,
        maxAge: 3600,
        name: "testCookie",
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
    const fakeReq = { addEventListener: () => {} };
    global.indexedDB = { open: () => fakeReq } as any;
    const state = reactive({} as Record<string, unknown>);
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
    delete (global as any).indexedDB;
  });

  test("Set: returns a Set", async () => {
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype({ $prototype: "Set" }, state, "s");
    state.s = result;
    expect(state.s).toBeInstanceOf(Set);
    expect((state.s as Set<unknown>).size).toBe(0);
  });

  test("Set: default values", async () => {
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype({ $prototype: "Set", default: [1, 2] }, state, "s");
    state.s = result;
    expect((state.s as Set<unknown>).has(1)).toBe(true);
  });

  test("Map: returns a Map", async () => {
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype({ $prototype: "Map" }, state, "m");
    state.m = result;
    expect(state.m).toBeInstanceOf(Map);
  });

  test("Map: default object", async () => {
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype({ $prototype: "Map", default: { a: 1 } }, state, "m");
    state.m = result;
    expect((state.m as Map<string, unknown>).get("a")).toBe(1);
  });

  test("FormData: returns FormData", async () => {
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype(
      { $prototype: "FormData", fields: { name: "Alice" } },
      state,
      "fd",
    );
    expect(result).toBeInstanceOf(FormData);
    expect((result as any).get("name")).toBe("Alice");
  });

  test("Blob: returns Blob", async () => {
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype(
      { $prototype: "Blob", parts: ["hello"], type: "text/plain" },
      state,
      "b",
    );
    expect(result).toBeInstanceOf(Blob);
  });

  test("ReadableStream: returns null", async () => {
    const state = reactive({} as Record<string, unknown>);
    const result = await resolvePrototype({ $prototype: "ReadableStream" }, state, "rs");
    expect(result).toBeNull();
  });

  test("unknown $prototype: warns and returns ref(null)", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const state = reactive({} as Record<string, unknown>);
    const result = (await resolvePrototype({ $prototype: "Unknown" }, state, "u")) as any;
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
    const el = renderNode({ disabled: true, tagName: "button" }, reactive({}));
    expect((el as any).disabled).toBe(true);
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
    const el = renderNode(
      {
        id: { $ref: "#/state/myId" },
        tagName: "div",
      } as unknown as JxElement,
      state,
    ) as HTMLElement;
    expect(el.id).toBe("my-id");
  });

  test("binds event handler via onclick $ref", async () => {
    const state = reactive({ count: 0 });
    (state as any).clickHandler = function clickHandler(s: any) {
      s.count += 1;
    };
    const el = renderNode({ onclick: { $ref: "#/state/clickHandler" }, tagName: "button" }, state);
    el.dispatchEvent(new Event("click"));
    expect(state.count).toBe(1);
  });

  test("ignores handler $ref when not a function", () => {
    const state = reactive({ notFn: 42 });
    expect(() =>
      renderNode({ onclick: { $ref: "#/state/notFn" }, tagName: "div" }, state),
    ).not.toThrow();
  });

  test("applies attributes", () => {
    const el = renderNode({ attributes: { "data-x": "val" }, tagName: "div" }, reactive({}));
    expect(el.dataset.x).toBe("val");
  });

  test("applies reactive attribute from $ref", async () => {
    const state = reactive({ cls: "a" });
    const el = renderNode(
      { attributes: { "data-cls": { $ref: "#/state/cls" } }, tagName: "div" },
      state,
    );
    expect(el.dataset.cls).toBe("a");
    state.cls = "b";
    await wait();
    expect(el.dataset.cls).toBe("b");
  });

  test("applies static attribute from plain $ref", () => {
    const state = reactive({ val: "hello" });
    const el = renderNode(
      { attributes: { "aria-label": { $ref: "#/state/val" } }, tagName: "div" },
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
      { className: '${state.active ? "active" : "inactive"}', tagName: "div" },
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
        children: [
          { tagName: "li", textContent: "A" },
          { tagName: "li", textContent: "B" },
        ],
        tagName: "ul",
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
        $switch: { $ref: "#/state/route" },
        cases: {
          about: { tagName: "section", textContent: "About" },
          home: { tagName: "section", textContent: "Home" },
        },
        tagName: "div",
      },
      state,
    );
    expect(el.textContent).toBe("About");
  });

  test("$switch reacts to change", async () => {
    const state = reactive({ route: "home" });
    const el = renderNode(
      {
        $switch: { $ref: "#/state/route" },
        cases: {
          about: { tagName: "div", textContent: "About" },
          home: { tagName: "div", textContent: "Home" },
        },
        tagName: "div",
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
        $switch: { $ref: "#/state/route" },
        cases: { home: { tagName: "div", textContent: "Home" } },
        tagName: "div",
      },
      state,
    );
    expect(el.textContent).toBe("");
  });

  test("Array map renders static items", () => {
    const el = renderNode(
      {
        children: {
          $prototype: "Array",
          items: [{ id: 1, label: "X" }],
          map: { tagName: "li" },
        },
        tagName: "ul",
      },
      reactive({}),
    );
    expect(el.children.length).toBe(1);
  });

  test("Array map re-renders on reactive change", async () => {
    const state = reactive({ list: [{ v: "a" }, { v: "b" }] });
    const el = renderNode(
      {
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/list" },
          map: { tagName: "li" },
        },
        tagName: "ul",
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
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/list" },
          map: { tagName: "span" },
        },
        tagName: "div",
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
      isEven: (x: any) => x % 2 === 0,
      list: [1, 2, 3, 4],
    });
    const el = renderNode(
      {
        children: {
          $prototype: "Array",
          filter: { $ref: "#/state/isEven" },
          items: { $ref: "#/state/list" },
          map: { tagName: "span" },
        },
        tagName: "div",
      },
      state,
    );
    expect(el.children.length).toBe(2);
  });

  test("Array map with sort", () => {
    const state = reactive({
      list: [3, 1, 2],
      sortAsc: (a: any, b: any) => a - b,
    });
    const el = renderNode(
      {
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/list" },
          map: { tagName: "span" },
          sort: { $ref: "#/state/sortAsc" },
        },
        tagName: "div",
      },
      state,
    );
    expect(el.children.length).toBe(3);
  });

  test("Array map: items not an array returns empty", () => {
    const state = reactive({ list: null });
    const el = renderNode(
      {
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/list" },
          map: { tagName: "span" },
        },
        tagName: "div",
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
      if (!term) {
        return allItems;
      }
      return allItems.filter((i) => i.text.includes(term));
    });
    const state = reactive({ filteredItems });
    const el = renderNode(
      {
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/filteredItems" },
          map: { tagName: "div", textContent: "${$map.item.text}" },
        },
        tagName: "div",
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
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/paginatedItems" },
          map: { tagName: "div" },
        },
        tagName: "div",
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
      $props: { val: { $ref: "#/state/count" } },
      tagName: "span",
      textContent: "ok",
    };
    const el = renderNode(def, state);
    expect(el.textContent).toBe("ok");
  });

  test("style object applied", () => {
    const el = renderNode({ style: { color: "green" }, tagName: "div" }, reactive({}));
    expect(el.style.color).toBe("green");
  });
});

// ─── Integration: computed $src functions + Array map (fetch-demo pattern) ────

describe("computed $src + Array map integration", () => {
  const BASE = "http://localhost/";

  test("computed function filters items for Array map rendering", async () => {
    const srcUrl = new URL("_test_computed_src.js", import.meta.url).href;
    const doc = {
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/filteredPosts" },
        map: { tagName: "div", textContent: "${$map.item.title}" },
      },
      state: {
        allPosts: {
          default: [
            { body: "first", id: 1, title: "Hello World" },
            { body: "second", id: 2, title: "Goodbye" },
            { body: "third", id: 3, title: "Hello Again" },
          ],
          type: "array",
        },
        filteredPosts: { $prototype: "Function", $src: srcUrl },
        searchTerm: { default: "", type: "string" },
      },
      tagName: "div",
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    expect(state.filteredPosts).toHaveLength(3);

    const el = renderNode(doc as unknown as JxDocument, state) as HTMLElement;
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
    const srcUrl = new URL("_test_computed_src.js", import.meta.url).href;
    const doc = {
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/paginatedItems" },
        map: { tagName: "span", textContent: "${$map.item.name}" },
      },
      state: {
        allItems: {
          default: Array.from({ length: 12 }, (_, i) => ({
            id: i + 1,
            name: `Item ${i + 1}`,
          })),
          type: "array",
        },
        currentPage: { default: 1, type: "integer" },
        paginatedItems: { $prototype: "Function", $src: srcUrl },
        perPage: { default: 5, type: "integer" },
      },
      tagName: "div",
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    const el = renderNode(doc as unknown as JxDocument, state) as HTMLElement;
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
        addItem: {
          $prototype: "Function",
          body: "if (!event.text) return; state.items = [...state.items, { text: event.text }]; return true;",
          parameters: ["event"],
        },
        items: { default: [], type: "array" },
      },
      tagName: "div",
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    expect(typeof state.addItem).toBe("function");
    expect(state.items).toHaveLength(0);
    const result = fnOf(state, "addItem")(state, { text: "new item" });
    expect(result).toBe(true);
    expect(state.items).toHaveLength(1);
    expect((arrOf(state, "items")[0] as { text: string }).text).toBe("new item");
  });
});

// ─── Array pseudo-elements among siblings (wrapper-less) ──────────────────────

describe("Array members in a children array", () => {
  test("array member renders items in place between static siblings, no wrapper", () => {
    const state = reactive({ list: [{ v: "a" }, { v: "b" }] });
    const el = renderNode(
      {
        children: [
          { tagName: "h1", textContent: "head" },
          {
            $prototype: "Array",
            items: { $ref: "#/state/list" },
            map: { tagName: "li", textContent: "${$map.item.v}" },
          },
          { tagName: "footer", textContent: "foot" },
        ],
        tagName: "div",
      },
      state,
    );
    // No extra wrapper: h1 + 2×li + footer are all direct children of <div>.
    const tags = [...el.children].map((c) => c.tagName.toLowerCase());
    expect(tags).toEqual(["h1", "li", "li", "footer"]);
    expect(el.children[1].textContent).toBe("a");
    expect(el.children[2].textContent).toBe("b");
  });

  test("array member as the sole child renders items directly into the parent", () => {
    const state = reactive({ list: [1, 2, 3] });
    const el = renderNode(
      {
        children: [
          { $prototype: "Array", items: { $ref: "#/state/list" }, map: { tagName: "li" } },
        ],
        tagName: "ul",
      },
      state,
    );
    expect([...el.children].map((c) => c.tagName.toLowerCase())).toEqual(["li", "li", "li"]);
  });

  test("array member re-renders only its own items, leaving siblings intact", async () => {
    const state = reactive({ list: [{ v: "a" }, { v: "b" }] });
    const el = renderNode(
      {
        children: [
          { tagName: "h1", textContent: "head" },
          {
            $prototype: "Array",
            items: { $ref: "#/state/list" },
            map: { tagName: "li", textContent: "${$map.item.v}" },
          },
        ],
        tagName: "div",
      },
      state,
    );
    expect(el.children.length).toBe(3);
    state.list = [{ v: "x" }];
    await wait();
    const tags = [...el.children].map((c) => c.tagName.toLowerCase());
    expect(tags).toEqual(["h1", "li"]);
    expect(el.children[0].textContent).toBe("head");
    expect(el.children[1].textContent).toBe("x");
  });

  test("two array members as siblings keep their relative order", () => {
    const state = reactive({ a: ["a1", "a2"], b: ["b1"] });
    const el = renderNode(
      {
        children: [
          { $prototype: "Array", items: { $ref: "#/state/a" }, map: { tagName: "i" } },
          { $prototype: "Array", items: { $ref: "#/state/b" }, map: { tagName: "b" } },
        ],
        tagName: "div",
      },
      state,
    );
    expect([...el.children].map((c) => c.tagName.toLowerCase())).toEqual(["i", "i", "b"]);
  });

  test("nested array (array template containing an array) renders and disposes cleanly", async () => {
    const state = reactive({ groups: [{ items: ["x", "y"] }, { items: ["z"] }] });
    const el = renderNode(
      {
        children: [
          {
            $prototype: "Array",
            items: { $ref: "#/state/groups" },
            map: {
              children: [
                {
                  $prototype: "Array",
                  items: { $ref: "$map/item/items" },
                  map: { tagName: "span" },
                },
              ],
              tagName: "section",
            },
          },
        ],
        tagName: "div",
      },
      state,
    );
    const sections = el.querySelectorAll("section");
    expect(sections.length).toBe(2);
    expect(sections[0].querySelectorAll("span").length).toBe(2);
    expect(sections[1].querySelectorAll("span").length).toBe(1);
    // Replacing the outer list disposes the old generation's inner arrays and rebuilds.
    state.groups = [{ items: ["only"] }];
    await wait();
    expect(el.querySelectorAll("section").length).toBe(1);
    expect(el.querySelectorAll("span").length).toBe(1);
  });

  test("empty items array renders no item nodes but keeps siblings", async () => {
    const state = reactive({ list: [] as number[] });
    const el = renderNode(
      {
        children: [
          { tagName: "h1" },
          { $prototype: "Array", items: { $ref: "#/state/list" }, map: { tagName: "li" } },
        ],
        tagName: "div",
      },
      state,
    );
    expect(el.querySelectorAll("li").length).toBe(0);
    expect(el.children.length).toBe(1);
    state.list = [1, 2];
    await wait();
    expect(el.querySelectorAll("li").length).toBe(2);
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
    const state = await Jx({ state: { x: 1 }, tagName: "div" }, target);
    expect(state.x).toBe(1);
  });

  test("returns scope with expanded signal property", async () => {
    const target = document.createElement("div");
    const state = await Jx({ state: { x: { default: 5 } }, tagName: "div" }, target);
    expect(state.x).toBe(5);
  });

  test("calls onMount if present in scope", async () => {
    const target = document.createElement("div");
    const srcUrl = new URL("_test_handlers.js", import.meta.url).href;
    await Jx(
      {
        state: {
          onMount: { $prototype: "Function", $src: srcUrl },
        },
        tagName: "div",
      },
      target,
    );
    await wait();
    expect((globalThis as any)._testMounted).toBe(true);
    delete (globalThis as any)._testMounted;
  });

  test("fetches string source", async () => {
    const doc = { tagName: "article" };
    global.fetch = mock(() =>
      Promise.resolve({
        json: () => Promise.resolve(doc),
        ok: true,
      }),
    ) as any;
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
  let el: HTMLElement;
  beforeEach(() => {
    el = document.createElement("div");
    for (const s of document.head.querySelectorAll("style")) {
      s.remove();
    }
  });

  test("@starting-style emits without @media wrapper", () => {
    applyStyle(el, {
      "@starting-style": {
        ":popover-open": { transform: "translateX(100%)" },
      },
    });
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style.textContent).toContain("@starting-style");
    expect(style.textContent).not.toContain("@media starting-style");
    expect(style.textContent).toContain(":popover-open");
    expect(style.textContent).toContain("transform: translateX(100%)");
  });

  test("@supports emits as-is", () => {
    applyStyle(el, {
      "@supports (display: grid)": { display: "grid" },
    });
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style.textContent).toContain("@supports (display: grid)");
    expect(style.textContent).not.toContain("@media");
  });

  test("@(condition) emits as @media shorthand", () => {
    applyStyle(el, {
      "@(max-width: 600px)": { fontSize: "14px" },
    });
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style.textContent).toContain("@media (max-width: 600px)");
  });

  test("@--breakpoint still resolves from mediaQueries", () => {
    applyStyle(el, { "@--lg": { fontSize: "20px" } }, { "--lg": "(min-width: 1024px)" });
    const style = document.head.querySelector("style") as HTMLStyleElement;
    expect(style.textContent).toContain("@media (min-width: 1024px)");
  });
});

// ─── $expression (Shape 5) ───────────────────────────────────────────────────

describe("isMutating", () => {
  test("identifies mutating operators", () => {
    expect(isMutating("=")).toBe(true);
    expect(isMutating("+=")).toBe(true);
    expect(isMutating("push")).toBe(true);
    expect(isMutating("splice")).toBe(true);
  });
  test("identifies pure operators", () => {
    expect(isMutating("+")).toBe(false);
    expect(isMutating("!")).toBe(false);
    expect(isMutating("===")).toBe(false);
    expect(isMutating("reduce")).toBe(false);
  });
});

describe("evaluateExpression — pure operators", () => {
  const state = reactive({ count: 5, flag: true, items: [1, 2, 3] });

  test("unary ! negation", () => {
    const node = { operator: "!", target: { $ref: "#/state/flag" } };
    expect(evaluateExpression(node, state, null)).toBe(false);
  });

  test("unary - negation", () => {
    const node = { operator: "-", target: { $ref: "#/state/count" } };
    expect(evaluateExpression(node, state, null)).toBe(-5);
  });

  test("binary arithmetic +", () => {
    const node = { operator: "+", target: { $ref: "#/state/count" }, value: 3 };
    expect(evaluateExpression(node, state, null)).toBe(8);
  });

  test("binary arithmetic *", () => {
    const node = { operator: "*", target: 4, value: 3 };
    expect(evaluateExpression(node, state, null)).toBe(12);
  });

  test("comparison ===", () => {
    const node = {
      operator: "===",
      target: { $ref: "#/state/count" },
      value: 5,
    };
    expect(evaluateExpression(node, state, null)).toBe(true);
  });

  test("comparison !==", () => {
    const node = {
      operator: "!==",
      target: { $ref: "#/state/count" },
      value: 3,
    };
    expect(evaluateExpression(node, state, null)).toBe(true);
  });

  test("logical &&", () => {
    const node = {
      operator: "&&",
      target: { $ref: "#/state/flag" },
      value: { $ref: "#/state/count" },
    };
    expect(evaluateExpression(node, state, null)).toBe(5);
  });

  test("logical ||", () => {
    const node = {
      operator: "||",
      target: false,
      value: { $ref: "#/state/count" },
    };
    expect(evaluateExpression(node, state, null)).toBe(5);
  });

  test("nested expression: count + 1", () => {
    const node = {
      operator: "+",
      target: { $ref: "#/state/count" },
      value: { operator: "*", target: 2, value: 3 },
    };
    expect(evaluateExpression(node, state, null)).toBe(11);
  });

  test("throws on unknown operator", () => {
    const node = { operator: "**", target: 2, value: 3 };
    expect(() => evaluateExpression(node, state, null)).toThrow('unknown operator "**"');
  });
});

describe("evaluateExpression — mutating operators", () => {
  test("assignment =", () => {
    const state = reactive({ count: 0 });
    const node = {
      operator: "=",
      target: { $ref: "#/state/count" },
      value: 42,
    };
    evaluateExpression(node, state, null);
    expect(state.count).toBe(42);
  });

  test("compound +=", () => {
    const state = reactive({ count: 10 });
    const node = {
      operator: "+=",
      target: { $ref: "#/state/count" },
      value: 5,
    };
    evaluateExpression(node, state, null);
    expect(state.count).toBe(15);
  });

  test("compound -=", () => {
    const state = reactive({ count: 10 });
    const node = {
      operator: "-=",
      target: { $ref: "#/state/count" },
      value: 3,
    };
    evaluateExpression(node, state, null);
    expect(state.count).toBe(7);
  });

  test("toggle via = and nested !", () => {
    const state = reactive({ dark: false });
    const node = {
      operator: "=",
      target: { $ref: "#/state/dark" },
      value: { operator: "!", target: { $ref: "#/state/dark" } },
    };
    evaluateExpression(node, state, null);
    expect(state.dark).toBe(true);
    evaluateExpression(node, state, null);
    expect(state.dark).toBe(false);
  });

  test("push to array", () => {
    const state = reactive({ items: [1, 2] });
    const node = {
      operator: "push",
      target: { $ref: "#/state/items" },
      value: 3,
    };
    evaluateExpression(node, state, null);
    expect(state.items).toEqual([1, 2, 3]);
  });

  test("pop from array", () => {
    const state = reactive({ items: [1, 2, 3] });
    const node = { operator: "pop", target: { $ref: "#/state/items" } };
    evaluateExpression(node, state, null);
    expect(state.items).toEqual([1, 2]);
  });

  test("splice array", () => {
    const state = reactive({ items: ["a", "b", "c", "d"] });
    const node = {
      operator: "splice",
      target: { $ref: "#/state/items" },
      value: [1, 2],
    };
    evaluateExpression(node, state, null);
    expect(state.items).toEqual(["a", "d"]);
  });

  test("assignment with event# ref", () => {
    const state = reactive({ name: "" });
    const event = { target: { value: "hello" } };
    const node = {
      operator: "=",
      target: { $ref: "#/state/name" },
      value: { $ref: "event#/target/value" },
    };
    evaluateExpression(node, state, event as unknown as Event);
    expect(state.name).toBe("hello");
  });

  test("assignment to nested path", () => {
    const state = reactive({ user: { name: "old" } });
    const node = {
      operator: "=",
      target: { $ref: "#/state/user/name" },
      value: "new",
    };
    evaluateExpression(node, state, null);
    expect(state.user.name).toBe("new");
  });
});

describe("evaluateExpression — aggregates", () => {
  test("reduce: sum", () => {
    const state = reactive({ nums: [1, 2, 3, 4] });
    const node = {
      initial: 0,
      operator: "reduce",
      target: { $ref: "#/state/nums" },
      value: {
        operator: "+",
        target: { $ref: "$reduce/acc" },
        value: { $ref: "$map/item" },
      },
    };
    expect(evaluateExpression(node, state, null)).toBe(10);
  });

  test("reduce: cart total (acc + price * qty)", () => {
    const state = reactive({
      cart: [
        { price: 10, qty: 2 },
        { price: 5, qty: 3 },
      ],
    });
    const node = {
      initial: 0,
      operator: "reduce",
      target: { $ref: "#/state/cart" },
      value: {
        operator: "+",
        target: { $ref: "$reduce/acc" },
        value: {
          operator: "*",
          target: { $ref: "$map/item/price" },
          value: { $ref: "$map/item/qty" },
        },
      },
    };
    expect(evaluateExpression(node, state, null)).toBe(35);
  });

  test("map: double each item", () => {
    const state = reactive({ nums: [1, 2, 3] });
    const node = {
      operator: "map",
      target: { $ref: "#/state/nums" },
      value: { operator: "*", target: { $ref: "$map/item" }, value: 2 },
    };
    expect(evaluateExpression(node, state, null)).toEqual([2, 4, 6]);
  });

  test("filter: keep items > 2", () => {
    const state = reactive({ nums: [1, 2, 3, 4] });
    const node = {
      operator: "filter",
      target: { $ref: "#/state/nums" },
      value: { operator: ">", target: { $ref: "$map/item" }, value: 2 },
    };
    expect(evaluateExpression(node, state, null)).toEqual([3, 4]);
  });
});

describe("buildScope — $expression (Shape 5)", () => {
  test("mutating expression becomes a handler function", async () => {
    const scope = await buildScope({
      state: {
        count: 0,
        increment: {
          $expression: {
            operator: "+=",
            target: { $ref: "#/state/count" },
            value: 1,
          },
        },
      },
    });
    expect(typeof scope.increment).toBe("function");
    fnOf(scope, "increment")(scope, null);
    expect(scope.count).toBe(1);
  });

  test("pure expression becomes a computed value", async () => {
    const scope = await buildScope({
      state: {
        a: 3,
        b: 4,
        sum: {
          $expression: {
            operator: "+",
            target: { $ref: "#/state/a" },
            value: { $ref: "#/state/b" },
          },
        },
      },
    });
    expect(scope.sum).toBe(7);
  });

  test("pure reduce expression is reactive", async () => {
    const scope = await buildScope({
      state: {
        nums: [1, 2, 3],
        total: {
          $expression: {
            initial: 0,
            operator: "reduce",
            target: { $ref: "#/state/nums" },
            value: {
              operator: "+",
              target: { $ref: "$reduce/acc" },
              value: { $ref: "$map/item" },
            },
          },
        },
      },
    });
    expect(scope.total).toBe(6);
    arrOf(scope, "nums").push(4);
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(scope.total).toBe(10);
  });

  test("named expression bound via $ref from event handler", async () => {
    const scope = await buildScope({
      state: {
        count: 0,
        increment: {
          $expression: {
            operator: "+=",
            target: { $ref: "#/state/count" },
            value: 1,
          },
        },
      },
    });
    const el = renderNode({ onclick: { $ref: "#/state/increment" }, tagName: "button" }, scope);
    el.dispatchEvent(new Event("click"));
    expect(scope.count).toBe(1);
  });

  test("inline $expression on event handler", async () => {
    const scope = await buildScope({ state: { count: 0 } });
    const el = renderNode(
      {
        onclick: {
          $expression: {
            operator: "+=",
            target: { $ref: "#/state/count" },
            value: 5,
          },
        },
        tagName: "button",
      },
      scope,
    );
    el.dispatchEvent(new Event("click"));
    expect(scope.count).toBe(5);
  });

  test("$expression not treated as plain object value", async () => {
    const scope = await buildScope({
      state: {
        on: false,
        toggle: {
          $expression: {
            operator: "=",
            target: { $ref: "#/state/on" },
            value: { operator: "!", target: { $ref: "#/state/on" } },
          },
        },
      },
    });
    expect(typeof scope.toggle).toBe("function");
    expect(scope.on).toBe(false);
    fnOf(scope, "toggle")(scope, null);
    expect(scope.on).toBe(true);
  });
});
