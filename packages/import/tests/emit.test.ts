import { describe, test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { emitProject } from "../src/emit.ts";

describe("emitProject", () => {
  test("writes project.json and pages/index.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-test-"));

    try {
      const document = {
        tagName: "div" as const,
        children: [
          { tagName: "h1" as const, textContent: "Hello" },
          { tagName: "p" as const, textContent: "World" },
        ],
      };

      const { files } = await emitProject({
        outDir: dir,
        title: "Test Site",
        document,
        sourceUrl: "https://example.com",
      });

      expect(files.length).toBeGreaterThanOrEqual(2);

      /*
       * Only keys the project schema declares. `title` and `description` used to be written here
       * and are page-level keys, so `jx validate` rejected every imported project (issue #228).
       */
      const project = await Bun.file(join(dir, "project.json")).json();
      expect(project.name).toBe("Test Site");
      expect(Object.keys(project)).toEqual(["name", "imports", "images"]);

      const page = await Bun.file(join(dir, "pages", "index.json")).json();
      expect(page.tagName).toBe("div");
      expect(page.children.length).toBe(2);
      expect(page.children[0].textContent).toBe("Hello");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("creates required directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-dirs-"));

    try {
      await emitProject({
        outDir: dir,
        title: "Dir Test",
        document: { tagName: "div" as const },
        sourceUrl: "https://example.com",
      });

      const { existsSync } = await import("node:fs");
      expect(existsSync(join(dir, "pages"))).toBe(true);
      expect(existsSync(join(dir, "layouts"))).toBe(true);
      expect(existsSync(join(dir, "components"))).toBe(true);
      expect(existsSync(join(dir, "public"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
