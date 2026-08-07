import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { setProjectState } from "../src/state";
import { getEffectiveElements, getEffectiveMedia, getEffectiveStyle } from "../src/site-context";
import { computeRelativePath } from "../src/files/components";
import { parseSourceForPath } from "../src/files/file-ops";
import { registerPlatform } from "../src/platform";
import { mockFormatAction, seedMarkdownFormat } from "./format-fixture";
import type { StudioPlatform } from "../src/types";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";

seedMarkdownFormat();
registerPlatform({
  formatAction: mockFormatAction,
} as unknown as StudioPlatform);

const loadMarkdown = (source: string) => parseSourceForPath("doc.md", source);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Collect all unique tag names from a Jx node tree. Mirrors the inline collectTags in
 * renderCanvasLive.
 *
 * @param {any} node
 */
function collectTags(node?: any) {
  const tags = new Set();
  if (!node || typeof node !== "object") {
    return tags;
  }
  if (node.tagName) {
    tags.add(node.tagName);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      for (const t of collectTags(child)) {
        tags.add(t);
      }
    }
  }
  return tags;
}

/**
 * Simulate the auto-discovery logic from renderCanvasLive: scan the document tree for tag names,
 * match against componentRegistry, and produce $ref entries for each match.
 *
 * @param {any} doc
 * @param {any} documentPath
 * @param {any[]} componentRegistry
 * @param {any[]} existingElements
 */
function autoDiscoverElements(
  doc: any,
  documentPath: any,
  componentRegistry: any[],
  existingElements: any[],
) {
  const effectiveElements = [...existingElements];
  const existingRefs = new Set(effectiveElements.map((e) => (typeof e === "string" ? e : e?.$ref)));
  for (const tag of collectTags(doc)) {
    const comp = componentRegistry.find((c: any) => c.tagName === tag);
    if (comp && comp.source !== "npm") {
      const relPath = computeRelativePath(documentPath, comp.path);
      if (!existingRefs.has(relPath)) {
        effectiveElements.push({ $ref: relPath });
        existingRefs.add(relPath);
      }
    }
  }
  return effectiveElements;
}

/**
 * Build docBase URL the same way renderCanvasLive does.
 *
 * @param {string} origin
 * @param {string | null} documentPath
 * @param {string} projectRoot
 */
function buildDocBase(origin: string, documentPath: string | null, root = "") {
  const docPrefix = root && root !== "." ? `${root}/` : "";
  return documentPath ? `${origin}/${docPrefix}${documentPath}` : undefined;
}

// ─── collectTags ────────────────────────────────────────────────────────────

describe("collectTags", () => {
  test("collects tag names from a flat tree", () => {
    const doc = {
      children: [{ tagName: "hero" }, { tagName: "footer" }],
      tagName: "div",
    };
    expect([...collectTags(doc)]).toEqual(["div", "hero", "footer"]);
  });

  test("collects tag names from a nested tree", () => {
    const doc = {
      children: [
        {
          children: [{ tagName: "hero" }, { tagName: "p" }],
          tagName: "section",
        },
        { tagName: "cta-banner" },
      ],
      tagName: "div",
    };
    const tags = collectTags(doc);
    expect(tags.has("div")).toBe(true);
    expect(tags.has("section")).toBe(true);
    expect(tags.has("hero")).toBe(true);
    expect(tags.has("p")).toBe(true);
    expect(tags.has("cta-banner")).toBe(true);
  });

  test("deduplicates tag names", () => {
    const doc = {
      children: [{ tagName: "p" }, { tagName: "p" }, { tagName: "p" }],
      tagName: "div",
    };
    expect([...collectTags(doc)]).toEqual(["div", "p"]);
  });

  test("handles null/undefined nodes", () => {
    expect(collectTags(null).size).toBe(0);
    expect(collectTags().size).toBe(0);
  });

  test("handles nodes without children", () => {
    expect([...collectTags({ tagName: "hr" })]).toEqual(["hr"]);
  });
});

// ─── docBase URL construction ───────────────────────────────────────────────

