import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, test, expect, mock, spyOn } from "bun:test";
import { buildScope, resolvePrototype, setResolveToken } from "../src/runtime";
import { reactive } from "@vue/reactivity";
import type { JxDocument } from "@jxsuite/schema/types";

try {
  GlobalRegistrator.register();
} catch {
  /* Already registered */
}

const wait = (ms = 0) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

const BASE = import.meta.url;
const IMPL_SRC = "./_gaps_class_impl.js";
const IMPL2_SRC = "./_gaps_class_impl2.js";
const SERVER_SRC = new URL("_gaps_server_fns.js", import.meta.url).href;

/**
 * Install a fetch mock that serves .class.json GETs and records dev-proxy POSTs. Returns the array
 * of recorded POST bodies.
 */
function installFetch(opts: {
  classDefs?: Record<string, unknown>;
  classOk?: boolean;
  proxyOk?: boolean;
  proxyValue?: (body: Record<string, unknown>) => unknown;
}) {
  const posts: { body: Record<string, unknown>; url: string }[] = [];
  global.fetch = mock((url: string, init?: { body?: string; method?: string }) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      posts.push({ body, url });
      if (opts.proxyOk === false) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      const value = opts.proxyValue ? opts.proxyValue(body) : { proxied: true };
      return Promise.resolve({ json: () => Promise.resolve(value), ok: true });
    }
    if (opts.classOk === false) {
      return Promise.resolve({ ok: false, status: 404 });
    }
    for (const [match, def] of Object.entries(opts.classDefs ?? {})) {
      if (String(url).includes(match)) {
        return Promise.resolve({ json: () => Promise.resolve(def), ok: true });
      }
    }
    return Promise.resolve({ ok: false, status: 404 });
  }) as any;
  return posts;
}

// ─── resolveFunction: $src import branches ───────────────────────────────────

