import { describe, test, expect, beforeEach } from "bun:test";
import {
  buildStylebookElement,
  renderStylebookElementsIntoCanvas,
  renderComponentPreview,
} from "../src/panels/stylebook-panel.js";
import { setProjectState } from "../src/store.js";

beforeEach(() => {
  setProjectState({ projectConfig: null, expanded: new Set() });
});

// ─── buildStylebookElement ────────────────────────────────────────────────────

describe("buildStylebookElement", () => {
  test("creates element with correct tag", () => {
    const el = buildStylebookElement({ tag: "h1", text: "Hello" }, {}, null);
    expect(el.tagName).toBe("H1");
    expect(el.textContent).toBe("Hello");
  });

  test("applies style from rootStyle matching selector", () => {
    const rootStyle = { h1: { color: "red", fontSize: "2rem" } };
    const el = buildStylebookElement({ tag: "h1", text: "Test" }, rootStyle, null);
    expect(el.style.color).toBe("red");
    expect(el.style.fontSize).toBe("2rem");
  });

  test("applies CSS variable references as style values", () => {
    const rootStyle = { h1: { color: "var(--color-primary)" } };
    const el = buildStylebookElement({ tag: "h1", text: "Test" }, rootStyle, null);
    expect(el.style.color).toBe("var(--color-primary)");
  });

  test("applies media-specific overrides when breakpoint is active", () => {
    const rootStyle = {
      h1: {
        fontSize: "3rem",
        "@md": { fontSize: "2rem" },
        "@sm": { fontSize: "1.5rem" },
      },
    };
    const active = new Set(["md"]);
    const el = buildStylebookElement({ tag: "h1", text: "Test" }, rootStyle, active);
    expect(el.style.fontSize).toBe("2rem");
  });

  test("does not apply media overrides for inactive breakpoints", () => {
    const rootStyle = {
      h1: {
        fontSize: "3rem",
        "@lg": { fontSize: "2.5rem" },
      },
    };
    const active = new Set(["md"]);
    const el = buildStylebookElement({ tag: "h1", text: "Test" }, rootStyle, active);
    expect(el.style.fontSize).toBe("3rem");
  });

  test("applies attributes from entry", () => {
    const el = buildStylebookElement(
      { tag: "a", text: "Link", attributes: { href: "#", target: "_blank" } },
      {},
      null,
    );
    expect(el.getAttribute("href")).toBe("#");
    expect(el.getAttribute("target")).toBe("_blank");
  });

  test("builds nested children recursively", () => {
    const entry = {
      tag: "ul",
      children: [
        { tag: "li", text: "Item 1" },
        { tag: "li", text: "Item 2" },
      ],
    };
    const rootStyle = { li: { color: "blue" } };
    const el = buildStylebookElement(entry, rootStyle, null);
    expect(el.children.length).toBe(2);
    expect(el.children[0].textContent).toBe("Item 1");
    expect(el.children[0].style.color).toBe("blue");
  });
});

// ─── buildStylebookElement — compound selectors ─────────────────────────────────

describe("buildStylebookElement compound selectors", () => {
  test("applies compound selector style when parentTag differs from entry.tag", () => {
    const rootStyle = {
      blockquote: { p: { fontStyle: "italic" } },
      p: { color: "black" },
    };
    const el = buildStylebookElement({ tag: "p", text: "Quote" }, rootStyle, null, "blockquote");
    expect(el.style.fontStyle).toBe("italic");
  });

  test("falls back to leaf selector when compound not in rootStyle", () => {
    const rootStyle = { p: { color: "green" } };
    const el = buildStylebookElement({ tag: "p", text: "Test" }, rootStyle, null, "blockquote");
    expect(el.style.color).toBe("green");
  });

  test("uses leaf selector when parentTag equals entry.tag", () => {
    const rootStyle = { li: { margin: "4px" } };
    const el = buildStylebookElement({ tag: "li", text: "Item" }, rootStyle, null, "li");
    expect(el.style.margin).toBe("4px");
  });

  test("recursive children receive parent entry.tag as parentTag", () => {
    const rootStyle = {
      ul: { li: { listStyleType: "disc" } },
      li: { listStyleType: "none" },
    };
    const entry = {
      tag: "ul",
      children: [{ tag: "li", text: "Item" }],
    };
    const el = buildStylebookElement(entry, rootStyle, null);
    expect(el.children[0].style.listStyleType).toBe("disc");
  });

  test("differentiates ul li from ol li", () => {
    const rootStyle = {
      ul: { li: { color: "blue" } },
      ol: { li: { color: "red" } },
    };
    const ul = buildStylebookElement(
      { tag: "ul", children: [{ tag: "li", text: "UL item" }] },
      rootStyle,
      null,
    );
    const ol = buildStylebookElement(
      { tag: "ol", children: [{ tag: "li", text: "OL item" }] },
      rootStyle,
      null,
    );
    expect(ul.children[0].style.color).toBe("blue");
    expect(ol.children[0].style.color).toBe("red");
  });

  test("compound selector with media breakpoint overrides", () => {
    const rootStyle = {
      blockquote: {
        p: {
          fontSize: "1.2rem",
          "@sm": { fontSize: "1rem" },
        },
      },
    };
    const active = new Set(["sm"]);
    const el = buildStylebookElement({ tag: "p", text: "Q" }, rootStyle, active, "blockquote");
    expect(el.style.fontSize).toBe("1rem");
  });
});

