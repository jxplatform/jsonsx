import { describe, expect, test } from "bun:test";
import { htmlToJx, markdownToHtml } from "../src/index";

describe("package root re-exports", () => {
  test("htmlToJx converts HTML to Jx nodes", () => {
    expect(htmlToJx("<p>hi</p>")).toEqual([{ tagName: "p", textContent: "hi" }]);
  });

  test("markdownToHtml renders sanitized HTML", () => {
    expect(markdownToHtml("**hi**")).toContain("<strong>hi</strong>");
  });
});
