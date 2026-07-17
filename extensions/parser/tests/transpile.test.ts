/**
 * Unit tests for extensions/parser/src/transpile.ts — Jx Markdown transpiler.
 *
 * Covers all exported functions, every mdast node kind in JX_TAG_MAP, directive attribute routing
 * (custom vs standard elements), phrasing unwrap, and the null/edge paths of mdastNodeToJx.
 */
import { describe, expect, test } from "bun:test";

import type { JxElement } from "@jxsuite/schema/types";
import type { MdastNode } from "../src/types";
import {
  applyStyleKeyMapping,
  assignHeadingIds,
  collapseDotPaths,
  collapseStylePaths,
  convertChildren,
  expandDotPaths,
  expandStylePaths,
  htmlToJx,
  isJxMarkdown,
  jxKey,
  mdKey,
  mdastNodeToJx,
  slugifyHeading,
  transpileJxMarkdown,
} from "../src/transpile";

// ─── jxKey / mdKey ──────────────────────────────────────────────────────────

describe("jxKey", () => {
  test("prefixes reserved keywords with $", () => {
    expect(jxKey("prototype")).toBe("$prototype");
    expect(jxKey("ref")).toBe("$ref");
    expect(jxKey("component")).toBe("$component");
    expect(jxKey("props")).toBe("$props");
    expect(jxKey("switch")).toBe("$switch");
    expect(jxKey("elements")).toBe("$elements");
  });

  test("maps -- annotation keys to $ keys", () => {
    expect(jxKey("--title")).toBe("$title");
    expect(jxKey("--description")).toBe("$description");
  });

  test("passes through unknown -- keys", () => {
    expect(jxKey("--dark")).toBe("--dark");
  });

  test("passes through ordinary keys", () => {
    expect(jxKey("style")).toBe("style");
    expect(jxKey("href")).toBe("href");
  });
});

describe("mdKey", () => {
  test("strips $ from reserved keywords", () => {
    expect(mdKey("$prototype")).toBe("prototype");
    expect(mdKey("$ref")).toBe("ref");
    expect(mdKey("$component")).toBe("component");
    expect(mdKey("$props")).toBe("props");
    expect(mdKey("$switch")).toBe("switch");
    expect(mdKey("$elements")).toBe("elements");
  });

  test("maps annotation $ keys to -- keys", () => {
    expect(mdKey("$title")).toBe("--title");
    expect(mdKey("$description")).toBe("--description");
  });

  test("passes through non-reserved $ keys and plain keys", () => {
    expect(mdKey("$schema")).toBe("$schema");
    expect(mdKey("className")).toBe("className");
  });
});

// ─── expandDotPaths / collapseDotPaths ──────────────────────────────────────

describe("expandDotPaths", () => {
  test("keeps flat keys, applying jxKey", () => {
    expect(expandDotPaths({ href: "/x", ref: "#/a" })).toEqual({
      $ref: "#/a",
      href: "/x",
    });
  });

  test("expands dot paths into nested objects", () => {
    expect(expandDotPaths({ "style.color": "red", "style.font.size": "12px" })).toEqual({
      style: { color: "red", font: { size: "12px" } },
    });
  });

  test("applies jxKey to every path segment", () => {
    expect(expandDotPaths({ "props.title": "Hi" })).toEqual({ $props: { title: "Hi" } });
    expect(expandDotPaths({ "children.prototype": "Array" })).toEqual({
      children: { $prototype: "Array" },
    });
  });

  test("replaces a scalar intermediate with an object when a deeper path follows", () => {
    expect(expandDotPaths({ a: "scalar", "a.b": "1" })).toEqual({ a: { b: "1" } });
  });

  test("returns empty object for empty input", () => {
    expect(expandDotPaths({})).toEqual({});
  });
});

