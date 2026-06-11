import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { computeDocumentDiff } from "../src/canvas/canvas-diff";

describe("computeDocumentDiff", () => {
  test("identical documents produce empty diff map", () => {
    const doc = {
      children: [{ tagName: "p", textContent: "hello" }],
      tagName: "div",
    };
    const { byPath } = computeDocumentDiff(doc, doc);
    expect(byPath.size).toBe(0);
  });

  test("identical deep documents produce empty diff map", () => {
    const a = {
      children: [{ tagName: "p", textContent: "hello" }],
      tagName: "div",
    };
    const b = {
      children: [{ tagName: "p", textContent: "hello" }],
      tagName: "div",
    };
    const { byPath } = computeDocumentDiff(a, b);
    expect(byPath.size).toBe(0);
  });

  test("modified root property marks root as modified", () => {
    const orig = { className: "old", tagName: "div" };
    const curr = { className: "new", tagName: "div" };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("/")).toBe("modified");
  });

  test("added child marks child as added", () => {
    const orig = { children: [], tagName: "div" };
    const curr = {
      children: [{ tagName: "p", textContent: "new" }],
      tagName: "div",
    };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("added");
  });

  test("removed child marks child as removed", () => {
    const orig = {
      children: [{ tagName: "p", textContent: "gone" }],
      tagName: "div",
    };
    const curr = { children: [], tagName: "div" };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("removed");
  });

  test("modified child property marks child as modified", () => {
    const orig = {
      children: [{ tagName: "p", textContent: "old" }],
      tagName: "div",
    };
    const curr = {
      children: [{ tagName: "p", textContent: "new" }],
      tagName: "div",
    };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("modified");
  });

  test("added child propagates modified to parent", () => {
    const orig = {
      children: [{ tagName: "p", textContent: "a" }],
      tagName: "div",
    };
    const curr = {
      children: [
        { tagName: "p", textContent: "a" },
        { tagName: "span", textContent: "b" },
      ],
      tagName: "div",
    };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/1")).toBe("added");
    // Root should be marked modified due to structural change
    expect(byPath.get("/")).toBe("modified");
  });

  test("removed child propagates modified to parent", () => {
    const orig = {
      children: [
        { tagName: "p", textContent: "a" },
        { tagName: "span", textContent: "b" },
      ],
      tagName: "div",
    };
    const curr = {
      children: [{ tagName: "p", textContent: "a" }],
      tagName: "div",
    };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/1")).toBe("removed");
    expect(byPath.get("/")).toBe("modified");
  });

  test("deeply nested change propagates modified upward", () => {
    const orig = {
      children: [
        {
          children: [{ tagName: "p", textContent: "old" }],
          tagName: "section",
        },
      ],
      tagName: "div",
    };
    const curr = {
      children: [
        {
          children: [
            { tagName: "p", textContent: "old" },
            { tagName: "span", textContent: "new" },
          ],
          tagName: "section",
        },
      ],
      tagName: "div",
    };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0/children/1")).toBe("added");
    expect(byPath.get("children/0")).toBe("modified");
  });

  test("added subtree marks all descendants as added", () => {
    const orig = { children: [], tagName: "div" };
    const curr = {
      children: [{ children: [{ tagName: "li", textContent: "item" }], tagName: "ul" }],
      tagName: "div",
    };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("added");
    expect(byPath.get("children/0/children/0")).toBe("added");
  });

  test("removed subtree marks all descendants as removed", () => {
    const orig = {
      children: [{ children: [{ tagName: "li", textContent: "item" }], tagName: "ul" }],
      tagName: "div",
    };
    const curr = { children: [], tagName: "div" };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("removed");
    expect(byPath.get("children/0/children/0")).toBe("removed");
  });

  test("ignores on* event handler properties in comparison", () => {
    const orig = { onClick: "handler1", tagName: "button" };
    const curr = { onClick: "handler2", tagName: "button" };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.size).toBe(0);
  });

  test("ignores $ref properties in comparison", () => {
    const orig = { $ref: "ref1", tagName: "div" };
    const curr = { $ref: "ref2", tagName: "div" };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.size).toBe(0);
  });

  test("null children are skipped in element filtering", () => {
    const orig = { children: [null, { tagName: "p" }], tagName: "div" } as any;
    const curr = { children: [null, { tagName: "p" }], tagName: "div" } as any;
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.size).toBe(0);
  });

  test("style object change marks element as modified", () => {
    const orig = { style: { color: "red" }, tagName: "div" };
    const curr = { style: { color: "blue" }, tagName: "div" };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("/")).toBe("modified");
  });

  test("allPaths collects all visited paths", () => {
    const orig = { children: [{ tagName: "p" }], tagName: "div" };
    const curr = { children: [{ tagName: "p" }], tagName: "div" };
    const { allPaths } = computeDocumentDiff(orig, curr);
    expect(allPaths.has("/")).toBe(true);
    expect(allPaths.has("children/0")).toBe(true);
  });
});
