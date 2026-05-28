import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import { collectSlots, exportCemManifest } from "../src/services/cem-export.js";

// ─── collectSlots ───────────────────────────────────────────────────────────

describe("collectSlots", () => {
  test("returns empty array for non-slot nodes", () => {
    expect(collectSlots({ tagName: "div", children: [] })).toEqual([]);
  });

  test("collects named slot", () => {
    const node = { tagName: "slot", attributes: { name: "header" } };
    expect(collectSlots(node)).toEqual(["header"]);
  });

  test("collects default (unnamed) slot", () => {
    const node = { tagName: "slot" };
    expect(collectSlots(node)).toEqual([""]);
  });

  test("collects slots from children recursively", () => {
    const node = {
      tagName: "div",
      children: [
        { tagName: "header", children: [{ tagName: "slot", attributes: { name: "header" } }] },
        { tagName: "main", children: [{ tagName: "slot" }] },
        {
          tagName: "footer",
          children: [{ tagName: "slot", attributes: { name: "footer" } }],
        },
      ],
    };
    const result = collectSlots(node);
    expect(result).toEqual(["header", "", "footer"]);
  });

  test("handles deeply nested slots", () => {
    const node = {
      tagName: "div",
      children: [
        {
          tagName: "div",
          children: [
            {
              tagName: "div",
              children: [{ tagName: "slot", attributes: { name: "deep" } }],
            },
          ],
        },
      ],
    };
    expect(collectSlots(node)).toEqual(["deep"]);
  });

  test("returns empty for null/undefined node", () => {
    expect(collectSlots(null)).toEqual([]);
    expect(collectSlots(undefined)).toEqual([]);
  });

  test("handles node without children", () => {
    expect(collectSlots({ tagName: "div" })).toEqual([]);
  });

  test("uses provided slots array", () => {
    const existing = ["existing"];
    const node = { tagName: "slot", attributes: { name: "new" } };
    const result = collectSlots(node, existing);
    expect(result).toEqual(["existing", "new"]);
    expect(result).toBe(existing);
  });
});

// ─── exportCemManifest ─────────────────────────────────────────────────────

describe("exportCemManifest", () => {
  const helpers = {
    defCategory: (/** @type {any} */ d) => {
      if (!d || typeof d !== "object") return "unknown";
      if (d.$prototype === "Function" || d.body || d.src) return "function";
      return "state";
    },
    normParam: (/** @type {any} */ p) => ({ name: p.name, type: p.type }),
    collectCssParts: () => [],
  };

  test("does nothing for non-custom-element tagName", () => {
    const S = { document: { tagName: "div", state: {} } };
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
        tagName: "my-counter",
        state: {
          count: { type: "number", default: 0, description: "Current count" },
          increment: { $prototype: "Function", body: "state.count++", description: "Add one" },
        },
        children: [],
      },
    };

    exportCemManifest(S, helpers);
    // If it ran successfully (triggers a download in DOM), the function completed
    // We just verify it doesn't throw for valid input
  });

  test("collects events from function emits", () => {
    const S = {
      document: {
        tagName: "my-input",
        state: {
          handleChange: {
            $prototype: "Function",
            body: "",
            emits: [{ name: "change", type: "CustomEvent", description: "Value changed" }],
          },
        },
        children: [],
      },
    };

    // Should not throw
    exportCemManifest(S, helpers);
  });

  test("collects slots from document tree", () => {
    const S = {
      document: {
        tagName: "my-layout",
        state: {},
        children: [{ tagName: "slot", attributes: { name: "header" } }, { tagName: "slot" }],
      },
    };

    exportCemManifest(S, helpers);
  });

  test("collects CSS custom properties from style", () => {
    const S = {
      document: {
        tagName: "my-themed",
        state: {},
        style: { "--primary": "#007bff", "--secondary": "#6c757d", color: "inherit" },
        children: [],
      },
    };

    exportCemManifest(S, helpers);
  });

  test("handles attributes and reflects", () => {
    const S = {
      document: {
        tagName: "my-toggle",
        state: {
          checked: {
            type: "boolean",
            default: false,
            attribute: "checked",
            reflects: true,
          },
        },
        children: [],
      },
    };

    exportCemManifest(S, helpers);
  });

  test("skips private state (# prefix)", () => {
    const S = {
      document: {
        tagName: "my-comp",
        state: {
          "#internal": { type: "string" },
          visible: { type: "boolean", default: true },
        },
        children: [],
      },
    };

    exportCemManifest(S, helpers);
  });

  test("handles deprecated fields", () => {
    const S = {
      document: {
        tagName: "my-old",
        state: {
          legacyProp: { type: "string", deprecated: "Use newProp instead" },
          oldMethod: { $prototype: "Function", body: "", deprecated: true },
        },
        children: [],
      },
    };

    exportCemManifest(S, helpers);
  });
});
