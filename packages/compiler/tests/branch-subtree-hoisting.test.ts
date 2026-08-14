/**
 * Branch-subtree-hoisting.test.ts — shared subtrees are hoisted out of branching constructs (#126).
 *
 * `emitLitNode` returns one template string, so a construct with N branches recursed once per
 * branch and wrote the whole subtree N times into the bundle — the authored document contains it
 * once. The output was always correct, which is why this sat unnoticed since `$switch` was
 * implemented: it is invisible except in bundle size.
 *
 * The assertions are on the COUNT, not on the output still rendering: the duplicating emitter
 * passed every render-level assertion, which is why the issue was measured rather than noticed. The
 * last block executes the emitted module in a DOM, because hoisting moves a subtree into a `const`
 * inside `template()` and that is a change to lit semantics, not just to bytes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { emitElementModule } from "../src/targets/compile-element";
import type { JxDocument } from "@jxsuite/schema/types";

const emit = (doc: unknown, name = "XProbe") => emitElementModule(doc as JxDocument, name, []);

/** Two children, so the shared subtree is big enough for duplication to matter. */
const SUBTREE = [
  { className: "label", tagName: "span", textContent: "${state.label}" },
  { tagName: "p", textContent: "Body copy." },
];

const chosenTag = (candidates: [string, string]) => ({
  children: [
    {
      children: SUBTREE,
      tagName: {
        $expression: {
          initial: candidates[1],
          operator: "?:",
          target: { $ref: "#/state/on" },
          value: candidates[0],
        },
      },
    },
  ],
  state: { label: { default: "L", type: "string" }, on: { default: false, type: "boolean" } },
  tagName: "x-tag",
});

const switchDoc = {
  children: [
    {
      $switch: { $ref: "#/state/mode" },
      cases: {
        a: { children: SUBTREE, tagName: "div" },
        b: { children: SUBTREE, tagName: "div" },
        c: { children: SUBTREE, tagName: "div" },
      },
      tagName: "div",
    },
  ],
  state: { label: { default: "L", type: "string" }, mode: { default: "a", type: "string" } },
  tagName: "x-switch",
};

describe("a chosen tagName", () => {
  test("writes the shared subtree once, not once per candidate", () => {
    const out = emit(chosenTag(["a", "div"]));

    expect(out.split("<span").length - 1).toBe(1);
    expect(out.split("${_c0}").length - 1).toBe(2);
  });

  test("declares the const inside template(), above the return", () => {
    // It has to be rebuilt per render and read the same `s` the template does — a module-scope
    // Const would capture one render's values forever.
    const out = emit(chosenTag(["a", "div"]));

    expect(out.indexOf("const s = this.state")).toBeLessThan(out.indexOf("const _c0"));
    expect(out.indexOf("const _c0")).toBeLessThan(out.indexOf("return html`"));
  });

  test("keeps both branches' tags", () => {
    const out = emit(chosenTag(["a", "div"]));

    expect(out).toContain("<a");
    expect(out).toContain("<div");
  });

  test("does not hoist when the candidates disagree about being preformatted", () => {
    // `white-space` decides how the subtree itself is indented, so `pre` and `div` cannot share one
    // Emitted copy.
    const out = emit(chosenTag(["pre", "div"]));

    expect(out).not.toContain("const _c0");
    expect(out.split("<span").length - 1).toBe(2);
  });
});

describe("$switch", () => {
  test("collapses byte-identical cases onto one const", () => {
    const out = emit(switchDoc);

    expect(out.split("<span").length - 1).toBe(1);
    expect(out.split("${_c0}").length - 1).toBe(3);
  });

  test("leaves distinct cases inline", () => {
    // Hoisting a case that appears once would add the `const` wrapper and save nothing.
    const out = emit({
      ...switchDoc,
      children: [
        {
          ...switchDoc.children[0],
          cases: {
            a: { tagName: "p", textContent: "ONE" },
            b: { tagName: "p", textContent: "TWO" },
          },
        },
      ],
    });

    expect(out).not.toContain("const _c0");
    expect(out).toContain("ONE");
    expect(out).toContain("TWO");
  });
});

describe("inside a map callback", () => {
  test("declares the const in the callback, not in template()", () => {
    // A subtree hoisted out of a branch in a map body closes over that callback's item/index, so
    // Lifting it to template() scope would emit a reference to an undefined binding.
    const out = emit({
      children: [
        {
          $prototype: "Array",
          items: { $ref: "#/state/rows" },
          map: {
            children: [
              {
                $switch: { $ref: "#/state/mode" },
                cases: {
                  a: { tagName: "b", textContent: "${$map.item.name}" },
                  b: { tagName: "b", textContent: "${$map.item.name}" },
                },
                tagName: "div",
              },
            ],
            tagName: "li",
          },
        },
      ],
      state: { mode: { default: "a", type: "string" }, rows: { default: [], type: "array" } },
      tagName: "x-map",
    });

    const callbackStart = out.indexOf("(item, index) =>");
    expect(callbackStart).toBeGreaterThan(-1);
    expect(out.indexOf("const _c0")).toBeGreaterThan(callbackStart);
  });
});

// ── The hoisted module actually renders ──────────────────────────────────────

const TMP = resolve(import.meta.dir, "__test-hoist-render__");
let win: Window;
let host: Element;

beforeAll(async () => {
  rmSync(TMP, { force: true, recursive: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(resolve(TMP, "el.js"), emit(chosenTag(["a", "div"]), "XHoist"), "utf8");

  win = new Window({ url: "https://example.test" });
  const globals = globalThis as Record<string, unknown>;
  const source = win as unknown as Record<string, unknown>;
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "customElements",
    "Node",
    "Element",
    "Event",
    "CustomEvent",
  ]) {
    globals[key] = source[key];
  }

  await import(resolve(TMP, "el.js"));
  win.document.body.innerHTML = "<x-tag></x-tag>";
  host = win.document.querySelector("x-tag") as unknown as Element;
  await new Promise((r) => {
    setTimeout(r, 20);
  });
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

describe("hoisted branch — runtime behaviour", () => {
  test("renders the shared subtree through the hoisted const", () => {
    expect(host.querySelector("span")?.textContent).toBe("L");
    expect(host.querySelector("p")?.textContent).toBe("Body copy.");
  });

  test("renders the branch the discriminant selects", () => {
    // `on` defaults to false → the `initial` candidate.
    expect(host.querySelector("div")).toBeTruthy();
    expect(host.querySelector("a")).toBeNull();
  });

  test("the shared subtree stays reactive after a state change", () => {
    // The const is rebuilt per render, so the binding inside it must still track `label`.
    (host as unknown as { state: Record<string, unknown> }).state.label = "CHANGED";
    expect(host.querySelector("span")?.textContent).toBe("CHANGED");
  });

  test("switching the discriminant swaps the tag and keeps the subtree", () => {
    (host as unknown as { state: Record<string, unknown> }).state.on = true;
    expect(host.querySelector("a")).toBeTruthy();
    expect(host.querySelector("a")?.querySelector("span")?.textContent).toBe("CHANGED");
  });
});