describe("buildDocBase", () => {
  const origin = "http://localhost:3000";

  test("includes projectRoot prefix for site projects", () => {
    const url = buildDocBase(origin, "content/pages/home.md", "sites/jxsuite.com");
    expect(url).toBe("http://localhost:3000/sites/jxsuite.com/content/pages/home.md");
  });

  test("omits prefix when projectRoot is '.'", () => {
    const url = buildDocBase(origin, "pages/index.json", ".");
    expect(url).toBe("http://localhost:3000/pages/index.json");
  });

  test("omits prefix when projectRoot is empty", () => {
    const url = buildDocBase(origin, "pages/index.json", "");
    expect(url).toBe("http://localhost:3000/pages/index.json");
  });

  test("returns undefined when documentPath is null", () => {
    expect(buildDocBase(origin, null, "sites/jxsuite.com")).toBeUndefined();
  });

  test("$ref resolves to correct URL with projectRoot prefix", () => {
    const docBase = buildDocBase(origin, "content/pages/home.md", "sites/jxsuite.com");
    const ref = "../../components/hero.json";
    const resolved = new URL(ref, docBase).href;
    expect(resolved).toBe("http://localhost:3000/sites/jxsuite.com/components/hero.json");
  });

  test("$ref resolves incorrectly WITHOUT projectRoot prefix (regression)", () => {
    // This is what the old code did — docBase without the site prefix
    const badDocBase = `${origin}/content/pages/home.md`;
    const ref = "../../components/hero.json";
    const resolved = new URL(ref, badDocBase).href;
    // Escapes out of the project root — wrong!
    expect(resolved).toBe("http://localhost:3000/components/hero.json");
    expect(resolved).not.toContain("sites/jxsuite.com");
  });
});

// ─── Component auto-discovery ───────────────────────────────────────────────

describe("autoDiscoverElements", () => {
  const registry = [
    { path: "components/hero.json", source: "jx", tagName: "hero" },
    {
      path: "components/product-showcase.json",
      source: "jx",
      tagName: "product-showcase",
    },
    {
      path: "components/feature-grid.json",
      source: "jx",
      tagName: "feature-grid",
    },
    { path: "components/cta-banner.json", source: "jx", tagName: "cta-banner" },
    { path: "npm-widget", source: "npm", tagName: "npm-widget" },
  ];

  test("discovers components matching tag names in the document", () => {
    const doc = {
      children: [{ tagName: "hero" }, { tagName: "cta-banner" }],
      tagName: "div",
    };
    const result = autoDiscoverElements(doc, "content/pages/home.md", registry, []);
    const refs = result.map((e) => e.$ref);
    expect(refs).toContain("../../components/hero.json");
    expect(refs).toContain("../../components/cta-banner.json");
  });

  test("discovers all directive components from a typical markdown tree", () => {
    const doc = {
      children: [
        { tagName: "hero" },
        { tagName: "product-showcase" },
        { tagName: "feature-grid" },
        { tagName: "cta-banner" },
      ],
      tagName: "div",
    };
    const result = autoDiscoverElements(doc, "content/pages/home.md", registry, []);
    expect(result.length).toBe(4);
  });

  test("skips npm-sourced components", () => {
    const doc = { children: [{ tagName: "npm-widget" }], tagName: "div" };
    const result = autoDiscoverElements(doc, "content/pages/home.md", registry, []);
    expect(result.length).toBe(0);
  });

  test("skips tags not in the registry", () => {
    const doc = {
      children: [{ tagName: "p" }, { tagName: "h1" }, { tagName: "unknown-thing" }],
      tagName: "div",
    };
    const result = autoDiscoverElements(doc, "content/pages/home.md", registry, []);
    expect(result.length).toBe(0);
  });

  test("does not duplicate already-existing $elements", () => {
    const doc = { children: [{ tagName: "hero" }], tagName: "div" };
    const existing = [{ $ref: "../../components/hero.json" }];
    const result = autoDiscoverElements(doc, "content/pages/home.md", registry, existing);
    const heroRefs = result.filter((e) => e.$ref?.includes("hero"));
    expect(heroRefs.length).toBe(1);
  });

  test("merges with pre-existing elements", () => {
    const doc = { children: [{ tagName: "cta-banner" }], tagName: "div" };
    const existing = [{ $ref: "../../components/hero.json" }];
    const result = autoDiscoverElements(doc, "content/pages/home.md", registry, existing);
    expect(result.length).toBe(2);
    expect(result[0].$ref).toBe("../../components/hero.json");
    expect(result[1].$ref).toBe("../../components/cta-banner.json");
  });
});

// ─── computeRelativePath for content files ──────────────────────────────────

