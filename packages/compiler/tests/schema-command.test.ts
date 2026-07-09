/**
 * Schema-command.test.ts — `jx schema` entry-document emission
 *
 * Verifies the project-relative ref computation: bare-specifier packages that resolve through the
 * workspace (outside the fixture root) fall back to conventional ./node_modules paths, local
 * extensions keep in-project relative paths, and document fragments contribute canonical
 * "$id#/$defs/*" paths refs (skipping fragments without $id/$defs or unreadable ones).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED_SCHEMA_COMMENT } from "@jxsuite/schema/project-schemas";
import { readBundledProjectSchemas, writeProjectSchemas } from "../src/site/schema-command";

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

describe("readBundledProjectSchemas", () => {
  const PARSER_FRAGMENT_ID = "https://jxsuite.com/schema/ext/parser/project/v1";

  beforeAll(() => {
    // Restore the local extension's full schema declaration (earlier tests rewrote the manifest).
    writeFile("local-ext/jx-extension.json", {
      classes: {},
      name: "local-schema-ext",
      schemas: {
        document: "./document.fragment.schema.json",
        project: "./project.fragment.schema.json",
      },
    });
    rmSync(resolve(TMP, "project.schema.json"), { force: true });
    rmSync(resolve(TMP, "document.schema.json"), { force: true });
  });

  it("regenerates missing entry documents and returns self-contained bundles", async () => {
    expect(existsSync(resolve(TMP, "project.schema.json"))).toBe(false);
    const { project, document } = await readBundledProjectSchemas(TMP);
    expect(existsSync(resolve(TMP, "project.schema.json"))).toBe(true);
    expect(existsSync(resolve(TMP, "document.schema.json"))).toBe(true);

    // Every relative ref is gone — the bundles resolve without any file access.
    const scanRefs = (node: unknown, out: string[] = []): string[] => {
      if (Array.isArray(node)) {
        for (const item of node) {
          scanRefs(item, out);
        }
      } else if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (typeof obj.$ref === "string") {
          out.push(obj.$ref);
        }
        for (const value of Object.values(obj)) {
          scanRefs(value, out);
        }
      }
      return out;
    };
    for (const ref of [...scanRefs(project), ...scanRefs(document)]) {
      expect(ref.startsWith("./")).toBe(false);
    }

    // The parser fragment (host-fallback: TMP has no node_modules) and the local fragment embed
    // Under $defs keyed by their canonical $ids; the entry allOf refs land on them.
    const projectDefs = project.$defs as Record<string, Record<string, unknown>>;
    expect(projectDefs[PARSER_FRAGMENT_ID]!.$id).toBe(PARSER_FRAGMENT_ID);
    expect(projectDefs["https://test.invalid/local-ext/project/v1"]).toBeDefined();
    const allOf = project.allOf as { $ref: string }[];
    expect(allOf.map((entry) => entry.$ref)).toEqual([
      "https://jxsuite.com/schema/project/core/v2",
      PARSER_FRAGMENT_ID,
      "https://test.invalid/local-ext/project/v1",
    ]);

    // The document bundle inlines the core document schema under its canonical $id.
    expect(document.$ref).toBe("https://jxsuite.com/schema/v1");
    const documentDefs = document.$defs as Record<string, Record<string, unknown>>;
    expect(documentDefs["https://jxsuite.com/schema/v1"]).toBeDefined();
  });

  it("reuses fresh entry documents but regenerates stale ones", async () => {
    const projectSchemaPath = resolve(TMP, "project.schema.json");
    // Fresh: a marker survives the read (no regeneration).
    const marked = { ...readJson("project.schema.json"), $comment: "marker — not regenerated" };
    writeFileSync(projectSchemaPath, JSON.stringify(marked, null, 2), "utf8");
    const fresh = await readBundledProjectSchemas(TMP);
    expect(fresh.project.$comment).toBe("marker — not regenerated");

    // Stale: project.json is newer than the entry document → regenerated marker is gone.
    const past = new Date(Date.now() - 60_000);
    utimesSync(projectSchemaPath, past, past);
    const rebundled = await readBundledProjectSchemas(TMP);
    expect(rebundled.project.$comment).toBe(GENERATED_SCHEMA_COMMENT);
  });

  it("rejects refs escaping the project root", async () => {
    const projectSchemaPath = resolve(TMP, "project.schema.json");
    const hijacked = {
      ...readJson("project.schema.json"),
      allOf: [{ $ref: "../../../etc/passwd.json" }],
    };
    writeFileSync(projectSchemaPath, JSON.stringify(hijacked, null, 2), "utf8");
    // Keep it "fresh" so the traversal ref is actually bundled rather than regenerated away.
    const future = new Date(Date.now() + 60_000);
    utimesSync(projectSchemaPath, future, future);
    // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
    await expect(readBundledProjectSchemas(TMP)).rejects.toThrow("escapes the project root");
    rmSync(projectSchemaPath, { force: true });
  });

  it("errors on unresolvable non-node_modules refs", async () => {
    await readBundledProjectSchemas(TMP);
    const projectSchemaPath = resolve(TMP, "project.schema.json");
    const broken = {
      ...readJson("project.schema.json"),
      allOf: [{ $ref: "./nope/missing.schema.json" }],
    };
    writeFileSync(projectSchemaPath, JSON.stringify(broken, null, 2), "utf8");
    const future = new Date(Date.now() + 60_000);
    utimesSync(projectSchemaPath, future, future);
    // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
    await expect(readBundledProjectSchemas(TMP)).rejects.toThrow("does not exist");
    rmSync(projectSchemaPath, { force: true });
  });
});
