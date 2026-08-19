/**
 * Feed generation.
 *
 * The serializers take items and return text, so everything here is a literal array — no project,
 * no filesystem. The `emit`/`head` split is exercised through `Feed` itself.
 */

import { describe, expect, test } from "bun:test";
import { Feed } from "../src/feed.ts";
import { renderAtom } from "../src/atom.ts";
import { renderJsonFeed } from "../src/json-feed.ts";
import {
  entryToItem,
  feedUpdated,
  normalizeFeedConfig,
  paginate,
  sortItems,
} from "../src/shared.ts";
import type { FeedItem } from "../src/shared.ts";
import type { ContentLoaderEntry, ProjectConfig } from "@jxsuite/schema/types";

const SITE = "https://example.com";

const SECTION = {
  blog: { basePath: "/blog/", collection: "posts", title: "Example Blog" },
};

const PROJECT = {
  build: { trailingSlash: "always" },
  defaults: { lang: "en" },
  name: "Example",
  url: SITE,
} as unknown as ProjectConfig;

function post(id: string, date: string | null, extra: Record<string, unknown> = {}) {
  return {
    body: `<p>${id}</p>`,
    data: { title: id.toUpperCase(), ...(date === null ? {} : { date }), ...extra },
    id,
  } as unknown as ContentLoaderEntry;
}

function emit(section: unknown, entries: ContentLoaderEntry[]) {
  return Feed.emit(section, {
    projectConfig: PROJECT,
    sections: { content: new Map([["posts", entries]]) },
  });
}

describe("configuration", () => {
  test("defaults are applied and the collection falls back to the key", () => {
    const cfg = normalizeFeedConfig({ posts: { basePath: "/p" } }, "fr");
    expect(cfg.posts).toMatchObject({
      archive: false,
      basePath: "/p/",
      collection: "posts",
      contentMode: "summary",
      formats: ["atom", "json"],
      language: "fr",
      output: "/feed",
      pageSize: 20,
    });
  });

  test("a non-object section yields nothing", () => {
    expect(normalizeFeedConfig(null)).toEqual({});
    expect(normalizeFeedConfig({ blog: "nope" })).toEqual({});
  });
});

describe("items", () => {
  test("an entry becomes an item with an absolute URL and its own id", () => {
    const item = entryToItem(
      post("hello", "2025-03-04"),
      normalizeFeedConfig(SECTION).blog!,
      SITE,
      "always",
    );
    expect(item.url).toBe("https://example.com/blog/hello/");
    expect(item.id).toBe(item.url);
    expect(item.published).toBe("2025-03-04T00:00:00Z");
  });

  test("trailingSlash: never drops the slash, matching the route table", () => {
    const item = entryToItem(
      post("hello", "2025-03-04"),
      normalizeFeedConfig(SECTION).blog!,
      SITE,
      "never",
    );
    expect(item.url).toBe("https://example.com/blog/hello");
  });

  test("_meta.mtime is the fallback when the frontmatter carries no date", () => {
    const entry = post("hello", null);
    entry._meta = { mtime: "2024-01-02T03:04:05Z" };
    const item = entryToItem(entry, normalizeFeedConfig(SECTION).blog!, SITE, "always");
    expect(item.published).toBe("2024-01-02T03:04:05Z");
  });

  /* A feed date that is not a real timestamp is worse than an absent one — a reader believes it. */
  test("an unreadable date becomes null rather than a guess", () => {
    const item = entryToItem(
      post("hello", "03/04/2025"),
      normalizeFeedConfig(SECTION).blog!,
      SITE,
      "always",
    );
    expect(item.published).toBeNull();
  });

  test("newest first, undated last, ties broken by id", () => {
    const items = sortItems([
      { id: "b", published: null } as FeedItem,
      { id: "a", published: "2025-01-01T00:00:00Z" } as FeedItem,
      { id: "c", published: "2025-06-01T00:00:00Z" } as FeedItem,
      { id: "a2", published: null } as FeedItem,
    ]);
    expect(items.map((i) => i.id)).toEqual(["c", "a", "a2", "b"]);
  });

  test("the feed timestamp is the newest item, never the build time", () => {
    expect(
      feedUpdated([
        { published: "2025-01-01T00:00:00Z", updated: null } as FeedItem,
        { published: "2025-01-01T00:00:00Z", updated: "2025-09-09T00:00:00Z" } as FeedItem,
      ]),
    ).toBe("2025-09-09T00:00:00Z");
    expect(feedUpdated([])).toBeNull();
  });
});

