import { describe, expect, test } from "bun:test";
import { isTagExpression, tagNameCandidates } from "@jxsuite/schema/guards";
import { compileClient } from "../src/targets/compile-client";
import { renderStaticNode, resolveStaticTagName } from "../src/shared";
import type { JxDocument, JxElement } from "@jxsuite/schema/types";

/*
 * A tag chosen at element creation, seen by the two targets that cannot bind one:
 * the STATIC renderer, which must commit to a single element and so resolves the choice against the
 * same scope the attributes are resolved against, and the CLIENT page target, which has no branch
 * construct and therefore refuses rather than emitting a silently wrong element.
 */

const conditional = {
  $expression: {
    initial: "div",
    operator: "?:" as const,
    target: { $ref: "#/state/href" },
    value: "a",
  },
};

const multiway = {
  $expression: {
    cases: { "1": "h1", "2": "h2" },
    default: "p",
    operator: "switch" as const,
    target: { $ref: "#/state/level" },
  },
};

const compile = (doc: unknown) => compileClient(doc as JxDocument, { title: "Test" });

/** The message `compileClient` refused a document with, or "" when it did not refuse at all. */
const refusal = (doc: unknown) => {
  try {
    compile(doc);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
};

describe("resolveStaticTagName — a chosen tag resolved for the prerender", () => {
  test("the two-way form commits to `value` when the target is truthy, `initial` when it is not", () => {
    expect(resolveStaticTagName(conditional, { href: "/docs" })).toBe("a");
    expect(resolveStaticTagName(conditional, { href: "" })).toBe("div");
  });

  test("the multiway form looks the discriminant up in `cases`, falling back to `default`", () => {
    expect(resolveStaticTagName(multiway, { level: 1 })).toBe("h1");
    expect(resolveStaticTagName(multiway, { level: 2 })).toBe("h2");
    // A key with no case, and an absent discriminant, both take the required fallback.
    expect(resolveStaticTagName(multiway, { level: 7 })).toBe("p");
    expect(resolveStaticTagName(multiway, {})).toBe("p");
  });

  test("a literal tag is itself and an absent tag is a div", () => {
    expect(resolveStaticTagName("section", { href: "/docs" })).toBe("section");
    expect(resolveStaticTagName(undefined, {})).toBe("div");
  });

  test("a half-written choice enumerates to nothing, so the prerender commits to a div", () => {
    /* The enumeration and the guard are one predicate seen twice: `tagNameCandidates` is non-empty
       only for a string — returned before either is consulted — or for a real `$expression`
       object. A document that half-declares a choice therefore reaches the same fallback an
       absent tag does, rather than crashing or emitting an empty tag. */
    for (const tagName of [
      { $expression: null },
      { $expression: [] },
      { half: "written" },
      [],
      42,
    ]) {
      expect(tagNameCandidates(tagName)).toEqual([]);
      expect(isTagExpression(tagName)).toBe(false);
      expect(resolveStaticTagName(tagName, { href: "/docs", level: 1 })).toBe("div");
    }
  });
});

describe("renderStaticNode — the element the prerender commits to", () => {
  test("the chosen tag follows the node's own scope, opening and closing the same element", () => {
    const node = {
      attributes: { href: "${state.href}" },
      children: ["Docs"],
      tagName: conditional,
    } as unknown as JxElement;

    const chosen = renderStaticNode(node, { href: "/docs" });
    expect(chosen).toStartWith("<a ");
    expect(chosen).toContain(">Docs</a>");
    expect(chosen).not.toContain("<div");

    const fallback = renderStaticNode(node, { href: "" });
    expect(fallback).toContain(">Docs</div>");
    expect(fallback).not.toContain("<a ");
  });

  test("the multiway form picks the heading level out of the component's own state", () => {
    const node = { children: ["Title"], tagName: multiway } as unknown as JxElement;
    expect(renderStaticNode(node, { level: 2 })).toBe("<h2>Title</h2>");
    expect(renderStaticNode(node, { level: 9 })).toBe("<p>Title</p>");
  });

  test("a tagName whose `$expression` is not an object renders as the div fallback", () => {
    const node = { children: ["Title"], tagName: { $expression: null } } as unknown as JxElement;
    expect(renderStaticNode(node, { level: 2 })).toBe("<div>Title</div>");
  });
});

describe("compileClient — a chosen tag is refused rather than silently wrong", () => {
  test("an element with a chosen tag throws, naming every candidate and the way out", () => {
    const message = refusal({
      children: [{ attributes: { href: "${state.href}" }, tagName: conditional }],
      state: { href: "" },
      tagName: "div",
    });
    expect(message).toContain("candidates: a, div");
    expect(message).toContain("Move the element into a component");
    expect(message).toContain("literal tagName");
  });

  test("a repeater's item template with a chosen tag throws about the repeater", () => {
    const message = refusal({
      children: [
        {
          children: {
            $prototype: "Array",
            items: { $ref: "#/state/items" },
            map: { tagName: multiway, textContent: "${$map.item}" },
          },
          tagName: "ul",
        },
      ],
      state: { items: ["one"] },
      tagName: "div",
    });
    expect(message).toContain("repeater");
    expect(message).toContain("candidates: h1, h2, p");
    expect(message).toContain("Move the item into a component");
  });

  test("a literal tag compiles to that element instead of throwing", () => {
    const { html } = compile({
      children: [{ tagName: "a", textContent: "Docs" }],
      state: { href: "" },
      tagName: "div",
    });
    expect(html).toContain("<a>Docs</a>");
  });
});