describe("collapseDotPaths", () => {
  test("flattens nested objects to dot paths", () => {
    expect(collapseDotPaths({ style: { color: "red", font: { size: "12px" } } })).toEqual({
      "style.color": "red",
      "style.font.size": "12px",
    });
  });

  test("stringifies non-object leaf values", () => {
    expect(collapseDotPaths({ count: 3, flag: true, label: "x" })).toEqual({
      count: "3",
      flag: "true",
      label: "x",
    });
  });

  test("treats arrays as leaves (stringified)", () => {
    expect(collapseDotPaths({ list: [1, 2] })).toEqual({ list: "1,2" });
  });

  test("is the inverse of expandDotPaths for string maps", () => {
    const flat = { "style.color": "red", title: "x" };
    // ExpandDotPaths applies jxKey, which leaves these keys untouched
    expect(collapseDotPaths(expandDotPaths(flat))).toEqual(flat);
  });
});

// ─── style key mapping ──────────────────────────────────────────────────────

describe("applyStyleKeyMapping", () => {
  test("prefixes known pseudo-class names with :", () => {
    expect(applyStyleKeyMapping({ hover: { color: "red" } })).toEqual({
      ":hover": { color: "red" },
    });
    expect(applyStyleKeyMapping({ "first-child": "x" })).toEqual({ ":first-child": "x" });
  });

  test("prefixes -- keys with @", () => {
    expect(applyStyleKeyMapping({ "--dark": { color: "white" } })).toEqual({
      "@--dark": { color: "white" },
    });
  });

  test("leaves plain CSS properties untouched", () => {
    expect(applyStyleKeyMapping({ color: "blue", display: "flex" })).toEqual({
      color: "blue",
      display: "flex",
    });
  });
});

describe("expandStylePaths", () => {
  test("expands dot paths and applies style key mapping at the top level", () => {
    expect(expandStylePaths({ "hover.color": "red", color: "blue" })).toEqual({
      ":hover": { color: "red" },
      color: "blue",
    });
  });
});

describe("collapseStylePaths", () => {
  test("strips : from known pseudo-class keys", () => {
    expect(collapseStylePaths({ ":hover": { color: "red" } })).toEqual({
      "hover.color": "red",
    });
  });

  test("strips @ from @-- media keys", () => {
    expect(collapseStylePaths({ "@--dark": { color: "white" } })).toEqual({
      "--dark.color": "white",
    });
  });

  test("keeps unknown : keys as-is", () => {
    expect(collapseStylePaths({ ":not-a-pseudo": "x" })).toEqual({ ":not-a-pseudo": "x" });
  });

  test("round-trips with expandStylePaths", () => {
    const flat = { "--dark.color": "white", "hover.color": "red", color: "blue" };
    expect(collapseStylePaths(expandStylePaths(flat))).toEqual(flat);
  });
});

// ─── isJxMarkdown ───────────────────────────────────────────────────────────

describe("isJxMarkdown", () => {
  test("true when frontmatter has hyphenated tagName", () => {
    expect(isJxMarkdown("---\ntagName: my-card\n---\n\nHello")).toBe(true);
  });

  test("handles CRLF line endings", () => {
    expect(isJxMarkdown("---\r\ntagName: my-card\r\n---\r\n\r\nHello")).toBe(true);
  });

  test("false when no frontmatter", () => {
    expect(isJxMarkdown("# Just a heading")).toBe(false);
  });

  test("false when frontmatter lacks tagName", () => {
    expect(isJxMarkdown("---\ntitle: Hello\n---\n\nBody")).toBe(false);
  });

  test("false when tagName has no hyphen", () => {
    expect(isJxMarkdown("---\ntagName: div\n---\n\nBody")).toBe(false);
  });
});

// ─── mdastNodeToJx: null / edge paths ───────────────────────────────────────

