import { describe, expect, test } from "bun:test";
import { compileElement } from "../src/targets/compile-element";
import { buildComponentCSS } from "../src/shared";
import { resolveShadowMode, styleScopePrefix } from "../src/shadow";
import type { JxDocument, ProjectConfig } from "@jxsuite/schema/types";

/**
 * Spec §16.6: light DOM is the default; a shadow root is opt-in per component.
 *
 * The two modes are asserted together, in one file, because the interesting claims are all
 * _differences_ — the slot emulation exists in one and must not exist in the other, the CSS scope
 * prefix flips, and the render target changes. A test that only knew one mode could not state any
 * of that.
 *
 * This replaces `no-shadow-dom.test.ts`, which asserted the absence of every shadow API anywhere in
 * the emitters. That was the right guard while light DOM was the only mode; it becomes a false
 * statement the moment a second mode exists, and the assertion worth keeping — that the DEFAULT
 * emits no shadow API — is the first test below.
 */

const asDoc = (d: unknown) => d as JxDocument;

const component = (extra: Record<string, unknown> = {}) =>
  asDoc({
    children: [
      { children: ["${state.n}"], className: "inner", tagName: "div" },
      { tagName: "slot" },
    ],
    state: { n: 0 },
    style: { color: "red" },
    tagName: "sd-probe",
    ...extra,
  });

const moduleFor = async (doc: JxDocument, defaults?: ProjectConfig["defaults"]) => {
  const { files } = await compileElement(doc, defaults === undefined ? {} : { defaults });
  return files.map((file) => file.content).join("\n");
};

describe("resolveShadowMode", () => {
  test("light DOM unless something says otherwise", () => {
    expect(resolveShadowMode(component())).toBeNull();
    expect(resolveShadowMode(component(), {})).toBeNull();
  });

  test("a project default turns it on for every component", () => {
    expect(resolveShadowMode(component(), { shadow: "open" })).toBe("open");
    expect(resolveShadowMode(component(), { shadow: "closed" })).toBe("closed");
  });

  // Both directions: `$shadow: false` is how one component opts out of a project that opted in.
  test("a component's own $shadow wins over the project", () => {
    expect(resolveShadowMode(component({ $shadow: "closed" }), { shadow: "open" })).toBe("closed");
    expect(resolveShadowMode(component({ $shadow: false }), { shadow: "open" })).toBeNull();
  });

  test("a value that is not a mode is ignored rather than guessed at", () => {
    expect(resolveShadowMode(component({ $shadow: "yes" }), { shadow: "open" })).toBe("open");
    expect(resolveShadowMode(component(), { shadow: true as unknown as "open" })).toBeNull();
  });
});

describe("the emitted module — light DOM (the default)", () => {
  test("names no shadow API and renders into the element", async () => {
    const source = await moduleFor(component());

    for (const api of ["attachShadow", "shadowRoot", "attachInternals", "#renderRoot"]) {
      expect(source).not.toContain(api);
    }
    expect(source).toContain("this.replaceChildren()");
    expect(source).toContain("render(this.template(), this)");
  });

  // The emulation: save the host's children, render over them, splice them back at the `<slot>`.
  test("keeps the light-DOM slot emulation", async () => {
    const source = await moduleFor(component());
    expect(source).toContain("const _slotted");
    expect(source).toContain("this.querySelector('slot')");
  });
});

