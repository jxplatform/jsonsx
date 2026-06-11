import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* Already registered */
}

import {
  defineElement,
  renderNode as _renderNode,
  buildScope,
  RESERVED_KEYS,
} from "../src/runtime";

const renderNode: (...args: Parameters<typeof _renderNode>) => HTMLElement = _renderNode as any;

// Use unique tag names per test to avoid cross-test registration collisions
let uid = 0;
const uniqueTag = () => `ce-test-${++uid}`;

describe("Custom Elements", () => {
  test("RESERVED_KEYS includes $elements and observedAttributes", () => {
    expect(RESERVED_KEYS.has("$elements")).toBe(true);
    expect(RESERVED_KEYS.has("observedAttributes")).toBe(true);
  });

  test("defineElement registers a custom element", async () => {
    const tag = uniqueTag();
    await defineElement({
      children: [{ tagName: "span", textContent: "${state.greeting}" }],
      state: { greeting: "Hello" },
      tagName: tag,
    });

    expect(customElements.get(tag)).toBeDefined();

    const el = document.createElement(tag);
    document.body.append(el);
    await new Promise((r) => setTimeout(r, 100));

    const span = el.querySelector("span");
    expect(span).not.toBeNull();
    expect((span as HTMLElement).textContent).toBe("Hello");
    document.body.removeChild(el);
  });

  test("$props override state defaults", async () => {
    const tag = uniqueTag();
    await defineElement({
      children: [{ tagName: "span", textContent: "${state.label}" }],
      state: { label: "default" },
      tagName: tag,
    });

    const el = document.createElement(tag);
    (el as any).label = "overridden";
    document.body.append(el);
    await new Promise((r) => setTimeout(r, 100));

    expect((el.querySelector("span") as HTMLElement).textContent).toBe("overridden");
    document.body.removeChild(el);
  });

  test("lifecycle hooks (onMount)", async () => {
    const tag = uniqueTag();
    await defineElement({
      children: [{ tagName: "div", textContent: "lifecycle" }],
      state: {
        mountCalled: false,
        onMount: { $prototype: "Function", body: "state.mountCalled = true" },
      },
      tagName: tag,
    });

    const el = document.createElement(tag);
    document.body.append(el);
    await new Promise((r) => setTimeout(r, 200));

    expect(el.querySelector("div")).not.toBeNull();
    expect((el as any).mountCalled).toBe(true);
    document.body.removeChild(el);
  });

  test("throws for non-hyphenated tagName", async () => {
    try {
      await defineElement({ state: {}, tagName: "nohyphen" });
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toContain("must contain a hyphen");
    }
  });

  test("skips already-registered elements", async () => {
    const tag = uniqueTag();
    await defineElement({ children: [], state: { x: 1 }, tagName: tag });
    // Second call should not throw
    await defineElement({ children: [], state: { x: 2 }, tagName: tag });
    expect(customElements.get(tag)).toBeDefined();
  });

  test("renderNode creates custom element with $props via renderCustomElementWithProps", async () => {
    const tag = uniqueTag();
    await defineElement({
      children: [
        { className: "val", tagName: "span", textContent: "${state.value}" },
        { className: "name", tagName: "span", textContent: "${state.name}" },
      ],
      state: { name: "none", value: 0 },
      tagName: tag,
    });

    const parentDef = {
      children: [
        {
          $props: { name: "test", value: 42 },
          tagName: tag,
        },
      ],
      tagName: "div",
    };
    const scope = await buildScope({ state: {} });
    const el = renderNode(parentDef, scope);
    document.body.append(el);
    await new Promise((r) => setTimeout(r, 150));

    const child = el.querySelector(tag);
    expect(child).not.toBeNull();
    expect(((child as HTMLElement).querySelector(".val") as HTMLElement).textContent).toBe("42");
    expect(((child as HTMLElement).querySelector(".name") as HTMLElement).textContent).toBe("test");
    document.body.removeChild(el);
  });

  test("observed attributes sync to state", async () => {
    const tag = uniqueTag();
    await defineElement({
      children: [{ tagName: "span", textContent: "${state.myLabel}" }],
      observedAttributes: ["my-label"],
      state: { myLabel: "initial" },
      tagName: tag,
    });

    const el = document.createElement(tag);
    document.body.append(el);
    await new Promise((r) => setTimeout(r, 100));
    expect((el.querySelector("span") as HTMLElement).textContent).toBe("initial");

    // Set an observed attribute — should sync to state.myLabel
    el.setAttribute("my-label", "updated");
    await new Promise((r) => setTimeout(r, 50));
    expect((el as any).myLabel).toBe("updated");

    document.body.removeChild(el);
  });
});
