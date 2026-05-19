import { describe, test, expect } from "bun:test";
import { generateProjectSchema, generateClassSchema, generateSchema } from "../src/schema.js";

// ─── generateProjectSchema ──────────────────────────────────────────────────

describe("generateProjectSchema", () => {
  const schema = /** @type {any} */ (generateProjectSchema());

  test("returns valid JSON Schema 2020-12", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://jxsuite.com/schema/project/v1");
    expect(schema.type).toBe("object");
  });

  test("includes required top-level properties", () => {
    const props = Object.keys(schema.properties);
    expect(props).toContain("name");
    expect(props).toContain("url");
    expect(props).toContain("defaults");
    expect(props).toContain("$head");
    expect(props).toContain("$elements");
    expect(props).toContain("imports");
    expect(props).toContain("$media");
    expect(props).toContain("style");
    expect(props).toContain("contentTypes");
    expect(props).toContain("build");
    expect(props).toContain("i18n");
    expect(props).toContain("redirects");
    expect(props).toContain("copy");
    expect(props).toContain("state");
  });

  test("defaults.layout accepts string or null", () => {
    const layout = schema.properties.defaults.properties.layout;
    expect(layout.oneOf).toHaveLength(2);
    expect(layout.oneOf[0].type).toBe("string");
    expect(layout.oneOf[1].type).toBe("null");
  });

  test("build.format restricts to directory|single", () => {
    const format = schema.properties.build.properties.format;
    expect(format.enum).toEqual(["directory", "single"]);
  });

  test("build.adapter restricts to known platforms", () => {
    const adapter = schema.properties.build.properties.adapter;
    expect(adapter.enum).toEqual(["netlify", "vercel", "cloudflare"]);
  });

  test("disallows additional properties", () => {
    expect(schema.additionalProperties).toBe(false);
  });

  test("contentTypes entries have source, schema, $elements", () => {
    const collectionEntry = schema.properties.contentTypes.additionalProperties;
    const collProps = Object.keys(collectionEntry.properties);
    expect(collProps).toContain("source");
    expect(collProps).toContain("schema");
    expect(collProps).toContain("$elements");
  });
});

// ─── generateClassSchema ────────────────────────────────────────────────────

describe("generateClassSchema", () => {
  const schema = /** @type {any} */ (generateClassSchema());

  test("returns valid JSON Schema 2020-12", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://jxsuite.com/schema/class/v1");
    expect(schema.type).toBe("object");
  });

  test("requires $prototype and title", () => {
    expect(schema.required).toEqual(["$prototype", "title"]);
  });

  test("$prototype must be Class", () => {
    expect(schema.properties.$prototype.const).toBe("Class");
  });

  test("disallows additional properties", () => {
    expect(schema.additionalProperties).toBe(false);
  });

  test("includes class member $defs", () => {
    const defsProps = schema.properties.$defs.properties;
    expect(defsProps).toHaveProperty("parameters");
    expect(defsProps).toHaveProperty("returnTypes");
    expect(defsProps).toHaveProperty("fields");
    expect(defsProps).toHaveProperty("constructor");
    expect(defsProps).toHaveProperty("methods");
  });

  test("extends accepts string or $ref object", () => {
    const ext = schema.properties.extends;
    expect(ext.oneOf).toHaveLength(2);
    expect(ext.oneOf[0].type).toBe("string");
    expect(ext.oneOf[1].type).toBe("object");
  });

  test("$defs contains ClassParameterDef with required identifier", () => {
    const paramDef = schema.$defs.ClassParameterDef;
    expect(paramDef.required).toEqual(["identifier"]);
    expect(paramDef.properties).toHaveProperty("type");
    expect(paramDef.properties).toHaveProperty("description");
  });

  test("$defs contains ClassFieldDef with access enum", () => {
    const fieldDef = schema.$defs.ClassFieldDef;
    expect(fieldDef.properties.access.enum).toEqual(["public", "private", "protected"]);
    expect(fieldDef.properties.scope.enum).toEqual(["instance", "static"]);
  });

  test("$defs contains ClassMethodDef with role enum", () => {
    const methodDef = schema.$defs.ClassMethodDef;
    expect(methodDef.properties.role.enum).toEqual(["method", "accessor"]);
  });

  test("ClassConstructorDef body accepts string or array", () => {
    const ctorDef = schema.$defs.ClassConstructorDef;
    expect(ctorDef.properties.body.oneOf).toHaveLength(2);
  });
});

// ─── generateSchema (async — webref data) ───────────────────────────────────

describe("generateSchema", () => {
  test("returns valid JSON Schema 2020-12 with web data", async () => {
    const schema = /** @type {any} */ (await generateSchema());
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://jxsuite.com/schema/v1");
    expect(schema.type).toBe("object");
  });

  test("includes tag name examples from webref", async () => {
    const schema = /** @type {any} */ (await generateSchema());
    const tagExamples = schema.$defs.TagName.examples;
    expect(tagExamples).toContain("div");
    expect(tagExamples).toContain("span");
    expect(tagExamples).toContain("a");
    expect(tagExamples.length).toBeGreaterThan(10);
  });

  test("includes CSS properties from webref", async () => {
    const schema = /** @type {any} */ (await generateSchema());
    const cssProps = Object.keys(schema.$defs.StyleObject.properties);
    expect(cssProps.length).toBeGreaterThan(50);
  });

  test("includes event handler properties", async () => {
    const schema = /** @type {any} */ (await generateSchema());
    const elementProps = Object.keys(schema.$defs.ElementDef.properties);
    expect(elementProps).toContain("onclick");
    expect(elementProps).toContain("onchange");
    expect(elementProps).toContain("onkeydown");
  });

  test("includes top-level document properties", async () => {
    const schema = /** @type {any} */ (await generateSchema());
    const props = Object.keys(schema.properties);
    expect(props).toContain("$schema");
    expect(props).toContain("$id");
    expect(props).toContain("$defs");
    expect(props).toContain("state");
    expect(props).toContain("$media");
    expect(props).toContain("children");
    expect(props).toContain("style");
  });

  test("StateEntry supports all value shapes", async () => {
    const schema = /** @type {any} */ (await generateSchema());
    const stateEntry = schema.$defs.StateEntry;
    expect(stateEntry.oneOf.length).toBeGreaterThanOrEqual(5);
  });

  test("FunctionDef requires $prototype and restricts to Function", async () => {
    const schema = /** @type {any} */ (await generateSchema());
    const funcDef = schema.$defs.FunctionDef;
    expect(funcDef.required).toContain("$prototype");
    expect(funcDef.properties.$prototype.const).toBe("Function");
    expect(funcDef.additionalProperties).toBe(false);
  });

  test("ExternalClassDef $prototype excludes Function", async () => {
    const schema = /** @type {any} */ (await generateSchema());
    const extDef = schema.$defs.ExternalClassDef;
    expect(extDef.properties.$prototype.not.const).toBe("Function");
  });

  test("$ref types include all reference patterns", async () => {
    const schema = /** @type {any} */ (await generateSchema());
    expect(schema.$defs.InternalRef.pattern).toBe("^#/\\$defs/");
    expect(schema.$defs.StateRef.pattern).toBe("^#/state/");
    expect(schema.$defs.MapRef.pattern).toBe("^\\$map/(item|index)(/.*)?$");
  });
});
