import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyGridLayout,
  clearGridLayout,
  loadGridLayout,
  saveGridLayout,
} from "../src/grid/grid-layout";

beforeEach(() => {
  clearGridLayout("g1");
});

describe("load/save/clear", () => {
  test("round-trips and merges partial changes", () => {
    expect(loadGridLayout("g1")).toBeNull();
    saveGridLayout("g1", { widths: { title: 200 } });
    saveGridLayout("g1", { widths: { views: 90 } });
    saveGridLayout("g1", { order: ["views", "title"] });
    expect(loadGridLayout("g1")).toEqual({
      order: ["views", "title"],
      widths: { title: 200, views: 90 },
    });
    clearGridLayout("g1");
    expect(loadGridLayout("g1")).toBeNull();
  });

  test("corrupt storage reads as null", () => {
    localStorage.setItem("jx-grid-layout:g1", "{not json");
    expect(loadGridLayout("g1")).toBeNull();
  });
});

describe("applyGridLayout", () => {
  const defs = [
    { field: "a", width: 100 },
    { field: "b", width: 100 },
    { field: "c", width: 100 },
  ];

  test("null layout is identity", () => {
    expect(applyGridLayout(defs, null)).toEqual(defs);
  });

  test("saved widths override; saved order leads and unknown fields follow", () => {
    const out = applyGridLayout(defs, { order: ["c", "a"], widths: { b: 240 } });
    expect(out.map((d) => d.field)).toEqual(["c", "a", "b"]);
    expect(out.find((d) => d.field === "b")!.width).toBe(240);
    expect(out.find((d) => d.field === "a")!.width).toBe(100);
  });

  test("stale saved fields are ignored", () => {
    const out = applyGridLayout(defs, { order: ["ghost", "b"], widths: { ghost: 50 } });
    expect(out.map((d) => d.field)).toEqual(["b", "a", "c"]);
  });
});
