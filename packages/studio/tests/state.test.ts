import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import type { JxMutableNode } from "@jxsuite/schema/types";
import {
  childIndex,
  createState,
  flattenTree,
  getNodeAtPath,
  hoverNode,
  isAncestor,
  nodeLabel,
  normalizeArrayChildren,
  parentElementPath,
  pathKey,
  pathsEqual,
  popDocument,
  pushDocument,
  selectNode,
} from "../src/state";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDoc() {
  return {
    children: [
      { tagName: "h1", textContent: "Hello" },
      {
        children: [{ tagName: "p", textContent: "Paragraph" }, { tagName: "span" }],
        tagName: "section",
      },
    ],
    tagName: "div",
  };
}

/** @param {any} [doc] */
function makeState(doc?: any) {
  return createState(doc || makeDoc());
}

// ─── Path utilities ──────────────────────────────────────────────────────────

describe("getNodeAtPath", () => {
  const doc = makeDoc();

  test("empty path returns root", () => {
    expect(getNodeAtPath(doc, [])).toBe(doc);
  });

  test("resolves first child", () => {
    expect(getNodeAtPath(doc, ["children", 0])).toBe(doc.children[0]!);
  });

  test("resolves deeply nested child", () => {
    expect(getNodeAtPath(doc, ["children", 1, "children", 0])).toBe(
      (doc.children[1] as any).children[0],
    );
  });

  test("returns undefined for invalid path", () => {
    expect(getNodeAtPath(doc, ["children", 99])).toBeUndefined();
  });

  test("returns undefined when traversing through null", () => {
    expect(getNodeAtPath(doc, ["children", 0, "children", 0])).toBeUndefined();
  });

  test("resolves a non-children key", () => {
    expect(getNodeAtPath(doc, ["tagName"]) as any).toBe("div");
  });
});

describe("parentElementPath", () => {
  test("returns parent of a child path", () => {
    expect(parentElementPath(["children", 0])).toEqual([]);
  });

  test("returns parent of a deeply nested path", () => {
    expect(parentElementPath(["children", 1, "children", 0])).toEqual(["children", 1]);
  });

  test("returns null for root path", () => {
    expect(parentElementPath([])).toBeNull();
  });

  test("returns null for single-segment path", () => {
    expect(parentElementPath(["children"])).toBeNull();
  });
});

describe("childIndex", () => {
  test("returns last segment", () => {
    expect(childIndex(["children", 2])).toBe(2);
  });

  test("works with string segment", () => {
    expect(childIndex(["cases", "home"])).toBe("home");
  });
});

describe("pathKey", () => {
  test("empty path", () => {
    expect(pathKey([])).toBe("");
  });

  test("joins segments with /", () => {
    expect(pathKey(["children", 0, "children", 1])).toBe("children/0/children/1");
  });
});

describe("pathsEqual", () => {
  test("same reference", () => {
    const p = ["children", 0];
    expect(pathsEqual(p, p)).toBe(true);
  });

  test("equal paths", () => {
    expect(pathsEqual(["children", 0], ["children", 0])).toBe(true);
  });

  test("different lengths", () => {
    expect(pathsEqual(["children", 0], ["children", 0, "children"])).toBe(false);
  });

  test("different values", () => {
    expect(pathsEqual(["children", 0], ["children", 1])).toBe(false);
  });

  test("null paths", () => {
    expect(pathsEqual(null, ["children"])).toBe(false);
    expect(pathsEqual(["children"], null)).toBe(false);
  });

  test("null === null (identity check)", () => {
    expect(pathsEqual(null, null)).toBe(true);
  });

  test("empty paths are equal", () => {
    expect(pathsEqual([], [])).toBe(true);
  });
});

describe("isAncestor", () => {
  test("root is ancestor of everything", () => {
    expect(isAncestor([], ["children", 0])).toBe(true);
  });

  test("path is ancestor of itself", () => {
    expect(isAncestor(["children", 0], ["children", 0])).toBe(true);
  });

  test("parent is ancestor of child", () => {
    expect(isAncestor(["children", 1], ["children", 1, "children", 0])).toBe(true);
  });

  test("child is not ancestor of parent", () => {
    expect(isAncestor(["children", 1, "children", 0], ["children", 1])).toBe(false);
  });

  test("sibling is not ancestor", () => {
    expect(isAncestor(["children", 0], ["children", 1])).toBe(false);
  });
});

// ─── Tree flattening ─────────────────────────────────────────────────────────