describe("resolveFunction $src branches", () => {
  test("falls back to bare-specifier import when base resolution fails", async () => {
    const doc = {
      state: {
        fn: { $export: "computed", $prototype: "Function", $src: "@vue/reactivity" },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, "file:///nonexistent/");
    expect(typeof state.fn).toBe("function");
  });

  test("imports absolute $src without base", async () => {
    const doc = {
      state: {
        dbl: { $export: "double", $prototype: "Function", $src: SERVER_SRC },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, "");
    // Double() has a return statement and <=1 params: wrapped in computed (async → Promise)
    expect(await (state.dbl as Promise<number>)).toBe(0);
  });

  test("throws when $src export is missing", async () => {
    const doc = {
      state: {
        bad: { $export: "nope", $prototype: "Function", $src: SERVER_SRC },
      },
    };
    expect(buildScope(doc as unknown as JxDocument, {}, "")).rejects.toThrow(
      'export "nope" not found',
    );
  });
});

// ─── resolveClassJson: hybrid $implementation ────────────────────────────────

describe("resolveClassJson hybrid", () => {
  test("instance with `value` property resolves to that value", async () => {
    installFetch({
      classDefs: { "vb.class.json": { $implementation: IMPL_SRC, title: "ValueBox" } },
    });
    const doc = {
      state: { box: { $prototype: "ValueBox", $src: "./vb.class.json", initial: "hello" } },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    expect(state.box).toBe("hello");
  });

  test("instance with resolve() + subscribe() resolves async and updates on push", async () => {
    installFetch({
      classDefs: { "rs.class.json": { $implementation: IMPL_SRC, title: "Resolvable" } },
    });
    const doc = {
      state: { r: { $prototype: "Resolvable", $src: "./rs.class.json", label: "x" } },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    expect(state.r).toBe("resolved:x");
    const inst = (globalThis as any).__gapsResolvable as { push: (v: unknown) => void };
    inst.push("next-value");
    await wait();
    expect(state.r).toBe("next-value");
    delete (globalThis as any).__gapsResolvable;
  });

  test("plain instance (no resolve, no value) resolves to the instance itself", async () => {
    installFetch({
      classDefs: { "pl.class.json": { $implementation: IMPL2_SRC, title: "PlainInstance" } },
    });
    const doc = {
      state: { p: { $prototype: "PlainInstance", $src: "./pl.class.json", label: "custom" } },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    expect((state.p as { label: string }).label).toBe("custom");
  });

  test("non-class export falls back to dev proxy", async () => {
    const posts = installFetch({
      classDefs: {
        "nc.class.json": { $implementation: IMPL_SRC, title: "Whatever" },
      },
      proxyValue: () => "from-proxy",
    });
    const doc = {
      state: {
        v: { $export: "notAClass", $prototype: "Anything", $src: "./nc.class.json" },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    await wait(5);
    expect(state.v).toBe("from-proxy");
    expect(posts.length).toBe(1);
    expect(posts[0]!.url).toBe("/__jx_resolve__");
    expect(posts[0]!.body.$export).toBe("notAClass");
  });

  test("missing export falls back to dev proxy", async () => {
    const posts = installFetch({
      classDefs: {
        "me.class.json": { $implementation: IMPL_SRC, title: "DoesNotExist" },
      },
      proxyValue: () => "proxy-2",
    });
    const doc = {
      state: { v: { $prototype: "DoesNotExist", $src: "./me.class.json" } },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    await wait(5);
    expect(state.v).toBe("proxy-2");
    expect(posts.length).toBe(1);
  });

  test("unimportable $implementation falls back to dev proxy", async () => {
    const posts = installFetch({
      classDefs: {
        "ni.class.json": { $implementation: "./__gaps_no_such_module__.js", title: "Nope" },
      },
      proxyValue: () => "proxy-3",
    });
    const doc = {
      state: { v: { $prototype: "Nope", $src: "./ni.class.json" } },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    await wait(5);
    expect(state.v).toBe("proxy-3");
    expect(posts.length).toBe(1);
  });

  test("$context reference goes straight to dev proxy", async () => {
    const posts = installFetch({
      classDefs: {
        "cx.class.json": {
          $defs: { entry: { $ref: "#/$context/content" } },
          $implementation: IMPL_SRC,
          title: "ValueBox",
        },
      },
      proxyValue: () => "ctx-proxied",
    });
    const doc = {
      state: { v: { $prototype: "ValueBox", $src: "./cx.class.json" } },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    await wait(5);
    expect(state.v).toBe("ctx-proxied");
    expect(posts.length).toBe(1);
  });

  test("failed .class.json fetch (HTTP error) falls back to dev proxy", async () => {
    const posts = installFetch({ classOk: false, proxyValue: () => "http-fallback" });
    const doc = {
      state: { v: { $prototype: "X", $src: "./missing.class.json" } },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    await wait(5);
    expect(state.v).toBe("http-fallback");
    expect(posts.length).toBe(1);
  });

  test("non-.class.json $src throws", () => {
    expect(
      resolvePrototype({ $prototype: "X", $src: "./thing.js" } as any, reactive({}), "v", BASE),
    ).rejects.toThrow("requires a .class.json $src");
  });
});

// ─── resolveClassJson: self-contained schema classes ─────────────────────────

describe("classFromSchema (self-contained)", () => {
  const counterDef = {
    $defs: {
      constructor: { body: "this.built = true;" },
      fields: {
        count: { default: [1, 2], identifier: "count" },
        label: { identifier: "label" },
        secret: { access: "private", identifier: "secret", initializer: 5 },
      },
      methods: {
        addTo: {
          body: "return amount + 1;",
          identifier: "addTo",
          parameters: [{ $ref: "#/params/amount" }],
        },
        getCount: { body: "return this.count.length;", identifier: "getCount" },
        makeIt: { body: "return 'static';", identifier: "makeIt", scope: "static" },
        named: { body: "return n;", identifier: "named", parameters: [{ identifier: "n" }] },
        tot: {
          getter: { body: "return this._secret;" },
          identifier: "tot",
          role: "accessor",
          setter: { body: "this._secret = v;", parameters: [{ $ref: "#/params/v" }] },
        },
      },
    },
    title: "Counter",
  };

  test("constructs instance with fields, constructor, methods, accessor", async () => {
    installFetch({ classDefs: { "counter.class.json": counterDef } });
    const doc = {
      state: {
        c: { $prototype: "Counter", $src: "./counter.class.json", label: "lbl" },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    const c = state.c as Record<string, any>;
    expect(c.built).toBe(true);
    expect(c.count).toEqual([1, 2]); // StructuredClone of default
    expect(c.label).toBe("lbl"); // From config
    expect(c._secret).toBe(5); // Private initializer
    expect(c.getCount()).toBe(2);
    expect(c.addTo(4)).toBe(5); // $ref parameter name
    expect(c.named("hi")).toBe("hi"); // Identifier parameter name
    expect(c.tot).toBe(5); // Accessor getter
    c.tot = 9; // Accessor setter
    expect(c.tot).toBe(9);
  });

  test("field without config/initializer/default is null", async () => {
    installFetch({ classDefs: { "counter2.class.json": counterDef } });
    const doc = {
      state: { c: { $prototype: "Counter", $src: "./counter2.class.json" } },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    expect((state.c as Record<string, unknown>).label).toBe(null);
  });

  test("schema-defined subscribe wires reactive updates", async () => {
    const subDef = {
      $defs: {
        fields: { tag: { identifier: "tag", initializer: "sub" } },
        methods: {
          subscribe: {
            body: "globalThis.__gapsSelfCb = cb;",
            identifier: "subscribe",
            parameters: [{ identifier: "cb" }],
          },
        },
      },
      title: "Subby",
    };
    installFetch({ classDefs: { "subby.class.json": subDef } });
    const doc = {
      state: { s: { $prototype: "Subby", $src: "./subby.class.json" } },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    expect((state.s as Record<string, unknown>).tag).toBe("sub");
    (globalThis as any).__gapsSelfCb(42);
    await wait();
    expect(state.s).toBe(42);
    delete (globalThis as any).__gapsSelfCb;
  });
});

// ─── resolveViaDevProxy ──────────────────────────────────────────────────────

describe("resolveViaDevProxy", () => {
  test("bare specifier $src posts to /__jx_resolve__ with config", async () => {
    const posts = installFetch({ proxyValue: (b) => ({ echoed: b.q }) });
    const doc = {
      state: {
        v: { $prototype: "Search", $src: "@fake/pkg/x.class.json", q: "static-q" },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    await wait(5);
    expect(state.v).toEqual({ echoed: "static-q" });
    expect(posts[0]!.body.$src).toBe("@fake/pkg/x.class.json");
    expect(posts[0]!.body.$prototype).toBe("Search");
    expect(posts[0]!.body.q).toBe("static-q");
  });

  test("template config values re-resolve reactively", async () => {
    const posts = installFetch({ proxyValue: (b) => ({ echoed: b.q }) });
    const doc = {
      state: {
        term: { default: "first" },
        v: { $prototype: "Search", $src: "@fake/pkg/y.class.json", q: "${state.term}" },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    await wait(5);
    expect(state.v).toEqual({ echoed: "first" });
    state.term = "second";
    await wait(5);
    expect(state.v).toEqual({ echoed: "second" });
    expect(posts.map((p) => p.body.q)).toEqual(["first", "second"]);
  });

  test("proxy HTTP error logs via console.error (template path)", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    installFetch({ proxyOk: false });
    const doc = {
      state: {
        term: { default: "t" },
        v: { $prototype: "Search", $src: "@fake/pkg/z.class.json", q: "${state.term}" },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    await wait(5);
    expect(state.v).toBe(null);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// ─── resolveServerFunction (timing: "server") ────────────────────────────────

describe("resolveServerFunction", () => {
  test("static args: awaits result; second entry hits module cache", async () => {
    const doc = {
      state: {
        echo: {
          $export: "echoArgs",
          $src: SERVER_SRC,
          arguments: { a: 1 },
          timing: "server",
        },
        ok: {
          $export: "failing",
          $src: SERVER_SRC,
          arguments: { boom: false },
          timing: "server",
        },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    expect(state.echo).toEqual({ got: { a: 1 } });
    expect(state.ok).toBe("ok");
  });

  test("reactive $ref args re-invoke on change", async () => {
    const doc = {
      state: {
        n: { default: 2 },
        result: {
          $export: "double",
          $src: SERVER_SRC,
          arguments: { n: { $ref: "#/state/n" } },
          timing: "server",
        },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    await wait(5);
    expect(state.result).toBe(4);
    state.n = 5;
    await wait(5);
    expect(state.result).toBe(10);
  });

  test("reactive args swallow rejections, recover when args change", async () => {
    const doc = {
      state: {
        boom: { default: true },
        result: {
          $export: "failing",
          $src: SERVER_SRC,
          arguments: { boom: { $ref: "#/state/boom" } },
          timing: "server",
        },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, BASE);
    await wait(5);
    expect(state.result).toBe(null);
    state.boom = false;
    await wait(5);
    expect(state.result).toBe("ok");
  });

  test("missing export throws", () => {
    const doc = {
      state: {
        r: { $export: "ghost", $src: SERVER_SRC, timing: "server" },
      },
    };
    expect(buildScope(doc as unknown as JxDocument, {}, BASE)).rejects.toThrow(
      'export "ghost" not found',
    );
  });

  test("non-function export throws", () => {
    const doc = {
      state: {
        r: { $export: "notFn", $src: SERVER_SRC, timing: "server" },
      },
    };
    expect(buildScope(doc as unknown as JxDocument, {}, BASE)).rejects.toThrow("is not a function");
  });

  test("unimportable module with base falls back to /__jx_server__ proxy", async () => {
    const posts = installFetch({
      proxyValue: (b) => ({ r: (b.arguments as Record<string, unknown>).a }),
    });
    const doc = {
      state: {
        remote: {
          $export: "anyFn",
          $src: "./__gaps_missing_server__.js",
          arguments: { a: "x" },
          timing: "server",
        },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, "file:///nonexistent/dir/");
    await wait(5);
    expect(state.remote).toEqual({ r: "x" });
    expect(posts[0]!.url).toBe("/__jx_server__");
    expect(posts[0]!.body.$export).toBe("anyFn");
  });

  test("unimportable module without base falls back to proxy", async () => {
    const posts = installFetch({ proxyValue: () => "no-base-proxied" });
    const doc = {
      state: {
        remote: {
          $export: "fn2",
          $src: "./__gaps_missing_server_2__.js",
          timing: "server",
        },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, "");
    await wait(5);
    expect(state.remote).toBe("no-base-proxied");
    expect(posts.length).toBe(1);
  });

  test("proxy with reactive $ref args re-posts on change", async () => {
    const posts = installFetch({
      proxyValue: (b) => ({ n: (b.arguments as Record<string, unknown>).n }),
    });
    const doc = {
      state: {
        n: { default: 1 },
        remote: {
          $export: "fn3",
          $src: "./__gaps_missing_server_3__.js",
          arguments: { n: { $ref: "#/state/n" } },
          timing: "server",
        },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, "file:///nonexistent/d2/");
    await wait(5);
    expect(state.remote).toEqual({ n: 1 });
    state.n = 7;
    await wait(5);
    expect(state.remote).toEqual({ n: 7 });
    expect(posts.map((p) => (p.body.arguments as Record<string, unknown>).n)).toEqual([1, 7]);
  });

  test("proxy HTTP error logs via console.error (static and reactive paths)", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    installFetch({ proxyOk: false });
    const doc = {
      state: {
        n: { default: 1 },
        remoteReactive: {
          $export: "fn5",
          $src: "./__gaps_missing_server_5__.js",
          arguments: { n: { $ref: "#/state/n" } },
          timing: "server",
        },
        remoteStatic: {
          $export: "fn4",
          $src: "./__gaps_missing_server_4__.js",
          timing: "server",
        },
      },
    };
    const state = await buildScope(doc as unknown as JxDocument, {}, "file:///nonexistent/d3/");
    await wait(5);
    expect(state.remoteStatic).toBe(null);
    expect(state.remoteReactive).toBe(null);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// ─── setResolveToken / resolveProxyPath (dev-proxy auth token) ────────────────
//
// `_resolveToken` is MODULE-GLOBAL state. The afterEach below resets it after
// Every test, so a leaked token cannot bleed into the bare-path suites above.

describe("setResolveToken / resolveProxyPath", () => {
  afterEach(() => {
    setResolveToken(null);
  });

  /** A bare-specifier $src that always falls through to resolveViaDevProxy. */
  function bareSpecifierDoc(key: string) {
    return {
      state: { v: { $prototype: "Search", $src: `@fake/pkg/${key}.class.json`, q: "x" } },
    } as unknown as JxDocument;
  }

  test("calling the setter directly returns undefined (covers the exported setter)", () => {
    expect(setResolveToken("anything")).toBeUndefined();
    expect(setResolveToken(null)).toBeUndefined();
    expect(setResolveToken("")).toBeUndefined();
  });

  test("default (no token): dev-proxy resolve posts to the BARE /__jx_resolve__", async () => {
    const posts = installFetch({ proxyValue: () => "ok" });
    const state = await buildScope(bareSpecifierDoc("default"), {}, BASE);
    await wait(5);
    expect(state.v).toBe("ok");
    expect(posts.length).toBe(1);
    // No token configured → no "?token=" query appended.
    expect(posts[0]!.url).toBe("/__jx_resolve__");
    expect(posts[0]!.url).not.toContain("?token=");
  });

  test('setResolveToken("abc123"): dev-proxy resolve posts to /__jx_resolve__?token=abc123', async () => {
    setResolveToken("abc123");
    const posts = installFetch({ proxyValue: () => "ok" });
    const state = await buildScope(bareSpecifierDoc("tokened"), {}, BASE);
    await wait(5);
    expect(state.v).toBe("ok");
    expect(posts[0]!.url).toBe("/__jx_resolve__?token=abc123");
  });

  test("token value is encodeURIComponent-escaped in the query", async () => {
    // Characters that MUST be percent-encoded: space, &, =, /, +, #.
    setResolveToken("a b&c=d/e+f#g");
    const posts = installFetch({ proxyValue: () => "ok" });
    await buildScope(bareSpecifierDoc("encoded"), {}, BASE);
    await wait(5);
    expect(posts[0]!.url).toBe(`/__jx_resolve__?token=${encodeURIComponent("a b&c=d/e+f#g")}`);
    // Sanity: the raw, un-escaped token must NOT appear verbatim.
    expect(posts[0]!.url).not.toContain("a b&c=d/e+f#g");
  });

  test("server-function proxy (/__jx_server__) is token-gated too", async () => {
    setResolveToken("srv-tok");
    const posts = installFetch({ proxyValue: () => "served" });
    const doc = {
      state: {
        remote: {
          $export: "anyFn",
          $src: "./__gaps_token_missing_server__.js",
          arguments: { a: "x" },
          timing: "server",
        },
      },
    } as unknown as JxDocument;
    const state = await buildScope(doc, {}, "file:///nonexistent/tok/");
    await wait(5);
    expect(state.remote).toBe("served");
    expect(posts[0]!.url).toBe("/__jx_server__?token=srv-tok");
  });

  test("is idempotent/resettable: setting back to null restores the bare path", async () => {
    setResolveToken("temp");
    const first = installFetch({ proxyValue: () => "with-token" });
    await buildScope(bareSpecifierDoc("reset-a"), {}, BASE);
    await wait(5);
    expect(first[0]!.url).toBe("/__jx_resolve__?token=temp");

    // Reset to null mid-test → next resolve must drop the query entirely.
    setResolveToken(null);
    const second = installFetch({ proxyValue: () => "no-token" });
    await buildScope(bareSpecifierDoc("reset-b"), {}, BASE);
    await wait(5);
    expect(second[0]!.url).toBe("/__jx_resolve__");
    expect(second[0]!.url).not.toContain("?token=");
  });

  test('empty-string token is treated as unset (setResolveToken("") → bare path)', async () => {
    // The setter normalizes falsy input to null (`token || null`).
    setResolveToken("");
    const posts = installFetch({ proxyValue: () => "ok" });
    await buildScope(bareSpecifierDoc("empty"), {}, BASE);
    await wait(5);
    expect(posts[0]!.url).toBe("/__jx_resolve__");
  });
});

// ─── observeScope (same-instance reactive observer) ───────────────────────────

describe("observeScope", () => {
  test("runs immediately, re-runs when a tracked runtime ref/reactive changes, and the disposer stops it", async () => {
    const { observeScope } = await import("../src/runtime");
    const state = reactive({ items: null as unknown }) as Record<string, unknown>;
    const seen: unknown[] = [];
    const stop = observeScope(() => {
      seen.push(state.items);
    });
    // First run is synchronous.
    expect(seen).toEqual([null]);

    // A change to the tracked reactive re-runs the observer (same reactivity instance).
    state.items = [1, 2];
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([1, 2]);

    // After the disposer, further changes no longer re-run it.
    stop();
    state.items = "later";
    expect(seen).toHaveLength(2);
  });
});