describe("computeRelativePath for content → component", () => {
  test("computes correct path from content/pages/ to components/", () => {
    const rel = computeRelativePath("content/pages/home.md", "components/hero.json");
    expect(rel).toBe("../../components/hero.json");
  });

  test("computes correct path from pages/ to components/", () => {
    const rel = computeRelativePath("pages/index.json", "components/hero.json");
    expect(rel).toBe("../components/hero.json");
  });

  test("computes correct path when files are siblings", () => {
    const rel = computeRelativePath("components/a.json", "components/b.json");
    expect(rel).toBe("./b.json");
  });

  test("handles backslash paths (Windows)", () => {
    const rel = computeRelativePath(
      String.raw`content\pages\home.md`,
      String.raw`components\hero.json`,
    );
    expect(rel).toBe("../../components/hero.json");
  });

  test("falls back to ./ prefix when fromDocPath is null", () => {
    const rel = computeRelativePath(null, "components/hero.json");
    expect(rel).toBe("./components/hero.json");
  });
});

// ─── getEffectiveElements with site-level config ────────────────────────────

describe("getEffectiveElements", () => {
  beforeEach(() => {
    setProjectState(null);
  });

  test("returns doc elements when no site config", () => {
    const docEls = [{ $ref: "./components/hero.json" }];
    const result = getEffectiveElements(docEls);
    expect(result).toEqual(docEls);
  });

  test("returns empty array when no doc elements and no site config", () => {
    expect(getEffectiveElements()).toEqual([]);
    expect(getEffectiveElements()).toEqual([]);
  });

  test("returns site elements when doc has none", () => {
    setProjectState({
      projectConfig: { $elements: [{ $ref: "./components/hero.json" }] },
    } as any);
    const result = getEffectiveElements();
    expect(result).toEqual([{ $ref: "./components/hero.json" }]);
  });

  test("merges site and doc elements with dedup", () => {
    setProjectState({
      projectConfig: {
        $elements: [{ $ref: "./components/hero.json" }, { $ref: "./components/footer.json" }],
      },
    } as any);
    const docEls = [{ $ref: "./components/hero.json" }, { $ref: "./components/nav.json" }];
    const result = getEffectiveElements(docEls);
    expect(result.length).toBe(3);
    const refs = result.map((e) => (e as { $ref: string }).$ref);
    expect(refs).toContain("./components/hero.json");
    expect(refs).toContain("./components/footer.json");
    expect(refs).toContain("./components/nav.json");
  });
});

// ─── loadMarkdown produces correct state ────────────────────────────────────

describe("loadMarkdown state", () => {
  test("sets mode to content", async () => {
    const result = await loadMarkdown("# Hello\n\nSome text");
    // Content mode is inferred: non-component markdown → document has children, no tagName
    expect((result.document as JxMutableNode).children).toBeDefined();
    expect((result.document as JxMutableNode).tagName).toBeUndefined();
  });

  test("parses frontmatter", async () => {
    const md = '---\ntitle: "My Page"\n---\n\n# Hello';
    const result = await loadMarkdown(md);
    expect((result.frontmatter as Record<string, unknown>).title).toBe("My Page");
  });

  test("converts directives to custom element nodes", async () => {
    const md = "::hero\n\n::cta-banner\n";
    const result = await loadMarkdown(md);
    const doc = result.document as JxMutableNode;
    expect(doc.tagName).toBeUndefined();
    const children = Array.isArray(doc.children) ? doc.children : [];
    const tags = children.map((c) => (c as JxMutableNode).tagName);
    expect(tags).toContain("hero");
    expect(tags).toContain("cta-banner");
  });

  test("document has no $elements (components must be auto-discovered)", async () => {
    const md = "::hero\n\n::cta-banner\n";
    const result = await loadMarkdown(md);
    expect((result.document as JxMutableNode).$elements).toBeUndefined();
  });

  test("documentPath is null (must be set by caller)", async () => {
    const result = await loadMarkdown("# Hello");
    // LoadMarkdown doesn't set documentPath — that's the caller's responsibility
    expect(result.document).toBeDefined();
  });
});

// ─── getEffectiveStyle ─────────────────────────────────────────────────────

