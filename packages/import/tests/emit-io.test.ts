/**
 * The emitter's whole file set, asserted through an in-memory sink.
 *
 * The other emit suites read the result back off disk, which can only ever prove what a local run
 * produces. This one proves the thing Jx Cloud depends on: the paths and the bytes are decided by
 * the emitter and handed to the sink, so a caller committing straight to git gets exactly the same
 * project without a filesystem anywhere in the picture.
 */
import { describe, expect, test } from "bun:test";
import { emitMultiPageProject, emitProject } from "../src/emit.ts";
import { memoryIo } from "./memory-io.ts";
import type { JxElement } from "@jxsuite/schema/types";

describe("emitMultiPageProject through a memory sink", () => {
  test("writes every file at a project-relative path, and reports the same list", async () => {
    const { io, files, dirs, text } = memoryIo();

    const result = await emitMultiPageProject({
      io,
      title: "Sink Site",
      sourceUrl: "https://sink.example/",
      pages: new Map<string, JxElement>([
        ["pages/index.json", { tagName: "div", textContent: "Home" }],
        ["pages/blog/first-post.json", { tagName: "div", textContent: "Post" }],
      ]),
      layout: { tagName: "div", children: [{ tagName: "header" }, { tagName: "slot" }] },
      breakpoints: { "--1024": "(min-width: 1024px)", "--640": "(min-width: 640px)" },
      baseWidth: 1440,
      componentizeOptions: false,
      styleTokens: { "--brand": "#3b82f6" },
      fontFaceRules: ['@font-face { font-family: "L"; src: url(https://cdn.example/l.woff2); }'],
      fontRewriteMap: new Map([["https://cdn.example/l.woff2", "public/assets/fonts/l.woff2"]]),
    });

    // Nothing absolute, nothing back-slashed, and the returned list IS the set that was written.
    expect(result.files.toSorted()).toEqual([...files.keys()].toSorted());
    expect(result.files.toSorted()).toEqual([
      "layouts/base.json",
      "pages/blog/first-post.json",
      "pages/index.json",
      "project.json",
      "public/assets/fonts.css",
    ]);
    expect(result.files.every((f) => !f.startsWith("/") && !f.includes("\\"))).toBe(true);
    expect(dirs).toEqual(["pages", "layouts", "components", "public"]);

    const project = JSON.parse(result.projectJson) as Record<string, unknown>;
    expect(text("project.json")).toBe(result.projectJson);
    expect(project.name).toBe("Sink Site");
    expect(project.style).toEqual({ "--brand": "#3b82f6" });
    // Base first, then ascending — `$media`'s order is the order Studio offers the sizes in.
    expect(Object.keys(project.$media as object)).toEqual(["--", "--640", "--1024"]);
    expect(project.$head).toEqual([
      { tagName: "link", attributes: { rel: "stylesheet", href: "/assets/fonts.css" } },
    ]);

    // The @font-face url() is rewritten to the served path, with the `public/` prefix dropped.
    expect(text("public/assets/fonts.css")).toContain("url(/assets/fonts/l.woff2)");

    const nested = JSON.parse(text("pages/blog/first-post.json")) as { textContent: string };
    expect(nested.textContent).toBe("Post");
    const layout = JSON.parse(text("layouts/base.json")) as { children: { tagName: string }[] };
    expect(layout.children.map((c) => c.tagName)).toEqual(["header", "slot"]);
  });

  test("components land under components/ and are referenced by every page", async () => {
    const { io, text } = memoryIo();
    const card = (title: string): JxElement => ({
      tagName: "article",
      children: [{ tagName: "h3", textContent: title }] as JxElement[],
    });

    const result = await emitMultiPageProject({
      io,
      title: "Componentized",
      sourceUrl: "https://sink.example/",
      pages: new Map<string, JxElement>([
        ["pages/index.json", { tagName: "div", children: [card("A"), card("B")] as JxElement[] }],
      ]),
      componentizeOptions: { minInstances: 2, minDepth: 1 },
    });

    const components = result.files.filter((f) => f.startsWith("components/"));
    expect(components.length).toBeGreaterThan(0);
    const page = JSON.parse(text("pages/index.json")) as { $elements: { $ref: string }[] };
    expect(page.$elements[0]?.$ref).toBe(`../${components[0]}`);
  });

  test("the class strip runs on the way out and is counted, never on the way in", async () => {
    const { io, text } = memoryIo();
    const { classesStripped } = await emitProject({
      io,
      title: "Stripped",
      sourceUrl: "https://sink.example/",
      document: { tagName: "div", attributes: { class: "wp-block-cover alignfull" } },
      componentizeOptions: false,
    });

    expect(classesStripped).toBeGreaterThan(0);
    expect(text("pages/index.json")).not.toContain('"class"');
  });
});
