/**
 * Tests for @jxsuite/ai tool registry — registration, validation branches, LLM-format shaping, and
 * execution paths.
 *
 * @module @jxsuite/ai/tests
 */

import { describe, it, expect, mock } from "bun:test";
import { createToolDefinition, createToolRegistry, toolError, toolSuccess } from "../src/tools.js";

// ─── Result helpers ───────────────────────────────────────────────────────────

describe("toolSuccess / toolError", () => {
  it("toolSuccess carries data and optional summary", () => {
    const withSummary = toolSuccess({ id: 1 }, "done");
    expect(withSummary.success).toBe(true);
    expect(withSummary.data).toEqual({ id: 1 });
    expect(withSummary.summary).toBe("done");

    const withoutSummary = toolSuccess(42);
    expect(withoutSummary.success).toBe(true);
    expect(withoutSummary.data).toBe(42);
    expect(withoutSummary.summary).toBeUndefined();
  });

  it("toolError carries the message and no data", () => {
    const result = toolError("nope");
    expect(result.success).toBe(false);
    expect(result.error).toBe("nope");
    expect(result.data).toBeUndefined();
  });
});

// ─── createToolDefinition ───────────────────────────────────────────────────

describe("createToolDefinition", () => {
  it("applies default strict=true and llmStrict=false", () => {
    const def = createToolDefinition({
      name: "noop",
      description: "does nothing",
      parameters: { type: "object", properties: {} },
      execute: () => toolSuccess(null),
    });

    expect(def.name).toBe("noop");
    expect(def.description).toBe("does nothing");
    expect(def.strict).toBe(true);
    expect(def.llmStrict).toBe(false);
    expect(typeof def.execute).toBe("function");
  });

  it("honors explicit strict and llmStrict overrides", () => {
    const def = createToolDefinition({
      name: "strictish",
      description: "configurable",
      parameters: { type: "object", properties: {} },
      strict: false,
      llmStrict: true,
      execute: () => toolSuccess(null),
    });

    expect(def.strict).toBe(false);
    expect(def.llmStrict).toBe(true);
  });
});

// ─── Registration ─────────────────────────────────────────────────────────────

describe("ToolRegistry registration", () => {
  function makeTool(name: string) {
    return createToolDefinition({
      name,
      description: `tool ${name}`,
      parameters: { type: "object", properties: {} },
      execute: () => toolSuccess(name),
    });
  }

  it("warns and overwrites when re-registering the same name", () => {
    const registry = createToolRegistry();
    const warn = mock((..._args: unknown[]) => {});
    const original = console.warn;
    console.warn = warn;
    try {
      registry.register(makeTool("dup"));
      registry.register(makeTool("dup"));
    } finally {
      console.warn = original;
    }

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain("dup");
    expect(message).toContain("re-registered");
    expect(registry.list().length).toBe(1);
  });

  it("does not warn for distinct tool names", () => {
    const registry = createToolRegistry();
    const warn = mock((..._args: unknown[]) => {});
    const original = console.warn;
    console.warn = warn;
    try {
      registry.register(makeTool("a"));
      registry.register(makeTool("b"));
    } finally {
      console.warn = original;
    }

    expect(warn).not.toHaveBeenCalled();
    expect(registry.list().length).toBe(2);
  });
});

// ─── getDefinition ────────────────────────────────────────────────────────────

describe("ToolRegistry.getDefinition", () => {
  it("returns the registered definition by name", () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "lookup",
        description: "find me",
        parameters: { type: "object", properties: {} },
        execute: () => toolSuccess("ok"),
      }),
    );

    const def = registry.getDefinition("lookup");
    expect(def).toBeDefined();
    expect(def!.name).toBe("lookup");
    expect(def!.description).toBe("find me");
  });

  it("returns undefined for an unknown name", () => {
    const registry = createToolRegistry();
    expect(registry.getDefinition("missing")).toBeUndefined();
  });
});

// ─── listForLLM ───────────────────────────────────────────────────────────────