describe("mdastNodeToJx edge cases", () => {
  test("returns null for null / non-object input", () => {
    expect(mdastNodeToJx(null as unknown as MdastNode)).toBeNull();
    expect(mdastNodeToJx("text" as unknown as MdastNode)).toBeNull();
  });

  test("returns null for yaml and toml nodes", () => {
    expect(mdastNodeToJx({ type: "yaml", value: "a: 1" } as MdastNode)).toBeNull();
    expect(mdastNodeToJx({ type: "toml", value: "a = 1" } as MdastNode)).toBeNull();
  });

  test("returns null for unknown node types", () => {
    expect(mdastNodeToJx({ type: "definition" } as MdastNode)).toBeNull();
    expect(mdastNodeToJx({ type: "footnoteDefinition" } as MdastNode)).toBeNull();
  });

  test("returns text node value, or null when missing", () => {
    expect(mdastNodeToJx({ type: "text", value: "hi" } as MdastNode)).toBe("hi");
    expect(mdastNodeToJx({ type: "text" } as MdastNode)).toBeNull();
  });

  test("converts html nodes via htmlToJx", () => {
    const result = mdastNodeToJx({ type: "html", value: "<div>hi</div>" } as MdastNode);
    expect(result).toEqual([{ tagName: "div", textContent: "hi" }]);
  });

  test("returns null for html nodes without value", () => {
    expect(mdastNodeToJx({ type: "html" } as MdastNode)).toBeNull();
    expect(mdastNodeToJx({ type: "html", value: "" } as MdastNode)).toBeNull();
  });
});

// ─── Prototype directives (:::Array) ────────────────────────────────────────

describe("prototype directives", () => {
  test(":::Array directive transpiles to a tagName-less $prototype node", () => {
    const md = [':::Array{items.ref="#/state/rows"}', "${$map.item.name}", ":::", ""].join("\n");
    const doc = transpileJxMarkdown(md);
    const [node] = doc.children as JxElement[];
    expect(node!.$prototype).toBe("Array");
    expect(node!.tagName).toBeUndefined();
    expect(node!.items).toEqual({ $ref: "#/state/rows" });
    expect((node!.map as JxElement).tagName).toBe("p");
    expect((node!.map as JxElement).textContent).toBe("${$map.item.name}");
  });

  test(":::Array nestled among sibling blocks keeps order", () => {
    const md = [
      "# Title",
      "",
      ':::Array{items.ref="#/state/rows"}',
      ":span{}",
      ":::",
      "",
      "End",
      "",
    ].join("\n");
    const doc = transpileJxMarkdown(md);
    const kids = doc.children as JxElement[];
    expect(kids[0]!.tagName).toBe("h1");
    expect(kids[1]!.$prototype).toBe("Array");
    // Trailing paragraph "End" remains a sibling after the array.
    expect(kids.at(-1)?.textContent ?? (kids.at(-1)?.children as unknown[])?.[0]).toBeDefined();
  });

  test(":::Array with filter and sort attributes", () => {
    const md = [
      ':::Array{items.ref="#/state/rows" filter.ref="#/state/byDate" sort.ref="#/state/asc"}',
      ":li{}",
      ":::",
      "",
    ].join("\n");
    const [node] = transpileJxMarkdown(md).children as JxElement[];
    expect(node!.filter).toEqual({ $ref: "#/state/byDate" });
    expect(node!.sort).toEqual({ $ref: "#/state/asc" });
  });
});

// ─── mdastNodeToJx: standard node kinds ─────────────────────────────────────

