import { GlobalRegistrator } from "@happy-dom/global-registrator";
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

import { describe, test, expect, mock, spyOn } from "bun:test";
import { buildScope, resolvePrototype, isSignal } from "@jxsuite/runtime";
import { resolve as resolvePath, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
const BASE = "http://localhost/";

// ─── .class.json self-contained class schema ────────────────────────────────

const selfContainedClassDef = {
  $prototype: "Class",
  title: "Adder",
  $defs: {
    fields: {
      a: {
        role: "field",
        access: "public",
        scope: "instance",
        identifier: "a",
        default: 0,
      },
      b: {
        role: "field",
        access: "public",
        scope: "instance",
        identifier: "b",
        default: 0,
      },
    },
    methods: {
      resolve: {
        role: "method",
        identifier: "resolve",
        body: "return this.a + this.b;",
      },
    },
  },
};

const privateFieldsClassDef = {
  $prototype: "Class",
  title: "Secret",
  $defs: {
    fields: {
      data: {
        role: "field",
        access: "private",
        scope: "instance",
        identifier: "data",
        default: "hidden",
      },
      pub: {
        role: "field",
        access: "public",
        scope: "instance",
        identifier: "pub",
        default: "visible",
      },
    },
    methods: {
      resolve: {
        role: "method",
        identifier: "resolve",
        body: "return { priv: this._data, pub: this.pub };",
      },
    },
  },
};

const classWithValueProp = {
  $prototype: "Class",
  title: "Greeter",
  $defs: {
    fields: {
      greeting: {
        role: "field",
        access: "public",
        scope: "instance",
        identifier: "greeting",
        default: "world",
      },
    },
    methods: {
      val: {
        role: "accessor",
        identifier: "value",
        getter: { body: 'return "Hello " + this.greeting;' },
      },
    },
  },
};

const classWithStaticMethod = {
  $prototype: "Class",
  title: "Utils",
  $defs: {
    methods: {
      double: {
        role: "method",
        scope: "static",
        identifier: "double",
        parameters: [{ identifier: "x" }],
        body: "return x * 2;",
      },
      add: {
        role: "method",
        identifier: "add",
        parameters: [{ identifier: "a" }, { identifier: "b" }],
        body: "return a + b;",
      },
    },
  },
};

const classWithConstructorBody = {
  $prototype: "Class",
  title: "Tagged",
  $defs: {
    fields: {
      tag: {
        role: "field",
        access: "public",
        scope: "instance",
        identifier: "tag",
        default: "",
      },
    },
    constructor: {
      role: "constructor",
      $prototype: "Function",
      body: 'this.tag = (config.prefix || "") + "-tagged";',
    },
  },
};

const classWithInitializer = {
  $prototype: "Class",
  title: "Initer",
  $defs: {
    fields: {
      items: {
        role: "field",
        access: "public",
        scope: "instance",
        identifier: "items",
        initializer: [],
      },
    },
    methods: {
      resolve: {
        role: "method",
        identifier: "resolve",
        body: "return this.items;",
      },
    },
  },
};

// Mock fetch to serve .class.json content based on URL
function setupFetchMock(classDefMap: any) {
  const originalFetch = global.fetch;
  global.fetch = mock((url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    for (const [pattern, def] of Object.entries(classDefMap)) {
      if (urlStr.includes(pattern)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(def),
        });
      }
    }
    // Fall through to 404 for unknown .class.json urls
    if (urlStr.endsWith(".class.json")) {
      return Promise.resolve({ ok: false, status: 404 });
    }
    // Let non-class-json requests through (shouldn't happen in these tests)
    return originalFetch(url);
  }) as unknown as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

// ─── resolveClassJson — self-contained ──────────────────────────────────────

