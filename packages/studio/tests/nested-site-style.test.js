import { describe, test, expect } from "bun:test";
import { buildNestedSiteCSS } from "../src/canvas/nested-site-style.js";

describe("buildNestedSiteCSS", () => {
  test("returns empty string when no nested objects exist", () => {
    const style = { color: "red", fontSize: "14px", "--accent": "#3b82f6" };
    expect(buildNestedSiteCSS(style, "[data-jx-site]")).toBe("");
  });

  test("generates CSS for a single nested selector", () => {
    const style = {
      table: { width: "100%", borderCollapse: "collapse" },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site] table { width: 100%; border-collapse: collapse }");
  });

  test("generates deeply nested selectors (table > tbody > tr)", () => {
    const style = {
      table: {
        width: "100%",
        tbody: {
          tr: { borderBottom: "1px solid #222" },
        },
      },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site] table { width: 100% }");
    expect(css).toContain("[data-jx-site] table tbody tr { border-bottom: 1px solid #222 }");
  });

  test("handles pseudo-selectors (:hover, :first-child)", () => {
    const style = {
      table: {
        tbody: {
          tr: {
            borderBottom: "1px solid #ccc",
            ":hover": { backgroundColor: "blue" },
            ":first-child": { fontWeight: "700" },
          },
        },
      },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site] table tbody tr:hover { background-color: blue }");
    expect(css).toContain("[data-jx-site] table tbody tr:first-child { font-weight: 700 }");
  });

  test("handles & (ampersand) selectors", () => {
    const style = {
      "&.active": { fontWeight: "bold" },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site].active { font-weight: bold }");
  });

  test("handles attribute selectors", () => {
    const style = {
      "[disabled]": { opacity: "0.5" },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site][disabled] { opacity: 0.5 }");
  });

  test("handles class selectors", () => {
    const style = {
      ".highlight": { color: "yellow" },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site].highlight { color: yellow }");
  });

  test("skips flat properties (non-objects)", () => {
    const style = {
      color: "red",
      margin: "0",
      "--custom": "blue",
      table: { width: "100%" },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).not.toContain("color");
    expect(css).not.toContain("margin");
    expect(css).not.toContain("--custom");
    expect(css).toContain("[data-jx-site] table { width: 100% }");
  });

  test("converts camelCase to kebab-case", () => {
    const style = {
      table: { fontSize: "14px", textAlign: "left", borderCollapse: "collapse" },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("font-size: 14px");
    expect(css).toContain("text-align: left");
    expect(css).toContain("border-collapse: collapse");
  });

  test("handles real-world project.json table styles", () => {
    const style = {
      "--color-border": "#222222",
      fontFamily: "system-ui",
      table: {
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "0.9375rem",
        thead: {
          padding: "1rem 1.25rem",
          fontWeight: "600",
          borderBottom: "1px solid var(--color-border)",
        },
        tbody: {
          tr: {
            borderBottom: "1px solid var(--color-border)",
            ":hover": { backgroundColor: "var(--color-bg-surface)" },
          },
          td: {
            padding: "1rem 1.25rem",
            ":first-child": { fontWeight: "600", borderLeft: "none" },
            ":last-child": { backgroundColor: "rgba(255, 255, 255, 0.97)" },
          },
        },
      },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");

    expect(css).toContain(
      "[data-jx-site] table { width: 100%; border-collapse: collapse; font-size: 0.9375rem }",
    );
    expect(css).toContain("[data-jx-site] table thead { padding: 1rem 1.25rem; font-weight: 600");
    expect(css).toContain(
      "[data-jx-site] table tbody tr { border-bottom: 1px solid var(--color-border) }",
    );
    expect(css).toContain(
      "[data-jx-site] table tbody tr:hover { background-color: var(--color-bg-surface) }",
    );
    expect(css).toContain("[data-jx-site] table tbody td { padding: 1rem 1.25rem }");
    expect(css).toContain(
      "[data-jx-site] table tbody td:first-child { font-weight: 600; border-left: none }",
    );
    expect(css).toContain(
      "[data-jx-site] table tbody td:last-child { background-color: rgba(255, 255, 255, 0.97) }",
    );
  });

  test("nested & within a descendant selector", () => {
    const style = {
      table: {
        tbody: {
          "&.striped": { background: "gray" },
        },
      },
    };
    const css = buildNestedSiteCSS(style, "[data-jx-site]");
    expect(css).toContain("[data-jx-site] table tbody.striped { background: gray }");
  });
});