describe("Atom (RFC 4287)", () => {
  const files = () => emit(SECTION, [post("a", "2025-01-01"), post("b", "2025-06-01")]);

  test("emits both formats at the configured paths", () => {
    expect(
      files()
        .map((f) => f.path)
        .toSorted(),
    ).toEqual(["/feed.json", "/feed.xml"]);
  });

  test("carries the required id, title, updated and self link", () => {
    const xml = files().find((f) => f.path === "/feed.xml")!.content;
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(xml).toContain("<id>https://example.com/feed.xml</id>");
    expect(xml).toContain("<title>Example Blog</title>");
    expect(xml).toContain("<updated>2025-06-01T00:00:00Z</updated>");
    expect(xml).toContain('<link rel="self" href="https://example.com/feed.xml"');
  });

  test("entries are newest first and carry their own id and timestamps", () => {
    const xml = files().find((f) => f.path === "/feed.xml")!.content;
    expect(xml.indexOf("/blog/b/")).toBeLessThan(xml.indexOf("/blog/a/"));
    expect(xml).toContain("<published>2025-06-01T00:00:00Z</published>");
  });

  test("escapes markup in authored text", () => {
    const xml = emit(SECTION, [post("x", "2025-01-01", { title: "A & B <c>" })]).find(
      (f) => f.path === "/feed.xml",
    )!.content;
    expect(xml).toContain("A &amp; B &lt;c&gt;");
    expect(xml).not.toContain("<c>");
  });

  test("contentMode full emits the body; summary does not", () => {
    const full = emit({ blog: { ...SECTION.blog, contentMode: "full" } }, [
      post("x", "2025-01-01"),
    ]).find((f) => f.path === "/feed.xml")!.content;
    expect(full).toContain('<content type="html">');
    const summary = emit(SECTION, [post("x", "2025-01-01")]).find(
      (f) => f.path === "/feed.xml",
    )!.content;
    expect(summary).not.toContain("<content");
  });
});

describe("authors and modification times", () => {
  const AUTHORED = {
    blog: {
      ...SECTION.blog,
      author: { email: "hi@example.com", name: "Ada", uri: "https://ada.example" },
    },
  };

  test("a feed-level author carries name, uri and email into Atom", () => {
    const xml = emit(AUTHORED, [post("a", "2025-01-01")]).find(
      (f) => f.path === "/feed.xml",
    )!.content;
    expect(xml).toContain("<name>Ada</name>");
    expect(xml).toContain("<uri>https://ada.example</uri>");
    expect(xml).toContain("<email>hi@example.com</email>");
  });

  test("a feed-level author reaches JSON Feed as `authors`, the 1.1 spelling", () => {
    const files = emit(AUTHORED, [post("a", "2025-01-01")]);
    const json = JSON.parse(files.find((f) => f.path === "/feed.json")!.content);
    expect(json.authors).toEqual([{ name: "Ada" }]);
    expect(json.author).toBeUndefined();
  });

  test("a per-entry author overrides the feed's", () => {
    const files = emit(AUTHORED, [post("a", "2025-01-01", { author: "Grace" })]);
    const json = JSON.parse(files.find((f) => f.path === "/feed.json")!.content);
    expect(json.items[0].authors).toEqual([{ name: "Grace" }]);
  });

  test("date_modified appears only when it differs from date_published", () => {
    const changed = emit(SECTION, [
      post("a", "2025-01-01", { description: "S", updated: "2025-02-02T00:00:00Z" }),
    ]);
    const json = JSON.parse(changed.find((f) => f.path === "/feed.json")!.content);
    expect(json.items[0].date_modified).toBe("2025-02-02T00:00:00Z");
    expect(json.items[0].summary).toBe("S");

    const same = emit(SECTION, [post("b", "2025-01-01")]);
    const unchanged = JSON.parse(same.find((f) => f.path === "/feed.json")!.content);
    expect(unchanged.items[0].date_modified).toBeUndefined();
    expect(unchanged.items[0].summary).toBeUndefined();
  });
});

