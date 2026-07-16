import { describe, expect, test } from "bun:test";
import { CANVAS_MODES, isCanvasMode } from "../src/canvas/iframe-protocol";
import type {
  ApplyFormatIntent,
  EvalExprResult,
  IframeToParent,
  InsertZone,
  InsertZonesMsg,
  ParentToIframe,
  SelectionSnapshot,
} from "../src/canvas/iframe-protocol";

describe("isCanvasMode", () => {
  test("accepts every declared canvas mode", () => {
    for (const mode of CANVAS_MODES) {
      expect(isCanvasMode(mode)).toBe(true);
    }
  });

  test("rejects unknown strings and non-strings", () => {
    expect(isCanvasMode("live")).toBe(false);
    expect(isCanvasMode("")).toBe(false);
    expect(isCanvasMode(null)).toBe(false);
    expect(isCanvasMode(3)).toBe(false);
    expect(isCanvasMode({})).toBe(false);
  });
});

describe("4b-2 format-toolbar messages", () => {
  test("selectionChanged carries the serializable snapshot shape", () => {
    const snap: SelectionSnapshot = {
      activeTags: ["strong", "em"],
      collapsed: false,
      kind: "selectionChanged",
      link: { active: false, href: null },
      localScope: null,
      path: ["children", 0],
      rect: { height: 12, width: 30, x: 4, y: 8 },
      seq: 3,
    };
    // It is a member of the iframe→parent union.
    const asUnion: IframeToParent = snap;
    expect(asUnion.kind).toBe("selectionChanged");
    expect(snap.localScope).toBeNull();
    expect(snap.activeTags).toEqual(["strong", "em"]);
    expect(snap.rect).toEqual({ height: 12, width: 30, x: 4, y: 8 });

    // A collapsed caret carries a null-href link and may carry a null rect.
    const collapsed: SelectionSnapshot = {
      activeTags: [],
      collapsed: true,
      kind: "selectionChanged",
      link: { active: true, href: "https://example.com" },
      localScope: null,
      path: [],
      rect: null,
      seq: 1,
    };
    expect(collapsed.collapsed).toBe(true);
    expect(collapsed.rect).toBeNull();
    expect(collapsed.link).toEqual({ active: true, href: "https://example.com" });
  });

  test("insertZones carries the InsertZone shape and is a member of the iframe→parent union", () => {
    const zone: InsertZone = {
      edge: "top",
      index: 1,
      insertParentPath: ["children", 0],
      rect: { height: 0, width: 120, x: 10, y: 40 },
    };
    const msg: InsertZonesMsg = { kind: "insertZones", zones: [zone] };
    const asUnion: IframeToParent = msg;
    expect(asUnion.kind).toBe("insertZones");
    expect(msg.zones?.[0]).toEqual(zone);

    // A null zone set (cursor mid-element / off-canvas) clears the parent "+".
    const cleared: InsertZonesMsg = { kind: "insertZones", zones: null };
    expect(cleared.zones).toBeNull();

    // A center zone (empty container) inserts as the container's first child.
    const center: InsertZone = {
      edge: "center",
      index: 0,
      insertParentPath: ["children", 2],
      rect: { height: 80, width: 200, x: 0, y: 0 },
    };
    expect(center.edge).toBe("center");
    expect(center.index).toBe(0);
  });

  test("applyFormat carries the three intent variants", () => {
    const bold: ApplyFormatIntent = { command: "bold" };
    const link: ApplyFormatIntent = { command: "link", href: "https://x" };
    const removeLink: ApplyFormatIntent = { command: "link", href: null };
    const insert: ApplyFormatIntent = { command: "insertData", token: "state.title" };

    const msg: ParentToIframe = { intent: bold, kind: "applyFormat" };
    expect(msg.kind).toBe("applyFormat");
    expect(bold.command).toBe("bold");
    expect(link).toEqual({ command: "link", href: "https://x" });
    expect(removeLink.href).toBeNull();
    expect(insert).toEqual({ command: "insertData", token: "state.title" });
  });
});

describe("M6 live expression-preview messages", () => {
  test("evalExpr carries id-keyed expression nodes, a nullable contextPath, reqId and gen", () => {
    const msg: ParentToIframe = {
      contextPath: ["children", 0, "map"],
      exprs: [
        { id: "sum", node: { operator: "+", target: { $ref: "#/state/a" }, value: 2 } },
        { id: "flag", node: { operator: "!", target: true } },
      ],
      gen: 4,
      kind: "evalExpr",
      reqId: 12,
    };
    expect(msg.kind).toBe("evalExpr");
    expect(msg.exprs).toHaveLength(2);
    expect(msg.exprs[0]!.id).toBe("sum");
    // Root-scope evaluation passes a null context.
    const rootScoped: ParentToIframe = { ...msg, contextPath: null };
    expect(rootScoped.contextPath).toBeNull();
  });

  test("evalResult echoes reqId + gen and carries display-string pairs (postMessage-safe)", () => {
    const result: EvalExprResult = {
      id: "sum",
      values: [
        ["", "42"],
        ["target", "40"],
        ["value", "2"],
      ],
    };
    const failed: EvalExprResult = { error: "unknown operator", id: "bad", values: [] };
    const msg: IframeToParent = {
      gen: 4,
      kind: "evalResult",
      reqId: 12,
      results: [result, failed],
    };
    expect(msg.kind).toBe("evalResult");
    expect(msg.reqId).toBe(12);
    expect(msg.gen).toBe(4);
    // Every value is a [pathKey, displayString] pair — plain strings cross the boundary.
    for (const [path, display] of result.values) {
      expect(typeof path).toBe("string");
      expect(typeof display).toBe("string");
    }
    expect(failed.error).toBe("unknown operator");
    // An empty results set is the stale-gen refusal shape.
    const refused: IframeToParent = { gen: 3, kind: "evalResult", reqId: 11, results: [] };
    expect(refused.results).toEqual([]);
  });
});
