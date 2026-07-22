import { describe, expect, test } from "bun:test";
import { compileClient } from "../src/targets/compile-client";
import type { JxDocument } from "@jxsuite/schema/types";

/**
 * Spec §21.1 guarantee: compiled island/client output contains NO runtime eval. A `${}` template is
 * spliced verbatim into the emitted module as a real template literal, and function bodies lower to
 * genuine JS — never `new Function` / `eval`. This test locks that so a future compiler change
 * can't silently reintroduce an eval requirement (which would force `'unsafe-eval'` on production
 * sites).
 */

const asDoc = (d: unknown) => d as JxDocument;

describe("compiled output contains no eval (spec §21.1)", () => {
  test("templates, computed bodies, and handlers emit no new Function / eval", () => {
    const doc = {
      tagName: "div",
      state: {
        count: { default: 0, type: "integer" },
        // A ${} template (computed) — the primary eval-risk surface at runtime.
        label: "${state.count} items",
        // A computed function body (returns a value).
        doubled: { $prototype: "Function", body: "return state.count * 2" },
        // An event handler body (mutates state).
        inc: { $prototype: "Function", body: "state.count++" },
      },
      children: [
        { tagName: "span", textContent: "${state.count}" },
        { tagName: "span", textContent: { $ref: "#/state/label" } },
        { tagName: "button", textContent: "+", onclick: { $ref: "#/state/inc" } },
      ],
    };

    const result = compileClient(asDoc(doc), {
      reactivitySrc: "https://esm.sh/@vue/reactivity@3.5.40",
      title: "NoEval",
    });

    const js = result.files.map((f) => f.content).join("\n");
    expect(js.length).toBeGreaterThan(0);
    expect(js).not.toContain("new Function");
    expect(js).not.toMatch(/\beval\s*\(/);
    // Sanity: the template text really did make it into the module (verbatim splice, not eval).
    expect(js).toContain("state.count");
  });
});