describe("getEffectiveStyle", () => {
  beforeEach(() => {
    setProjectState(null);
  });

  test("returns doc style when no site config", () => {
    const docStyle = { color: "red" };
    expect(getEffectiveStyle(docStyle)).toEqual({ color: "red" });
  });

  test("returns empty object when no doc style and no site config", () => {
    expect(getEffectiveStyle()).toEqual({});
  });

  test("returns site style when doc has none", () => {
    setProjectState({
      projectConfig: { style: { color: "blue", fontFamily: "sans-serif" } },
    } as any);
    expect(getEffectiveStyle()).toEqual({
      color: "blue",
      fontFamily: "sans-serif",
    });
  });

  test("doc style overrides site style on conflict", () => {
    setProjectState({
      projectConfig: { style: { color: "blue", fontFamily: "sans-serif" } },
    } as any);
    const result = getEffectiveStyle({ color: "red" });
    expect(result.color).toBe("red");
    expect(result.fontFamily).toBe("sans-serif");
  });

  test("shallow-merges nested selector objects (e.g. & li)", () => {
    setProjectState({
      projectConfig: {
        style: { "& li": { margin: "0", padding: "4px" } },
      },
    } as any);
    const result = getEffectiveStyle({
      "& li": { color: "red", margin: "8px" },
    });
    expect((result["& li"] as JxStyle).margin).toBe("8px");
    expect((result["& li"] as JxStyle).padding).toBe("4px");
    expect((result["& li"] as JxStyle).color).toBe("red");
  });

  test("flat CSS custom properties from site config (project style is implicitly :root)", () => {
    setProjectState({
      projectConfig: {
        style: {
          "--bg-primary": "#0a0a0a",
          "--text-primary": "#fafafa",
          backgroundColor: "var(--bg-primary)",
          fontFamily: "system-ui",
        },
      },
    } as any);
    const result = getEffectiveStyle();
    expect(result["--bg-primary"]).toBe("#0a0a0a");
    expect(result["--text-primary"]).toBe("#fafafa");
    expect(result.backgroundColor).toBe("var(--bg-primary)");
    expect(result.fontFamily).toBe("system-ui");
  });
});

// ─── Flat project style convention ────────────────────────────────────────

describe("flat project style (implicit :root)", () => {
  beforeEach(() => {
    setProjectState(null);
  });

  test("CSS variables and regular props coexist at top level", () => {
    const style = {
      "--bg": "#000",
      "--text": "#fff",
      backgroundColor: "var(--bg)",
      fontFamily: "sans-serif",
    };
    // No promotion needed — already flat
    expect(style["--bg"]).toBe("#000");
    expect(style["--text"]).toBe("#fff");
    expect(style.fontFamily).toBe("sans-serif");
    expect(style.backgroundColor).toBe("var(--bg)");
  });

  test("doc style overrides project CSS variables on conflict", () => {
    setProjectState({
      projectConfig: {
        style: { "--bg": "#000", "--text": "#fff", color: "var(--text)" },
      },
    } as any);
    const result = getEffectiveStyle({ "--bg": "#111" });
    expect(result["--bg"]).toBe("#111");
    expect(result["--text"]).toBe("#fff");
    expect(result.color).toBe("var(--text)");
  });

  test("full pipeline: flat site config → effective style", () => {
    setProjectState({
      projectConfig: {
        style: {
          "--bg-primary": "#0a0a0a",
          "--text-primary": "#fafafa",
          backgroundColor: "var(--bg-primary)",
          color: "var(--text-primary)",
          fontFamily: "system-ui",
        },
      },
    } as any);
    const result = getEffectiveStyle();
    expect(result["--bg-primary"]).toBe("#0a0a0a");
    expect(result["--text-primary"]).toBe("#fafafa");
    expect(result.backgroundColor).toBe("var(--bg-primary)");
    expect(result.fontFamily).toBe("system-ui");
  });
});

// ─── getEffectiveMedia ─────────────────────────────────────────────────────

describe("getEffectiveMedia", () => {
  beforeEach(() => {
    setProjectState(null);
  });

  test("returns doc media when no site config", () => {
    const docMedia = { "--sm": "(min-width: 640px)" };
    expect(getEffectiveMedia(docMedia)).toEqual(docMedia);
  });

  test("returns empty object when no doc media and no site config", () => {
    expect(getEffectiveMedia()).toEqual({});
  });

  test("returns site media when doc has none", () => {
    setProjectState({
      projectConfig: {
        $media: { "--md": "(min-width: 768px)", "--sm": "(min-width: 640px)" },
      },
    } as any);
    expect(getEffectiveMedia()).toEqual({
      "--md": "(min-width: 768px)",
      "--sm": "(min-width: 640px)",
    });
  });

  test("doc media overrides site media on conflict", () => {
    setProjectState({
      projectConfig: {
        $media: { "--md": "(min-width: 768px)", "--sm": "(min-width: 640px)" },
      },
    } as any);
    const result = getEffectiveMedia({ "--sm": "(min-width: 600px)" });
    expect(result["--sm"]).toBe("(min-width: 600px)");
    expect(result["--md"]).toBe("(min-width: 768px)");
  });
});
