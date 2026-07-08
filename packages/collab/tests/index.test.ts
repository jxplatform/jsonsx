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
});
