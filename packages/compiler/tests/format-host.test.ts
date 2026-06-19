import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProjectFormatRegistry,
  createNodeFormatIO,
  importImplementation,
} from "../src/site/format-host";

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

describe("buildProjectFormatRegistry", () => {
  test("builds the registry for a project without node_modules", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-format-reg-"));
    try {
      const registry = await buildProjectFormatRegistry(root, {
        imports: {
          Csv: "@jxsuite/parser/Csv.class.json",
          Markdown: "@jxsuite/parser/Markdown.class.json",
        },
      } as never);
      expect(registry.byExtension(".md")?.name).toBe("Markdown");
      expect(registry.byExtension(".csv")?.name).toBe("Csv");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("skips unresolvable imports instead of failing the whole registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "jx-format-skip-"));
    try {
      const registry = await buildProjectFormatRegistry(root, {
        imports: {
          Broken: "@jxsuite/does-not-exist/Broken.class.json",
          Markdown: "@jxsuite/parser/Markdown.class.json",
        },
      } as never);
      expect(registry.byExtension(".md")?.name).toBe("Markdown");
      expect(registry.byName("Broken")).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
