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
