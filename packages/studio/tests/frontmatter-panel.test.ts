/**
 * Above-canvas frontmatter Properties panel — eligibility gating (content mode + edit canvas mode +
 * content-collection schema match), accordion collapse persistence per tab, field rendering without
 * reserved keys (title shows, unlike the Document-tab section), commit paths through transactDoc,
 * and reactive re-render on frontmatter changes.
 */
import { flush, installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { frontmatterPanelEl, initShellRefs, registerRenderer } from "../src/store";
import { invalidateMediaCache } from "../src/ui/media-picker";
import { activateTab, closeAllTabs, openTab } from "../src/workspace/workspace";
import { mutateUpdateFrontmatter, transactDoc } from "../src/tabs/transact";
import { collectFmFields } from "../src/panels/frontmatter-fields";

const { mount, render, unmount } = await import("../src/panels/frontmatter-panel");

// Panel scheduler coalesces via requestAnimationFrame; make it synchronous-ish.
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (
  cb: FrameRequestCallback,
) => setTimeout(() => cb(0), 0) as unknown as number;

const FM_SCHEMA = {
  properties: {
    category: { enum: ["news", "guide"] },
    date: { format: "date", type: "string" },
    draft: { type: "boolean" },
    tags: { type: "array" },
    title: { type: "string" },
  },
  required: ["title"],
};

let canvasMode = "edit";

function setShell(withPanelHost = true) {
  document.body.innerHTML = `<div id="app">
    <div id="toolbar"></div><div id="tab-bar"></div>
    ${withPanelHost ? '<div id="frontmatter-panel" hidden></div>' : ""}
    <div id="activity-bar"></div><div id="left-panel"></div>
    <div id="canvas-wrap"></div><div id="right-panel"></div><div id="chat-panel"></div>
    <div id="statusbar"></div>
  </div>`;
  initShellRefs();
}

function setupContentTab(
  frontmatter: Record<string, unknown>,
  opts: { withSchema?: boolean; documentPath?: string; id?: string } = {},
) {
  resetStudioState({
    projectConfig:
      opts.withSchema === false
        ? {}
        : { content: { posts: { format: "json", schema: FM_SCHEMA, source: "./posts" } } },
  });
  const tab = resetWorkspaceWithTab(undefined, {
    documentPath: opts.documentPath ?? "posts/hello.json",
    id: opts.id ?? "fm-tab",
  }) as any;
  tab.doc.mode = "content";
  tab.doc.content.frontmatter = frontmatter;
  return tab;
}

function fireChange(el: Element, value: string): void {
  (el as any).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function row(prop: string): HTMLElement {
  const el = frontmatterPanelEl.querySelector(`[data-prop="${prop}"]`);
  if (!el) {
    throw new Error(`row not found: ${prop}`);
  }
  return el as HTMLElement;
}

beforeEach(() => {
  setShell();
  installMockPlatform();
  canvasMode = "edit";
});

afterEach(() => {
  unmount();
  closeAllTabs();
});

async function mountAndFlush() {
  mount({ getCanvasMode: () => canvasMode });
  render();
  await flush(4);
}

describe("eligibility gating", () => {
  test("visible with accordion + collection label for an eligible content tab", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    expect(frontmatterPanelEl.hidden).toBe(false);
    const item = frontmatterPanelEl.querySelector("sp-accordion-item")!;
    expect(item).toBeTruthy();
    expect(item.getAttribute("label")).toBe("Properties · posts");
  });

  test("hidden in component mode", async () => {
    const tab = setupContentTab({ title: "Hello" });
    tab.doc.mode = "component";
    await mountAndFlush();
    expect(frontmatterPanelEl.hidden).toBe(true);
    expect(frontmatterPanelEl.querySelector("sp-accordion")).toBeNull();
  });

  test("hidden when the canvas mode is not edit (design, preview)", async () => {
    setupContentTab({ title: "Hello" });
    for (const mode of ["design", "preview", "source"]) {
      canvasMode = mode;
      await mountAndFlush();
      expect(frontmatterPanelEl.hidden).toBe(true);
      unmount();
    }
  });

  test("hidden when the document matches no content collection", async () => {
    setupContentTab({ title: "Hello" }, { withSchema: false });
    await mountAndFlush();
    expect(frontmatterPanelEl.hidden).toBe(true);
  });

  test("hidden when the path is outside the collection source", async () => {
    setupContentTab({ title: "Hello" }, { documentPath: "pages/about.json" });
    await mountAndFlush();
    expect(frontmatterPanelEl.hidden).toBe(true);
  });

  test("hidden with no active tab; mount without a host element is a no-op", async () => {
    resetStudioState({ projectConfig: {} });
    closeAllTabs();
    await mountAndFlush();
    expect(frontmatterPanelEl.hidden).toBe(true);
    unmount();

    setShell(false);
    mount({ getCanvasMode: () => "edit" });
    render(); // Must not throw with no host bound
  });
});

describe("field rendering", () => {
  test("title is NOT reserved here (unlike the Document tab) and required fields are marked", async () => {
    setupContentTab({ title: "My Post" });
    await mountAndFlush();
    const titleRow = row("title");
    expect((titleRow.querySelector("sp-textfield") as any).value).toBe("My Post");
    expect(titleRow.querySelector("sp-field-label")?.textContent).toBe("Title *");
  });

  test("schema fields render typed widgets; extra keys render as inferred fields", async () => {
    setupContentTab({ extra: "loose", tags: ["a", "b"] });
    await mountAndFlush();
    expect(row("draft").querySelector("sp-checkbox")).toBeTruthy();
    expect(row("category").querySelector("sp-picker")).toBeTruthy();
    expect((row("tags").querySelector("sp-textfield") as any).value).toBe("a, b");
    expect(row("date").querySelector("sp-textfield")?.getAttribute("placeholder")).toBe(
      "YYYY-MM-DD",
    );
    expect((row("extra").querySelector("sp-textfield") as any).value).toBe("loose");
  });

  test("image field's Browse button appears once the async media cache resolves", async () => {
    // The Browse button is gated on the async-loaded media cache; when the listing resolves,
    // Media-picker repaints host panels via renderOnly — the frontmatter panel must be included.
    invalidateMediaCache();
    installMockPlatform({}, { "public/hero.jpg": "img-bytes" });
    resetStudioState({
      projectConfig: {
        content: {
          posts: {
            format: "json",
            schema: { properties: { hero: { format: "image", type: "string" } } },
            source: "./posts",
          },
        },
      },
    });
    const tab = resetWorkspaceWithTab(undefined, {
      documentPath: "posts/hello.json",
      id: "fm-media",
    }) as any;
    tab.doc.mode = "content";
    tab.doc.content.frontmatter = { hero: "/hero.jpg" };
    registerRenderer("frontmatterPanel", () => render());

    await mountAndFlush();
    await flush(6); // Async media listing resolves → renderOnly("frontmatterPanel") repaints
    expect(row("hero").querySelector(".media-picker")).toBeTruthy();
    expect(row("hero").querySelector('sp-action-button[title="Browse media"]')).toBeTruthy();
  });

  test("collectFmFields with an empty reserved set includes title; $-keys always skipped", () => {
    const tab = setupContentTab({ $paths: ["x"], title: "T" });
    const { fields, hasSchema, requiredFields } = collectFmFields(
      tab,
      { content: { posts: { format: "json", schema: FM_SCHEMA, source: "./posts" } } } as any,
      new Set<string>(),
    );
    expect(hasSchema).toBe(true);
    const names = fields.map((f) => f.field);
    expect(names).toContain("title");
    expect(names).not.toContain("$paths");
    expect(requiredFields.has("title")).toBe(true);
  });
});

describe("commits and reactivity", () => {
  test("text field commit updates frontmatter and marks the tab dirty", async () => {
    const tab = setupContentTab({ title: "Old" });
    await mountAndFlush();
    expect(tab.doc.dirty).toBe(false);
    fireChange(row("title").querySelector("sp-textfield")!, "New");
    expect(tab.doc.content.frontmatter.title).toBe("New");
    expect(tab.doc.dirty).toBe(true);
  });

  test("checkbox commit sets a boolean; clear dot deletes the key", async () => {
    const tab = setupContentTab({ draft: true });
    await mountAndFlush();
    const dot = row("draft").querySelector(".set-dot")!;
    dot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect("draft" in tab.doc.content.frontmatter).toBe(false);
  });

  test("external frontmatter change re-renders the panel reactively", async () => {
    const tab = setupContentTab({ title: "Before" });
    await mountAndFlush();
    transactDoc(tab, (t: any) => mutateUpdateFrontmatter(t, "title", "After"));
    await flush(4);
    expect((row("title").querySelector("sp-textfield") as any).value).toBe("After");
  });

  test("unmount stops reactive re-rendering", async () => {
    const tab = setupContentTab({ title: "Before" });
    await mountAndFlush();
    unmount();
    transactDoc(tab, (t: any) => mutateUpdateFrontmatter(t, "title", "After"));
    await flush(4);
    expect((row("title").querySelector("sp-textfield") as any).value).toBe("Before");
  });
});

describe("accordion collapse persistence", () => {
  test("toggle writes tab.session.ui.frontmatterOpen and it is per-tab", async () => {
    const tabA = setupContentTab({ title: "A" });
    await mountAndFlush();
    expect(tabA.session.ui.frontmatterOpen).toBe(true);

    const item = frontmatterPanelEl.querySelector("sp-accordion-item") as HTMLElement & {
      open: boolean;
    };
    item.open = false;
    item.dispatchEvent(new Event("sp-accordion-item-toggle"));
    expect(tabA.session.ui.frontmatterOpen).toBe(false);

    // A second tab starts with its own default-open state.
    const tabB = openTab({
      document: { tagName: "div" },
      documentPath: "posts/second.json",
      id: "fm-tab-b",
    }) as any;
    tabB.doc.mode = "content";
    tabB.doc.content.frontmatter = { title: "B" };
    await flush(4);
    expect(tabB.session.ui.frontmatterOpen).toBe(true);
    const itemB = frontmatterPanelEl.querySelector("sp-accordion-item");
    expect(itemB?.hasAttribute("open")).toBe(true);

    // Switching back re-renders with tab A's collapsed state intact.
    activateTab(tabA.id);
    render();
    await flush(4);
    expect(tabA.session.ui.frontmatterOpen).toBe(false);
    const itemA = frontmatterPanelEl.querySelector("sp-accordion-item");
    expect(itemA?.hasAttribute("open")).toBe(false);
  });
});
