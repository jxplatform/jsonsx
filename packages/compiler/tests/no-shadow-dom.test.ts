import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileElement } from "../src/targets/compile-element";
import type { JxDocument } from "@jxsuite/schema/types";

/**
 * Spec §16.6: custom elements render to the **light DOM**, and no shadow root is attached anywhere
 * in the compiler or the runtime.
 *
 * That is a deliberate divergence from the encapsulation model WHATWG HTML offers, not an
 * oversight, and it is load-bearing in both directions: a page's own CSS can restyle a component
 * because nothing isolates it, and the light-DOM `<slot>` emulation exists because there is no real
 * slot distribution. Adding a shadow root anywhere would change both without any call site asking
 * for it — so the absence is asserted rather than assumed.
 *
 * The opt-in (`$shadow` on a component, `defaults.shadow` on a project) is designed and not built;
 * when it lands, this test gains a mode rather than being deleted.
 */

const asDoc = (d: unknown) => d as JxDocument;

/** Every construct that would create or address a shadow root. */
const SHADOW_APIS = [
  "attachShadow",
  "shadowRoot",
  "shadowrootmode",
  "adoptedStyleSheets",
  "::part(",
  "::slotted(",
  ":host",
];

describe("compiled elements attach no shadow root (spec §16.6)", () => {
  test("an element module renders into the element itself", async () => {
    const doc = asDoc({
      children: [
        { children: ["${state.n}"], onclick: { $ref: "#/state/bump" }, tagName: "button" },
        { tagName: "slot" },
      ],
      state: {
        bump: { $expression: { operator: "+=", target: { $ref: "#/state/n" }, value: 1 } },
        n: 0,
      },
      style: { color: "red" },
      tagName: "sd-probe",
    });

    const { files } = await compileElement(doc);
    const source = files.map((file) => file.content).join("\n");

    for (const api of SHADOW_APIS) {
      expect(source).not.toContain(api);
    }
    // The positive half: the render target is the element, which is what "light DOM" means.
    expect(source).toContain("render(this.template(), this)");
  });
});

describe("the compiler and runtime sources name no shadow API", () => {
  /*
   * A source-level assertion, because the emitted-output test above only covers the constructs one
   * document happens to reach. Shadow DOM is all-or-nothing for a component's styling and slotting
   * contract, so the guarantee has to be about the code, not about a sample of its output.
   */
  const ROOT = join(import.meta.dir, "../..");
  const SOURCES = [
    "compiler/src/targets/compile-element.ts",
    "compiler/src/targets/compile-client.ts",
    "compiler/src/targets/compile-static.ts",
    "compiler/src/shared.ts",
    "runtime/src/runtime.ts",
  ];

  test("no attachShadow, shadowrootmode or adoptedStyleSheets in the emitters", () => {
    for (const rel of SOURCES) {
      let source: string;
      try {
        source = readFileSync(join(ROOT, rel), "utf8");
      } catch {
        // A moved file should fail loudly rather than silently pass this check.
        throw new Error(`${rel} no longer exists — update this test's source list`);
      }
      for (const api of ["attachShadow", "shadowrootmode", "adoptedStyleSheets"]) {
        // Stripped of comments first: the modules explain *why* there is no shadow root, and
        // Saying so must not trip the check that says so.
        const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
        expect(code).not.toContain(api);
      }
    }
  });
});
