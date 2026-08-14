import { describe, expect, test } from "bun:test";
import { jxToMdast, serializeJxMarkdown } from "../src/serialize";
import type { JxDocument, JxElementTagName } from "@jxsuite/schema/types";

// A tag chosen when the element is created: `a` when the target is truthy, `div` otherwise.
const conditionalTag: JxElementTagName = {
  $expression: { initial: "div", operator: "?:", target: { $ref: "#/state/href" }, value: "a" },
};

// The multi-way form — one branch per case, plus the fallback.
const multiwayTag: JxElementTagName = {
  $expression: {
    cases: { "1": "h1", "2": "h2" },
    default: "p",
    operator: "switch",
    target: { $ref: "#/state/level" },
  },
};

/** The message thrown for a chosen tag, or "" when serialization succeeded. */
function throwsWith(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

// ═════════════════════════════════════════════════════════════════════════════
// Chosen tags — a directive is named by a literal, so serializableTag refuses
// ═════════════════════════════════════════════════════════════════════════════

describe("serializableTag — a tag chosen at creation has no markdown spelling", () => {
  test("roundtrip refuses a conditional tagName and names both candidates", () => {
    const doc: JxDocument = {
      children: [{ tagName: conditionalTag, textContent: "Read more" }],
    };
    // Picking a candidate would silently rewrite the document into one branch of itself, so the
    // Serializer refuses instead of guessing — and says which branches it saw.
    expect(throwsWith(() => serializeJxMarkdown(doc))).toBe(
      "Markdown cannot express a tag chosen at creation (candidates: a, div). " +
        "Keep this element in a JSON component.",
    );
  });

  test("roundtrip refuses a switch tagName, listing every case and the default", () => {
    const doc: JxDocument = {
      children: [{ tagName: multiwayTag, textContent: "Heading or paragraph" }],
    };
    expect(throwsWith(() => serializeJxMarkdown(doc))).toBe(
      "Markdown cannot express a tag chosen at creation (candidates: h1, h2, p). " +
        "Keep this element in a JSON component.",
    );
  });

  test("a chosen tag nested inside markdown-native content refuses too", () => {
    // The paragraph itself is expressible; the child is not, so the whole document is refused
    // Rather than emitting a paragraph with the chosen element quietly dropped.
    const mdast = () =>
      jxToMdast({
        children: [
          {
            children: [{ tagName: conditionalTag, textContent: "link or box" }],
            tagName: "p",
          },
        ],
      });
    expect(throwsWith(mdast)).toContain("(candidates: a, div)");
  });

  test("export mode refuses the same element", () => {
    // Export runs a different converter (nodeToMdast) over the same tree; both ask the one helper,
    // So neither can quietly pick a branch the other refuses.
    const doc: JxDocument = {
      children: [{ tagName: conditionalTag, textContent: "Read more" }],
    };
    expect(throwsWith(() => serializeJxMarkdown(doc, { mode: "export" }))).toBe(
      "Markdown cannot express a tag chosen at creation (candidates: a, div). " +
        "Keep this element in a JSON component.",
    );
  });

  test("a non-string, non-expression tagName is refused rather than coerced", () => {
    const doc = { children: [{ tagName: 42, textContent: "x" }] } as unknown as JxDocument;
    // No candidates to name, but a number is still not a tag — coercing it to "42" would emit a
    // Directive named after a value that was never a tag.
    expect(throwsWith(() => serializeJxMarkdown(doc))).toContain(
      "Markdown cannot express a tag chosen at creation",
    );
  });

  test("an absent tagName is not a chosen tag — it falls back to div", () => {
    // The refusal is narrow: only a declared-but-non-literal tag is refused. Elements that never
    // Declared one keep serializing through the existing `div` fallback.
    const mdast = jxToMdast({ children: [{ textContent: "plain" }] });
    expect(mdast.children?.[0]).toMatchObject({ name: "div", type: "containerDirective" });
  });

  test("a literal tagName still serializes as markdown", () => {
    const doc: JxDocument = { children: [{ tagName: "h2", textContent: "Title" }] };
    expect(serializeJxMarkdown(doc, { frontmatter: false })).toBe("## Title\n");
  });
});
