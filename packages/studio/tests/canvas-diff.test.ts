import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import { computeDocumentDiff } from "../src/canvas/canvas-diff";

describe("computeDocumentDiff", () => {
  test("identical documents produce empty diff map", () => {
    const doc = { tagName: "div", children: [{ tagName: "p", textContent: "hello" }] };
    const { byPath } = computeDocumentDiff(doc, doc);
    expect(byPath.size).toBe(0);
  });

  test("identical deep documents produce empty diff map", () => {
    const a = { tagName: "div", children: [{ tagName: "p", textContent: "hello" }] };
    const b = { tagName: "div", children: [{ tagName: "p", textContent: "hello" }] };
    const { byPath } = computeDocumentDiff(a, b);
    expect(byPath.size).toBe(0);
  });

  test("modified root property marks root as modified", () => {
    const orig = { tagName: "div", className: "old" };
    const curr = { tagName: "div", className: "new" };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("/")).toBe("modified");
  });

  test("added child marks child as added", () => {
    const orig = { tagName: "div", children: [] };
    const curr = { tagName: "div", children: [{ tagName: "p", textContent: "new" }] };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("added");
  });

  test("removed child marks child as removed", () => {
    const orig = { tagName: "div", children: [{ tagName: "p", textContent: "gone" }] };
    const curr = { tagName: "div", children: [] };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("removed");
  });

  test("modified child property marks child as modified", () => {
    const orig = { tagName: "div", children: [{ tagName: "p", textContent: "old" }] };
    const curr = { tagName: "div", children: [{ tagName: "p", textContent: "new" }] };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("modified");
  });

  test("added child propagates modified to parent", () => {
    const orig = { tagName: "div", children: [{ tagName: "p", textContent: "a" }] };
    const curr = {
      tagName: "div",
      children: [
        { tagName: "p", textContent: "a" },
        { tagName: "span", textContent: "b" },
      ],
    };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/1")).toBe("added");
    // Root should be marked modified due to structural change
    expect(byPath.get("/")).toBe("modified");
  });

  test("removed child propagates modified to parent", () => {
    const orig = {
      tagName: "div",
      children: [
        { tagName: "p", textContent: "a" },
        { tagName: "span", textContent: "b" },
      ],
    };
    const curr = { tagName: "div", children: [{ tagName: "p", textContent: "a" }] };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/1")).toBe("removed");
    expect(byPath.get("/")).toBe("modified");
  });

  test("deeply nested change propagates modified upward", () => {
    const orig = {
      tagName: "div",
      children: [{ tagName: "section", children: [{ tagName: "p", textContent: "old" }] }],
    };
    const curr = {
      tagName: "div",
      children: [
        {
          tagName: "section",
          children: [
            { tagName: "p", textContent: "old" },
            { tagName: "span", textContent: "new" },
          ],
        },
      ],
    };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0/children/1")).toBe("added");
    expect(byPath.get("children/0")).toBe("modified");
  });

  test("added subtree marks all descendants as added", () => {
    const orig = { tagName: "div", children: [] };
    const curr = {
      tagName: "div",
      children: [{ tagName: "ul", children: [{ tagName: "li", textContent: "item" }] }],
    };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("added");
    expect(byPath.get("children/0/children/0")).toBe("added");
  });

  test("removed subtree marks all descendants as removed", () => {
    const orig = {
      tagName: "div",
      children: [{ tagName: "ul", children: [{ tagName: "li", textContent: "item" }] }],
    };
    const curr = { tagName: "div", children: [] };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("children/0")).toBe("removed");
    expect(byPath.get("children/0/children/0")).toBe("removed");
  });

  test("ignores on* event handler properties in comparison", () => {
    const orig = { tagName: "button", onClick: "handler1" };
    const curr = { tagName: "button", onClick: "handler2" };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.size).toBe(0);
  });

  test("ignores $ref properties in comparison", () => {
    const orig = { tagName: "div", $ref: "ref1" };
    const curr = { tagName: "div", $ref: "ref2" };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.size).toBe(0);
  });

  test("null children are skipped in element filtering", () => {
    const orig = { tagName: "div", children: [null, { tagName: "p" }] } as any;
    const curr = { tagName: "div", children: [null, { tagName: "p" }] } as any;
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.size).toBe(0);
  });

  test("style object change marks element as modified", () => {
    const orig = { tagName: "div", style: { color: "red" } };
    const curr = { tagName: "div", style: { color: "blue" } };
    const { byPath } = computeDocumentDiff(orig, curr);
    expect(byPath.get("/")).toBe("modified");
  });

  test("allPaths collects all visited paths", () => {
    const orig = { tagName: "div", children: [{ tagName: "p" }] };
    const curr = { tagName: "div", children: [{ tagName: "p" }] };
    const { allPaths } = computeDocumentDiff(orig, curr);
    expect(allPaths.has("/")).toBe(true);
    expect(allPaths.has("children/0")).toBe(true);
  });
});
