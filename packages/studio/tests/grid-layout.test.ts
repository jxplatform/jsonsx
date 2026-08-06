import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  activeViewModified,
  activeViewName,
  applyGridLayout,
  applySavedView,
  clearGridLayout,
  deleteSavedView,
  listSavedViews,
  loadGridLayout,
  resetGridLayout,
  saveGridLayout,
  saveViewAs,
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

// ─── Saved views ──────────────────────────────────────────────────────────────

describe("saved views", () => {
  const sort = { dir: "desc" as const, field: "title" };

  test("a view snapshots every facet of the working layout and applies it back", () => {
    saveGridLayout("g1", {
      filter: "draft",
      groupBy: "status",
      hidden: ["body"],
      order: ["title", "status"],
      sort,
      widths: { title: 220 },
    });
    expect(saveViewAs("g1", "  Recent drafts  ")?.name).toBe("Recent drafts");
    expect(listSavedViews("g1").map((v) => v.name)).toEqual(["Recent drafts"]);
    expect(activeViewName("g1")).toBe("Recent drafts");

    resetGridLayout("g1");
    expect(loadGridLayout("g1")).toEqual({});
    expect(listSavedViews("g1")).toHaveLength(1);

    const applied = applySavedView("g1", "Recent drafts");
    expect(applied).toEqual({
      filter: "draft",
      groupBy: "status",
      hidden: ["body"],
      order: ["title", "status"],
      sort,
      widths: { title: 220 },
    });
    expect(loadGridLayout("g1")).toEqual(applied!);
    expect(activeViewName("g1")).toBe("Recent drafts");
  });

  test("the applied name is a bookmark: drift is reported, not silently absorbed", () => {
    saveGridLayout("g1", { hidden: [] });
    saveViewAs("g1", "Wide");
    expect(activeViewModified("g1")).toBeFalse();
    saveGridLayout("g1", { hidden: ["body"] });
    expect(activeViewModified("g1")).toBeTrue();
    // Re-saving under the same name is the Update verb — one view, not two.
    saveViewAs("g1", "Wide");
    expect(listSavedViews("g1")).toHaveLength(1);
    expect(activeViewModified("g1")).toBeFalse();
  });

  test("nothing applied means nothing to be modified relative to", () => {
    saveGridLayout("g1", { hidden: ["body"] });
    expect(activeViewName("g1")).toBeNull();
    expect(activeViewModified("g1")).toBeFalse();
  });

  test("a blank name saves nothing; an unknown view applies nothing", () => {
    expect(saveViewAs("g1", "   ")).toBeNull();
    expect(applySavedView("g1", "ghost")).toBeNull();
    expect(deleteSavedView("g1", "ghost")).toBeFalse();
    expect(listSavedViews("g1")).toEqual([]);
  });

  test("deleting the applied view clears the applied name and keeps the layout", () => {
    saveGridLayout("g1", { hidden: ["body"] });
    saveViewAs("g1", "A");
    saveViewAs("g1", "B");
    expect(deleteSavedView("g1", "B")).toBeTrue();
    expect(activeViewName("g1")).toBeNull();
    expect(loadGridLayout("g1")?.hidden).toEqual(["body"]);
    expect(deleteSavedView("g1", "A")).toBeTrue();
    expect(listSavedViews("g1")).toEqual([]);
  });

  test("deleting a view that is not the applied one leaves the applied name alone", () => {
    saveGridLayout("g1", {});
    saveViewAs("g1", "A");
    saveViewAs("g1", "B");
    expect(deleteSavedView("g1", "A")).toBeTrue();
    expect(activeViewName("g1")).toBe("B");
  });

  test("reset on a grid that stored nothing is a no-op", () => {
    resetGridLayout("nothing-here");
    expect(loadGridLayout("nothing-here")).toBeNull();
  });

  test("a stored views array of the wrong shape is ignored, not thrown on", () => {
    localStorage.setItem("jx-grid-layout:g1", JSON.stringify({ views: [{ nope: 1 }, "x"] }));
    expect(listSavedViews("g1")).toEqual([]);
    localStorage.setItem("jx-grid-layout:g1", JSON.stringify({ views: "not-an-array" }));
    expect(listSavedViews("g1")).toEqual([]);
  });

  test("views are per grid id — which is per collection, because that is the id", () => {
    saveGridLayout("grid://collection/posts", { hidden: ["body"] });
    saveViewAs("grid://collection/posts", "Posts view");
    expect(listSavedViews("grid://collection/pages")).toEqual([]);
    clearGridLayout("grid://collection/posts");
  });
});

describe("applyGridLayout hidden columns", () => {
  const defs = [{ field: "a" }, { field: "b" }, { field: "c" }, { title: "no field" }];

  test("hidden fields are withheld; a def with no field is always kept", () => {
    const out = applyGridLayout(defs, { hidden: ["b"] });
    expect(out).toHaveLength(3);
    expect(out.map((d) => d.field)).toEqual(["a", "c", undefined]);
  });

  test("hiding composes with order and widths", () => {
    const sized: { field: string; width?: number }[] = [
      { field: "a" },
      { field: "b" },
      { field: "c" },
    ];
    const out = applyGridLayout(sized, {
      hidden: ["a"],
      order: ["c", "b"],
      widths: { c: 300 },
    });
    expect(out.map((d) => d.field)).toEqual(["c", "b"]);
    expect(out[0]!.width).toBe(300);
  });
});
