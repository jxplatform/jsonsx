/**
 * Class-schema drift guard (specs/extensions.md §6–§12): the generated class schema must track
 * format-registry's admission blocks and capability roles. Fails the moment a capability role or
 * admission block is added to the registry without a matching schema update — plus an integration
 * net: every shipped extension class in the repo must validate.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLASS_METHOD_ROLES } from "../defs/class-def.schema";
import { EXTENSION_CAPABILITIES } from "../src/format-registry";
import { generateClassSchema, validateClass, validateWithSchema } from "../src/schema";

describe("class schema ↔ format-registry drift guard", () => {
  test("every registry capability role is a schema method role", () => {
    for (const capability of EXTENSION_CAPABILITIES) {
      expect(CLASS_METHOD_ROLES).toContain(capability);
    }
  });

  test("the generated class schema carries the full role enum", () => {
    const schema = generateClassSchema();
    const roleEnum = schema.$defs.ClassMethodDef.properties.role.enum;
    expect([...roleEnum]).toEqual([...CLASS_METHOD_ROLES]);
  });

  test("the admission-block property set matches the registry blocks", () => {
    const schema = generateClassSchema();
    // Format-registry dispatches on exactly these descriptor blocks (ClassDefLike).
    expect(schema.properties.format).toEqual({ $ref: "#/$defs/FormatDef" });
    expect(schema.properties.project).toEqual({ $ref: "#/$defs/ProjectBlockDef" });
    expect(schema.properties.server).toEqual({ $ref: "#/$defs/ServerBlockDef" });
    expect(schema.properties.connector).toEqual({ $ref: "#/$defs/ConnectorBlockDef" });
    // Required keys mirror the ProjectBlock/ServerBlock/ConnectorBlock interfaces.
    expect([...schema.$defs.ProjectBlockDef.required]).toEqual(["key"]);
    expect([...schema.$defs.ServerBlockDef.required]).toEqual(["basePath"]);
    expect([...schema.$defs.ConnectorBlockDef.required]).toEqual(["provider", "kind"]);
    // ConnectorBlock is open ([key: string]: unknown) — a closed schema re-rejects providers.
    expect(
      (schema.$defs.ConnectorBlockDef as { additionalProperties?: boolean }).additionalProperties,
    ).not.toBe(false);
  });

  test("every shipped extension class validates against the class schema", async () => {
    const extensionsDir = resolve(import.meta.dir, "../../../extensions");
    const classFiles: string[] = [];
    for (const ext of readdirSync(extensionsDir)) {
      const srcDir = join(extensionsDir, ext, "src");
      let names: string[];
      try {
        names = readdirSync(srcDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith(".class.json")) {
          classFiles.push(join(srcDir, name));
        }
      }
    }
    expect(classFiles.length).toBeGreaterThan(0);
    for (const file of classFiles) {
      const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const { errors, valid } = await validateClass(doc);
      if (!valid) {
        throw new Error(`${file} failed class-schema validation: ${JSON.stringify(errors)}`);
      }
    }
  });

  test("validateWithSchema validates against an arbitrary self-contained schema", async () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: { name: { type: "string" } },
      required: ["name"],
      type: "object",
    };
    const ok = await validateWithSchema({ name: "ok" }, schema);
    expect(ok.valid).toBe(true);
    const bad = await validateWithSchema({}, schema);
    expect(bad.valid).toBe(false);
    expect(bad.errors).not.toBeNull();
  });
});
