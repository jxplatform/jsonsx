import { describe, test, expect } from "bun:test";
import { mergeHead, renderHead } from "../src/site/head-merger.js";

// ─── mergeHead ──────────────────────────────────────────────────────────────

describe("mergeHead", () => {
  test("auto-injects charset and viewport defaults", () => {
    const result = mergeHead();
    const charsetEntry = result.find(
      (e) => e.tagName === "meta" && e.attributes?.charset === "utf-8",
    );
    const viewportEntry = result.find((e) => e.attributes?.name === "viewport");
    expect(charsetEntry).toBeDefined();
    expect(viewportEntry).toBeDefined();
  });

  test("injects title from context", () => {
    const result = mergeHead([], [], [], { title: "My Page" });
    const titleEntry = result.find((e) => e.tagName === "title");
    expect(titleEntry).toBeDefined();
    expect(titleEntry.children).toEqual(["My Page"]);
  });

  test("uses siteName as fallback title", () => {
    const result = mergeHead([], [], [], { siteName: "Jx Site" });
    const titleEntry = result.find((e) => e.tagName === "title");
    expect(titleEntry.children).toEqual(["Jx Site"]);
  });

  test("later layers override earlier ones (page > layout > site)", () => {
    const site = [{ tagName: "meta", attributes: { name: "description", content: "Site desc" } }];
    /** @type {any[]} */
    const layout = [];
    const page = [{ tagName: "meta", attributes: { name: "description", content: "Page desc" } }];
    const result = mergeHead(site, layout, page);
    const desc = result.find((e) => e.attributes?.name === "description");
    expect(desc.attributes.content).toBe("Page desc");
  });

  test("deduplicates <meta charset>", () => {
    const site = [{ tagName: "meta", attributes: { charset: "utf-8" } }];
    const page = [{ tagName: "meta", attributes: { charset: "utf-16" } }];
    const result = mergeHead(site, [], page);
    const charsets = result.filter((e) => e.attributes?.charset);
    expect(charsets).toHaveLength(1);
    expect(charsets[0].attributes.charset).toBe("utf-16");
  });

  test("deduplicates <link> by rel+href", () => {
    const site = [{ tagName: "link", attributes: { rel: "stylesheet", href: "/style.css" } }];
    const page = [{ tagName: "link", attributes: { rel: "stylesheet", href: "/style.css" } }];
    const result = mergeHead(site, [], page);
    const links = result.filter((e) => e.tagName === "link" && e.attributes?.href === "/style.css");
    expect(links).toHaveLength(1);
  });

  test("deduplicates <script> by src", () => {
    const site = [{ tagName: "script", attributes: { src: "/app.js" } }];
    const page = [{ tagName: "script", attributes: { src: "/app.js" } }];
    const result = mergeHead(site, [], page);
    const scripts = result.filter((e) => e.tagName === "script" && e.attributes?.src === "/app.js");
    expect(scripts).toHaveLength(1);
  });

  test("deduplicates <meta property> (Open Graph)", () => {
    const site = [{ tagName: "meta", attributes: { property: "og:title", content: "Site Title" } }];
    const page = [{ tagName: "meta", attributes: { property: "og:title", content: "Page Title" } }];
    const result = mergeHead(site, [], page);
    const og = result.filter((e) => e.attributes?.property === "og:title");
    expect(og).toHaveLength(1);
    expect(og[0].attributes.content).toBe("Page Title");
  });

  test("adds canonical URL when pageUrl and siteUrl provided", () => {
    const result = mergeHead([], [], [], {
      pageUrl: "/about",
      siteUrl: "https://example.com",
    });
    const canonical = result.find((e) => e.tagName === "link" && e.attributes?.rel === "canonical");
    expect(canonical).toBeDefined();
    expect(canonical.attributes.href).toBe("https://example.com/about");
  });

  test("does not add canonical without both URLs", () => {
    const result = mergeHead([], [], [], { pageUrl: "/about" });
    const canonical = result.find((e) => e.tagName === "link" && e.attributes?.rel === "canonical");
    expect(canonical).toBeUndefined();
  });

  test("respects custom charset from context", () => {
    const result = mergeHead([], [], [], { charset: "utf-16" });
    const charset = result.find((e) => e.attributes?.charset);
    expect(charset.attributes.charset).toBe("utf-16");
  });

  test("handles empty arrays gracefully", () => {
    const result = mergeHead([], [], []);
    expect(result.length).toBeGreaterThan(0);
  });

  test("deduplicates <style> tags by content", () => {
    const site = [{ tagName: "style", children: ["body { color: red; }"] }];
    const page = [{ tagName: "style", children: ["body { color: red; }"] }];
    const result = mergeHead(site, [], page);
    const styles = result.filter((e) => e.tagName === "style");
    expect(styles).toHaveLength(1);
  });

  test("keeps distinct <style> tags with different content", () => {
    const site = [{ tagName: "style", children: ["body { color: red; }"] }];
    const page = [{ tagName: "style", children: [".card { padding: 1rem; }"] }];
    const result = mergeHead(site, [], page);
    const styles = result.filter((e) => e.tagName === "style");
    expect(styles).toHaveLength(2);
  });

  test("deduplicates unknown/custom tags by full JSON key", () => {
    const site = [{ tagName: "custom-tag", attributes: { foo: "bar" } }];
    const page = [{ tagName: "custom-tag", attributes: { foo: "bar" } }];
    const result = mergeHead(site, [], page);
    const custom = result.filter((e) => e.tagName === "custom-tag");
    expect(custom).toHaveLength(1);
  });
});

// ─── renderHead ─────────────────────────────────────────────────────────────

describe("renderHead", () => {
  test("renders void elements without closing tags", () => {
    const html = renderHead([{ tagName: "meta", attributes: { charset: "utf-8" } }]);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).not.toContain("</meta>");
  });

  test("renders elements with content", () => {
    const html = renderHead([{ tagName: "title", children: ["My Page"] }]);
    expect(html).toContain("<title>My Page</title>");
  });

  test("renders link elements", () => {
    const html = renderHead([
      { tagName: "link", attributes: { rel: "stylesheet", href: "/style.css" } },
    ]);
    expect(html).toContain('<link rel="stylesheet" href="/style.css">');
  });

  test("renders script elements with src", () => {
    const html = renderHead([{ tagName: "script", attributes: { src: "/app.js" } }]);
    expect(html).toContain('<script src="/app.js"></script>');
  });

  test("handles string entries", () => {
    const html = renderHead(["<!-- custom -->"]);
    expect(html).toContain("<!-- custom -->");
  });

  test("escapes attribute values", () => {
    const html = renderHead([
      { tagName: "meta", attributes: { name: "test", content: 'value with "quotes"' } },
    ]);
    expect(html).toContain("&quot;");
  });

  test("handles boolean attributes", () => {
    const html = renderHead([{ tagName: "script", attributes: { async: true, src: "/app.js" } }]);
    expect(html).toContain("async");
  });
});
