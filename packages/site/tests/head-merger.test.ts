import { describe, expect, test } from "bun:test";
import { mergeHead, renderHead } from "../src/head-merger.ts";
import type { JxHeadEntry } from "@jxsuite/schema/types";

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

// ─── Link identity ──────────────────────────────────────────────────────────

/*
 * `rel` + `href` is not identity. These are the four cases where it is not, and the first two are
 * the reason feeds and locale alternates could not be emitted at all.
 */
describe("link deduplication", () => {
  const links = (entries: JxHeadEntry[]) =>
    (mergeHead([], [], entries) as JxHeadEntry[]).filter((e) => e.tagName === "link");

  test("two alternates sharing an href but differing in hreflang both survive", () => {
    // `x-default` conventionally points at the SAME href as the default locale's alternate.
    const out = links([
      { attributes: { href: "https://x/", hreflang: "en", rel: "alternate" }, tagName: "link" },
      {
        attributes: { href: "https://x/", hreflang: "x-default", rel: "alternate" },
        tagName: "link",
      },
    ]);
    expect(out).toHaveLength(2);
  });

  test("an RSS and an Atom feed both survive — they differ only in type", () => {
    const out = links([
      {
        attributes: { href: "/feed", rel: "alternate", type: "application/rss+xml" },
        tagName: "link",
      },
      {
        attributes: { href: "/feed", rel: "alternate", type: "application/atom+xml" },
        tagName: "link",
      },
    ]);
    expect(out).toHaveLength(2);
  });

  test("icons differing only in sizes both survive", () => {
    const out = links([
      { attributes: { href: "/i.png", rel: "icon", sizes: "16x16" }, tagName: "link" },
      { attributes: { href: "/i.png", rel: "icon", sizes: "32x32" }, tagName: "link" },
    ]);
    expect(out).toHaveLength(2);
  });

  test("a genuine duplicate still collapses", () => {
    const out = links([
      { attributes: { href: "/a.css", rel: "stylesheet" }, tagName: "link" },
      { attributes: { href: "/a.css", rel: "stylesheet" }, tagName: "link" },
    ]);
    expect(out).toHaveLength(1);
  });

  /*
   * The auto-canonical used a hand-written key `headEntryKey` never produces, so it landed under a
   * different key than an author's own canonical and the page got BOTH — the one thing a canonical
   * link must not be.
   */
  test("an author-supplied canonical replaces the auto one rather than joining it", () => {
    const out = links([
      { attributes: { href: "https://mine.example/x", rel: "canonical" }, tagName: "link" },
    ]).filter((e) => e.attributes?.rel === "canonical");
    const merged = (
      mergeHead(
        [],
        [],
        [{ attributes: { href: "https://mine.example/x", rel: "canonical" }, tagName: "link" }],
        { pageUrl: "/x", siteUrl: "https://auto.example" },
      ) as JxHeadEntry[]
    ).filter((e) => e.tagName === "link" && e.attributes?.rel === "canonical");
    expect(out).toHaveLength(1);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.attributes!.href).toBe("https://mine.example/x");
  });

  test("the canonical is still auto-injected when the page declares none", () => {
    const merged = (
      mergeHead([], [], [], { pageUrl: "/x", siteUrl: "https://auto.example" }) as JxHeadEntry[]
    ).filter((e) => e.tagName === "link" && e.attributes?.rel === "canonical");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.attributes!.href).toBe("https://auto.example/x");
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

describe("structured data (§8.5)", () => {
  test("an object textContent is serialized to JSON, not stringified to [object Object]", () => {
    const html = renderHead([
      {
        attributes: { type: "application/ld+json" },
        tagName: "script",
        textContent: { "@context": "https://schema.org", "@type": "BlogPosting", headline: "Hi" },
      },
    ]);
    expect(html).not.toContain("[object Object]");
    expect(html).toContain('"@type": "BlogPosting"');
    const body = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>"));
    expect(JSON.parse(body)).toEqual({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "Hi",
    });
  });

  test("a string textContent is still emitted verbatim", () => {
    const html = renderHead([{ tagName: "script", textContent: '{"a":1}' }]);
    expect(html).toContain('<script>{"a":1}</script>');
  });
});

// ─── Cases the compiler's own suite reached indirectly ───────────────────────

describe("mergeHead singletons and alternates", () => {
  test("a <title> is a singleton, and the resolved one is what survives", () => {
    /* Three levels may each author a title; exactly one element comes out, and it carries the
       title the build already resolved rather than whichever level happened to be merged last. */
    const result = mergeHead(
      [{ children: ["Site"], tagName: "title" }],
      [{ children: ["Layout"], tagName: "title" }],
      [{ children: ["Page"], tagName: "title" }],
    ) as any[];
    const titles = result.filter((entry) => entry.tagName === "title");
    expect(titles).toHaveLength(1);
    expect(titles[0].children).toEqual(["Jx Site"]);
  });

  test("the resolved page title outranks a <title> any level authored", () => {
    /* `context.title` is the answer the build already worked out — the page's `title`, else the
       layout's, else the site name — so it is applied last on purpose. */
    const result = mergeHead([], [], [{ children: ["Page"], tagName: "title" }], {
      title: "Resolved",
    }) as any[];
    const titles = result.filter((entry) => entry.tagName === "title");
    expect(titles).toHaveLength(1);
    expect(titles[0].children).toEqual(["Resolved"]);
  });

  test("an author charset replaces the auto-injected one rather than joining it", () => {
    const result = mergeHead([{ attributes: { charset: "iso-8859-1" }, tagName: "meta" }]) as any[];
    const charsets = result.filter((entry) => entry.attributes?.charset);
    expect(charsets).toHaveLength(1);
    expect(charsets[0].attributes.charset).toBe("iso-8859-1");
  });

  test("a malformed entry is keyed by its own value rather than crashing the merge", () => {
    const result = mergeHead([null as any, "junk" as any, null as any]) as any[];
    expect(result.filter((entry) => entry === null)).toHaveLength(1);
  });

  test("alternates become one link each, keyed by hreflang", () => {
    const result = mergeHead([], [], [], {
      alternates: [
        { href: "https://example.com/", hreflang: "en" },
        { href: "https://example.com/fr/", hreflang: "fr" },
        { href: "https://example.com/", hreflang: "x-default" },
      ],
    }) as any[];
    const alternates = result.filter((entry) => entry.attributes?.rel === "alternate");
    expect(alternates.map((entry) => entry.attributes.hreflang)).toEqual(["en", "fr", "x-default"]);
  });

  test("an author-supplied alternate for the same link wins", () => {
    /* Identity for a link is rel + href + the attribute that distinguishes two links sharing both,
       so this is the same entry — and the generated one must not displace it. */
    const authored = {
      attributes: { href: "/fr/", hreflang: "fr", rel: "alternate", title: "Français" },
      tagName: "link",
    };
    const result = mergeHead([], [], [authored], {
      alternates: [{ href: "/fr/", hreflang: "fr" }],
    }) as any[];
    const alternates = result.filter((entry) => entry.attributes?.rel === "alternate");
    expect(alternates).toHaveLength(1);
    expect(alternates[0].attributes.title).toBe("Français");
  });
});
