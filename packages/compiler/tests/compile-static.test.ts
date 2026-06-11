import { describe, expect, test } from "bun:test";
import { compileStaticPage } from "../src/targets/compile-static";

// ─── compileStaticPage ─────────────────────────────────────────────────────

describe("compileStaticPage", () => {
  const baseOpts = {
    litHtmlSrc: "https://esm.sh/lit-html",
    reactivitySrc: "https://esm.sh/@vue/reactivity",
    title: "Test Page",
  };

  test("generates valid HTML document", () => {
    const doc = {
      children: [{ tagName: "p", textContent: "Hello" }],
    };
    const { html } = compileStaticPage(doc, baseOpts);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Test Page</title>");
    expect(html).toContain("<p>Hello</p>");
    expect(html).toContain("</body>");
    expect(html).toContain("</html>");
  });

  test("includes meta charset and viewport", () => {
    const doc = { children: [] };
    const { html } = compileStaticPage(doc, baseOpts);
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain("viewport");
  });

  test("renders nested static elements", () => {
    const doc = {
      children: [
        {
          children: [
            { tagName: "h1", textContent: "Title" },
            { tagName: "p", textContent: "Content" },
          ],
          id: "app",
          tagName: "div",
        },
      ],
    };
    const { html } = compileStaticPage(doc, baseOpts);
    expect(html).toContain('<div id="app">');
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Content</p>");
  });

  test("escapes HTML in text content", () => {
    const doc = {
      children: [{ tagName: "p", textContent: "<script>alert('xss')</script>" }],
    };
    const { html } = compileStaticPage(doc, baseOpts);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  test("includes style block when styles present", () => {
    const doc = {
      children: [
        {
          children: [],
          id: "styled",
          style: { "@(min-width: 768px)": { color: "blue" }, color: "red" },
          tagName: "div",
        },
      ],
    };
    const { html } = compileStaticPage(doc, baseOpts);
    expect(html).toContain("<style>");
    expect(html).toContain("@media (min-width: 768px)");
  });

  test("converts dynamic nodes to islands", () => {
    const doc = {
      children: [
        {
          onclick: { $ref: "#/state/fn" },
          state: { count: 0 },
          tagName: "div",
          textContent: "Dynamic",
        },
      ],
    };
    const { html, files } = compileStaticPage(doc, baseOpts);
    expect(html).toContain("jx-island-");
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].path).toContain("_islands/");
  });

  test("includes importmap and module scripts for islands", () => {
    const doc = {
      children: [
        {
          onclick: { $ref: "#/state/fn" },
          tagName: "button",
          textContent: "Click",
        },
      ],
    };
    const { html } = compileStaticPage(doc, baseOpts);
    expect(html).toContain("importmap");
    expect(html).toContain("@vue/reactivity");
    expect(html).toContain('type="module"');
  });

  test("returns no files for fully static page", () => {
    const doc = {
      children: [
        { tagName: "h1", textContent: "Static" },
        { tagName: "p", textContent: "No JS needed" },
      ],
    };
    const { files } = compileStaticPage(doc, baseOpts);
    expect(files).toEqual([]);
  });

  test("handles innerHTML content", () => {
    const doc = {
      children: [{ innerHTML: "<b>Bold</b>", tagName: "div" }],
    };
    const { html } = compileStaticPage(doc, baseOpts);
    expect(html).toContain("<b>Bold</b>");
  });

  test("state with template triggers island compilation", () => {
    const doc = {
      children: [{ tagName: "p", textContent: "${state.name}" }],
      state: { name: "World" },
    };
    const { html, files } = compileStaticPage(doc, baseOpts);
    expect(html).toContain("jx-island-");
    expect(files.length).toBeGreaterThan(0);
  });

  test("handles string children", () => {
    const doc = {
      children: [{ children: ["Hello ", "World"], tagName: "p" }],
    };
    const { html } = compileStaticPage(doc, baseOpts);
    expect(html).toContain("Hello");
    expect(html).toContain("World");
  });

  test("handles numeric and boolean children", () => {
    const doc = {
      children: [{ children: [42, true], tagName: "p" }],
    } as unknown as import("@jxsuite/schema/types").JxDocument;
    const { html } = compileStaticPage(doc, baseOpts);
    expect(html).toContain("42");
    expect(html).toContain("true");
  });

  test("applies projectStyle to style output", () => {
    const doc = { children: [{ tagName: "p", textContent: "hi" }] };
    const opts = { ...baseOpts, projectStyle: { "--bg": "#000" } };
    const { html } = compileStaticPage(doc, opts);
    expect(html).toContain(":root");
    expect(html).toContain("--bg: #000");
  });
});
