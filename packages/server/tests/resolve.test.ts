import { describe, expect, test } from "bun:test";
import { handleResolve, handleServerFunction } from "../src/resolve";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const FIXTURES = resolve(import.meta.dir, "_fixtures");

// Create fixtures before tests
mkdirSync(FIXTURES, { recursive: true });

// Self-contained .class.json with resolve() method
const selfContainedClass = {
  $defs: {
    constructor: {
      $prototype: "Function",
      role: "constructor",
    },
    fields: {
      a: {
        access: "public",
        default: 0,
        identifier: "a",
        role: "field",
        scope: "instance",
      },
      b: {
        access: "public",
        default: 0,
        identifier: "b",
        role: "field",
        scope: "instance",
      },
    },
    methods: {
      resolve: {
        body: "return this.a + this.b;",
        identifier: "resolve",
        role: "method",
      },
    },
  },
  $prototype: "Class",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Adder",
};
writeFileSync(join(FIXTURES, "Adder.class.json"), JSON.stringify(selfContainedClass), "utf8");

// Self-contained .class.json with value property (no resolve)
const valueClass = {
  $defs: {
    fields: {
      name: {
        access: "public",
        default: "world",
        identifier: "name",
        role: "field",
        scope: "instance",
      },
    },
    methods: {
      greeting: {
        getter: { body: 'return "Hello " + this.name;' },
        identifier: "value",
        role: "accessor",
      },
    },
  },
  $prototype: "Class",
  title: "Greeter",
};
writeFileSync(join(FIXTURES, "Greeter.class.json"), JSON.stringify(valueClass), "utf8");

// Self-contained .class.json with neither resolve nor value
const plainClass = {
  $defs: {
    fields: {
      x: {
        access: "public",
        default: 0,
        identifier: "x",
        role: "field",
        scope: "instance",
      },
      y: {
        access: "public",
        default: 0,
        identifier: "y",
        role: "field",
        scope: "instance",
      },
    },
  },
  $prototype: "Class",
  title: "Point",
};
writeFileSync(join(FIXTURES, "Point.class.json"), JSON.stringify(plainClass), "utf8");

// Hybrid .class.json with $implementation
const hybridImpl = `
export class Calculator {
  constructor(/** @type {{ a?: number; b?: number }} */ config) { this.a = config.a ?? 0; this.b = config.b ?? 0; }
  async resolve() { return this.a * this.b; }
}
`;
writeFileSync(join(FIXTURES, "calc.js"), hybridImpl, "utf8");

const hybridClass = {
  $defs: {
    parameters: {
      a: { identifier: "a", type: { type: "number" } },
      b: { identifier: "b", type: { type: "number" } },
    },
  },
  $implementation: "./calc.js",
  $prototype: "Class",
  title: "Calculator",
};
writeFileSync(join(FIXTURES, "Calculator.class.json"), JSON.stringify(hybridClass), "utf8");

// Hybrid with missing export
const badHybridClass = {
  $implementation: "./calc.js",
  $prototype: "Class",
  title: "Missing",
};
writeFileSync(join(FIXTURES, "Missing.class.json"), JSON.stringify(badHybridClass), "utf8");

// Private fields .class.json
const privateFieldsClass = {
  $defs: {
    fields: {
      data: {
        access: "private",
        default: "hidden",
        identifier: "data",
        role: "field",
        scope: "instance",
      },
    },
    methods: {
      resolve: {
        body: "return this.data;",
        identifier: "resolve",
        role: "method",
      },
    },
  },
  $prototype: "Class",
  title: "Secret",
};
writeFileSync(join(FIXTURES, "Secret.class.json"), JSON.stringify(privateFieldsClass), "utf8");

