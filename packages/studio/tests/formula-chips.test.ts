/**
 * Tests for src/ui/formula-chips.ts — the chip-pipeline presentation layer: target-chain unrolling,
 * live value badges, parenthesized group chips, and click-to-path reporting.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { render } from "lit-html";
import { chipSummary, renderFormulaChips } from "../src/ui/formula-chips";
import type { EditorPreview } from "../src/ui/expression-editor";

function mount(node: unknown, opts: Record<string, unknown> = {}) {
  const picks: (string | number)[][] = [];
  const container = document.createElement("div");
  render(
    renderFormulaChips(node, (p) => picks.push(p), opts as never),
    container,
  );
  return { container, picks };
}

function chips(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll(".formula-chip")] as HTMLElement[];
}

function chipLabels(container: HTMLElement): string[] {
  return chips(container).map((c) => (c.querySelector("span") as HTMLElement).textContent!.trim());
}

const CHAIN_NODE = {
  operator: "+",
  target: {
    operator: "*",
    target: { $ref: "#/state/count" },
    value: 2,
  },
  value: 1,
};

describe("renderFormulaChips — chain unrolling", () => {
  test("unrolls the target chain deepest-first: head operand, then operators outward", () => {
    const { container } = mount(CHAIN_NODE);
    expect(chipLabels(container)).toEqual(["count", "*", "+"]);
    const paths = chips(container).map((c) => c.dataset.path);
    expect(paths).toEqual(["target/target", "target", ""]);
  });

  test("a base path prefixes every chip path", () => {
    const { container } = mount(CHAIN_NODE, { path: ["value"] });
    const paths = chips(container).map((c) => c.dataset.path);
    expect(paths).toEqual(["value/target/target", "value/target", "value"]);
  });

  test("literal and null head operands render as chips too", () => {
    const { container } = mount({ operator: "!", target: null });
    expect(chipLabels(container)).toEqual(["null", "!"]);
    const { container: c2 } = mount({ operator: "+", target: "hi", value: 1 });
    expect(chipLabels(c2)).toEqual(['"hi"', "+"]);
  });

  test("call chips show the callee ref as the head chip", () => {
    const { container } = mount({
      operator: "call",
      target: { $ref: "window#/Math/max" },
      value: [1, 2],
    });
    expect(chipLabels(container)).toEqual(["Math.max", "call"]);
  });

  test("non-node input renders nothing", () => {
    const { container } = mount(null);
    expect(chips(container).length).toBe(0);
    const { container: c2 } = mount("text");
    expect(chips(c2).length).toBe(0);
  });
});

describe("renderFormulaChips — badges", () => {
  test("shows live value badges from the preview keyed by chip path", () => {
    const preview: EditorPreview = {
      error: null,
      mutating: false,
      values: new Map([
        ["", "7"],
        ["target", "6"],
        ["target/target", "3"],
      ]),
    };
    const { container } = mount(CHAIN_NODE, { preview });
    const badgeByPath = new Map(
      chips(container).map((c) => [
        c.dataset.path,
        c.querySelector(".expr-live-badge")?.textContent ?? null,
      ]),
    );
    expect(badgeByPath.get("target/target")).toBe("3");
    expect(badgeByPath.get("target")).toBe("6");
    expect(badgeByPath.get("")).toBe("7");
  });

  test("renders no badges without a preview", () => {
    const { container } = mount(CHAIN_NODE);
    expect(container.querySelector(".expr-live-badge")).toBeNull();
  });
});

describe("renderFormulaChips — group chips", () => {
  test("nested non-target value operand renders a parenthesized group chip", () => {
    const { container } = mount({
      operator: "+",
      target: { $ref: "#/state/count" },
      value: { operator: "*", target: { $ref: "#/state/factor" }, value: 2 },
    });
    const group = container.querySelector(".formula-chip--group") as HTMLElement;
    expect(group).not.toBeNull();
    expect(group.dataset.path).toBe("value");
    expect(group.querySelector("span")!.textContent).toBe("(factor › *)");
    expect(chipLabels(container)).toEqual(["count", "+", "(factor › *)"]);
  });

  test("nested initial and switch case operands render group chips", () => {
    const { container } = mount({
      cases: { done: { operator: "!", target: { $ref: "#/state/busy" } } },
      default: null,
      operator: "switch",
      target: { $ref: "#/state/status" },
    });
    const group = container.querySelector(".formula-chip--group") as HTMLElement;
    expect(group.dataset.path).toBe("cases/done");

    const { container: c2 } = mount({
      initial: { operator: "-", target: { $ref: "#/state/n" } },
      operator: "?:",
      target: { $ref: "#/state/flag" },
      value: 1,
    });
    const group2 = c2.querySelector(".formula-chip--group") as HTMLElement;
    expect(group2.dataset.path).toBe("initial");
  });

  test("expression nodes inside an args array render indexed group chips", () => {
    const { container } = mount({
      operator: "call",
      target: { $ref: "#/state/lineTotal" },
      value: [{ operator: "+", target: 1, value: 2 }, 5],
    });
    const group = container.querySelector(".formula-chip--group") as HTMLElement;
    expect(group.dataset.path).toBe("value/0");
  });
});

describe("renderFormulaChips — selection", () => {
  test("clicking a chip reports its node path", () => {
    const { container, picks } = mount(CHAIN_NODE);
    const [head, mul, plus] = chips(container);
    head!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    mul!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    plus!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(picks).toEqual([["target", "target"], ["target"], []]);
  });
});

describe("chipSummary", () => {
  test("summarizes the chain left to right", () => {
    expect(chipSummary(CHAIN_NODE)).toBe("count › * › +");
    expect(chipSummary({ operator: "!", target: { $ref: "#/state/flag" } })).toBe("flag › !");
    expect(chipSummary({ operator: "call", target: { $ref: "window#/Math/max" }, value: [] })).toBe(
      "Math.max › call",
    );
  });

  test("non-node values summarize as operand labels", () => {
    expect(chipSummary({ $ref: "#/state/count" })).toBe("count");
    expect(chipSummary("hi")).toBe('"hi"');
    expect(chipSummary(5)).toBe("5");
    expect(chipSummary(null)).toBe("null");
  });
});
