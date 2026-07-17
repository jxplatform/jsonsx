import { describe, expect, test } from "bun:test";
import { mergeHead, renderHead } from "../src/site/head-merger";

// ─── mergeHead ──────────────────────────────────────────────────────────────

describe("mergeHead", () => {
  test("auto-injects charset and viewport defaults", () => {
    const result = mergeHead() as any[];
    const charsetEntry = result.find(
      (e) => e.tagName === "meta" && e.attributes?.charset === "utf8",
    );
    const viewportEntry = result.find((e) => e.attributes?.name === "viewport");
    expect(charsetEntry).toBeDefined();
    expect(viewportEntry).toBeDefined();
  });

  test("injects title from context", () => {
    const result = mergeHead([], [], [], { title: "My Page" }) as any[];
    const titleEntry = result.find((e) => e.tagName === "title");
    expect(titleEntry).toBeDefined();
    expect((titleEntry as any).children).toEqual(["My Page"]);
  });

  test("uses siteName as fallback title", () => {
    const result = mergeHead([], [], [], { siteName: "Jx Site" }) as any[];
    const titleEntry = result.find((e) => e.tagName === "title");
    expect((titleEntry as any).children).toEqual(["Jx Site"]);
  });

  test("later layers override earlier ones (page > layout > site)", () => {
    const site = [
      {
        attributes: { content: "Site desc", name: "description" },
        tagName: "meta",
      },
    ];
    const layout: any[] = [];
    const page = [
      {
        attributes: { content: "Page desc", name: "description" },
        tagName: "meta",
      },
    ];
    const result = mergeHead(site, layout, page) as any[];
    const desc = result.find((e) => e.attributes?.name === "description");
    expect((desc as any).attributes.content).toBe("Page desc");
  });

  test("deduplicates <meta charset>", () => {
    const site = [{ attributes: { charset: "utf8" }, tagName: "meta" }];
    const page = [{ attributes: { charset: "utf-16" }, tagName: "meta" }];
    const result = mergeHead(site, [], page) as any[];
    const charsets = result.filter((e) => e.attributes?.charset);
    expect(charsets).toHaveLength(1);
    expect((charsets[0] as any).attributes.charset).toBe("utf-16");
  });

  test("deduplicates <link> by rel+href", () => {
    const site = [
      {
        attributes: { href: "/style.css", rel: "stylesheet" },
        tagName: "link",
      },
    ];
    const page = [
      {
        attributes: { href: "/style.css", rel: "stylesheet" },
        tagName: "link",
      },
    ];
    const result = mergeHead(site, [], page) as any[];
    const links = result.filter((e) => e.tagName === "link" && e.attributes?.href === "/style.css");
    expect(links).toHaveLength(1);
  });

  test("deduplicates <script> by src", () => {
    const site = [{ attributes: { src: "/app.js" }, tagName: "script" }];
    const page = [{ attributes: { src: "/app.js" }, tagName: "script" }];
    const result = mergeHead(site, [], page) as any[];
    const scripts = result.filter((e) => e.tagName === "script" && e.attributes?.src === "/app.js");
    expect(scripts).toHaveLength(1);
  });

  test("deduplicates <meta property> (Open Graph)", () => {
    const site = [
      {
        attributes: { content: "Site Title", property: "og:title" },
        tagName: "meta",
      },
    ];
    const page = [
      {
        attributes: { content: "Page Title", property: "og:title" },
        tagName: "meta",
      },
    ];
    const result = mergeHead(site, [], page) as any[];
    const og = result.filter((e) => e.attributes?.property === "og:title");
    expect(og).toHaveLength(1);
    expect((og[0] as any).attributes.content).toBe("Page Title");
  });

  test("adds canonical URL when pageUrl and siteUrl provided", () => {
    const result = mergeHead([], [], [], {
      pageUrl: "/about",
      siteUrl: "https://example.com",
    }) as any[];
    const canonical = result.find((e) => e.tagName === "link" && e.attributes?.rel === "canonical");
    expect(canonical).toBeDefined();
    expect((canonical as any).attributes.href).toBe("https://example.com/about");
  });

  test("does not add canonical without both URLs", () => {
    const result = mergeHead([], [], [], { pageUrl: "/about" }) as any[];
    const canonical = result.find((e) => e.tagName === "link" && e.attributes?.rel === "canonical");
    expect(canonical).toBeUndefined();
  });

  test("auto-adds og:url and og:site_name", () => {
    const result = mergeHead([], [], [], {
      pageUrl: "/about",
      siteName: "Example Site",
      siteUrl: "https://example.com",
    }) as any[];
    const ogUrl = result.find((e) => e.attributes?.property === "og:url");
    const ogSite = result.find((e) => e.attributes?.property === "og:site_name");
    expect((ogUrl as any).attributes.content).toBe("https://example.com/about");
    expect((ogSite as any).attributes.content).toBe("Example Site");
  });

  test("author-supplied og:url and og:site_name win over auto values", () => {
    const page = [
      {
        attributes: { content: "https://canonical.example/", property: "og:url" },
        tagName: "meta",
      },
      {
        attributes: { content: "Custom Name", property: "og:site_name" },
        tagName: "meta",
      },
    ];
    const result = mergeHead([], [], page, {
      pageUrl: "/about",
      siteName: "Example Site",
      siteUrl: "https://example.com",
    }) as any[];
    const ogUrl = result.filter((e) => e.attributes?.property === "og:url");
    const ogSite = result.filter((e) => e.attributes?.property === "og:site_name");
    expect(ogUrl).toHaveLength(1);
    expect((ogUrl[0] as any).attributes.content).toBe("https://canonical.example/");
    expect(ogSite).toHaveLength(1);
    expect((ogSite[0] as any).attributes.content).toBe("Custom Name");
  });

  test("respects custom charset from context", () => {
    const result = mergeHead([], [], [], { charset: "utf-16" }) as any[];
    const charset = result.find((e) => e.attributes?.charset);
    expect((charset as any).attributes.charset).toBe("utf-16");
  });

  test("handles empty arrays gracefully", () => {
    const result = mergeHead([], [], []);
    expect(result.length).toBeGreaterThan(0);
  });

  test("deduplicates <style> tags by content", () => {
    const site = [{ children: ["body { color: red; }"], tagName: "style" }];
    const page = [{ children: ["body { color: red; }"], tagName: "style" }];
    const result = mergeHead(site, [], page) as any[];
    const styles = result.filter((e) => e.tagName === "style");
    expect(styles).toHaveLength(1);
  });

  test("keeps distinct <style> tags with different content", () => {
    const site = [{ children: ["body { color: red; }"], tagName: "style" }];
    const page = [{ children: [".card { padding: 1rem; }"], tagName: "style" }];
    const result = mergeHead(site, [], page) as any[];
    const styles = result.filter((e) => e.tagName === "style");
    expect(styles).toHaveLength(2);
  });

  test("deduplicates unknown/custom tags by full JSON key", () => {
    const site = [{ attributes: { foo: "bar" }, tagName: "custom-tag" }];
    const page = [{ attributes: { foo: "bar" }, tagName: "custom-tag" }];
    const result = mergeHead(site, [], page) as any[];
    const custom = result.filter((e) => e.tagName === "custom-tag");
    expect(custom).toHaveLength(1);
  });
});

