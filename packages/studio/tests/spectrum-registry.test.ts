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