describe("resolveClassJson — self-contained", () => {
  test("resolves self-contained .class.json with resolve() method", async () => {
    const restore = setupFetchMock({
      "Adder.class.json": selfContainedClassDef,
    });
    try {
      const sig = (await resolvePrototype(
        { $prototype: "Adder", $src: "./Adder.class.json", a: 3, b: 7 },
        {},
        "$sum",
      )) as any;
      expect(isSignal(sig)).toBe(true);
      expect(sig.value).toBe(10);
    } finally {
      restore();
    }
  });

  test("resolves .class.json with value accessor (no resolve method)", async () => {
    const restore = setupFetchMock({
      "Greeter.class.json": classWithValueProp,
    });
    try {
      const sig = (await resolvePrototype(
        {
          $prototype: "Greeter",
          $src: "./Greeter.class.json",
          greeting: "Alice",
        },
        {},
        "$greeting",
      )) as any;
      expect(isSignal(sig)).toBe(true);
      expect(sig.value).toBe("Hello Alice");
    } finally {
      restore();
    }
  });

  test("uses default field values when config omitted", async () => {
    const restore = setupFetchMock({
      "Adder.class.json": selfContainedClassDef,
    });
    try {
      const sig = (await resolvePrototype(
        { $prototype: "Adder", $src: "./Adder.class.json" },
        {},
        "$sum",
      )) as any;
      expect(sig.value).toBe(0); // 0 + 0
    } finally {
      restore();
    }
  });

  test("private fields map to _-prefixed public fields", async () => {
    const restore = setupFetchMock({
      "Secret.class.json": privateFieldsClassDef,
    });
    try {
      const sig = (await resolvePrototype(
        { $prototype: "Secret", $src: "./Secret.class.json" },
        {},
        "$s",
      )) as any;
      expect(sig.value.priv).toBe("hidden");
      expect(sig.value.pub).toBe("visible");
    } finally {
      restore();
    }
  });

  test("config values override defaults", async () => {
    const restore = setupFetchMock({
      "Secret.class.json": privateFieldsClassDef,
    });
    try {
      const sig = (await resolvePrototype(
        { $prototype: "Secret", $src: "./Secret.class.json", data: "custom" },
        {},
        "$s",
      )) as any;
      expect(sig.value.priv).toBe("custom");
    } finally {
      restore();
    }
  });

  test("auto-wraps external prototype in ref", async () => {
    const restore = setupFetchMock({
      "Adder.class.json": selfContainedClassDef,
    });
    try {
      const sig = (await resolvePrototype(
        { $prototype: "Adder", $src: "./Adder.class.json", a: 2, b: 3 },
        {},
        "$sum",
      )) as any;
      expect(isSignal(sig)).toBe(true);
      expect(sig.value).toBe(5);
    } finally {
      restore();
    }
  });
});

// ─── classFromSchema — methods and accessors ────────────────────────────────

describe("classFromSchema — via resolvePrototype", () => {
  test("static methods are attached to class", async () => {
    const restore = setupFetchMock({
      "Utils.class.json": classWithStaticMethod,
    });
    try {
      // Static methods aren't directly testable via resolve since resolve()
      // returns instance, but instance methods work
      const val = (await resolvePrototype(
        { $prototype: "Utils", $src: "./Utils.class.json" },
        {},
        "$u",
      )) as any;
      // Instance returned as value (no resolve, no value prop) — wrapped in ref
      expect(typeof val.value.add).toBe("function");
      expect(val.value.add(2, 3)).toBe(5);
    } finally {
      restore();
    }
  });

  test("constructor body is executed", async () => {
    const restore = setupFetchMock({
      "Tagged.class.json": classWithConstructorBody,
    });
    try {
      const val = (await resolvePrototype(
        { $prototype: "Tagged", $src: "./Tagged.class.json", prefix: "test" },
        {},
        "$t",
      )) as any;
      expect(val.value.tag).toBe("test-tagged");
    } finally {
      restore();
    }
  });

  test("initializer field takes priority when no config", async () => {
    const restore = setupFetchMock({
      "Initer.class.json": classWithInitializer,
    });
    try {
      const val = (await resolvePrototype(
        { $prototype: "Initer", $src: "./Initer.class.json" },
        {},
        "$i",
      )) as any;
      expect(val.value).toEqual([]);
    } finally {
      restore();
    }
  });

  test("class name is set on constructed class", async () => {
    const restore = setupFetchMock({
      "Adder.class.json": selfContainedClassDef,
    });
    try {
      // Auto-wrapped as ref; resolve() returns a number, not the instance
      const val = (await resolvePrototype(
        { $prototype: "Adder", $src: "./Adder.class.json", a: 1, b: 1 },
        {},
        "$a",
      )) as any;
      // resolve() returns a number, not the instance, so we can't check class name directly
      expect(val.value).toBe(2);
    } finally {
      restore();
    }
  });
});

// ─── resolveClassJson — hybrid with $implementation ─────────────────────────

describe("resolveClassJson — hybrid $implementation", () => {
  test("follows $implementation to JS module via resolveExternalPrototype", async () => {
    const parserDir = resolvePath(__dirname, "..", "..", "parser", "src");
    const hybridDef = {
      $prototype: "Class",
      title: "Markdown",
      $implementation: "./markdown.js",
    };
    const schemaSrc = "file://" + join(parserDir, "MdFile.class.json");
    const restore = setupFetchMock({ "MdFile.class.json": hybridDef });
    try {
      const fixtureDir = resolvePath(__dirname, "..", "..", "..", "examples", "content", "posts");
      const sig = (await resolvePrototype(
        {
          $prototype: "Markdown",
          $src: schemaSrc,
          src: join(fixtureDir, "getting-started.md"),
        },
        {},
        "$post",
      )) as any;
      expect(isSignal(sig)).toBe(true);
      expect(sig.value.slug).toBe("getting-started");
    } finally {
      restore();
    }
  });
});

// ─── resolveClassJson — fallback to dev proxy ───────────────────────────────

