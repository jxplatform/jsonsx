/**
 * A content collection spread over one directory per locale, end to end through a real build.
 *
 * `{locale}` in a `source` had been declared in the spec and read literally by the loader, so a
 * project written the documented way looked for a directory actually named `{locale}` and loaded
 * nothing. Fixing that is only half of it: the interesting half is that two translations of one
 * post **share an id**, so a `[slug]` route that expanded the whole collection would emit each URL
 * twice and let the second overwrite the first. Only a build shows that, because it is the route
 * table — not the loader — where the collision lands.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/site/site-build.ts";

let root = "";
const warnings: string[] = [];

function write(path: string, contents: string) {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function built(path: string): boolean {
  return existsSync(join(root, "dist", path, "index.html"));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jx-localized-collection-"));
  write(
    "project.json",
    JSON.stringify({
      build: { outDir: "./dist" },
      content: { blog: { format: "Markdown", source: "./content/blog/{locale}/" } },
      extensions: ["@jxsuite/parser"],
      i18n: { defaultLocale: "en", locales: ["en", "fr"], routing: "prefix-always" },
      imports: { Markdown: "@jxsuite/parser/Markdown.class.json" },
      name: "Localized",
      url: "https://localized.example",
    }),
  );
  write("pages/en/index.json", JSON.stringify({ children: ["EN"], tagName: "h1", title: "EN" }));
  write("pages/fr/index.json", JSON.stringify({ children: ["FR"], tagName: "h1", title: "FR" }));
  // The page outside the locale tree that `prefix-always` is supposed to notice.
  write("pages/stray.json", JSON.stringify({ children: ["S"], tagName: "p", title: "Stray" }));

  const template = JSON.stringify({
    $paths: { contentType: "blog", field: "id", param: "slug" },
    children: [{ children: ["post"], tagName: "h1" }],
    tagName: "article",
  });
  write("pages/en/blog/[slug].json", template);
  write("pages/fr/blog/[slug].json", template);

  // `hello` exists in both languages and shares its id; `solo` exists only in English.
  write("content/blog/en/hello.md", "---\ntitle: Hello\n---\nEnglish body.\n");
  write("content/blog/fr/hello.md", "---\ntitle: Bonjour\n---\nCorps francais.\n");
  write("content/blog/en/solo.md", "---\ntitle: Solo\n---\nEnglish only.\n");

  const origWarn = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    await buildSite(root, { verbose: false });
  } finally {
    console.warn = origWarn;
  }
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("a {locale} content source", () => {
  it("loads every locale's directory rather than one literally named {locale}", () => {
    expect(built("en/blog/hello")).toBe(true);
    expect(built("fr/blog/hello")).toBe(true);
    expect(built("en/blog/solo")).toBe(true);
  });

  /*
   * The collision, stated directly: `solo` exists only in English, so a French route for it would
   * mean the French template expanded English entries — which is also how `hello` would have been
   * built twice and overwritten.
   */
  it("expands each locale's route from that locale's entries only", () => {
    expect(built("fr/blog/solo")).toBe(false);

    const sitemap = readFileSync(join(root, "dist/sitemap.xml"), "utf8");
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toContain("https://localized.example/en/blog/hello");
    expect(locs).toContain("https://localized.example/fr/blog/hello");
    expect(locs).not.toContain("https://localized.example/fr/blog/solo");
    // Each URL exactly once — a shared id must not produce a duplicate route.
    expect(new Set(locs).size).toBe(locs.length);
  });
});

describe("prefix-always", () => {
  /*
   * The mode promises that every URL names its language. A page outside the tree still builds —
   * the author may mean it — but it can no longer do so silently.
   */
  it("names the routes sitting outside the locale tree", () => {
    const reported = warnings.filter((w) => w.includes("sit outside the locale tree"));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("/stray");
    expect(built("stray")).toBe(true);
  });
});
