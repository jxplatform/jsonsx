import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MarkdownCollection, processMarkdown } from "../src/md";
import type { MarkdownFileResult } from "../src/types";
import type { JxElement } from "@jxsuite/schema/types";

// ─── processMarkdown ──────────────────────────────────────────────────────────

describe("processMarkdown", () => {
  test("parses frontmatter and strips the yaml node from $children", () => {
    const source = ["---", "title: Hello", "date: 2026-01-02", "---", "", "Body text."].join("\n");
    const result = processMarkdown(source, "/posts/hello.md");
    expect(result.frontmatter).toEqual({ date: "2026-01-02", title: "Hello" });
    expect(result.$children).toHaveLength(1);
    expect(result.$children[0] as JxElement).toEqual({ tagName: "p", textContent: "Body text." });
  });

  test("returns empty frontmatter when none is present", () => {
    const result = processMarkdown("Just text.", "/x.md");
    expect(result.frontmatter).toEqual({});
  });

  test("derives slug from the file basename without extension", () => {
    expect(processMarkdown("hi", "/a/b/my-post.md").slug).toBe("my-post");
    expect(processMarkdown("hi", "deep/dir/notes.markdown").slug).toBe("notes");
    expect(processMarkdown("hi", "/a/b/my-post.md").path).toBe("/a/b/my-post.md");
  });

  test("derives path-based slugs for files in subdirectories of sourceRoot", () => {
    expect(processMarkdown("hi", "/docs/studio/canvas.md", { sourceRoot: "/docs" }).slug).toBe(
      "studio/canvas",
    );
    expect(
      processMarkdown("hi", "/docs/studio/canvas/index.md", { sourceRoot: "/docs" }).slug,
    ).toBe("studio/canvas");
    expect(
      processMarkdown("hi", "/docs/framework/concepts/state.md", { sourceRoot: "/docs" }).slug,
    ).toBe("framework/concepts/state");
  });

  test("keeps basename slugs at the sourceRoot itself and outside it", () => {
    expect(processMarkdown("hi", "/docs/intro.md", { sourceRoot: "/docs" }).slug).toBe("intro");
    expect(processMarkdown("hi", "/docs/index.md", { sourceRoot: "/docs" }).slug).toBe("index");
    expect(processMarkdown("hi", "/elsewhere/post.md", { sourceRoot: "/docs" }).slug).toBe("post");
  });

  test("extracts a table of contents with slugified ids", () => {
    const source = ["# Top Heading", "", "## What's New?", "", "### Multi  Spaced -- Title"].join(
      "\n",
    );
    const { $toc } = processMarkdown(source, "/toc.md");
    expect($toc).toEqual([
      { depth: 1, id: "top-heading", text: "Top Heading" },
      { depth: 2, id: "whats-new", text: "What's New?" },
      { depth: 3, id: "multi-spaced-title", text: "Multi  Spaced -- Title" },
    ]);
  });

  test("toc id strips leading and trailing hyphens", () => {
    const { $toc } = processMarkdown("# !leading and trailing!", "/t.md");
    expect($toc[0]?.id).toBe("leading-and-trailing");
  });

  test("excerpt is the first paragraph's plain text", () => {
    const source = ["# Heading", "", "First *emphasized* paragraph.", "", "Second paragraph."].join(
      "\n",
    );
    expect(processMarkdown(source, "/e.md").$excerpt).toBe("First emphasized paragraph.");
  });

  test("excerpt is empty when there is no paragraph", () => {
    expect(processMarkdown("# Only a heading", "/h.md").$excerpt).toBe("");
  });

  test("word count and minimum reading time", () => {
    const result = processMarkdown("one two three", "/w.md");
    expect(result.$wordCount).toBe(3);
    expect(result.$readingTime).toBe(1);
  });

  test("reading time scales with word count (~200 wpm, rounded up)", () => {
    const source = Array.from({ length: 401 }, (_, i) => `w${i}`).join(" ");
    const result = processMarkdown(source, "/long.md");
    expect(result.$wordCount).toBe(401);
    expect(result.$readingTime).toBe(3);
  });

  test("empty source produces an empty, well-formed result", () => {
    const result = processMarkdown("", "/empty.md");
    expect(result.$children).toEqual([]);
    expect(result.$excerpt).toBe("");
    expect(result.$toc).toEqual([]);
    expect(result.$wordCount).toBe(0);
    expect(result.$readingTime).toBe(1);
  });

  test("GFM tables become JX table nodes", () => {
    const source = ["| A | B |", "| - | - |", "| 1 | 2 |"].join("\n");
    const result = processMarkdown(source, "/table.md");
    const table = result.$children[0] as JxElement & { tagName?: string };
    expect(table.tagName).toBe("table");
  });

  test("directives are inert without the directives option", () => {
    const result = processMarkdown(":::note\nHello\n:::", "/d.md");
    const text = JSON.stringify(result.$children);
    expect(text).toContain(":::note");
  });

  test("directives option enables container directive parsing", () => {
    const result = processMarkdown(":::note\nHello\n:::", "/d.md", { directives: true });
    const text = JSON.stringify(result.$children);
    expect(text).not.toContain(":::");
  });

  test("directiveOptions alone also enables the directive plugin", () => {
    const result = processMarkdown(":::note\nHello\n:::", "/d.md", { directiveOptions: {} });
    expect(JSON.stringify(result.$children)).not.toContain(":::");
  });
});

