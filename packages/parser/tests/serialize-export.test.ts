import { describe, expect, test } from "bun:test";
import { jxToMdast, mdastToJx, serializeJxMarkdown } from "../src/serialize";
import type { JxDocument, JxElement, JxStateDefinition } from "@jxsuite/schema/types";

// Test-local template hooks mirroring the compiler's shared.ts machinery — the
// Compiler injects its real implementations; these cover the same contract.
function evaluateTemplate(str: string, scope: Record<string, unknown>) {
  if (!str.includes("${")) {
    return;
  }
  try {
    const singleExprMatch = str.match(/^\$\{(.+)\}$/s);
    if (singleExprMatch) {
      const fn = new Function("state", "$map", `return (${singleExprMatch[1]})`);
      return fn(scope, scope?.$map) ?? str;
    }
    const fn = new Function("state", "$map", `return \`${str}\``);
    return fn(scope, scope?.$map) ?? str;
  } catch {
    return str;
  }
}

function buildScope(stateDefs: Record<string, JxStateDefinition>) {
  const scope: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(stateDefs ?? {})) {
    scope[key] =
      def && typeof def === "object" && !Array.isArray(def) && "default" in def
        ? (def as { default: unknown }).default
        : def;
  }
  return scope;
}

function compileMarkdown(doc: JxDocument, componentDefs?: Map<string, JxElement>) {
  return {
    content: serializeJxMarkdown(doc, {
      mode: "export",
      ...(componentDefs && { componentDefs }),
      evaluateTemplate,
      buildScope,
    }),
  };
}

// ─── compileMarkdown ────────────────────────────────────────────────────────

