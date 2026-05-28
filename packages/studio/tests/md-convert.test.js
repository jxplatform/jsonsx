import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import { mdToJx, jxToMd, jxDocToMd } from "../src/markdown/md-convert.js";

// ─── Helpers — build mdast nodes ─────────────────────────────────────────────

/** @param {any[]} children */
function root(...children) {
  return { type: "root", children };
}

/** @param {any} depth @param {any} text */
function heading(depth, text) {
  return { type: "heading", depth, children: [{ type: "text", value: text }] };
}

/** @param {any} text */
function paragraph(text) {
  return { type: "paragraph", children: [{ type: "text", value: text }] };
}

/** @param {any} text */
function emphasis(text) {
  return { type: "emphasis", children: [{ type: "text", value: text }] };
}

/** @param {any} text */
function strong(text) {
  return { type: "strong", children: [{ type: "text", value: text }] };
}

/** @param {any} url @param {any} text @param {any} [title] */
function link(url, text, title) {
  return { type: "link", url, title: title ?? null, children: [{ type: "text", value: text }] };
}

/** @param {any} url @param {any} alt @param {any} title */
function image(url, alt, title) {
  return { type: "image", url, alt: alt ?? "", title: title ?? null };
}

/** @param {any} value */
function inlineCode(value) {
  return { type: "inlineCode", value };
}

/** @param {any} ordered @param {any[]} items */
function list(ordered, ...items) {
  return { type: "list", ordered, spread: false, children: items };
}

/** @param {any[]} children */
function listItem(...children) {
  return { type: "listItem", spread: false, children };
}

/** @param {any} value @param {any} lang */
function codeBlock(value, lang) {
  return { type: "code", lang: lang ?? null, value };
}

function thematicBreak() {
  return { type: "thematicBreak" };
}

// ─── mdToJx ──────────────────────────────────────────────────────────────

