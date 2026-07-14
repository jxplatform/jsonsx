import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  cellValuesEqual,
  gridTabLabel,
  isGridTabId,
  makeGridTabId,
  parseGridTabId,
} from "../src/grid/grid-source";

describe("grid tab ids", () => {
  test("pages id round-trips", () => {
    const id = makeGridTabId({ kind: "pages" });
    expect(id).toBe("grid://pages");
    expect(isGridTabId(id)).toBeTrue();
    expect(parseGridTabId(id)).toEqual({ kind: "pages" });
  });

  test("collection id round-trips", () => {
    const id = makeGridTabId({ kind: "collection", name: "posts" });
    expect(id).toBe("grid://collection/posts");
    expect(parseGridTabId(id)).toEqual({ kind: "collection", name: "posts" });
  });

  test("data id round-trips", () => {
    const id = makeGridTabId({ connection: "main", kind: "data", table: "users" });
    expect(parseGridTabId(id)).toEqual({ connection: "main", kind: "data", table: "users" });
  });

  test("segments with slashes survive encoding", () => {
    const id = makeGridTabId({ kind: "collection", name: "docs/guides" });
    expect(id).not.toContain("guides/");
    expect(parseGridTabId(id)).toEqual({ kind: "collection", name: "docs/guides" });
    const dataId = makeGridTabId({ connection: "a/b", kind: "data", table: "c/d" });
    expect(parseGridTabId(dataId)).toEqual({ connection: "a/b", kind: "data", table: "c/d" });
  });

  test("non-grid and malformed ids parse to null", () => {
    expect(isGridTabId("pages/index.md")).toBeFalse();
    expect(parseGridTabId("pages/index.md")).toBeNull();
    expect(parseGridTabId("grid://collection")).toBeNull();
    expect(parseGridTabId("grid://collection/")).toBeNull();
    expect(parseGridTabId("grid://data/only-conn")).toBeNull();
    expect(parseGridTabId("grid://bogus/x")).toBeNull();
    expect(parseGridTabId("grid://pages/extra")).toBeNull();
  });
});

describe("gridTabLabel", () => {
  test("labels each kind", () => {
    expect(gridTabLabel("grid://pages")).toBe("Pages · grid");
    expect(gridTabLabel(makeGridTabId({ kind: "collection", name: "posts" }))).toBe("posts · grid");
    expect(gridTabLabel(makeGridTabId({ connection: "main", kind: "data", table: "users" }))).toBe(
      "users @ main · grid",
    );
  });

  test("returns null for non-grid ids", () => {
    expect(gridTabLabel("content/posts/a.md")).toBeNull();
  });
});

describe("cellValuesEqual", () => {
  test("primitives compare by identity", () => {
    expect(cellValuesEqual("a", "a")).toBeTrue();
    expect(cellValuesEqual("a", "b")).toBeFalse();
    expect(cellValuesEqual(1, 1)).toBeTrue();
    expect(cellValuesEqual(true, false)).toBeFalse();
    expect(cellValuesEqual(null, null)).toBeTrue();
    expect(cellValuesEqual(null, "")).toBeFalse();
    expect(cellValuesEqual(0, "0")).toBeFalse();
  });

  test("arrays compare element-wise", () => {
    expect(cellValuesEqual(["a", "b"], ["a", "b"])).toBeTrue();
    expect(cellValuesEqual(["a", "b"], ["b", "a"])).toBeFalse();
    expect(cellValuesEqual(["a"], ["a", "b"])).toBeFalse();
    expect(cellValuesEqual([], [])).toBeTrue();
  });

  test("$ref objects compare by target; mixed shapes are unequal", () => {
    expect(cellValuesEqual({ $ref: "#/content/x" }, { $ref: "#/content/x" })).toBeTrue();
    expect(cellValuesEqual({ $ref: "#/content/x" }, { $ref: "#/content/y" })).toBeFalse();
    expect(cellValuesEqual({ $ref: "#/content/x" }, "x")).toBeFalse();
    expect(cellValuesEqual(["a"], { $ref: "a" })).toBeFalse();
  });
});
