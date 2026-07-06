/**
 * Tests for src/panels/ai-chat/chat-markdown.ts — memoized markdown rendering: parse-once per
 * message id, re-parse on content growth (streaming finalize), and cache clearing. Uses the parser
 * package's real md-html pipeline (browser-safe, no mocks needed).
 */
import { renderInto } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { clearMarkdownCache, renderMarkdown } from "../src/panels/ai-chat/chat-markdown";

beforeEach(() => {
  clearMarkdownCache();
});

describe("renderMarkdown", () => {
  test("renders markdown to sanitized HTML inside .ai-msg-md", async () => {
    const el = await renderInto(renderMarkdown("m1", "# Hi\n\n**bold** <script>x()</script>"));
    const md = el.querySelector(".ai-msg-md")!;
    expect(md.querySelector("h1")?.textContent).toBe("Hi");
    expect(md.querySelector("strong")?.textContent).toBe("bold");
    expect(md.querySelector("script")).toBeNull();
  });

  test("memoizes by message id and content length", async () => {
    const a = await renderInto(renderMarkdown("m1", "one **two**"));
    const first = a.querySelector(".ai-msg-md")!.innerHTML;
    // Same id + same length → cached (rendering again produces identical HTML).
    const b = await renderInto(renderMarkdown("m1", "one **two**"));
    expect(b.querySelector(".ai-msg-md")!.innerHTML).toBe(first);
    // Content growth (streaming finalize) re-parses.
    const c = await renderInto(renderMarkdown("m1", "one **two** three"));
    expect(c.querySelector(".ai-msg-md")!.textContent).toContain("three");
  });

  test("clearMarkdownCache drops cached entries", async () => {
    await renderInto(renderMarkdown("m1", "alpha"));
    clearMarkdownCache();
    const el = await renderInto(renderMarkdown("m1", "*beta*"));
    expect(el.querySelector("em")?.textContent).toBe("beta");
  });
});