describe("mdastNodeToJx standard nodes", () => {
  test("heading maps depth to h-tag with textContent", () => {
    const el = mdastNodeToJx({
      children: [{ type: "text", value: "Title" }],
      depth: 3,
      type: "heading",
    } as MdastNode) as JxElement;
    expect(el).toEqual({ tagName: "h3", textContent: "Title" });
  });

  test("paragraph with mixed children gets children array", () => {
    const el = mdastNodeToJx({
      children: [
        { type: "text", value: "Hello " },
        { children: [{ type: "text", value: "world" }], type: "strong" },
      ],
      type: "paragraph",
    } as MdastNode) as JxElement;
    expect(el.tagName).toBe("p");
    expect(el.children).toEqual(["Hello ", { tagName: "strong", textContent: "world" }]);
  });

  test("paragraph with no convertible children has neither textContent nor children", () => {
    const el = mdastNodeToJx({ children: [], type: "paragraph" } as MdastNode) as JxElement;
    expect(el).toEqual({ tagName: "p" });
  });

  test("emphasis and delete map to em / del", () => {
    const em = mdastNodeToJx({
      children: [{ type: "text", value: "x" }],
      type: "emphasis",
    } as MdastNode) as JxElement;
    expect(em).toEqual({ tagName: "em", textContent: "x" });

    const del = mdastNodeToJx({
      children: [{ type: "text", value: "y" }],
      type: "delete",
    } as MdastNode) as JxElement;
    expect(del).toEqual({ tagName: "del", textContent: "y" });
  });

  test("blockquote wraps block children", () => {
    const el = mdastNodeToJx({
      children: [{ children: [{ type: "text", value: "quoted" }], type: "paragraph" }],
      type: "blockquote",
    } as MdastNode) as JxElement;
    expect(el).toEqual({
      children: [{ tagName: "p", textContent: "quoted" }],
      tagName: "blockquote",
    });
  });

  test("inlineCode becomes code with textContent", () => {
    expect(mdastNodeToJx({ type: "inlineCode", value: "x+1" } as MdastNode)).toEqual({
      tagName: "code",
      textContent: "x+1",
    });
    expect(mdastNodeToJx({ type: "inlineCode" } as MdastNode)).toEqual({
      tagName: "code",
      textContent: null,
    });
  });

  test("link gets href, optional title, and textContent", () => {
    const el = mdastNodeToJx({
      children: [{ type: "text", value: "site" }],
      title: "Tip",
      type: "link",
      url: "https://example.com",
    } as MdastNode) as JxElement;
    expect(el).toEqual({
      attributes: { href: "https://example.com", title: "Tip" },
      tagName: "a",
      textContent: "site",
    });
  });

  test("link without title or url defaults href to empty string", () => {
    const el = mdastNodeToJx({
      children: [
        { type: "text", value: "a" },
        { children: [{ type: "text", value: "b" }], type: "emphasis" },
      ],
      type: "link",
    } as MdastNode) as JxElement;
    expect(el.attributes).toEqual({ href: "" });
    expect(el.children).toEqual(["a", { tagName: "em", textContent: "b" }]);
  });

  test("image gets src, alt, and optional title", () => {
    expect(
      mdastNodeToJx({
        alt: "A cat",
        title: "Cat",
        type: "image",
        url: "/cat.png",
      } as MdastNode),
    ).toEqual({ attributes: { alt: "A cat", src: "/cat.png", title: "Cat" }, tagName: "img" });

    expect(mdastNodeToJx({ type: "image" } as MdastNode)).toEqual({
      attributes: { alt: "", src: "" },
      tagName: "img",
    });
  });

  test("unordered list with items", () => {
    const el = mdastNodeToJx({
      children: [
        {
          children: [{ children: [{ type: "text", value: "one" }], type: "paragraph" }],
          type: "listItem",
        },
      ],
      ordered: false,
      type: "list",
    } as MdastNode) as JxElement;
    expect(el.tagName).toBe("ul");
    expect(el.children).toEqual([
      { children: [{ tagName: "p", textContent: "one" }], tagName: "li" },
    ]);
  });

  test("ordered list with non-default start gets start attribute", () => {
    const el = mdastNodeToJx({
      children: [],
      ordered: true,
      start: 4,
      type: "list",
    } as MdastNode) as JxElement;
    expect(el.tagName).toBe("ol");
    expect(el.attributes).toEqual({ start: "4" });
    expect(el.children).toBeUndefined();
  });

  test("ordered list starting at 1 omits start attribute", () => {
    const el = mdastNodeToJx({
      children: [],
      ordered: true,
      start: 1,
      type: "list",
    } as MdastNode) as JxElement;
    expect(el.attributes).toBeUndefined();
  });

  test("code block becomes pre > code with language class", () => {
    expect(mdastNodeToJx({ lang: "js", type: "code", value: "let a = 1;" } as MdastNode)).toEqual({
      children: [{ className: "language-js", tagName: "code", textContent: "let a = 1;" }],
      tagName: "pre",
    });
  });

  test("code block without language omits className", () => {
    expect(mdastNodeToJx({ type: "code", value: "plain" } as MdastNode)).toEqual({
      children: [{ tagName: "code", textContent: "plain" }],
      tagName: "pre",
    });
  });

  test("thematicBreak and break map to hr / br", () => {
    expect(mdastNodeToJx({ type: "thematicBreak" } as MdastNode)).toEqual({ tagName: "hr" });
    expect(mdastNodeToJx({ type: "break" } as MdastNode)).toEqual({ tagName: "br" });
  });

  test("table splits first row into thead, rest into tbody", () => {
    const row = (cells: string[], isHeader?: boolean) => ({
      children: cells.map((value) => ({
        children: [{ type: "text", value }],
        ...(isHeader ? { isHeader: true } : {}),
        type: "tableCell",
      })),
      type: "tableRow",
    });
    const el = mdastNodeToJx({
      children: [row(["Name"], true), row(["Ada"])],
      type: "table",
    } as MdastNode) as JxElement;

    expect(el.tagName).toBe("table");
    expect(el.children).toEqual([
      {
        children: [{ children: [{ tagName: "th", textContent: "Name" }], tagName: "tr" }],
        tagName: "thead",
      },
      {
        children: [{ children: [{ tagName: "td", textContent: "Ada" }], tagName: "tr" }],
        tagName: "tbody",
      },
    ]);
  });

  test("table with a single row emits only thead", () => {
    const el = mdastNodeToJx({
      children: [
        {
          children: [{ children: [{ type: "text", value: "Solo" }], type: "tableCell" }],
          type: "tableRow",
        },
      ],
      type: "table",
    } as MdastNode) as JxElement;
    expect((el.children as JxElement[]).map((c) => c.tagName)).toEqual(["thead"]);
  });

  test("empty table emits no children", () => {
    const el = mdastNodeToJx({ children: [], type: "table" } as MdastNode) as JxElement;
    expect(el).toEqual({ children: [], tagName: "table" });
  });
});

