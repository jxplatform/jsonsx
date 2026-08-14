/**
 * Client-switch.test.ts — `$switch` on a dynamic page (issue #127).
 *
 * `buildClientNode` had no `$switch` branch at all, so the node fell through to the generic element
 * path: a container was emitted and then `children` was looked for to recurse into. `cases` is not
 * `children`, so the subtree was never visited and the page compiled to `<div><div></div></div>`
 * with no binding — no error, no warning, content missing. The same node through the element target
 * emitted both branches correctly, so this was one construct with two implementations and one of
 * them missing.
 *
 * Every assertion here is on branch CONTENT: the tests that existed passed against a target that
 * emitted neither branch, which is why this went unnoticed.
 */

import { describe, expect, test } from "bun:test";
import { compileClient } from "../src/targets/compile-client";
import type { JxDocument } from "@jxsuite/schema/types";

const DOC = {
  children: [
    {
      $switch: { $ref: "#/state/mode" },
      cases: {
        a: { tagName: "p", textContent: "AAA-BRANCH" },
        b: { tagName: "p", textContent: "BBB-BRANCH" },
      },
    },
  ],
  state: { mode: "a" },
  tagName: "div",
};

const compile = (doc: unknown = DOC) =>
  compileClient(doc as JxDocument, { modulePath: "app.js", title: "t" });

const moduleOf = (r: { files: { content: string }[] }) => r.files[0]?.content ?? "";

describe("compileClient — $switch", () => {
  test("emits every branch's content", () => {
    const js = moduleOf(compile());

    expect(js).toContain("AAA-BRANCH");
    expect(js).toContain("BBB-BRANCH");
  });

  test("binds the container rather than emitting an empty div", () => {
    const { html } = compile();

    expect(html).toContain("data-bind");
    expect(html).toMatch(/:render="_sw0"/);
  });

  test("keys the lookup on the discriminant", () => {
    expect(moduleOf(compile())).toContain("[String(state.mode)]");
  });

  test("falls back to an empty template for an unmatched key", () => {
    // A discriminant with no matching case renders nothing rather than throwing on `undefined`.
    expect(moduleOf(compile())).toContain("?? html``");
  });

  test("accepts a template-string discriminant", () => {
    const js = moduleOf(
      compile({ ...DOC, children: [{ ...DOC.children[0], $switch: "${state.mode}" }] }),
    );

    expect(js).toContain("[String(`${state.mode}`)]");
  });

  test("skips an external $ref case it cannot fetch at compile time", () => {
    const js = moduleOf(
      compile({
        ...DOC,
        children: [
          {
            ...DOC.children[0],
            cases: { a: { tagName: "p", textContent: "AAA-BRANCH" }, b: { $ref: "./other.json" } },
          },
        ],
      }),
    );

    expect(js).toContain("AAA-BRANCH");
    expect(js).not.toContain("other.json");
  });

  test("imports lit-html, which the binding needs", () => {
    expect(moduleOf(compile())).toContain("lit-html");
  });
});
