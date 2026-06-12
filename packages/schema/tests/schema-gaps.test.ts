/**
 * Covers the public-API tail of src/schema.ts: generateSchemaString, validateDocument (with ajv
 * mocked — it is an optional peer dependency that is not installed), and the CLI block's default
 * (no-arg) branch, triggered by pointing argv[1] at a schema.ts path inside a temp directory.
 */
import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ── Fake ajv / ajv-formats (optional peers, not installed in this repo) ────────
type FakeValidate = ((doc: unknown) => boolean) & {
  errors: { instancePath: string; message: string }[] | null;
};

const compiledSchemas: unknown[] = [];

class FakeAjv {
  options: unknown;

  constructor(options: unknown) {
    this.options = options;
  }

  compile(schema: unknown): FakeValidate {
    compiledSchemas.push({ options: this.options, schema });
    const validate = ((doc: unknown) => {
      const bad =
        typeof doc === "object" &&
        doc !== null &&
        (doc as Record<string, unknown>).__invalid === true;
      validate.errors = bad ? [{ instancePath: "", message: "fake schema violation" }] : null;
      return !bad;
    }) as FakeValidate;
    validate.errors = null;
    return validate;
  }
}

const addFormatsCalls: unknown[] = [];

mock.module("ajv", () => ({ default: FakeAjv }));
mock.module("ajv-formats", () => ({
  default: (ajv: unknown) => {
    addFormatsCalls.push(ajv);
  },
}));

// ── Trigger the CLI default branch at import time ───────────────────────────────
const TMP = resolve(tmpdir(), `jx-schema-cli-test-${Date.now()}`);
mkdirSync(join(TMP, "src"), { recursive: true });

const cliMessages: string[] = [];
console.error = (...args: unknown[]) => {
  cliMessages.push(args.join(" "));
};

process.argv = [process.argv[0] ?? "bun", join(TMP, "src", "schema.ts")];

const { generateSchemaString, validateDocument } = await import("../src/schema");

// Snapshot the CLI's output files before cleaning up the temp directory.
const wroteComponent = existsSync(join(TMP, "schema.json"));
const wroteProject = existsSync(join(TMP, "project-schema.json"));
const wroteClass = existsSync(join(TMP, "class-schema.json"));
const componentSchemaText = wroteComponent ? readFileSync(join(TMP, "schema.json"), "utf8") : "";
rmSync(TMP, { force: true, recursive: true });

describe("CLI default branch", () => {
  test("writes all three schema files next to the schema source", () => {
    expect(wroteComponent).toBe(true);
    expect(wroteProject).toBe(true);
    expect(wroteClass).toBe(true);
    expect(JSON.parse(componentSchemaText).$defs).toBeDefined();
  });

  test("logs the generated file names", () => {
    expect(cliMessages.join("\n")).toContain("Generated:");
    expect(cliMessages.join("\n")).toContain("schema.json (component)");
    expect(cliMessages.join("\n")).toContain("project-schema.json");
    expect(cliMessages.join("\n")).toContain("class-schema.json");
  });
});

describe("generateSchemaString", () => {
  test("returns pretty-printed JSON of the component schema", async () => {
    const text = await generateSchemaString();
    const parsed = JSON.parse(text);
    expect(parsed.$schema).toContain("json-schema.org");
    expect(parsed.$defs).toBeDefined();
    // Pretty-printed with 2-space indent
    expect(text).toContain('\n  "$schema"');
  });
});

describe("validateDocument", () => {
  test("returns valid: true with null errors for a passing document", async () => {
    const result = await validateDocument({ tagName: "div" });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeNull();
  });

  test("returns valid: false with errors for a failing document", async () => {
    const result = await validateDocument({ __invalid: true });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([{ instancePath: "", message: "fake schema violation" }]);
  });

  test("constructs Ajv with allErrors and registers formats", async () => {
    await validateDocument({ tagName: "p" });
    expect(addFormatsCalls.length).toBeGreaterThan(0);
    expect(addFormatsCalls[0]).toBeInstanceOf(FakeAjv);
    expect((addFormatsCalls[0] as FakeAjv).options).toEqual({
      allErrors: true,
      ownProperties: true,
      strict: false,
    });
    expect(compiledSchemas.length).toBeGreaterThan(0);
  });
});