// ─── renderStylebookElementsIntoCanvas — CSS variable propagation ─────────────

describe("renderStylebookElementsIntoCanvas CSS variables", () => {
  test("sets CSS custom properties on the canvas element", () => {
    const canvasEl = document.createElement("div");
    const rootStyle = {
      "--color-primary": "#6c0505",
      "--font-body": "Inter, sans-serif",
      "--spacing-lg": "2rem",
      h1: { color: "var(--color-primary)" },
    };
    renderStylebookElementsIntoCanvas(canvasEl, rootStyle, "", false, null);
    expect(canvasEl.style.getPropertyValue("--color-primary")).toBe("#6c0505");
    expect(canvasEl.style.getPropertyValue("--font-body")).toBe("Inter, sans-serif");
    expect(canvasEl.style.getPropertyValue("--spacing-lg")).toBe("2rem");
  });

  test("does not set non-variable properties on canvas element", () => {
    const canvasEl = document.createElement("div");
    const rootStyle = {
      "--color-accent": "blue",
      h1: { color: "red" },
    };
    renderStylebookElementsIntoCanvas(canvasEl, rootStyle, "", false, null);
    expect(canvasEl.style.getPropertyValue("--color-accent")).toBe("blue");
    expect(canvasEl.style.color).toBe("");
  });

  test("re-render replaces stale content with fresh elements", () => {
    const canvasEl = document.createElement("div");
    const rootStyle1 = { h1: { color: "red" } };
    renderStylebookElementsIntoCanvas(canvasEl, rootStyle1, "", false, null);

    const h1Before = canvasEl.querySelector("h1");
    expect(h1Before).not.toBeNull();
    expect(h1Before?.style.color).toBe("red");

    const rootStyle2 = { h1: { color: "blue" } };
    renderStylebookElementsIntoCanvas(canvasEl, rootStyle2, "", false, null);

    const h1After = canvasEl.querySelector("h1");
    expect(h1After).not.toBeNull();
    expect(h1After?.style.color).toBe("blue");
  });

  test("updates CSS variables on re-render", () => {
    const canvasEl = document.createElement("div");
    const rootStyle1 = { "--color-primary": "#000" };
    renderStylebookElementsIntoCanvas(canvasEl, rootStyle1, "", false, null);
    expect(canvasEl.style.getPropertyValue("--color-primary")).toBe("#000");

    const rootStyle2 = { "--color-primary": "#fff" };
    renderStylebookElementsIntoCanvas(canvasEl, rootStyle2, "", false, null);
    expect(canvasEl.style.getPropertyValue("--color-primary")).toBe("#fff");
  });
});

// ─── renderComponentPreview ──────────────────────────────────────────────────

describe("renderComponentPreview", () => {
  test("npm component not registered → returns fallback div", async () => {
    const el = await renderComponentPreview({ tagName: "sl-button", source: "npm" });
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("<sl-button>");
  });

  test("npm component not registered → does not throw", async () => {
    await expect(
      renderComponentPreview({ tagName: "sl-nonexistent", source: "npm" }),
    ).resolves.toBeDefined();
  });

  test("markdown component → returns fallback div without fetch", async () => {
    const el = await renderComponentPreview({
      tagName: "todo-app",
      source: "local",
      path: "components/todo-app.md",
    });
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("<todo-app>");
  });

  test("markdown component with .MD extension → returns fallback", async () => {
    const el = await renderComponentPreview({
      tagName: "my-comp",
      source: "local",
      path: "components/my-comp.MD",
    });
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("<my-comp>");
  });

  test("local component with invalid path → returns fallback (no unhandled error)", async () => {
    setProjectState({ projectRoot: "test-project", projectConfig: null, expanded: new Set() });
    const el = await renderComponentPreview({
      tagName: "missing-comp",
      source: "local",
      path: "components/nonexistent.json",
    });
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("<missing-comp>");
  });
});
