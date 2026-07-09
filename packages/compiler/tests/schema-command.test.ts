/**
 * Schema-command.test.ts — `jx schema` entry-document emission
 *
 * Verifies the project-relative ref computation: bare-specifier packages that resolve through the
 * workspace (outside the fixture root) fall back to conventional ./node_modules paths, local
 * extensions keep in-project relative paths, and document fragments contribute canonical
 * "$id#/$defs/*" paths refs (skipping fragments without $id/$defs or unreadable ones).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED_SCHEMA_COMMENT } from "@jxsuite/schema/project-schemas";
import { writeProjectSchemas } from "../src/site/schema-command";

const TMP = resolve(import.meta.dir, "__test-schema-command__");

function writeFile(relPath: string, content: string | object) {
  const abs = resolve(TMP, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

function readJson(relPath: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(TMP, relPath), "utf8"));
}

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });

  writeFile("project.json", {
    extensions: ["@jxsuite/parser", "./local-ext"],
    name: "Schema Command Fixture",
  });

  writeFile("local-ext/jx-extension.json", {
    classes: {},
    name: "local-schema-ext",
    schemas: {
      document: "./document.fragment.schema.json",
      project: "./project.fragment.schema.json",
    },
  });

  writeFile("local-ext/project.fragment.schema.json", {
    $id: "https://test.invalid/local-ext/project/v1",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    properties: { localstuff: { type: "object" } },
    type: "object",
  });

  // Document fragment WITHOUT an $id — contributes no paths refs.
  writeFile("local-ext/document.fragment.schema.json", {
    $defs: { LocalPaths: { type: "object" } },
    $schema: "https://json-schema.org/draft/2020-12/schema",
  });
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

describe("writeProjectSchemas", () => {
  it("emits both entry documents with project-relative refs", async () => {
    const { projectSchemaPath, documentSchemaPath } = await writeProjectSchemas(TMP);
    expect(projectSchemaPath).toBe(resolve(TMP, "project.schema.json"));
    expect(documentSchemaPath).toBe(resolve(TMP, "document.schema.json"));

    const project = readJson("project.schema.json");
    expect(project.$comment).toBe(GENERATED_SCHEMA_COMMENT);
    // Workspace resolution escapes the fixture root → conventional node_modules fallback; the
    // Local extension stays a plain in-project path.
    expect(project.allOf.map((entry: { $ref: string }) => entry.$ref)).toEqual([
      "./node_modules/@jxsuite/schema/schemas/project.core.schema.json",
      "./node_modules/@jxsuite/parser/schemas/project.fragment.schema.json",
      "./local-ext/project.fragment.schema.json",
    ]);
    expect(project.unevaluatedProperties).toBe(false);

    const document = readJson("document.schema.json");
    expect(document.$ref).toBe("./node_modules/@jxsuite/schema/schema.json");
    // Parser's fragment contributes its canonical paths shape; the $id-less local fragment none.
    expect(document.$defs.PathsValue.anyOf).toEqual([
      { $ref: "https://jxsuite.com/schema/ext/parser/document/v1#/$defs/ContentPathsSource" },
    ]);
  });

  it("skips unreadable and $defs-less document fragments", async () => {
    // Point the local manifest at a missing document fragment (resolvePath does not stat).
    writeFile("local-ext/jx-extension.json", {
      classes: {},
      name: "local-schema-ext",
      schemas: { document: "./missing.fragment.schema.json" },
    });
    await writeProjectSchemas(TMP);
    let document = readJson("document.schema.json");
    expect(document.$defs.PathsValue.anyOf).toEqual([
      { $ref: "https://jxsuite.com/schema/ext/parser/document/v1#/$defs/ContentPathsSource" },
    ]);

    // An $id-bearing fragment without $defs contributes nothing either.
    writeFile("local-ext/jx-extension.json", {
      classes: {},
      name: "local-schema-ext",
      schemas: { document: "./iddefs.fragment.schema.json" },
    });
    writeFile("local-ext/iddefs.fragment.schema.json", {
      $id: "https://test.invalid/local-ext/document/v1",
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });
    await writeProjectSchemas(TMP);
    document = readJson("document.schema.json");
    expect(document.$defs.PathsValue.anyOf).toEqual([
      { $ref: "https://jxsuite.com/schema/ext/parser/document/v1#/$defs/ContentPathsSource" },
    ]);
  });
});
