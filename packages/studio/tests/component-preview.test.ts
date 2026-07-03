/**
 * Parent-realm component preview (src/panels/component-preview.ts) — used by the browse grid and
 * the components-palette DnD cards. Fallback paths must never throw (a broken component shows a
 * placeholder box instead).
 */
import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { renderComponentPreview } from "../src/panels/component-preview";
import { setProjectState } from "../src/store";
import type { ProjectState } from "../src/types";

beforeEach(() => {
  setProjectState({
    expanded: new Set(),
    projectConfig: null,
  } as unknown as ProjectState);
});

describe("renderComponentPreview", () => {
  test("npm component not registered → returns fallback div", async () => {
    const el = await renderComponentPreview(
      /** @type {any} */ { source: "npm", tagName: "sl-button" },
    );
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("<sl-button>");
  });

  test("registered npm component → instantiates it with prop defaults (false/'' skipped)", async () => {
    if (!customElements.get("x-preview-registered")) {
      customElements.define("x-preview-registered", class extends HTMLElement {});
    }
    const el = await renderComponentPreview({
      props: [
        { default: "'Jane'", name: "name" },
        { default: "false", name: "compact" },
        { default: "''", name: "label" },
        { name: "unset" },
      ],
      source: "npm",
      tagName: "x-preview-registered",
    } as never);
    expect(el.tagName.toLowerCase()).toBe("x-preview-registered");
    expect(el.getAttribute("name")).toBe("Jane");
    expect(el.hasAttribute("compact")).toBe(false);
    expect(el.hasAttribute("label")).toBe(false);
    expect(el.hasAttribute("unset")).toBe(false);
  });

  test("npm component not registered → does not throw", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- Bun's expect().resolves.toBeDefined() returns a real Promise at runtime but is typed `void`; the await must be kept to wait for resolution.
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
    } as never);
    const el = await renderComponentPreview({
      path: "components/nonexistent.json",
      source: "local",
      tagName: "missing-comp",
    });
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("<missing-comp>");
  });
});
