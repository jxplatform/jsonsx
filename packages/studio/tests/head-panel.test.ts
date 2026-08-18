import {
  flush,
  installMockPlatform,
  pointer,
  renderInto,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  BUILD_FALLBACK_TITLE,
  buildSeoPreview,
  invalidateLayoutHeadCache,
  invalidateLayoutPickerCache,
  layoutDisplayName,
  layoutHeadEntries,
  renderHeadTemplate,
  resolveMetaField,
  resolveSeoUrl,
  resolveTitleField,
  seoField,
  seoPreviewFor,
  visibleLength,
} from "../src/panels/head-panel";
import { invalidateLayoutCache } from "../src/site-context";
import { closeAllTabs } from "../src/workspace/workspace";

import type { HeadLayers, SeoPreview } from "../src/panels/head-panel";
import type { Tab } from "../src/tabs/tab";
import type { JxHeadEntry, JxMutableNode } from "@jxsuite/schema/types";

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

interface RenderResult {
  container: HTMLElement;
  doc: JxMutableNode;
  mutations: number;
  leftPanelRenders: number;
}

/** Render the head panel template around a doc, applying mutations directly to it. */
async function renderHead(doc: Record<string, unknown>): Promise<RenderResult> {
  const result: RenderResult = {
    container: document.createElement("div"),
    doc: doc as unknown as JxMutableNode,
    leftPanelRenders: 0,
    mutations: 0,
  };
  await renderInto(
    renderHeadTemplate({
      applyMutation: (fn) => {
        result.mutations += 1;
        fn(result.doc);
      },
      document: result.doc,
      renderLeftPanel: () => {
        result.leftPanelRenders += 1;
      },
    }),
    result.container,
  );
  return result;
}

function sectionByTitle(container: HTMLElement, title: string): HTMLElement | null {
  for (const sec of container.querySelectorAll(".imports-section")) {
    const t = sec.querySelector(".imports-section-title")?.textContent ?? "";
    if (t.startsWith(title)) {
      return sec as HTMLElement;
    }
  }
  return null;
}

function row(scope: ParentNode, prop: string): HTMLElement {
  const el = scope.querySelector(`[data-prop="${prop}"]`);
  if (!el) {
    throw new Error(`row not found: ${prop}`);
  }
  return el as HTMLElement;
}

