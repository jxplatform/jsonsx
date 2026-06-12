/**
 * Canvas diff — gap coverage for valuesEqual edge branches (array/object shape mismatches, key-set
 * differences), recursive subtree marking for added/removed trees with grandchildren, and
 * clearDiffHighlight DOM cleanup.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { clearDiffHighlight, computeDocumentDiff } from "../src/canvas/canvas-diff";

import type { JxMutableNode } from "@jxsuite/schema/types";

describe("computeDocumentDiff value comparison", () => {
  test("array vs object property values mark the node modified", () => {
    const orig = { data: [], tagName: "div" } as unknown as JxMutableNode;
    const curr = { data: {}, tagName: "div" } as unknown as JxMutableNode;
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("/")).toBe("modified");
  });

  test("different property counts mark the node modified", () => {
    const orig = { tagName: "div" } as JxMutableNode;
    const curr = { id: "x", tagName: "div" } as JxMutableNode;
    expect(computeDocumentDiff(orig, curr).byPath.get("/")).toBe("modified");
  });

  test("same property count but different keys marks the node modified", () => {
    const orig = { alpha: 1, tagName: "div" } as unknown as JxMutableNode;
    const curr = { beta: 1, tagName: "div" } as unknown as JxMutableNode;
    expect(computeDocumentDiff(orig, curr).byPath.get("/")).toBe("modified");
  });

  test("nested object values are compared deeply", () => {
    const orig = { style: { color: "red" }, tagName: "div" } as JxMutableNode;
    const currSame = { style: { color: "red" }, tagName: "div" } as JxMutableNode;
    const currDiff = { style: { color: "blue" }, tagName: "div" } as JxMutableNode;
    expect(computeDocumentDiff(orig, currSame).byPath.size).toBe(0);
    expect(computeDocumentDiff(orig, currDiff).byPath.get("/")).toBe("modified");
  });

  test("event handler and $ref properties are ignored", () => {
    const orig = { $ref: "a.json", onclick: "doA()", tagName: "p" } as unknown as JxMutableNode;
    const curr = { $ref: "b.json", onclick: "doB()", tagName: "p" } as unknown as JxMutableNode;
    expect(computeDocumentDiff(orig, curr).byPath.size).toBe(0);
  });

  test("array length mismatch in a property marks the node modified", () => {
    const orig = { tags: ["a"], terms: ["x"] } as unknown as JxMutableNode;
    const curr = { tags: ["a", "b"], terms: ["y"] } as unknown as JxMutableNode;
    expect(computeDocumentDiff(orig, curr).byPath.get("/")).toBe("modified");
  });
});

describe("computeDocumentDiff subtree marking", () => {
  test("added subtree marks every descendant added (recursive)", () => {
    const orig = { children: [], tagName: "div" } as unknown as JxMutableNode;
    const curr = {
      children: [
        {
          children: [{ children: [{ tagName: "em" }], tagName: "p" }],
          tagName: "section",
        },
      ],
      tagName: "div",
    } as unknown as JxMutableNode;
    const { allPaths, byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("added");
    expect(byPath.get("children/0/children/0")).toBe("added");
    expect(byPath.get("children/0/children/0/children/0")).toBe("added");
    expect(allPaths.has("children/0/children/0/children/0")).toBe(true);
  });

  test("removed subtree marks every descendant removed (recursive)", () => {
    const orig = {
      children: [
        {
          children: [{ children: [{ tagName: "em" }], tagName: "p" }],
          tagName: "section",
        },
      ],
      tagName: "div",
    } as unknown as JxMutableNode;
    const curr = { children: [], tagName: "div" } as unknown as JxMutableNode;
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("removed");
    expect(byPath.get("children/0/children/0")).toBe("removed");
    expect(byPath.get("children/0/children/0/children/0")).toBe("removed");
  });

  test("string children are skipped when indexing element children", () => {
    const orig = {
      children: ["text", { tagName: "p", textContent: "a" }],
      tagName: "div",
    } as unknown as JxMutableNode;
    const curr = {
      children: ["text", { tagName: "p", textContent: "b" }],
      tagName: "div",
    } as unknown as JxMutableNode;
    const { byPath } = computeDocumentDiff(orig, curr);
    // Element children are filtered: the <p> is children/0, not children/1.
    expect(byPath.get("children/0")).toBe("modified");
  });

  test("undefined documents produce an empty diff", () => {
    const diffNoArgs = computeDocumentDiff as unknown as () => ReturnType<
      typeof computeDocumentDiff
    >;
    const { allPaths, byPath } = diffNoArgs();
    expect(byPath.size).toBe(0);
    expect(allPaths.has("/")).toBe(true);
  });

  test("deep added child also marks ancestors modified via tree walk", () => {
    const orig = {
      children: [{ children: [{ tagName: "p" }], tagName: "section" }],
      tagName: "div",
    } as unknown as JxMutableNode;
    const curr = {
      children: [{ children: [{ tagName: "p" }, { tagName: "span" }], tagName: "section" }],
      tagName: "div",
    } as unknown as JxMutableNode;
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0/children/1")).toBe("added");
    expect(byPath.get("children/0")).toBe("modified");
  });
});

describe("clearDiffHighlight", () => {
  test("removes all diff classes while preserving other classes", () => {
    const canvas = document.createElement("div");
    const a = document.createElement("p");
    a.className = "element-diff-added keep-me";
    const r = document.createElement("p");
    r.className = "element-diff-removed";
    const m = document.createElement("p");
    m.className = "other element-diff-modified";
    const clean = document.createElement("p");
    clean.className = "untouched";
    canvas.append(a, r, m, clean);

    clearDiffHighlight(canvas);

    expect(a.classList.contains("element-diff-added")).toBe(false);
    expect(a.classList.contains("keep-me")).toBe(true);
    expect(r.classList.contains("element-diff-removed")).toBe(false);
    expect(m.classList.contains("element-diff-modified")).toBe(false);
    expect(m.classList.contains("other")).toBe(true);
    expect(clean.className).toBe("untouched");
  });

  test("is a no-op on a canvas without diff classes", () => {
    const canvas = document.createElement("div");
    const p = document.createElement("p");
    p.className = "plain";
    canvas.append(p);
    clearDiffHighlight(canvas);
    expect(p.className).toBe("plain");
  });
});
