import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import {
  setCanvasDelinkAnchors,
  setCanvasViewportTranspose,
  setStampPropBindings,
} from "@jxsuite/runtime";
import {
  applyPreviewColorScheme,
  applySiteStyle,
  EDIT_PLACEHOLDER_CSS,
  EDIT_PLACEHOLDER_STYLE_ID,
  injectHead,
  installCanvasImageRetry,
  makeStamper,
  registerElements,
  renderResolvedDocument,
  STYLEBOOK_STYLE_ID,
  syncEditableRoot,
  syncEditModeCss,
  syncStylebookCss,
} from "../src/canvas/iframe-render";
import type { PathMapCtx } from "../src/canvas/path-mapping";

const ctx: PathMapCtx = {
  arrayPaths: new Set(),
  canvasMode: "design",
  layoutWrapped: false,
  pageContentOffset: null,
  pageContentPrefix: null,
};

describe("syncEditableRoot accessibility", () => {
  test("the editable region announces as a multiline textbox, and drops it when not editable", () => {
    const container = document.createElement("div");
    syncEditableRoot(container, "edit" as never);
    // A bare contenteditable div announces as an unlabelled group; the one surface an author types
    // Into was the least described thing in the editor.
    expect(container.getAttribute("role")).toBe("textbox");
    expect(container.getAttribute("aria-multiline")).toBe("true");
    expect(container.getAttribute("aria-label")).toBeTruthy();
    expect(container.getAttribute("contenteditable")).toBe("true");

    syncEditableRoot(container, "preview" as never);
    expect(container.getAttribute("role")).toBeNull();
    expect(container.getAttribute("aria-multiline")).toBeNull();
    expect(container.getAttribute("aria-label")).toBeNull();
    expect(container.getAttribute("contenteditable")).toBeNull();
  });
});

describe("renderResolvedDocument", () => {
  test("renders a resolved doc into the container and stamps data-jx-path", async () => {
    const container = document.createElement("div");
    const doc = {
      children: [
        { children: ["hi"], tagName: "p" },
        { attributes: { src: "/images/x.jpg" }, tagName: "img" },
      ],
      tagName: "div",
    };
    const handle = await renderResolvedDocument({
      container,
      doc: doc as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "design",
    });

    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe("DIV");
    expect(root.dataset.jxPath).toBe("[]");

    const p = root.querySelector("p") as HTMLElement;
    expect(p.textContent).toBe("hi");
    expect(p.dataset.jxPath).toBe('["children",0]');

    const img = root.querySelector("img") as HTMLElement;
    // The asset src is left verbatim — it resolves natively against the iframe's real origin
    // (no data: URL rewriting), which is the bug this migration fixes.
    expect(img.getAttribute("src")).toBe("/images/x.jpg");
    expect(img.dataset.jxPath).toBe('["children",1]');

    handle.dispose();
  });

  test("replaces previous content on re-render", async () => {
    const container = document.createElement("div");
    await renderResolvedDocument({
      container,
      doc: { children: ["one"], tagName: "section" } as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "design",
    });
    expect(container.querySelector("section")?.textContent).toBe("one");

    await renderResolvedDocument({
      container,
      doc: { children: ["two"], tagName: "article" } as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "preview",
    });
    expect(container.querySelector("section")).toBeNull();
    expect(container.querySelector("article")?.textContent).toBe("two");
  });

  test("dispose() actually stops the render's reactive effects", async () => {
    // The runtime's renderNode creates its effects with the RUNTIME's copy of @vue/reactivity, and
    // Scope collection is per module instance — a studio-instance effectScope wrap around renderNode
    // Collects NOTHING, so dispose() would silently leak every binding effect of the superseded
    // Render (they keep re-running against detached DOM and pin it in memory).
    const container = document.createElement("div");
    const doc = {
      children: [{ children: ["${state.msg}"], tagName: "p" }],
      state: { msg: "one" },
      tagName: "div",
    };
    const handle = await renderResolvedDocument({
      container,
      doc: doc as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "preview",
    });
    const p = container.querySelector("p") as HTMLElement;
    expect(p.textContent).toBe("one");

    // Sanity: the binding is live before dispose (the effect tracks the reactive $defs).
    const defs = handle.ctx.defs as Record<string, unknown>;
    defs.msg = "two";
    expect(p.textContent).toBe("two");

    // After dispose the effect must be dead: further state changes leave the DOM untouched.
    handle.dispose();
    defs.msg = "three";
    expect(p.textContent).toBe("two");
  });
});

