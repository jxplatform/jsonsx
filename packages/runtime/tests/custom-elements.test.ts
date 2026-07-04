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

  test("props.* attributes override state defaults and are stripped", async () => {
    const tag = uniqueTag();
    await defineElement({
      children: [{ tagName: "span", textContent: "${state.label}" }],
      state: { label: "default", other: "untouched" },
      tagName: tag,
    });

    const el = document.createElement(tag);
    el.setAttribute("props.label", "From attribute");
    el.setAttribute("props.unknown", "ignored");
    document.body.append(el);
    await new Promise((r) => {
      setTimeout(r, 100);
    });

    expect((el.querySelector("span") as HTMLElement).textContent).toBe("From attribute");
    // Lifted prop attributes don't leak into the DOM; unknown keys stay untouched
    expect(el.hasAttribute("props.label")).toBe(false);
    expect(el.hasAttribute("props.unknown")).toBe(true);
    expect((el as any).other).toBe("untouched");
    el.remove();
  });

  test("explicit $props JS property wins over a props.* attribute", async () => {
    const tag = uniqueTag();
    await defineElement({
      children: [{ tagName: "span", textContent: "${state.label}" }],
      state: { label: "default" },
      tagName: tag,
    });

    const el = document.createElement(tag);
    el.setAttribute("props.label", "attribute");
    (el as any).label = "js property";
    document.body.append(el);
    await new Promise((r) => {
      setTimeout(r, 100);
    });

    expect((el.querySelector("span") as HTMLElement).textContent).toBe("js property");
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

  test("data-jx-definition-root suppresses self-initialization (studio edits the definition)", async () => {
    const tag = uniqueTag();
    await defineElement({
      children: [{ tagName: "span", textContent: "${state.heading}" }],
      state: { heading: "Default Heading" },
      tagName: tag,
    });

    // An external renderer (the studio canvas) built the definition's tree itself and marked the
    // Root; connectedCallback must NOT wipe it and re-render a live instance with default state.
    const el = document.createElement(tag);
    el.dataset.jxDefinitionRoot = "";
    const authored = document.createElement("h2");
    authored.dataset.jxPath = '["children",0]';
    authored.textContent = "Authored Tree";
    el.append(authored);
    document.body.append(el);
    await new Promise((r) => {
      setTimeout(r, 100);
    });

    expect(el.children).toHaveLength(1);
    expect(el.firstElementChild).toBe(authored);
    expect(el.textContent).toBe("Authored Tree");

    // A SIBLING instance without the marker still self-initializes normally.
    const instance = document.createElement(tag);
    document.body.append(instance);
    await new Promise((r) => {
      setTimeout(r, 100);
    });
    expect(instance.textContent).toBe("Default Heading");

    el.remove();
    instance.remove();
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
