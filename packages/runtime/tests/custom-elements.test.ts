import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  defineElement,
  renderNode as _renderNode,
  buildScope,
  RESERVED_KEYS,
  applyStyle,
  setRootMedia,
} from "../src/runtime";

try {
  GlobalRegistrator.register();
} catch {
  /* Already registered */
}

const renderNode: (...args: Parameters<typeof _renderNode>) => HTMLElement = _renderNode as any;

// Use unique tag names per test to avoid cross-test registration collisions
let uid = 0;
const uniqueTag = () => `ce-test-${(uid += 1)}`;

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
    await new Promise((r) => {
      setTimeout(r, 100);
    });

    const span = el.querySelector("span");
    expect(span).not.toBeNull();
    expect((span as HTMLElement).textContent).toBe("Hello");
    el.remove();
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
    await new Promise((r) => {
      setTimeout(r, 100);
    });

    expect((el.querySelector("span") as HTMLElement).textContent).toBe("overridden");
    el.remove();
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
    await new Promise((r) => {
      setTimeout(r, 200);
    });

    expect(el.querySelector("div")).not.toBeNull();
    expect((el as any).mountCalled).toBe(true);
    el.remove();
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
    await new Promise((r) => {
      setTimeout(r, 150);
    });

    const child = el.querySelector(tag);
    expect(child).not.toBeNull();
    expect(((child as HTMLElement).querySelector(".val") as HTMLElement).textContent).toBe("42");
    expect(((child as HTMLElement).querySelector(".name") as HTMLElement).textContent).toBe("test");
    el.remove();
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
    await new Promise((r) => {
      setTimeout(r, 100);
    });
    expect((el.querySelector("span") as HTMLElement).textContent).toBe("initial");

    // Set an observed attribute — should sync to state.myLabel
    el.setAttribute("my-label", "updated");
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    expect((el as any).myLabel).toBe("updated");

    el.remove();
  });
});

// ─── Phase 5: component @media via the buildScope-direct (iframe) path ────────────

describe("component @media (setRootMedia seeds the iframe path)", () => {
  test("equal-specificity cascade: base prop → stylesheet rule (not inline) + a real @media rule", () => {
    for (const s of document.head.querySelectorAll("style")) {
      s.remove();
    }
    const el = document.createElement("div");
    // A base prop that is ALSO overridden under @--md routes to a stylesheet baseDecls rule (NOT
    // Inline), so the @media rule can win at equal specificity — the whole Phase-5 premise.
    applyStyle(el, { "@--md": { color: "blue" }, color: "red" }, { "--md": "(min-width: 768px)" });
    expect(el.style.color).toBe(""); // No inline color.
    const jxUid = el.dataset.jx;
    const css = (document.head.querySelector(`style[data-jx-owner="${jxUid}"]`) as HTMLStyleElement)
      .textContent;
    expect(css).toContain(`[data-jx="${jxUid}"] { color: red }`);
    expect(css).toContain(`@media (min-width: 768px) { [data-jx="${jxUid}"] { color: blue } }`);
  });

  test("a component with its own @--md and no own $media resolves the real query after setRootMedia", async () => {
    for (const s of document.head.querySelectorAll("style")) {
      s.remove();
    }
    const tag = uniqueTag();
    // The component carries an @--md block but NO own $media — it must inherit the root map.
    await defineElement({
      state: {},
      style: { "@--md": { color: "blue" }, color: "red" },
      tagName: tag,
    });

    // The iframe path calls buildScope directly (never Jx()); seed the root media first.
    setRootMedia({ "--md": "(min-width: 768px)" });

    const el = document.createElement(tag);
    document.body.append(el);
    await new Promise((r) => {
      setTimeout(r, 100);
    });

    const jxUid = el.dataset.jx;
    const css = (document.head.querySelector(`style[data-jx-owner="${jxUid}"]`) as HTMLStyleElement)
      .textContent;
    // The named breakpoint resolved to its real query — NOT the invalid `@media --md`.
    expect(css).toContain("@media (min-width: 768px)");
    expect(css).not.toContain("@media --md");

    el.remove();
    setRootMedia({}); // Reset so the map can't leak into other tests.
  });
});