describe("compileMarkdown", () => {
  test("returns empty content for doc with no children", () => {
    expect(compileMarkdown({})).toEqual({ content: "" });
    expect(compileMarkdown({ children: [] })).toEqual({ content: "" });
  });

  test("converts heading elements", () => {
    const doc = {
      children: [
        { tagName: "h1", textContent: "Title" },
        { tagName: "h2", textContent: "Subtitle" },
        { tagName: "h3", textContent: "Section" },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("# Title");
    expect(content).toContain("## Subtitle");
    expect(content).toContain("### Section");
  });

  test("converts paragraph elements", () => {
    const doc = {
      children: [{ tagName: "p", textContent: "Hello world" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Hello world");
  });

  test("converts emphasis and strong", () => {
    const doc = {
      children: [
        {
          children: [
            { tagName: "em", textContent: "italic" },
            { tagName: "strong", textContent: "bold" },
          ],
          tagName: "p",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("*italic*");
    expect(content).toContain("**bold**");
  });

  test("converts inline code", () => {
    const doc = {
      children: [
        {
          children: [{ tagName: "code", textContent: "const x = 1" }],
          tagName: "p",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("`const x = 1`");
  });

  test("converts links", () => {
    const doc = {
      children: [
        {
          children: [
            {
              attributes: { href: "https://example.com" },
              tagName: "a",
              textContent: "Example",
            },
          ],
          tagName: "p",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("[Example](https://example.com)");
  });

  test("converts images", () => {
    const doc = {
      children: [{ attributes: { alt: "A photo", src: "/photo.jpg" }, tagName: "img" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("![A photo](/photo.jpg)");
  });

  test("converts blockquotes", () => {
    const doc = {
      children: [
        {
          children: [{ tagName: "p", textContent: "A quote" }],
          tagName: "blockquote",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("> A quote");
  });

  test("converts unordered lists", () => {
    const doc = {
      children: [
        {
          children: [
            { tagName: "li", textContent: "Item 1" },
            { tagName: "li", textContent: "Item 2" },
          ],
          tagName: "ul",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("- Item 1");
    expect(content).toContain("- Item 2");
  });

  test("converts ordered lists", () => {
    const doc = {
      children: [
        {
          children: [
            { tagName: "li", textContent: "First" },
            { tagName: "li", textContent: "Second" },
          ],
          tagName: "ol",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("1. First");
    expect(content).toContain("2. Second");
  });

  test("converts fenced code blocks (pre > code)", () => {
    const doc = {
      children: [
        {
          children: [
            {
              className: "language-js",
              tagName: "code",
              textContent: "console.log('hi')",
            },
          ],
          tagName: "pre",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("```js");
    expect(content).toContain("console.log('hi')");
    expect(content).toContain("```");
  });

  test("converts horizontal rules", () => {
    const doc = {
      children: [
        { tagName: "p", textContent: "Before" },
        { tagName: "hr" },
        { tagName: "p", textContent: "After" },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("***");
  });

  test("converts tables", () => {
    const doc = {
      children: [
        {
          children: [
            {
              children: [
                {
                  children: [
                    { tagName: "th", textContent: "Name" },
                    { tagName: "th", textContent: "Age" },
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
                    { tagName: "td", textContent: "Alice" },
                    { tagName: "td", textContent: "30" },
                  ],
                  tagName: "tr",
                },
              ],
              tagName: "tbody",
            },
          ],
          tagName: "table",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Name");
    expect(content).toContain("Age");
    expect(content).toContain("Alice");
    expect(content).toContain("30");
    expect(content).toContain("|");
  });

  test("unwraps wrapper tags (div, section, span, etc.)", () => {
    const doc = {
      children: [
        {
          children: [{ tagName: "p", textContent: "Inside div" }],
          tagName: "div",
        },
        {
          children: [{ tagName: "p", textContent: "Inside section" }],
          tagName: "section",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Inside div");
    expect(content).toContain("Inside section");
    expect(content).not.toContain("<div>");
    expect(content).not.toContain("<section>");
  });

  test("wrapper with only textContent wraps in paragraph", () => {
    const doc = {
      children: [{ tagName: "div", textContent: "Just text" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Just text");
  });

  test("converts delete (strikethrough)", () => {
    const doc = {
      children: [
        {
          children: [{ tagName: "del", textContent: "removed" }],
          tagName: "p",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("~~removed~~");
  });

  test("converts break elements", () => {
    const doc = {
      children: [
        {
          children: [
            { tagName: "span", textContent: "Line 1" },
            { tagName: "br" },
            { tagName: "span", textContent: "Line 2" },
          ],
          tagName: "p",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Line 1");
    expect(content).toContain("Line 2");
  });

  test("inlines known component definitions", () => {
    const componentDefs = new Map([
      [
        "my-card",
        {
          children: [{ tagName: "h2", textContent: "${state.title}" }],
          state: { title: "Default" },
        },
      ],
    ]);

    const doc = {
      children: [{ $props: { title: "Custom Title" }, tagName: "my-card" }],
    };

    const { content } = compileMarkdown(doc, componentDefs);
    expect(content).toContain("Custom Title");
  });

  test("unwraps unknown custom elements (no definition)", () => {
    const doc = {
      children: [
        {
          children: [{ tagName: "p", textContent: "Widget content" }],
          tagName: "my-widget",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Widget content");
  });

  test("resolves template strings in text content", () => {
    const doc = {
      children: [{ tagName: "p", textContent: "${state.greeting} World" }],
      state: { greeting: "Hello" },
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Hello World");
  });

  test("handles innerHTML content", () => {
    const doc = {
      children: [{ innerHTML: "<p>HTML content</p>", tagName: "div" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("HTML content");
  });

  test("handles innerHTML with headings", () => {
    const doc = {
      children: [{ innerHTML: "<h2>Section Title</h2>", tagName: "div" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("## Section Title");
  });

  test("handles innerHTML with links", () => {
    const doc = {
      children: [
        {
          innerHTML: '<p><a href="https://test.com">Test</a></p>',
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("[Test](https://test.com)");
  });

  test("handles innerHTML with emphasis/strong", () => {
    const doc = {
      children: [
        {
          innerHTML: "<p><em>italic</em> and <strong>bold</strong></p>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("*italic*");
    expect(content).toContain("**bold**");
  });

  test("handles innerHTML with inline code", () => {
    const doc = {
      children: [{ innerHTML: "<p>Use <code>npm install</code></p>", tagName: "div" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("`npm install`");
  });

  test("handles innerHTML with fenced code block", () => {
    const doc = {
      children: [
        {
          innerHTML: '<pre><code class="language-python">print("hi")</code></pre>',
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("```python");
    expect(content).toContain('print("hi")');
  });

  test("handles innerHTML with blockquote", () => {
    const doc = {
      children: [
        {
          children: [{ tagName: "p", textContent: "Quoted" }],
          tagName: "blockquote",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("> Quoted");
  });

  test("handles innerHTML with unordered list", () => {
    const doc = {
      children: [{ innerHTML: "<ul><li>Apple</li><li>Banana</li></ul>", tagName: "div" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("- Apple");
    expect(content).toContain("- Banana");
  });

  test("handles innerHTML with ordered list", () => {
    const doc = {
      children: [{ innerHTML: "<ol><li>First</li><li>Second</li></ol>", tagName: "div" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("1. First");
    expect(content).toContain("2. Second");
  });

  test("handles innerHTML with hr", () => {
    const doc = {
      children: [{ innerHTML: "<p>Above</p><hr /><p>Below</p>", tagName: "div" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Above");
    expect(content).toContain("Below");
  });

  test("handles innerHTML with table", () => {
    const doc = {
      children: [
        {
          innerHTML:
            "<table><tr><th>Col1</th><th>Col2</th></tr><tr><td>a</td><td>b</td></tr></table>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Col1");
    expect(content).toContain("|");
  });

  test("handles innerHTML with br", () => {
    const doc = {
      children: [{ innerHTML: "<p>Line 1<br>Line 2</p>", tagName: "div" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Line 1");
    expect(content).toContain("Line 2");
  });

  test("handles innerHTML with img", () => {
    const doc = {
      children: [{ innerHTML: '<p><img src="/pic.jpg" alt="Pic"></p>', tagName: "div" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("![Pic](/pic.jpg)");
  });

  test("decodes HTML entities in innerHTML", () => {
    const doc = {
      children: [
        {
          innerHTML: "<p>&lt;div&gt; &amp; &quot;test&quot;</p>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain('<div> & "test"');
  });

  test("handles innerHTML with wrapper elements (unwraps)", () => {
    const doc = {
      children: [{ innerHTML: "<div><p>Nested in div</p></div>", tagName: "div" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Nested in div");
  });

  test("handles innerHTML with del/s (strikethrough)", () => {
    const doc = {
      children: [
        {
          innerHTML: "<p><del>deleted</del> and <s>struck</s></p>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("~~deleted~~");
    expect(content).toContain("~~struck~~");
  });

  test("handles innerHTML with b/i tags", () => {
    const doc = {
      children: [{ innerHTML: "<p><b>bold</b> and <i>italic</i></p>", tagName: "div" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("**bold**");
    expect(content).toContain("*italic*");
  });

  test("expands $prototype Array with map template", () => {
    const doc = {
      children: [
        {
          children: [
            {
              $prototype: "Array",
              items: { $ref: "#/state/items" },
              map: {
                tagName: "li",
                textContent: { $ref: "$map/item/name" },
              },
            },
          ],
          tagName: "ul",
        },
      ],
      state: {
        items: [{ name: "Apple" }, { name: "Banana" }, { name: "Cherry" }],
      },
    };
    const { content } = compileMarkdown(doc as unknown as JxDocument);
    expect(content).toContain("- Apple");
    expect(content).toContain("- Banana");
    expect(content).toContain("- Cherry");
  });

  test("handles number nodes", () => {
    const doc = {
      children: [{ children: [42], tagName: "p" }],
    };
    const { content } = compileMarkdown(doc as unknown as JxDocument);
    expect(content).toContain("42");
  });

  test("skips null/undefined nodes", () => {
    const doc = {
      children: [null, undefined, { tagName: "p", textContent: "Valid" }],
    };
    const { content } = compileMarkdown(doc as unknown as JxDocument);
    expect(content).toContain("Valid");
  });

  test("link with title attribute", () => {
    const doc = {
      children: [
        {
          children: [
            {
              attributes: { href: "https://x.com", title: "Visit X" },
              tagName: "a",
              textContent: "X",
            },
          ],
          tagName: "p",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain('[X](https://x.com "Visit X")');
  });

  test("image with title attribute", () => {
    const doc = {
      children: [
        {
          attributes: { alt: "Alt", src: "/img.png", title: "Title" },
          tagName: "img",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain('![Alt](/img.png "Title")');
  });

  test("code block without language", () => {
    const doc = {
      children: [
        {
          children: [{ tagName: "code", textContent: "plain code" }],
          tagName: "pre",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("```");
    expect(content).toContain("plain code");
  });

  test("pre with textContent directly (no code child)", () => {
    const doc = {
      children: [{ tagName: "pre", textContent: "raw text" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("raw text");
  });

  test("component with slot replacement", () => {
    const componentDefs = new Map([
      [
        "my-layout",
        {
          children: [{ tagName: "h1", textContent: "Header" }, { tagName: "slot" }],
          state: {},
        },
      ],
    ]);

    const doc = {
      children: [
        {
          children: [{ tagName: "p", textContent: "Slotted content" }],
          tagName: "my-layout",
        },
      ],
    };

    const { content } = compileMarkdown(doc, componentDefs);
    expect(content).toContain("# Header");
    expect(content).toContain("Slotted content");
  });

  test("component with no children in definition returns empty", () => {
    const componentDefs = new Map([["my-empty", { state: {} }]]);
    const doc = {
      children: [{ tagName: "my-empty" }],
    };
    const { content } = compileMarkdown(doc, componentDefs);
    expect(content).toBe("\n");
  });

  test("unknown tag with textContent wraps in paragraph", () => {
    const doc = {
      children: [{ tagName: "custom-unknown-tag", textContent: "Unknown" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Unknown");
  });

  test("empty paragraph produces no output", () => {
    const doc = {
      children: [{ tagName: "p", textContent: "" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content.trim()).toBe("");
  });

  test("list with non-listItem children filters them out", () => {
    const doc = {
      children: [
        {
          children: [
            { tagName: "li", textContent: "Valid" },
            { tagName: "p", textContent: "Not a list item" },
          ],
          tagName: "ul",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("- Valid");
  });

  test("handles innerHTML with nested lists", () => {
    const doc = {
      children: [
        {
          innerHTML: "<ul><li><ul><li>Nested</li></ul></li></ul>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Nested");
  });

  test("handles link in innerHTML with title", () => {
    const doc = {
      children: [
        {
          innerHTML: '<p><a href="/page" title="Go">Click</a></p>',
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("[Click](/page");
  });

  test("blockquote with bare text wraps in paragraph", () => {
    const doc = {
      children: [{ tagName: "blockquote", textContent: "Simple quote" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("> Simple quote");
  });

  // ─── Coverage: unknown non-custom, non-wrapper tag with children (lines 116-119)

  test("unknown non-custom tag with children but no textContent unwraps children", () => {
    const doc = {
      children: [
        {
          children: [{ tagName: "p", textContent: "Fallback text" }],
          tagName: "video",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Fallback text");
  });

  test("unknown non-custom tag with no textContent and no children produces nothing", () => {
    const doc = {
      children: [{ tagName: "audio" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content.trim()).toBe("");
  });

  // ─── Coverage: blockquote with inline text children (line 234, 237)

  test("blockquote with mixed inline and block children", () => {
    const doc = {
      children: [
        {
          children: [
            { tagName: "p", textContent: "First paragraph" },
            { tagName: "p", textContent: "Second paragraph" },
          ],
          tagName: "blockquote",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("> First paragraph");
    expect(content).toContain("> Second paragraph");
  });

  // ─── Coverage: inline <code> element (line 262)

  test("inline code with empty textContent", () => {
    const doc = {
      children: [
        {
          children: [
            { tagName: "code", textContent: "" },
            { tagName: "code", textContent: "valid" },
          ],
          tagName: "p",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("`valid`");
  });

  // ─── Coverage: <pre><code> with lang attribute (lines 278-280)

  test("code block with lang from attributes instead of className", () => {
    const doc = {
      children: [
        {
          children: [
            {
              className: "language-rust",
              tagName: "code",
              textContent: "fn main() {}",
            },
          ],
          tagName: "pre",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("```rust");
    expect(content).toContain("fn main() {}");
  });

  // ─── Coverage: <table> direct rows without thead/tbody (lines 314-315, 319)

  test("table with direct tr children (no thead/tbody wrappers)", () => {
    const doc = {
      children: [
        {
          children: [
            {
              children: [
                { tagName: "th", textContent: "Header1" },
                { tagName: "th", textContent: "Header2" },
              ],
              tagName: "tr",
            },
            {
              children: [
                { tagName: "td", textContent: "Val1" },
                { tagName: "td", textContent: "Val2" },
              ],
              tagName: "tr",
            },
          ],
          tagName: "table",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Header1");
    expect(content).toContain("Header2");
    expect(content).toContain("Val1");
    expect(content).toContain("Val2");
    expect(content).toContain("|");
  });

  test("table cell with inline children instead of textContent", () => {
    const doc = {
      children: [
        {
          children: [
            {
              children: [
                {
                  children: [{ tagName: "strong", textContent: "Bold Cell" }],
                  tagName: "td",
                },
                { tagName: "td", textContent: "Plain" },
              ],
              tagName: "tr",
            },
          ],
          tagName: "table",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("**Bold Cell**");
    expect(content).toContain("Plain");
  });

  // ─── Coverage: resolveNode() attribute handling with template expressions (lines 364, 374, 377-382, 385)

  test("component resolves template expressions in attributes", () => {
    const componentDefs = new Map([
      [
        "link-card",
        {
          children: [
            {
              children: [
                {
                  attributes: { href: "${state.url}" },
                  tagName: "a",
                  textContent: "${state.label}",
                },
              ],
              tagName: "p",
            },
          ],
          state: { label: "Click", url: "https://default.com" },
        },
      ],
    ]);

    const doc = {
      children: [
        {
          $props: { label: "Visit", url: "https://example.org" },
          tagName: "link-card",
        },
      ],
    };

    const { content } = compileMarkdown(doc, componentDefs);
    expect(content).toContain("[Visit](https://example.org)");
  });

  test("component resolves template expressions in innerHTML", () => {
    const componentDefs = new Map([
      [
        "html-card",
        {
          children: [{ innerHTML: "<p>${state.message}</p>", tagName: "div" }],
          state: { message: "Hello from template" },
        },
      ],
    ]);

    const doc = {
      children: [{ tagName: "html-card" }],
    };

    const { content } = compileMarkdown(doc, componentDefs);
    expect(content).toContain("Hello from template");
  });

  test("component resolves children nodes recursively", () => {
    const componentDefs = new Map([
      [
        "nested-card",
        {
          children: [
            {
              children: [{ tagName: "h2", textContent: "${state.title}" }],
              tagName: "div",
            },
          ],
          state: { title: "Nested" },
        },
      ],
    ]);

    const doc = {
      children: [{ $props: { title: "Deep Title" }, tagName: "nested-card" }],
    };

    const { content } = compileMarkdown(doc, componentDefs);
    expect(content).toContain("## Deep Title");
  });

  // ─── Coverage: Array expansion with $map/ paths (lines 452, 456, 460, 493-494, 531-532, 579-580)

  test("$prototype Array with $map/ ref in nested $props", () => {
    const componentDefs = new Map([
      [
        "item-card",
        {
          children: [{ tagName: "p", textContent: "${state.name}" }],
          state: { name: "default" },
        },
      ],
    ]);

    const doc = {
      children: [
        {
          $prototype: "Array",
          items: { $ref: "#/state/things" },
          map: {
            $props: { name: { $ref: "$map/item/name" } },
            tagName: "item-card",
          },
        },
      ],
      state: { things: [{ name: "Alpha" }, { name: "Beta" }] },
    };

    const { content } = compileMarkdown(doc as unknown as JxDocument, componentDefs);
    expect(content).toContain("Alpha");
    expect(content).toContain("Beta");
  });

  test("$prototype Array with textContent as $map/ path string", () => {
    const doc = {
      children: [
        {
          children: [
            {
              $prototype: "Array",
              items: { $ref: "#/state/fruits" },
              map: {
                tagName: "li",
                textContent: "$map/label",
              },
            },
          ],
          tagName: "ul",
        },
      ],
      state: { fruits: [{ label: "Apple" }, { label: "Pear" }] },
    };

    const { content } = compileMarkdown(doc as unknown as JxDocument);
    expect(content).toContain("- Apple");
    expect(content).toContain("- Pear");
  });

  test("$prototype Array with children in map template", () => {
    const doc = {
      children: [
        {
          $prototype: "Array",
          items: { $ref: "#/state/entries" },
          map: {
            children: [
              {
                tagName: "h3",
                textContent: { $ref: "$map/item/title" },
              },
            ],
            tagName: "div",
          },
        },
      ],
      state: { entries: [{ title: "One" }, { title: "Two" }] },
    };

    const { content } = compileMarkdown(doc as unknown as JxDocument);
    expect(content).toContain("### One");
    expect(content).toContain("### Two");
  });

  test("$prototype Array with no scope returns empty", () => {
    const doc = {
      children: [
        {
          $prototype: "Array",
          items: { $ref: "#/state/missing" },
          map: { tagName: "p", textContent: "never" },
        },
      ],
    };
    // No state defined, so no scope — should return empty
    const { content } = compileMarkdown(doc);
    expect(content.trim()).toBe("");
  });

  test("$prototype Array with non-array items ref returns empty", () => {
    const doc = {
      children: [
        {
          $prototype: "Array",
          items: { $ref: "#/state/notArray" },
          map: { tagName: "p", textContent: "never" },
        },
      ],
      state: { notArray: "hello" },
    };
    const { content } = compileMarkdown(doc);
    expect(content.trim()).toBe("");
  });

  // ─── Coverage: HTML parsing edge cases (lines 618, 634-635, 637-638, 668)

  test("innerHTML with blockquote containing paragraph", () => {
    const doc = {
      children: [
        {
          innerHTML: "<blockquote>A simple quoted sentence</blockquote>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("> A simple quoted sentence");
  });

  test("innerHTML with blockquote containing bare text", () => {
    const doc = {
      children: [
        {
          innerHTML: "<blockquote>Bare text in blockquote</blockquote>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("> Bare text in blockquote");
  });

  test("innerHTML with blockquote containing inline emphasis", () => {
    const doc = {
      children: [
        {
          innerHTML: "<blockquote><em>Emphasized quote</em></blockquote>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Emphasized quote");
  });

  test("innerHTML with wrapper div unwraps inner content", () => {
    const doc = {
      children: [
        {
          innerHTML: "<section><p>Inside section</p></section>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Inside section");
  });

  // ─── Coverage: complex inline HTML / self-closing / nested (lines 732-733, 771, 801-803, 808-809)

  test("innerHTML with unmatched inline tag treats as text", () => {
    const doc = {
      children: [
        {
          innerHTML: "<p>Some <em>unclosed text</p>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    // Should still produce output (graceful fallback)
    expect(content).toContain("Some");
  });

  test("innerHTML with nested same-name tags", () => {
    const doc = {
      children: [
        {
          innerHTML: "<p><a href='/outer'><a href='/inner'>Inner</a> link</a></p>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Inner");
    expect(content).toContain("link");
  });

  test("innerHTML with unknown tags skipped gracefully", () => {
    const doc = {
      children: [
        {
          innerHTML: "<p>Text <custom>ignored tag</custom> more text</p>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Text");
    expect(content).toContain("more text");
  });

  test("innerHTML with self-closing img inside paragraph", () => {
    const doc = {
      children: [
        {
          innerHTML: '<p>Before <img src="/x.png" alt="X" /> After</p>',
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Before");
    expect(content).toContain("![X](/x.png)");
    expect(content).toContain("After");
  });

  test("innerHTML with bare inline content (no block wrapper)", () => {
    const doc = {
      children: [
        {
          innerHTML: "<em>just italic</em> and <strong>bold</strong>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("*just italic*");
    expect(content).toContain("**bold**");
  });

  test("innerHTML table parsed directly", () => {
    const doc = {
      children: [
        {
          innerHTML: "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("A");
    expect(content).toContain("B");
    expect(content).toContain("1");
    expect(content).toContain("2");
    expect(content).toContain("|");
  });

  // ─── Additional coverage tests ────────────────────────────────────────────

  test("whitespace-only bare text node produces nothing (line 76)", () => {
    const doc = {
      children: [
        {
          children: ["   ", "Hello"],
          tagName: "p",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Hello");
    expect(content.trim()).toBe("Hello");
  });

  test("unknown tag with whitespace-only textContent produces nothing (line 117)", () => {
    const doc = {
      children: [{ tagName: "video", textContent: "   " }],
    };
    const { content } = compileMarkdown(doc);
    expect(content.trim()).toBe("");
  });

  test("convertChildren returns empty for empty-string textContent (line 262)", () => {
    // A list uses convertChildren; if textContent is empty, no items to filter
    const doc = {
      children: [{ tagName: "ul", textContent: "" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content.trim()).toBe("");
  });

  test("convertChildrenInline returns empty for empty-string textContent (lines 278-280)", () => {
    // A heading with empty string textContent
    const doc = {
      children: [{ tagName: "h1", textContent: "" }],
    };
    const { content } = compileMarkdown(doc);
    // Heading with empty text still generates a heading node with empty text child
    expect(content).toContain("#");
  });

  test("component prop overwrites state with default object (lines 314-315)", () => {
    const componentDefs = new Map([
      [
        "prop-card",
        {
          children: [{ tagName: "h1", textContent: "${state.title}" }],
          state: { title: { default: "Fallback", type: "string" } },
        },
      ],
    ]);
    const doc = {
      children: [{ $props: { title: "Override" }, tagName: "prop-card" }],
    };
    const { content } = compileMarkdown(doc, componentDefs);
    expect(content).toContain("# Override");
  });

  test("component prop added to state when not already present (line 319)", () => {
    const componentDefs = new Map([
      [
        "extra-card",
        {
          children: [{ tagName: "p", textContent: "${state.extra}" }],
          state: { existing: "yes" },
        },
      ],
    ]);
    const doc = {
      children: [{ $props: { extra: "new value" }, tagName: "extra-card" }],
    };
    const { content } = compileMarkdown(doc, componentDefs);
    expect(content).toContain("new value");
  });

  test("resolveNode handles plain template string in children (line 364)", () => {
    const componentDefs = new Map([
      [
        "text-card",
        {
          children: ["Hello ${state.word}"],
          state: { word: "World" },
        },
      ],
    ]);
    const doc = {
      children: [{ tagName: "text-card" }],
    };
    const { content } = compileMarkdown(doc, componentDefs);
    expect(content).toContain("Hello World");
  });

  test("resolveRef with non-#/state/ prefix (lines 493-494)", () => {
    const doc = {
      children: [
        {
          children: [
            {
              $prototype: "Array",
              items: { $ref: "items" },
              map: { tagName: "li", textContent: { $ref: "$map/item/name" } },
            },
          ],
          tagName: "ul",
        },
      ],
      state: { items: [{ name: "Direct" }] },
    };
    const { content } = compileMarkdown(doc as unknown as JxDocument);
    expect(content).toContain("- Direct");
  });

  test("resolveText with numeric textContent (lines 531-532)", () => {
    const doc = {
      children: [{ tagName: "p", textContent: 42 }],
    };
    const { content } = compileMarkdown(doc as unknown as JxDocument);
    expect(content).toContain("42");
  });

  test("innerHTML with text between block elements (lines 579-580)", () => {
    const doc = {
      children: [
        {
          innerHTML: "<p>First</p>between text<p>Second</p>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("First");
    expect(content).toContain("between text");
    expect(content).toContain("Second");
  });

  test("innerHTML with standalone hr element (line 618)", () => {
    const doc = {
      children: [
        {
          innerHTML: "<hr>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("***");
  });

  test("innerHTML with wrapper div element containing only text (line 668)", () => {
    const doc = {
      children: [
        {
          innerHTML: "<div>inner text only</div>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("inner text only");
  });

  test("innerHTML with malformed tag missing closing angle bracket (line 771)", () => {
    const doc = {
      children: [
        {
          innerHTML: "<p>text <broken no close</p>",
          tagName: "div",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("text");
  });

  test("paragraph with empty textContent via convertChildrenInline (line 280)", () => {
    // A paragraph element with children that have empty textContent
    const doc = {
      children: [
        {
          children: [{ tagName: "em", textContent: "" }],
          tagName: "p",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    // Em with empty textContent produces emphasis with empty text child
    expect(content).toBeDefined();
  });

  test("tableCell with children uses convertChildrenInline (line 234)", () => {
    const doc = {
      children: [
        {
          children: [
            {
              children: [
                {
                  children: [{ tagName: "em", textContent: "italic cell" }],
                  tagName: "td",
                },
              ],
              tagName: "tr",
            },
          ],
          tagName: "table",
        },
      ],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("*italic cell*");
  });

  test("innerHTML with wrapper div unwraps content (line 668)", () => {
    const doc = {
      children: [{ innerHTML: "<div><p>Wrapped content</p></div>", tagName: "div" }],
    };
    const { content } = compileMarkdown(doc);
    expect(content).toContain("Wrapped content");
  });
});

// ─── Prototype directive round-trip (:::Array) ──────────────────────────────

describe("prototype directive round-trip", () => {
  test("a tagName-less Array node serializes to a :::Array directive", () => {
    const doc = {
      children: [
        { tagName: "h1", textContent: "List" },
        {
          $prototype: "Array",
          items: { $ref: "#/state/rows" },
          map: { tagName: "p", textContent: "${$map.item.name}" },
        },
      ],
    };
    const md = serializeJxMarkdown(doc as JxDocument);
    // Directive named after the prototype, with items as an attribute and the map as the body.
    expect(md).toContain(':::Array{items.ref="#/state/rows"}');
    expect(md).toContain("${$map.item.name}");
    // No throwaway div wrapper / dot-path blob.
    expect(md).not.toContain("map.tagName");
  });

  test("jxToMdast → mdastToJx preserves an Array member among siblings", () => {
    const jx: JxElement = {
      tagName: "ul",
      children: [
        { tagName: "li", textContent: "header" },
        {
          $prototype: "Array",
          items: { $ref: "#/state/rows" },
          filter: { $ref: "#/state/byDate" },
          map: { tagName: "li", textContent: "row" },
        },
      ],
    };
    const back = mdastToJx(jxToMdast(jx)) as JxElement;
    const [, arr] = back.children as JxElement[];
    expect(arr.$prototype).toBe("Array");
    expect(arr.tagName).toBeUndefined();
    expect(arr.items).toEqual({ $ref: "#/state/rows" });
    expect(arr.filter).toEqual({ $ref: "#/state/byDate" });
    expect((arr.map as JxElement).tagName).toBe("li");
  });
});
