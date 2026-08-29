import { describe, expect, test } from "bun:test";
import { rewriteDocRefs, rewriteTagName } from "../src/refactor/refs";
import type { RemapCtx } from "../src/refactor/paths";

const ctx = (over: Partial<RemapCtx>): RemapCtx => ({
  docNewDir: "/p/pages",
  docOldDir: "/p/pages",
  newAbs: "/p/components/button.json",
  oldAbs: "/p/components/counter.json",
  root: "/p",
  ...over,
});

describe("rewriteDocRefs — recognized reference forms", () => {
  test("rewrites $ref / $elements / imports targeting the renamed file, leaving others", () => {
    const doc = {
      $elements: [
        "../components/counter.json",
        "@scope/pkg",
        { $ref: "../components/counter.json" },
      ],
      $layout: "../layouts/base.json",
      children: [
        { $ref: "../components/counter.json" },
        { $ref: "#/state/x" },
        { src: "../img/logo.png", tagName: "img" },
      ],
      imports: {
        Counter: "../components/counter.json",
        Markdown: "@jxsuite/parser/Markdown.class.json",
      },
    };
    const { changes } = rewriteDocRefs(doc, ctx({}));

    expect(doc.children[0]).toEqual({ $ref: "../components/button.json" });
    expect(doc.children[1]).toEqual({ $ref: "#/state/x" }); // State ref untouched
    expect(doc.$elements[0]).toBe("../components/button.json");
    expect(doc.$elements[1]).toBe("@scope/pkg"); // NPM specifier untouched
    expect(doc.$elements[2]).toEqual({ $ref: "../components/button.json" });
    expect(doc.imports.Counter).toBe("../components/button.json");
    expect(doc.imports.Markdown).toBe("@jxsuite/parser/Markdown.class.json"); // NPM untouched
    expect(doc.$layout).toBe("../layouts/base.json"); // Unrelated layout untouched
    expect((doc.children[2] as { src: string }).src).toBe("../img/logo.png"); // Unrelated asset
    expect(changes).toHaveLength(4);
  });

  test("rewrites $src and $implementation file paths", () => {
    const doc = {
      $implementation: "./impl.js",
      state: { fn: { $prototype: "Function", $src: "./fetch-demo.js" } },
    };
    const c = ctx({
      docNewDir: "/p/components",
      docOldDir: "/p/components",
      newAbs: "/p/components/fetch.js",
      oldAbs: "/p/components/fetch-demo.js",
    });
    rewriteDocRefs(doc, c);
    expect(doc.state.fn.$src).toBe("./fetch.js");
    expect(doc.$implementation).toBe("./impl.js"); // Different file, untouched
  });

  test("rewrites url(...) in style strings, preserving quotes and shorthand", () => {
    const doc = {
      children: [{ style: { background: 'url("../img/bg.png")' } }],
      style: { backgroundImage: "url('../img/bg.png')", other: "url(../img/bg.png) no-repeat" },
    };
    const c = ctx({ newAbs: "/p/img/hero.png", oldAbs: "/p/img/bg.png" });
    const { changes } = rewriteDocRefs(doc, c);
    expect(doc.style.backgroundImage).toBe("url('../img/hero.png')");
    expect(doc.style.other).toBe("url(../img/hero.png) no-repeat");
    expect((doc.children[0] as { style: { background: string } }).style.background).toBe(
      'url("../img/hero.png")',
    );
    expect(changes).toHaveLength(3);
  });

  test("directory move — incoming ref from an unmoved document", () => {
    const doc = { children: [{ $ref: "../components/card.json" }] };
    const c = ctx({ newAbs: "/p/widgets", oldAbs: "/p/components" });
    rewriteDocRefs(doc, c);
    expect(doc.children[0]).toEqual({ $ref: "../widgets/card.json" });
  });

  test("dangling / unrelated refs produce no changes", () => {
    const doc = { children: [{ $ref: "../components/missing.json" }] };
    const { changes } = rewriteDocRefs(doc, ctx({}));
    expect(changes).toHaveLength(0);
  });

  test("a non-array $elements value is walked like any nested object", () => {
    const doc = { $elements: { $ref: "../components/counter.json" } };
    const { changes } = rewriteDocRefs(doc, ctx({}));
    expect(doc.$elements).toEqual({ $ref: "../components/button.json" });
    expect(changes).toHaveLength(1);
  });

  test("non-path $elements entries (external URLs) are left alone", () => {
    const doc = { $elements: ["https://cdn.example.com/x.js"] };
    const { changes } = rewriteDocRefs(doc, ctx({}));
    expect(doc.$elements[0]).toBe("https://cdn.example.com/x.js");
    expect(changes).toHaveLength(0);
  });

  test("style url() handling across arrays, primitives, externals and non-matches", () => {
    const doc = {
      children: [{ style: { x: "url(../img/other.png)" } }],
      style: ["url(../img/bg.png)", { bg: "url(data:image/png;base64,AA)", opacity: 1 }, 5],
    };
    const c = ctx({ newAbs: "/p/img/hero.png", oldAbs: "/p/img/bg.png" });
    const { changes } = rewriteDocRefs(doc, c);
    expect(doc.style[0] as string).toBe("url(../img/hero.png)"); // Array string member rewritten
    expect((doc.style[1] as { bg: string }).bg).toBe("url(data:image/png;base64,AA)"); // Data URL left
    expect((doc.children[0] as { style: { x: string } }).style.x).toBe("url(../img/other.png)"); // No match
    expect(changes).toHaveLength(1);
  });
});