describe("ToolRegistry.listForLLM", () => {
  it("includes strict:true in the function only when llmStrict is set", () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "plain",
        description: "no strict",
        parameters: { type: "object", properties: { x: { type: "string" } } },
        execute: () => toolSuccess("ok"),
      }),
    );
    registry.register(
      createToolDefinition({
        name: "strict_one",
        description: "strict",
        parameters: { type: "object", properties: { y: { type: "string" } } },
        llmStrict: true,
        execute: () => toolSuccess("ok"),
      }),
    );

    const tools = registry.listForLLM() as {
      type: string;
      function: { name: string; description: string; parameters: object; strict?: boolean };
    }[];

    expect(tools.length).toBe(2);

    const plain = tools.find((t) => t.function.name === "plain")!;
    expect(plain.type).toBe("function");
    expect(plain.function.description).toBe("no strict");
    expect(plain.function.parameters).toEqual({
      type: "object",
      properties: { x: { type: "string" } },
    });
    expect("strict" in plain.function).toBe(false);

    const strictOne = tools.find((t) => t.function.name === "strict_one")!;
    expect(strictOne.function.strict).toBe(true);
  });

  it("returns an empty array when no tools are registered", () => {
    const registry = createToolRegistry();
    expect(registry.listForLLM()).toEqual([]);
  });
});

// ─── validate — early-exit branches ───────────────────────────────────────────

describe("ToolRegistry.validate early exits", () => {
  it("skips validation when strict is false", () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "lenient",
        description: "lenient",
        parameters: {
          type: "object",
          properties: { needed: { type: "string" } },
          required: ["needed"],
        },
        strict: false,
        execute: () => toolSuccess("ok"),
      }),
    );

    const result = registry.validate("lenient", {});
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("passes when the schema has no properties block", () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "anything",
        description: "schema without properties",
        parameters: { type: "object" },
        execute: () => toolSuccess("ok"),
      }),
    );

    const result = registry.validate("anything", { whatever: 1, more: "x" });
    expect(result.valid).toBe(true);
  });
});

// ─── validate — required + type checks ────────────────────────────────────────

