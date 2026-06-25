import { describe, test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { emitMultiPageProject } from "../src/emit.ts";

describe("emitMultiPageProject", () => {
  test("writes multiple pages to correct paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-multi-"));

    try {
      const pages = new Map([
        ["pages/index.json", { tagName: "div" as const, textContent: "Home" }],
        ["pages/about.json", { tagName: "div" as const, textContent: "About" }],
        ["pages/blog/post-1.json", { tagName: "div" as const, textContent: "Post 1" }],
      ]);

      const { files } = await emitMultiPageProject({
        outDir: dir,
        title: "Multi Page Test",
        sourceUrl: "https://example.com",
        pages,
      });

      // Project.json + 3 pages + layout = 5
      expect(files.length).toBe(5);

      const project = await Bun.file(join(dir, "project.json")).json();
      expect(project.title).toBe("Multi Page Test");

      const index = await Bun.file(join(dir, "pages", "index.json")).json();
      expect(index.textContent).toBe("Home");

      const about = await Bun.file(join(dir, "pages", "about.json")).json();
      expect(about.textContent).toBe("About");

      const post = await Bun.file(join(dir, "pages", "blog", "post-1.json")).json();
      expect(post.textContent).toBe("Post 1");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("writes custom layout when provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-layout-"));

    try {
      const layout = {
        tagName: "div" as const,
        children: [
          { tagName: "nav" as const, textContent: "Header" },
          { tagName: "slot" as const, attributes: { name: "content" } },
          { tagName: "footer" as const, textContent: "Footer" },
        ],
      };

      await emitMultiPageProject({
        outDir: dir,
        title: "Layout Test",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", { tagName: "div" as const }]]),
        layout,
      });

      const layoutFile = await Bun.file(join(dir, "layouts", "base.json")).json();
      expect(layoutFile.children.length).toBe(3);
      expect(layoutFile.children[0].tagName).toBe("nav");
      expect(layoutFile.children[1].tagName).toBe("slot");
      expect(layoutFile.children[2].tagName).toBe("footer");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("writes breakpoints into project.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-bp-"));

    try {
      await emitMultiPageProject({
        outDir: dir,
        title: "BP Test",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", { tagName: "div" as const }]]),
        breakpoints: { "@768": "min-width: 768px", "@1024": "min-width: 1024px" },
      });

      const project = await Bun.file(join(dir, "project.json")).json();
      expect(project.$media).toEqual({
        "@768": "min-width: 768px",
        "@1024": "min-width: 1024px",
      });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("creates nested page directories automatically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-nested-"));

    try {
      await emitMultiPageProject({
        outDir: dir,
        title: "Nested",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/docs/api/reference.json", { tagName: "div" as const }]]),
      });

      expect(existsSync(join(dir, "pages", "docs", "api", "reference.json"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