describe("component registration ordering (props applied)", () => {
  // The runtime only applies a custom element's `$props` when the element is ALREADY defined
  // (renderNode gates renderCustomElementWithProps on a truthy customElements.get). So the doc's
  // `$elements` MUST be registered BEFORE renderNode. With the old fire-and-forget ordering the
  // Component upgraded in place to its empty default and the prop was dropped. These tests prove the
  // Fix by observing that the prop reached the DOM.
  let uid = 0;
  const uniqueTag = () => `eer-order-${(uid += 1)}`;

  test("a $props-fed custom element renders WITH its prop applied (registered before renderNode)", async () => {
    const tag = uniqueTag();
    // Component whose child <img> src is driven purely by a state value fed via $props. The default
    // Is "" — the exact empty-render regression symptom — so a real src proves the prop was applied.
    const doc = {
      $elements: [
        {
          children: [{ attributes: { class: "thumb", src: "${state.imgSrc}" }, tagName: "img" }],
          state: { imgSrc: "" },
          tagName: tag,
        },
      ],
      children: [{ $props: { imgSrc: "/images/real.jpg" }, tagName: tag }],
      tagName: "div",
    };

    const container = document.createElement("div");
    // Attach the container so the custom element's async connectedCallback fires on replaceChildren.
    document.body.append(container);
    const handle = await renderResolvedDocument({
      container,
      doc: doc as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "design",
    });
    // The async connectedCallback renders the component's light DOM on a later microtask/timer.
    await new Promise((r) => {
      setTimeout(r, 150);
    });

    const host = container.querySelector(tag) as HTMLElement;
    expect(host).not.toBeNull();
    const img = host.querySelector("img.thumb") as HTMLImageElement;
    expect(img).not.toBeNull();
    // The prop reached the component's state and drove the child src — NOT the empty "" default.
    expect(img.getAttribute("src")).toBe("/images/real.jpg");

    handle.dispose();
    container.remove();
  });

  test("registerElements resolves before renderNode produces the element", async () => {
    const tag = uniqueTag();
    // A component that has no template but records whether its tag was defined at render time. We
    // Prove ordering directly: renderResolvedDocument must have registered the tag by the time it
    // Returns (which only happens if registration is awaited before renderNode), so the custom
    // Element is defined and its host node — not an inert unknown element — is in the container.
    const doc = {
      $elements: [{ children: [{ tagName: "span" }], state: {}, tagName: tag }],
      children: [{ tagName: tag }],
      tagName: "div",
    };
    // Not yet defined before the render call.
    expect(customElements.get(tag)).toBeUndefined();

    const container = document.createElement("div");
    document.body.append(container);
    const handle = await renderResolvedDocument({
      container,
      doc: doc as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "design",
    });

    // Awaiting the render means registration already completed — the tag is now defined.
    expect(customElements.get(tag)).toBeDefined();
    expect(container.querySelector(tag)).not.toBeNull();

    handle.dispose();
    container.remove();
  });
});

