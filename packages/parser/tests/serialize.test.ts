import { describe, expect, test } from "bun:test";
import { jxToMdast as jxToMd, mdastToJx as mdToJx, serializeJxMarkdown } from "../src/serialize";

const jxDocToMd = (doc: Record<string, unknown>) => serializeJxMarkdown(doc as any);

// ─── Helpers — build mdast nodes ─────────────────────────────────────────────

/** @param {any[]} children */
function root(...children: any[]) {
  return { children, type: "root" };
}

/** @param {any} depth @param {any} text */
function heading(depth: any, text: any) {
  return { children: [{ type: "text", value: text }], depth, type: "heading" };
}

/** @param {any} text */
function paragraph(text: any) {
  return { children: [{ type: "text", value: text }], type: "paragraph" };
}

/** @param {any} text */
function emphasis(text: any) {
  return { children: [{ type: "text", value: text }], type: "emphasis" };
}

/** @param {any} text */
function strong(text: any) {
  return { children: [{ type: "text", value: text }], type: "strong" };
}

/** @param {any} url @param {any} text @param {any} [title] */
function link(url: any, text: any, title?: any) {
  return {
    children: [{ type: "text", value: text }],
    title: title ?? null,
    type: "link",
    url,
  };
}

/** @param {any} url @param {any} alt @param {any} title */
function image(url: any, alt: any, title: any) {
  return { alt: alt ?? "", title: title ?? null, type: "image", url };
}

/** @param {any} value */
function inlineCode(value: any) {
  return { type: "inlineCode", value };
}

/** @param {any} ordered @param {any[]} items */
function list(ordered: any, ...items: any[]) {
  return { children: items, ordered, spread: false, type: "list" };
}

/** @param {any[]} children */
function listItem(...children: any[]) {
  return { children, spread: false, type: "listItem" };
}

/** @param {any} value @param {any} lang */
function codeBlock(value: any, lang: any) {
  return { lang: lang ?? null, type: "code", value };
}

function thematicBreak() {
  return { type: "thematicBreak" };
}

// ─── mdToJx ──────────────────────────────────────────────────────────────

