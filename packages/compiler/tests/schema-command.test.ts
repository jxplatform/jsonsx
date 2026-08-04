/**
 * Schema-command.test.ts — `jx schema` entry-document emission
 *
 * Verifies the project-relative ref computation and the shape of the committed output:
 * bare-specifier packages that resolve through the workspace (outside the fixture root) fall back
 * to conventional ./node_modules paths, local extensions keep in-project relative paths, document
 * fragments contribute their $defs to the paths union (skipping fragments without $id/$defs or
 * unreadable ones), and every ref in the written files is a root-relative pointer into an embed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GENERATED_SCHEMA_COMMENT } from "@jxsuite/schema/project-schemas";
import {
  isFirstPartySchema,
  readBundledProjectSchemas,
  writeProjectSchemas,
} from "../src/site/schema-command";

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

interface SchemaDoc {
  $comment?: string;
  $ref?: string;
  allOf?: { $ref: string }[];
  $defs?: Record<string, Record<string, unknown>>;
  unevaluatedProperties?: boolean;
  [key: string]: unknown;
}

function readJson(relPath: string): SchemaDoc {
  return JSON.parse(readFileSync(resolve(TMP, relPath), "utf8")) as SchemaDoc;
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
  it("emits both entry documents as self-contained bundles", async () => {
    const { projectSchemaPath, documentSchemaPath } = await writeProjectSchemas(TMP);
    expect(projectSchemaPath).toBe(resolve(TMP, "project.schema.json"));
    expect(documentSchemaPath).toBe(resolve(TMP, "document.schema.json"));

    const project = readJson("project.schema.json");
    expect(project.$comment).toBe(GENERATED_SCHEMA_COMMENT);
    /* The committed form is bundled AND flattened into one resource: every fragment ref is a
       root-relative pointer into the embed under $defs — no ./node_modules or in-project relative
       refs, and no canonical URIs an editor would try to fetch. */
    expect(project.allOf!.map((entry) => entry.$ref)).toEqual([
      "#/$defs/project-core-v2",
      "#/$defs/ext-parser-project-v1",
      "#/$defs/local-ext-project-v1",
    ]);
    expect(project.$defs!["project-core-v2"]).toBeDefined();
    expect(project.$defs!["local-ext-project-v1"]).toBeDefined();
    expect(project.$defs!["project-core-v2"]!.$id).toBeUndefined();
    expect(project.unevaluatedProperties).toBe(false);

    const document = readJson("document.schema.json");
    // A root $ref beside $defs would make VS Code merge the core's $defs over the entry's own.
    expect(document.$ref).toBeUndefined();
    expect(document.allOf!.map((entry) => entry.$ref)).toEqual(["#/$defs/v1"]);
    expect(document.$defs!.v1).toBeDefined();
    /* Parser's fragment contributes its paths shape; the $id-less local fragment none. The union
       also restates the core source shapes — it shadows the shipped default rather than extending
       it — so assert on the contributed tail. */
    const pathsMembers = document.$defs!.PathsValue!.anyOf as Record<string, unknown>[];
    expect(pathsMembers.at(-1)).toEqual({
      $ref: "#/$defs/ext-parser-document-v1/$defs/ContentPathsSource",
    });
    expect(pathsMembers.length).toBeGreaterThan(1);
    // And the shape it names is embedded, so the union actually resolves.
    expect(
      (document.$defs!["ext-parser-document-v1"]!.$defs as Record<string, unknown>)
        .ContentPathsSource,
    ).toBeDefined();
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
    const contributed = (defs: SchemaDoc) =>
      (defs.$defs!.PathsValue!.anyOf as Record<string, unknown>[]).filter((m) => "$ref" in m);
    expect(contributed(document)).toEqual([
      { $ref: "#/$defs/ext-parser-document-v1/$defs/ContentPathsSource" },
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
    expect(contributed(document)).toEqual([
      { $ref: "#/$defs/ext-parser-document-v1/$defs/ContentPathsSource" },
    ]);
  });

  it("falls back to host resolution for core refs outside the workspace", async () => {
    // A project root outside the monorepo: project-first resolution fails (the empty node_modules
    // Disables Bun's install-cache fallback), so the intermediate refs land on the conventional
    // ./node_modules form — and the bundler's host fallback then embeds the real resources, so
    // The committed files still carry only root pointers.
    const root = mkdtempSync(resolve(tmpdir(), "jx-schema-command-"));
    try {
      mkdirSync(resolve(root, "node_modules"));
      writeFileSync(
        resolve(root, "project.json"),
        JSON.stringify({ name: "Host Fallback Fixture" }, null, 2),
        "utf8",
      );

      await writeProjectSchemas(root);

      const project = JSON.parse(
        readFileSync(resolve(root, "project.schema.json"), "utf8"),
      ) as SchemaDoc;
      expect(project.allOf!.map((entry) => entry.$ref)).toEqual(["#/$defs/project-core-v2"]);
      expect(project.$defs!["project-core-v2"]).toBeDefined();
      const document = JSON.parse(
        readFileSync(resolve(root, "document.schema.json"), "utf8"),
      ) as SchemaDoc;
      expect(document.allOf!.map((entry) => entry.$ref)).toEqual(["#/$defs/v1"]);
      expect(document.$defs!.v1).toBeDefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("readBundledProjectSchemas", () => {
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
    /* Not merely relative-ref-free: every ref is a root pointer. A canonical URI would send an
       editor to the network instead of the embed sitting right there in the document. */
    for (const ref of [...scanRefs(project), ...scanRefs(document)]) {
      expect(ref.startsWith("#/")).toBe(true);
    }

    // The parser fragment (host-fallback: TMP has no node_modules) and the local fragment embed
    // Under $defs keyed by slugs of their $ids; the entry allOf refs point at them.
    const projectDefs = project.$defs as Record<string, Record<string, unknown>>;
    expect(projectDefs["ext-parser-project-v1"]).toBeDefined();
    expect(projectDefs["ext-parser-project-v1"]!.$id).toBeUndefined();
    expect(projectDefs["local-ext-project-v1"]).toBeDefined();
    const allOf = project.allOf as { $ref: string }[];
    expect(allOf.map((entry) => entry.$ref)).toEqual([
      "#/$defs/project-core-v2",
      "#/$defs/ext-parser-project-v1",
      "#/$defs/local-ext-project-v1",
    ]);

    // The document bundle inlines the core document schema, reached through allOf (never a root $ref).
    expect(document.$ref).toBeUndefined();
    expect((document.allOf as { $ref: string }[]).map((entry) => entry.$ref)).toEqual([
      "#/$defs/v1",
    ]);
    const documentDefs = document.$defs as Record<string, Record<string, unknown>>;
    expect(documentDefs.v1).toBeDefined();
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

  it("errors on node_modules refs resolvable neither project-first nor from the host", async () => {
    await readBundledProjectSchemas(TMP);
    const projectSchemaPath = resolve(TMP, "project.schema.json");
    const hijacked = {
      ...readJson("project.schema.json"),
      allOf: [{ $ref: "./node_modules/@nonexistent-scope/pkg/x.schema.json" }],
    };
    writeFileSync(projectSchemaPath, JSON.stringify(hijacked, null, 2), "utf8");
    const future = new Date(Date.now() + 60_000);
    utimesSync(projectSchemaPath, future, future);
    // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
    await expect(readBundledProjectSchemas(TMP)).rejects.toThrow(
      "not resolvable from the project or the host",
    );
    rmSync(projectSchemaPath, { force: true });
  });

  it("returns existing entry documents when project.json is missing", async () => {
    // Regenerate fresh entry documents, then mark the project one so a regeneration would show.
    await readBundledProjectSchemas(TMP);
    const projectSchemaPath = resolve(TMP, "project.schema.json");
    const marked = { ...readJson("project.schema.json"), $comment: "kept without project.json" };
    writeFileSync(projectSchemaPath, JSON.stringify(marked, null, 2), "utf8");

    const projectJsonPath = resolve(TMP, "project.json");
    const savedProjectJson = readFileSync(projectJsonPath, "utf8");
    rmSync(projectJsonPath);
    try {
      // Staleness cannot be determined (project.json is gone) → the docs are reused as-is; a
      // Regeneration attempt would throw from loadProjectConfig instead.
      const { project } = await readBundledProjectSchemas(TMP);
      expect(project.$comment).toBe("kept without project.json");
    } finally {
      writeFileSync(projectJsonPath, savedProjectJson, "utf8");
    }
  });
});

// ─── The shadow-core regression ──────────────────────────────────────────────

describe("a project-local @jxsuite core never answers for the host's", () => {
  /**
   * A stray `bun install` inside a starter leaves a gitignored `node_modules` holding a PUBLISHED
   * `@jxsuite/schema`. Both the `existsSync` shortcut and the project-first `createRequire` used to
   * resolve to it, so the generator emitted a document schema built from whatever core that install
   * happened to pin — on one machine, silently, for six weeks. The emitted schema was not merely
   * older: it dropped `ChildrenValue`'s computed-children branch, which made the starter's own
   * pages invalid against its own committed schema.
   */
  it("reads the host core even when the project ships its own, and never widens on it", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "jx-shadow-core-"));
    try {
      writeFileSync(
        resolve(root, "package.json"),
        JSON.stringify({ name: "shadowed", version: "0.0.0" }),
      );
      writeFileSync(
        resolve(root, "project.json"),
        JSON.stringify({ $schema: "./project.schema.json", name: "shadowed" }),
      );

      const clean = await writeProjectSchemas(root);
      const withoutShadow = readFileSync(clean.documentSchemaPath, "utf8");

      // Now plant a hostile core: a syntactically valid schema that defines almost nothing. If the
      // Loader ever prefers it, the emitted document schema collapses and this test sees it.
      const shadowDir = resolve(root, "node_modules/@jxsuite/schema");
      mkdirSync(shadowDir, { recursive: true });
      writeFileSync(
        resolve(shadowDir, "package.json"),
        JSON.stringify({ name: "@jxsuite/schema", version: "0.0.1", exports: { "./*": "./*" } }),
      );
      writeFileSync(
        resolve(shadowDir, "schema.json"),
        JSON.stringify({ $defs: {}, $id: "https://jxsuite.dev/impostor.json" }),
      );

      const shadowed = await writeProjectSchemas(root);
      const withShadow = readFileSync(shadowed.documentSchemaPath, "utf8");

      expect(withShadow).toBe(withoutShadow);
      expect(withShadow).not.toContain("impostor");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("classifies first-party specifiers, and leaves project fragments alone", () => {
    expect(isFirstPartySchema("@jxsuite/schema/schema.json")).toBe(true);
    expect(isFirstPartySchema("@jxsuite/parser/fragment.schema.json")).toBe(true);
    // A project's own fragments still resolve project-first — that is what the loader is FOR.
    expect(isFirstPartySchema("my-extension/thing.schema.json")).toBe(false);
    expect(isFirstPartySchema("@other/schema.json")).toBe(false);
    // Not a schema file at all.
    expect(isFirstPartySchema("@jxsuite/schema/index.js")).toBe(false);
  });
});

describe("a validator does not edit what it is checking", () => {
  it("regenerates a stale entry document in memory and leaves the committed bytes alone", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "jx-readonly-validate-"));
    try {
      writeFileSync(
        resolve(root, "package.json"),
        JSON.stringify({ name: "readonly", version: "0.0.0" }),
      );
      const projectJson = resolve(root, "project.json");
      writeFileSync(
        projectJson,
        JSON.stringify({ $schema: "./project.schema.json", name: "readonly" }),
      );
      const { documentSchemaPath } = await writeProjectSchemas(root);

      // A recognisable marker, then make project.json newer so the staleness check fires.
      writeFileSync(documentSchemaPath, JSON.stringify({ marker: "committed-bytes" }), "utf8");
      const future = Date.now() / 1000 + 60;
      utimesSync(projectJson, future, future);

      const readOnly = await readBundledProjectSchemas(root, { write: false });
      // It returned a real composed schema, not the marker…
      expect(readOnly.document).not.toHaveProperty("marker");
      expect(Object.keys(readOnly.document).length).toBeGreaterThan(1);
      // …and the file on disk is untouched.
      expect(JSON.parse(readFileSync(documentSchemaPath, "utf8"))).toEqual({
        marker: "committed-bytes",
      });

      // The default is still to write, because the studio's live PAL path wants fresh bytes.
      await readBundledProjectSchemas(root);
      expect(JSON.parse(readFileSync(documentSchemaPath, "utf8"))).not.toHaveProperty("marker");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
