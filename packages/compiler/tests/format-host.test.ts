import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectFormatRegistry, createNodeFormatIO } from "../src/site/format-host";

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
