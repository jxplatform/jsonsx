import { renderInto } from "./harness";
import { afterEach, describe, expect, test } from "bun:test";
import {
  BASE_SELECTOR_LABEL,
  openSelectorMenu,
  renderTargetLine,
  resetSelectorTrigger,
} from "../src/panels/target-line";
import type { TargetLineModel, TargetScope } from "../src/panels/target-line";

function model(over: Partial<TargetLineModel> = {}): TargetLineModel {
  return {
    scope: { kind: "element", label: "this element" },
    segments: [{ key: "element", label: "h1", title: "the element" }],
    selector: {
      declared: new Set<string>(),
      onAddCustom: () => {},
      onSelect: () => {},
      options: [":hover"],
      value: null,
    },
    ...over,
  };
}

/** Render into a CONNECTED host — `openSelectorMenu` asks the element whether it is still live. */
async function renderLine(m: TargetLineModel) {
  const host = document.createElement("div");
  document.body.append(host);
  return renderInto(renderTargetLine(m), host);
}

afterEach(() => {
  resetSelectorTrigger();
  document.body.replaceChildren();
});

describe("segments", () => {
  test("a segment with no action is a span, not a button that does nothing", async () => {
    const c = await renderLine(model());
    const seg = c.querySelector('[data-seg="element"]')!;
    expect(seg.tagName.toLowerCase()).toBe("span");
    expect(seg.getAttribute("title")).toBe("the element");
  });

  test("a segment with an action is a button, and separators sit between segments", async () => {
    let opened = 0;
    const c = await renderLine(
      model({
        segments: [
          { key: "element", label: "h1", onActivate: () => (opened += 1), title: "one" },
          { key: "media", label: "@Md", title: "two" },
        ],
      }),
    );
    const seg = c.querySelector('[data-seg="element"]')!;
    expect(seg.tagName.toLowerCase()).toBe("button");
    seg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opened).toBe(1);
    // One separator before the second segment and one before the selector — never a leading one.
    expect(c.querySelectorAll(".tl-sep").length).toBe(2);
  });
});

describe("the selector segment", () => {
  test("names the base rule when nothing is selected, and marks declared options", async () => {
    const c = await renderLine(
      model({
        selector: {
          declared: new Set([":hover"]),
          onAddCustom: () => {},
          onSelect: () => {},
          options: [":hover", ":focus"],
          value: null,
        },
      }),
    );
    expect(c.querySelector('[data-seg="selector"]')!.textContent).toContain(BASE_SELECTOR_LABEL);
    const items = [...c.querySelectorAll(".tl-selector-menu sp-menu-item")];
    expect(items.find((i) => i.getAttribute("value") === ":hover")!.textContent).toContain("●");
    expect(items.find((i) => i.getAttribute("value") === ":focus")!.textContent).not.toContain("●");
  });

  test("choosing closes the menu and reports the choice; base reports null", async () => {
    const chosen: (string | null)[] = [];
    const c = await renderLine(
      model({
        selector: {
          declared: new Set<string>(),
          onAddCustom: () => {},
          onSelect: (v) => chosen.push(v),
          options: [":hover"],
          value: ":hover",
        },
      }),
    );
    const trigger = c.querySelector("overlay-trigger") as HTMLElement & { open?: string };
    openSelectorMenu();
    expect(trigger.open).toBe("click");

    const item = (value: string) =>
      [...c.querySelectorAll(".tl-selector-menu sp-menu-item")].find(
        (i) => i.getAttribute("value") === value,
      )!;
    item(":hover").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(chosen).toEqual([":hover"]);
    expect(trigger.open).toBeUndefined();

    item("__base__").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(chosen).toEqual([":hover", null]);
  });

  test("+ Add custom… hands off to the dialog owner and closes the menu", async () => {
    let asked = 0;
    const c = await renderLine(
      model({
        selector: {
          declared: new Set<string>(),
          onAddCustom: () => (asked += 1),
          onSelect: () => {},
          options: [],
          value: null,
        },
      }),
    );
    const trigger = c.querySelector("overlay-trigger") as HTMLElement & { open?: string };
    openSelectorMenu();
    [...c.querySelectorAll(".tl-selector-menu sp-menu-item")]
      .find((i) => i.getAttribute("value") === "__add_custom__")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(asked).toBe(1);
    expect(trigger.open).toBeUndefined();
  });

  test("the command refuses when the line is not on screen", async () => {
    await renderInto(renderTargetLine(model())); // Detached container.
    expect(() => openSelectorMenu()).toThrow("selector menu is not in the document");
    resetSelectorTrigger();
    expect(() => openSelectorMenu()).toThrow("needs the Inspector's Style tab rendered");
  });
});

describe("the scope chip", () => {
  test("element scope carries no warning band", async () => {
    const c = await renderLine(model());
    expect(c.querySelector(".tl-scope")!.textContent!.trim()).toBe("this element");
    expect(c.querySelector(".tl-scope")!.getAttribute("title")).toBe(
      "These edits apply to the selected element only",
    );
    expect(c.querySelector(".tl-warning")).toBeNull();
  });

  test("document scope states the tag without warning", async () => {
    const scope: TargetScope = { kind: "document", label: "all <h1> in this document" };
    const c = await renderLine(model({ scope }));
    expect(c.querySelector(".tl-scope--document")).not.toBeNull();
    expect(c.querySelector(".tl-scope")!.getAttribute("title")).toBe(
      "These edits apply to all <h1> in this document",
    );
    expect(c.querySelector(".tl-warning")).toBeNull();
  });

  test("project scope warns, counts, and lists the affected files on demand", async () => {
    let toggled = 0;
    const scope: TargetScope = {
      affected: "12 elements in 3 files",
      affectedFiles: [{ count: 7, path: "pages/index.json" }],
      kind: "project",
      label: "all <h1> in this project",
      onToggleAffected: () => (toggled += 1),
      showAffected: false,
    };
    let c = await renderLine(model({ scope }));
    expect(c.querySelector(".tl-warning-text")!.textContent).toContain("12 elements in 3 files");
    const action = c.querySelector(".tl-warning-action")!;
    expect(action.textContent!.trim()).toBe("Show affected");
    action.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(toggled).toBe(1);

    c = await renderLine(model({ scope: { ...scope, showAffected: true } }));
    expect(c.querySelector(".tl-warning-action")!.textContent!.trim()).toBe("Hide affected");
    expect(c.querySelector(".tl-affected-path")!.textContent).toBe("pages/index.json");
    expect(c.querySelector(".tl-affected-count")!.textContent).toBe("7");
  });

  test("no count and no list is 'unknown', never a confident zero", async () => {
    const c = await renderLine(
      model({
        scope: {
          kind: "project",
          label: "all <h1> in this project",
          showAffected: true,
        },
      }),
    );
    expect(c.querySelector(".tl-warning-text")!.textContent).toContain("unknown");
    // No toggle handler → no action to press, and the disclosure explains its own emptiness.
    expect(c.querySelector(".tl-warning-action")).toBeNull();
    expect(c.querySelector(".tl-affected-empty")!.textContent).toContain("could not be searched");
  });
});
