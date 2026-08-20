import { describe, expect, test } from "bun:test";
import * as collab from "../src/index.ts";

describe("package barrel", () => {
  test("exposes the schema, bridge, diff, envelope, and awareness surface", () => {
    expect(typeof collab.seedStructure).toBe("function");
    expect(typeof collab.yDocToJson).toBe("function");
    expect(typeof collab.applyDocOpsToY).toBe("function");
    expect(typeof collab.yEventsToDocOps).toBe("function");
    expect(typeof collab.diffDocs).toBe("function");
    expect(typeof collab.replaceYStructure).toBe("function");
    expect(typeof collab.encodeFrame).toBe("function");
    expect(typeof collab.decodeFrame).toBe("function");
    expect(typeof collab.applyDocOpToDoc).toBe("function");
    expect(typeof collab.colorForKey).toBe("function");
    expect(collab.LOCAL_ORIGIN).toBe("jx-local");
    expect(collab.PRESENCE_PALETTE.length).toBeGreaterThan(0);
  });

  /**
   * The yjs re-exports, which are a CONTRACT rather than a convenience.
   *
   * Every consumer reaches yjs through this barrel so the whole app shares one instance — a second
   * one makes `instanceof` fail and, for the two position helpers below, makes every
   * `RelativePosition` a code-view cursor mints resolve to null against the document it came from.
   * The failure is a caret that silently stops moving, so it is worth a test that the entry points
   * exist at all.
   */
  test("re-exports the yjs surface consumers are required to use", () => {
    expect(typeof collab.YDoc).toBe("function");
    expect(typeof collab.UndoManager).toBe("function");
    expect(typeof collab.createRelativePositionFromTypeIndex).toBe("function");
    expect(typeof collab.createAbsolutePositionFromRelativePosition).toBe("function");
  });

  test("the position helpers round-trip an index through this instance", () => {
    const doc = new collab.YDoc();
    const text = collab.sourceText(doc);
    doc.transact(() => text.insert(0, "hello world"));
    const relative = collab.createRelativePositionFromTypeIndex(text, 6);
    doc.transact(() => text.insert(0, ">> "));
    const absolute = collab.createAbsolutePositionFromRelativePosition(relative, doc);
    // The position moved with the text it was anchored to, which is the whole point of it.
    expect(absolute?.index).toBe(9);
    expect(absolute?.type).toBe(text);
  });
});
