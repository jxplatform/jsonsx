import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
