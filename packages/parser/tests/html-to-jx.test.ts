import { describe, expect, test } from "bun:test";
import { htmlToJx } from "../src/html-to-jx";
import type { JxElement } from "@jxsuite/schema/types";

describe("htmlToJx", () => {
  test("simple element with attributes", () => {
    const result = htmlToJx('<div class="foo" id="bar">Hello</div>');
    expect(result).toEqual([
      {
        attributes: { class: "foo", id: "bar" },
        tagName: "div",
        textContent: "Hello",
      },
    ]);
  });

  test("void elements", () => {
    expect(htmlToJx("<br>")).toEqual([{ tagName: "br" }]);
    expect(htmlToJx('<img src="/photo.jpg" alt="Photo">')).toEqual([
      { attributes: { alt: "Photo", src: "/photo.jpg" }, tagName: "img" },
    ]);
    expect(htmlToJx('<input type="text" name="q">')).toEqual([
      { attributes: { name: "q", type: "text" }, tagName: "input" },
    ]);
  });

  test("nested elements", () => {
    const result = htmlToJx("<div><p>Text</p></div>");
    expect(result).toEqual([{ children: [{ tagName: "p", textContent: "Text" }], tagName: "div" }]);
  });

  test("script with src attribute", () => {
    const result = htmlToJx('<script src="https://example.com/embed.js"></script>');
    expect(result).toEqual([
      {
        attributes: { src: "https://example.com/embed.js" },
        tagName: "script",
      },
    ]);
  });

  test("script with inline content", () => {
    const result = htmlToJx("<script>console.log('hi');</script>");
    expect(result).toEqual([{ tagName: "script", textContent: "console.log('hi');" }]);
  });

  test("style with inline content", () => {
    const result = htmlToJx("<style>.foo { color: red; }</style>");
    expect(result).toEqual([{ tagName: "style", textContent: ".foo { color: red; }" }]);
  });

  test("multiple top-level elements", () => {
    const result = htmlToJx(
      '<iframe src="https://example.com/form" title="Form"></iframe>\n<script src="https://example.com/embed.js"></script>',
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      attributes: { src: "https://example.com/form", title: "Form" },
      tagName: "iframe",
    });
    expect(result[1]).toEqual({
      attributes: { src: "https://example.com/embed.js" },
      tagName: "script",
    });
  });

  test("mixed text and element children", () => {
    const result = htmlToJx("<p>Hello <strong>world</strong> foo</p>");
    expect(result).toEqual([
      {
        children: ["Hello ", { tagName: "strong", textContent: "world" }, " foo"],
        tagName: "p",
      },
    ]);
  });

  test("boolean attributes", () => {
    const result = htmlToJx("<input disabled>");
    expect(result).toEqual([{ attributes: { disabled: "" }, tagName: "input" }]);
  });

  test("className maps to class", () => {
    const result = htmlToJx('<div class="a b c"></div>');
    expect((result[0] as JxElement).attributes?.class).toBe("a b c");
  });

  test("skips whitespace-only text nodes", () => {
    const result = htmlToJx("<div>\n  <p>Text</p>\n</div>");
    expect(result).toEqual([{ children: [{ tagName: "p", textContent: "Text" }], tagName: "div" }]);
  });

  test("empty string returns empty array", () => {
    expect(htmlToJx("")).toEqual([]);
  });

  test("HTML comments are skipped", () => {
    const result = htmlToJx("<!-- comment --><div>Text</div>");
    expect(result).toEqual([{ tagName: "div", textContent: "Text" }]);
  });

  test("inline style converts to style object", () => {
    const result = htmlToJx(
      '<iframe src="https://example.com" style="width:100%;height:100%;border:none;border-radius:8px"></iframe>',
    );
    expect(result).toEqual([
      {
        attributes: { src: "https://example.com" },
        style: {
          border: "none",
          "border-radius": "8px",
          height: "100%",
          width: "100%",
        },
        tagName: "iframe",
      },
    ]);
  });

  test("style-only element has no attributes key", () => {
    const result = htmlToJx('<div style="color:red"></div>');
    expect((result[0] as JxElement).attributes).toBeUndefined();
    expect((result[0] as JxElement).style).toEqual({ color: "red" });
  });
});
