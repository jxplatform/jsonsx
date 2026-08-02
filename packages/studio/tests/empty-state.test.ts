/**
 * The shared empty-state pattern — every panel renders through it, so this file pins the shape the
 * panels inherit: the sentence, the optional detail, the action buttons, and the compact variant.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { html, render } from "lit-html";

const openQuickSearch = mock(() => {});
void mock.module("../src/panels/quick-search.js", () => ({
  closeQuickSearch: () => {},
  initQuickSearch: () => {},
  openQuickSearch,
}));

const { CANVAS_VERB, clickAnythingTo, openPageAction, renderEmptyState, staleSelectionMessage } =
  await import("../src/panels/empty-state");

function paint(spec: Parameters<typeof renderEmptyState>[0]): HTMLElement {
  const container = document.createElement("div");
  render(renderEmptyState(spec), container);
  return container;
}

function root(container: HTMLElement): HTMLElement {
  return container.querySelector(".empty-state") as HTMLElement;
}

beforeEach(() => {
  openQuickSearch.mockClear();
});

describe("copy helpers", () => {
  test("clickAnythingTo builds one sentence from the shared verb", () => {
    expect(clickAnythingTo("style it")).toBe("Click anything on the canvas to style it.");
    expect(clickAnythingTo("style it").startsWith(CANVAS_VERB)).toBe(true);
  });

  test("every selection surface phrases its requirement the same way", () => {
    // The regression this guards: Properties said "Select an element to inspect" while Style,
    // Immediately beside it, said "Select an element to style" — two requirements, one need.
    const outcomes = ["edit its content", "style it", "wire it up"].map((outcome) =>
      clickAnythingTo(outcome),
    );
    for (const sentence of outcomes) {
      expect(sentence.startsWith(`${CANVAS_VERB} to `)).toBe(true);
      expect(sentence.endsWith(".")).toBe(true);
    }
  });

  test("staleSelectionMessage names what is gone, then hands back the shared verb", () => {
    const message = staleSelectionMessage();
    expect(message).toContain("no longer on the page");
    expect(message).toContain(CANVAS_VERB);
  });
});

describe("openPageAction", () => {
  test("defaults to one label and runs the open-a-file surface", async () => {
    const action = openPageAction();
    expect(action.label).toBe("Open a page…");
    action.run();
    // The Quick Access module is reached through a lazy import, so the call lands a tick later.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(openQuickSearch).toHaveBeenCalledTimes(1);
  });

  test("accepts a caller-supplied label", () => {
    expect(openPageAction("Open a layout…").label).toBe("Open a layout…");
  });
});

describe("renderEmptyState", () => {
  test("renders the sentence and no action row when nothing fills the region", () => {
    const container = paint({ message: "Open a page to see the elements it is built from." });
    expect(root(container).classList.contains("empty-state--teach")).toBe(true);
    expect(root(container).classList.contains("empty-state--compact")).toBe(false);
    expect(container.querySelector(".empty-state-message")?.textContent).toBe(
      "Open a page to see the elements it is built from.",
    );
    expect(container.querySelector(".empty-state-detail")).toBeNull();
    expect(container.querySelector(".empty-state-actions")).toBeNull();
  });

  test("renders the optional detail line", () => {
    const container = paint({ detail: "It comes from project.json.", message: "Nothing yet." });
    expect(container.querySelector(".empty-state-detail")?.textContent).toBe(
      "It comes from project.json.",
    );
  });

  test("renders an action button that runs its handler", () => {
    let ran = 0;
    const container = paint({
      actions: [{ label: "Add a value", run: () => (ran += 1) }],
      message: "Data lives here.",
    });
    const button = container.querySelector(".empty-state-action") as HTMLElement;
    expect(button.textContent?.trim()).toBe("Add a value");
    expect(button.hasAttribute("disabled")).toBe(false);
    button.click();
    expect(ran).toBe(1);
  });

  test("renders several actions, an icon slot, and the disabled state", () => {
    const container = paint({
      actions: [
        {
          disabled: true,
          icon: html`<sp-icon-add slot="icon"></sp-icon-add>`,
          label: "Initialize Repository",
          run: () => {},
        },
        { label: "Create GitHub repository", run: () => {} },
      ],
      message: "This project is not tracked by git yet.",
    });
    const buttons = [...container.querySelectorAll(".empty-state-action")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.hasAttribute("disabled")).toBe(true);
    expect(buttons[0]!.querySelector("sp-icon-add")).not.toBeNull();
    expect(buttons[1]!.hasAttribute("disabled")).toBe(false);
  });

  test("compact marks the inline variant that sits above its own add form", () => {
    const container = paint({ compact: true, message: "No commits yet." });
    expect(root(container).classList.contains("empty-state--compact")).toBe(true);
    expect(root(container).classList.contains("empty-state")).toBe(true);
  });
});