describe("canvas transpose + anchor de-link flags", () => {
  // CRITICAL: `setCanvasViewportTranspose` / `setCanvasDelinkAnchors` are GLOBAL module-level runtime
  // Flags. Reset BOTH to false after every test so they cannot leak into other studio tests.
  afterEach(() => {
    setCanvasViewportTranspose(false);
    setCanvasDelinkAnchors(false);
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  test("applySiteStyle transposes viewport units to container units", () => {
    setCanvasViewportTranspose(true);
    applySiteStyle({ "--hero-h": "50vw", minHeight: "100vh" });
    const css = document.head.querySelector("#jx-site-style")!.textContent!;
    // Plain property goes in the body rule, with vh → cqh.
    expect(css).toContain("body { min-height: 100cqh }");
    // `--`-prefixed var goes in the :root rule, with vw → cqw.
    expect(css).toContain(":root { --hero-h: 50cqw }");
  });

  test("applySiteStyle leaves viewport units untouched when the flag is off", () => {
    // Flag defaults to false here (reset in afterEach); no transpose should happen.
    applySiteStyle({ minHeight: "100vh" });
    const css = document.head.querySelector("#jx-site-style")!.textContent!;
    expect(css).toContain("body { min-height: 100vh }");
  });

  test("renderResolvedDocument de-links <a href> in edit mode but keeps it live in preview", async () => {
    const anchorDoc = {
      children: [{ attributes: { href: "/x" }, children: ["go"], tagName: "a" }],
      tagName: "div",
    };

    const editContainer = document.createElement("div");
    const editHandle = await renderResolvedDocument({
      container: editContainer,
      doc: anchorDoc as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "edit",
    });
    const editAnchor = editContainer.querySelector("a") as HTMLElement;
    // Design/edit: the target is stamped on `data-jx-href`, leaving the anchor inert (no real href).
    expect(editAnchor.getAttribute("href")).toBeNull();
    expect(editAnchor.dataset.jxHref).toBe("/x");
    editHandle.dispose();

    const previewContainer = document.createElement("div");
    const previewHandle = await renderResolvedDocument({
      container: previewContainer,
      doc: anchorDoc as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "preview",
    });
    const previewAnchor = previewContainer.querySelector("a") as HTMLElement;
    // Preview keeps a real, live link (no de-linking).
    expect(previewAnchor.getAttribute("href")).toBe("/x");
    expect(previewAnchor.dataset.jxHref).toBeUndefined();
    previewHandle.dispose();
  });
});

describe("prop-binding markers (inline prop editing)", () => {
  // `setStampPropBindings` is a GLOBAL module-level runtime flag (same discipline as the transpose/
  // De-link flags above): reset after every test so it cannot leak into other studio tests.
  afterEach(() => {
    setStampPropBindings(false);
  });

  let uid = 0;
  const uniqueTag = () => `eer-propmark-${(uid += 1)}`;

  const instanceDoc = (tag: string) => ({
    $elements: [
      {
        children: [{ tagName: "h3", textContent: "${state.title}" }],
        state: { title: "" },
        tagName: tag,
      },
    ],
    children: [{ $props: { title: "Local" }, tagName: tag }],
    tagName: "div",
  });

  test("the edit-mode canvas CSS carries the prop-bound hover/empty affordances", () => {
    expect(EDIT_PLACEHOLDER_CSS).toContain("[data-jx-bound-prop]:hover");
    expect(EDIT_PLACEHOLDER_CSS).toContain("[data-jx-bound-prop]:empty");
  });

  test("a design-mode render stamps component internals with data-jx-bound-prop", async () => {
    const tag = uniqueTag();
    const container = document.createElement("div");
    document.body.append(container);
    const handle = await renderResolvedDocument({
      container,
      doc: instanceDoc(tag) as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "design",
    });
    // The custom element's async connectedCallback renders its light DOM on a later timer.
    await new Promise((r) => {
      setTimeout(r, 150);
    });

    const h3 = container.querySelector(`${tag} h3`) as HTMLElement;
    expect(h3).not.toBeNull();
    expect(h3.dataset.jxBoundProp).toBe("title");
    expect(h3.textContent).toBe("Local");
    // Internals stay path-less — the marker is the ONLY studio annotation inside the instance.
    expect(h3.dataset.jxPath).toBeUndefined();

    handle.dispose();
    container.remove();
  });

  test("a preview render leaves component internals unstamped", async () => {
    const tag = uniqueTag();
    const container = document.createElement("div");
    document.body.append(container);
    const handle = await renderResolvedDocument({
      container,
      doc: instanceDoc(tag) as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: ctx,
      mode: "preview",
    });
    await new Promise((r) => {
      setTimeout(r, 150);
    });

    const h3 = container.querySelector(`${tag} h3`) as HTMLElement;
    expect(h3).not.toBeNull();
    expect(h3.dataset.jxBoundProp).toBeUndefined();

    handle.dispose();
    container.remove();
  });
});

describe("makeStamper", () => {
  test("ignores non-element nodes", () => {
    const stamp = makeStamper(ctx);
    const text = document.createTextNode("x");
    expect(() => stamp(text, ["children", 0], "x")).not.toThrow();
  });

  test("stamps a layout node's ORIGIN (file + path in the layout) and no page path", () => {
    const stamp = makeStamper({ ...ctx, layoutWrapped: true });
    const el = document.createElement("div");
    stamp(el, ["children", 0], {
      $__layout: { file: "layouts/base.json", path: ["children", 0, "children", 1] },
    });
    expect(el.dataset.jxLayoutFile).toBe("layouts/base.json");
    expect(el.dataset.jxLayoutPath).toBe('["children",0,"children",1]');
    expect(el.dataset.jxPath).toBeUndefined();
  });

  test("layout CHROME is marked as a region and frozen so no caret can land in it", () => {
    // The bug this closes: the canvas root is permanently contenteditable, so a click on the site
    // Header put a caret there and every keystroke was then silently rejected downstream.
    const stamp = makeStamper({ ...ctx, canvasMode: "edit", layoutWrapped: true });
    const el = document.createElement("header");
    stamp(el, ["children", 0], { $__layout: { file: "layouts/base.json", path: [] } });
    expect(el.dataset.jxLayoutRegion).toBe("");
    expect(el.getAttribute("contenteditable")).toBe("false");
  });

  test("a layout node that WRAPS the page content is neither dimmed nor frozen", () => {
    const stamp = makeStamper({
      ...ctx,
      canvasMode: "edit",
      layoutWrapped: true,
      pageContentPrefix: ["children", 1, "children"],
    });
    const main = document.createElement("main");
    stamp(main, ["children", 1], { $__layout: { file: "layouts/base.json", path: [] } });
    expect(main.dataset.jxLayoutPath).toBe("[]");
    expect(main.dataset.jxLayoutRegion).toBeUndefined();
    expect(main.getAttribute("contenteditable")).toBeNull();
  });

  test("preview leaves layout chrome editable-agnostic (nothing is an editing host there)", () => {
    const stamp = makeStamper({ ...ctx, canvasMode: "preview", layoutWrapped: true });
    const el = document.createElement("footer");
    stamp(el, ["children", 2], { $__layout: { file: "layouts/base.json", path: [] } });
    expect(el.dataset.jxLayoutRegion).toBe("");
    expect(el.getAttribute("contenteditable")).toBeNull();
  });

  test("a legacy boolean marker stamps the region but names no file", () => {
    const stamp = makeStamper({ ...ctx, layoutWrapped: true });
    const el = document.createElement("div");
    stamp(el, ["children", 0], { $__layout: true });
    expect(el.dataset.jxLayoutPath).toBe("[]");
    expect(el.dataset.jxLayoutFile).toBeUndefined();
  });

  test("stamps data-jx-path on ordinary nodes", () => {
    const stamp = makeStamper(ctx);
    const el = document.createElement("div");
    stamp(el, ["children", 2], { tagName: "div" });
    expect(el.dataset.jxPath).toBe('["children",2]');
  });

  test("marks a component-definition ROOT with data-jx-definition-root; plain roots and nested custom tags stay unmarked", () => {
    const stamp = makeStamper(ctx);
    // The opened doc IS a component definition — its root must not self-instantiate.
    const defRoot = document.createElement("eer-cta");
    stamp(defRoot, [], { tagName: "eer-cta" });
    expect(defRoot.dataset.jxDefinitionRoot).toBe("");
    expect(defRoot.dataset.jxPath).toBe("[]");
    // A page's plain root gets no marker.
    const pageRoot = document.createElement("div");
    stamp(pageRoot, [], { tagName: "div" });
    expect(pageRoot.dataset.jxDefinitionRoot).toBeUndefined();
    // A NESTED custom element is an instantiation site — it must stay live.
    const nested = document.createElement("eer-step");
    stamp(nested, ["children", 1], { tagName: "eer-step" });
    expect(nested.dataset.jxDefinitionRoot).toBeUndefined();
  });
});

describe("component-definition root vs a registered custom element (cross-tab realm reuse)", () => {
  test("rendering a doc whose root tag is ALREADY registered keeps the stamped editable tree", async () => {
    // A previously-rendered page registered the component in this realm (hosts persist across tab
    // Switches). Without the definition-root guard, the upgrade's connectedCallback wipes the
    // Editor-rendered children and re-renders a live instance with default state — the "component
    // Editor shows an uneditable instance" bug.
    const { defineElement } = await import("@jxsuite/runtime");
    await defineElement({
      children: [{ children: ["Default Heading"], tagName: "h2" }],
      state: { heading: "Default Heading" },
      tagName: "x-defroot-test",
    });

    const container = document.createElement("div");
    document.body.append(container);
    const handle = await renderResolvedDocument({
      container,
      doc: {
        children: [{ children: ["Authored Heading"], tagName: "h2" }],
        state: { heading: "Authored Heading" },
        tagName: "x-defroot-test",
      } as never,
      docBase: "http://localhost:3000/components/x-defroot-test.json",
      mapperCtx: ctx,
      mode: "design",
    });
    // ConnectedCallback initialization is async (buildScope) — give it room to (not) fire.
    await new Promise((r) => {
      setTimeout(r, 100);
    });

    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName.toLowerCase()).toBe("x-defroot-test");
    expect(root.dataset.jxDefinitionRoot).toBe("");
    // The editable, path-stamped tree survived (not the instance's unstamped re-render).
    const h2 = root.querySelector("h2") as HTMLElement;
    expect(h2.textContent).toBe("Authored Heading");
    expect(h2.dataset.jxPath).toBe('["children",0]');

    handle.dispose();
    container.remove();
  });
});

describe("applySiteStyle", () => {
  afterEach(() => {
    document.head.querySelector("#jx-site-style")?.remove();
    delete document.documentElement.dataset.colorScheme;
  });

  test("emits a stylesheet: custom properties on :root, plain properties on body", () => {
    applySiteStyle({ "--brand": "#0f0", color: "red", margin: {} as unknown });
    const css = document.head.querySelector("#jx-site-style")!.textContent!;
    expect(css).toContain(":root { --brand: #0f0 }");
    expect(css).toContain("body { color: red }");
    // Nested non-@ object values are page-content styling — not part of the site sheet.
    expect(css).not.toContain("margin");
  });

  test("replaces the sheet in place — stale tokens cannot linger", () => {
    applySiteStyle({ "--brand": "#0f0" });
    applySiteStyle({ "--accent": "#00f" });
    const tags = document.head.querySelectorAll("#jx-site-style");
    expect(tags).toHaveLength(1);
    expect(tags[0]!.textContent).toContain("--accent: #00f");
    expect(tags[0]!.textContent).not.toContain("--brand");
  });

  test("dual-emits scheme blocks and declares color-scheme", () => {
    applySiteStyle(
      { "--bg": "#fff", "@--dark": { "--bg": "#000" } },
      { "--dark": "(prefers-color-scheme: dark)" },
    );
    const css = document.head.querySelector("#jx-site-style")!.textContent!;
    expect(css).toContain(
      "@media (prefers-color-scheme: dark) { :root:where(:not([data-color-scheme])) { --bg: #000 } }",
    );
    expect(css).toContain(':root:where([data-color-scheme="dark"]) { --bg: #000 }');
    expect(css).toContain(":root { color-scheme: light dark }");
  });

  test("removes the sheet for null/non-object", () => {
    applySiteStyle({ "--brand": "#0f0" });
    expect(() => applySiteStyle(null)).not.toThrow();
    expect(document.head.querySelector("#jx-site-style")).toBeNull();
  });
});

describe("applyPreviewColorScheme", () => {
  afterEach(() => {
    delete document.documentElement.dataset.colorScheme;
  });

  test("sets and clears the forced-scheme attribute on the root element", () => {
    applyPreviewColorScheme(document, "dark");
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    applyPreviewColorScheme(document, "light");
    expect(document.documentElement.dataset.colorScheme).toBe("light");
    applyPreviewColorScheme(document, null);
    expect(document.documentElement.dataset.colorScheme).toBeUndefined();
  });
});

describe("injectHead", () => {
  afterEach(() => {
    document.head.innerHTML = "";
  });

  test("injects link/meta, rewrites bare specifiers, skips inline scripts, and de-dupes", () => {
    const doc = {
      $head: [
        { attributes: { href: "/x.css", rel: "stylesheet" }, tagName: "link" },
        { attributes: { content: "bar", name: "foo" }, tagName: "meta" },
        { attributes: {}, tagName: "script", textContent: "alert(1)" },
        { attributes: { href: "pkg/y.css", rel: "stylesheet" }, tagName: "link" },
      ],
    };
    injectHead(doc as never);
    expect(document.head.querySelector('link[href="/x.css"]')).not.toBeNull();
    expect(document.head.querySelector('meta[name="foo"]')).not.toBeNull();
    expect(document.head.querySelector("script")).toBeNull(); // Inline script skipped.
    // Bare specifier rewritten under /node_modules/.
    expect(document.head.querySelector('link[href="/node_modules/pkg/y.css"]')).not.toBeNull();

    // Re-injecting the same head de-dupes by href/src (no duplicate /x.css link).
    injectHead(doc as never);
    expect(document.head.querySelectorAll('link[href="/x.css"]')).toHaveLength(1);
  });

  test("is a no-op when there is no $head array", () => {
    expect(() => injectHead({} as never)).not.toThrow();
    expect(document.head.children).toHaveLength(0);
  });
});

describe("registerElements", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("registers $ref/inline components, tolerates failures, and skips non-array $elements", async () => {
    // Reject all fetches so $ref resolution fails fast (exercises the catch path without a hang).
    globalThis.fetch = (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch;
    const doc = {
      $elements: [
        "nonexistent-pkg-xyz", // String → dynamic import (fails) → caught.
        { $ref: "comp.json" }, //  $ref → defineElement(fetch fails) → caught.
        { tagName: "x-inline-comp" }, // Inline def → defineElement registers it.
      ],
    };
    await registerElements(doc as never, "http://localhost:3000/page.json");
    expect(customElements.get("x-inline-comp")).toBeDefined();

    // Missing/non-array $elements is a no-op.
    expect(await registerElements({} as never, "http://localhost:3000/")).toBeUndefined();
  });
});

describe("installCanvasImageRetry", () => {
  // Happy-dom never loads images, so the broken-image `error` event is driven manually. The retry
  // Schedules the re-fire via setTimeout(150 * attempt); swap setTimeout so the backoff fires
  // Synchronously and we can assert the re-fire happened (or didn't) without real waiting.
  function withCapturedTimers<T>(fn: (runPending: () => void) => T): T {
    const origSet = globalThis.setTimeout;
    const origClear = globalThis.clearTimeout;
    const pending: (() => unknown)[] = [];
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((cb: () => unknown) => {
      pending.push(cb);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    (globalThis as unknown as { clearTimeout: unknown }).clearTimeout =
      (() => {}) as typeof clearTimeout;
    try {
      return fn(() => {
        for (const cb of pending.splice(0)) {
          cb();
        }
      });
    } finally {
      globalThis.setTimeout = origSet;
      globalThis.clearTimeout = origClear;
    }
  }

  /** Fire a bubbling-irrelevant `error` Event at `img` so the capture-phase root listener sees it. */
  function fireError(img: HTMLImageElement): void {
    img.dispatchEvent(new Event("error"));
  }

  test("re-fires a failed image's request after the backoff", () => {
    withCapturedTimers((runPending) => {
      const root = document.createElement("div");
      const img = document.createElement("img");
      img.src = "http://x/y.jpg";
      root.append(img);
      const stop = installCanvasImageRetry(root);

      // Track that src is cleared then re-set to the original (the re-fire).
      const sets: string[] = [];
      let current = img.src;
      Object.defineProperty(img, "src", {
        configurable: true,
        get: () => current,
        set: (v: string) => {
          current = v;
          sets.push(v);
        },
      });

      fireError(img);
      // Re-fire is deferred until the backoff timer runs.
      expect(sets).toEqual([]);
      runPending();
      // Cleared to "" then re-assigned the original URL.
      expect(sets).toEqual(["", "http://x/y.jpg"]);

      stop();
    });
  });

  test("stops retrying after maxAttempts", () => {
    withCapturedTimers((runPending) => {
      const root = document.createElement("div");
      const img = document.createElement("img");
      img.src = "http://x/y.jpg";
      root.append(img);
      const stop = installCanvasImageRetry(root, 2);

      let refires = 0;
      let current = img.src;
      Object.defineProperty(img, "src", {
        configurable: true,
        get: () => current,
        set: (v: string) => {
          current = v;
          // Count each completed re-fire (the re-assignment back to a non-empty URL).
          if (v !== "") {
            refires += 1;
          }
        },
      });

      // Two attempts allowed: error → flush, error → flush each re-fire once.
      fireError(img);
      runPending();
      fireError(img);
      runPending();
      expect(refires).toBe(2);

      // Third error exceeds maxAttempts: nothing is scheduled, so a flush re-fires nothing.
      fireError(img);
      runPending();
      expect(refires).toBe(2);

      stop();
    });
  });

  test("ignores a data:-src image", () => {
    withCapturedTimers((runPending) => {
      const root = document.createElement("div");
      const img = document.createElement("img");
      img.src = "data:image/png;base64,AAAA";
      root.append(img);
      const stop = installCanvasImageRetry(root);

      let setCount = 0;
      let current = img.src;
      Object.defineProperty(img, "src", {
        configurable: true,
        get: () => current,
        set: (v: string) => {
          current = v;
          setCount += 1;
        },
      });

      fireError(img);
      runPending();
      // No retry was scheduled, so src was never touched.
      expect(setCount).toBe(0);

      stop();
    });
  });

  test("ignores an error from a non-image target", () => {
    withCapturedTimers((runPending) => {
      const root = document.createElement("div");
      // A non-<img> subresource (e.g. <script>/<link>) also fires a non-bubbling `error` in capture.
      const script = document.createElement("script");
      root.append(script);
      const stop = installCanvasImageRetry(root);

      let scheduled = false;
      const origSetTimeout = globalThis.setTimeout;
      (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((cb: () => unknown) => {
        scheduled = true;
        return origSetTimeout(cb as () => void, 0);
      }) as typeof setTimeout;
      try {
        script.dispatchEvent(new Event("error"));
        runPending();
      } finally {
        globalThis.setTimeout = origSetTimeout;
      }
      // The non-image guard returned early — no retry timer was scheduled.
      expect(scheduled).toBe(false);

      stop();
    });
  });

  test("teardown removes the listener so later errors no longer retry", () => {
    withCapturedTimers((runPending) => {
      const root = document.createElement("div");
      const img = document.createElement("img");
      img.src = "http://x/y.jpg";
      root.append(img);
      const stop = installCanvasImageRetry(root);
      stop();

      let setCount = 0;
      let current = img.src;
      Object.defineProperty(img, "src", {
        configurable: true,
        get: () => current,
        set: (v: string) => {
          current = v;
          setCount += 1;
        },
      });

      fireError(img);
      runPending();
      // Listener was removed, so no re-fire was scheduled.
      expect(setCount).toBe(0);
    });
  });
});

// ─── Design/edit-mode canvas CSS (placeholder affordances) ──────────────────────

describe("syncEditModeCss", () => {
  const sheet = () => document.head.querySelector(`#${EDIT_PLACEHOLDER_STYLE_ID}`);

  test("injects the placeholder stylesheet for design/edit, idempotently", () => {
    syncEditModeCss(document, "design");
    expect(sheet()).toBeTruthy();
    expect(sheet()!.textContent).toContain("Click here to add text...");
    expect(sheet()!.textContent).toContain("Type / for commands");
    syncEditModeCss(document, "edit");
    expect(document.head.querySelectorAll(`#${EDIT_PLACEHOLDER_STYLE_ID}`)).toHaveLength(1);
  });

  test("a preview render removes it", () => {
    syncEditModeCss(document, "design");
    expect(sheet()).toBeTruthy();
    syncEditModeCss(document, "preview");
    expect(sheet()).toBeNull();
    // Removing when absent is a no-op.
    syncEditModeCss(document, "preview");
    expect(sheet()).toBeNull();
  });

  test("a stylebook render removes it (specimens must not show placeholder affordances)", () => {
    syncEditModeCss(document, "edit");
    expect(sheet()).toBeTruthy();
    syncEditModeCss(document, "stylebook");
    expect(sheet()).toBeNull();
  });
});

// ─── Stylebook chrome CSS ────────────────────────────────────────────────────────

describe("syncStylebookCss", () => {
  const sheet = () => document.head.querySelector(`#${STYLEBOOK_STYLE_ID}`);

  afterEach(() => {
    syncStylebookCss(document, "preview");
  });

  test("injects card/section chrome for stylebook mode, idempotently", () => {
    syncStylebookCss(document, "stylebook");
    expect(sheet()).toBeTruthy();
    expect(sheet()!.textContent).toContain(".element-card");
    expect(sheet()!.textContent).toContain(".sb-section");
    // The parent grid disabled preview hits; the iframe must NOT — clicks select specimens.
    expect(sheet()!.textContent).not.toContain("pointer-events: none");
    syncStylebookCss(document, "stylebook");
    expect(document.head.querySelectorAll(`#${STYLEBOOK_STYLE_ID}`)).toHaveLength(1);
  });

  test("any other mode removes it", () => {
    syncStylebookCss(document, "stylebook");
    expect(sheet()).toBeTruthy();
    syncStylebookCss(document, "design");
    expect(sheet()).toBeNull();
    syncStylebookCss(document, "design");
    expect(sheet()).toBeNull();
  });

  test("renderResolvedDocument wires it by mode", async () => {
    const container = document.createElement("div");
    const handle = await renderResolvedDocument({
      container,
      doc: { children: ["x"], tagName: "div" } as never,
      docBase: "http://localhost:3000/page.json",
      mapperCtx: { ...ctx, canvasMode: "stylebook" },
      mode: "stylebook",
    });
    expect(sheet()).toBeTruthy();
    expect(document.head.querySelector(`#${EDIT_PLACEHOLDER_STYLE_ID}`)).toBeNull();
    handle.dispose();
  });
});
