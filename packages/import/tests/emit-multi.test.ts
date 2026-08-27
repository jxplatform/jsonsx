import { describe, test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { JxElement } from "@jxsuite/schema/types";
import type { ComponentizeResult } from "../src/componentize.ts";
import { emitMultiPageProject } from "../src/emit.ts";

function makePrecomputed(): ComponentizeResult {
  const template: JxElement = {
    tagName: "div",
    children: [
      "${state.caption}",
      "plain text",
      { tagName: "h3", textContent: "${state.title}" },
      {
        tagName: "a",
        attributes: { href: "${state.href}", "data-count": 5, target: "_blank" },
        children: [{ tagName: "span", textContent: "${state.title}" }] as JxElement[],
      },
    ] as JxElement[],
  };

  const staticTemplate: JxElement = {
    tagName: "footer",
    textContent: "All rights reserved",
  };

  return {
    components: new Map([
      ["hero-card.json", { $id: "HeroCard", tagName: "hero-card", template, instanceCount: 2 }],
      [
        "site-footer.json",
        { $id: "SiteFooter", tagName: "site-footer", template: staticTemplate, instanceCount: 2 },
      ],
    ]),
    rewrittenPages: new Map<string, JxElement>([
      [
        "pages/index.json",
        {
          tagName: "div",
          $elements: [{ tagName: "aside" }] as JxElement[],
          children: [
            { tagName: "hero-card", $props: { title: "A", href: "/a", caption: "one" } },
          ] as JxElement[],
        },
      ],
      [
        "pages/about.json",
        {
          tagName: "div",
          children: [{ tagName: "site-footer" }] as JxElement[],
        },
      ],
    ]),
  };
}

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
      expect(project.name).toBe("Multi Page Test");

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

  test("writes style tokens into project.json.style", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-tokens-"));

    try {
      await emitMultiPageProject({
        outDir: dir,
        title: "Token Test",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", { tagName: "div" as const }]]),
        styleTokens: { "--brand": "#3b82f6", "--space-4": "16px" },
      });

      const project = await Bun.file(join(dir, "project.json")).json();
      expect(project.style).toEqual({ "--brand": "#3b82f6", "--space-4": "16px" });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("emits fonts.css and links it in project $head", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-fonts-"));

    try {
      const { files } = await emitMultiPageProject({
        outDir: dir,
        title: "Font Test",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", { tagName: "div" as const }]]),
        fontFaceRules: [
          '@font-face { font-family: "A"; src: url(https://cdn.example.com/a.woff2); }',
          '@font-face { font-family: "B"; src: url(https://cdn.example.com/b.woff2); }',
        ],
      });

      const fontsCssPath = join(dir, "public", "assets", "fonts.css");
      expect(files).toContain(fontsCssPath);
      const css = await Bun.file(fontsCssPath).text();
      expect(css).toContain('font-family: "A"');
      expect(css).toContain('font-family: "B"');

      const project = await Bun.file(join(dir, "project.json")).json();
      expect(project.$head).toEqual([
        {
          tagName: "link",
          attributes: { rel: "stylesheet", href: "/assets/fonts.css" },
        },
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("rewrites font URLs to local paths in fonts.css", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-fontmap-"));

    try {
      await emitMultiPageProject({
        outDir: dir,
        title: "Font Rewrite Test",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", { tagName: "div" as const }]]),
        fontFaceRules: [
          "@font-face { src: url(https://cdn.example.com/a.woff2); }",
          "@font-face { src: url(https://cdn.example.com/b.woff2); }",
        ],
        fontRewriteMap: new Map([
          ["https://cdn.example.com/a.woff2", "/assets/fonts/a.woff2"],
          ["https://cdn.example.com/b.woff2", "assets/fonts/b.woff2"],
        ]),
      });

      const css = await Bun.file(join(dir, "public", "assets", "fonts.css")).text();
      expect(css).toContain("url(/assets/fonts/a.woff2)");
      expect(css).toContain("url(/assets/fonts/b.woff2)");
      expect(css).not.toContain("cdn.example.com");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("skips componentization when componentizeOptions is false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-nocomp-"));

    try {
      const card = (title: string): JxElement => ({
        tagName: "div",
        children: [
          { tagName: "h3", textContent: title },
          { tagName: "p", textContent: "desc" },
        ] as JxElement[],
      });

      await emitMultiPageProject({
        outDir: dir,
        title: "No Comp",
        sourceUrl: "https://example.com",
        pages: new Map<string, JxElement>([
          ["pages/index.json", { tagName: "div", children: [card("A"), card("B")] as JxElement[] }],
        ]),
        componentizeOptions: false,
      });

      const page = await Bun.file(join(dir, "pages", "index.json")).json();
      expect(page.$elements).toBeUndefined();
      expect(page.children[0].tagName).toBe("div");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("writes precomputed components with extracted state defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-precomp-"));

    try {
      const { files } = await emitMultiPageProject({
        outDir: dir,
        title: "Precomputed",
        sourceUrl: "https://example.com",
        pages: new Map<string, JxElement>([["pages/index.json", { tagName: "div" }]]),
        precomputedComponents: makePrecomputed(),
      });

      const heroPath = join(dir, "components", "hero-card.json");
      const footerPath = join(dir, "components", "site-footer.json");
      expect(files).toContain(heroPath);
      expect(files).toContain(footerPath);

      const hero = await Bun.file(heroPath).json();
      expect(hero.$id).toBe("HeroCard");
      expect(hero.tagName).toBe("hero-card");
      expect(hero.state).toEqual({ caption: "", title: "", href: "" });

      const footer = await Bun.file(footerPath).json();
      expect(footer.state).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("registers component refs in pages and a provided layout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-refs-"));

    try {
      await emitMultiPageProject({
        outDir: dir,
        title: "Refs",
        sourceUrl: "https://example.com",
        pages: new Map<string, JxElement>([["pages/index.json", { tagName: "div" }]]),
        precomputedComponents: makePrecomputed(),
        layout: {
          tagName: "main",
          children: [{ tagName: "slot" }] as JxElement[],
        },
      });

      const refs = [
        { $ref: "../components/hero-card.json" },
        { $ref: "../components/site-footer.json" },
      ];

      const index = await Bun.file(join(dir, "pages", "index.json")).json();
      expect(index.$elements).toEqual([...refs, { tagName: "aside" }]);

      const about = await Bun.file(join(dir, "pages", "about.json")).json();
      expect(about.$elements).toEqual(refs);

      const layout = await Bun.file(join(dir, "layouts", "base.json")).json();
      expect(layout.tagName).toBe("main");
      expect(layout.$elements).toEqual(refs);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