describe("flattenTree", () => {
  test("flattens static children", () => {
    const doc = makeDoc();
    const rows = flattenTree(doc);
    expect(rows.length).toBe(5); // Root + h1 + section + p + span
    expect(rows[0]!.nodeType).toBe("element");
    expect(rows[0]!.depth).toBe(0);
    expect((rows[1]!.node as JxMutableNode).tagName).toBe("h1");
    expect(rows[1]!.depth).toBe(1);
  });

  test("flattens $map children", () => {
    const doc = {
      children: {
        $prototype: "Array",
        items: { $ref: "#/$defs/list" },
        map: { tagName: "li", textContent: "item" },
      },
      tagName: "ul",
    };
    const rows = flattenTree(doc as unknown as JxMutableNode);
    expect(rows.some((r) => r.nodeType === "map")).toBe(true);
    const mapRow = rows.find((r) => r.nodeType === "map");
    expect((mapRow as any).depth).toBe(1);
    // Template element should be at depth 2
    const templateRow = rows.find(
      (r) => (r.node as JxMutableNode).tagName === "li" && r.depth === 2,
    );
    expect(templateRow).toBeDefined();
  });

  test("flattens an array pseudo-element among sibling children", () => {
    const doc = {
      children: [
        { tagName: "li", textContent: "header" },
        {
          $prototype: "Array",
          items: { $ref: "#/state/rows" },
          map: { tagName: "li", textContent: "item" },
        },
      ],
      tagName: "ul",
    };
    const rows = flattenTree(doc as unknown as JxMutableNode);
    const mapRow = rows.find((r) => r.nodeType === "map");
    expect(mapRow).toBeDefined();
    // The array node sits at its own child index, with the template one level under it.
    expect(mapRow!.path).toEqual(["children", 1]);
    expect(mapRow!.depth).toBe(1);
    const templateRow = rows.find((r) => pathsEqual(r.path, ["children", 1, "map"]));
    expect(templateRow).toBeDefined();
    expect((templateRow!.node as JxMutableNode).tagName).toBe("li");
    expect(templateRow!.depth).toBe(2);
  });

  test("flattens $switch cases", () => {
    const doc = {
      $switch: "${route}",
      cases: {
        about: { tagName: "main", textContent: "About" },
        home: { tagName: "main", textContent: "Home" },
      },
      tagName: "div",
    };
    const rows = flattenTree(doc);
    const caseRows = rows.filter((r) => r.nodeType === "case");
    expect(caseRows.length).toBe(2);
    expect(caseRows[0]!.depth).toBe(1);
  });

  test("emits case-ref for $ref cases", () => {
    const doc = {
      $switch: "${route}",
      cases: {
        home: { $ref: "#/components/home" },
      },
      tagName: "div",
    };
    const rows = flattenTree(doc);
    const refRows = rows.filter((r) => r.nodeType === "case-ref");
    expect(refRows.length).toBe(1);
  });

  test("stops recursion for custom component instances without children array", () => {
    const doc = {
      $props: { title: "Hi" },
      tagName: "my-card",
    };
    const rows = flattenTree(doc);
    // Should only have the root — no children to recurse
    expect(rows.length).toBe(1);
  });

  test("recurses into children of custom components with slotted content", () => {
    const doc = {
      $props: { title: "Hi" },
      children: [{ tagName: "p" }],
      tagName: "my-card",
    };
    const rows = flattenTree(doc);
    // Should have the root + the slotted p child
    expect(rows.length).toBe(2);
    expect((rows[1]!.node as JxMutableNode).tagName).toBe("p");
    expect(rows[1]!.path).toEqual(["children", 0]);
  });

  test("leaf node returns single row", () => {
    const doc = { tagName: "br" };
    const rows = flattenTree(doc);
    expect(rows.length).toBe(1);
    expect(rows[0]!.path).toEqual([]);
  });
});

// ─── normalizeArrayChildren ───────────────────────────────────────────────────

describe("normalizeArrayChildren", () => {
  test("converts a legacy whole-children repeater into a single array member", () => {
    const doc: JxMutableNode = {
      children: { $prototype: "Array", items: { $ref: "#/state/rows" }, map: { tagName: "li" } },
      tagName: "ul",
    };
    normalizeArrayChildren(doc);
    const kids = doc.children as JxMutableNode[];
    expect(Array.isArray(kids)).toBe(true);
    expect(kids.length).toBe(1);
    expect(kids[0]!.$prototype).toBe("Array");
  });

  test("leaves an already-normalized member array untouched", () => {
    const arr: JxMutableNode = { $prototype: "Array", items: [], map: { tagName: "li" } };
    const doc: JxMutableNode = { children: [{ tagName: "li" }, arr], tagName: "ul" };
    normalizeArrayChildren(doc);
    const kids = doc.children as JxMutableNode[];
    expect(kids).toHaveLength(2);
    expect(kids[1]).toBe(arr);
  });

  test("recurses through repeater templates and $switch cases", () => {
    const doc: JxMutableNode = {
      children: {
        $prototype: "Array",
        items: [],
        map: {
          // Nested legacy whole-children repeater inside the template.
          children: { $prototype: "Array", items: [], map: { tagName: "span" } },
          tagName: "ul",
        },
      },
      tagName: "div",
    };
    normalizeArrayChildren(doc);
    const kids = doc.children as JxMutableNode[];
    const [outer] = kids;
    expect(Array.isArray(kids)).toBe(true);
    expect(Array.isArray((outer!.map as JxMutableNode).children)).toBe(true);
  });
});

