import { flush, installMockPlatform, key, pointer, resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { renderHeadEditor } from "../src/settings/head-editor";
import { projectState } from "../src/store";

import type { MockPlatformState } from "./harness";
import type { JxHeadEntry } from "@jxsuite/schema/types";

// ─── Local helpers ────────────────────────────────────────────────────────────

/** Run fn with setTimeout/clearTimeout replaced by immediate invocation (deterministic debounce). */
function withImmediateTimers<T>(fn: () => T): T {
  const origSet = globalThis.setTimeout;
  const origClear = globalThis.clearTimeout;
  (globalThis as any).setTimeout = (cb: () => void) => {
    cb();
    return 0;
  };
  (globalThis as any).clearTimeout = () => {};
  try {
    return fn();
  } finally {
    globalThis.setTimeout = origSet;
    globalThis.clearTimeout = origClear;
  }
}

let platformState: MockPlatformState;

/** Seed project state with a $head array and render the editor into a fresh container. */
function setup(head: JxHeadEntry[] = []): { container: HTMLElement; head: JxHeadEntry[] } {
  ({ state: platformState } = installMockPlatform());
  resetStudioState({ projectConfig: { $head: head, name: "demo" } });
  const container = document.createElement("div");
  renderHeadEditor(container);
  return { container, head };
}

/** The Head (non-fonts) settings section. */
function headSection(container: HTMLElement): HTMLElement {
  return container.querySelectorAll(".settings-section")[1] as HTMLElement;
}

function entries(container: HTMLElement): HTMLElement[] {
  return [...headSection(container).querySelectorAll(".head-entry")] as HTMLElement[];
}

function addButton(container: HTMLElement, label: string): Element {
  const button = [...container.querySelectorAll(".head-add-actions sp-action-button")].find((b) =>
    b.textContent?.includes(label),
  );
  if (!button) {
    throw new Error(`add button not found: ${label}`);
  }
  return button;
}

function fontEntryUrl(family: string): string {
  return `https://fonts.googleapis.com/css2?family=${family.replaceAll(" ", "+")}&display=swap`;
}

async function savedHead(): Promise<JxHeadEntry[]> {
  await flush();
  const raw = platformState.files.get("project.json");
  expect(raw).toBeTruthy();
  return JSON.parse(raw!).$head;
}

beforeEach(() => {
  resetStudioState();
});

// ─── Head entry rendering ─────────────────────────────────────────────────────

describe("head entry rendering", () => {
  test("renders one block per entry with tag headers and per-tag fields", () => {
    const { container } = setup([
      { attributes: { href: "/a.css", rel: "stylesheet" }, tagName: "link" },
      { attributes: { content: "ie=edge", name: "x-ua" }, tagName: "meta" },
      { attributes: { src: "/app.js" }, tagName: "script" },
      { attributes: {}, tagName: "script" },
      { tagName: "style", textContent: ".x{}" } as JxHeadEntry,
      { attributes: {}, tagName: "base" },
    ]);
    const blocks = entries(container);
    expect(blocks.length).toBe(6);
    expect(blocks.map((b) => b.querySelector(".head-entry-tag")?.textContent)).toEqual([
      "<link>",
      "<meta>",
      "<script>",
      "<script>",
      "<style>",
      "<base>",
    ]);

    // Link: rel + href textfields with bound values
    const linkFields = blocks[0]!.querySelectorAll("sp-textfield");
    expect(linkFields.length).toBe(2);
    expect((linkFields[0] as any).value).toBe("stylesheet");
    expect((linkFields[1] as any).value).toBe("/a.css");

    // Meta: name + content
    const metaFields = blocks[1]!.querySelectorAll("sp-textfield");
    expect((metaFields[0] as any).value).toBe("x-ua");
    expect((metaFields[1] as any).value).toBe("ie=edge");

    // Script with src: single field, no inline body
    expect(blocks[2]!.querySelectorAll("sp-textfield").length).toBe(1);
    expect(blocks[2]!.querySelector("textarea")).toBeNull();

    // Script without src: textarea body shown
    expect(blocks[3]!.querySelector("textarea")).toBeTruthy();

    // Style: textarea with content
    expect((blocks[4]!.querySelector("textarea") as HTMLTextAreaElement).value).toBe(".x{}");

    // Unknown tag: no fields
    expect(blocks[5]!.querySelector(".head-entry-fields")?.children.length).toBe(0);
  });
});

// ─── Add / remove entries ─────────────────────────────────────────────────────

describe("add and remove entries", () => {
  test("add buttons append tag-specific defaults and persist", async () => {
    const { container, head } = setup([]);
    pointer(addButton(container, "+ Link"), "click");
    pointer(addButton(container, "+ Meta"), "click");
    pointer(addButton(container, "+ Script"), "click");
    pointer(addButton(container, "+ Style"), "click");

    expect(head).toEqual([
      { attributes: { href: "", rel: "stylesheet" }, tagName: "link" },
      { attributes: { content: "", name: "" }, tagName: "meta" },
      { attributes: { src: "" }, tagName: "script" },
      { attributes: {}, tagName: "style", textContent: "" },
    ]);
    // The editor re-rendered itself with the new entries
    expect(entries(container).length).toBe(4);
    expect(await savedHead()).toEqual(head);
    expect(projectState?.projectConfig?.$head).toBe(head as any);
  });

  test("delete button removes the entry and persists", async () => {
    const { container, head } = setup([
      { attributes: { content: "a", name: "first" }, tagName: "meta" },
      { attributes: { content: "b", name: "second" }, tagName: "meta" },
    ]);
    const firstDelete = entries(container)[0]!.querySelector("sp-action-button")!;
    pointer(firstDelete, "click");
    expect(head.length).toBe(1);
    expect(head[0]!.attributes?.name).toBe("second");
    expect(entries(container).length).toBe(1);
    const persisted = await savedHead();
    expect(persisted.length).toBe(1);
  });
});

// ─── Field updates ────────────────────────────────────────────────────────────

describe("field updates", () => {
  test("link field change debounces into attributes (creating them when absent)", () => {
    const { container, head } = setup([{ tagName: "link" } as JxHeadEntry]);
    const [relField, hrefField] = entries(container)[0]!.querySelectorAll("sp-textfield");
    withImmediateTimers(() => {
      (relField as any).value = "preload";
      relField!.dispatchEvent(new Event("change", { bubbles: true }));
      (hrefField as any).value = "/new.css";
      hrefField!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(head[0]!.attributes).toEqual({ href: "/new.css", rel: "preload" });
  });

  test("meta content change updates attributes.content (not textContent)", () => {
    const { container, head } = setup([
      { attributes: { content: "old", name: "desc" }, tagName: "meta" },
    ]);
    const [, contentField] = entries(container)[0]!.querySelectorAll("sp-textfield");
    withImmediateTimers(() => {
      (contentField as any).value = "new";
      contentField!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(head[0]!.attributes?.content).toBe("new");
    expect(head[0]!.textContent).toBeUndefined();
  });

  test("inline script and style bodies write textContent via the content key", () => {
    const { container, head } = setup([
      { attributes: {}, tagName: "script" },
      { attributes: {}, tagName: "style", textContent: "" },
    ]);
    const [scriptBlock, styleBlock] = entries(container);
    withImmediateTimers(() => {
      const scriptArea = scriptBlock!.querySelector("textarea") as HTMLTextAreaElement;
      scriptArea.value = "console.log(1)";
      scriptArea.dispatchEvent(new Event("input", { bubbles: true }));
      const styleArea = styleBlock!.querySelector("textarea") as HTMLTextAreaElement;
      styleArea.value = "body{margin:0}";
      styleArea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(head[0]!.textContent).toBe("console.log(1)");
    expect(head[1]!.textContent).toBe("body{margin:0}");
  });
});

// ─── Google Fonts section ─────────────────────────────────────────────────────

describe("google fonts", () => {
  function fontsSection(container: HTMLElement): HTMLElement {
    return container.querySelectorAll(".settings-section")[0] as HTMLElement;
  }

  function fontInput(container: HTMLElement): HTMLElement & { value: string } {
    return fontsSection(container).querySelector("sp-textfield") as any;
  }

  test("shows an empty message without fonts and family names with them", () => {
    const empty = setup([]);
    expect(fontsSection(empty.container).textContent).toContain("No fonts imported.");

    const withFonts = setup([
      { attributes: { href: fontEntryUrl("Open Sans"), rel: "stylesheet" }, tagName: "link" },
      { attributes: { href: fontEntryUrl("Inter"), rel: "stylesheet" }, tagName: "link" },
    ]);
    const names = [...fontsSection(withFonts.container).querySelectorAll(".head-entry span")].map(
      (s) => s.textContent,
    );
    expect(names).toEqual(["Open Sans", "Inter"]);
  });

  test("Enter in the family field adds preconnects plus the stylesheet link", async () => {
    const { container, head } = setup([]);
    const input = fontInput(container);
    input.value = "Open Sans";
    key(input, "Enter");

    expect(head.length).toBe(3);
    expect(head[0]).toEqual({
      attributes: { href: "https://fonts.googleapis.com", rel: "preconnect" },
      tagName: "link",
    });
    expect(head[1]).toEqual({
      attributes: { crossorigin: "", href: "https://fonts.gstatic.com", rel: "preconnect" },
      tagName: "link",
    });
    expect(head[2]!.attributes?.href).toBe(fontEntryUrl("Open Sans"));
    expect(input.value).toBe(""); // Cleared after adding
    expect(fontsSection(container).textContent).toContain("Open Sans"); // Re-rendered
    const persisted = await savedHead();
    expect(persisted.length).toBe(3);
  });

  test("Enter with an empty field and non-Enter keys are no-ops", () => {
    const { container, head } = setup([]);
    const input = fontInput(container);
    input.value = "   ";
    key(input, "Enter");
    expect(head.length).toBe(0);
    input.value = "Inter";
    key(input, "a");
    expect(head.length).toBe(0);
  });

  test("+ Add button reads the sibling field; empty value is a no-op", () => {
    const { container, head } = setup([]);
    const button = [...fontsSection(container).querySelectorAll("sp-action-button")].find((b) =>
      b.textContent?.includes("+ Add"),
    )!;
    pointer(button, "click"); // Empty input → nothing happens
    expect(head.length).toBe(0);

    fontInput(container).value = "Roboto";
    pointer(button, "click");
    expect(head.length).toBe(3); // 2 preconnects + stylesheet
    expect(head[2]!.attributes?.href).toBe(fontEntryUrl("Roboto"));
    expect(fontInput(container).value).toBe("");
  });

  test("removing the last font also strips preconnects; earlier fonts keep them", () => {
    const { container, head } = setup([]);
    const input = fontInput(container);
    input.value = "Open Sans";
    key(input, "Enter");
    fontInput(container).value = "Inter";
    key(fontInput(container), "Enter");
    expect(head.length).toBe(4); // 2 preconnects + 2 stylesheets (preconnects deduped)

    // Remove "Open Sans" — preconnects must survive because Inter remains.
    const deleteButtons = () => [
      ...fontsSection(container).querySelectorAll(".head-entry sp-action-button"),
    ];
    pointer(deleteButtons()[0]!, "click");
    expect(head.length).toBe(3);
    expect(head.filter((e) => e.attributes?.rel === "preconnect").length).toBe(2);

    // Remove the final font — preconnects are cleaned up in place.
    pointer(deleteButtons()[0]!, "click");
    expect(head.length).toBe(0);
    expect(fontsSection(container).textContent).toContain("No fonts imported.");
  });
});
