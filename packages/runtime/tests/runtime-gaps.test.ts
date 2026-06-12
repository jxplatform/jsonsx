import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, test, expect, mock, spyOn } from "bun:test";
import { reactive } from "@vue/reactivity";
import type { Ref } from "@vue/reactivity";
import {
  applyStyle,
  buildScope,
  elementStyleTags,
  Jx,
  reapplyStyle,
  renderNode as _renderNode,
  resolvePrototype,
  resolveRef,
  setSkipContentResolution,
} from "../src/runtime";
import type { JxDocument } from "@jxsuite/schema/types";

try {
  GlobalRegistrator.register();
} catch {
  /* Already registered */
}

const renderNode: (...args: Parameters<typeof _renderNode>) => HTMLElement = _renderNode as any;

describe("setSkipContentResolution", () => {
  test("is a retained no-op", () => {
    expect(setSkipContentResolution(true)).toBeUndefined();
    expect(setSkipContentResolution(false)).toBeUndefined();
  });
});

const wait = (ms = 0) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ─── renderNode: text nodes & local $-bindings ───────────────────────────────

describe("renderNode text nodes", () => {
  test("bare string/number/boolean children become text nodes", () => {
    const el = renderNode({ children: ["hi", 5, true], tagName: "div" } as any, reactive({}));
    expect(el.childNodes.length).toBe(3);
    expect(el.childNodes[0].textContent).toBe("hi");
    expect(el.childNodes[1].textContent).toBe("5");
    expect(el.childNodes[2].textContent).toBe("true");
  });

  test("template string child is reactive", async () => {
    const state = reactive({ msg: "first" });
    const el = renderNode({ children: ["${state.msg}"], tagName: "div" } as any, state);
    expect(el.textContent).toBe("first");
    state.msg = "second";
    await wait();
    expect(el.textContent).toBe("second");
  });

  test("$-prefixed local bindings extend scope ($ref and literal)", async () => {
    const state = reactive({ x: "from-state" });
    const el = renderNode(
      {
        $bar: "literal",
        $foo: { $ref: "#/state/x" },
        children: ["${state.$foo}-${state.$bar}"],
        tagName: "div",
      } as any,
      state,
    );
    expect(el.textContent).toBe("from-state-literal");
  });

  test("onNodeCreated fires with element, path, def, state", () => {
    const seen: { path: unknown; tag: string }[] = [];
    const el = renderNode(
      { children: [{ tagName: "span" }], tagName: "div" } as any,
      reactive({}),
      {
        onNodeCreated: (node: HTMLElement, path: unknown) => {
          seen.push({ path, tag: node.tagName.toLowerCase() });
        },
      } as any,
    );
    expect(el.tagName.toLowerCase()).toBe("div");
    expect(seen.length).toBe(2);
    expect(seen[0].tag).toBe("div");
    expect(seen[1].tag).toBe("span");
    expect(seen[1].path).toEqual(["children", 0]);
  });
});

// ─── applyProperties: inline handlers ─────────────────────────────────────────

describe("inline event handlers", () => {
  test("inline $prototype Function handler is wired", () => {
    const state = reactive({ clicked: false });
    const el = renderNode(
      {
        onclick: {
          $prototype: "Function",
          body: "state.clicked = true;",
          parameters: ["event"],
        },
        tagName: "button",
      } as any,
      state,
    );
    el.dispatchEvent(new Event("click"));
    expect(state.clicked).toBe(true);
  });

  test("inline $expression handler is wired", () => {
    const state = reactive({ count: 0 });
    const el = renderNode(
      {
        onclick: {
          $expression: { operator: "+=", target: { $ref: "#/state/count" }, value: 1 },
        },
        tagName: "button",
      } as any,
      state,
    );
    el.dispatchEvent(new Event("click"));
    el.dispatchEvent(new Event("click"));
    expect(state.count).toBe(2);
  });

  test("on*-keyed value that is not a handler shape falls through to property binding", () => {
    const el = renderNode({ onfake: "not-a-handler", tagName: "div" } as any, reactive({}));
    expect((el as any).onfake).toBe("not-a-handler");
  });
});

