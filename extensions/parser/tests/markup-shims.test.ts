/**
 * The full pipelines are tested in packages/markup; these smoke tests pin the parser's historical
 * `./html-to-jx` and `./md-html` entrypoints to the @jxsuite/markup re-exports.
 */

import { describe, expect, test } from "bun:test";
import { htmlToJx } from "../src/html-to-jx";
import { markdownToHtml } from "../src/md-html";

describe("markup shims", () => {
  test("html-to-jx re-exports htmlToJx", () => {
    expect(htmlToJx("<p>hi</p>")).toEqual([{ tagName: "p", textContent: "hi" }]);
  });

  test("md-html re-exports markdownToHtml", () => {
    expect(markdownToHtml("**hi**")).toContain("<strong>hi</strong>");
  });
});
