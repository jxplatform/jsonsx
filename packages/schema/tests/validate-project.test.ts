/**
 * Validate-project suite: builds a tempdir project with a mini node_modules containing copies of
 * the REAL core fragment and parser project fragment, generates the entry document via
 * emitProjectSchema, and drives validateProjectFile end-to-end — valid project, unknown-key
 * rejection, unresolvable refs, path-escape rejection, and the host-resolution fallback for
 * projects without their own node_modules (in-repo starters).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitProjectSchema } from "../src/project-schemas";
import { validateProjectFile } from "../src/validate-project";

const CORE_FRAGMENT_SRC = resolve(import.meta.dir, "../schemas/project.core.schema.json");
const PARSER_FRAGMENT_SRC = resolve(
  import.meta.dir,
  "../../parser/schemas/project.fragment.schema.json",
);

const CORE_REF = "./node_modules/@jxsuite/schema/schemas/project.core.schema.json";
const PARSER_REF = "./node_modules/@jxsuite/parser/schemas/project.fragment.schema.json";

const ROOTS: string[] = [];

function makeProject(opts: {
  nodeModules?: boolean;
  fragments?: string[];
  project?: Record<string, unknown>;
}): string {
  const { nodeModules = true, fragments = [PARSER_REF], project = validProject() } = opts;
  const root = resolve(tmpdir(), `jx-validate-project-${Date.now()}-${ROOTS.length}`);
  ROOTS.push(root);
  mkdirSync(root, { recursive: true });

  if (nodeModules) {
    const schemaDir = join(root, "node_modules/@jxsuite/schema/schemas");
    const parserDir = join(root, "node_modules/@jxsuite/parser/schemas");
    mkdirSync(schemaDir, { recursive: true });
    mkdirSync(parserDir, { recursive: true });
    cpSync(CORE_FRAGMENT_SRC, join(schemaDir, "project.core.schema.json"));
    cpSync(PARSER_FRAGMENT_SRC, join(parserDir, "project.fragment.schema.json"));
  }

  const entry = emitProjectSchema({ corePath: CORE_REF, fragments });
  writeFileSync(join(root, "project.schema.json"), `${JSON.stringify(entry, null, 2)}\n`);
  writeFileSync(join(root, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
  return root;
}

function validProject(): Record<string, unknown> {
  return {
    $schema: "./project.schema.json",
    content: {
      posts: {
        format: "Markdown",
        schema: {
          properties: {
            author: { $ref: "#/content/authors" },
            date: { format: "date", type: "string" },
            title: { type: "string" },
          },
          required: ["title"],
          type: "object",
        },
        source: "./content/posts/",
      },
    },
    extensions: ["@jxsuite/parser"],
    name: "Validate Me",
    url: "https://example.com",
  };
}

afterAll(() => {
  for (const root of ROOTS) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("validateProjectFile", () => {
  test("a valid project validates against its generated entry document", async () => {
    const root = makeProject({});
    const result = await validateProjectFile(root);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeNull();
  });

  test("unknown top-level keys are rejected with unevaluatedProperties errors", async () => {
    const root = makeProject({
      project: { ...validProject(), contentTypez: {} },
    });
    const result = await validateProjectFile(root);
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.errors)).toContain("unevaluatedProperties");
  });

  test("falls back to host resolution when the project has no node_modules", async () => {
    const root = makeProject({ nodeModules: false });
    const result = await validateProjectFile(root);
    expect(result.valid).toBe(true);
  });

  test("an unresolvable node_modules ref throws (project and host both miss)", async () => {
    const root = makeProject({
      fragments: ["./node_modules/@jx-nope/missing/project.fragment.schema.json"],
    });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(validateProjectFile(root)).rejects.toThrow("is not resolvable");
  });

  test("a ref outside node_modules that does not exist throws", async () => {
    const root = makeProject({ fragments: ["./missing-local.fragment.schema.json"] });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(validateProjectFile(root)).rejects.toThrow("does not exist");
  });

  test("refs escaping the project root are rejected", async () => {
    const root = makeProject({ fragments: ["../escape.fragment.schema.json"] });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(validateProjectFile(root)).rejects.toThrow("escapes the project root");
  });

  test("non-file ref schemes are refused by the restricted loader", async () => {
    const root = makeProject({ fragments: ["https://fragments.invalid/x.schema.json"] });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(validateProjectFile(root)).rejects.toThrow(
      "only project-relative file refs are loadable",
    );
  });

  test("a missing project.schema.json names the jx schema fix", async () => {
    const root = resolve(tmpdir(), `jx-validate-project-noschema-${Date.now()}`);
    ROOTS.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "project.json"), "{}\n");
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(validateProjectFile(root)).rejects.toThrow("run `jx schema`");
  });

  test("a missing project.json throws", async () => {
    const root = resolve(tmpdir(), `jx-validate-project-empty-${Date.now()}`);
    ROOTS.push(root);
    mkdirSync(root, { recursive: true });
    // oxlint-disable-next-line typescript/await-thenable -- Bun types `.rejects.toThrow` as void, but it resolves a Promise at runtime; the await is required.
    await expect(validateProjectFile(root)).rejects.toThrow("project.json not found");
  });
});
