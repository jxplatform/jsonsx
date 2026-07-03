import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { buildMergeTags, buildRepeaterTagsFromFields } from "../src/editor/merge-tags";
import type { MergeTag } from "../src/editor/merge-tags";

/** Fake a Vue ref so unwrapSignal resolves it. */
function ref<T>(value: T) {
  return { __v_isRef: true, value };
}

function tokens(tags: MergeTag[]) {
  return tags.map((t) => t.token);
}

function byToken(tags: MergeTag[], token: string) {
  return tags.find((t) => t.token === token);
}

describe("buildMergeTags", () => {
  test("emits top-level state names with type + value hints", () => {
    const state = { count: 5, title: "Hello" };
    const scope = { count: 5, title: "Hello" };
    const tags = buildMergeTags(state, scope);

    expect(byToken(tags, "state.title")?.hint).toBe('string · "Hello"');
    expect(byToken(tags, "state.title")?.label).toBe("state.title");
    expect(byToken(tags, "state.title")?.category).toBe("state");
    expect(byToken(tags, "state.count")?.hint).toBe("number · 5");
  });

  test("skips $-prefixed def names", () => {
    const tags = buildMergeTags({ $internal: 1, visible: 2 }, { $internal: 1, visible: 2 });
    expect(tokens(tags)).toContain("state.visible");
    expect(tokens(tags)).not.toContain("state.$internal");
  });

  test("skips function/handler defs (not text-insertable)", () => {
    const state = { onClick: { $prototype: "Function", body: "return 1" }, title: "x" };
    const tags = buildMergeTags(state, { title: "x" });
    expect(tokens(tags)).toEqual(["state.title"]);
  });

  test("walks nested object properties into dotted paths", () => {
    const scope = { user: { address: { city: "NYC" }, name: "Alice" } };
    const tags = buildMergeTags({ user: {} }, scope);

    expect(byToken(tags, "state.user")?.hint).toBe("{2}");
    expect(byToken(tags, "state.user.name")?.hint).toBe('string · "Alice"');
    expect(byToken(tags, "state.user.address")?.hint).toBe("{1}");
    expect(byToken(tags, "state.user.address.city")?.hint).toBe('string · "NYC"');
  });

  test("nested entries inherit the root def category", () => {
    const state = { posts: { $prototype: "Request", url: "/api" } };
    const scope = { posts: { data: { total: 3 } } };
    const tags = buildMergeTags(state, scope);

    expect(byToken(tags, "state.posts")?.category).toBe("data");
    expect(byToken(tags, "state.posts.data")?.category).toBe("data");
    expect(byToken(tags, "state.posts.data.total")?.category).toBe("data");
  });

  test("arrays contribute the array path plus .length, no index access", () => {
    const tags = buildMergeTags({ items: [] }, { items: [10, 20, 30, 40] });
    expect(byToken(tags, "state.items")?.hint).toBe("Array(4)");
    expect(byToken(tags, "state.items.length")?.hint).toBe("number · 4");
    expect(tokens(tags).some((t) => t.includes("[0]"))).toBe(false);
  });

  test("unwraps Vue refs before walking", () => {
    const scope = { profile: ref({ name: "Bob" }) };
    const tags = buildMergeTags({ profile: {} }, scope);
    expect(byToken(tags, "state.profile.name")?.hint).toBe('string · "Bob"');
  });

  test("respects the depth cap (3 nested levels)", () => {
    const scope = { a: { b: { c: { d: { e: 1 } } } } };
    const tags = buildMergeTags({ a: {} }, scope);
    const t = tokens(tags);
    expect(t).toContain("state.a.b.c.d");
    expect(t).not.toContain("state.a.b.c.d.e");
  });

  test("respects the breadth cap (30 keys per level)", () => {
    const big = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`k${i}`, i]));
    const tags = buildMergeTags({ big: {} }, { big });
    const nested = tokens(tags).filter((t) => t.startsWith("state.big."));
    expect(nested.length).toBe(30);
  });

  test("skips $-prefixed keys inside walked objects", () => {
    const scope = { post: { $children: [], title: "x" } };
    const tags = buildMergeTags({ post: {} }, scope);
    expect(tokens(tags)).toContain("state.post.title");
    expect(tokens(tags)).not.toContain("state.post.$children");
  });

  test("emits item/item.*/index when a repeater scope is supplied", () => {
    const localScope = { $map: { index: 2, item: { done: true, title: "T" } } };
    const tags = buildMergeTags({}, {}, localScope);

    expect(byToken(tags, "item")?.category).toBe("repeater");
    expect(byToken(tags, "item")?.hint).toBe("{2}");
    expect(byToken(tags, "item.title")?.hint).toBe('string · "T"');
    expect(byToken(tags, "item.done")?.hint).toBe("boolean · true");
    expect(byToken(tags, "index")?.hint).toBe("number · 2");
  });

  test("omits item/index without a repeater scope", () => {
    const tags = buildMergeTags({ title: "x" }, { title: "x" });
    expect(tokens(tags)).not.toContain("item");
    expect(tokens(tags)).not.toContain("index");
  });

  test("hints fall back to pending/null when the live value is absent", () => {
    const tags = buildMergeTags({ pendingData: {}, nothing: null }, { nothing: null });
    expect(byToken(tags, "state.pendingData")?.hint).toBe("pending");
    expect(byToken(tags, "state.nothing")?.hint).toBe("null");
  });

  test("tolerates null state, and a null scope with defined state", () => {
    expect(buildMergeTags(null, null)).toEqual([]);
    expect(tokens(buildMergeTags({ a: 1 }, null))).toEqual(["state.a"]);
  });
});

describe("buildRepeaterTagsFromFields", () => {
  test("emits item / index / item.* with category repeater and label===token", () => {
    const tags = buildRepeaterTagsFromFields(["item", "index", "item.data.title", "item.id"]);
    expect(tokens(tags)).toEqual(["item", "index", "item.data.title", "item.id"]);
    for (const t of tags) {
      expect(t.category).toBe("repeater");
      expect(t.label).toBe(t.token);
      expect(t.hint).toBe(""); // No live value in edit mode.
    }
  });

  test("guarantees item + index first even when the input omits them", () => {
    const tags = buildRepeaterTagsFromFields(["item.name"]);
    expect(tokens(tags)).toEqual(["item", "index", "item.name"]);
  });

  test("empty-ish input yields just item + index", () => {
    expect(tokens(buildRepeaterTagsFromFields([]))).toEqual(["item", "index"]);
  });

  test("dedupes tokens while preserving first-seen order", () => {
    const tags = buildRepeaterTagsFromFields([
      "item",
      "index",
      "item.a",
      "item.a",
      "index",
      "item.b",
    ]);
    expect(tokens(tags)).toEqual(["item", "index", "item.a", "item.b"]);
  });

  test("skips empty-string tokens", () => {
    const tags = buildRepeaterTagsFromFields(["", "item.x", ""]);
    expect(tokens(tags)).toEqual(["item", "index", "item.x"]);
  });
});