describe("mdToJx", () => {
  test("root node becomes document container", () => {
    /** @type {any} */
    const result = mdToJx(root());
    expect(result.tagName).toBeUndefined();
    expect(result.children).toEqual([]);
  });

  test("converts heading", () => {
    /** @type {any} */
    const result = mdToJx(root(heading(2, "Hello")));
    expect(result.children[0]).toEqual({ tagName: "h2", textContent: "Hello" });
  });

  test("converts all heading depths", () => {
    for (let i = 1; i <= 6; i++) {
      /** @type {any} */
      const result = mdToJx(root(heading(i, "H")));
      expect(result.children[0].tagName).toBe(`h${i}`);
    }
  });

  test("converts paragraph", () => {
    /** @type {any} */
    const result = mdToJx(root(paragraph("Some text")));
    expect(result.children[0]).toEqual({ tagName: "p", textContent: "Some text" });
  });

  test("converts emphasis", () => {
    const mdast = root({
      type: "paragraph",
      children: [emphasis("italic")],
    });
    /** @type {any} */
    const result = mdToJx(mdast);
    const p = result.children[0];
    expect(p.children[0]).toEqual({ tagName: "em", textContent: "italic" });
  });

  test("converts strong", () => {
    const mdast = root({
      type: "paragraph",
      children: [strong("bold")],
    });
    /** @type {any} */
    const result = mdToJx(mdast);
    const p = result.children[0];
    expect(p.children[0]).toEqual({ tagName: "strong", textContent: "bold" });
  });

  test("converts inline code", () => {
    const mdast = root({
      type: "paragraph",
      children: [inlineCode("const x = 1")],
    });
    /** @type {any} */
    const result = mdToJx(mdast);
    const p = result.children[0];
    expect(p.children[0]).toEqual({ tagName: "code", textContent: "const x = 1" });
  });

  test("converts link", () => {
    const mdast = root({
      type: "paragraph",
      children: [link("https://example.com", "Example")],
    });
    /** @type {any} */
    const result = mdToJx(mdast);
    const a = result.children[0].children[0];
    expect(a.tagName).toBe("a");
    expect(a.attributes.href).toBe("https://example.com");
    expect(a.textContent).toBe("Example");
  });

  test("converts image", () => {
    const mdast = root({
      type: "paragraph",
      children: [image("img.png", "Alt text", "Title")],
    });
    /** @type {any} */
    const result = mdToJx(mdast);
    const img = result.children[0].children[0];
    expect(img.tagName).toBe("img");
    expect(img.attributes.src).toBe("img.png");
    expect(img.attributes.alt).toBe("Alt text");
    expect(img.attributes.title).toBe("Title");
  });

  test("converts unordered list", () => {
    const mdast = root(list(false, listItem(paragraph("Item 1")), listItem(paragraph("Item 2"))));
    /** @type {any} */
    const result = mdToJx(mdast);
    const ul = result.children[0];
    expect(ul.tagName).toBe("ul");
    expect(ul.children.length).toBe(2);
    expect(ul.children[0].tagName).toBe("li");
  });

  test("converts ordered list", () => {
    const mdast = root(list(true, listItem(paragraph("First"))));
    /** @type {any} */
    const result = mdToJx(mdast);
    expect(result.children[0].tagName).toBe("ol");
  });

  test("converts code block", () => {
    const mdast = root(codeBlock("console.log('hi')", "js"));
    /** @type {any} */
    const result = mdToJx(mdast);
    const pre = result.children[0];
    expect(pre.tagName).toBe("pre");
    expect(pre.children[0].tagName).toBe("code");
    expect(pre.children[0].textContent).toBe("console.log('hi')");
    expect(pre.children[0].attributes.class).toBe("language-js");
  });

  test("converts thematic break", () => {
    const mdast = root(thematicBreak());
    /** @type {any} */
    const result = mdToJx(mdast);
    expect(result.children[0]).toEqual({ tagName: "hr" });
  });

  test("filters out yaml frontmatter nodes", () => {
    const mdast = root({ type: "yaml", value: "title: Test" }, paragraph("Hello"));
    /** @type {any} */
    const result = mdToJx(mdast);
    expect(result.children.length).toBe(1);
    expect(result.children[0].tagName).toBe("p");
  });

  test("converts blockquote", () => {
    const mdast = root({
      type: "blockquote",
      children: [paragraph("Quoted text")],
    });
    /** @type {any} */
    const result = mdToJx(mdast);
    const bq = result.children[0];
    expect(bq.tagName).toBe("blockquote");
    expect(bq.children[0]).toEqual({ tagName: "p", textContent: "Quoted text" });
  });
});

// ─── jxToMd ──────────────────────────────────────────────────────────────

