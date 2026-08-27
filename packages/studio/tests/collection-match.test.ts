/**
 * Tests for src/content/collection-match.ts — the ONE answer to "which collection owns this path".
 *
 * Every case here is a disagreement between the three matchers this replaced, and each one is a
 * wrong answer somebody can see: a co-located media folder read as a locale root, a creation into a
 * directory literally named `{locale}`, a picker locked to an extension the collection does not
 * use.
 */
import "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { setFormats } from "../src/format/format-host";
import { collectionForDirectory, collectionForFile } from "../src/content/collection-match";
import { MARKDOWN_FORMAT } from "./format-fixture";
import type { ProjectConfig } from "@jxsuite/schema/types";

const MD = { format: "Markdown", schema: { properties: {} }, source: "./content/posts/" };

function config(content: Record<string, unknown>, i18n?: unknown): ProjectConfig {
  return { content, ...(i18n === undefined ? {} : { i18n }) } as unknown as ProjectConfig;
}

beforeEach(() => {
  setFormats([MARKDOWN_FORMAT]);
});

describe("directory membership", () => {
  test("the source root itself, and any directory beneath it", () => {
    const cfg = config({ posts: MD });
    expect(collectionForDirectory("content/posts", cfg)).toMatchObject({
      dir: "content/posts",
      ext: ".md",
      isSourceRoot: true,
      name: "posts",
    });
    // Discovery is recursive — `Markdown.discover` walks with `readdirSync(recursive: true)` — so a
    // Document here is an entry, and the caller needs to know it is not the root.
    expect(collectionForDirectory("content/posts/2026", cfg)).toMatchObject({
      dir: "content/posts/2026",
      isSourceRoot: false,
      name: "posts",
    });
    expect(collectionForDirectory("pages", cfg)).toBeNull();
  });

  test("a sibling whose name merely starts the same is not a member", () => {
    const cfg = config({ posts: MD });
    expect(collectionForDirectory("content/posts-archive", cfg)).toBeNull();
  });

  test("the LONGEST source wins, not the first declared", () => {
    const cfg = config({
      blog: { format: "Markdown", source: "./content/blog/" },
      everything: { format: "Markdown", source: "./content/" },
    });
    expect(collectionForDirectory("content/blog/2026", cfg)?.name).toBe("blog");
    expect(collectionForDirectory("content/other", cfg)?.name).toBe("everything");
  });

  test("a source outside the project is matched literally, dots and all", () => {
    // `sites/jxsuite.com` really ships `"source": "../../docs"`; those dots are regex metacharacters
    // And an unescaped pattern would match `..X..X/docs` as well.
    const cfg = config({ docs: { format: "Markdown", source: "../../docs" } });
    expect(collectionForDirectory("../../docs/studio", cfg)?.name).toBe("docs");
    expect(collectionForDirectory("aaXaaX/docs", cfg)).toBeNull();
  });

  test("a file-backed source's folder is an ordinary folder", () => {
    const cfg = config({ products: { format: "Csv", source: "./content/catalog.csv" } });
    expect(collectionForDirectory("content", cfg)).toBeNull();
  });

  test("a version-numbered DIRECTORY is not mistaken for a file", () => {
    // The predecessor tested the whole source string for an extension, so `./content/v1.2/` read as
    // A single-file catalogue and its entries stopped being entries.
    const cfg = config({ docs: { format: "Markdown", source: "./content/v1.2/" } });
    expect(collectionForDirectory("content/v1.2", cfg)?.name).toBe("docs");
  });

  test("a directory nobody named, and a config with no content at all", () => {
    expect(collectionForDirectory("content/posts", config({}))).toBeNull();
    expect(collectionForDirectory("", config({ posts: MD }))).toBeNull();
    expect(collectionForDirectory(null, config({ posts: MD }))).toBeNull();
  });
});

