import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { reactive } from "@vue/reactivity";

import {
  defineElement,
  renderNode as _renderNode,
  buildScope,
  RESERVED_KEYS,
  applyStyle,
  setRootMedia,
  setStampPropBindings,
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

  /*
   * A definition's content can be root-level `textContent` rather than `children` — the shape
   * spec.md §17.2 recommends when every child would be a bare string. The interpreter looked at
   * `children` alone, so such a component upgraded to an empty element.
   */
  test("renders root-level textContent when the definition has no children", async () => {
    const tag = uniqueTag();
    await defineElement({
      state: { text: "Label" },
      tagName: tag,
      textContent: "${state.text}",
    });

    const el = document.createElement(tag);
    document.body.append(el);
    await new Promise((r) => {
      setTimeout(r, 100);
    });

    expect(el.textContent).toBe("Label");
    el.remove();
  });

  /*
   * The static build emits markup text, so the HTML parser applied foreign-content rules and SVG
   * worked there. The runtime built every node with createElement, which is HTML-only, so the same
   * document rendered blank in the Studio canvas — the editor wrong and the deployed site right.
   */
  test("renders svg children in the SVG namespace, class included", () => {
    const el = renderNode(
      {
        children: [
          {
            attributes: { viewBox: "0 0 32 32" },
            children: [{ className: "plate", tagName: "rect" }],
            tagName: "svg",
          },
        ],
        tagName: "div",
      },
      reactive({}) as never,
    );

    const svg = el.querySelector("svg") as Element;
    const rect = el.querySelector("rect") as Element;
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    // The namespace is inherited by descendants, not re-derived per tag.
    expect(rect.namespaceURI).toBe("http://www.w3.org/2000/svg");
    // `className` is a read-only SVGAnimatedString, so the property write would have thrown.
    expect(rect.getAttribute("class")).toBe("plate");
  });

  test("foreignObject returns its descendants to HTML", () => {
    const el = renderNode(
      {
        children: [
          {
            children: [{ children: [{ tagName: "p" }], tagName: "foreignObject" }],
            tagName: "svg",
          },
        ],
        tagName: "div",
      },
      reactive({}) as never,
    );

    expect((el.querySelector("foreignObject") as Element).namespaceURI).toBe(
      "http://www.w3.org/2000/svg",
    );
    expect((el.querySelector("p") as Element).namespaceURI).toBe("http://www.w3.org/1999/xhtml");
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

  test("instance $props are carried onto a not-yet-registered custom element", () => {
    // Regression for the Studio desktop-canvas bug: a component instance can render BEFORE its async
    // DefineElement finishes. renderNode must carry the instance's $props onto the bare tag as JS
    // Properties so the eventual upgrade's connectedCallback consumes them (the def.state merge in
    // ConnectedCallback reads instance props off `this`). The old code stripped $props here, so a
    // Late upgrade painted the component's state DEFAULTS instead — every instance showed the same
    // "0"/"DESCRIPTION". Asserting the JS property is browser-agnostic; the upgrade half (a JS
    // Property winning over a state default) is covered by "$props override state defaults" above.
    // (happy-dom does not upgrade an already-created element on a later define, so the full late
    // Upgrade cannot be exercised here — but a real Chromium browser does.)
    const tag = uniqueTag();
    const el = renderNode(
      { $props: { label: "instance-value", value: 42 }, tagName: tag },
      reactive({}),
    );
    // Still unregistered — yet the fix has already set the instance props as JS properties, ready
    // For whenever the upgrade lands, instead of discarding them.
    expect(customElements.get(tag)).toBeUndefined();
    expect((el as unknown as { label: string }).label).toBe("instance-value");
    expect((el as unknown as { value: number }).value).toBe(42);
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

describe("prop-binding markers (setStampPropBindings)", () => {
  // Module-level flag leaks across tests otherwise.
  afterEach(() => {
    setStampPropBindings(false);
  });

  test("stamps data-jx-bound-prop on a pure ${state.key} textContent binding", () => {
    setStampPropBindings(true);
    const el = renderNode(
      { tagName: "h3", textContent: "${state.title}" },
      reactive({ title: "Local" }),
    );
    expect(el.dataset.jxBoundProp).toBe("title");
    expect(el.textContent).toBe("Local");
  });

  test("stamps a single-segment #/state/key $ref textContent binding", () => {
    setStampPropBindings(true);
    const el = renderNode(
      { tagName: "p", textContent: { $ref: "#/state/description" } },
      reactive({ description: "Body" }),
    );
    expect(el.dataset.jxBoundProp).toBe("description");
    expect(el.textContent).toBe("Body");
  });

  test("does not stamp when the flag is off (the default)", () => {
    const el = renderNode(
      { tagName: "h3", textContent: "${state.title}" },
      reactive({ title: "x" }),
    );
    expect(el.dataset.jxBoundProp).toBeUndefined();
  });

  test("does not stamp mixed or multi-key templates", () => {
    setStampPropBindings(true);
    const state = reactive({ a: "1", b: "2", t: "x" });
    for (const textContent of ["Hi ${state.t}", "${state.a}${state.b}", "$${state.a}"]) {
      const el = renderNode({ tagName: "p", textContent }, state);
      expect(el.dataset.jxBoundProp).toBeUndefined();
    }
  });

  test("does not stamp non-state or deep bindings", () => {
    setStampPropBindings(true);
    const state = reactive({ a: { b: "deep" } });
    expect(
      renderNode({ tagName: "p", textContent: "${window.name}" }, state).dataset.jxBoundProp,
    ).toBeUndefined();
    expect(
      renderNode({ tagName: "p", textContent: "${state.a.b}" }, state).dataset.jxBoundProp,
    ).toBeUndefined();
    expect(
      renderNode({ tagName: "p", textContent: { $ref: "#/state/a/b" } }, state).dataset.jxBoundProp,
    ).toBeUndefined();
    expect(
      renderNode({ tagName: "p", textContent: { $ref: "#/$defs/x" } }, state).dataset.jxBoundProp,
    ).toBeUndefined();
  });

  test("does not stamp template bindings on keys other than textContent", () => {
    setStampPropBindings(true);
    const el = renderNode({ tagName: "p", title: "${state.t}" }, reactive({ t: "tip" }));
    expect(el.dataset.jxBoundProp).toBeUndefined();
  });

  test("does not stamp bindings to computed, function, or object state entries", async () => {
    setStampPropBindings(true);
    // BuildScope turns a template-string state entry into a computed ref — not a writable prop.
    const scope = await buildScope({
      state: {
        first: "Ada",
        fullName: "${state.first} L.",
        onPick: { $prototype: "Function", body: "return 1" },
        profile: { city: "x" },
      },
    });
    expect(
      renderNode({ tagName: "h4", textContent: "${state.fullName}" }, scope).dataset.jxBoundProp,
    ).toBeUndefined();
    expect(
      renderNode({ tagName: "p", textContent: { $ref: "#/state/fullName" } }, scope).dataset
        .jxBoundProp,
    ).toBeUndefined();
    expect(
      renderNode({ tagName: "p", textContent: "${state.onPick}" }, scope).dataset.jxBoundProp,
    ).toBeUndefined();
    expect(
      renderNode({ tagName: "p", textContent: "${state.profile}" }, scope).dataset.jxBoundProp,
    ).toBeUndefined();
    // The plain data entry on the SAME scope stays stampable.
    expect(
      renderNode({ tagName: "p", textContent: "${state.first}" }, scope).dataset.jxBoundProp,
    ).toBe("first");
  });

  test("stamps component internals rendered by connectedCallback", async () => {
    setStampPropBindings(true);
    const tag = uniqueTag();
    await defineElement({
      children: [{ tagName: "h3", textContent: "${state.title}" }],
      state: { title: "default" },
      tagName: tag,
    });

    const el = document.createElement(tag);
    (el as any).title = "Stamped";
    document.body.append(el);
    await new Promise((r) => {
      setTimeout(r, 100);
    });

    const h3 = el.querySelector("h3") as HTMLElement;
    expect(h3.dataset.jxBoundProp).toBe("title");
    expect(h3.textContent).toBe("Stamped");
    el.remove();
  });
});

/**
 * A state key that collides with a REFLECTED DOM property.
 *
 * `connectedCallback` merges instance values with `key in this && this[key] !== undefined`. For a
 * reflected name — `title`, `role`, `id`, `lang`, `dir`, `slot`, `hidden` — the accessor exists on
 * the prototype and answers `""` when nothing is set, and `"" !== undefined`, so the empty string
 * won and the component's own default never rendered. A plain key beside it kept its default, which
 * is what made this look like broken content rather than a runtime bug. 41 shipped starter
 * components declare `title` or `role` as state.
 */
describe("a reflected property name does not clobber the declared default", () => {
  /** Render one instance of a definition declaring a reflected key and a plain one. */
  async function render(instance: Record<string, unknown>) {
    const tag = uniqueTag();
    await defineElement({
      children: [
        { tagName: "h3", textContent: "${state.title}" },
        { tagName: "p", textContent: "${state.quote}" },
      ],
      state: { quote: "DEFAULT QUOTE", title: "DEFAULT TITLE" },
      tagName: tag,
    } as never);
    const el = renderNode({ tagName: tag, ...instance }, {}, {});
    document.body.append(el);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    return {
      quote: el.querySelector("p")?.textContent,
      title: el.querySelector("h3")?.textContent,
    };
  }

  test("with nothing supplied, BOTH defaults render", async () => {
    // The regression, stated once: `title` rendered "" while `quote` rendered its default.
    expect(await render({})).toEqual({ quote: "DEFAULT QUOTE", title: "DEFAULT TITLE" });
  });

  test("$props on a reflected name still wins", async () => {
    /* The trap in the fix. Assigning a reflected name goes through the prototype accessor and
       creates NO own property, so an `Object.hasOwn` test would discard this silently — for every
       component that declares one. The accessor writes the attribute, and that is the evidence. */
    const r = await render({ $props: { title: "FROM PROPS" } });
    expect(r.title).toBe("FROM PROPS");
  });

  test("an explicitly EMPTY $props value is honoured, not replaced by the default", async () => {
    // "" is a value an author may mean. It must not be read as "nothing was supplied".
    const rendered = await render({ $props: { title: "" } });
    expect(rendered.title).toBe("");
  });

  test("$props on a plain name still wins", async () => {
    const rendered = await render({ $props: { quote: "FROM PROPS" } });
    expect(rendered.quote).toBe("FROM PROPS");
  });

  test("a literal attribute of the same name still wins", async () => {
    // Unchanged behaviour: the attribute is how a reflected value arrives, so it still supplies.
    const rendered = await render({ attributes: { title: "FROM ATTR" } });
    expect(rendered.title).toBe("FROM ATTR");
  });

  test("a props.* attribute still wins", async () => {
    const r = await render({ attributes: { "props.title": "FROM PROPS-ATTR" } });
    expect(r.title).toBe("FROM PROPS-ATTR");
  });
});
