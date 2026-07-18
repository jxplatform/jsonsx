import { describe, expect, test } from "bun:test";

import { highlightCodeBlocks, highlightFence } from "../src/highlight";
import { processMarkdown } from "../src/md";
import type { JxElement } from "@jxsuite/schema/types";

// ─── highlightFence ───────────────────────────────────────────────────────────

describe("highlightFence", () => {
  test("tokenizes a known language into spans with dual-theme variables", () => {
    const spans = highlightFence('{ "a": 1 }', "json")!;
    expect(spans.length).toBeGreaterThan(1);
    const first = spans[0] as JxElement;
    expect(first.tagName).toBe("span");
    expect(typeof first.textContent).toBe("string");
    expect(first.style).toHaveProperty("--shiki-light");
    expect(first.style).toHaveProperty("--shiki-dark");
    const joined = spans
      .map((s) => (typeof s === "string" ? s : ((s as JxElement).textContent ?? "")))
      .join("");
    expect(joined).toBe('{ "a": 1 }');
  });

  test("joins lines with newline strings, preserving the source text", () => {
    const code = '{\n  "a": 1\n}';
    const spans = highlightFence(code, "json")!;
    expect(spans.filter((s) => s === "\n")).toHaveLength(2);
    const joined = spans
      .map((s) => (typeof s === "string" ? s : ((s as JxElement).textContent ?? "")))
      .join("");
    expect(joined).toBe(code);
  });

  test("resolves registered grammar aliases (bash → shellscript, ts → typescript)", () => {
    expect(highlightFence("echo hi", "bash")).not.toBeNull();
    expect(highlightFence("const x: number = 1;", "ts")).not.toBeNull();
    expect(highlightFence("# Title", "md")).not.toBeNull();
  });

  test("returns null for unknown languages", () => {
    expect(highlightFence("PRINT 1", "cobol")).toBeNull();
    expect(highlightFence("x", "not-a-language")).toBeNull();
  });
});

// ─── highlightCodeBlocks ──────────────────────────────────────────────────────

describe("highlightCodeBlocks", () => {
  const fence = (lang: string | null, text: string): JxElement => ({
    children: [
      {
        tagName: "code",
        textContent: text,
        ...(lang ? { className: `language-${lang}` } : {}),
      },
    ],
    tagName: "pre",
  });

  test("replaces fence text with token spans and marks the code element", () => {
    const tree: (JxElement | string)[] = [fence("json", '{ "a": 1 }')];
    highlightCodeBlocks(tree);
    const code = (tree[0] as JxElement).children![0] as JxElement;
    expect(code.className).toBe("language-json shiki");
    expect(code.textContent).toBeUndefined();
    expect(Array.isArray(code.children)).toBe(true);
    expect((code.children![0] as JxElement).tagName).toBe("span");
  });

  test("leaves unknown languages and bare fences untouched", () => {
    const unknown = fence("cobol", "PRINT 1");
    const bare = fence(null, "plain text");
    highlightCodeBlocks([unknown, bare]);
    expect((unknown.children![0] as JxElement).textContent).toBe("PRINT 1");
    expect((bare.children![0] as JxElement).textContent).toBe("plain text");
  });

  test("recurses into nested containers", () => {
    const tree: (JxElement | string)[] = [
      { children: ["intro", fence("json", "{}")], tagName: "div" },
    ];
    highlightCodeBlocks(tree);
    const pre = (tree[0] as JxElement).children![1] as JxElement;
    const code = pre.children![0] as JxElement;
    expect(code.className).toContain("shiki");
  });

  test("ignores strings and empty code elements", () => {
    const empty = fence("json", "");
    highlightCodeBlocks(["hello", empty]);
    expect((empty.children![0] as JxElement).textContent).toBe("");
  });
});

// ─── processMarkdown integration ──────────────────────────────────────────────

describe("processMarkdown highlighting", () => {
  test("fenced blocks come out highlighted, prose untouched", () => {
    const source = ["Some prose.", "", "```json", '{ "a": 1 }', "```", ""].join("\n");
    const result = processMarkdown(source, "/x.md");
    expect(result.$children[0]).toEqual({ tagName: "p", textContent: "Some prose." });
    const pre = result.$children[1] as JxElement;
    expect(pre.tagName).toBe("pre");
    const code = pre.children![0] as JxElement;
    expect(code.className).toBe("language-json shiki");
    expect((code.children![0] as JxElement).style).toHaveProperty("--shiki-light");
  });

  test("unknown fence languages keep plain text output", () => {
    const source = ["```cobol", "PRINT 1", "```", ""].join("\n");
    const result = processMarkdown(source, "/x.md");
    const code = (result.$children[0] as JxElement).children![0] as JxElement;
    expect(code.className).toBe("language-cobol");
    expect(code.textContent).toBe("PRINT 1");
  });
});
