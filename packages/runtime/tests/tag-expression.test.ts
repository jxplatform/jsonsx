/**
 * A tag chosen when the element is created.
 *
 * The rule under test is not only "the right element appears" but "it is decided ONCE" — the
 * runtime deliberately does not track a tag, because replacing a mounted element would take its
 * subtree's listeners, focus, typed values and component instances with it, and this runtime has no
 * dispose walk to pay that bill.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { describe, expect, test } from "bun:test";
import { renderNode, resolveTagName } from "../src/runtime";
import { reactive } from "@vue/reactivity";
import type { JxTagExpression } from "@jxsuite/schema/types";

if (!globalThis.document) {
  GlobalRegistrator.register();
}

const conditional = (value: string, initial: string) =>
  ({
    $expression: { initial, operator: "?:" as const, target: { $ref: "#/state/href" }, value },
  }) satisfies { $expression: JxTagExpression };

describe("resolveTagName", () => {
  test("a plain name is itself", () => {
    expect(resolveTagName("section", {})).toBe("section");
    expect(resolveTagName(undefined, {})).toBe("div");
  });

  test("the two-way form picks by truthiness", () => {
    expect(resolveTagName(conditional("a", "div"), { href: "/x" })).toBe("a");
    expect(resolveTagName(conditional("a", "div"), { href: "" })).toBe("div");
  });

  test("the multiway form matches by string form, and falls back", () => {
    const tag = {
      $expression: {
        cases: { "1": "h1", "2": "h2" },
        default: "p",
        operator: "switch",
        target: { $ref: "#/state/level" },
      },
    };
    expect(resolveTagName(tag, { level: 1 })).toBe("h1");
    expect(resolveTagName(tag, { level: "2" })).toBe("h2");
    expect(resolveTagName(tag, { level: 9 })).toBe("p");
  });
});

describe("renderNode", () => {
  test("builds the branch the state selects, with the subtree written once", () => {
    const state = reactive({ href: "/about" }) as Record<string, unknown>;
    const el = renderNode(
      {
        attributes: { href: "${state.href}" },
        children: [{ tagName: "span", textContent: "Read" }],
        tagName: conditional("a", "div"),
      },
      state,
    ) as HTMLElement;
    expect(el.tagName.toLowerCase()).toBe("a");
    expect(el.getAttribute("href")).toBe("/about");
    expect(el.querySelector("span")?.textContent).toBe("Read");
  });

  test("the other branch, from the same document", () => {
    const el = renderNode(
      { children: [{ tagName: "span" }], tagName: conditional("a", "div") },
      reactive({ href: "" }) as Record<string, unknown>,
    ) as HTMLElement;
    expect(el.tagName.toLowerCase()).toBe("div");
  });

  test("DECIDED ONCE: a later change to the discriminant does not swap the element", () => {
    /* Deliberate, and the reason is in `defs/tag-expression.schema.ts`. Asserted rather than left
       implicit, because "the formula is live" is what every other `$expression` position teaches
       and this is the one place it is not — a test is the only thing that keeps that promise from
       drifting into a reactive implementation nobody costed. */
    const state = reactive({ href: "" }) as Record<string, unknown>;
    const el = renderNode({ children: [], tagName: conditional("a", "div") }, state) as HTMLElement;
    expect(el.tagName.toLowerCase()).toBe("div");
    state.href = "/now-a-link";
    expect(el.tagName.toLowerCase()).toBe("div");
    expect(el.isConnected).toBe(false);
  });
});
