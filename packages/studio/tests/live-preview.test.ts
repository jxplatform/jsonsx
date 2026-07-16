/**
 * Live expression preview service (M6) — snapshot fallback when no iframe answers, the synchronous
 * call-site wrapper (immediate snapshot, retained live result on match, debounced refresh), and the
 * change-gated onUpdate that keeps re-render loops from self-sustaining. The canvas bridge is
 * mocked at the requestCanvasEval seam; the real round-trip is covered by iframe-host.test.ts and
 * the iframe side by iframe-entry/iframe-eval tests.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { flush, resetWorkspaceWithTab } from "./harness";
import { toRaw } from "../src/reactivity";

import type { EvalExprResult } from "../src/canvas/iframe-protocol";
import type { Tab } from "../src/tabs/tab";

// ─── Mock the canvas bridge seam ─────────────────────────────────────────────────

let evalCalls: { tabId: string | null; exprs: unknown; contextPath: unknown }[] = [];
let evalAnswer: EvalExprResult[] | null = null;

void mock.module("../src/canvas/iframe-host", () => ({
  requestCanvasEval: (
    tabId: string | null,
    exprs: { id: string; node: unknown }[],
    contextPath: (string | number)[] | null,
  ) => {
    evalCalls.push({ contextPath, exprs, tabId });
    return Promise.resolve(evalAnswer);
  },
}));

const { livePreviewExpression, requestLivePreview, LIVE_PREVIEW_DEBOUNCE_MS } =
  await import("../src/services/live-preview");

const EXPR = { operator: "+", target: 2, value: 3 };

/** Wait past the refresh debounce plus a microtask turn for the async store. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, LIVE_PREVIEW_DEBOUNCE_MS + 20);
  });
  await flush();
}

function freshTab(): Tab {
  const tab = resetWorkspaceWithTab() as Tab;
  tab.session.canvas.scope = { count: 40 };
  return tab;
}

beforeEach(() => {
  evalCalls = [];
  evalAnswer = null;
});

describe("requestLivePreview", () => {
  test("prefers the live result when the iframe answers", async () => {
    const tab = freshTab();
    evalAnswer = [{ id: "0", values: [["", "5"]] }];
    const preview = await requestLivePreview(tab, EXPR);
    expect(preview).not.toBeNull();
    expect(preview!.values.get("")).toBe("5");
    expect(preview!.error).toBeNull();
    expect(preview!.mutating).toBe(false);
    expect(evalCalls[0]).toMatchObject({ contextPath: null, tabId: tab.id });
  });

  test("falls back to the snapshot evaluation when no iframe answers", async () => {
    const tab = freshTab();
    evalAnswer = null; // No host / timeout / stale reply.
    const preview = await requestLivePreview(tab, {
      operator: "+",
      target: { $ref: "#/state/count" },
      value: 2,
    });
    // Snapshot evaluation against tab.session.canvas.scope produced the value.
    expect(preview!.values.get("")).toBe("42");
  });

  test("returns null for a non-expression node without touching the bridge", async () => {
    const tab = freshTab();
    expect(await requestLivePreview(tab, "${a}")).toBeNull();
    expect(await requestLivePreview(tab, null)).toBeNull();
    expect(evalCalls).toHaveLength(0);
  });

  test("carries a live evaluation error through", async () => {
    const tab = freshTab();
    evalAnswer = [{ error: "boom", id: "0", values: [] }];
    const preview = await requestLivePreview(tab, EXPR);
    expect(preview!.error).toBe("boom");
  });
});

describe("livePreviewExpression", () => {
  test("returns the snapshot immediately, then stores the live result and calls onUpdate", async () => {
    const tab = freshTab();
    evalAnswer = [{ id: "0", values: [["", "99"]] }];
    let updates = 0;

    const first = livePreviewExpression(tab, "def:x", EXPR, null, () => {
      updates += 1;
    });
    // Synchronous path: the snapshot evaluation (2 + 3) renders immediately.
    expect(first!.values.get("")).toBe("5");
    expect(updates).toBe(0);

    await settle();
    expect(updates).toBe(1);
    // Unwrap the reactive proxy before comparing (bun matchers don't see through Vue proxies).
    const stored = tab.session.canvas.livePreviews?.["def:x"];
    expect(toRaw(stored!.values)).toEqual([["", "99"]]);
    expect(stored?.error).toBeNull();

    // The next render returns the retained LIVE values for the same expression.
    const second = livePreviewExpression(tab, "def:x", EXPR, null, () => {
      updates += 1;
    });
    expect(second!.values.get("")).toBe("99");
  });

  test("an unchanged live refresh stores silently — no onUpdate, no re-render loop", async () => {
    const tab = freshTab();
    evalAnswer = [{ id: "0", values: [["", "99"]] }];
    let updates = 0;
    const onUpdate = () => {
      updates += 1;
    };

    livePreviewExpression(tab, "def:x", EXPR, null, onUpdate);
    await settle();
    expect(updates).toBe(1);

    // The re-render triggered by onUpdate calls again; the identical result must not re-fire.
    livePreviewExpression(tab, "def:x", EXPR, null, onUpdate);
    await settle();
    expect(updates).toBe(1);
  });

  test("a retained result for an OLD expression is skipped (snapshot until the refresh lands)", async () => {
    const tab = freshTab();
    evalAnswer = [{ id: "0", values: [["", "99"]] }];
    livePreviewExpression(tab, "def:x", EXPR, null);
    await settle();

    // The expression changed — the stored key no longer matches, so the snapshot renders.
    const changed = { operator: "+", target: 10, value: 10 };
    const preview = livePreviewExpression(tab, "def:x", changed, null);
    expect(preview!.values.get("")).toBe("20");
  });

  test("no iframe answer keeps the snapshot and never calls onUpdate", async () => {
    const tab = freshTab();
    evalAnswer = null;
    let updates = 0;
    const preview = livePreviewExpression(tab, "def:y", EXPR, null, () => {
      updates += 1;
    });
    expect(preview!.values.get("")).toBe("5");
    await settle();
    expect(updates).toBe(0);
    expect(tab.session.canvas.livePreviews?.["def:y"]).toBeUndefined();
  });

  test("debounces bursts — only the latest expression is fetched once", async () => {
    const tab = freshTab();
    evalAnswer = [{ id: "0", values: [["", "1"]] }];
    livePreviewExpression(tab, "def:x", EXPR, null);
    livePreviewExpression(tab, "def:x", { operator: "+", target: 1, value: 1 }, null);
    livePreviewExpression(tab, "def:x", { operator: "+", target: 1, value: 2 }, null);
    await settle();
    expect(evalCalls).toHaveLength(1);
    expect(evalCalls[0]!.exprs).toMatchObject([{ node: { operator: "+", target: 1, value: 2 } }]);
  });

  test("returns null for a missing tab or a non-expression node", () => {
    expect(livePreviewExpression(null, "t", EXPR)).toBeNull();
    expect(livePreviewExpression(freshTab(), "t", "${a}")).toBeNull();
  });
});
