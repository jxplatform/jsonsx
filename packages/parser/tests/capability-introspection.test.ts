/**
 * Guards the format-extension contract: every capability a .class.json declares must exist as a
 * static method on the implementation class, and the $studio element metadata must stay in sync
 * with the serializer's element sets (the source of truth).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Markdown } from "../src/markdown";
import { Csv } from "../src/csv";
import { MD_ELEMENTS } from "../src/serialize";

const CLASSES: [string, string, Record<string, unknown>][] = [
  ["Markdown.class.json", "Markdown", Markdown as unknown as Record<string, unknown>],
  ["Csv.class.json", "Csv", Csv as unknown as Record<string, unknown>],
];

function loadClassDef(file: string) {
  return JSON.parse(readFileSync(resolve(import.meta.dir, "../src", file), "utf8"));
}

describe.each(CLASSES)("%s capability contract", (file, title, Impl) => {
  const def = loadClassDef(file);

  test("declares a format block with extensions", () => {
    expect(def.title).toBe(title);
    expect(Array.isArray(def.format.extensions)).toBe(true);
    expect(def.format.extensions.length).toBeGreaterThan(0);
    for (const ext of def.format.extensions) {
      expect(ext.startsWith(".")).toBe(true);
    }
  });

  test("every declared capability is a static method on the implementation", () => {
    const methods = def.$defs?.methods ?? {};
    const capabilityRoles = new Set(["parse", "serialize", "discover", "load"]);
    const declared = Object.values(methods).filter((m: any) => capabilityRoles.has(m.role));
    expect(declared.length).toBeGreaterThan(0);
    for (const method of declared as {
      role: string;
      identifier: string;
      scope: string;
    }[]) {
      expect(method.scope).toBe("static");
      expect(typeof Impl[method.identifier]).toBe("function");
    }
  });

  test("instance resolve is declared and implemented", () => {
    expect(def.$defs.methods.resolve.scope).toBe("instance");
    expect(typeof (Impl as { prototype: Record<string, unknown> }).prototype.resolve).toBe(
      "function",
    );
  });
});

describe("Markdown.class.json $studio elements", () => {
  const def = loadClassDef("Markdown.class.json");

  test("match the serializer's element sets (drift guard)", () => {
    expect(def.$studio.elements.block).toEqual(MD_ELEMENTS.block);
    expect(def.$studio.elements.inline).toEqual(MD_ELEMENTS.inline);
    expect(def.$studio.elements.void).toEqual(MD_ELEMENTS.void);
    expect(def.$studio.elements.textOnly).toEqual(MD_ELEMENTS.textOnly);
    expect(def.$studio.elements.nesting).toEqual(structuredClone(MD_ELEMENTS.nesting));
  });
});

describe("Markdown capability behavior", () => {
  test("parse transpiles markdown source to a Jx document", () => {
    const doc = Markdown.parse("---\ntitle: Hi\n---\n\n# Hello\n");
    expect(doc.title).toBe("Hi");
    expect((doc.children as { tagName: string }[])[0].tagName).toBe("h1");
  });

  test("serialize roundtrips parse output", () => {
    const source = "---\ntitle: Hi\n---\n\n# Hello\n\nSome *emphasis* here.\n";
    const doc = Markdown.parse(source);
    const out = Markdown.serialize(doc);
    expect(out).toContain("title: Hi");
    expect(out).toContain("# Hello");
    expect(out).toContain("*emphasis*");
  });

  test("serialize export mode emits clean markdown without frontmatter", () => {
    const doc = Markdown.parse("---\ntitle: Hi\n---\n\n# Hello\n");
    const out = Markdown.serialize(doc, { mode: "export" });
    expect(out).not.toContain("title: Hi");
    expect(out).toContain("# Hello");
  });

  test("load packages a markdown file as a content entry", async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const TMP = resolve(import.meta.dir, "__test-md-load__");
    rmSync(TMP, { force: true, recursive: true });
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      resolve(TMP, "hello-world.md"),
      "---\ntitle: Hello\ndate: 2026-01-01\n---\n\nFirst paragraph.\n\n## Section\n",
    );
    try {
      const entries = await Markdown.load(resolve(TMP, "hello-world.md"));
      expect(entries.length).toBe(1);
      expect(entries[0].id).toBe("hello-world");
      expect(entries[0].data.title).toBe("Hello");
      expect(entries[0].body).toContain("First paragraph.");
      expect(entries[0]._meta?.excerpt).toBe("First paragraph.");
      expect(entries[0]._meta?.toc?.[0]?.text).toBe("Section");
    } finally {
      rmSync(TMP, { force: true, recursive: true });
    }
  });

  test("discover lists .md files in a directory", async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const TMP = resolve(import.meta.dir, "__test-md-discover__");
    rmSync(TMP, { force: true, recursive: true });
    mkdirSync(resolve(TMP, "posts"), { recursive: true });
    writeFileSync(resolve(TMP, "posts/a.md"), "# A");
    writeFileSync(resolve(TMP, "posts/b.md"), "# B");
    writeFileSync(resolve(TMP, "posts/c.txt"), "not md");
    try {
      const files = await Markdown.discover("./posts", { baseDir: TMP });
      expect(files.length).toBe(2);
      expect(files.every((f) => f.endsWith(".md"))).toBe(true);
    } finally {
      rmSync(TMP, { force: true, recursive: true });
    }
  });

  test("instance resolve parses the configured file", async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const TMP = resolve(import.meta.dir, "__test-md-resolve__");
    rmSync(TMP, { force: true, recursive: true });
    mkdirSync(TMP, { recursive: true });
    writeFileSync(resolve(TMP, "post.md"), "---\ntitle: T\n---\n\nBody.\n");
    try {
      const md = new Markdown({ basePath: TMP, src: "./post.md" });
      const result = await md.resolve();
      expect(result.slug).toBe("post");
      expect(result.frontmatter.title).toBe("T");
    } finally {
      rmSync(TMP, { force: true, recursive: true });
    }
  });
});