describe("mdToJx", () => {
  test("root node becomes document container", () => {
    const result: any = mdToJx(root());
    expect(result.tagName).toBeUndefined();
    expect(result.children).toEqual([]);
  });

  test("converts heading", () => {
    const result: any = mdToJx(root(heading(2, "Hello")));
    expect(result.children[0]).toEqual({ tagName: "h2", textContent: "Hello" });
  });

  test("converts all heading depths", () => {
    for (let i = 1; i <= 6; i++) {
      const result: any = mdToJx(root(heading(i, "H")));
      expect(result.children[0].tagName).toBe(`h${i}`);
    }
  });

  test("converts paragraph", () => {
    const result: any = mdToJx(root(paragraph("Some text")));
    expect(result.children[0]).toEqual({
      tagName: "p",
      textContent: "Some text",
    });
  });

  test("converts emphasis", () => {
    const mdast = root({
      children: [emphasis("italic")],
      type: "paragraph",
    });
    const result: any = mdToJx(mdast);
    const [p] = result.children;
    expect(p.children[0]).toEqual({ tagName: "em", textContent: "italic" });
  });

  test("converts strong", () => {
    const mdast = root({
      children: [strong("bold")],
      type: "paragraph",
    });
    const result: any = mdToJx(mdast);
    const [p] = result.children;
    expect(p.children[0]).toEqual({ tagName: "strong", textContent: "bold" });
  });

  test("converts inline code", () => {
    const mdast = root({
      children: [inlineCode("const x = 1")],
      type: "paragraph",
    });
    const result: any = mdToJx(mdast);
    const [p] = result.children;
    expect(p.children[0]).toEqual({
      tagName: "code",
      textContent: "const x = 1",
    });
  });

  test("converts link", () => {
    const mdast = root({
      children: [link("https://example.com", "Example")],
      type: "paragraph",
    });
    const result: any = mdToJx(mdast);
    const [a] = result.children[0].children;
    expect(a.tagName).toBe("a");
    expect(a.attributes.href).toBe("https://example.com");
    expect(a.textContent).toBe("Example");
  });

  test("converts image", () => {
    const mdast = root({
      children: [image("img.png", "Alt text", "Title")],
      type: "paragraph",
    });
    const result: any = mdToJx(mdast);
    const [img] = result.children[0].children;
    expect(img.tagName).toBe("img");
    expect(img.attributes.src).toBe("img.png");
    expect(img.attributes.alt).toBe("Alt text");
    expect(img.attributes.title).toBe("Title");
  });

  test("converts unordered list", () => {
    const mdast = root(list(false, listItem(paragraph("Item 1")), listItem(paragraph("Item 2"))));
    const result: any = mdToJx(mdast);
    const [ul] = result.children;
    expect(ul.tagName).toBe("ul");
    expect(ul.children.length).toBe(2);
    expect(ul.children[0].tagName).toBe("li");
  });

  test("converts ordered list", () => {
    const mdast = root(list(true, listItem(paragraph("First"))));
    const result: any = mdToJx(mdast);
    expect(result.children[0].tagName).toBe("ol");
  });

  test("converts code block", () => {
    const mdast = root(codeBlock("console.log('hi')", "js"));
    const result: any = mdToJx(mdast);
    const [pre] = result.children;
    expect(pre.tagName).toBe("pre");
    expect(pre.children[0].tagName).toBe("code");
    expect(pre.children[0].textContent).toBe("console.log('hi')");
    expect(pre.children[0].className).toBe("language-js");
  });

  test("converts thematic break", () => {
    const mdast = root(thematicBreak());
    const result: any = mdToJx(mdast);
    expect(result.children[0]).toEqual({ tagName: "hr" });
  });

  test("filters out yaml frontmatter nodes", () => {
    const mdast = root({ type: "yaml", value: "title: Test" }, paragraph("Hello"));
    const result: any = mdToJx(mdast);
    expect(result.children.length).toBe(1);
    expect(result.children[0].tagName).toBe("p");
  });

  test("converts blockquote", () => {
    const mdast = root({
      children: [paragraph("Quoted text")],
      type: "blockquote",
    });
    const result: any = mdToJx(mdast);
    const [bq] = result.children;
    expect(bq.tagName).toBe("blockquote");
    expect(bq.children[0]).toEqual({
      tagName: "p",
      textContent: "Quoted text",
    });
  });
});

// ─── jxToMd ──────────────────────────────────────────────────────────────