// Helper: create a mock Request
function mockRequest(body: unknown) {
  return new Request("http://localhost/__jx_resolve__", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

// ─── handleResolve — self-contained .class.json ─────────────────────────────

describe("handleResolve — self-contained .class.json", () => {
  test("resolves class with resolve() method", async () => {
    const req = mockRequest({
      $prototype: "Adder",
      $src: "./_fixtures/Adder.class.json",
      a: 3,
      b: 7,
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBe(10);
  });

  test("resolves class with value property", async () => {
    const req = mockRequest({
      $prototype: "Greeter",
      $src: "./_fixtures/Greeter.class.json",
      name: "Alice",
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBe("Hello Alice");
  });

  test("resolves class with neither resolve nor value (returns instance)", async () => {
    const req = mockRequest({
      $prototype: "Point",
      $src: "./_fixtures/Point.class.json",
      x: 5,
      y: 10,
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.x).toBe(5);
    expect(data.y).toBe(10);
  });

  test("private fields map to _-prefixed public properties", async () => {
    const req = mockRequest({
      $prototype: "Secret",
      $src: "./_fixtures/Secret.class.json",
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBe("hidden");
  });

  test("uses default values when config omitted", async () => {
    const req = mockRequest({
      $prototype: "Adder",
      $src: "./_fixtures/Adder.class.json",
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBe(0);
  });
});

// ─── handleResolve — hybrid .class.json with $implementation ────────────────

describe("handleResolve — hybrid .class.json", () => {
  test("follows $implementation to JS module", async () => {
    const req = mockRequest({
      $prototype: "Calculator",
      $src: "./_fixtures/Calculator.class.json",
      a: 6,
      b: 7,
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBe(42);
  });

  test("returns 500 when export not found in $implementation", async () => {
    const req = mockRequest({
      $prototype: "Missing",
      $src: "./_fixtures/Missing.class.json",
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(500);
  });
});

// ─── handleResolve — error handling ─────────────────────────────────────────

describe("handleResolve — errors", () => {
  test("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/__jx_resolve__", {
      body: "not json",
      method: "POST",
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(400);
  });

  test("returns 400 when $src is missing", async () => {
    const req = mockRequest({ $prototype: "Foo" });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(400);
  });

  test("returns 400 when non-Function $src points to .js", async () => {
    const req = mockRequest({
      $prototype: "Calculator",
      $src: "./_fixtures/calc.js",
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain(".class.json");
  });
});

// ─── handleResolve — $base URL resolution ───────────────────────────────────

describe("handleResolve — $base URL resolution", () => {
  test("resolves $src relative to document directory when $base is provided", async () => {
    const subDir = join(FIXTURES, "sub");
    mkdirSync(subDir, { recursive: true });
    const subClass = {
      $defs: {
        fields: {
          x: {
            access: "public",
            default: 1,
            identifier: "x",
            role: "field",
            scope: "instance",
          },
        },
        methods: {
          resolve: {
            body: "return this.x * 2;",
            identifier: "resolve",
            role: "method",
          },
        },
      },
      $prototype: "Class",
      title: "SubAdder",
    };
    writeFileSync(join(subDir, "SubAdder.class.json"), JSON.stringify(subClass), "utf8");
    try {
      const req = mockRequest({
        $base: "http://localhost/_fixtures/sub/page.json",
        $prototype: "SubAdder",
        $src: "./SubAdder.class.json",
        x: 7,
      });
      const res = await handleResolve(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toBe(14);
    } finally {
      rmSync(subDir, { force: true, recursive: true });
    }
  });

  test("returns 400 when $base is a malformed URL", async () => {
    const req = mockRequest({
      $base: "not-a-url",
      $prototype: "Foo",
      $src: "./anything.class.json",
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Cannot resolve $src");
  });

  test("rebases relative config paths to CWD-relative when $base is provided", async () => {
    const subDir = join(FIXTURES, "sub");
    mkdirSync(subDir, { recursive: true });
    const rebaserClass = {
      $defs: {
        fields: {
          src: {
            access: "public",
            default: "",
            identifier: "src",
            role: "field",
            scope: "instance",
          },
        },
        methods: {
          resolve: {
            body: "return this.src;",
            identifier: "resolve",
            role: "method",
          },
        },
      },
      $prototype: "Class",
      title: "Rebaser",
    };
    writeFileSync(join(subDir, "Rebaser.class.json"), JSON.stringify(rebaserClass), "utf8");
    try {
      const req = mockRequest({
        $base: "http://localhost/_fixtures/sub/page.json",
        $prototype: "Rebaser",
        $src: "./Rebaser.class.json",
        src: "./data.json",
      });
      const res = await handleResolve(req, import.meta.dir);
      expect(res.status).toBe(200);
      const value = await res.json();
      // The path should be rebased to CWD-relative (starts with ./) and include the sub dir
      expect(typeof value).toBe("string");
      expect(value.startsWith("./")).toBe(true);
      expect(value).toContain("_fixtures/sub/data.json");
    } finally {
      rmSync(subDir, { force: true, recursive: true });
    }
  });
});

// ─── handleResolve — malformed .class.json ──────────────────────────────────

describe("handleResolve — malformed .class.json", () => {
  test("returns 500 with error object when .class.json contains invalid JSON", async () => {
    const badFile = join(FIXTURES, "BadJson.class.json");
    writeFileSync(badFile, "{ this is not valid json }", "utf8");
    try {
      const req = mockRequest({
        $prototype: "BadJson",
        $src: "./_fixtures/BadJson.class.json",
      });
      const res = await handleResolve(req, import.meta.dir);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    } finally {
      rmSync(badFile, { force: true });
    }
  });
});

// ─── handleResolve — accessor with getter and setter ────────────────────────

describe("handleResolve — accessor with getter and setter", () => {
  test("accessor role generates get/set descriptor on prototype", async () => {
    const counterClass = {
      $defs: {
        fields: {
          _count: {
            access: "public",
            default: 0,
            identifier: "_count",
            role: "field",
            scope: "instance",
          },
        },
        methods: {
          count: {
            getter: { body: "return this._count;" },
            identifier: "count",
            role: "accessor",
            setter: {
              body: "this._count = val;",
              parameters: [{ $ref: "#/$defs/parameters/val" }],
            },
          },
          resolve: {
            body: "this.count = 5; return this.count;",
            identifier: "resolve",
            role: "method",
          },
        },
      },
      $prototype: "Class",
      title: "Counter",
    };
    const counterFile = join(FIXTURES, "Counter.class.json");
    writeFileSync(counterFile, JSON.stringify(counterClass), "utf8");
    try {
      const req = mockRequest({
        $prototype: "Counter",
        $src: "./_fixtures/Counter.class.json",
      });
      const res = await handleResolve(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toBe(5);
    } finally {
      rmSync(counterFile, { force: true });
    }
  });
});

// ─── handleResolve — static method ──────────────────────────────────────────

describe("handleResolve — static method", () => {
  test("static scope attaches method to class constructor", async () => {
    const factoryClass = {
      $defs: {
        methods: {
          create: {
            body: "return 42;",
            identifier: "create",
            role: "method",
            scope: "static",
          },
          resolve: {
            body: "return this.constructor.create();",
            identifier: "resolve",
            role: "method",
          },
        },
      },
      $prototype: "Class",
      title: "Factory",
    };
    const factoryFile = join(FIXTURES, "Factory.class.json");
    writeFileSync(factoryFile, JSON.stringify(factoryClass), "utf8");
    try {
      const req = mockRequest({
        $prototype: "Factory",
        $src: "./_fixtures/Factory.class.json",
      });
      const res = await handleResolve(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toBe(42);
    } finally {
      rmSync(factoryFile, { force: true });
    }
  });
});

// ─── handleResolve — hybrid .value instance (no resolve) ────────────────────

describe("handleResolve — hybrid .value instance", () => {
  test("returns value getter from $implementation when no resolve() method exists", async () => {
    const implFile = join(FIXTURES, "value-holder.js");
    const classFile = join(FIXTURES, "HybridValue.class.json");
    writeFileSync(
      implFile,
      `export class HybridValue {
  constructor(config) { this.data = config.data ?? "default"; }
  get value() { return "got:" + this.data; }
}`,
      "utf8",
    );
    const hybridValueClass = {
      $implementation: "./value-holder.js",
      $prototype: "Class",
      title: "HybridValue",
    };
    writeFileSync(classFile, JSON.stringify(hybridValueClass), "utf8");
    try {
      const req = mockRequest({
        $prototype: "HybridValue",
        $src: "./_fixtures/HybridValue.class.json",
        data: "test",
      });
      const res = await handleResolve(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toBe("got:test");
    } finally {
      rmSync(implFile, { force: true });
      rmSync(classFile, { force: true });
    }
  });
});

// ─── handleServerFunction — malformed $base ─────────────────────────────────

describe("handleServerFunction — malformed $base", () => {
  test("returns 400 when $base is not a valid URL", async () => {
    const req = mockRequest({
      $base: "not-a-url",
      $export: "fn",
      $src: "./foo.js",
    });
    const res = await handleServerFunction(req, import.meta.dir);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Cannot resolve $src");
  });
});

// Cleanup
process.on("exit", () => {
  try {
    rmSync(FIXTURES, { recursive: true });
  } catch {}
});

// ─── handleServerFunction ──────────────────────────────────────────────────

describe("handleServerFunction", () => {
  test("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/__jx_server", {
      body: "bad",
      method: "POST",
    });
    const res = await handleServerFunction(req, import.meta.dir);
    expect(res.status).toBe(400);
  });

  test("returns 400 when $src is missing", async () => {
    const req = mockRequest({ $export: "fn" });
    const res = await handleServerFunction(req, import.meta.dir);
    expect(res.status).toBe(400);
  });

  test("returns 400 when $export is missing", async () => {
    const req = mockRequest({ $src: "./calc.js" });
    const res = await handleServerFunction(req, import.meta.dir);
    expect(res.status).toBe(400);
  });

  test("calls exported function and returns result", async () => {
    writeFileSync(
      join(FIXTURES, "server-fn.js"),
      "export function add(args) { return args.a + args.b; }",
    );
    try {
      const req = mockRequest({
        $export: "add",
        $src: "./_fixtures/server-fn.js",
        arguments: { a: 10, b: 20 },
      });
      const res = await handleServerFunction(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toBe(30);
    } finally {
      rmSync(join(FIXTURES, "server-fn.js"), { force: true });
    }
  });

  test("returns null for void function", async () => {
    writeFileSync(join(FIXTURES, "noop.js"), "export function noop() {}");
    try {
      const req = mockRequest({ $export: "noop", $src: "./_fixtures/noop.js" });
      const res = await handleServerFunction(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    } finally {
      rmSync(join(FIXTURES, "noop.js"), { force: true });
    }
  });

  test("returns 500 when module not found", async () => {
    const req = mockRequest({
      $export: "fn",
      $src: "./_fixtures/nonexistent.js",
    });
    const res = await handleServerFunction(req, import.meta.dir);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Failed to import");
  });

  test("returns 500 when export not found in module", async () => {
    const req = mockRequest({
      $export: "nonExistent",
      $src: "./_fixtures/calc.js",
    });
    const res = await handleServerFunction(req, import.meta.dir);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("not found");
  });

  test("returns error JSON when function throws", async () => {
    writeFileSync(
      join(FIXTURES, "throws.js"),
      'export function boom() { throw new Error("kaboom"); }',
    );
    try {
      const req = mockRequest({
        $export: "boom",
        $src: "./_fixtures/throws.js",
      });
      const res = await handleServerFunction(req, import.meta.dir);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("kaboom");
    } finally {
      rmSync(join(FIXTURES, "throws.js"), { force: true });
    }
  });

  test("resolves with $base for path resolution", async () => {
    mkdirSync(join(FIXTURES, "api"), { recursive: true });
    writeFileSync(
      join(FIXTURES, "api", "greet.js"),
      "export function greet(args) { return `hello ${args.name}`; }",
    );
    try {
      const req = mockRequest({
        $base: `http://localhost/_fixtures/api/page.json`,
        $export: "greet",
        $src: "./greet.js",
        arguments: { name: "world" },
      });
      const res = await handleServerFunction(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toBe("hello world");
    } finally {
      rmSync(join(FIXTURES, "api"), { force: true, recursive: true });
    }
  });

  test("defaults arguments to empty object", async () => {
    writeFileSync(
      join(FIXTURES, "keys.js"),
      "export function getKeys(args) { return Object.keys(args); }",
    );
    try {
      const req = mockRequest({
        $export: "getKeys",
        $src: "./_fixtures/keys.js",
      });
      const res = await handleServerFunction(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      rmSync(join(FIXTURES, "keys.js"), { force: true });
    }
  });
});