function fireChange(el: Element, value: string): void {
  (el as any).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function metaContent(doc: any, attr: string, keyName: string): string | undefined {
  const entry = (doc.$head ?? []).find(
    (e: any) => e?.tagName === "meta" && e?.attributes?.[attr] === keyName,
  );
  return entry?.attributes?.content;
}

beforeEach(() => {
  installMockPlatform();
  resetStudioState();
  closeAllTabs();
  invalidateLayoutPickerCache();
});

// ─── Page section ─────────────────────────────────────────────────────────────

describe("page section", () => {
  test("renders title with set-dot when present; clearing deletes doc.title", async () => {
    const { container, doc } = await renderHead({ tagName: "div", title: "Hello" });
    const titleRow = row(container, "title");
    expect(titleRow.querySelector("sp-field-label")?.textContent).toBe("Title");
    const dot = titleRow.querySelector(".set-dot");
    expect(dot).toBeTruthy();
    pointer(dot!, "click");
    expect((doc as any).title).toBeUndefined();
  });

  test("committing a title sets doc.title; whitespace-only deletes it", async () => {
    const { container, doc } = await renderHead({ tagName: "div" });
    expect(row(container, "title").querySelector(".set-dot")).toBeNull();
    const field = row(container, "title").querySelector("sp-textfield")!;
    fireChange(field, "My Page");
    expect((doc as any).title).toBe("My Page");
    fireChange(field, "   ");
    expect((doc as any).title).toBeUndefined();
  });

  test("description meta upserts: add, replace in place, then remove", async () => {
    const { container, doc } = await renderHead({ tagName: "div" });
    const field = row(container, "description").querySelector("sp-textfield")!;
    fireChange(field, "First");
    expect(metaContent(doc, "name", "description")).toBe("First");
    expect((doc as any).$head.length).toBe(1);
    fireChange(field, "Second");
    expect(metaContent(doc, "name", "description")).toBe("Second");
    expect((doc as any).$head.length).toBe(1); // Replaced, not appended
    fireChange(field, "");
    expect(metaContent(doc, "name", "description")).toBeUndefined();
    expect((doc as any).$head.length).toBe(0);
  });

  test("viewport field gets the canonical placeholder", async () => {
    const { container } = await renderHead({ tagName: "div" });
    const field = row(container, "viewport").querySelector("sp-textfield")!;
    expect(field.getAttribute("placeholder")).toBe("width=device-width, initial-scale=1");
  });

  test("icon row shows media picker; clear dot removes the link entry", async () => {
    const head: JxHeadEntry[] = [
      { attributes: { href: "/favicon.ico", rel: "icon" }, tagName: "link" },
    ];
    const { container, doc } = await renderHead({ $head: head, tagName: "div" });
    const iconRow = row(container, "icon");
    expect(iconRow.querySelector(".media-picker")).toBeTruthy();
    pointer(iconRow.querySelector(".set-dot")!, "click");
    expect((doc as any).$head.length).toBe(0);
  });

  test("icon media picker input upserts the link entry (add then replace)", async () => {
    const { container, doc } = await renderHead({ tagName: "div" });
    const field = row(container, "icon").querySelector(".media-picker sp-textfield")!;
    withImmediateTimers(() => {
      (field as any).value = "/icon.svg";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const link = (doc as any).$head.find((e: any) => e?.attributes?.rel === "icon");
    expect(link?.attributes?.href).toBe("/icon.svg");
    withImmediateTimers(() => {
      (field as any).value = "/icon2.svg";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect((doc as any).$head.filter((e: any) => e?.attributes?.rel === "icon").length).toBe(1);
    expect((doc as any).$head[0].attributes.href).toBe("/icon2.svg");
  });
});

// ─── OpenGraph section ────────────────────────────────────────────────────────

describe("opengraph section", () => {
  test("og:description renders multiline; og:image renders a media picker", async () => {
    const { container } = await renderHead({ tagName: "div" });
    const og = sectionByTitle(container, "OpenGraph")!;
    const descField = row(og, "og:description").querySelector("sp-textfield")!;
    expect(descField.hasAttribute("multiline")).toBe(true);
    expect(row(og, "og:image").querySelector(".media-picker")).toBeTruthy();
  });

  test("og:image media picker commits a meta entry and its dot clears it", async () => {
    const head: JxHeadEntry[] = [
      { attributes: { content: "/old.png", property: "og:image" }, tagName: "meta" },
    ];
    const { container, doc } = await renderHead({ $head: head, tagName: "div" });
    const og = sectionByTitle(container, "OpenGraph")!;
    const imageRow = row(og, "og:image");
    const field = imageRow.querySelector(".media-picker sp-textfield")!;
    withImmediateTimers(() => {
      (field as any).value = "/new.png";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(metaContent(doc, "property", "og:image")).toBe("/new.png");
    pointer(imageRow.querySelector(".set-dot")!, "click");
    expect(metaContent(doc, "property", "og:image")).toBeUndefined();
  });

  test("og:title shows the existing value, commits trimmed updates, dot clears", async () => {
    const head: JxHeadEntry[] = [
      { attributes: { content: "Old", property: "og:title" }, tagName: "meta" },
    ];
    const { container, doc } = await renderHead({ $head: head, tagName: "div" });
    const og = sectionByTitle(container, "OpenGraph")!;
    const titleRow = row(og, "og:title");
    expect((titleRow.querySelector("sp-textfield") as any).value).toBe("Old");
    fireChange(titleRow.querySelector("sp-textfield")!, "  New OG  ");
    expect(metaContent(doc, "property", "og:title")).toBe("New OG");
    pointer(titleRow.querySelector(".set-dot")!, "click");
    expect(metaContent(doc, "property", "og:title")).toBeUndefined();
  });
});

// ─── Custom entries ───────────────────────────────────────────────────────────

describe("custom $head entries", () => {
  const managed: JxHeadEntry[] = [
    { attributes: { content: "d", name: "description" }, tagName: "meta" },
    { attributes: { content: "t", property: "og:title" }, tagName: "meta" },
    { attributes: { href: "/f.ico", rel: "icon" }, tagName: "link" },
  ];
  const fonts: JxHeadEntry[] = [
    {
      attributes: {
        href: "https://fonts.googleapis.com/css2?family=Inter&display=swap",
        rel: "stylesheet",
      },
      tagName: "link",
    },
    { attributes: { href: "https://fonts.googleapis.com", rel: "preconnect" }, tagName: "link" },
    {
      attributes: { crossorigin: "", href: "https://fonts.gstatic.com", rel: "preconnect" },
      tagName: "link",
    },
  ];
  const custom: JxHeadEntry[] = [
    { attributes: { charset: "utf8" }, tagName: "meta" },
    { attributes: { src: "/app.js" }, tagName: "script" },
    { attributes: { href: "/c", rel: "canonical" }, tagName: "link" },
    { attributes: { content: "Jx", name: "generator" }, tagName: "meta" },
    { attributes: { content: "x", property: "og:custom" }, tagName: "meta" },
    { tagName: "style", textContent: ".a{color:red}" } as JxHeadEntry,
  ];

  test("filters managed/font entries and labels each custom entry", async () => {
    const { container } = await renderHead({
      $head: [...managed, ...fonts, ...custom],
      tagName: "div",
    });
    const section = sectionByTitle(container, "Custom Tags")!;
    expect(section.querySelector(".imports-count")?.textContent).toBe("6");
    const names = [...section.querySelectorAll(".import-name")].map((n) => n.textContent);
    expect(names).toEqual([
      '<meta charset="utf8">',
      '<script src="/app.js">',
      '<link rel="canonical">',
      '<meta name="generator">',
      '<meta property="og:custom">',
      "<style>",
    ]);
    const values = [...section.querySelectorAll(".import-path")].map((n) => n.textContent);
    expect(values).toEqual(["", "/app.js", "/c", "Jx", "x", ".a{color:red}"]);
  });

  test("an entry without a tagName is labeled unknown", async () => {
    const { container } = await renderHead({
      $head: [{ textContent: "?" } as unknown as JxHeadEntry],
      tagName: "div",
    });
    const section = sectionByTitle(container, "Custom Tags")!;
    expect(section.querySelector(".import-name")?.textContent).toBe("unknown");
  });

  test("shows empty message when there are no custom entries", async () => {
    const { container } = await renderHead({ $head: [...managed], tagName: "div" });
    const section = sectionByTitle(container, "Custom Tags")!;
    expect(section.querySelector(".empty-state-message")?.textContent).toContain(
      "Custom tags add your own meta, link and script elements",
    );
    expect(section.querySelector(".imports-count")?.textContent).toBe("0");
  });

  test("remove button splices the entry and re-renders the left panel", async () => {
    const result = await renderHead({ $head: [...custom], tagName: "div" });
    const section = sectionByTitle(result.container, "Custom Tags")!;
    const firstRemove = section.querySelector(".import-row sp-action-button")!;
    pointer(firstRemove, "click");
    expect((result.doc as any).$head.length).toBe(5);
    expect((result.doc as any).$head.some((e: any) => e?.attributes?.charset === "utf8")).toBe(
      false,
    );
    expect(result.leftPanelRenders).toBe(1);
  });
});

// ─── Add custom tag form ──────────────────────────────────────────────────────

describe("add custom tag form", () => {
  test("adds a meta entry by default and clears the inputs", async () => {
    const result = await renderHead({ tagName: "div" });
    const form = result.container.querySelector(".head-add-form")!;
    const attr = form.querySelector(".head-add-attr") as any;
    const val = form.querySelector(".head-add-val") as any;
    attr.value = "author";
    val.value = "Jane";
    pointer(form.querySelector("sp-action-button")!, "click");
    expect((result.doc as any).$head).toEqual([
      { attributes: { content: "Jane", name: "author" }, tagName: "meta" },
    ]);
    expect(attr.value).toBe("");
    expect(val.value).toBe("");
    expect(result.leftPanelRenders).toBe(1);
  });

  test("adds link and script entries with the right attribute mapping", async () => {
    const result = await renderHead({ tagName: "div" });
    const form = result.container.querySelector(".head-add-form")!;
    const picker = form.querySelector(".head-add-tag") as any;
    const attr = form.querySelector(".head-add-attr") as any;
    const val = form.querySelector(".head-add-val") as any;
    const button = form.querySelector("sp-action-button")!;

    picker.value = "link";
    attr.value = "preload";
    val.value = "/x.css";
    pointer(button, "click");
    expect((result.doc as any).$head.at(-1)).toEqual({
      attributes: { href: "/x.css", rel: "preload" },
      tagName: "link",
    });

    picker.value = "script";
    attr.value = "src";
    val.value = "/x.js";
    pointer(button, "click");
    expect((result.doc as any).$head.at(-1)).toEqual({
      attributes: { src: "/x.js" },
      tagName: "script",
    });
  });

  test("does nothing when attribute or value is missing", async () => {
    const result = await renderHead({ tagName: "div" });
    const form = result.container.querySelector(".head-add-form")!;
    const attr = form.querySelector(".head-add-attr") as any;
    const val = form.querySelector(".head-add-val") as any;
    attr.value = "only-attr";
    val.value = "  ";
    pointer(form.querySelector("sp-action-button")!, "click");
    expect((result.doc as any).$head).toBeUndefined();
    expect(result.mutations).toBe(0);
  });
});

// ─── Layout section ───────────────────────────────────────────────────────────

function layoutDirEntries() {
  return [
    { name: "main-layout.json", path: "layouts/main-layout.json", type: "file" },
    { name: "blog.json", path: "layouts/blog.json", type: "file" },
    { name: "partials", path: "layouts/partials", type: "directory" },
    { name: "notes.txt", path: "layouts/notes.txt", type: "file" },
  ] as any[];
}

function setupSitePage(documentPath = "pages/about.json") {
  const counters = { layoutLists: 0 };
  installMockPlatform({
    listDirectory: async (dir: string) => {
      if (dir === "layouts") {
        counters.layoutLists += 1;
        return layoutDirEntries() as any;
      }
      return [];
    },
  } as any);
  resetStudioState({
    isSiteProject: true,
    projectConfig: { defaults: { layout: "./layouts/main-layout.json" } },
  });
  resetWorkspaceWithTab(undefined, { documentPath });
  return counters;
}

describe("layout section", () => {
  test("absent for non-site projects and non-page paths", async () => {
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    resetWorkspaceWithTab(undefined, { documentPath: "components/x.json" });
    let { container } = await renderHead({ tagName: "div" });
    expect(sectionByTitle(container, "Layout")).toBeNull();

    resetStudioState({ isSiteProject: false, projectConfig: {} });
    resetWorkspaceWithTab(undefined, { documentPath: "pages/x.json" });
    ({ container } = await renderHead({ tagName: "div" }));
    expect(sectionByTitle(container, "Layout")).toBeNull();
  });

  test("first render kicks off the layout listing; second render shows the picker", async () => {
    const counters = setupSitePage();
    const first = await renderHead({ tagName: "div" });
    expect(sectionByTitle(first.container, "Layout")).toBeNull(); // Still loading
    await flush();
    expect(counters.layoutLists).toBe(1);

    const second = await renderHead({ tagName: "div" });
    const section = sectionByTitle(second.container, "Layout")!;
    const items = [...section.querySelectorAll("sp-menu-item")].map((i) => i.textContent?.trim());
    expect(items[0]).toBe("Default (Main Layout)");
    expect(items[1]).toBe("None");
    expect(items.slice(2)).toEqual(["Main Layout", "Blog"]); // Only .json files, prettified
    expect(section.querySelector("sp-picker")?.getAttribute("value")).toBe("__default__");
  });

  test("works with ./pages/ prefixed paths and reflects explicit/false layouts", async () => {
    setupSitePage("./pages/about.json");
    await renderHead({ tagName: "div" });
    await flush();

    let { container } = await renderHead({
      $layout: "./layouts/blog.json",
      tagName: "div",
    });
    let picker = sectionByTitle(container, "Layout")!.querySelector("sp-picker")!;
    expect(picker.getAttribute("value")).toBe("./layouts/blog.json");

    ({ container } = await renderHead({ $layout: false, tagName: "div" }));
    picker = sectionByTitle(container, "Layout")!.querySelector("sp-picker")!;
    expect(picker.getAttribute("value")).toBe("__none__");
  });

  test("picker changes write $layout: path, false, or delete", async () => {
    setupSitePage();
    await renderHead({ tagName: "div" });
    await flush();
    const result = await renderHead({ tagName: "div" });
    const picker = sectionByTitle(result.container, "Layout")!.querySelector("sp-picker")!;

    fireChange(picker, "./layouts/blog.json");
    expect((result.doc as any).$layout).toBe("./layouts/blog.json");
    fireChange(picker, "__none__");
    expect((result.doc as any).$layout).toBe(false);
    fireChange(picker, "__default__");
    expect("$layout" in (result.doc as any)).toBe(false);
  });

  test("clear dot removes an explicit $layout", async () => {
    setupSitePage();
    await renderHead({ tagName: "div" });
    await flush();
    const result = await renderHead({ $layout: "./layouts/blog.json", tagName: "div" });
    const section = sectionByTitle(result.container, "Layout")!;
    pointer(section.querySelector(".set-dot")!, "click");
    expect((result.doc as any).$layout).toBeUndefined();
  });

  test("listing failure falls back to an empty layout list", async () => {
    installMockPlatform({
      listDirectory: async () => {
        throw new Error("boom");
      },
    } as any);
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    resetWorkspaceWithTab(undefined, { documentPath: "pages/p.json" });
    await renderHead({ tagName: "div" });
    await flush();
    const { container } = await renderHead({ tagName: "div" });
    const section = sectionByTitle(container, "Layout")!;
    const items = [...section.querySelectorAll("sp-menu-item")].map((i) => i.textContent?.trim());
    expect(items).toEqual(["Default", "None"]); // No default label without config
  });

  test("invalidateLayoutPickerCache forces a reload on next render", async () => {
    const counters = setupSitePage();
    await renderHead({ tagName: "div" });
    await flush();
    invalidateLayoutPickerCache();
    const { container } = await renderHead({ tagName: "div" });
    expect(sectionByTitle(container, "Layout")).toBeNull(); // Loading again
    await flush();
    expect(counters.layoutLists).toBe(2);
  });
});

// ─── Frontmatter section ──────────────────────────────────────────────────────

const FM_SCHEMA = {
  properties: {
    category: { enum: ["news", "guide"] },
    date: { format: "date", type: "string" },
    description: { type: "string" },
    draft: { type: "boolean" },
    hero: { format: "image", type: "string" },
    tags: { type: "array" },
    title: { type: "string" },
    weight: { type: "number" },
  },
  required: ["description"],
};

function setupContentTab(
  frontmatter: Record<string, unknown>,
  withSchema = true,
  documentPath = "posts/hello.json",
) {
  installMockPlatform();
  resetStudioState({
    projectConfig: withSchema
      ? { content: { posts: { format: "json", schema: FM_SCHEMA, source: "./posts" } } }
      : {},
  });
  closeAllTabs();
  const tab = resetWorkspaceWithTab(undefined, { documentPath });
  (tab as any).doc.mode = "content";
  (tab as any).doc.content.frontmatter = frontmatter;
  return tab as any;
}

describe("frontmatter section", () => {
  test("hidden in component mode even when frontmatter exists", async () => {
    const tab = setupContentTab({ description: "x" });
    tab.doc.mode = "component";
    const { container } = await renderHead({ tagName: "div" });
    expect(sectionByTitle(container, "Frontmatter")).toBeNull();
  });

  test("schema-driven fields render with type-specific widgets and required marker", async () => {
    setupContentTab({ draft: true, extra: "loose", tags: ["a", "b"], title: "skip me" });
    const { container } = await renderHead({ tagName: "div" });
    const section = sectionByTitle(container, "Frontmatter (posts)")!;
    expect(section).toBeTruthy();
    expect(section.querySelector('[data-prop="title"]')).toBeNull(); // Reserved
    expect(row(section, "draft").querySelector("sp-checkbox")).toBeTruthy();
    expect((row(section, "tags").querySelector("sp-textfield") as any).value).toBe("a, b");
    expect(row(section, "category").querySelector("sp-picker")).toBeTruthy();
    const catOptions = [...row(section, "category").querySelectorAll("sp-menu-item")].map(
      (i) => i.textContent,
    );
    expect(catOptions).toEqual(["news", "guide"]);
    expect(row(section, "hero").querySelector(".media-picker")).toBeTruthy();
    expect(row(section, "weight").querySelector("sp-number-field")).toBeTruthy();
    expect(row(section, "date").querySelector("sp-textfield")?.getAttribute("placeholder")).toBe(
      "YYYY-MM-DD",
    );
    expect(row(section, "description").querySelector("sp-field-label")?.textContent).toBe(
      "Description *",
    );
    // Loose fm key not in schema still renders as a string field
    expect((row(section, "extra").querySelector("sp-textfield") as any).value).toBe("loose");
  });

  test("matches the content type when the document path uses Windows backslashes", async () => {
    // The desktop platform on Windows hands the studio backslash paths.
    // Format-driven widgets (e.g. the image picker) must still resolve from the schema.
    setupContentTab({ hero: "x.png" }, true, String.raw`posts\hello.json`);
    const { container } = await renderHead({ tagName: "div" });
    const section = sectionByTitle(container, "Frontmatter (posts)")!;
    expect(section).toBeTruthy();
    expect(row(section, "hero").querySelector(".media-picker")).toBeTruthy();
  });

  test("checkbox toggles boolean frontmatter; unchecking deletes the field", async () => {
    const tab = setupContentTab({});
    const { container } = await renderHead({ tagName: "div" });
    const section = sectionByTitle(container, "Frontmatter")!;
    const checkbox = row(section, "draft").querySelector("sp-checkbox") as any;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(tab.doc.content.frontmatter.draft).toBe(true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect("draft" in tab.doc.content.frontmatter).toBe(false);
  });

  test("array field parses comma-separated input and clears on empty", async () => {
    const tab = setupContentTab({});
    const { container } = await renderHead({ tagName: "div" });
    const section = sectionByTitle(container, "Frontmatter")!;
    const field = row(section, "tags").querySelector("sp-textfield")!;
    fireChange(field, "x, y ,, z");
    expect(tab.doc.content.frontmatter.tags).toEqual(["x", "y", "z"]);
    fireChange(field, "");
    expect("tags" in tab.doc.content.frontmatter).toBe(false);
  });

  test("enum picker sets and clears the field", async () => {
    const tab = setupContentTab({ category: "news" });
    const { container } = await renderHead({ tagName: "div" });
    const section = sectionByTitle(container, "Frontmatter")!;
    const picker = row(section, "category").querySelector("sp-picker")!;
    fireChange(picker, "guide");
    expect(tab.doc.content.frontmatter.category).toBe("guide");
    fireChange(picker, "");
    expect("category" in tab.doc.content.frontmatter).toBe(false);
  });

  test("number field commits numbers and deletes on empty or NaN", async () => {
    const tab = setupContentTab({ weight: 1 });
    const { container } = await renderHead({ tagName: "div" });
    const section = sectionByTitle(container, "Frontmatter")!;
    const field = row(section, "weight").querySelector("sp-number-field")!;
    fireChange(field, "42");
    expect(tab.doc.content.frontmatter.weight).toBe(42);
    fireChange(field, "");
    expect("weight" in tab.doc.content.frontmatter).toBe(false);
    fireChange(field, "abc");
    expect("weight" in tab.doc.content.frontmatter).toBe(false);
  });

  test("string field commits text; clear dot deletes the value", async () => {
    const tab = setupContentTab({ description: "old" });
    const { container } = await renderHead({ tagName: "div" });
    const section = sectionByTitle(container, "Frontmatter")!;
    const descRow = row(section, "description");
    fireChange(descRow.querySelector("sp-textfield")!, "fresh");
    expect(tab.doc.content.frontmatter.description).toBe("fresh");

    // Re-render to get a dot bound to the new value, then clear it.
    const second = await renderHead({ tagName: "div" });
    const dot = row(sectionByTitle(second.container, "Frontmatter")!, "description").querySelector(
      ".set-dot",
    )!;
    pointer(dot, "click");
    expect("description" in tab.doc.content.frontmatter).toBe(false);
  });

  test("without a schema, fields are inferred from frontmatter values", async () => {
    setupContentTab(
      { $hidden: "skip", published: false, publishDate: "2026-01-01", title: "skip" },
      false,
    );
    const { container } = await renderHead({ tagName: "div" });
    const section = sectionByTitle(container, "Frontmatter")!;
    expect(section.querySelector(".imports-section-title")?.textContent).toBe("Frontmatter");
    expect(row(section, "published").querySelector("sp-checkbox")).toBeTruthy();
    expect(row(section, "publishDate").querySelector("sp-field-label")?.textContent).toBe(
      "Publish Date",
    );
    expect(section.querySelector('[data-prop="$hidden"]')).toBeNull();
    expect(section.querySelector('[data-prop="title"]')).toBeNull();
  });

  test("section is omitted entirely with no schema and no displayable fields", async () => {
    setupContentTab({ $internal: "x", title: "only reserved" }, false);
    const { container } = await renderHead({ tagName: "div" });
    expect(sectionByTitle(container, "Frontmatter")).toBeNull();
  });
});

// ─── The merged `$head`, as a preview model ───────────────────────────────────

/**
 * The half of the SEO block that has no DOM: resolving what actually reaches the browser out of
 * site → layout → page, and naming the layer it came from.
 *
 * These assertions are the contract with `packages/compiler/src/site/head-merger.ts`. Studio does
 * not depend on `@jxsuite/compiler`, so nothing mechanical keeps the two in step — this is what
 * fails if the merger's precedence, its `<title>` handling or its canonical rule ever changes.
 */

const meta = (attr: "name" | "property", key: string, content: string): JxHeadEntry => ({
  attributes: { [attr]: key, content },
  tagName: "meta",
});

function layers(over: Partial<HeadLayers> = {}): HeadLayers {
  return { layout: [], layoutName: null, page: [], site: [], ...over };
}

function warningIds(preview: SeoPreview): string[] {
  return preview.warnings.map((w) => w.id);
}

describe("resolveMetaField — later layer wins, and says which one spoke", () => {
  test("the page's own entry is `set here`, with no donor to name", () => {
    const field = resolveMetaField(
      layers({
        page: [meta("name", "description", "the page")],
        site: [meta("name", "description", "the site")],
      }),
      "name",
      "description",
    );
    expect(field).toEqual({ donor: null, source: "page", value: "the page" });
  });

  test("a layout entry is inherited from the layout, by name", () => {
    const field = resolveMetaField(
      layers({ layout: [meta("name", "description", "from base")], layoutName: "Base" }),
      "name",
      "description",
    );
    expect(field).toEqual({ donor: "Base", source: "layout", value: "from base" });
  });

  test("an unnamed layout still names itself as something", () => {
    const field = resolveMetaField(
      layers({ layout: [meta("name", "description", "x")] }),
      "name",
      "description",
    );
    expect(field.donor).toBe("the layout");
  });

  test("a site entry is inherited from Site head", () => {
    const field = resolveMetaField(
      layers({ site: [meta("property", "og:image", "/card.png")] }),
      "property",
      "og:image",
    );
    expect(field).toEqual({ donor: "Site head", source: "site", value: "/card.png" });
  });

  test("nothing anywhere resolves to `none`, not to an empty page value", () => {
    expect(resolveMetaField(layers(), "name", "description").source).toBe("none");
  });

  test("the LAST entry in a layer wins — the merger folds a layer into a keyed map in order", () => {
    const field = resolveMetaField(
      layers({
        page: [meta("name", "description", "first"), meta("name", "description", "second")],
      }),
      "name",
      "description",
    );
    expect(field.value).toBe("second");
  });

  test("an empty page entry SHADOWS the site's, because the merged map is keyed", () => {
    const field = resolveMetaField(
      layers({
        page: [meta("name", "description", "")],
        site: [meta("name", "description", "the site")],
      }),
      "name",
      "description",
    );
    expect(field).toEqual({ donor: null, source: "page", value: "" });
  });
});

describe("resolveTitleField — page title, then the site name, then the build", () => {
  test("the page's title wins and is trimmed", () => {
    expect(resolveTitleField("  Hello  ", "Acme")).toEqual({
      donor: null,
      source: "page",
      value: "Hello",
    });
  });

  test("a blank page title falls through to the site name", () => {
    expect(resolveTitleField("   ", "Acme")).toEqual({
      donor: "Site name",
      source: "site",
      value: "Acme",
    });
  });

  test("with neither, the build supplies one and is named as the donor", () => {
    expect(resolveTitleField("")).toEqual({
      donor: "the build",
      source: "build",
      value: BUILD_FALLBACK_TITLE,
    });
    expect(resolveTitleField("", "   ")).toEqual({
      donor: "the build",
      source: "build",
      value: BUILD_FALLBACK_TITLE,
    });
  });
});

describe("resolveSeoUrl — the canonical the build would emit, or the honest absence", () => {
  test("a site URL and a route produce a breadcrumb, a host and an href", () => {
    expect(resolveSeoUrl("/blog/hello", "https://example.com")).toEqual({
      crumb: "example.com › blog › hello",
      host: "example.com",
      href: "https://example.com/blog/hello",
    });
  });

  test("the site root is just the host", () => {
    expect(resolveSeoUrl("/", "https://example.com").crumb).toBe("example.com");
  });

  test("no site URL means no canonical — the build emits none either", () => {
    expect(resolveSeoUrl("/blog/hello")).toEqual({
      crumb: "/blog/hello",
      host: "",
      href: null,
    });
  });

  test("a document with no route (not a page) has no canonical", () => {
    expect(resolveSeoUrl(null, "https://example.com")).toEqual({
      crumb: "/",
      host: "",
      href: null,
    });
  });

  test("a malformed site URL degrades to the route instead of throwing", () => {
    expect(resolveSeoUrl("/about", "not a url")).toEqual({
      crumb: "/about",
      host: "",
      href: null,
    });
  });
});

describe("buildSeoPreview — the six fields, in render order, with their budgets", () => {
  test("every previewed key is present, once, with the limit that applies to it", () => {
    const preview = buildSeoPreview(layers(), { pageTitle: "T", route: "/" });
    expect(preview.fields.map((f) => f.key)).toEqual([
      "title",
      "description",
      "og:title",
      "og:description",
      "og:image",
      "og:type",
    ]);
    expect(preview.fields.map((f) => f.limit)).toEqual([60, 160, 60, 200, null, null]);
  });

  test("seoField looks a key up, and invents an unsupplied one rather than throwing", () => {
    const preview = buildSeoPreview(layers(), { pageTitle: "T", route: "/" });
    expect(seoField(preview, "title").value).toBe("T");
    expect(seoField(preview, "twitter:card")).toEqual({
      donor: null,
      key: "twitter:card",
      label: "twitter:card",
      limit: null,
      source: "none",
      value: "",
    });
  });
});

describe("seoWarnings — named consequences, never a total", () => {
  const full = () =>
    layers({
      page: [
        meta("name", "description", "A real description."),
        meta("property", "og:title", "Card title"),
        meta("property", "og:description", "Card summary."),
        meta("property", "og:image", "/card.png"),
      ],
    });

  test("a fully-described page with a site URL raises nothing at all", () => {
    const preview = buildSeoPreview(full(), {
      pageTitle: "Hello",
      route: "/hello",
      siteUrl: "https://example.com",
    });
    expect(preview.warnings).toEqual([]);
  });

  test("a page that INHERITS its description is never told it has none", () => {
    const inherited = buildSeoPreview(
      layers({
        page: [
          meta("property", "og:title", "t"),
          meta("property", "og:description", "d"),
          meta("property", "og:image", "/i.png"),
        ],
        site: [meta("name", "description", "the site's own description")],
      }),
      { pageTitle: "Hello", route: "/hello", siteUrl: "https://example.com" },
    );
    expect(warningIds(inherited)).toEqual([]);
    expect(seoField(inherited, "description").source).toBe("site");
  });

  test("each absent field raises its own named warning, and they do not merge", () => {
    const preview = buildSeoPreview(layers(), { pageTitle: "Hello", route: "/hello" });
    expect(warningIds(preview)).toEqual([
      "description-missing",
      "og-title-missing",
      "og-description-missing",
      "og-image-missing",
      "site-url-missing",
    ]);
    expect(preview.warnings.map((w) => w.field)).toEqual([
      "description",
      "og:title",
      "og:description",
      "og:image",
      "url",
    ]);
  });

  test("no title anywhere names the string the build ships instead", () => {
    const preview = buildSeoPreview(full(), {
      pageTitle: "",
      route: "/hello",
      siteUrl: "https://example.com",
    });
    expect(warningIds(preview)).toEqual(["title-missing"]);
    expect(preview.warnings[0]!.message).toContain(BUILD_FALLBACK_TITLE);
  });

  test("a title inherited from the site name is NOT a missing title", () => {
    const preview = buildSeoPreview(full(), {
      pageTitle: "",
      route: "/hello",
      siteName: "Acme",
      siteUrl: "https://example.com",
    });
    expect(warningIds(preview)).toEqual([]);
    expect(seoField(preview, "title")).toMatchObject({ donor: "Site name", source: "site" });
  });

  test("over-budget fields are counted, not scored", () => {
    const long = layers({
      page: [
        meta("name", "description", "d".repeat(161)),
        meta("property", "og:title", "t"),
        meta("property", "og:description", "s"),
        meta("property", "og:image", "/i.png"),
      ],
    });
    const preview = buildSeoPreview(long, {
      pageTitle: "T".repeat(61),
      route: "/hello",
      siteUrl: "https://example.com",
    });
    expect(warningIds(preview)).toEqual(["title-long", "description-long"]);
    expect(preview.warnings[0]!.message).toBe("Title is 61 characters; headlines are cut near 60.");
    expect(preview.warnings[1]!.message).toBe(
      "Description is 161 characters; summaries are cut near 160.",
    );
    // Nothing sums them. The report IS the list.
    expect(Object.keys(preview)).toEqual(["fields", "url", "warnings"]);
  });

  test("an og:description over budget says `summaries`, matching its shape not its label", () => {
    const longSummary = "s".repeat(201);
    const page = [
      meta("name", "description", "d"),
      meta("property", "og:title", "t"),
      meta("property", "og:description", longSummary),
      meta("property", "og:image", "/i.png"),
    ];
    const preview = buildSeoPreview(layers({ page }), {
      pageTitle: "T",
      route: "/h",
      siteUrl: "https://example.com",
    });
    expect(preview.warnings[0]!.message).toBe(
      "Social description is 201 characters; summaries are cut near 200.",
    );
  });

  test("a <title> in any layer is reported as discarded — the merger overwrites it", () => {
    for (const layer of ["site", "layout", "page"] as const) {
      const preview = buildSeoPreview(
        layers({ ...full(), [layer]: [...full().page, { tagName: "title", textContent: "x" }] }),
        { pageTitle: "Hello", route: "/hello", siteUrl: "https://example.com" },
      );
      expect(warningIds(preview)).toContain("head-title-ignored");
    }
  });
});

// ─── The layout layer ─────────────────────────────────────────────────────────

describe("layoutHeadEntries — the one layer that lives in a file", () => {
  const LAYOUT = JSON.stringify({
    $head: [{ attributes: { content: "from the layout", name: "description" }, tagName: "div" }],
    tagName: "div",
  });

  function seedLayout(body = LAYOUT) {
    installMockPlatform({}, { "layouts/main-layout.json": body });
    resetStudioState({
      isSiteProject: true,
      projectConfig: { defaults: { layout: "./layouts/main-layout.json" } },
    });
    return resetWorkspaceWithTab(undefined, { documentPath: "pages/about.json" }) as Tab;
  }

  beforeEach(() => {
    invalidateLayoutCache();
    invalidateLayoutHeadCache();
  });

  test("a non-page document never reads a layout at all", () => {
    resetStudioState({ isSiteProject: false, projectConfig: {} });
    const tab = resetWorkspaceWithTab(undefined, {
      documentPath: "components/card.json",
    }) as Tab;
    expect(layoutHeadEntries(tab)).toEqual({ entries: [], name: null });
  });

  test("the first call is empty and schedules the read; the second has the entries", async () => {
    const tab = seedLayout();
    expect(layoutHeadEntries(tab)).toEqual({ entries: [], name: "Main Layout" });
    await flush();
    const resolved = layoutHeadEntries(tab);
    expect(resolved.name).toBe("Main Layout");
    expect(resolved.entries).toHaveLength(1);
  });

  test("an unreadable layout caches as empty rather than re-reading on every render", async () => {
    installMockPlatform();
    resetStudioState({
      isSiteProject: true,
      projectConfig: { defaults: { layout: "./layouts/gone.json" } },
    });
    const tab = resetWorkspaceWithTab(undefined, { documentPath: "pages/about.json" }) as Tab;
    layoutHeadEntries(tab);
    await flush();
    expect(layoutHeadEntries(tab).entries).toEqual([]);
  });

  test("invalidateLayoutPickerCache drops the head too — one event, one answer", async () => {
    const tab = seedLayout();
    layoutHeadEntries(tab);
    await flush();
    expect(layoutHeadEntries(tab).entries).toHaveLength(1);
    invalidateLayoutPickerCache();
    expect(layoutHeadEntries(tab).entries).toEqual([]);
  });

  test("a second layout asked for mid-flight owns the cache; the first is discarded", async () => {
    const tab = seedLayout();
    layoutHeadEntries(tab, "./layouts/main-layout.json");
    layoutHeadEntries(tab, "./layouts/other.json");
    await flush();
    // The superseded read must not have written "Main Layout"'s entries under "Other".
    expect(layoutHeadEntries(tab, "./layouts/other.json").entries).toEqual([]);
  });

  test("layoutDisplayName reads a path the way a person names the layout", () => {
    expect(layoutDisplayName("./layouts/blog_post.json")).toBe("Blog Post");
    expect(layoutDisplayName("layouts/nested/marketing-page.json")).toBe("Nested Marketing Page");
  });

  test("seoPreviewFor reads the open document, its layout, and the project config", async () => {
    installMockPlatform(
      {},
      {
        "layouts/main-layout.json": JSON.stringify({
          $head: [
            { attributes: { content: "layout summary", name: "description" }, tagName: "meta" },
          ],
          tagName: "div",
        }),
      },
    );
    resetStudioState({
      isSiteProject: true,
      projectConfig: {
        $head: [
          { attributes: { content: "/site-card.png", property: "og:image" }, tagName: "meta" },
        ],
        defaults: { layout: "./layouts/main-layout.json" },
        name: "Acme",
        url: "https://acme.test",
      },
    });
    const tab = resetWorkspaceWithTab(undefined, { documentPath: "pages/about.json" }) as Tab;
    seoPreviewFor(tab, { tagName: "div" });
    await flush();

    const preview = seoPreviewFor(tab, { tagName: "div", title: "About" });
    expect(preview.url.href).toBe("https://acme.test/about");
    expect(seoField(preview, "title")).toMatchObject({ source: "page", value: "About" });
    expect(seoField(preview, "description")).toMatchObject({
      donor: "Main Layout",
      source: "layout",
      value: "layout summary",
    });
    expect(seoField(preview, "og:image")).toMatchObject({
      donor: "Site head",
      source: "site",
      value: "/site-card.png",
    });
  });
});

// ─── Counting what a reader sees ─────────────────────────────────────────────

describe("visibleLength", () => {
  test("counts graphemes, not UTF-16 code units", () => {
    /*
     * `String.length` is not a count of anything a person can see: an emoji is 2 code units, a flag
     * is 4, and a multi-person emoji with a zero-width joiner is more. A budget counter reporting
     * those numbers is wrong by exactly that margin.
     */
    expect(visibleLength("hello")).toBe(5);
    expect(visibleLength("🚀")).toBe(1);
    expect("🚀".length).toBe(2);
    expect(visibleLength("🇬🇧")).toBe(1);
    expect(visibleLength("👩‍🚀")).toBe(1);
    expect(visibleLength("café")).toBe(4);
    // A decomposed é is two code points and one grapheme.
    expect(visibleLength("café")).toBe(4);
    expect(visibleLength("")).toBe(0);
  });

  test("the over-limit warning counts the same way the badge does", () => {
    const long = "🚀".repeat(40);
    // 80 code units, 40 graphemes: the old counter called this over a 60-character title budget.
    expect(long.length).toBe(80);
    expect(visibleLength(long)).toBe(40);
  });
});