describe("RFC 5005", () => {
  const many = Array.from({ length: 7 }, (_, i) => post(`p${i}`, `2025-01-0${i + 1}T00:00:00Z`));

  test("a complete feed says so, and only when nothing is missing", () => {
    const small = emit(SECTION, [post("a", "2025-01-01")]).find((f) => f.path === "/feed.xml")!;
    expect(small.content).toContain("<fh:complete/>");
    expect(small.content).toContain('xmlns:fh="http://purl.org/syndication/history/1.0"');

    // `pageSize` trims the feed, so it is NOT complete even with no archives.
    const trimmed = emit({ blog: { ...SECTION.blog, pageSize: 2 } }, many).find(
      (f) => f.path === "/feed.xml",
    )!;
    expect(trimmed.content).not.toContain("fh:complete");
  });

  test("archives are emitted oldest-first and linked in both directions", () => {
    const files = emit({ blog: { ...SECTION.blog, archive: true, pageSize: 3 } }, many);
    const paths = files.map((f) => f.path).filter((p) => p.endsWith(".xml"));
    expect(paths).toContain("/feed.xml");
    expect(paths).toContain("/feed/archive/1.xml");
    expect(paths).toContain("/feed/archive/2.xml");

    const current = files.find((f) => f.path === "/feed.xml")!.content;
    expect(current).toContain('rel="prev-archive"');
    expect(current).not.toContain("fh:complete");

    const oldest = files.find((f) => f.path === "/feed/archive/1.xml")!.content;
    expect(oldest).toContain('rel="current" href="https://example.com/feed.xml"');
    expect(oldest).toContain('rel="next-archive"');
    // The oldest page has nothing before it.
    expect(oldest).not.toContain('rel="prev-archive"');
  });

  test("paginate keeps the newest page current and the rest oldest-first", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `i${i}` }) as FeedItem);
    const { archives, current } = paginate(items, 2);
    expect(current.map((i) => i.id)).toEqual(["i0", "i1"]);
    // Archive 1 is the oldest and stays put as entries are added; only the newest one grows.
    expect(archives.map((p) => p.map((i) => i.id))).toEqual([["i3", "i4"], ["i2"]]);
  });

  // A feed that fits on one page has no archive: paging it would publish empty pages to subscribe to.
  test("a feed no longer than one page is all current and has no archives", () => {
    const items = Array.from({ length: 2 }, (_, i) => ({ id: `i${i}` }) as FeedItem);
    expect(paginate(items, 5)).toEqual({ archives: [], current: [items[0]!, items[1]!] });
    expect(paginate(items, 2).archives).toEqual([]);
    expect(paginate([], 2)).toEqual({ archives: [], current: [] });
  });
});

describe("JSON Feed 1.1", () => {
  test("carries the version, feed_url, language and items", () => {
    const json = JSON.parse(
      emit(SECTION, [post("a", "2025-01-01")]).find((f) => f.path === "/feed.json")!.content,
    );
    expect(json.version).toBe("https://jsonfeed.org/version/1.1");
    expect(json.feed_url).toBe("https://example.com/feed.json");
    expect(json.home_page_url).toBe("https://example.com/blog/");
    expect(json.language).toBe("en");
    expect(json.items).toHaveLength(1);
    expect(json.items[0].id).toBe("https://example.com/blog/a/");
  });

  test("an item always carries content_html or content_text (1.1 requires one)", () => {
    const summary = JSON.parse(
      emit(SECTION, [post("a", "2025-01-01")]).find((f) => f.path === "/feed.json")!.content,
    );
    expect(summary.items[0].content_text).toBeDefined();
    const fullFiles = emit({ blog: { ...SECTION.blog, contentMode: "full" } }, [
      post("a", "2025-01-01"),
    ]);
    const full = JSON.parse(fullFiles.find((f) => f.path === "/feed.json")!.content);
    expect(full.items[0].content_html).toBe("<p>a</p>");
  });

  test("optional keys are absent rather than null", () => {
    const text = renderJsonFeed({
      feed: normalizeFeedConfig({ blog: { basePath: "/b/" } }).blog!,
      items: [],
      selfUrl: `${SITE}/feed.json`,
      siteUrl: SITE,
    });
    expect(text).not.toContain("null");
    expect(JSON.parse(text).language).toBeUndefined();
  });
});

describe("the head capability", () => {
  test("contributes one alternate link per format, typed and titled", () => {
    const entries = Feed.head(SECTION, { projectConfig: PROJECT });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.attributes!.type).toSorted()).toEqual([
      "application/atom+xml",
      "application/feed+json",
    ]);
    expect(entries[0]!.attributes!.rel).toBe("alternate");
    expect(entries[0]!.attributes!.href).toBe("https://example.com/feed.xml");
  });

  /*
   * Both links are `rel="alternate"` at the same `rel` and different `href` and `type`. Before the
   * head-merger keyed on type, the second would have replaced the first.
   */
  test("the two links differ in a way the head merger can see", () => {
    const entries = Feed.head(SECTION, { projectConfig: PROJECT });
    const keys = entries.map(
      (e) => `${e.attributes!.rel}:${e.attributes!.href}:${e.attributes!.type}`,
    );
    expect(new Set(keys).size).toBe(2);
  });

  test("contributes nothing without a site url — a feed needs absolute links", () => {
    expect(Feed.head(SECTION, { projectConfig: { name: "x" } as ProjectConfig })).toEqual([]);
  });
});