// ─── Node labels ─────────────────────────────────────────────────────────────

describe("nodeLabel", () => {
  test("null node returns ?", () => {
    expect(nodeLabel(null)).toBe("?");
  });

  test("$prototype Array shows Repeater", () => {
    expect(nodeLabel({ $prototype: "Array", items: { $ref: "#/$defs/posts" } })).toBe(
      "Repeater → #/$defs/posts",
    );
  });

  test("$id takes priority", () => {
    expect(nodeLabel({ $id: "hero", tagName: "section" })).toBe("hero");
  });

  test("tag + textContent", () => {
    expect(nodeLabel({ tagName: "p", textContent: "Hello world" })).toBe("p — Hello world");
  });

  test("truncates long text to 24 chars", () => {
    const label = nodeLabel({
      tagName: "p",
      textContent: "This is a very long paragraph text that exceeds the limit",
    });
    expect(label).toBe("p — This is a very long para");
  });

  test("$switch suffix", () => {
    expect(nodeLabel({ $switch: "${x}", tagName: "div" })).toBe("div ⇆");
  });

  test("defaults to div when no tagName", () => {
    expect(nodeLabel({})).toBe("div");
  });
});

// ─── State factory ───────────────────────────────────────────────────────────

describe("createState", () => {
  test("initializes with document", () => {
    const doc = makeDoc();
    const s = createState(doc);
    expect(s.document).toBe(doc);
    expect(s.selection).toBeNull();
    expect(s.hover).toBeNull();
  });

  test("history starts with one snapshot", () => {
    const s = makeState();
    expect(s.history.length).toBe(1);
    expect(s.historyIndex).toBe(0);
  });

  test("dirty starts as false", () => {
    expect(makeState().dirty).toBe(false);
  });

  test("ui defaults", () => {
    const s = makeState();
    expect(s.ui.rightTab).toBe("properties");
    expect(s.ui.zoom).toBe(1);
    expect(s.ui.activeMedia).toBeNull();
  });
});

// ─── Selection / hover ───────────────────────────────────────────────────────

describe("selectNode", () => {
  test("sets selection", () => {
    const s = selectNode(makeState(), ["children", 0]);
    expect(s.selection).toEqual(["children", 0]);
  });

  test("clears selection with null", () => {
    let s = selectNode(makeState(), ["children", 0]);
    s = selectNode(s, null);
    expect(s.selection).toBeNull();
  });
});

describe("hoverNode", () => {
  test("sets hover", () => {
    const s = hoverNode(makeState(), ["children", 1]);
    expect(s.hover).toEqual(["children", 1]);
  });
});

// ─── Document stack ──────────────────────────────────────────────────────────

describe("pushDocument / popDocument", () => {
  test("push saves current document and opens new one", () => {
    let s = makeState();
    const newDoc = { tagName: "article" };
    s = pushDocument(s, newDoc, "components/card.json");
    expect(s.document).toBe(newDoc);
    expect(s.documentPath).toBe("components/card.json");
    expect(s.documentStack.length).toBe(1);
    expect(s.selection).toBeNull();
  });

  test("pop restores previous document", () => {
    let s = makeState();
    s = selectNode(s, ["children", 0]);
    const origDoc = s.document;
    s = pushDocument(s, { tagName: "article" }, "card.json");
    s = popDocument(s);
    expect(s.document).toEqual(origDoc);
    expect(s.documentStack.length).toBe(0);
  });

  test("pop returns same state if stack is empty", () => {
    const s = makeState();
    expect(popDocument(s)).toBe(s);
  });

  test("push resets ui media", () => {
    let s = makeState();
    s = { ...s, ui: { ...s.ui, activeMedia: "--md" } };
    s = pushDocument(s, { tagName: "nav" }, "nav.json");
    expect(s.ui.activeMedia).toBeNull();
  });
});
