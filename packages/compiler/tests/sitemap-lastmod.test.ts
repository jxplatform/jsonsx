/**
 * `<lastmod>` for a route that was generated rather than authored, end to end through a real build.
 *
 * The defect this pins is invisible in a unit test of any single layer. A collection route's
 * `sourcePath` is the `[slug]` template that rendered it, so the sitemap dated every post in an
 * archive by the template — and a template is edited far more often than the posts under it, which
 * means the whole archive announced itself as changed every time. `<lastmod>` exists to say the
 * opposite of that.
 *
 * Three layers have to agree for it to work, and each lives in a different package: the parser's
 * `Content.resolvePaths` carries the entry's `_meta`, the compiler's `$paths` expansion lifts it
 * off the parameters onto the route, and the sitemap prefers it over the template's own mtime. Only
 * a build exercises all three.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/site/site-build.ts";

let root = "";
let sitemap = "";

/** Distinct, in the past, and not "now" — so a passing assertion cannot be a coincidence. */
const FIRST_EDITED = new Date("2024-03-04T05:06:07.000Z");
const SECOND_EDITED = new Date("2021-11-12T13:14:15.000Z");

/** The `<lastmod>` the sitemap gives one URL. */
function lastmodOf(url: string): string | null {
  const block = sitemap.split("<url>").find((chunk) => chunk.includes(`<loc>${url}</loc>`));
  return block?.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? null;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jx-sitemap-lastmod-"));
  mkdirSync(join(root, "pages/posts"), { recursive: true });
  mkdirSync(join(root, "content/posts"), { recursive: true });

  writeFileSync(
    join(root, "project.json"),
    JSON.stringify({
      build: { outDir: "./dist" },
      content: {
        posts: {
          format: "Markdown",
          schema: { properties: { title: { type: "string" } }, type: "object" },
          source: "./content/posts",
        },
      },
      extensions: ["@jxsuite/parser"],
      imports: { Markdown: "@jxsuite/parser/Markdown.class.json" },
      name: "Lastmod Site",
      url: "https://lastmod.example",
    }),
  );
  writeFileSync(
    join(root, "pages/index.json"),
    JSON.stringify({ children: ["home"], tagName: "div" }),
  );
  writeFileSync(
    join(root, "pages/posts/[slug].json"),
    JSON.stringify({
      $paths: { contentType: "posts", field: "id", param: "slug" },
      children: [{ children: ["post"], tagName: "h1" }],
      tagName: "article",
    }),
  );
  writeFileSync(join(root, "content/posts/first.md"), "---\ntitle: First\n---\nA.\n");
  writeFileSync(join(root, "content/posts/second.md"), "---\ntitle: Second\n---\nB.\n");

  // Backdated AFTER writing, so the template stays "now" and the two entries stay distinct.
  utimesSync(join(root, "content/posts/first.md"), FIRST_EDITED, FIRST_EDITED);
  utimesSync(join(root, "content/posts/second.md"), SECOND_EDITED, SECOND_EDITED);

  await buildSite(root, { verbose: false });
  sitemap = readFileSync(join(root, "dist/sitemap.xml"), "utf8");
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("sitemap <lastmod> for generated routes", () => {
  it("dates each collection route by its own entry", () => {
    expect(lastmodOf("https://lastmod.example/posts/first")).toBe("2024-03-04T05:06:07Z");
    expect(lastmodOf("https://lastmod.example/posts/second")).toBe("2021-11-12T13:14:15Z");
  });

  /*
   * The failure mode, stated directly: before the entry timestamp reached the route, both of these
   * were the template's mtime and therefore equal to each other.
   */
  it("does not give two entries the template's single timestamp", () => {
    const first = lastmodOf("https://lastmod.example/posts/first");
    const second = lastmodOf("https://lastmod.example/posts/second");
    expect(first).not.toBe(second);
  });

  // An authored page has no entry behind it, so its own file is still the right answer.
  it("still dates an authored page by its own file", () => {
    const home = lastmodOf("https://lastmod.example/");
    expect(home).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(home).not.toBe("2024-03-04T05:06:07Z");
    expect(home).not.toBe("2021-11-12T13:14:15Z");
  });

  // `_meta` rides along with the parameters and must not become one.
  it("keeps the reserved carrier out of the generated URLs", () => {
    expect(sitemap).not.toContain("_meta");
    expect(sitemap).toContain("<loc>https://lastmod.example/posts/first</loc>");
  });
});
