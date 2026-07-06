import { describe, test, expect } from "bun:test";
import { convertToJx } from "../src/to-jx.ts";
import type { JxElement } from "@jxsuite/schema/types";

describe("convertToJx", () => {
  test("converts basic HTML to a valid Jx document", () => {
    const html = `
      <div class="container">
        <h1>Hello World</h1>
        <p>Some text</p>
      </div>
    `;
    const result = convertToJx(html);

    expect(result.document.tagName).toBe("div");
    expect(result.nodeCount).toBeGreaterThan(0);
    expect(result.collectedStyles).toEqual([]);

    // The wrapper div should contain the converted tree
    const children = result.document.children as JxElement[];
    expect(children.length).toBeGreaterThan(0);
  });

  test("strips script and noscript tags", () => {
    const html = `
      <div>
        <script>alert('xss')</script>
        <noscript>Enable JS</noscript>
        <p>Keep me</p>
      </div>
    `;
    const result = convertToJx(html);
    const json = JSON.stringify(result.document);
    expect(json).not.toContain("script");
    expect(json).not.toContain("alert");
    expect(json).toContain("Keep me");
  });

  test("strips iframe, object, embed tags", () => {
    const html = `
      <div>
        <iframe src="https://evil.com"></iframe>
        <object data="flash.swf"></object>
        <embed src="plugin.swf">
        <p>Safe content</p>
      </div>
    `;
    const result = convertToJx(html);
    const json = JSON.stringify(result.document);
    expect(json).not.toContain("iframe");
    expect(json).not.toContain("object");
    expect(json).not.toContain("embed");
    expect(json).toContain("Safe content");
  });

  test("collects inline style content", () => {
    const html = `
      <style>.foo { color: red; }</style>
      <div><p>Hello</p></div>
    `;
    const result = convertToJx(html);
    expect(result.collectedStyles.length).toBe(1);
    expect(result.collectedStyles[0]).toContain(".foo");
    // Style element itself should be stripped from the tree
    const json = JSON.stringify(result.document);
    expect(json).not.toContain('"style"');
  });

  test("strips link and meta tags", () => {
    const html = `
      <link rel="stylesheet" href="styles.css">
      <meta name="viewport" content="width=device-width">
      <div>Content</div>
    `;
    const result = convertToJx(html);
    const json = JSON.stringify(result.document);
    expect(json).not.toContain("stylesheet");
    expect(json).not.toContain("viewport");
    expect(json).toContain("Content");
  });

  test("handles inline styles on elements", () => {
    const html = `<div style="color: red; font-size: 16px"><p>Styled</p></div>`;
    const result = convertToJx(html);
    const [outerDiv] = result.document.children as any[];
    expect(outerDiv.style).toBeDefined();
    expect(outerDiv.style.color).toBe("red");
    expect(outerDiv.style["font-size"]).toBe("16px");
  });

  test("reports node count accurately", () => {
    const html = `
      <header>
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
      </header>
      <main><p>Body</p></main>
      <footer><p>Footer</p></footer>
    `;
    const result = convertToJx(html);
    // Wrapper(1) + header(1) + nav(1) + a(2) + main(1) + p(1) + footer(1) + p(1) = 9
    expect(result.nodeCount).toBe(9);
  });

  test("warns-worthy large page produces valid output", () => {
    // Generate a page with many nodes
    const items = Array.from({ length: 200 }, (_, i) => `<li>Item ${i}</li>`).join("");
    const html = `<ul>${items}</ul>`;
    const result = convertToJx(html);
    expect(result.nodeCount).toBe(202); // Wrapper + ul + 200 li
    expect(result.document.tagName).toBe("div");
  });

  test("empty body produces minimal valid document", () => {
    const result = convertToJx("");
    expect(result.document.tagName).toBe("div");
    expect(result.nodeCount).toBe(1);
    expect(result.collectedStyles).toEqual([]);
  });
});