// ─── applyAttributes: template strings ───────────────────────────────────────

describe("applyAttributes template strings", () => {
  test("template attribute is reactive", async () => {
    const state = reactive({ t: "one" });
    const el = renderNode({ attributes: { title: "${state.t}" }, tagName: "div" } as any, state);
    expect(el.getAttribute("title")).toBe("one");
    state.t = "two";
    await wait();
    expect(el.getAttribute("title")).toBe("two");
  });
});

// ─── applyStyle: template strings, nested-in-nested, media ───────────────────

describe("applyStyle gaps", () => {
  test("template string in custom property and regular property is reactive", async () => {
    const state = reactive({ c: "red" });
    const el = document.createElement("div");
    applyStyle(el, { "--accent": "${state.c}", color: "${state.c}" } as any, {}, state);
    expect(el.style.getPropertyValue("--accent")).toBe("red");
    expect(el.style.color).toBe("red");
    state.c = "blue";
    await wait();
    expect(el.style.getPropertyValue("--accent")).toBe("blue");
    expect(el.style.color).toBe("blue");
  });

  test("nested selectors recurse (&, [attr], :pseudo, .class, descendant, @ skipped)", () => {
    const el = document.createElement("div");
    applyStyle(el, {
      ".kid": {
        "&:hover": { color: "blue" },
        ":focus": { outline: "1px solid" },
        ".sub": { margin: "1px" },
        "@media print": { color: "black" },
        "[data-a]": { padding: "2px" },
        color: "red",
        span: { fontSize: "10px" },
      },
    } as any);
    const uid = el.dataset.jx as string;
    expect(uid).toBeTruthy();
    const tag = elementStyleTags.get(el) as HTMLStyleElement;
    const css = tag.textContent as string;
    expect(css).toContain(`[data-jx="${uid}"].kid { color: red }`);
    expect(css).toContain(`[data-jx="${uid}"].kid:hover { color: blue }`);
    expect(css).toContain(`[data-jx="${uid}"].kid:focus { outline: 1px solid }`);
    expect(css).toContain(`[data-jx="${uid}"].kid[data-a] { padding: 2px }`);
    expect(css).toContain(`[data-jx="${uid}"].kid.sub { margin: 1px }`);
    expect(css).toContain(`[data-jx="${uid}"].kid span { font-size: 10px }`);
    expect(css).not.toContain("@media print");
  });

  test("media queries: named breakpoint, @( shorthand, raw @media, @-- skipped, base decls", () => {
    const el = document.createElement("div");
    applyStyle(
      el,
      {
        "@(max-width: 100px)": { margin: "0" },
        "@--": { color: "ignored" },
        "@--sm": {
          ".inner": { "&:active": { color: "green" }, color: "teal" },
          color: "blue",
        },
        "@media (min-width: 900px)": { padding: "4px" },
        color: "red",
      } as any,
      { "--sm": "(min-width: 640px)" },
    );
    const uid = el.dataset.jx as string;
    const css = (elementStyleTags.get(el) as HTMLStyleElement).textContent as string;
    // Base decl moved out of inline style because it is media-overridden
    expect(el.style.color).toBe("");
    expect(css).toContain(`[data-jx="${uid}"] { color: red }`);
    expect(css).toContain(`@media (min-width: 640px) { [data-jx="${uid}"] { color: blue } }`);
    expect(css).toContain(`@media (max-width: 100px) { [data-jx="${uid}"] { margin: 0 } }`);
    expect(css).toContain(`@media (min-width: 900px) { [data-jx="${uid}"] { padding: 4px } }`);
    // Nested selector inside media query
    expect(css).toContain(`@media (min-width: 640px) { [data-jx="${uid}"].inner { color: teal } }`);
    expect(css).toContain(
      `@media (min-width: 640px) { [data-jx="${uid}"].inner:active { color: green } }`,
    );
    expect(css).not.toContain("ignored");
  });

  test("scalar under a selector-like key is dropped", () => {
    const el = document.createElement("div");
    applyStyle(el, { ":hover": "red", color: "green" } as any);
    expect(el.style.color).toBe("green");
    expect(elementStyleTags.get(el)).toBeUndefined();
  });
});

