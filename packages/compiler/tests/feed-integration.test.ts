/**
 * Feeds, end to end through a real build.
 *
 * This is the one test that exercises the whole chain rather than a unit of it: the parser coerces
 * a frontmatter date, `@jxsuite/feed`'s `head` capability contributes discovery links before the
 * first page is built, its `emit` writes the documents after the last one, and the headers emitter
 * names their content types. Each half is unit-tested in its own workspace; only here do they
 * meet.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/site/site-build.ts";

let root = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jx-feed-e2e-"));
  mkdirSync(join(root, "pages"), { recursive: true });
  mkdirSync(join(root, "content/posts"), { recursive: true });
  writeFileSync(
    join(root, "project.json"),
    JSON.stringify({
      build: { outDir: "./dist" },
      content: {
        posts: {
          format: "Markdown",
          schema: {
            properties: { date: { format: "date", type: "string" }, title: { type: "string" } },
            type: "object",
          },
          source: "./content/posts",
        },
      },
      extensions: ["@jxsuite/parser", "@jxsuite/feed"],
      feed: { blog: { basePath: "/blog/", collection: "posts", title: "Feed Site Blog" } },
      imports: { Markdown: "@jxsuite/parser/Markdown.class.json" },
      name: "Feed Site",
      url: "https://feeds.example",
    }),
  );
  writeFileSync(
    join(root, "pages/index.json"),
    JSON.stringify({ children: ["home"], tagName: "div" }),
  );
  writeFileSync(
    join(root, "content/posts/first.md"),
    "---\ntitle: First\ndate: 2025-01-02\n---\nA.\n",
  );
  writeFileSync(
    join(root, "content/posts/second.md"),
    "---\ntitle: Second\ndate: 2025-06-02\n---\nB.\n",
  );
  await buildSite(root, { verbose: false });
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("feeds through a real build", () => {
  it("emits both documents", () => {
    expect(existsSync(join(root, "dist/feed.xml"))).toBe(true);
    expect(existsSync(join(root, "dist/feed.json"))).toBe(true);
  });

  it("takes its timestamps from the coerced frontmatter dates", () => {
    // The parser normalized `2025-06-02` to an instant; the feed did not have to guess.
    expect(read("dist/feed.xml")).toContain("<updated>2025-06-02T00:00:00Z</updated>");
    expect(read("dist/feed.xml")).toContain("<published>2025-01-02T00:00:00Z</published>");
  });

  /*
   * BOTH links survive. They share `rel="alternate"` and differ only in `href` and `type`, so
   * before the head merger keyed on the qualifying attribute the second replaced the first and a
   * site could advertise only one of its two feeds.
   */
  it("advertises both feeds in <head> via the head capability", () => {
    const html = read("dist/index.html");
    expect(html).toContain('href="https://feeds.example/feed.xml"');
    expect(html).toContain('href="https://feeds.example/feed.json"');
    expect(html.match(/rel="alternate"/g)).toHaveLength(2);
  });

  it("names the content types no host would infer", () => {
    const headers = read("dist/_headers");
    expect(headers).toContain("Content-Type: application/atom+xml; charset=utf-8");
    expect(headers).toContain("Content-Type: application/feed+json; charset=utf-8");
  });

  it("entry URLs match how the route table spells them", () => {
    expect(read("dist/feed.xml")).toContain("<id>https://feeds.example/blog/second/</id>");
  });
});