/*
 * `project.json`'s copy map names its sources in its KEYS and its destinations in its values, and
 * for both halves that fact is the whole test: a key must be rewritten (issue 242) and a value must
 * not, because the value lives in `outDir` and no rename inside the project can move it.
 */
describe("rewriteDocRefs — copy map keys", () => {
  const copyCtx = (over: Partial<RemapCtx> = {}): RemapCtx =>
    ctx({
      docNewDir: "/p",
      docOldDir: "/p",
      newAbs: "/p/assets/prospectus.pdf",
      oldAbs: "/p/assets/brochure.pdf",
      ...over,
    });

  test("renames a copy key naming the moved file, leaving its destination value alone", () => {
    const doc: { copy: Record<string, string> } = {
      copy: { "assets/brochure.pdf": "brochure.pdf" },
    };
    const { changes } = rewriteDocRefs(doc, copyCtx());
    expect(doc.copy).toEqual({ "assets/prospectus.pdf": "brochure.pdf" });
    expect(changes).toEqual([
      { from: "assets/brochure.pdf", refType: "copy", to: "assets/prospectus.pdf" },
    ]);
  });

  test("a copy key is project-root-relative, not document-relative", () => {
    // A page deep in the tree could never carry `copy`, but the base choice is what makes the key
    // Resolve at all — read from the project root, exactly as the build resolves it.
    const doc: { copy: Record<string, string> } = {
      copy: { "assets/brochure.pdf": "files/brochure.pdf" },
    };
    rewriteDocRefs(doc, copyCtx({ docNewDir: "/p/pages", docOldDir: "/p/pages" }));
    expect(doc.copy).toEqual({ "assets/prospectus.pdf": "files/brochure.pdf" });
  });

  test("a copy DESTINATION that happens to name a real project file is never rewritten", () => {
    /* The value is a path inside `outDir`. Before the `copy` case existed the shape fallback
       offered it, so renaming `/p/brochure.pdf` rewrote a destination that merely shared its
       name — a silent edit to the built site's layout. */
    const doc = { copy: { "assets/a.pdf": "brochure.pdf" } };
    const { changes } = rewriteDocRefs(
      doc,
      copyCtx({ newAbs: "/p/prospectus.pdf", oldAbs: "/p/brochure.pdf" }),
    );
    expect(doc.copy).toEqual({ "assets/a.pdf": "brochure.pdf" });
    expect(changes).toHaveLength(0);
  });

  test("renaming a directory rewrites every key beneath it and preserves insertion order", () => {
    const doc = {
      copy: {
        "assets/a.pdf": "a.pdf",
        "assets/deep/b.pdf": "b.pdf",
        "other/c.pdf": "c.pdf",
      },
    };
    rewriteDocRefs(doc, copyCtx({ newAbs: "/p/files", oldAbs: "/p/assets" }));
    expect(Object.entries(doc.copy)).toEqual([
      ["files/a.pdf", "a.pdf"],
      ["files/deep/b.pdf", "b.pdf"],
      ["other/c.pdf", "c.pdf"],
    ]);
  });

  test("a copy map matching nothing is left untouched, and a non-object copy is ignored", () => {
    const doc = { copy: { "assets/other.pdf": "other.pdf" } };
    expect(rewriteDocRefs(doc, copyCtx()).changes).toHaveLength(0);
    const odd = { copy: "assets/brochure.pdf" };
    expect(rewriteDocRefs(odd, copyCtx()).changes).toHaveLength(0);
    expect(odd.copy).toBe("assets/brochure.pdf");
  });
});