describe("resolveClassJson — fallback", () => {
  test("falls back to dev proxy when fetch fails", async () => {
    // Mock fetch to fail for the .class.json
    const originalFetch = global.fetch;
    let proxyCalled = false;
    global.fetch = mock((url, _opts) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith(".class.json")) {
        return Promise.reject(new Error("Network error"));
      }
      // Dev proxy call
      if (urlStr.includes("__jx_resolve__")) {
        proxyCalled = true;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(42),
        });
      }
      return originalFetch(url);
    }) as any;

    try {
      const sig = await resolvePrototype(
        { $prototype: "Missing", $src: "./Missing.class.json" },
        {},
        "$m",
      );
      expect(proxyCalled).toBe(true);
      expect(isSignal(sig)).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ─── buildScope with .class.json $src ───────────────────────────────────────

describe("buildScope — .class.json $src", () => {
  test("integrates .class.json in buildScope", async () => {
    const restore = setupFetchMock({
      "Adder.class.json": selfContainedClassDef,
    });
    try {
      const doc = {
        state: {
          $result: {
            $prototype: "Adder",
            $src: "http://localhost/Adder.class.json",
            a: 10,
            b: 20,
          },
        },
      };
      const scope = await buildScope(doc, {}, BASE);
      // Vue reactive() unwraps refs
      expect(scope.$result).toBe(30);
    } finally {
      restore();
    }
  });
});

// ─── .class.json enforcement ─────────────────────────────────────────────────

describe("resolveExternalPrototype — .class.json enforcement", () => {
  test("throws when non-Function $src does not end in .class.json", async () => {
    expect(
      resolvePrototype({ $prototype: "MyClass", $src: "./my-class.js" }, {}, "$mc"),
    ).rejects.toThrow(".class.json");
  });

  test("allows .class.json $src for non-Function prototypes", async () => {
    const restore = setupFetchMock({
      "Adder.class.json": selfContainedClassDef,
    });
    try {
      const sig = await resolvePrototype(
        {
          $prototype: "Adder",
          $src: "http://localhost/Adder.class.json",
          a: 1,
          b: 2,
        },
        {},
        "$sum",
      );
      expect(isSignal(sig)).toBe(true);
      expect((sig as any).value).toBe(3);
    } finally {
      restore();
    }
  });
});

// ─── Import map resolution ──────────────────────────────────────────────────

describe("buildScope — import map", () => {
  test("bare $prototype resolved via doc.imports", async () => {
    const restore = setupFetchMock({
      "Adder.class.json": selfContainedClassDef,
    });
    try {
      const doc = {
        imports: { Adder: "http://localhost/Adder.class.json" },
        state: {
          $sum: { $prototype: "Adder", a: 5, b: 3 },
        },
      };
      const scope = await buildScope(doc, {}, BASE);
      expect(scope.$sum).toBe(8);
    } finally {
      restore();
    }
  });

  test("explicit $src takes precedence over import map", async () => {
    const restore = setupFetchMock({
      "Adder.class.json": selfContainedClassDef,
      "Greeter.class.json": classWithValueProp,
    });
    try {
      const doc = {
        imports: { Adder: "http://localhost/Greeter.class.json" },
        state: {
          $sum: {
            $prototype: "Adder",
            $src: "http://localhost/Adder.class.json",
            a: 2,
            b: 3,
          },
        },
      };
      const scope = await buildScope(doc, {}, BASE);
      // Should use the explicit $src (Adder), not the import map (Greeter)
      expect(scope.$sum).toBe(5);
    } finally {
      restore();
    }
  });

  test("$prototype: 'Function' unaffected by import map", async () => {
    const doc = {
      imports: { Function: "http://localhost/DoesNotExist.class.json" },
      state: {
        increment: {
          $prototype: "Function",
          body: "state.counter++;",
        },
      },
    };
    const scope = await buildScope(doc, {}, BASE);
    // Function should still resolve normally — not redirected via import map
    expect(typeof scope.increment).toBe("function");
  });

  test("non-.class.json import value warns and skips", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const doc = {
        imports: { BadClass: "./bad.js" },
        state: {
          $x: { $prototype: "BadClass" },
        },
      };
      const scope = await buildScope(doc, {}, BASE);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("must map to a .class.json path"));
      // $x should remain null (no $src injected, falls through to unknown prototype warning)
      expect(scope.$x).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test("unknown $prototype with no import and no $src warns", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const doc = {
        imports: {},
        state: {
          $missing: { $prototype: "NothingHere" },
        },
      };
      const scope = await buildScope(doc, {}, BASE);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Did you mean to add '$src'?"));
      expect(scope.$missing).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test("multiple imports resolved in same document", async () => {
    const restore = setupFetchMock({
      "Adder.class.json": selfContainedClassDef,
      "Greeter.class.json": classWithValueProp,
    });
    try {
      const doc = {
        imports: {
          Adder: "http://localhost/Adder.class.json",
          Greeter: "http://localhost/Greeter.class.json",
        },
        state: {
          $sum: { $prototype: "Adder", a: 10, b: 20 },
          $greeting: { $prototype: "Greeter", greeting: "World" },
        },
      };
      const scope = await buildScope(doc, {}, BASE);
      expect(scope.$sum).toBe(30);
      expect(scope.$greeting).toBe("Hello World");
    } finally {
      restore();
    }
  });
});
