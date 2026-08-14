import "./harness";
import { describe, expect, test } from "bun:test";

// Pre-define one tag so the registration loop's "already defined" guard is exercised.
class PreexistingToast extends HTMLElement {}
customElements.define("sp-toast", PreexistingToast);

const { components } = await import("../src/ui/spectrum");

describe("spectrum component registry", () => {
  test("exports the full tag/constructor manifest", () => {
    expect(components.length).toBeGreaterThan(100);
    const tags = components.map(([tag]) => tag);
    expect(new Set(tags).size).toBe(tags.length); // No duplicate tags
    for (const [tag, ctor] of components as [string, CustomElementConstructor][]) {
      expect(typeof tag).toBe("string");
      expect(typeof ctor).toBe("function");
    }
  });

  test("registers every manifest tag on the custom element registry", () => {
    for (const [tag] of components) {
      expect(customElements.get(tag as string), tag as string).toBeDefined();
    }
  });

  test("sp-tooltip is registered, and NOT by us", () => {
    /* The one tag this file deliberately does not own.
       Registering it here from the class-only module made Studio the first definer, and Spectrum's
       own registering entry — reached later by the textfield's dynamically-imported truncated-value
       controller — then called `customElements.define` for a name already taken and threw
       `NotSupportedError` into the console during ordinary panel use. The loop's
       `customElements.get` guard could never help: the second define is Spectrum's own call inside
       node_modules. A bare side-effect import of `sp-tooltip.js` puts THEIR module in the static
       graph, so it is the single definer and the later dynamic import hits the module cache.

       Both halves are asserted, because either one alone passes on the broken arrangement. */
    expect(components.map(([tag]) => tag)).not.toContain("sp-tooltip");
    expect(customElements.get("sp-tooltip")).toBeDefined();
  });

  test("widgets, icons, and studio elements are all reachable by tag", () => {
    for (const tag of [
      "sp-theme",
      "sp-action-button",
      "sp-color-area",
      "sp-table-cell",
      "sp-icon-folder",
      "sp-icon-chevron100",
      "jx-value-selector",
      "jx-color-popover",
    ]) {
      expect(customElements.get(tag), tag).toBeDefined();
    }
  });

  test("pre-registered tags are left untouched instead of redefined", () => {
    expect(customElements.get("sp-toast")).toBe(PreexistingToast);
    const manifestToast = components.find(([tag]) => tag === "sp-toast");
    expect(manifestToast?.[1]).not.toBe(PreexistingToast);
  });

  test("registered constructors instantiate via createElement", () => {
    const el = document.createElement("sp-divider");
    const ctor = customElements.get("sp-divider") as CustomElementConstructor;
    expect(el).toBeInstanceOf(ctor);
  });
});