describe("localized sources", () => {
  const LOCALIZED = { format: "Markdown", source: "./content/exhibitions/{locale}/" };

  test("a declared locale is a root; a co-located media folder is not", () => {
    const cfg = config({ exhibitions: LOCALIZED }, { locales: ["en", "fr"] });
    expect(collectionForDirectory("content/exhibitions/fr", cfg)).toMatchObject({
      dir: "content/exhibitions/fr",
      isSourceRoot: true,
      name: "exhibitions",
    });
    // The rule this whole matcher exists for. `[^/]+` binds the media directory
    // `site-architecture.md` §6.5 blesses, and a creation there is then locked to `.md`.
    expect(collectionForDirectory("content/exhibitions/images", cfg)).toBeNull();
  });

  test("`dir` is the REAL directory, never the placeholder", () => {
    const cfg = config({ exhibitions: LOCALIZED }, { locales: ["en", "fr"] });
    expect(collectionForDirectory("content/exhibitions/en/2026", cfg)?.dir).toBe(
      "content/exhibitions/en/2026",
    );
  });

  test("case does not decide a locale, because a filesystem often does not either", () => {
    const cfg = config({ exhibitions: LOCALIZED }, { locales: ["en-US"] });
    expect(collectionForDirectory("content/exhibitions/en-us", cfg)?.name).toBe("exhibitions");
  });

  test("with no locales declared the segment falls back to matching anything", () => {
    // The fallback is not laxness: a project declaring a `{locale}` source and no `i18n` section has
    // Nothing else that could match, and refusing it would show no frontmatter fields at all.
    const cfg = config({ exhibitions: LOCALIZED });
    expect(collectionForDirectory("content/exhibitions/fr", cfg)?.name).toBe("exhibitions");
  });

  test("the collection root above the locale directories holds no entries", () => {
    const cfg = config({ exhibitions: LOCALIZED }, { locales: ["en"] });
    expect(collectionForDirectory("content/exhibitions", cfg)).toBeNull();
  });
});

describe("the entry extension", () => {
  test("comes off the declared format, and `json` is native", () => {
    expect(collectionForDirectory("content/posts", config({ posts: MD }))?.ext).toBe(".md");
    expect(
      collectionForDirectory("c", config({ posts: { format: "json", source: "./c/" } }))?.ext,
    ).toBe(".json");
  });

  test("an unregistered format is null and NAMES itself — never a silent .json", () => {
    // A `.json` fallback here would lock a picker to an extension the collection does not use: a
    // Stated lie plus an enforced refusal, which is worse than not constraining at all.
    const match = collectionForDirectory(
      "c",
      config({ posts: { format: "Toml", source: "./c/" } }),
    );
    expect(match?.ext).toBeNull();
    expect(match?.unresolvedFormat).toBe("Toml");
  });

  test("no declared format at all falls back to the default content format", () => {
    const match = collectionForDirectory("c", config({ posts: { source: "./c/" } }));
    expect(match?.ext).toBe(".md");
    expect(match?.unresolvedFormat).toBeNull();
  });
});

describe("files", () => {
  test("a file takes its directory's collection, whatever its own extension", () => {
    const cfg = config({ posts: MD });
    expect(collectionForFile("content/posts/hello.md", cfg)?.name).toBe("posts");
    // A `.json` beside `.md` posts still belongs to the collection's business — it is exactly the
    // File a convert must refuse to produce, and answering "no collection" is how it would slip in.
    expect(collectionForFile("content/posts/notes.json", cfg)?.name).toBe("posts");
    expect(collectionForFile("pages/index.json", cfg)).toBeNull();
  });

  test("a file-backed collection is matched as the file it is", () => {
    const cfg = config({ products: { format: "Csv", source: "./content/catalog.csv" } });
    expect(collectionForFile("content/catalog.csv", cfg)).toMatchObject({
      fileBacked: true,
      name: "products",
    });
    expect(collectionForFile("content/other.csv", cfg)).toBeNull();
  });

  test("a file at the project root belongs to no collection", () => {
    expect(collectionForFile("README.md", config({ posts: MD }))).toBeNull();
    expect(collectionForFile("", config({ posts: MD }))).toBeNull();
  });

  test("Windows backslashes are normalised before anything is compared", () => {
    expect(collectionForFile(String.raw`content\posts\hello.md`, config({ posts: MD }))?.name).toBe(
      "posts",
    );
  });
});