// ─── MarkdownCollection ───────────────────────────────────────────────────────

describe("MarkdownCollection", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "jx-md-units-"));
    mkdirSync(join(dir, "posts"));
    writeFileSync(
      join(dir, "posts", "first.md"),
      [
        "---",
        "title: First",
        "date: 2026-01-01",
        "draft: false",
        "---",
        "",
        "First post body.",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "posts", "second.md"),
      [
        "---",
        "title: Second",
        "date: 2026-02-01",
        "draft: true",
        "---",
        "",
        "Second post body.",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "posts", "third.md"),
      [
        "---",
        "title: Third",
        "date: 2026-03-01",
        "draft: false",
        "---",
        "",
        "Third post body.",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  test("stores its config", () => {
    const config = { src: "./posts/*.md" };
    expect(new MarkdownCollection(config).config).toBe(config);
  });

  test("globs and parses all matching files, newest first by default", async () => {
    const collection = new MarkdownCollection({ src: join(dir, "posts", "*.md") });
    const results = await collection.resolve();
    expect(results).toHaveLength(3);
    expect(results.map((r: MarkdownFileResult) => r.frontmatter.title)).toEqual([
      "Third",
      "Second",
      "First",
    ]);
    expect(results.map((r: MarkdownFileResult) => r.slug)).toEqual(["third", "second", "first"]);
  });

  test("resolves src against basePath", async () => {
    const collection = new MarkdownCollection({ basePath: dir, src: "./posts/*.md" });
    const results = await collection.resolve();
    expect(results).toHaveLength(3);
  });

  test("normalizes backslashes in the resolved pattern", async () => {
    const winStyle = join(dir, "posts", "*.md").split("/").join("\\");
    const collection = new MarkdownCollection({ src: winStyle });
    const results = await collection.resolve();
    expect(results).toHaveLength(3);
  });

  test("sorts ascending on a nested frontmatter field", async () => {
    const collection = new MarkdownCollection({
      sortBy: "frontmatter.title",
      sortOrder: "asc",
      src: join(dir, "posts", "*.md"),
    });
    const results = await collection.resolve();
    expect(results.map((r: MarkdownFileResult) => r.frontmatter.title)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  test("missing sortBy paths fall back to empty values without throwing", async () => {
    const collection = new MarkdownCollection({
      sortBy: "frontmatter.nope.deep",
      src: join(dir, "posts", "*.md"),
    });
    const results = await collection.resolve();
    expect(results).toHaveLength(3);
  });

  test("applies the filter callback", async () => {
    const collection = new MarkdownCollection({
      filter: (r) => r.frontmatter.draft === false,
      src: join(dir, "posts", "*.md"),
    });
    const results = await collection.resolve();
    expect(results.map((r: MarkdownFileResult) => r.frontmatter.title)).toEqual(["Third", "First"]);
  });

  test("applies a positive limit after sorting", async () => {
    const collection = new MarkdownCollection({ limit: 2, src: join(dir, "posts", "*.md") });
    const results = await collection.resolve();
    expect(results.map((r: MarkdownFileResult) => r.frontmatter.title)).toEqual([
      "Third",
      "Second",
    ]);
  });

  test("ignores a zero limit", async () => {
    const collection = new MarkdownCollection({ limit: 0, src: join(dir, "posts", "*.md") });
    expect(await collection.resolve()).toHaveLength(3);
  });

  test("returns an empty array when nothing matches the glob", async () => {
    const collection = new MarkdownCollection({ src: join(dir, "nope", "*.md") });
    expect(await collection.resolve()).toEqual([]);
  });

  test("each result carries derived metadata", async () => {
    const collection = new MarkdownCollection({ limit: 1, src: join(dir, "posts", "*.md") });
    const [result] = await collection.resolve();
    expect(result?.$excerpt).toBe("Third post body.");
    expect(result?.$readingTime).toBe(1);
    expect(result?.$wordCount).toBeGreaterThan(0);
    expect(result?.path).toEndWith("third.md");
  });
});