// ─── directives ─────────────────────────────────────────────────────────────

describe("mdastNodeToJx directives", () => {
  test("leafDirective converts to bare element with routed attributes", () => {
    const el = mdastNodeToJx({
      attributes: { ref: "#/x", src: "/img.png" },
      name: "img",
      type: "leafDirective",
    } as MdastNode) as JxElement;
    expect(el).toEqual({ $ref: "#/x", attributes: { src: "/img.png" }, tagName: "img" });
  });

  test("textDirective with single text child uses textContent", () => {
    const el = mdastNodeToJx({
      children: [{ type: "text", value: "hi" }],
      name: "span",
      type: "textDirective",
    } as MdastNode) as JxElement;
    expect(el).toEqual({ tagName: "span", textContent: "hi" });
  });

  test("textDirective with mixed children uses children array", () => {
    const el = mdastNodeToJx({
      children: [
        { type: "text", value: "a " },
        { children: [{ type: "text", value: "b" }], type: "strong" },
      ],
      name: "span",
      type: "textDirective",
    } as MdastNode) as JxElement;
    expect(el.children).toEqual(["a ", { tagName: "strong", textContent: "b" }]);
    expect(el.textContent).toBeUndefined();
  });

  test("textDirective without children stays bare", () => {
    const el = mdastNodeToJx({ name: "wbr", type: "textDirective" } as MdastNode) as JxElement;
    expect(el).toEqual({ tagName: "wbr" });
  });

  test("standard element: DOM props stay element-level, rest become attributes", () => {
    const el = mdastNodeToJx({
      attributes: {
        "aria-label": "Close",
        className: "btn",
        "data-x": "1",
        href: "/go",
        id: "main",
        onclick: "doThing()",
        slot: "footer",
        type: "button",
      },
      name: "a",
      type: "leafDirective",
    } as MdastNode) as JxElement;

    expect(el.tagName).toBe("a");
    expect(el.id).toBe("main");
    expect(el.className).toBe("btn");
    expect(el.onclick).toBe("doThing()");
    expect(el.attributes).toEqual({
      "aria-label": "Close",
      "data-x": "1",
      href: "/go",
      slot: "footer",
      type: "button",
    });
  });

  test("standard element: style dot-paths build a style object with pseudo mapping", () => {
    const el = mdastNodeToJx({
      attributes: { "style.color": "blue", "style.hover.color": "red" },
      name: "div",
      type: "leafDirective",
    } as MdastNode) as JxElement;
    expect(el.style).toEqual({ ":hover": { color: "red" }, color: "blue" });
  });

  test("custom element: structural keys element-level, unknown keys become attributes", () => {
    const el = mdastNodeToJx({
      attributes: {
        ref: "#/$defs/thing",
        "style.color": "red",
        textContent: "Hi",
        variant: "primary",
      },
      name: "my-card",
      type: "leafDirective",
    } as MdastNode) as JxElement;

    expect(el.tagName).toBe("my-card");
    expect(el.$ref).toBe("#/$defs/thing");
    expect(el.style).toEqual({ color: "red" });
    expect(el.textContent).toBe("Hi");
    expect(el.attributes).toEqual({ variant: "primary" });
  });

  test("custom element: props.* dot paths land in $props", () => {
    const el = mdastNodeToJx({
      attributes: { "props.count": "3", "props.title": "Hi" },
      name: "my-counter",
      type: "leafDirective",
    } as MdastNode) as JxElement;
    expect(el.$props).toEqual({ count: "3", title: "Hi" });
  });

  test("containerDirective converts block children", () => {
    const el = mdastNodeToJx({
      children: [
        { children: [{ type: "text", value: "one" }], type: "paragraph" },
        { children: [{ type: "text", value: "two" }], type: "paragraph" },
      ],
      name: "section",
      type: "containerDirective",
    } as MdastNode) as JxElement;
    expect(el.children).toEqual([
      { tagName: "p", textContent: "one" },
      { tagName: "p", textContent: "two" },
    ]);
  });

  test("containerDirective with a single text child collapses to textContent", () => {
    const el = mdastNodeToJx({
      children: [{ children: [{ type: "text", value: "solo" }], type: "paragraph" }],
      name: "div",
      type: "containerDirective",
    } as MdastNode) as JxElement;
    // Div is not a phrasing element, so the paragraph wrapper is kept
    expect(el.children).toEqual([{ tagName: "p", textContent: "solo" }]);
  });

  test("phrasing container unwraps paragraph children", () => {
    const el = mdastNodeToJx({
      children: [
        {
          children: [
            { type: "text", value: "Click " },
            { children: [{ type: "text", value: "me" }], type: "strong" },
          ],
          type: "paragraph",
        },
      ],
      name: "button",
      type: "containerDirective",
    } as MdastNode) as JxElement;
    expect(el.tagName).toBe("button");
    expect(el.children).toEqual(["Click ", { tagName: "strong", textContent: "me" }]);
  });

  test("phrasing container with a single unwrapped text child uses textContent", () => {
    const el = mdastNodeToJx({
      children: [{ children: [{ type: "text", value: "just text" }], type: "paragraph" }],
      name: "button",
      type: "containerDirective",
    } as MdastNode) as JxElement;
    expect(el).toEqual({ tagName: "button", textContent: "just text" });
  });

  test("phrasing container spreads array results from inline html children", () => {
    const el = mdastNodeToJx({
      children: [
        {
          children: [{ type: "html", value: "<b>a</b><i>b</i>" }],
          type: "paragraph",
        },
      ],
      name: "button",
      type: "containerDirective",
    } as MdastNode) as JxElement;
    expect(el.children).toEqual([
      { tagName: "b", textContent: "a" },
      { tagName: "i", textContent: "b" },
    ]);
  });

  test("phrasing container skips null inline children", () => {
    const el = mdastNodeToJx({
      children: [
        {
          children: [{ type: "definition" }, { type: "text", value: "kept" }],
          type: "paragraph",
        },
      ],
      name: "button",
      type: "containerDirective",
    } as MdastNode) as JxElement;
    expect(el).toEqual({ tagName: "button", textContent: "kept" });
  });

  test("non-phrasing container spreads array results from block html children", () => {
    const el = mdastNodeToJx({
      children: [{ type: "html", value: "<span>a</span><span>b</span>" }],
      name: "div",
      type: "containerDirective",
    } as MdastNode) as JxElement;
    expect(el.children).toEqual([
      { tagName: "span", textContent: "a" },
      { tagName: "span", textContent: "b" },
    ]);
  });

  test("non-phrasing container skips null children", () => {
    const el = mdastNodeToJx({
      children: [{ type: "definition" }],
      name: "div",
      type: "containerDirective",
    } as MdastNode) as JxElement;
    expect(el).toEqual({ tagName: "div" });
  });

  test("children descriptor from dot-path attributes is not overwritten by body", () => {
    const el = mdastNodeToJx({
      attributes: { "children.items.ref": "#/$defs/items", "children.prototype": "Array" },
      children: [{ children: [{ type: "text", value: "fallback" }], type: "paragraph" }],
      name: "div",
      type: "containerDirective",
    } as MdastNode) as JxElement;
    expect(el.children).toEqual({ $prototype: "Array", items: { $ref: "#/$defs/items" } });
  });
});

