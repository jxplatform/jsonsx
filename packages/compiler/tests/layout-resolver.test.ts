import { describe, test, expect } from "bun:test";
import { resolveLayout } from "../src/site/layout-resolver";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "_fixtures_layout");

function setup() {
  mkdirSync(join(FIXTURES, "layouts"), { recursive: true });
}

function cleanup() {
  rmSync(FIXTURES, { recursive: true, force: true });
}

/** @param {string} name @param {unknown} content */
function writeLayout(name: string, content: unknown) {
  writeFileSync(join(FIXTURES, "layouts", name), JSON.stringify(content), "utf8");
}

// ─── resolveLayout ──────────────────────────────────────────────────────────

describe("resolveLayout", () => {
  test("returns page as-is when no layout specified", () => {
    const page = { tagName: "div", children: [{ tagName: "p" }] };
    const result = resolveLayout(page, {}, "/tmp");
    expect(result).toBe(page);
  });

  test("returns page as-is when $layout is not set and no defaults", () => {
    const page = { children: [{ tagName: "p" }] };
    const result = resolveLayout(page, { defaults: {} }, "/tmp");
    expect(result).toBe(page);
  });

  test("throws when layout file not found", () => {
    const page = { $layout: "./layouts/missing.json" };
    expect(() => resolveLayout(page, {}, "/tmp")).toThrow("Layout not found");
  });

  test("distributes page children into layout slots", () => {
    setup();
    try {
      writeLayout("base.json", {
        tagName: "div",
        children: [
          { tagName: "header", children: [{ tagName: "h1", textContent: "Header" }] },
          { tagName: "main", children: [{ tagName: "slot" }] },
          { tagName: "footer", children: [{ tagName: "p", textContent: "Footer" }] },
        ],
      });

      const page = {
        $layout: "./layouts/base.json",
        children: [{ tagName: "p", textContent: "Page content" }],
      };

      const result = resolveLayout(page, {}, FIXTURES) as any;
      const main = result.children.find((c: JxElement) => c.tagName === "main");
      expect(main.children[0].textContent).toBe("Page content");
    } finally {
      cleanup();
    }
  });

  test("distributes named slots", () => {
    setup();
    try {
      writeLayout("slots.json", {
        tagName: "div",
        children: [
          {
            tagName: "nav",
            children: [{ tagName: "slot", attributes: { name: "nav" } }],
          },
          { tagName: "main", children: [{ tagName: "slot" }] },
        ],
      });

      const page = {
        $layout: "./layouts/slots.json",
        children: [
          { tagName: "a", attributes: { slot: "nav" }, textContent: "Link" },
          { tagName: "p", textContent: "Main content" },
        ],
      };

      const result = resolveLayout(page, {}, FIXTURES) as any;
      const nav = result.children.find((c: JxElement) => c.tagName === "nav");
      expect(nav.children[0].tagName).toBe("a");
      expect(nav.children[0].textContent).toBe("Link");

      const main = result.children.find((c: JxElement) => c.tagName === "main");
      expect(main.children[0].textContent).toBe("Main content");
    } finally {
      cleanup();
    }
  });

  test("merges page state onto layout state", () => {
    setup();
    try {
      writeLayout("with-state.json", {
        tagName: "div",
        state: { layoutVar: "from-layout" },
        children: [],
      });

      const page = {
        $layout: "./layouts/with-state.json",
        state: { pageVar: "from-page" },
      };

      const result = resolveLayout(page, {}, FIXTURES) as any;
      expect(result.state.layoutVar).toBe("from-layout");
      expect(result.state.pageVar).toBe("from-page");
    } finally {
      cleanup();
    }
  });

  test("page state overrides layout state on conflict", () => {
    setup();
    try {
      writeLayout("override.json", {
        tagName: "div",
        state: { shared: "layout-value" },
        children: [],
      });

      const page = {
        $layout: "./layouts/override.json",
        state: { shared: "page-value" },
      };

      const result = resolveLayout(page, {}, FIXTURES) as any;
      expect(result.state.shared).toBe("page-value");
    } finally {
      cleanup();
    }
  });

  test("preserves page $head and title as _pageHead and _pageTitle", () => {
    setup();
    try {
      writeLayout("meta.json", {
        tagName: "div",
        children: [],
      });

      const page = {
        $layout: "./layouts/meta.json",
        title: "About Us",
        $head: [{ tagName: "meta", attributes: { name: "description", content: "About page" } }],
      };

      const result = resolveLayout(page, {}, FIXTURES) as any;
      expect(result._pageTitle).toBe("About Us");
      expect(result._pageHead).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("removes $layout from resolved document", () => {
    setup();
    try {
      writeLayout("clean.json", { tagName: "div", children: [] });
      const page = { $layout: "./layouts/clean.json" };
      const result = resolveLayout(page, {}, FIXTURES) as any;
      expect(result.$layout).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("uses project default layout when page has no $layout", () => {
    setup();
    try {
      writeLayout("default.json", {
        tagName: "div",
        className: "default-layout",
        children: [{ tagName: "slot" }],
      });

      const page = {
        children: [{ tagName: "p", textContent: "Content" }],
      };
      const project = { defaults: { layout: "./layouts/default.json" } };

      const result = resolveLayout(page, project, FIXTURES) as any;
      expect(result.className).toBe("default-layout");
    } finally {
      cleanup();
    }
  });

  test("slot fallback content is used when no matching children", () => {
    setup();
    try {
      writeLayout("fallback.json", {
        tagName: "div",
        children: [
          {
            tagName: "aside",
            children: [
              {
                tagName: "slot",
                attributes: { name: "sidebar" },
                children: [{ tagName: "p", textContent: "Default sidebar" }],
              },
            ],
          },
          { tagName: "main", children: [{ tagName: "slot" }] },
        ],
      });

      const page = {
        $layout: "./layouts/fallback.json",
        children: [{ tagName: "p", textContent: "Main content" }],
      };

      const result = resolveLayout(page, {}, FIXTURES) as any;
      const aside = result.children.find((c: JxElement) => c.tagName === "aside");
      expect(aside.children[0].textContent).toBe("Default sidebar");
    } finally {
      cleanup();
    }
  });

  test("throws on malformed layout JSON", () => {
    setup();
    try {
      writeFileSync(join(FIXTURES, "layouts", "bad.json"), "{ not valid json", "utf8");
      const page = { $layout: "./layouts/bad.json" };
      expect(() => resolveLayout(page, {}, FIXTURES)).toThrow("Invalid layout JSON");
    } finally {
      cleanup();
    }
  });

  test("resolves nested layouts (layout extending another layout)", () => {
    setup();
    try {
      writeLayout("outer.json", {
        tagName: "html",
        children: [{ tagName: "body", children: [{ tagName: "slot" }] }],
      });
      writeLayout("inner.json", {
        $layout: "./layouts/outer.json",
        tagName: "div",
        className: "inner-wrapper",
        children: [{ tagName: "slot" }],
      });

      const page = {
        $layout: "./layouts/inner.json",
        children: [{ tagName: "p", textContent: "Nested content" }],
      };

      const result = resolveLayout(page, {}, FIXTURES) as any;
      expect(result.tagName).toBe("html");
      const body = result.children.find((c: JxElement) => c.tagName === "body");
      expect(body).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("merges page $media onto layout $media", () => {
    setup();
    try {
      writeLayout("media.json", {
        tagName: "div",
        $media: { "--md": "(min-width: 768px)" },
        children: [{ tagName: "slot" }],
      });

      const page = {
        $layout: "./layouts/media.json",
        $media: { "--lg": "(min-width: 1024px)" },
        children: [{ tagName: "p" }],
      };

      const result = resolveLayout(page, {}, FIXTURES) as any;
      expect(result.$media["--md"]).toBe("(min-width: 768px)");
      expect(result.$media["--lg"]).toBe("(min-width: 1024px)");
    } finally {
      cleanup();
    }
  });

  test("merges page style onto layout style", () => {
    setup();
    try {
      writeLayout("styled.json", {
        tagName: "div",
        style: { color: "red" },
        children: [{ tagName: "slot" }],
      });

      const page = {
        $layout: "./layouts/styled.json",
        style: { fontSize: "16px" },
        children: [{ tagName: "p" }],
      };

      const result = resolveLayout(page, {}, FIXTURES) as any;
      expect(result.style.color).toBe("red");
      expect(result.style.fontSize).toBe("16px");
    } finally {
      cleanup();
    }
  });
});

process.on("exit", () => {
  try {
    cleanup();
  } catch {}
});