describe("jxToMd", () => {
  test("empty document", () => {
    /** @type {any} */
    const result = jxToMd({ tagName: "div", children: [] });
    expect(result).toEqual({ type: "root", children: [] });
  });

  test("paragraph", () => {
    /** @type {any} */
    const result = jxToMd({
      tagName: "div",
      children: [{ tagName: "p", textContent: "Hello" }],
    });
    expect(result.children[0].type).toBe("paragraph");
    expect(result.children[0].children[0]).toEqual({ type: "text", value: "Hello" });
  });

  test("heading depth", () => {
    /** @type {any} */
    const result = jxToMd({
      tagName: "div",
      children: [{ tagName: "h3", textContent: "Title" }],
    });
    expect(result.children[0].type).toBe("heading");
    expect(result.children[0].depth).toBe(3);
  });

  test("link", () => {
    /** @type {any} */
    const result = jxToMd({
      tagName: "div",
      children: [
        {
          tagName: "p",
          children: [{ tagName: "a", attributes: { href: "https://x.com" }, textContent: "Link" }],
        },
      ],
    });
    const link = result.children[0].children[0];
    expect(link.type).toBe("link");
    expect(link.url).toBe("https://x.com");
  });

  test("image", () => {
    /** @type {any} */
    const result = jxToMd({
      tagName: "div",
      children: [
        {
          tagName: "p",
          children: [{ tagName: "img", attributes: { src: "photo.jpg", alt: "A photo" } }],
        },
      ],
    });
    const img = result.children[0].children[0];
    expect(img.type).toBe("image");
    expect(img.url).toBe("photo.jpg");
    expect(img.alt).toBe("A photo");
  });

  test("unordered list", () => {
    /** @type {any} */
    const result = jxToMd({
      tagName: "div",
      children: [
        {
          tagName: "ul",
          children: [
            { tagName: "li", children: [{ tagName: "p", textContent: "A" }] },
            { tagName: "li", children: [{ tagName: "p", textContent: "B" }] },
          ],
        },
      ],
    });
    const list = result.children[0];
    expect(list.type).toBe("list");
    expect(list.ordered).toBe(false);
    expect(list.children.length).toBe(2);
  });

  test("ordered list", () => {
    /** @type {any} */
    const result = jxToMd({
      tagName: "div",
      children: [
        {
          tagName: "ol",
          children: [{ tagName: "li", children: [{ tagName: "p", textContent: "First" }] }],
        },
      ],
    });
    expect(result.children[0].ordered).toBe(true);
  });

  test("code block with language", () => {
    /** @type {any} */
    const result = jxToMd({
      tagName: "div",
      children: [
        {
          tagName: "pre",
          children: [
            {
              tagName: "code",
              textContent: "const x = 1",
              attributes: { class: "language-js" },
            },
          ],
        },
      ],
    });
    const code = result.children[0];
    expect(code.type).toBe("code");
    expect(code.lang).toBe("js");
    expect(code.value).toBe("const x = 1");
  });

  test("thematic break", () => {
    /** @type {any} */
    const result = jxToMd({
      tagName: "div",
      children: [{ tagName: "hr" }],
    });
    expect(result.children[0].type).toBe("thematicBreak");
  });

  test("non-markdown tag becomes directive", () => {
    /** @type {any} */
    const result = jxToMd({
      tagName: "div",
      children: [{ tagName: "my-widget", attributes: { color: "red" } }],
    });
    const directive = result.children[0];
    expect(directive.type).toBe("leafDirective");
    expect(directive.name).toBe("my-widget");
    expect(directive.attributes.color).toBe("red");
  });
});

// ─── Round-trip ──────────────────────────────────────────────────────────────

describe("round-trip", () => {
  test("paragraph survives round-trip", () => {
    const mdast = root(paragraph("Hello world"));
    /** @type {any} */
    const jx = mdToJx(mdast);
    /** @type {any} */
    const back = jxToMd(jx);
    expect(back.children[0].type).toBe("paragraph");
    expect(back.children[0].children[0].value).toBe("Hello world");
  });

  test("heading survives round-trip", () => {
    const mdast = root(heading(2, "Title"));
    /** @type {any} */
    const jx = mdToJx(mdast);
    /** @type {any} */
    const back = jxToMd(jx);
    expect(back.children[0].type).toBe("heading");
    expect(back.children[0].depth).toBe(2);
    expect(back.children[0].children[0].value).toBe("Title");
  });

  test("code block survives round-trip", () => {
    const mdast = root(codeBlock("x = 1", "python"));
    /** @type {any} */
    const jx = mdToJx(mdast);
    /** @type {any} */
    const back = jxToMd(jx);
    expect(back.children[0].type).toBe("code");
    expect(back.children[0].lang).toBe("python");
    expect(back.children[0].value).toBe("x = 1");
  });

  test("thematic break survives round-trip", () => {
    const mdast = root(thematicBreak());
    /** @type {any} */
    const jx = mdToJx(mdast);
    /** @type {any} */
    const back = jxToMd(jx);
    expect(back.children[0].type).toBe("thematicBreak");
  });
});

