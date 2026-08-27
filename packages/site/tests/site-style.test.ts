import { describe, expect, test } from "bun:test";
import { SITE_STYLE_ID, buildSiteStyleCSS } from "../src/site-style.ts";

const id = (v: string) => v;

// ─── buildSiteStyleCSS ──────────────────────────────────────────────────────

describe("buildSiteStyleCSS", () => {
  test("splits custom properties to :root and plain props to body", () => {
    const css = buildSiteStyleCSS({ "--brand": "#0f0", color: "red", margin: "0" }, {}, id);
    expect(css).toContain(":root { --brand: #0f0 }");
    expect(css).toContain("body { color: red; margin: 0 }");
  });

  test("applies the transpose hook to values", () => {
    const css = buildSiteStyleCSS({ minHeight: "100vh" }, {}, (v) => v.replace("vh", "cqh"));
    expect(css).toContain("body { min-height: 100cqh }");
  });

  test("resolves @--name blocks against mediaQueries, tokens on :root", () => {
    const css = buildSiteStyleCSS(
      { "--pad": "1rem", "@--md": { "--pad": "2rem", margin: "0" } },
      { "--md": "(min-width: 768px)" },
      id,
    );
    expect(css).toContain("@media (min-width: 768px) { :root { --pad: 2rem } }");
    expect(css).toContain("@media (min-width: 768px) { body { margin: 0 } }");
    expect(css.indexOf(":root { --pad: 1rem")).toBeLessThan(css.indexOf("@media"));
    expect(css).not.toContain("color-scheme");
  });

  test("dual-emits scheme blocks with the §9.5 selector contract", () => {
    const css = buildSiteStyleCSS(
      { "--bg": "#fff", "@--dark": { "--bg": "#000", ".card": { borderColor: "#333" } } },
      { "--dark": "(prefers-color-scheme: dark)" },
      id,
    );
    // Pin the exact selector contract shared with the compiler/runtime emission.
    expect(css).toContain(
      "@media (prefers-color-scheme: dark) { :root:where(:not([data-color-scheme])) { --bg: #000 } }",
    );
    expect(css).toContain(':root:where([data-color-scheme="dark"]) { --bg: #000 }');
    expect(css).toContain(':where(:root[data-color-scheme="dark"]) .card { border-color: #333 }');
    expect(css).toContain(":root { color-scheme: light dark }");
  });

  test("literal @(query) blocks work; unresolvable at-keys are skipped", () => {
    const css = buildSiteStyleCSS(
      {
        "@(prefers-color-scheme: light)": { "--fg": "#111" },
        "@supports (gap: 1px)": { gap: "1" },
      },
      {},
      id,
    );
    expect(css).toContain(':root:where([data-color-scheme="light"]) { --fg: #111 }');
    expect(css).not.toContain("@supports");
  });

  /*
   * A media TYPE is bare. `@media (print)` reads as a boolean media feature named `print`, which
   * does not exist, so the canvas silently dropped every print rule.
   */
  test("@(print) emits the bare media type", () => {
    const css = buildSiteStyleCSS({ "@(print)": { color: "#000" } }, {}, id);
    expect(css).toContain("@media print");
    expect(css).not.toContain("@media (print)");
  });

  test("declares color-scheme when the media map has a scheme query even without blocks", () => {
    const css = buildSiteStyleCSS(
      { "--bg": "#fff" },
      { "--dark": "(prefers-color-scheme: dark)" },
      id,
    );
    expect(css).toContain(":root { color-scheme: light dark }");
  });

  test("empty style with no scheme query produces no rules", () => {
    expect(buildSiteStyleCSS({}, {}, id)).toBe("");
  });

  test("exports the stable style-tag id", () => {
    expect(SITE_STYLE_ID).toBe("jx-site-style");
  });
});