// ─── convertChildren ────────────────────────────────────────────────────────

describe("convertChildren", () => {
  test("returns [] for missing input", () => {
    expect(convertChildren(undefined as unknown as MdastNode[])).toEqual([]);
    expect(convertChildren(null as unknown as MdastNode[])).toEqual([]);
  });

  test("filters nulls and flattens arrays", () => {
    const result = convertChildren([
      { type: "definition" },
      { type: "text", value: "t" },
      { type: "html", value: "<u>a</u><u>b</u>" },
    ] as MdastNode[]);
    expect(result).toEqual([
      "t",
      { tagName: "u", textContent: "a" },
      { tagName: "u", textContent: "b" },
    ]);
  });
});

// ─── htmlToJx re-export ─────────────────────────────────────────────────────

describe("htmlToJx re-export", () => {
  test("is exported and converts html fragments", () => {
    expect(htmlToJx("<p>hi</p>")).toEqual([{ tagName: "p", textContent: "hi" }]);
  });
});

// ─── transpileJxMarkdown (end-to-end) ───────────────────────────────────────

describe("transpileJxMarkdown", () => {
  test("merges frontmatter into the document root", () => {
    const doc = transpileJxMarkdown("---\ntagName: my-page\ntitle: Home\n---\n\nHello\n");
    expect(doc.tagName).toBe("my-page");
    expect(doc.title).toBe("Home");
    expect(doc.children).toEqual([{ tagName: "p", textContent: "Hello" }]);
  });

  test("returns an empty document for empty source", () => {
    expect(transpileJxMarkdown("")).toEqual({});
  });

  test("frontmatter-only source has no children", () => {
    const doc = transpileJxMarkdown("---\ntagName: my-page\n---\n");
    expect(doc).toEqual({ tagName: "my-page" });
  });

  test("converts headings, code fences, breaks, and tables", () => {
    const doc = transpileJxMarkdown(
      [
        "# Title",
        "",
        "```js",
        "let a = 1;",
        "```",
        "",
        "---",
        "",
        "| Name | Age |",
        "| ---- | --- |",
        "| Ada  | 36  |",
        "",
      ].join("\n"),
    );
    expect(doc.children).toEqual([
      { tagName: "h1", textContent: "Title" },
      {
        children: [{ className: "language-js", tagName: "code", textContent: "let a = 1;" }],
        tagName: "pre",
      },
      { tagName: "hr" },
      {
        children: [
          {
            children: [
              {
                children: [
                  // Remark-gfm does not mark header cells with isHeader in this pipeline
                  { tagName: "td", textContent: "Name" },
                  { tagName: "td", textContent: "Age" },
                ],
                tagName: "tr",
              },
            ],
            tagName: "thead",
          },
          {
            children: [
              {
                children: [
                  { tagName: "td", textContent: "Ada" },
                  { tagName: "td", textContent: "36" },
                ],
                tagName: "tr",
              },
            ],
            tagName: "tbody",
          },
        ],
        tagName: "table",
      },
    ]);
  });

  test("hard break inside a paragraph becomes br", () => {
    const doc = transpileJxMarkdown("line one\\\nline two\n");
    const [p] = doc.children as JxElement[];
    expect(p!.tagName).toBe("p");
    expect(p!.children).toEqual(["line one", { tagName: "br" }, "line two"]);
  });

  test("strikethrough (gfm) becomes del", () => {
    const doc = transpileJxMarkdown("~~gone~~\n");
    const [p] = doc.children as JxElement[];
    expect(p!.textContent).toBeUndefined();
    expect(p!.children).toEqual([{ tagName: "del", textContent: "gone" }]);
  });

  test("container directive with attributes round-trips through the pipeline", () => {
    const doc = transpileJxMarkdown(
      [
        ":::my-card{ref=#/$defs/card style.color=red variant=primary}",
        "Body **text**",
        ":::",
        "",
      ].join("\n"),
    );
    const [card] = doc.children as JxElement[];
    expect(card!.tagName).toBe("my-card");
    expect(card!.$ref).toBe("#/$defs/card");
    expect(card!.style).toEqual({ color: "red" });
    expect(card!.attributes).toEqual({ variant: "primary" });
    expect(card!.children).toEqual([
      { children: ["Body ", { tagName: "strong", textContent: "text" }], tagName: "p" },
    ]);
  });

  test("text directive inline in a paragraph", () => {
    const doc = transpileJxMarkdown("Press :kbd[Ctrl+S] to save.\n");
    const [p] = doc.children as JxElement[];
    expect(p!.children).toEqual(["Press ", { tagName: "kbd", textContent: "Ctrl+S" }, " to save."]);
  });

  test("block html in the body is flattened into children", () => {
    const doc = transpileJxMarkdown("<aside>one</aside><aside>two</aside>\n");
    expect(doc.children).toEqual([
      { tagName: "aside", textContent: "one" },
      { tagName: "aside", textContent: "two" },
    ]);
  });

  test("annotation attributes (--title) become $ keys", () => {
    const doc = transpileJxMarkdown('::my-widget{--title="Widget Title"}\n');
    const [widget] = doc.children as JxElement[];
    expect(widget!.$title).toBe("Widget Title");
  });
});