describe("the emitted module — shadow DOM", () => {
  test("renders into the shadow root, not the element", async () => {
    const source = await moduleFor(component({ $shadow: "open" }));

    expect(source).toContain("render(this.template(), _root)");
    expect(source).not.toContain("render(this.template(), this)");
    // The light children are the slotted content — clearing them would delete the composition.
    expect(source).not.toContain("this.replaceChildren()");
  });

  /*
   * The hydration contract, and the reason this feature is worth anything: a declarative shadow
   * root the parser already materialized must be ADOPTED. Calling `attachShadow` over one throws,
   * and even where it did not, replacing it would discard the server-rendered markup.
   */
  test("adopts an existing declarative root instead of re-attaching", async () => {
    const source = await moduleFor(component({ $shadow: "open" }));
    expect(source).toContain("this.shadowRoot ?? this.attachShadow({ mode: 'open' })");
  });

  /*
   * A closed root is not on the element — that is what closed means — so the open-mode lookup
   * would miss it and `attachShadow` would then throw over the root the parser made.
   * `ElementInternals` is the standard's only way back to it.
   */
  test("finds a closed declarative root through ElementInternals", async () => {
    const source = await moduleFor(component({ $shadow: "closed" }));
    expect(source).toContain(
      "this.attachInternals().shadowRoot ?? this.attachShadow({ mode: 'closed' })",
    );
    expect(source).not.toContain("this.shadowRoot ??");
  });

  /*
   * `lit` renders by appending into its container, so leaving the declarative markup in place shows
   * the component twice — verified in a browser before this was written. The stylesheet link is
   * the one child that survives: it styles this root, and the document's head cannot reach in.
   */
  test("clears the declarative markup but keeps the stylesheet link", async () => {
    const source = await moduleFor(component({ $shadow: "open" }));
    expect(source).toContain("_root.childNodes");
    expect(source).toContain("_n.tagName === 'LINK'");
  });

  // Real slot distribution does the work; the emulation would fight it and move children out.
  test("drops the slot emulation entirely", async () => {
    const source = await moduleFor(component({ $shadow: "open" }));
    expect(source).not.toContain("const _slotted");
    expect(source).not.toContain("this.querySelector('slot')");
  });

  test("a project default reaches the emitted module", async () => {
    expect(await moduleFor(component(), { shadow: "open" })).toContain("attachShadow");
  });
});

describe("styleScopePrefix", () => {
  test("the tag name in light DOM, :host inside a shadow root", () => {
    expect(styleScopePrefix("sd-probe", null)).toBe("sd-probe");
    expect(styleScopePrefix("sd-probe", "open")).toBe(":host");
    expect(styleScopePrefix("sd-probe", "closed")).toBe(":host");
  });
});

describe("buildComponentCSS scoping", () => {
  const style = {
    "& .inner": { color: "blue" },
    ":hover": { color: "teal" },
    ":host(.wide)": { maxWidth: "none" },
    "::slotted(p)": { color: "green" },
    color: "red",
  };

  test("light DOM prefixes every rule with the tag name", () => {
    const css = buildComponentCSS("sd-probe", style, null, {}, null);
    expect(css).toContain("sd-probe {");
    expect(css).toContain("sd-probe .inner");
    expect(css).toContain("sd-probe:hover");
  });

  test("shadow DOM roots them at :host", () => {
    const css = buildComponentCSS("sd-probe", style, null, {}, "open");
    expect(css).toContain(":host {");
    expect(css).toContain(":host .inner");
    expect(css).toContain(":host:hover");
    expect(css).not.toContain("sd-probe");
  });

  /*
   * `:host::slotted(p)` matches nothing — the pseudo-element attaches to a slot, not to the host —
   * so it stands alone. In light DOM there is no slot to attach to either way, and the prefixed
   * form is left as it was rather than silently reinterpreted.
   */
  test("::slotted stands alone inside a shadow root", () => {
    expect(buildComponentCSS("sd-probe", style, null, {}, "open")).toContain("::slotted(p) {");
  });

  /*
   * `:host` is translated rather than passed through, so one style object means the same thing in
   * both modes: inside a root it stands alone, and outside it is the host — which is the tag name.
   * Moving a component between modes does not silently break its styles.
   */
  test(":host translates to the tag name in light DOM", () => {
    const light = buildComponentCSS("sd-probe", { ":host": { display: "block" } }, null, {}, null);
    expect(light).toContain("sd-probe { display: block }");

    const shadow = buildComponentCSS(
      "sd-probe",
      { ":host": { display: "block" } },
      null,
      {},
      "open",
    );
    expect(shadow).toContain(":host { display: block }");
  });

  test(":host(.sel) becomes <tag>.sel in light DOM", () => {
    expect(buildComponentCSS("sd-probe", style, null, {}, null)).toContain("sd-probe.wide {");
    expect(buildComponentCSS("sd-probe", style, null, {}, "open")).toContain(":host(.wide) {");
  });
});