/*
 * A collection's `source` is the one reference whose value may be a DIRECTORY, and a directory
 * carries no extension — which is exactly what `looksLikeFileRef` requires. So the shape fallback
 * resolved the single-file form for free and could never admit the directory form (issue 243).
 */
describe("rewriteDocRefs — content collection sources", () => {
  const sourceCtx = (over: Partial<RemapCtx>): RemapCtx =>
    ctx({ docNewDir: "/p", docOldDir: "/p", ...over });

  test("rewrites a directory source and keeps the trailing slash the author wrote", () => {
    const doc = { content: { posts: { format: "Markdown", source: "./content/posts/" } } };
    const { changes } = rewriteDocRefs(
      doc,
      sourceCtx({ newAbs: "/p/content/articles", oldAbs: "/p/content/posts" }),
    );
    expect(doc.content.posts.source).toBe("./content/articles/");
    expect(changes).toEqual([
      { from: "./content/posts/", refType: "source", to: "./content/articles/" },
    ]);
  });

  test("rewrites a directory source with no trailing slash, and adds none", () => {
    const doc = { content: { posts: { source: "content/posts" } } };
    rewriteDocRefs(doc, sourceCtx({ newAbs: "/p/content/articles", oldAbs: "/p/content/posts" }));
    expect(doc.content.posts.source).toBe("content/articles");
  });

  test("a locale placeholder inside the source survives the rewrite", () => {
    const doc = { content: { shows: { source: "./content/exhibitions/{locale}/" } } };
    rewriteDocRefs(
      doc,
      sourceCtx({ newAbs: "/p/content/shows", oldAbs: "/p/content/exhibitions" }),
    );
    expect(doc.content.shows.source).toBe("./content/shows/{locale}/");
  });

  test("the single-file source form still rewrites, as it did through the shape fallback", () => {
    const doc = { content: { listings: { source: "./content/listings.csv" } } };
    const { changes } = rewriteDocRefs(
      doc,
      sourceCtx({ newAbs: "/p/content/homes.csv", oldAbs: "/p/content/listings.csv" }),
    );
    expect(doc.content.listings.source).toBe("./content/homes.csv");
    expect(changes[0]!.refType).toBe("source");
  });

  test("a remote source and an unrelated directory are both left alone", () => {
    const doc = {
      content: {
        remote: { source: "https://example.com/sheet.csv" },
        other: { source: "./content/authors/" },
      },
    };
    const { changes } = rewriteDocRefs(
      doc,
      sourceCtx({ newAbs: "/p/content/articles", oldAbs: "/p/content/posts" }),
    );
    expect(doc.content.remote.source).toBe("https://example.com/sheet.csv");
    expect(doc.content.other.source).toBe("./content/authors/");
    expect(changes).toHaveLength(0);
  });

  test("a rooted directory source keeps its trailing slash too", () => {
    const doc = { content: { docs: { source: "/content/guides/" } } };
    rewriteDocRefs(doc, sourceCtx({ newAbs: "/p/content/manuals", oldAbs: "/p/content/guides" }));
    expect(doc.content.docs.source).toBe("/content/manuals/");
  });
});

describe("rewriteTagName", () => {
  test("renames every tagName instance and the definition root, leaving file refs", () => {
    const doc = {
      cases: { a: { $ref: "x.json" } },
      children: [
        { tagName: "my-counter" },
        { children: [{ tagName: "my-counter" }], tagName: "div" },
        { children: { $prototype: "Array", map: { tagName: "my-counter" } } },
      ],
      tagName: "my-counter",
    };
    const { count } = rewriteTagName(doc, "my-counter", "my-button");
    expect(count).toBe(4);
    expect(doc.tagName).toBe("my-button");
    expect(doc.cases.a).toEqual({ $ref: "x.json" }); // File ref left to rewriteDocRefs
  });

  test("no-op when oldTag equals newTag", () => {
    const doc = { tagName: "my-x" };
    expect(rewriteTagName(doc, "my-x", "my-x").count).toBe(0);
  });

  test("absent tag yields zero", () => {
    expect(rewriteTagName({ tagName: "a-b" }, "c-d", "e-f").count).toBe(0);
  });
});
