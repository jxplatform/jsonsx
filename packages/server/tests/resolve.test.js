import { describe, test, expect } from "bun:test";
import { handleResolve, handleServerFunction } from "../src/resolve.js";
import { join, resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const FIXTURES = resolve(import.meta.dir, "_fixtures");

// Create fixtures before tests
mkdirSync(FIXTURES, { recursive: true });

// Self-contained .class.json with resolve() method
const selfContainedClass = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Adder",
  $prototype: "Class",
  $defs: {
    fields: {
      a: { role: "field", access: "public", scope: "instance", identifier: "a", default: 0 },
      b: { role: "field", access: "public", scope: "instance", identifier: "b", default: 0 },
    },
    constructor: {
      role: "constructor",
      $prototype: "Function",
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
writeFileSync(join(FIXTURES, "Adder.class.json"), JSON.stringify(selfContainedClass), "utf8");

// Self-contained .class.json with value property (no resolve)
const valueClass = {
  title: "Greeter",
  $prototype: "Class",
  $defs: {
    fields: {
      name: {
        role: "field",
        access: "public",
        scope: "instance",
        identifier: "name",
        default: "world",
      },
    },
    methods: {
      greeting: {
        role: "accessor",
        identifier: "value",
        getter: { body: 'return "Hello " + this.name;' },
      },
    },
  },
};
writeFileSync(join(FIXTURES, "Greeter.class.json"), JSON.stringify(valueClass), "utf8");

// Self-contained .class.json with neither resolve nor value
const plainClass = {
  title: "Point",
  $prototype: "Class",
  $defs: {
    fields: {
      x: { role: "field", access: "public", scope: "instance", identifier: "x", default: 0 },
      y: { role: "field", access: "public", scope: "instance", identifier: "y", default: 0 },
    },
  },
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
  title: "Calculator",
  $prototype: "Class",
  $implementation: "./calc.js",
  $defs: {
    parameters: {
      a: { identifier: "a", type: { type: "number" } },
      b: { identifier: "b", type: { type: "number" } },
    },
  },
};
writeFileSync(join(FIXTURES, "Calculator.class.json"), JSON.stringify(hybridClass), "utf8");

// Hybrid with missing export
const badHybridClass = {
  title: "Missing",
  $prototype: "Class",
  $implementation: "./calc.js",
};
writeFileSync(join(FIXTURES, "Missing.class.json"), JSON.stringify(badHybridClass), "utf8");

// Private fields .class.json
const privateFieldsClass = {
  title: "Secret",
  $prototype: "Class",
  $defs: {
    fields: {
      data: {
        role: "field",
        access: "private",
        scope: "instance",
        identifier: "data",
        default: "hidden",
      },
    },
    methods: {
      resolve: {
        role: "method",
        identifier: "resolve",
        body: "return this.data;",
      },
    },
  },
};
writeFileSync(join(FIXTURES, "Secret.class.json"), JSON.stringify(privateFieldsClass), "utf8");

// Helper: create a mock Request
function mockRequest(/** @type {unknown} */ body) {
  return new Request("http://localhost/__jx_resolve__", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── handleResolve — self-contained .class.json ─────────────────────────────

describe("handleResolve — self-contained .class.json", () => {
  test("resolves class with resolve() method", async () => {
    const req = mockRequest({
      $src: "./_fixtures/Adder.class.json",
      $prototype: "Adder",
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
      $src: "./_fixtures/Greeter.class.json",
      $prototype: "Greeter",
      name: "Alice",
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBe("Hello Alice");
  });

  test("resolves class with neither resolve nor value (returns instance)", async () => {
    const req = mockRequest({
      $src: "./_fixtures/Point.class.json",
      $prototype: "Point",
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
      $src: "./_fixtures/Secret.class.json",
      $prototype: "Secret",
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBe("hidden");
  });

  test("uses default values when config omitted", async () => {
    const req = mockRequest({
      $src: "./_fixtures/Adder.class.json",
      $prototype: "Adder",
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
      $src: "./_fixtures/Calculator.class.json",
      $prototype: "Calculator",
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
      $src: "./_fixtures/Missing.class.json",
      $prototype: "Missing",
    });
    const res = await handleResolve(req, import.meta.dir);
    expect(res.status).toBe(500);
  });
});

// ─── handleResolve — error handling ─────────────────────────────────────────

describe("handleResolve — errors", () => {
  test("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/__jx_resolve__", {
      method: "POST",
      body: "not json",
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
      $src: "./_fixtures/calc.js",
      $prototype: "Calculator",
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
      title: "SubAdder",
      $prototype: "Class",
      $defs: {
        fields: {
          x: { role: "field", access: "public", scope: "instance", identifier: "x", default: 1 },
        },
        methods: {
          resolve: { role: "method", identifier: "resolve", body: "return this.x * 2;" },
        },
      },
    };
    writeFileSync(join(subDir, "SubAdder.class.json"), JSON.stringify(subClass), "utf8");
    try {
      const req = mockRequest({
        $src: "./SubAdder.class.json",
        $prototype: "SubAdder",
        $base: "http://localhost/_fixtures/sub/page.json",
        x: 7,
      });
      const res = await handleResolve(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toBe(14);
    } finally {
      rmSync(subDir, { recursive: true, force: true });
    }
  });

  test("returns 400 when $base is a malformed URL", async () => {
    const req = mockRequest({
      $src: "./anything.class.json",
      $prototype: "Foo",
      $base: "not-a-url",
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
      title: "Rebaser",
      $prototype: "Class",
      $defs: {
        fields: {
          src: {
            role: "field",
            access: "public",
            scope: "instance",
            identifier: "src",
            default: "",
          },
        },
        methods: {
          resolve: { role: "method", identifier: "resolve", body: "return this.src;" },
        },
      },
    };
    writeFileSync(join(subDir, "Rebaser.class.json"), JSON.stringify(rebaserClass), "utf8");
    try {
      const req = mockRequest({
        $src: "./Rebaser.class.json",
        $prototype: "Rebaser",
        $base: "http://localhost/_fixtures/sub/page.json",
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
      rmSync(subDir, { recursive: true, force: true });
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
        $src: "./_fixtures/BadJson.class.json",
        $prototype: "BadJson",
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
      title: "Counter",
      $prototype: "Class",
      $defs: {
        fields: {
          _count: {
            role: "field",
            access: "public",
            scope: "instance",
            identifier: "_count",
            default: 0,
          },
        },
        methods: {
          count: {
            role: "accessor",
            identifier: "count",
            getter: { body: "return this._count;" },
            setter: {
              parameters: [{ $ref: "#/$defs/parameters/val" }],
              body: "this._count = val;",
            },
          },
          resolve: {
            role: "method",
            identifier: "resolve",
            body: "this.count = 5; return this.count;",
          },
        },
      },
    };
    const counterFile = join(FIXTURES, "Counter.class.json");
    writeFileSync(counterFile, JSON.stringify(counterClass), "utf8");
    try {
      const req = mockRequest({
        $src: "./_fixtures/Counter.class.json",
        $prototype: "Counter",
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
      title: "Factory",
      $prototype: "Class",
      $defs: {
        methods: {
          create: {
            role: "method",
            scope: "static",
            identifier: "create",
            body: "return 42;",
          },
          resolve: {
            role: "method",
            identifier: "resolve",
            body: "return this.constructor.create();",
          },
        },
      },
    };
    const factoryFile = join(FIXTURES, "Factory.class.json");
    writeFileSync(factoryFile, JSON.stringify(factoryClass), "utf8");
    try {
      const req = mockRequest({
        $src: "./_fixtures/Factory.class.json",
        $prototype: "Factory",
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
      title: "HybridValue",
      $prototype: "Class",
      $implementation: "./value-holder.js",
    };
    writeFileSync(classFile, JSON.stringify(hybridValueClass), "utf8");
    try {
      const req = mockRequest({
        $src: "./_fixtures/HybridValue.class.json",
        $prototype: "HybridValue",
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
      $src: "./foo.js",
      $export: "fn",
      $base: "not-a-url",
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
      method: "POST",
      body: "bad",
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
        $src: "./_fixtures/server-fn.js",
        $export: "add",
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
      const req = mockRequest({ $src: "./_fixtures/noop.js", $export: "noop" });
      const res = await handleServerFunction(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    } finally {
      rmSync(join(FIXTURES, "noop.js"), { force: true });
    }
  });

  test("returns 500 when module not found", async () => {
    const req = mockRequest({ $src: "./_fixtures/nonexistent.js", $export: "fn" });
    const res = await handleServerFunction(req, import.meta.dir);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Failed to import");
  });

  test("returns 500 when export not found in module", async () => {
    const req = mockRequest({ $src: "./_fixtures/calc.js", $export: "nonExistent" });
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
      const req = mockRequest({ $src: "./_fixtures/throws.js", $export: "boom" });
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
        $src: "./greet.js",
        $export: "greet",
        $base: `http://localhost/_fixtures/api/page.json`,
        arguments: { name: "world" },
      });
      const res = await handleServerFunction(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toBe("hello world");
    } finally {
      rmSync(join(FIXTURES, "api"), { recursive: true, force: true });
    }
  });

  test("defaults arguments to empty object", async () => {
    writeFileSync(
      join(FIXTURES, "keys.js"),
      "export function getKeys(args) { return Object.keys(args); }",
    );
    try {
      const req = mockRequest({ $src: "./_fixtures/keys.js", $export: "getKeys" });
      const res = await handleServerFunction(req, import.meta.dir);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      rmSync(join(FIXTURES, "keys.js"), { force: true });
    }
  });
});
