import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { html, render } from "lit-html";
import { renderDynamicSlot, slotMode } from "../src/ui/dynamic-slot";

describe("slotMode", () => {
  test("detects each rung of the ladder", () => {
    expect(slotMode("plain")).toBe("literal");
    expect(slotMode(42)).toBe("literal");
    expect(slotMode(null)).toBe("literal");
    expect(slotMode({ $ref: "#/state/x" })).toBe("ref");
    expect(slotMode("${state.x} items")).toBe("template");
    expect(slotMode({ $expression: { operator: "!", target: null } })).toBe("expression");
  });
});

describe("renderDynamicSlot", () => {
  const staticWidget = html`<input class="static-widget" />`;

  test("literal mode renders the panel's static widget and only capped modes", () => {
    const container = document.createElement("div");
    render(
      renderDynamicSlot({
        caps: ["literal", "ref"],
        onChange: () => {},
        staticWidget,
        stateDefs: ["count"],
        value: "hello",
      }),
      container,
    );
    expect(container.querySelector(".static-widget")).not.toBeNull();
    const items = [...container.querySelectorAll("sp-menu-item")].map((i) =>
      i.getAttribute("value"),
    );
    expect(items).toEqual(["literal", "ref"]);
  });

  test("ref mode renders the signal picker with state options", () => {
    const container = document.createElement("div");
    render(
      renderDynamicSlot({
        caps: ["literal", "ref"],
        onChange: () => {},
        staticWidget,
        stateDefs: ["count", "title"],
        value: { $ref: "#/state/count" },
      }),
      container,
    );
    expect(container.querySelector(".static-widget")).toBeNull();
    const items = [...container.querySelectorAll("sp-menu-item")].map((i) =>
      i.getAttribute("value"),
    );
    expect(items).toContain("#/state/count");
    expect(items).toContain("#/state/title");
  });

  test("expression mode renders the expression editor", () => {
    const container = document.createElement("div");
    render(
      renderDynamicSlot({
        caps: ["literal", "ref", "expression"],
        onChange: () => {},
        staticWidget,
        stateDefs: ["count"],
        value: { $expression: { operator: "!", target: { $ref: "#/state/count" } } },
      }),
      container,
    );
    expect(container.querySelector(".expression-editor")).not.toBeNull();
  });

  test("template mode renders the raw template textfield", () => {
    const container = document.createElement("div");
    render(
      renderDynamicSlot({
        caps: ["literal", "ref", "template"],
        onChange: () => {},
        staticWidget,
        stateDefs: [],
        value: "${state.count}",
      }),
      container,
    );
    const tf = container.querySelector("sp-textfield");
    expect(tf).not.toBeNull();
  });
});
