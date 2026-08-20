/**
 * Element-idl-props.test.ts — IDL properties survive to the emitted element (issue #121).
 *
 * `value`, `checked` and friends go directly on the element rather than into `attributes`. The
 * emitter only had branches for a `$ref` and for a string containing `${…}`, with no `else` — so a
 * literal IDL value was dropped outright, and so was every `${…}` that a build-time map expansion
 * had already resolved to a constant. Nothing warned: `jx validate` passed, the build reported no
 * errors, and the page rendered. It just never responded correctly to input.
 */

import { describe, expect, test } from "bun:test";
import { emitElementModule } from "../src/targets/compile-element";
import type { JxDocument } from "@jxsuite/schema/types";

const emit = (doc: unknown) => emitElementModule(doc as JxDocument, "XProbe", []);

describe("emitLitNode — IDL properties", () => {
  test("emits a literal string property", () => {
    const out = emit({
      children: [{ tagName: "option", textContent: "Alpha", value: "a" }],
      tagName: "x-probe",
    });

    expect(out).toContain('.value="${"a"}"');
  });

  test("emits a literal boolean property", () => {
    const out = emit({ children: [{ checked: true, tagName: "input" }], tagName: "x-probe" });

    expect(out).toContain('.checked="${true}"');
  });

  test("still emits a bound property", () => {
    const out = emit({
      children: [{ tagName: "input", value: "${state.sel}" }],
      state: { sel: { default: "a", type: "string" } },
      tagName: "x-probe",
    });

    expect(out).toContain('.value="${s.sel}"');
  });

  test("does not emit reserved or structural keys as properties", () => {
    const out = emit({
      children: [{ attributes: { id: "x" }, tagName: "p", textContent: "hi" }],
      tagName: "x-probe",
    });

    expect(out).not.toContain(".textContent=");
    expect(out).not.toContain(".tagName=");
    expect(out).not.toContain(".attributes=");
  });
});

describe("emitMappedArray — IDL properties inside a map", () => {
  const mapDoc = {
    children: [
      {
        $prototype: "Array",
        items: { $ref: "#/state/rows" },
        map: { tagName: "option", textContent: "${$map.item.label}", value: "${$map.item.v}" },
      },
    ],
    state: { rows: { default: [], type: "array" } },
    tagName: "x-probe",
  };

  test("emits a $map-interpolating property on the map body", () => {
    // Authored per the IDL rule, this reached the output as no `value` at all, so each <option>
    // Fell back to its own label and a change handler received a display string, not the key.
    expect(emit(mapDoc)).toContain('.value="${$map.item.v}"');
  });

  test("emits a $ref property on the map body", () => {
    const out = emit({
      ...mapDoc,
      children: [
        {
          ...mapDoc.children[0],
          map: { tagName: "option", value: { $ref: "$map/item" } },
        },
      ],
    });

    // `$map/item` resolves to the callback's own `item` parameter.
    expect(out).toContain('.value="${item}"');
  });

  test("emits a literal property on the map body", () => {
    const out = emit({
      ...mapDoc,
      children: [{ ...mapDoc.children[0], map: { disabled: true, tagName: "option" } }],
    });

    expect(out).toContain('.disabled="${true}"');
  });
});
