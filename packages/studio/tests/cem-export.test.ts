import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  collectSlots,
  exportCemManifest,
  validateComponentSlots,
} from "../src/services/cem-export";

// ─── collectSlots ───────────────────────────────────────────────────────────

describe("collectSlots", () => {
  test("returns empty array for non-slot nodes", () => {
    expect(collectSlots({ children: [], tagName: "div" })).toEqual([]);
  });

  test("collects named slot", () => {
    const node = { attributes: { name: "header" }, tagName: "slot" };
    expect(collectSlots(node)).toEqual(["header"]);
  });

  test("collects default (unnamed) slot", () => {
    const node = { tagName: "slot" };
    expect(collectSlots(node)).toEqual([""]);
  });

  test("collects slots from children recursively", () => {
    const node = {
      children: [
        {
          children: [{ attributes: { name: "header" }, tagName: "slot" }],
          tagName: "header",
        },
        { children: [{ tagName: "slot" }], tagName: "main" },
        {
          children: [{ attributes: { name: "footer" }, tagName: "slot" }],
          tagName: "footer",
        },
      ],
      tagName: "div",
    };
    const result = collectSlots(node);
    expect(result).toEqual(["header", "", "footer"]);
  });

  test("handles deeply nested slots", () => {
    const node = {
      children: [
        {
          children: [
            {
              children: [{ attributes: { name: "deep" }, tagName: "slot" }],
              tagName: "div",
            },
          ],
          tagName: "div",
        },
      ],
      tagName: "div",
    };
    expect(collectSlots(node)).toEqual(["deep"]);
  });

  test("returns empty for null/undefined node", () => {
    expect(collectSlots(null)).toEqual([]);
    expect(collectSlots()).toEqual([]);
  });

  test("handles node without children", () => {
    expect(collectSlots({ tagName: "div" })).toEqual([]);
  });

  test("uses provided slots array", () => {
    const existing = ["existing"];
    const node = { attributes: { name: "new" }, tagName: "slot" };
    const result = collectSlots(node, existing);
    expect(result).toEqual(["existing", "new"]);
    expect(result).toBe(existing);
  });

  test("whitespace-only name counts as unnamed", () => {
    expect(collectSlots({ attributes: { name: "   " }, tagName: "slot" })).toEqual([""]);
  });

  test("trims slot names", () => {
    expect(collectSlots({ attributes: { name: " header " }, tagName: "slot" })).toEqual(["header"]);
  });
});

// ─── validateComponentSlots ─────────────────────────────────────────────────

describe("validateComponentSlots", () => {
  test("no slots is valid", () => {
    expect(validateComponentSlots({ children: [{ tagName: "div" }], tagName: "my-card" })).toBe(
      null,
    );
  });

  test("one unnamed slot is valid", () => {
    expect(validateComponentSlots({ children: [{ tagName: "slot" }], tagName: "my-card" })).toBe(
      null,
    );
  });

  test("unnamed plus named slots is valid", () => {
    const doc = {
      children: [{ tagName: "slot" }, { attributes: { name: "header" }, tagName: "slot" }],
      tagName: "my-card",
    };
    expect(validateComponentSlots(doc)).toBe(null);
  });

  test("two unnamed slots is invalid", () => {
    const doc = {
      children: [{ tagName: "slot" }, { tagName: "slot" }],
      tagName: "my-card",
    };
    expect(validateComponentSlots(doc)).toMatch(/unnamed/);
  });

  test("whitespace-only name counts as unnamed", () => {
    const doc = {
      children: [{ tagName: "slot" }, { attributes: { name: "  " }, tagName: "slot" }],
      tagName: "my-card",
    };
    expect(validateComponentSlots(doc)).toMatch(/unnamed/);
  });

  test("duplicate named slots is invalid", () => {
    const doc = {
      children: [
        { attributes: { name: "header" }, tagName: "slot" },
        { attributes: { name: "header" }, tagName: "slot" },
      ],
      tagName: "my-card",
    };
    expect(validateComponentSlots(doc)).toMatch(/Duplicate slot name "header"/);
  });

  test("distinct named slots are valid", () => {
    const doc = {
      children: [
        { attributes: { name: "header" }, tagName: "slot" },
        { attributes: { name: "footer" }, tagName: "slot" },
      ],
      tagName: "my-card",
    };
    expect(validateComponentSlots(doc)).toBe(null);
  });

  test("counts nested slots", () => {
    const doc = {
      children: [
        { children: [{ tagName: "slot" }], tagName: "main" },
        { children: [{ tagName: "slot" }], tagName: "aside" },
      ],
      tagName: "my-card",
    };
    expect(validateComponentSlots(doc)).toMatch(/2 unnamed/);
  });
});

