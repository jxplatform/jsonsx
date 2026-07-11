import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExtensionsPayload,
  buildProjectExtensionRegistry,
  buildProjectFormatRegistry,
  createNodeFormatIO,
  importImplementation,
  unknownFormatError,
} from "../src/site/format-host";

describe("unknownFormatError", () => {
  test("names the extensions-based fix", () => {
    const error = unknownFormatError("/site/pages/page.toml", ".toml");
    expect(error.message).toContain('No format class registered for ".toml"');
    expect(error.message).toContain('project.json "extensions"');
  });
});

describe("importImplementation", () => {
  test("falls back from a .js path to its .ts sibling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-import-impl-"));
    try {
      writeFileSync(join(dir, "mod.ts"), "export const hello = 42;\n");
      // Pass the .js path: the first candidate fails, the .ts sibling resolves.
      const mod = await importImplementation(join(dir, "mod.js"));
      expect(mod.hello).toBe(42);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("throws the last error when no candidate resolves", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
    await expect(importImplementation("/no/such/src/missing.js")).rejects.toThrow();
  });
});

describe("createNodeFormatIO", () => {
  test("resolvePath falls back to host resolution for projects without node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "jx-format-host-"));
    try {
      const io = createNodeFormatIO(root);
      const resolved = io.resolvePath(
        join(root, "project.json"),
        "@jxsuite/parser/Markdown.class.json",
      );
      expect(resolved.endsWith("Markdown.class.json")).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("buildProjectExtensionRegistry", () => {
  test("builds the registry for a project without node_modules (host fallback)", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-ext-reg-"));
    try {
      const registry = await buildProjectExtensionRegistry(root, {
        extensions: ["@jxsuite/parser"],
      });
      expect(registry.formats.byExtension(".md")?.name).toBe("Markdown");
      expect(registry.formats.byExtension(".csv")?.name).toBe("Csv");
      expect(registry.byProjectKey("content")?.name).toBe("Content");
      expect(registry.byPathsDiscriminator("contentType")?.name).toBe("Content");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("an empty extensions list yields an empty registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-ext-empty-"));
    try {
      const registry = await buildProjectExtensionRegistry(root, {});
      expect(registry.extensions).toHaveLength(0);
      expect(registry.formats.entries).toHaveLength(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("an unresolvable extension is an explicit error, not a silent skip", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-ext-broken-"));
    try {
      // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
      await expect(
        buildProjectExtensionRegistry(root, { extensions: ["@jxsuite/does-not-exist"] }),
      ).rejects.toThrow("is not resolvable");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("buildExtensionsPayload", () => {
  test("pairs each project contribution with its fragment entry schema (parser)", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-ext-payload-"));
    try {
      const registry = await buildProjectExtensionRegistry(root, {
        extensions: ["@jxsuite/parser"],
      });
      const payload = buildExtensionsPayload(registry);
      expect(payload).toHaveLength(1);
      const [parser] = payload;
      expect(parser!.specifier).toBe("@jxsuite/parser");
      expect(parser!.name).toBe("@jxsuite/parser");
      expect(parser!.title).toBe("Content & Markdown");
      // Additive classes list: every manifest class with its resolved descriptor path.
      const collection = parser!.classes.find((cls) => cls.name === "ContentCollection");
      expect(collection?.path.endsWith("ContentCollection.class.json")).toBe(true);
      expect(parser!.classes.length).toBeGreaterThanOrEqual(6);
      expect(parser!.contributions).toHaveLength(1);
      const [content] = parser!.contributions;
      expect(content!.className).toBe("Content");
      expect(content!.project).toMatchObject({ key: "content", title: "Content Types" });
      const studio = content!.studio as { settings: { layout: string; order: number } };
      expect(studio.settings.layout).toBe("map");
      expect(studio.settings.order).toBe(50);
      // The entry schema is properties.content of the shipped project fragment.
      const entrySchema = content!.entrySchema as {
        type: string;
        additionalProperties: { properties: Record<string, unknown> };
      };
      expect(entrySchema.type).toBe("object");
      expect(Object.keys(entrySchema.additionalProperties.properties)).toEqual([
        "$elements",
        "format",
        "schema",
        "source",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("degrades to a null entrySchema for unreadable or key-less fragments", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-ext-payload-degrade-"));
    try {
      mkdirSync(join(root, "local-ext"), { recursive: true });
      writeFileSync(
        join(root, "local-ext", "jx-extension.json"),
        JSON.stringify({
          classes: { Guestbook: "./Guestbook.class.json" },
          name: "local-guestbook",
          schemas: { project: "./missing.fragment.schema.json" },
        }),
        "utf8",
      );
      writeFileSync(
        join(root, "local-ext", "Guestbook.class.json"),
        JSON.stringify({
          project: { key: "guestbook" },
          title: "Guestbook",
        }),
        "utf8",
      );
      const registry = await buildProjectExtensionRegistry(root, { extensions: ["./local-ext"] });
      const payload = buildExtensionsPayload(registry);
      expect(payload).toHaveLength(1);
      expect(payload[0]!.title).toBeUndefined();
      expect(payload[0]!.contributions).toEqual([
        {
          className: "Guestbook",
          entrySchema: null,
          project: { key: "guestbook" },
          studio: null,
        },
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("flags plain state classes and forwards their stateDefaults hint", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-ext-payload-state-"));
    try {
      const registry = await buildProjectExtensionRegistry(root, {
        extensions: ["@jxsuite/connector"],
      });
      const [connector] = buildExtensionsPayload(registry);
      const byName = new Map(connector!.classes.map((cls) => [cls.name, cls]));

      // Plain $prototype targets: state + the descriptor's stateDefaults (specs §10).
      expect(byName.get("TableQuery")).toMatchObject({
        state: true,
        stateDefaults: { timing: "client" },
      });
      // Admission-block classes are not state prototypes.
      expect(byName.get("Data")!.state).toBeUndefined();
      expect(byName.get("Sqlite")!.state).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("classes without a project block contribute nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-ext-payload-formats-"));
    try {
      const registry = await buildProjectExtensionRegistry(root, {
        extensions: ["@jxsuite/parser"],
      });
      const [parser] = buildExtensionsPayload(registry);
      const names = parser!.contributions.map((c) => c.className);
      expect(names).not.toContain("Markdown");
      expect(names).not.toContain("Csv");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("buildProjectFormatRegistry (deprecated formats view)", () => {
  test("returns the extension registry's format-dispatch view", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-format-view-"));
    try {
      const registry = await buildProjectFormatRegistry(root, {
        extensions: ["@jxsuite/parser"],
      });
      expect(registry.byExtension(".md")?.name).toBe("Markdown");
      expect(registry.byName("Content")).toBeUndefined(); // No format block → not in the view
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
