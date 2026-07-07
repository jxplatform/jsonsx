import { describe, expect, test } from "bun:test";
import { generateClassSchema, generateProjectSchema, generateSchema } from "../src/schema";

// ─── generateProjectSchema ──────────────────────────────────────────────────

describe("generateProjectSchema", () => {
  const schema = generateProjectSchema() as any;

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
    const { layout } = schema.properties.defaults.properties;
    expect(layout.oneOf).toHaveLength(2);
    expect(layout.oneOf[0].type).toBe("string");
    expect(layout.oneOf[1].type).toBe("null");
  });

  test("build.format restricts to directory|single", () => {
    const { format } = schema.properties.build.properties;
    expect(format.enum).toEqual(["directory", "single"]);
  });

  test("build.adapter restricts to the adapters the compiler implements", () => {
    const { adapter } = schema.properties.build.properties;
    expect(adapter.enum).toEqual([
      "static",
      "cloudflare-pages",
      "cloudflare-workers",
      "node",
      "bun",
    ]);
  });

  test("build.deploy tracks the connected hosting project (identifiers only)", () => {
    const { deploy } = schema.properties.build.properties;
    expect(deploy.type).toBe("object");
    expect(deploy.additionalProperties).toBe(false);
    expect(deploy.required).toEqual(["provider", "accountId", "projectName"]);
    expect(deploy.properties.provider.enum).toEqual(["cloudflare-pages"]);
    expect(deploy.properties.projectName.pattern).toBe("^[a-z0-9][a-z0-9-]*$");
    expect(Object.keys(deploy.properties).toSorted()).toEqual([
      "accountId",
      "productionUrl",
      "projectName",
      "provider",
    ]);
  });

  test("disallows additional properties", () => {
    expect(schema.additionalProperties).toBe(false);
  });

  test("contentTypes entries reference ContentTypeDef", () => {
    const collectionEntry = schema.properties.contentTypes.additionalProperties;
    expect(collectionEntry.$ref).toBe("#/$defs/ContentTypeDef");
    const contentTypeDef = schema.$defs.ContentTypeDef;
    const collProps = Object.keys(contentTypeDef.properties);
    expect(collProps).toContain("source");
    expect(collProps).toContain("schema");
    expect(collProps).toContain("$elements");
  });
});

// ─── generateClassSchema ────────────────────────────────────────────────────

describe("generateClassSchema", () => {
  const schema = generateClassSchema() as any;

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
    expect(methodDef.properties.role.enum).toEqual([
      "method",
      "accessor",
      "parse",
      "serialize",
      "discover",
      "load",
    ]);
    expect(methodDef.properties.timing.items.enum).toEqual(["compiler", "server", "client"]);
  });

  test("$defs contains FormatDef and StudioHints for format classes", () => {
    expect(schema.$defs.FormatDef.required).toEqual(["extensions"]);
    expect(schema.properties.format).toEqual({ $ref: "#/$defs/FormatDef" });
    expect(schema.properties.$studio).toEqual({ $ref: "#/$defs/StudioHints" });
  });

  test("ClassConstructorDef body accepts string or array", () => {
    const ctorDef = schema.$defs.ClassConstructorDef;
    expect(ctorDef.properties.body.oneOf).toHaveLength(2);
  });
});

// ─── generateSchema (async — webref data) ───────────────────────────────────

describe("generateSchema", () => {
  test("returns valid JSON Schema 2020-12 with web data", async () => {
    const schema = (await generateSchema()) as any;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://jxsuite.com/schema/v1");
    expect(schema.type).toBe("object");
  });

  test("includes tag name examples from webref", async () => {
    const schema = (await generateSchema()) as any;
    const tagExamples = schema.$defs.TagName.examples;
    expect(tagExamples).toContain("div");
    expect(tagExamples).toContain("span");
    expect(tagExamples).toContain("a");
    expect(tagExamples.length).toBeGreaterThan(10);
  });

  test("includes CSS properties from webref", async () => {
    const schema = (await generateSchema()) as any;
    const cssProps = Object.keys(schema.$defs.StyleObject.properties);
    expect(cssProps.length).toBeGreaterThan(50);
  });

  test("includes event handler properties", async () => {
    const schema = (await generateSchema()) as any;
    const elementProps = Object.keys(schema.$defs.ElementDef.properties);
    expect(elementProps).toContain("onclick");
    expect(elementProps).toContain("onchange");
    expect(elementProps).toContain("onkeydown");
  });

  test("includes top-level document properties", async () => {
    const schema = (await generateSchema()) as any;
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
    const schema = (await generateSchema()) as any;
    const stateEntry = schema.$defs.StateEntry;
    expect(stateEntry.oneOf.length).toBeGreaterThanOrEqual(5);
  });

  test("FunctionDef requires $prototype and restricts to Function", async () => {
    const schema = (await generateSchema()) as any;
    const funcDef = schema.$defs.FunctionDef;
    expect(funcDef.required).toContain("$prototype");
    expect(funcDef.properties.$prototype.const).toBe("Function");
    expect(funcDef.additionalProperties).toBe(false);
  });

  test("ExternalClassDef $prototype excludes Function", async () => {
    const schema = (await generateSchema()) as any;
    const extDef = schema.$defs.ExternalClassDef;
    expect(extDef.properties.$prototype.not.const).toBe("Function");
  });

  test("$ref types include all reference patterns", async () => {
    const schema = (await generateSchema()) as any;
    expect(schema.$defs.InternalRef.pattern).toBe(String.raw`^#/\$defs/`);
    expect(schema.$defs.StateRef.pattern).toBe("^#/state/");
    expect(schema.$defs.MapRef.pattern).toBe(String.raw`^\$map/(item|index)(/.*)?$`);
  });

  test("ExpressionEntry is defined in schema $defs", async () => {
    const schema = (await generateSchema()) as any;
    expect(schema.$defs.ExpressionEntry).toBeDefined();
    expect(schema.$defs.ExpressionEntry.required).toContain("$expression");
  });

  test("ExpressionNode enforces operator-specific constraints via oneOf", async () => {
    const schema = (await generateSchema()) as any;
    const node = schema.$defs.ExpressionNode;
    expect(node.oneOf.length).toBeGreaterThanOrEqual(7);
  });

  test("StateEntry includes ExpressionEntry (Shape 5)", async () => {
    const schema = (await generateSchema()) as any;
    const stateEntry = schema.$defs.StateEntry;
    const refs = stateEntry.oneOf
      .filter(/** @param {any} e */ (e: any) => e.$ref)
      .map(/** @param {any} e */ (e: any) => e.$ref);
    expect(refs).toContain("#/$defs/ExpressionEntry");
  });

  test("event handlers accept ExpressionEntry inline", async () => {
    const schema = (await generateSchema()) as any;
    const { onclick } = schema.$defs.ElementDef.properties;
    const refs = onclick.oneOf.map(/** @param {any} e */ (e: any) => e.$ref);
    expect(refs).toContain("#/$defs/ExpressionEntry");
    expect(refs).toContain("#/$defs/RefObject");
  });

  test("ExpressionEntry plain object exclusion prevents false match", async () => {
    const schema = (await generateSchema()) as any;
    const plainObj = schema.$defs.StateEntry.oneOf.find(
      /** @param {any} e */ (e: any) => e.type === "object" && e.not,
    );
    expect(JSON.stringify(plainObj.not)).toContain("$expression");
  });
});