describe("jxToMd", () => {
  test("empty document", () => {
    const result: any = jxToMd({ children: [], tagName: "div" });
    expect(result).toEqual({ children: [], type: "root" });
  });

  test("paragraph", () => {
    const result: any = jxToMd({
      children: [{ tagName: "p", textContent: "Hello" }],
      tagName: "div",
    });
    expect(result.children[0].type).toBe("paragraph");
    expect(result.children[0].children[0]).toEqual({
      type: "text",
      value: "Hello",
    });
  });

  test("heading depth", () => {
    const result: any = jxToMd({
      children: [{ tagName: "h3", textContent: "Title" }],
      tagName: "div",
    });
    expect(result.children[0].type).toBe("heading");
    expect(result.children[0].depth).toBe(3);
  });

  test("link", () => {
    const result: any = jxToMd({
      children: [
        {
          children: [
            {
              attributes: { href: "https://x.com" },
              tagName: "a",
              textContent: "Link",
            },
          ],
          tagName: "p",
        },
      ],
      tagName: "div",
    });
    const [linkNode] = result.children[0].children;
    expect(linkNode.type).toBe("link");
    expect(linkNode.url).toBe("https://x.com");
  });

  test("image", () => {
    const result: any = jxToMd({
      children: [
        {
          children: [
            {
              attributes: { alt: "A photo", src: "photo.jpg" },
              tagName: "img",
            },
          ],
          tagName: "p",
        },
      ],
      tagName: "div",
    });
    const [img] = result.children[0].children;
    expect(img.type).toBe("image");
    expect(img.url).toBe("photo.jpg");
    expect(img.alt).toBe("A photo");
  });

  test("unordered list", () => {
    const result: any = jxToMd({
      children: [
        {
          children: [
            { children: [{ tagName: "p", textContent: "A" }], tagName: "li" },
            { children: [{ tagName: "p", textContent: "B" }], tagName: "li" },
          ],
          tagName: "ul",
        },
      ],
      tagName: "div",
    });
    const [listNode] = result.children;
    expect(listNode.type).toBe("list");
    expect(listNode.ordered).toBe(false);
    expect(listNode.children.length).toBe(2);
  });

  test("ordered list", () => {
    const result: any = jxToMd({
      children: [
        {
          children: [
            {
              children: [{ tagName: "p", textContent: "First" }],
              tagName: "li",
            },
          ],
          tagName: "ol",
        },
      ],
      tagName: "div",
    });
    expect(result.children[0].ordered).toBe(true);
  });

  test("code block with language", () => {
    const result: any = jxToMd({
      children: [
        {
          children: [
            {
              className: "language-js",
              tagName: "code",
              textContent: "const x = 1",
            },
          ],
          tagName: "pre",
        },
      ],
      tagName: "div",
    });
    const [code] = result.children;
    expect(code.type).toBe("code");
    expect(code.lang).toBe("js");
    expect(code.value).toBe("const x = 1");
  });

  test("thematic break", () => {
    const result: any = jxToMd({
      children: [{ tagName: "hr" }],
      tagName: "div",
    });
    expect(result.children[0].type).toBe("thematicBreak");
  });

  test("non-markdown tag becomes directive", () => {
    const result: any = jxToMd({
      children: [{ attributes: { color: "red" }, tagName: "my-widget" }],
      tagName: "div",
    });
    const [directive] = result.children;
    expect(directive.type).toBe("leafDirective");
    expect(directive.name).toBe("my-widget");
    expect(directive.attributes.color).toBe("red");
  });
});

// ─── Round-trip ──────────────────────────────────────────────────────────────

describe("round-trip", () => {
  test("paragraph survives round-trip", () => {
    const mdast = root(paragraph("Hello world"));
    const jx: any = mdToJx(mdast);
    const back: any = jxToMd(jx);
    expect(back.children[0].type).toBe("paragraph");
    expect(back.children[0].children[0].value).toBe("Hello world");
  });

  test("heading survives round-trip", () => {
    const mdast = root(heading(2, "Title"));
    const jx: any = mdToJx(mdast);
    const back: any = jxToMd(jx);
    expect(back.children[0].type).toBe("heading");
    expect(back.children[0].depth).toBe(2);
    expect(back.children[0].children[0].value).toBe("Title");
  });

  test("code block survives round-trip", () => {
    const mdast = root(codeBlock("x = 1", "python"));
    const jx: any = mdToJx(mdast);
    const back: any = jxToMd(jx);
    expect(back.children[0].type).toBe("code");
    expect(back.children[0].lang).toBe("python");
    expect(back.children[0].value).toBe("x = 1");
  });

  test("thematic break survives round-trip", () => {
    const mdast = root(thematicBreak());
    const jx: any = mdToJx(mdast);
    const back: any = jxToMd(jx);
    expect(back.children[0].type).toBe("thematicBreak");
  });
});

// ─── Bare text nodes ────────────────────────────────────────────────────────

