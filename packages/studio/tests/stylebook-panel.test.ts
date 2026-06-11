import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildStylebookElement,
  renderComponentPreview,
  renderStylebookElementsIntoCanvas,
} from "../src/panels/stylebook-panel";
import { setProjectState } from "../src/store";
import type { ProjectState } from "../src/types";

beforeEach(() => {
  setProjectState({
    expanded: new Set(),
    projectConfig: null,
  } as unknown as ProjectState);
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
        "@md": { fontSize: "2rem" },
        "@sm": { fontSize: "1.5rem" },
        fontSize: "3rem",
      },
    };
    const active = new Set(["md"]);
    const el = buildStylebookElement({ tag: "h1", text: "Test" }, rootStyle, active);
    expect(el.style.fontSize).toBe("2rem");
  });

  test("does not apply media overrides for inactive breakpoints", () => {
    const rootStyle = {
      h1: {
        "@lg": { fontSize: "2.5rem" },
        fontSize: "3rem",
      },
    };
    const active = new Set(["md"]);
    const el = buildStylebookElement({ tag: "h1", text: "Test" }, rootStyle, active);
    expect(el.style.fontSize).toBe("3rem");
  });

  test("applies attributes from entry", () => {
    const el = buildStylebookElement(
      { attributes: { href: "#", target: "_blank" }, tag: "a", text: "Link" },
      {},
      null,
    );
    expect(el.getAttribute("href")).toBe("#");
    expect(el.getAttribute("target")).toBe("_blank");
  });

  test("builds nested children recursively", () => {
    const entry = {
      children: [
        { tag: "li", text: "Item 1" },
        { tag: "li", text: "Item 2" },
      ],
      tag: "ul",
    };
    const rootStyle = { li: { color: "blue" } };
    const el = buildStylebookElement(entry, rootStyle, null);
    expect(el.children.length).toBe(2);
    expect(el.children[0].textContent).toBe("Item 1");
    expect((el.children[0] as HTMLElement).style.color).toBe("blue");
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
      li: { listStyleType: "none" },
      ul: { li: { listStyleType: "disc" } },
    };
    const entry = {
      children: [{ tag: "li", text: "Item" }],
      tag: "ul",
    };
    const el = buildStylebookElement(entry, rootStyle, null);
    expect((el.children[0] as HTMLElement).style.listStyleType).toBe("disc");
  });

  test("differentiates ul li from ol li", () => {
    const rootStyle = {
      ol: { li: { color: "red" } },
      ul: { li: { color: "blue" } },
    };
    const ul = buildStylebookElement(
      { children: [{ tag: "li", text: "UL item" }], tag: "ul" },
      rootStyle,
      null,
    );
    const ol = buildStylebookElement(
      { children: [{ tag: "li", text: "OL item" }], tag: "ol" },
      rootStyle,
      null,
    );
    expect((ul.children[0] as HTMLElement).style.color).toBe("blue");
    expect((ol.children[0] as HTMLElement).style.color).toBe("red");
  });

  test("compound selector with media breakpoint overrides", () => {
    const rootStyle = {
      blockquote: {
        p: {
          "@sm": { fontSize: "1rem" },
          fontSize: "1.2rem",
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
    const el = await renderComponentPreview(
      /** @type {any} */ { source: "npm", tagName: "sl-button" },
    );
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("<sl-button>");
  });

  test("npm component not registered → does not throw", async () => {
    await expect(
      renderComponentPreview(/** @type {any} */ { source: "npm", tagName: "sl-nonexistent" }),
    ).resolves.toBeDefined();
  });

  test("markdown component → returns fallback div without fetch", async () => {
    const el = await renderComponentPreview({
      path: "components/todo-app.md",
      source: "local",
      tagName: "todo-app",
    });
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("<todo-app>");
  });

  test("markdown component with .MD extension → returns fallback", async () => {
    const el = await renderComponentPreview({
      path: "components/my-comp.MD",
      source: "local",
      tagName: "my-comp",
    });
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("<my-comp>");
  });

  test("local component with invalid path → returns fallback (no unhandled error)", async () => {
    setProjectState({
      expanded: new Set(),
      projectConfig: null,
      projectRoot: "test-project",
    } as any);
    const el = await renderComponentPreview({
      path: "components/nonexistent.json",
      source: "local",
      tagName: "missing-comp",
    });
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("<missing-comp>");
  });
});