describe("ToolRegistry.validate type checks", () => {
  function registryWith(properties: Record<string, { type: string }>, required: string[] = []) {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "typed",
        description: "typed tool",
        parameters: { type: "object", properties, required },
        execute: () => toolSuccess("ok"),
      }),
    );
    return registry;
  }

  it("flags a required argument that is null", () => {
    const registry = registryWith({ name: { type: "string" } }, ["name"]);
    const result = registry.validate("typed", { name: null });
    expect(result.valid).toBe(false);
    expect(result.errors![0]).toContain("Missing required argument");
    expect(result.errors![0]).toContain("name");
  });

  it("flags a required argument that is explicitly undefined", () => {
    const registry = registryWith({ name: { type: "string" } }, ["name"]);
    const result = registry.validate("typed", { name: undefined });
    expect(result.valid).toBe(false);
    expect(result.errors![0]).toContain("Missing required argument");
  });

  it("ignores extra properties not present in the schema", () => {
    const registry = registryWith({ name: { type: "string" } });
    const result = registry.validate("typed", { name: "ok", extra: 99 });
    expect(result.valid).toBe(true);
  });

  it("ignores schema properties that declare no type", () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "untyped",
        description: "untyped prop",
        parameters: { type: "object", properties: { freeform: {} } },
        execute: () => toolSuccess("ok"),
      }),
    );
    const result = registry.validate("untyped", { freeform: { any: "thing" } });
    expect(result.valid).toBe(true);
  });

  it("accepts a genuine number for a number property", () => {
    const registry = registryWith({ n: { type: "number" } });
    expect(registry.validate("typed", { n: 3.14 }).valid).toBe(true);
  });

  it("accepts a numeric string for an integer property (coercion)", () => {
    const registry = registryWith({ n: { type: "integer" } });
    expect(registry.validate("typed", { n: "7" }).valid).toBe(true);
  });

  it("rejects a non-numeric string for a number property", () => {
    const registry = registryWith({ n: { type: "number" } });
    const result = registry.validate("typed", { n: "abc" });
    expect(result.valid).toBe(false);
    expect(result.errors![0]).toContain("non-numeric string");
  });

  it("rejects a boolean for a number property", () => {
    const registry = registryWith({ n: { type: "number" } });
    const result = registry.validate("typed", { n: true });
    expect(result.valid).toBe(false);
    expect(result.errors![0]).toContain("should be a number, got boolean");
  });

  it("rejects an array for an integer property", () => {
    const registry = registryWith({ n: { type: "integer" } });
    const result = registry.validate("typed", { n: [1, 2] });
    expect(result.valid).toBe(false);
    expect(result.errors![0]).toContain("should be a number, got array");
  });

  it("rejects a non-string for a string property", () => {
    const registry = registryWith({ s: { type: "string" } });
    const result = registry.validate("typed", { s: 5 });
    expect(result.valid).toBe(false);
    expect(result.errors![0]).toContain("should be a string, got number");
  });

  it("accepts a matching string property", () => {
    const registry = registryWith({ s: { type: "string" } });
    expect(registry.validate("typed", { s: "hi" }).valid).toBe(true);
  });

  it("rejects a non-boolean for a boolean property", () => {
    const registry = registryWith({ b: { type: "boolean" } });
    const result = registry.validate("typed", { b: "true" });
    expect(result.valid).toBe(false);
    expect(result.errors![0]).toContain("should be a boolean, got string");
  });

  it("accepts a matching boolean property", () => {
    const registry = registryWith({ b: { type: "boolean" } });
    expect(registry.validate("typed", { b: false }).valid).toBe(true);
  });

  it("rejects a non-array for an array property", () => {
    const registry = registryWith({ items: { type: "array" } });
    const result = registry.validate("typed", { items: "nope" });
    expect(result.valid).toBe(false);
    expect(result.errors![0]).toContain("should be an array, got string");
  });

  it("accepts a matching array property", () => {
    const registry = registryWith({ items: { type: "array" } });
    expect(registry.validate("typed", { items: [1, 2, 3] }).valid).toBe(true);
  });

  it("rejects a non-object for an object property", () => {
    const registry = registryWith({ obj: { type: "object" } });
    const result = registry.validate("typed", { obj: "nope" });
    expect(result.valid).toBe(false);
    expect(result.errors![0]).toContain("should be an object, got string");
  });

  it("accepts a matching object property", () => {
    const registry = registryWith({ obj: { type: "object" } });
    expect(registry.validate("typed", { obj: { a: 1 } }).valid).toBe(true);
  });

  it("collects multiple errors across required and type checks", () => {
    const registry = registryWith({ a: { type: "string" }, b: { type: "number" } }, ["a"]);
    const result = registry.validate("typed", { b: "not-a-number" });
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBe(2);
  });

  it("reports the unknown tool name when validating", () => {
    const registry = createToolRegistry();
    const result = registry.validate("ghost", {});
    expect(result.valid).toBe(false);
    expect(result.errors![0]).toContain("Unknown tool");
    expect(result.errors![0]).toContain("ghost");
  });
});

// ─── execute ──────────────────────────────────────────────────────────────────

describe("ToolRegistry.execute", () => {
  it("returns an error result for an unknown tool", async () => {
    const registry = createToolRegistry();
    const result = await registry.execute("nope", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
    expect(result.error).toContain("nope");
  });

  it("returns a validation-failed error before running execute", async () => {
    let ran = false;
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "needsName",
        description: "requires name",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        execute: () => {
          ran = true;
          return toolSuccess("ok");
        },
      }),
    );

    const result = await registry.execute("needsName", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
    expect(result.error).toContain("name");
    expect(ran).toBe(false);
  });

  it("awaits an async execute and returns its result", async () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "asyncTool",
        description: "async",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          await Promise.resolve();
          return toolSuccess("async-data", "did it");
        },
      }),
    );

    const result = await registry.execute("asyncTool", {});
    expect(result.success).toBe(true);
    expect(result.data).toBe("async-data");
    expect(result.summary).toBe("did it");
  });

  it("wraps a thrown error from execute as a tool error", async () => {
    const registry = createToolRegistry();
    registry.register(
      createToolDefinition({
        name: "thrower",
        description: "throws",
        parameters: { type: "object", properties: {} },
        execute: () => {
          throw new Error("kaboom");
        },
      }),
    );

    const result = await registry.execute("thrower", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("thrower");
    expect(result.error).toContain("execution error");
    expect(result.error).toContain("kaboom");
  });
});