describe("jxToMd bare text nodes", () => {
  test("bare string children become mdast text nodes", () => {
    const result: any = jxToMd({
      children: [
        {
          children: ["Hello ", { tagName: "strong", textContent: "world" }, "!"],
          tagName: "p",
        },
      ],
    });
    const [p] = result.children;
    expect(p.type).toBe("paragraph");
    expect(p.children).toEqual([
      { type: "text", value: "Hello " },
      { children: [{ type: "text", value: "world" }], type: "strong" },
      { type: "text", value: "!" },
    ]);
  });

  test("bare number children become text nodes", () => {
    const result: any = jxToMd({
      children: [{ children: ["Score: ", 42] as any, tagName: "p" }],
    });
    const [p] = result.children;
    expect(p.children[0]).toEqual({ type: "text", value: "Score: " });
    expect(p.children[1]).toEqual({ type: "text", value: "42" });
  });

  test("null and undefined children are filtered out", () => {
    const result: any = jxToMd({
      children: [{ children: ["text", null, undefined] as any, tagName: "p" }],
    });
    expect(result.children[0].children).toEqual([{ type: "text", value: "text" }]);
  });
});

// ─── Jx props → directive routing ───────────────────────────────────────────

describe("jxToMd Jx props trigger directive", () => {
  test("plain p stays as paragraph", () => {
    const result: any = jxToMd({
      children: [{ tagName: "p", textContent: "Hello" }],
    });
    expect(result.children[0].type).toBe("paragraph");
  });

  test("p with style becomes container directive", () => {
    const result: any = jxToMd({
      children: [{ style: { color: "red" }, tagName: "p", textContent: "Hello" }],
    });
    expect(result.children[0].type).toBe("containerDirective");
    expect(result.children[0].name).toBe("p");
    expect(result.children[0].attributes["style.color"]).toBe("red");
  });

  test("heading with style becomes container directive", () => {
    const result: any = jxToMd({
      children: [{ style: { fontSize: "2em" }, tagName: "h2", textContent: "Title" }],
    });
    expect(result.children[0].type).toBe("containerDirective");
    expect(result.children[0].name).toBe("h2");
  });

  test("element with $ref becomes directive", () => {
    const result: any = jxToMd({
      children: [{ $ref: "./components/fancy-p.json", tagName: "p", textContent: "Hi" }],
    });
    expect(result.children[0].type).toBe("containerDirective");
    expect(result.children[0].attributes.ref).toBe("./components/fancy-p.json");
  });
});

// ─── Container directive inline content ─────────────────────────────────────

describe("container directive inline content", () => {
  test("decorated p wraps mixed children in single paragraph", () => {
    const result: any = jxToMd({
      children: [
        {
          children: [
            "Another paragraph, just to test ",
            { tagName: "strong", textContent: "things" },
            " out.",
          ],
          style: { color: "#b59a9a" },
          tagName: "p",
        },
      ],
    });
    const [directive] = result.children;
    expect(directive.type).toBe("containerDirective");
    expect(directive.name).toBe("p");
    // Children should be a single paragraph wrapping all inline nodes
    expect(directive.children.length).toBe(1);
    expect(directive.children[0].type).toBe("paragraph");
    expect(directive.children[0].children.length).toBe(3);
    expect(directive.children[0].children[0]).toEqual({
      type: "text",
      value: "Another paragraph, just to test ",
    });
    expect(directive.children[0].children[1].type).toBe("strong");
    expect(directive.children[0].children[2]).toEqual({
      type: "text",
      value: " out.",
    });
  });

  test("decorated h1 wraps children in single paragraph", () => {
    const result: any = jxToMd({
      children: [
        {
          children: ["Welcome to ", { tagName: "em", textContent: "Jx" }],
          style: { color: "blue" },
          tagName: "h1",
        },
      ],
    });
    const [directive] = result.children;
    expect(directive.type).toBe("containerDirective");
    expect(directive.children.length).toBe(1);
    expect(directive.children[0].type).toBe("paragraph");
    expect(directive.children[0].children.length).toBe(2);
  });

  test("non-inline-content tag keeps block children", () => {
    const result: any = jxToMd({
      children: [
        {
          children: [
            { tagName: "h1", textContent: "Title" },
            { tagName: "p", textContent: "Body" },
          ],
          tagName: "my-section",
        },
      ],
    });
    const [directive] = result.children;
    expect(directive.type).toBe("containerDirective");
    // Block children stay as separate nodes, not wrapped in a paragraph
    expect(directive.children.length).toBe(2);
    expect(directive.children[0].type).toBe("heading");
    expect(directive.children[1].type).toBe("paragraph");
  });

  test("decorated p with textContent wraps in paragraph", () => {
    const result: any = jxToMd({
      children: [
        {
          style: { fontWeight: "bold" },
          tagName: "p",
          textContent: "Simple text",
        },
      ],
    });
    const [directive] = result.children;
    expect(directive.children.length).toBe(1);
    expect(directive.children[0].type).toBe("paragraph");
    expect(directive.children[0].children[0].value).toBe("Simple text");
  });
});