// ─── reapplyStyle ─────────────────────────────────────────────────────────────

describe("reapplyStyle", () => {
  test("removes previous scoped style tag and inline styles", () => {
    const el = document.createElement("div");
    applyStyle(el, { ".kid": { color: "red" }, color: "purple" } as any);
    const prevTag = elementStyleTags.get(el) as HTMLStyleElement;
    expect(prevTag.isConnected).toBe(true);
    reapplyStyle(el, { color: "green" });
    expect(prevTag.isConnected).toBe(false);
    expect(elementStyleTags.get(el)).toBeUndefined();
    expect(el.style.color).toBe("green");
    expect(el.dataset.jx).toBeUndefined();
  });

  test("handles element with no previous style tag and undefined def", () => {
    const el = document.createElement("div");
    el.style.color = "red";
    // oxlint-disable-next-line unicorn/no-useless-undefined -- param is required; exercises the undefined styleDef branch
    reapplyStyle(el, undefined);
    expect(el.style.color).toBe("");
  });
});

// ─── renderSwitch gaps ────────────────────────────────────────────────────────

describe("renderSwitch gaps", () => {
  test("non-ref $switch renders empty container", () => {
    const el = renderNode(
      { $switch: "not-a-ref", cases: { a: { tagName: "span" } }, tagName: "div" } as any,
      reactive({}),
    );
    expect(el.children.length).toBe(0);
  });

  test("onNodeCreated fires for switch container", () => {
    const created: string[] = [];
    renderNode(
      { $switch: { $ref: "#/state/k" }, cases: {}, tagName: "section" } as any,
      reactive({ k: "x" }),
      { onNodeCreated: (n: HTMLElement) => created.push(n.tagName.toLowerCase()) } as any,
    );
    expect(created).toEqual(["section"]);
  });

  test("external $ref case fetches, builds scope, and renders", async () => {
    const extDoc = {
      children: ["${state.label}"],
      state: { label: "external!" },
      tagName: "article",
    };
    global.fetch = mock(() =>
      Promise.resolve({ json: () => Promise.resolve(extDoc), ok: true }),
    ) as any;
    const state = reactive({ page: "ext" });
    const el = renderNode(
      {
        $switch: { $ref: "#/state/page" },
        cases: { ext: { $ref: "http://localhost/gaps-ext-case.json" } },
        tagName: "div",
      } as any,
      state,
    );
    await wait(10);
    expect(el.children.length).toBe(1);
    expect(el.children[0].tagName.toLowerCase()).toBe("article");
    expect(el.children[0].textContent).toBe("external!");
  });

  test("stale external case (superseded before fetch resolves) is dropped", async () => {
    const dA = deferred<unknown>();
    const dB = deferred<unknown>();
    global.fetch = mock((url: string) =>
      String(url).includes("gaps-stale-a") ? dA.promise : dB.promise,
    ) as any;
    const state = reactive({ page: "a" });
    const el = renderNode(
      {
        $switch: { $ref: "#/state/page" },
        cases: {
          a: { $ref: "http://localhost/gaps-stale-a.json" },
          b: { $ref: "http://localhost/gaps-stale-b.json" },
        },
        tagName: "div",
      } as any,
      state,
    );
    state.page = "b"; // Supersede before A's fetch resolves
    dA.resolve({
      json: () => Promise.resolve({ children: ["A"], tagName: "article" }),
      ok: true,
    });
    dB.resolve({
      json: () => Promise.resolve({ children: ["B"], tagName: "aside" }),
      ok: true,
    });
    await wait(10);
    expect(el.children.length).toBe(1);
    expect(el.children[0].tagName.toLowerCase()).toBe("aside");
    expect(el.textContent).toBe("B");
  });

  test("stale external case (superseded during buildScope) is dropped", async () => {
    const dClass = deferred<unknown>();
    const docA = {
      children: ["A944"],
      state: { slow: { $prototype: "Slow", $src: "http://localhost/gaps-slow.class.json" } },
      tagName: "article",
    };
    const docB = { children: ["B944"], tagName: "aside" };
    global.fetch = mock((url: string) => {
      const u = String(url);
      if (u.includes("gaps-slow.class.json")) {
        return dClass.promise;
      }
      const doc = u.includes("gaps-944-a") ? docA : docB;
      return Promise.resolve({ json: () => Promise.resolve(doc), ok: true });
    }) as any;
    const state = reactive({ page: "a" });
    const el = renderNode(
      {
        $switch: { $ref: "#/state/page" },
        cases: {
          a: { $ref: "http://localhost/gaps-944-a.json" },
          b: { $ref: "http://localhost/gaps-944-b.json" },
        },
        tagName: "div",
      } as any,
      state,
    );
    await wait(10); // A's scope build is now blocked on the pending .class.json fetch
    state.page = "b"; // Supersede while A is mid-buildScope
    await wait(10);
    expect(el.textContent).toBe("B944");
    dClass.resolve({
      json: () => Promise.resolve({ $defs: { fields: {} }, title: "Slow" }),
      ok: true,
    });
    await wait(10);
    expect(el.textContent).toBe("B944"); // A944 never lands
  });

  test("external $ref case failure logs error", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    global.fetch = mock(() => Promise.resolve({ ok: false, status: 500 })) as any;
    const state = reactive({ page: "bad" });
    const el = renderNode(
      {
        $switch: { $ref: "#/state/page" },
        cases: { bad: { $ref: "http://localhost/gaps-bad-case.json" } },
        tagName: "div",
      } as any,
      state,
    );
    await wait(10);
    expect(el.children.length).toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// ─── renderMappedArray: onNodeCreated ────────────────────────────────────────

describe("renderMappedArray onNodeCreated", () => {
  test("container reported to onNodeCreated", () => {
    const created: string[] = [];
    const state = reactive({ items: ["a", "b"] });
    const el = renderNode(
      {
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/items" },
          map: { tagName: "li", textContent: "${$map.item}" },
        },
        tagName: "ul",
      } as any,
      state,
      { onNodeCreated: (n: HTMLElement) => created.push(n.tagName.toLowerCase()) } as any,
    );
    expect(created[0]).toBe("ul");
    expect(el.children.length).toBe(2);
  });
});

// ─── Request prototype gaps ──────────────────────────────────────────────────

describe("Request prototype gaps", () => {
  test("template URL is evaluated, cleanup aborts on re-run", async () => {
    const urls: string[] = [];
    global.fetch = mock((url: string) => {
      urls.push(url);
      return Promise.resolve({ json: () => Promise.resolve({ u: url }), ok: true });
    }) as any;
    const doc = {
      state: {
        endpoint: { default: "http://api.test/one" },
        result: { $prototype: "Request", url: "${state.endpoint}" },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument);
    await wait(5);
    expect(urls).toContain("http://api.test/one");
    expect((state.result as { u: string }).u).toBe("http://api.test/one");
    state.endpoint = "http://api.test/two";
    await wait(5);
    expect(urls).toContain("http://api.test/two");
    expect((state.result as { u: string }).u).toBe("http://api.test/two");
  });

  test("URL containing 'undefined' is skipped", async () => {
    const fetchMock = mock(() => Promise.resolve({ json: () => Promise.resolve({}), ok: true }));
    global.fetch = fetchMock as any;
    const doc = {
      state: {
        result: { $prototype: "Request", url: "${state.missing}/items" },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument);
    await wait(5);
    expect(fetchMock.mock.calls.length).toBe(0);
    expect(state.result).toBe(null);
  });

  test("debounce delays fetch and clears timer on re-trigger", async () => {
    const urls: string[] = [];
    global.fetch = mock((url: string) => {
      urls.push(url);
      return Promise.resolve({ json: () => Promise.resolve("done"), ok: true });
    }) as any;
    const doc = {
      state: {
        q: { default: "a" },
        result: { $prototype: "Request", debounce: 10, url: "http://api.test/?q=${state.q}" },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument);
    expect(urls.length).toBe(0);
    state.q = "b"; // Re-trigger before debounce fires — clears the first timer
    await wait(30);
    expect(urls).toEqual(["http://api.test/?q=b"]);
    expect(state.result).toBe("done");
  });
});

// ─── URLSearchParams prototype ───────────────────────────────────────────────

describe("URLSearchParams prototype", () => {
  test("builds query string from $ref, template, and literal values", async () => {
    const doc = {
      state: {
        qs: {
          $prototype: "URLSearchParams",
          a: { $ref: "#/state/x" },
          b: "${state.x}-suffix",
          c: "plain",
        },
        x: { default: "1" },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument);
    expect(state.qs).toBe("a=1&b=1-suffix&c=plain");
    state.x = "2";
    await wait();
    expect(state.qs).toBe("a=2&b=2-suffix&c=plain");
  });
});

// ─── LocalStorage gaps ───────────────────────────────────────────────────────

describe("LocalStorage gaps", () => {
  test("invalid JSON in storage falls back to default", async () => {
    localStorage.setItem("gapsBadJson", "{not json");
    const doc = {
      state: { v: { $prototype: "LocalStorage", default: "fallback", key: "gapsBadJson" } },
    };
    const state = await buildScope(doc as unknown as JxDocument);
    expect(state.v).toBe("fallback");
    localStorage.removeItem("gapsBadJson");
  });

  test("setting value to null removes the key", async () => {
    const doc = {
      state: { v: { $prototype: "LocalStorage", default: "keep", key: "gapsNull" } },
    };
    const state = await buildScope(doc as unknown as JxDocument);
    await wait();
    expect(localStorage.getItem("gapsNull")).toBe(JSON.stringify("keep"));
    state.v = null;
    await wait();
    expect(localStorage.getItem("gapsNull")).toBe(null);
  });
});

// ─── Cookie gaps ─────────────────────────────────────────────────────────────

describe("Cookie gaps", () => {
  test("reads existing JSON cookie", async () => {
    // oxlint-disable-next-line unicorn/no-document-cookie -- seeding the cookie store for the Cookie prototype read path
    document.cookie = `gapsJsonCk=${encodeURIComponent(JSON.stringify({ a: 1 }))}`;
    const doc = { state: { ck: { $prototype: "Cookie", name: "gapsJsonCk" } } };
    const state = await buildScope(doc as unknown as JxDocument);
    expect(state.ck).toEqual({ a: 1 });
  });

  test("reads existing non-JSON cookie as raw string", async () => {
    // oxlint-disable-next-line unicorn/no-document-cookie -- seeding the cookie store for the Cookie prototype read path
    document.cookie = "gapsRawCk=hello";
    const doc = { state: { ck: { $prototype: "Cookie", name: "gapsRawCk" } } };
    const state = await buildScope(doc as unknown as JxDocument);
    expect(state.ck).toBe("hello");
  });

  test("persists with maxAge, path, domain, secure, sameSite options", async () => {
    const doc = {
      state: {
        ck: {
          $prototype: "Cookie",
          default: "opt",
          domain: "localhost",
          maxAge: 60,
          name: "gapsOptCk",
          path: "/",
          sameSite: "Lax",
          secure: false,
        },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument);
    expect(state.ck).toBe("opt");
    state.ck = "updated";
    await wait();
    expect(state.ck).toBe("updated");
  });

  test("secure flag branch executes", async () => {
    const doc = {
      state: {
        ck: { $prototype: "Cookie", default: "s", name: "gapsSecCk", secure: true },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument);
    expect(state.ck).toBe("s");
  });
});

// ─── IndexedDB gaps ──────────────────────────────────────────────────────────

describe("IndexedDB gaps", () => {
  test("throws without database/store", async () => {
    expect(
      resolvePrototype({ $prototype: "IndexedDB" } as any, reactive({}), "idb"),
    ).rejects.toThrow("requires database and store");
  });

  test("upgradeneeded creates store + indexes, success exposes getStore", async () => {
    const listeners: Record<string, (e?: unknown) => void> = {};
    const fakeReq = {
      addEventListener: (n: string, cb: (e?: unknown) => void) => {
        listeners[n] = cb;
      },
      error: { message: "idb fail" },
    };
    (global as any).indexedDB = { open: mock(() => fakeReq) };

    const result = (await resolvePrototype(
      {
        $prototype: "IndexedDB",
        database: "gapsDb",
        indexes: [{ keyPath: "name", name: "byName", unique: true }],
        store: "gapsStore",
      } as any,
      reactive({}),
      "idb",
    )) as Ref<unknown>;
    expect(result.value).toBe(null);

    const indexCalls: unknown[][] = [];
    const objectStore = {
      createIndex: (...args: unknown[]) => indexCalls.push(args),
    };
    const storeNames = new Set<string>();
    const db = {
      createObjectStore: (name: string) => {
        storeNames.add(name);
        return objectStore;
      },
      objectStoreNames: { contains: (n: string) => storeNames.has(n) },
      transaction: () => ({ objectStore: () => "the-store" }),
    };
    listeners.upgradeneeded({ target: { result: db } });
    expect(storeNames.has("gapsStore")).toBe(true);
    expect(indexCalls).toEqual([["byName", "name", { unique: true }]]);

    listeners.success({ target: { result: db } });
    const api = result.value as {
      database: string;
      getStore: () => Promise<unknown>;
      isReady: boolean;
      store: string;
      version: number;
    };
    expect(api.isReady).toBe(true);
    expect(api.database).toBe("gapsDb");
    expect(api.store).toBe("gapsStore");
    expect(api.version).toBe(1);
    expect(await api.getStore()).toBe("the-store");

    listeners.error();
    expect(result.value).toEqual({ error: "idb fail" });
    delete (global as any).indexedDB;
  });
});

// ─── resolveRef deep paths ───────────────────────────────────────────────────

describe("resolveRef deep paths", () => {
  test("#/state/key/sub/path navigates nested objects", () => {
    const state = reactive({ post: { frontmatter: { title: "Deep" } } });
    expect(resolveRef("#/state/post/frontmatter/title", state)).toBe("Deep");
  });

  test("$map/item/sub navigates into item", () => {
    const state = reactive({ $map: { index: 0, item: { name: "n1" } } });
    expect(resolveRef("$map/item/name", state)).toBe("n1");
  });
});

// ─── Jx top-level: $head, $media propagation, resolve cache ─────────────────

describe("Jx gaps", () => {
  test("$media on root doc propagates to scopes built without $media", async () => {
    const target = document.createElement("div");
    await Jx({ $media: { "--sm": "(min-width: 640px)" }, state: {}, tagName: "div" }, target);
    const child = await buildScope({ state: {}, tagName: "div" } as JxDocument);
    expect(child["$media"]).toEqual({ "--sm": "(min-width: 640px)" });
  });

  test("resolve cache returns same promise for repeated source", async () => {
    const doc = { tagName: "div" };
    const fetchMock = mock(() => Promise.resolve({ json: () => Promise.resolve(doc), ok: true }));
    global.fetch = fetchMock as any;
    const target = document.createElement("div");
    await Jx("http://localhost/gaps-cached.json", target);
    await Jx("http://localhost/gaps-cached.json", target);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(target.children.length).toBe(2);
  });
});
