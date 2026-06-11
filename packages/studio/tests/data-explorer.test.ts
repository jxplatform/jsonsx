import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { render } from "lit-html";
import { renderDataExplorerTemplate } from "../src/panels/data-explorer";

const noop = () => {};
const callbacks = {
  defBadgeLabel: () => "Request",
  defCategory: () => "data",
  renderCanvas: noop,
  renderLeftPanel: noop,
};

describe("renderDataExplorerTemplate", () => {
  test("renders state entries when liveScope is null (design mode)", () => {
    const state = {
      allPosts: { $prototype: "Request", url: "https://api.example.com/posts" },
      searchTerm: { default: "", type: "string" },
    };
    const result = renderDataExplorerTemplate(state, null, callbacks);
    expect(result).toBeDefined();
    const container = document.createElement("div");
    render(result, container);
    expect(container.textContent).not.toContain("No live data");
    expect(container.textContent).toContain("allPosts");
    expect(container.textContent).toContain("searchTerm");
  });

  test("renders state entries with live values", () => {
    const state = {
      allPosts: { $prototype: "Request", url: "https://api.example.com/posts" },
    };
    const liveScope = { allPosts: [{ id: 1 }, { id: 2 }] };
    const result = renderDataExplorerTemplate(state, liveScope, callbacks);
    const container = document.createElement("div");
    render(result, container);
    expect(container.textContent).toContain("allPosts");
  });

  test("shows 'No state defined' when state is empty", () => {
    const result = renderDataExplorerTemplate({}, null, callbacks);
    const container = document.createElement("div");
    render(result, container);
    expect(container.textContent).toContain("No state defined");
  });
});