// ─── Bare text nodes ────────────────────────────────────────────────────────

describe("jxToMd bare text nodes", () => {
  test("bare string children become mdast text nodes", () => {
    /** @type {any} */
    const result = jxToMd({
      children: [
        {
          tagName: "p",
          children: ["Hello ", { tagName: "strong", textContent: "world" }, "!"],
        },
      ],
    });
    const p = result.children[0];
    expect(p.type).toBe("paragraph");
    expect(p.children).toEqual([
      { type: "text", value: "Hello " },
      { type: "strong", children: [{ type: "text", value: "world" }] },
      { type: "text", value: "!" },
    ]);
  });

  test("bare number children become text nodes", () => {
    /** @type {any} */
    const result = jxToMd({
      children: [{ tagName: "p", children: /** @type {any} */ (["Score: ", 42]) }],
    });
    const p = result.children[0];
    expect(p.children[0]).toEqual({ type: "text", value: "Score: " });
    expect(p.children[1]).toEqual({ type: "text", value: "42" });
  });

  test("null and undefined children are filtered out", () => {
    /** @type {any} */
    const result = jxToMd({
      children: [{ tagName: "p", children: /** @type {any} */ (["text", null, undefined]) }],
    });
    expect(result.children[0].children).toEqual([{ type: "text", value: "text" }]);
  });
});

// ─── Jx props → directive routing ───────────────────────────────────────────

describe("jxToMd Jx props trigger directive", () => {
  test("plain p stays as paragraph", () => {
    /** @type {any} */
    const result = jxToMd({
      children: [{ tagName: "p", textContent: "Hello" }],
    });
    expect(result.children[0].type).toBe("paragraph");
  });

  test("p with style becomes container directive", () => {
    /** @type {any} */
    const result = jxToMd({
      children: [{ tagName: "p", style: { color: "red" }, textContent: "Hello" }],
    });
    expect(result.children[0].type).toBe("containerDirective");
    expect(result.children[0].name).toBe("p");
    expect(result.children[0].attributes["style.color"]).toBe("red");
  });

  test("heading with style becomes container directive", () => {
    /** @type {any} */
    const result = jxToMd({
      children: [{ tagName: "h2", style: { fontSize: "2em" }, textContent: "Title" }],
    });
    expect(result.children[0].type).toBe("containerDirective");
    expect(result.children[0].name).toBe("h2");
  });

  test("element with $ref becomes directive", () => {
    /** @type {any} */
    const result = jxToMd({
      children: [{ tagName: "p", $ref: "./components/fancy-p.json", textContent: "Hi" }],
    });
    expect(result.children[0].type).toBe("containerDirective");
    expect(result.children[0].attributes.ref).toBe("./components/fancy-p.json");
  });
});

// ─── Container directive inline content ─────────────────────────────────────

describe("container directive inline content", () => {
  test("decorated p wraps mixed children in single paragraph", () => {
    /** @type {any} */
    const result = jxToMd({
      children: [
        {
          tagName: "p",
          style: { color: "#b59a9a" },
          children: [
            "Another paragraph, just to test ",
            { tagName: "strong", textContent: "things" },
            " out.",
          ],
        },
      ],
    });
    const directive = result.children[0];
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
    expect(directive.children[0].children[2]).toEqual({ type: "text", value: " out." });
  });

  test("decorated h1 wraps children in single paragraph", () => {
    /** @type {any} */
    const result = jxToMd({
      children: [
        {
          tagName: "h1",
          style: { color: "blue" },
          children: ["Welcome to ", { tagName: "em", textContent: "Jx" }],
        },
      ],
    });
    const directive = result.children[0];
    expect(directive.type).toBe("containerDirective");
    expect(directive.children.length).toBe(1);
    expect(directive.children[0].type).toBe("paragraph");
    expect(directive.children[0].children.length).toBe(2);
  });

  test("non-inline-content tag keeps block children", () => {
    /** @type {any} */
    const result = jxToMd({
      children: [
        {
          tagName: "my-section",
          children: [
            { tagName: "h1", textContent: "Title" },
            { tagName: "p", textContent: "Body" },
          ],
        },
      ],
    });
    const directive = result.children[0];
    expect(directive.type).toBe("containerDirective");
    // Block children stay as separate nodes, not wrapped in a paragraph
    expect(directive.children.length).toBe(2);
    expect(directive.children[0].type).toBe("heading");
    expect(directive.children[1].type).toBe("paragraph");
  });

  test("decorated p with textContent wraps in paragraph", () => {
    /** @type {any} */
    const result = jxToMd({
      children: [{ tagName: "p", style: { fontWeight: "bold" }, textContent: "Simple text" }],
    });
    const directive = result.children[0];
    expect(directive.children.length).toBe(1);
    expect(directive.children[0].type).toBe("paragraph");
    expect(directive.children[0].children[0].value).toBe("Simple text");
  });
});

