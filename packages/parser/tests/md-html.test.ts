import { describe, expect, test } from "bun:test";
import { markdownToHtml } from "../src/md-html";

describe("markdownToHtml", () => {
  test("renders basic markdown", () => {
    const html = markdownToHtml("# Title\n\nSome **bold** and *italic* text.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  test("renders lists", () => {
    const html = markdownToHtml("- one\n- two\n\n1. first\n2. second");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
  });

  test("renders fenced code blocks and inline code", () => {
    const html = markdownToHtml("Use `foo()` like:\n\n```js\nconst x = 1;\n```");
    expect(html).toContain("<code>foo()</code>");
    expect(html).toContain("<pre>");
    expect(html).toContain("const x = 1;");
  });

  test("renders GFM tables", () => {
    const html = markdownToHtml("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  test("renders GFM strikethrough and links", () => {
    const html = markdownToHtml("~~gone~~ and [site](https://example.com)");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain('<a href="https://example.com">site</a>');
  });

  test("drops raw HTML (script injection)", () => {
    const html = markdownToHtml('hello <script>alert("x")</script> world');
    expect(html).not.toContain("<script");
    expect(html).toContain("hello");
    expect(html).toContain("world");
  });

  test("drops event-handler attributes in raw HTML", () => {
    const html = markdownToHtml('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });

  test("strips javascript: URLs from links", () => {
    // Assembled to satisfy no-script-url — the payload is the point of the test.
    const jsUrl = ["javascript", "alert(1)"].join(":");
    const html = markdownToHtml(`[click](${jsUrl})`);
    expect(html).not.toContain(jsUrl);
    expect(html).toContain("click");
  });

  test("handles empty input", () => {
    expect(markdownToHtml("")).toBe("");
  });
});