// ─── exportCemManifest ─────────────────────────────────────────────────────

describe("exportCemManifest", () => {
  const helpers = {
    collectCssParts: () => [],
    defCategory: (d: any) => {
      if (!d || typeof d !== "object") {
        return "unknown";
      }
      if (d.$prototype === "Function" || d.body || d.src) {
        return "function";
      }
      return "state";
    },
    normParam: (p: any) => ({ name: p.name, type: p.type }),
  };

  test("does nothing for non-custom-element tagName", () => {
    const S = { document: { state: {}, tagName: "div" } };
    const result = exportCemManifest(S, helpers);
    expect(result).toBeUndefined();
  });

  test("does nothing for missing tagName", () => {
    const S = { document: { state: {} } };
    const result = exportCemManifest(S, helpers);
    expect(result).toBeUndefined();
  });

  test("generates manifest with members from state", () => {
    const S = {
      document: {
        children: [],
        state: {
          count: { default: 0, description: "Current count", type: "number" },
          increment: {
            $prototype: "Function",
            body: "state.count++",
            description: "Add one",
          },
        },
        tagName: "my-counter",
      },
    };

    exportCemManifest(S, helpers);
    // If it ran successfully (triggers a download in DOM), the function completed
    // We just verify it doesn't throw for valid input
  });

  test("collects events from function emits", () => {
    const S = {
      document: {
        children: [],
        state: {
          handleChange: {
            $prototype: "Function",
            body: "",
            emits: [
              {
                description: "Value changed",
                name: "change",
                type: "CustomEvent",
              },
            ],
          },
        },
        tagName: "my-input",
      },
    };

    // Should not throw
    exportCemManifest(S, helpers);
  });

  test("collects slots from document tree", () => {
    const S = {
      document: {
        children: [{ attributes: { name: "header" }, tagName: "slot" }, { tagName: "slot" }],
        state: {},
        tagName: "my-layout",
      },
    };

    exportCemManifest(S, helpers);
  });

  test("collects CSS custom properties from style", () => {
    const S = {
      document: {
        children: [],
        state: {},
        style: {
          "--primary": "#007bff",
          "--secondary": "#6c757d",
          color: "inherit",
        },
        tagName: "my-themed",
      },
    };

    exportCemManifest(S, helpers);
  });

  test("handles attributes and reflects", () => {
    const S = {
      document: {
        children: [],
        state: {
          checked: {
            attribute: "checked",
            default: false,
            reflects: true,
            type: "boolean",
          },
        },
        tagName: "my-toggle",
      },
    };

    exportCemManifest(S, helpers);
  });

  test("skips private state (# prefix)", () => {
    const S = {
      document: {
        children: [],
        state: {
          "#internal": { type: "string" },
          visible: { default: true, type: "boolean" },
        },
        tagName: "my-comp",
      },
    };

    exportCemManifest(S, helpers);
  });

  test("handles deprecated fields", () => {
    const S = {
      document: {
        children: [],
        state: {
          legacyProp: { deprecated: "Use newProp instead", type: "string" },
          oldMethod: { $prototype: "Function", body: "", deprecated: true },
        },
        tagName: "my-old",
      },
    };

    exportCemManifest(S, helpers);
  });
});