// ─── jxDocToMd serialization ────────────────────────────────────────────────

describe("jxDocToMd", () => {
  test("undecorated elements emit standard markdown", () => {
    const md = jxDocToMd({
      tagName: "my-comp",
      children: [
        { tagName: "h1", textContent: "Title" },
        { tagName: "p", textContent: "Paragraph." },
      ],
    });
    expect(md).toContain("# Title");
    expect(md).toContain("Paragraph.");
    expect(md).not.toContain(":::h1");
    expect(md).not.toContain(":::p");
  });

  test("decorated element emits directive syntax", () => {
    const md = jxDocToMd({
      tagName: "my-comp",
      children: [{ tagName: "p", style: { color: "red" }, textContent: "Colored" }],
    });
    expect(md).toContain(':::p{style.color="red"}');
    expect(md).toContain("Colored");
    expect(md).toContain(":::");
  });

  test("mixed inline content in decorated p serializes on one line", () => {
    const md = jxDocToMd({
      tagName: "my-comp",
      children: [
        {
          tagName: "p",
          style: { color: "#b59a9a" },
          children: [
            "Another paragraph, just to test ",
            { tagName: "strong", textContent: "things" },
            " out.",
          ],
        },
      ],
    });
    expect(md).toContain(':::p{style.color="#b59a9a"}');
    expect(md).toContain("Another paragraph, just to test **things** out.");
  });

  test("bare text nodes serialize in standard paragraphs", () => {
    const md = jxDocToMd({
      tagName: "my-comp",
      children: [
        {
          tagName: "p",
          children: ["Hello ", { tagName: "strong", textContent: "world" }, "!"],
        },
      ],
    });
    expect(md).toContain("Hello **world**!");
    expect(md).not.toContain(":::p");
  });

  test("frontmatter emitted for non-children props", () => {
    const md = jxDocToMd({
      tagName: "my-comp",
      $elements: [{ $ref: "./components/hero.json" }],
      children: [{ tagName: "p", textContent: "Hi" }],
    });
    expect(md).toContain("---");
    expect(md).toContain("tagName: my-comp");
    expect(md).toContain("Hi");
  });

  test("custom element without children emits leaf directive", () => {
    const md = jxDocToMd({
      tagName: "my-comp",
      children: [{ tagName: "hero-banner" }],
    });
    expect(md).toContain("::hero-banner");
  });

  test("inline HTML in markdown converts to Jx directives on save", () => {
    const md = jxDocToMd({
      tagName: "my-comp",
      children: [
        {
          tagName: "iframe",
          attributes: { src: "https://example.com/form", title: "Form" },
        },
        {
          tagName: "script",
          attributes: { src: "https://example.com/embed.js" },
        },
      ],
    });
    expect(md).toContain("::iframe");
    expect(md).toContain('src="https://example.com/form"');
    expect(md).toContain("::script");
    expect(md).not.toContain("<iframe");
    expect(md).not.toContain("<script");
  });
});