// ─── renderHead ─────────────────────────────────────────────────────────────

describe("renderHead", () => {
  test("renders void elements without closing tags", () => {
    const html = renderHead([{ attributes: { charset: "utf8" }, tagName: "meta" }]);
    expect(html).toContain('<meta charset="utf8">');
    expect(html).not.toContain("</meta>");
  });

  test("renders elements with content", () => {
    const html = renderHead([{ children: ["My Page"], tagName: "title" }]);
    expect(html).toContain("<title>My Page</title>");
  });

  test("renders link elements", () => {
    const html = renderHead([
      {
        attributes: { href: "/style.css", rel: "stylesheet" },
        tagName: "link",
      },
    ]);
    expect(html).toContain('<link href="/style.css" rel="stylesheet">');
  });

  test("renders script elements with src", () => {
    const html = renderHead([{ attributes: { src: "/app.js" }, tagName: "script" }]);
    expect(html).toContain('<script src="/app.js"></script>');
  });

  test("handles string entries", () => {
    const html = renderHead(["<!-- custom -->" as any]);
    expect(html).toContain("<!-- custom -->");
  });

  test("escapes attribute values", () => {
    const html = renderHead([
      {
        attributes: { content: 'value with "quotes"', name: "test" },
        tagName: "meta",
      },
    ]);
    expect(html).toContain("&quot;");
  });

  test("handles boolean attributes", () => {
    const html = renderHead([{ attributes: { async: true, src: "/app.js" }, tagName: "script" }]);
    expect(html).toContain("async");
  });
});