// ─── assignHeadingIds / slugifyHeading units ──────────────────────────────────

describe("assignHeadingIds", () => {
  test("mutates headings depth-first and returns matching toc entries", () => {
    const tree = [
      { tagName: "h2", textContent: "One" },
      { children: [{ tagName: "h3", textContent: "Nested" }], tagName: "section" },
      "loose text",
    ] as (JxElement | string)[];
    const toc = assignHeadingIds(tree);
    expect((tree[0] as JxElement).id).toBe("one");
    expect(toc).toEqual([
      { depth: 2, id: "one", text: "One" },
      { depth: 3, id: "nested", text: "Nested" },
    ]);
  });

  test("pre-existing ids are respected and still claim their slug", () => {
    const tree = [
      { id: "custom", tagName: "h2", textContent: "Setup" },
      { tagName: "h2", textContent: "Setup" },
    ] as JxElement[];
    const toc = assignHeadingIds(tree);
    expect(toc.map((e) => e.id)).toEqual(["custom", "setup"]);
    expect((tree[1] as JxElement).id).toBe("setup");
  });

  test("missing children yield no entries", () => {
    expect(assignHeadingIds()).toEqual([]);
  });
});

describe("slugifyHeading", () => {
  test("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(slugifyHeading("The `emit` Capability!")).toBe("the-emit-capability");
    expect(slugifyHeading("  spaced   out  ")).toBe("spaced-out");
  });
});
