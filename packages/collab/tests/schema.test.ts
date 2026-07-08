import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import type { JxMutableNode } from "@jxsuite/schema/types";
import {
  frontmatterMap,
  metaMap,
  resolveYPath,
  seedStructure,
  sourceText,
  structureMap,
  toYNode,
  yDocToJson,
  yValueToJson,
} from "../src/schema.ts";

const SAMPLE: JxMutableNode = {
  children: [
    { tagName: "h1", textContent: "Title" },
    "loose text",
    {
      children: [{ tagName: "span", textContent: "deep" }],
      style: { color: "red", "@md": { color: "blue" } },
      tagName: "section",
    },
  ],
  state: { count: { default: 0 } },
  tagName: "div",
};

function seeded(doc: JxMutableNode = SAMPLE): Y.Doc {
  const ydoc = new Y.Doc();
  seedStructure(ydoc, doc, { frontmatter: { title: "Hello" }, sourceFormat: "markdown" });
  return ydoc;
}

describe("seedStructure / yDocToJson", () => {
  test("roundtrips a representative document identically", () => {
    const ydoc = seeded();
    expect(yDocToJson(ydoc)).toEqual(SAMPLE);
  });

  test("roundtrips an empty document", () => {
    const ydoc = seeded({});
    expect(yDocToJson(ydoc)).toEqual({});
  });

  test("string children and nested arrays survive", () => {
    const doc: JxMutableNode = { children: ["a", "b", { children: ["c"], tagName: "p" }] };
    expect(yDocToJson(seeded(doc))).toEqual(doc);
  });

  test("records meta and frontmatter", () => {
    const ydoc = seeded();
    expect(metaMap(ydoc).get("structureSeeded")).toBe(true);
    expect(metaMap(ydoc).get("canonical")).toBe("structure");
    expect(metaMap(ydoc).get("sourceFormat")).toBe("markdown");
    expect(frontmatterMap(ydoc).get("title")).toBe("Hello");
  });

  test("second seed is a no-op (another seeder already won)", () => {
    const ydoc = seeded();
    const won = seedStructure(ydoc, { tagName: "other" });
    expect(won).toBe(false);
    expect((yDocToJson(ydoc) as { tagName?: string }).tagName).toBe("div");
  });

  test("undefined-valued keys are dropped, not stored", () => {
    const ydoc = seeded({ tagName: "div", textContent: undefined } as unknown as JxMutableNode);
    expect("textContent" in yDocToJson(ydoc)).toBe(false);
  });

  test("concurrent seeders converge without duplicating children", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    // Both seed the same parsed document before hearing from each other.
    seedStructure(a, SAMPLE);
    seedStructure(b, SAMPLE);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(yDocToJson(a)).toEqual(SAMPLE);
    expect(yDocToJson(b)).toEqual(yDocToJson(a));
    const { children } = yDocToJson(a) as { children: unknown[] };
    expect(children).toHaveLength(3);
  });
});

describe("resolveYPath", () => {
  test("resolves nodes, children arrays, string children, and leaves", () => {
    const ydoc = seeded();
    expect(resolveYPath(ydoc, [])).toBe(structureMap(ydoc));
    const h1 = resolveYPath(ydoc, ["children", 0]);
    expect(h1).toBeInstanceOf(Y.Map);
    expect((h1 as Y.Map<unknown>).get("textContent")).toBe("Title");
    expect(resolveYPath(ydoc, ["children", 1])).toBe("loose text");
    expect(resolveYPath(ydoc, ["children", 2, "children", 0, "textContent"])).toBe("deep");
    expect(resolveYPath(ydoc, ["children"])).toBeInstanceOf(Y.Array);
  });

  test("missing segments resolve to undefined", () => {
    const ydoc = seeded();
    expect(resolveYPath(ydoc, ["children", 9])).toBeUndefined();
    expect(resolveYPath(ydoc, ["children", -1])).toBeUndefined();
    expect(resolveYPath(ydoc, ["nope", 0])).toBeUndefined();
    expect(resolveYPath(ydoc, ["children", 1, "children", 0])).toBeUndefined();
  });
});

describe("toYNode / yValueToJson", () => {
  test("rejects non-object nodes", () => {
    expect(() => toYNode("just a string")).toThrow(TypeError);
    expect(() => toYNode([1, 2])).toThrow(TypeError);
  });

  test("plain leaves pass through yValueToJson", () => {
    expect(yValueToJson("x")).toBe("x");
    expect(yValueToJson(3)).toBe(3);
    expect(yValueToJson(null)).toBeNull();
  });
});

describe("sourceText", () => {
  test("is an initially-empty Y.Text the provider seeds", () => {
    const ydoc = new Y.Doc();
    expect(sourceText(ydoc).toString()).toBe("");
    sourceText(ydoc).insert(0, "# Hello");
    expect(sourceText(ydoc).toString()).toBe("# Hello");
  });
});