describe("failure modes", () => {
  test("a feed naming an unloaded collection is skipped, not fatal", () => {
    const files = Feed.emit(
      { blog: { basePath: "/blog/", collection: "nope" } },
      { projectConfig: PROJECT, sections: { content: new Map() } },
    );
    expect(files).toEqual([]);
  });

  test("no site url means no feed", () => {
    const content = new Map([["posts", [post("a", "2025-01-01")]]]);
    const files = Feed.emit(SECTION, {
      projectConfig: { name: "x" } as ProjectConfig,
      sections: { content },
    });
    expect(files).toEqual([]);
  });

  test("projectData normalizes for _project.feed", () => {
    const normalized = Feed.projectData(SECTION, { projectConfig: PROJECT });
    expect(normalized.blog!.collection).toBe("posts");
  });

  test("an empty feed still renders a valid document", () => {
    const xml = renderAtom({
      feed: normalizeFeedConfig({ blog: { basePath: "/b/" } }).blog!,
      items: [],
      selfUrl: `${SITE}/feed.xml`,
      siteUrl: SITE,
      updated: null,
    });
    expect(xml).toContain("<updated>1970-01-01T00:00:00Z</updated>");
    expect(xml).toContain("</feed>");
  });
});

// ─── One feed per language ──────────────────────────────────────────────────

/*
 * A collection spread over one directory per locale (site-architecture.md §13.3) is several feeds,
 * not one. A single feed mixing three languages is worse than it sounds: a reader subscribes in
 * theirs and receives every post three times, twice in a language they do not read.
 */
describe("a localized collection", () => {
  const LOCALIZED_PROJECT = {
    content: { blog: { format: "Markdown", source: "./content/blog/{locale}/" } },
    i18n: { defaultLocale: "en", locales: ["en", "fr-ca"] },
    url: "https://x.example",
  };
  const LOCALIZED_SECTION = { blog: { basePath: "/blog/", collection: "blog", title: "Journal" } };
  const ENTRIES = [
    {
      _meta: { locale: "en" },
      body: "",
      data: { date: "2026-01-02", title: "Hello" },
      id: "hello",
    },
    {
      _meta: { locale: "fr-ca" },
      body: "",
      data: { date: "2026-01-02", title: "Bonjour" },
      id: "hello",
    },
  ] as unknown as ContentLoaderEntry[];

  const emitted = () =>
    Feed.emit(LOCALIZED_SECTION, {
      projectConfig: LOCALIZED_PROJECT as never,
      sections: { content: new Map([["blog", ENTRIES]]) },
    });

  test("publishes one feed per locale, in that locale's URL space", () => {
    expect(
      emitted()
        .map((f) => f.path)
        .toSorted(),
    ).toEqual(["/feed.json", "/feed.xml", "/fr-ca/feed.json", "/fr-ca/feed.xml"]);
  });

  test("each feed holds only its own language's entries, at its own URLs", () => {
    const french = emitted().find((f) => f.path === "/fr-ca/feed.xml")!.content;
    expect(french).toContain("<title>Bonjour</title>");
    expect(french).not.toContain("<title>Hello</title>");
    expect(french).toContain("https://x.example/fr-ca/blog/hello/");
  });

  // RFC 4287 §2: `xml:lang` on the feed element, inherited by every child. JSON Feed says the same
  // Thing with `language`.
  // The tag is canonical (`fr-CA`) while the directory is lowercase (`/fr-ca/`): one is a language
  // Attribute, the other is a URL, and each follows its own convention.
  test("each feed states the language it carries", () => {
    expect(emitted().find((f) => f.path === "/fr-ca/feed.xml")!.content).toContain(
      'xml:lang="fr-CA"',
    );
    const json = JSON.parse(emitted().find((f) => f.path === "/fr-ca/feed.json")!.content) as {
      language?: string;
    };
    expect(json.language).toBe("fr-CA");
  });

  /*
   * `head` runs before routing and cannot know which locale its page is in, so it advertises every
   * feed and lets the client choose — which is what `hreflang` on an `alternate` link is for.
   */
  test("discovery advertises each language's feed by hreflang", () => {
    const links = Feed.head(LOCALIZED_SECTION, { projectConfig: LOCALIZED_PROJECT as never });
    expect(links.map((l) => [l.attributes?.hreflang, l.attributes?.href]).toSorted()).toEqual([
      ["en", "https://x.example/feed.json"],
      ["en", "https://x.example/feed.xml"],
      ["fr-CA", "https://x.example/fr-ca/feed.json"],
      ["fr-CA", "https://x.example/fr-ca/feed.xml"],
    ]);
  });

  // A project whose collection is not localized keeps exactly what it had: one feed, no hreflang.
  test("an unlocalized collection is untouched", () => {
    const plain = Feed.head(LOCALIZED_SECTION, {
      projectConfig: { url: "https://x.example" } as never,
    });
    expect(plain.every((l) => l.attributes?.hreflang === undefined)).toBe(true);
  });
});
