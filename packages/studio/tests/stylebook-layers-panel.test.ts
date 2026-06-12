/** Tests for src/panels/stylebook-layers-panel.ts — stylebook layers tree. */
import { renderInto, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderStylebookLayersTemplate } from "../src/panels/stylebook-layers-panel";
import { componentRegistry } from "../src/files/components";
import type { JxMutableNode } from "@jxsuite/schema/types";

const meta = {
  $sections: [
    { elements: [{ tag: "h1", text: "Heading" }], label: "Headings" },
    {
      elements: [
        {
          children: [
            { tag: "li", text: "One" },
            { tag: "li", text: "Two" },
          ],
          tag: "ul",
        },
      ],
      label: "List",
    },
  ],
};

const selectStylebookTag = mock(
  (_tag: string, _media?: string | null, _opts?: { panCanvas?: boolean }) => {},
);
const ctx = { selectStylebookTag, stylebookMeta: meta };

function makeTab(style: Record<string, unknown> = {}) {
  return resetWorkspaceWithTab({
    children: [],
    style,
    tagName: "div",
  } as unknown as JxMutableNode);
}

beforeEach(() => {
  resetStudioState();
  selectStylebookTag.mockClear();
  componentRegistry.length = 0;
});

describe("elements tab", () => {
  test("renders a row per meta entry plus deduped children", async () => {
    makeTab();
    const el = await renderInto(renderStylebookLayersTemplate(ctx));
    const rows = el.querySelectorAll(".layer-row");
    // H1, ul, one deduped li (two li children share the tag)
    expect(rows.length).toBe(3);
    const tags = [...el.querySelectorAll(".layer-tag")].map((r) => r.textContent);
    expect(tags).toEqual(["h1", "ul", "li"]);
  });

  test("children rows are indented and use compound path on click", async () => {
    makeTab();
    const el = await renderInto(renderStylebookLayersTemplate(ctx));
    const rows = [...el.querySelectorAll(".layer-row")] as HTMLElement[];
    const liRow = rows.at(2) as HTMLElement;
    expect(liRow.style.paddingLeft).toBe("24px");
    liRow.click();
    expect(selectStylebookTag).toHaveBeenCalledWith("ul li", undefined, { panCanvas: true });
  });

  test("top-level row click selects bare tag with panCanvas", async () => {
    makeTab();
    const el = await renderInto(renderStylebookLayersTemplate(ctx));
    (el.querySelector(".layer-row") as HTMLElement).click();
    expect(selectStylebookTag).toHaveBeenCalledWith("h1", undefined, { panCanvas: true });
  });

  test("marks the selected leaf tag, including compound selections", async () => {
    const tab = makeTab();
    tab.session.ui.stylebookSelection = "ul li";
    const el = await renderInto(renderStylebookLayersTemplate(ctx));
    const selected = [...el.querySelectorAll(".layer-row.selected")];
    expect(selected.length).toBe(1);
    expect(selected[0].querySelector(".layer-tag")?.textContent).toBe("li");
  });

  test("shows customization dot for tags styled via '& tag' keys", async () => {
    makeTab({ "& h1": { color: "red" } });
    const el = await renderInto(renderStylebookLayersTemplate(ctx));
    const rows = [...el.querySelectorAll(".layer-row")];
    expect(rows[0].querySelectorAll("span").length).toBe(3); // Tag + label + dot
    expect(rows[1].querySelectorAll("span").length).toBe(2);
  });

  test("empty '& tag' style block shows no dot", async () => {
    makeTab({ "& h1": {} });
    const el = await renderInto(renderStylebookLayersTemplate(ctx));
    const rows = [...el.querySelectorAll(".layer-row")];
    expect(rows[0].querySelectorAll("span").length).toBe(2);
  });

  test("uses fallback label when entry has no text", async () => {
    makeTab();
    const localCtx = {
      selectStylebookTag,
      stylebookMeta: { $sections: [{ elements: [{ tag: "hr" }], label: "Rule" }] },
    };
    const el = await renderInto(renderStylebookLayersTemplate(localCtx));
    expect(el.querySelector(".layer-label")?.textContent).toBe("<hr>");
  });

  test("renders component registry rows and selects by tagName", async () => {
    const tab = makeTab();
    componentRegistry.push({ tagName: "x-card" } as never, { tagName: "x-nav" } as never);
    tab.session.ui.stylebookSelection = "x-nav";
    const el = await renderInto(renderStylebookLayersTemplate(ctx));
    const compRows = [...el.querySelectorAll(".layer-row")].filter((r) =>
      r.querySelector(".component-tag"),
    ) as HTMLElement[];
    expect(compRows.length).toBe(2);
    expect(compRows[1].classList.contains("selected")).toBe(true);
    compRows[0].click();
    expect(selectStylebookTag).toHaveBeenCalledWith("x-card", undefined, { panCanvas: true });
  });
});

describe("variables tab", () => {
  test("lists CSS custom properties with values", async () => {
    const tab = makeTab({ "--accent": "#f00", "--gap": "8px", h1: { color: "red" } });
    tab.session.ui.stylebookTab = "variables";
    const el = await renderInto(renderStylebookLayersTemplate(ctx));
    const rows = [...el.querySelectorAll(".layer-row")];
    expect(rows.length).toBe(2);
    expect(el.textContent).toContain("--accent");
    expect(el.textContent).toContain("#f00");
    expect(el.textContent).toContain("--gap");
    expect(el.textContent).toContain("8px");
    expect(el.textContent).not.toContain("h1");
  });

  test("shows empty state when no variables are defined", async () => {
    const tab = makeTab({ h1: { color: "red" } });
    tab.session.ui.stylebookTab = "variables";
    const el = await renderInto(renderStylebookLayersTemplate(ctx));
    expect(el.textContent).toContain("No variables defined");
  });

  test("handles a missing document style gracefully", async () => {
    const tab = resetWorkspaceWithTab({ children: [], tagName: "div" } as unknown as JxMutableNode);
    tab.session.ui.stylebookTab = "variables";
    const el = await renderInto(renderStylebookLayersTemplate(ctx));
    expect(el.textContent).toContain("No variables defined");
  });
});