// ─── jxDocToMd serialization ────────────────────────────────────────────────

describe("jxDocToMd", () => {
  test("undecorated elements emit standard markdown", () => {
    const md = jxDocToMd({
      children: [
        { tagName: "h1", textContent: "Title" },
        { tagName: "p", textContent: "Paragraph." },
      ],
      tagName: "my-comp",
    });
    expect(md).toContain("# Title");
    expect(md).toContain("Paragraph.");
    expect(md).not.toContain(":::h1");
    expect(md).not.toContain(":::p");
  });

  test("decorated element emits directive syntax", () => {
    const md = jxDocToMd({
      children: [{ style: { color: "red" }, tagName: "p", textContent: "Colored" }],
      tagName: "my-comp",
    });
    expect(md).toContain(':::p{style.color="red"}');
    expect(md).toContain("Colored");
    expect(md).toContain(":::");
  });

  test("mixed inline content in decorated p serializes on one line", () => {
    const md = jxDocToMd({
      children: [
        {
          children: [
            "Another paragraph, just to test ",
            { tagName: "strong", textContent: "things" },
            " out.",
          ],
          style: { color: "#b59a9a" },
          tagName: "p",
        },
      ],
      tagName: "my-comp",
    });
    expect(md).toContain(':::p{style.color="#b59a9a"}');
    expect(md).toContain("Another paragraph, just to test **things** out.");
  });

  test("bare text nodes serialize in standard paragraphs", () => {
    const md = jxDocToMd({
      children: [
        {
          children: ["Hello ", { tagName: "strong", textContent: "world" }, "!"],
          tagName: "p",
        },
      ],
      tagName: "my-comp",
    });
    expect(md).toContain("Hello **world**!");
    expect(md).not.toContain(":::p");
  });

  test("frontmatter emitted for non-children props", () => {
    const md = jxDocToMd({
      $elements: [{ $ref: "./components/hero.json" }],
      children: [{ tagName: "p", textContent: "Hi" }],
      tagName: "my-comp",
    });
    expect(md).toContain("---");
    expect(md).toContain("tagName: my-comp");
    expect(md).toContain("Hi");
  });

  test("custom element without children emits leaf directive", () => {
    const md = jxDocToMd({
      children: [{ tagName: "hero-banner" }],
      tagName: "my-comp",
    });
    expect(md).toContain("::hero-banner");
  });

  test("inline HTML in markdown converts to Jx directives on save", () => {
    const md = jxDocToMd({
      children: [
        {
          attributes: { src: "https://example.com/form", title: "Form" },
          tagName: "iframe",
        },
        {
          attributes: { src: "https://example.com/embed.js" },
          tagName: "script",
        },
      ],
      tagName: "my-comp",
    });
    expect(md).toContain("::iframe");
    expect(md).toContain('src="https://example.com/form"');
    expect(md).toContain("::script");
    expect(md).not.toContain("<iframe");
    expect(md).not.toContain("<script");
  });
});
