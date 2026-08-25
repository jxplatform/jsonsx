/**
 * The Document Header card — the three deleted gates (collection, canvas mode, document mode), the
 * ONE reserved-key policy (`title` has a named row and never doubles as a generic property), the
 * Route line, the Raw-head disclosure, the door to Search appearance, the commit paths, and
 * reactive re-render.
 *
 * The SEO block left: it is a modal now (`tests/seo-modal.test.ts`), reachable from this card and
 * from the Page panel. What stays here is the BUTTON — that the card offers the door at all.
 *
 * The card has no host of its own any more: `#frontmatter-panel` is deleted and the STAGE hands one
 * over. These tests play the stage's part with `attachDocumentHeaderHost`; `canvas-render.test.ts`
 * covers where the stage actually puts it.
 */
import {
  flush,
  installMockPlatform,
  registerPrimaryStage,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initShellRefs, registerRenderer } from "../src/store";
import { invalidateMediaCache } from "../src/ui/media-picker";
import {
  activateTab,
  activeTab,
  closeAllTabs,
  openTab,
  paneById,
  splitRight,
} from "../src/workspace/workspace";
import { mutateUpdateFrontmatter, transactDoc } from "../src/tabs/transact";
import { collectFmFields } from "../src/panels/frontmatter-fields";
import {
  RESERVED_FM_KEYS,
  invalidateLayoutHeadCache,
  invalidateLayoutPickerCache,
} from "../src/panels/head-panel";
import { invalidateLayoutCache } from "../src/site-context";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext } from "../src/commands/context";
import { setActiveRegistry } from "../src/commands/active-registry";

const { attachDocumentHeaderHost, documentHeaderHost, hasDocumentHeader, mount, render, unmount } =
  await import("../src/panels/frontmatter-panel");

/** The node the card paints into — whatever the stage (here, the test) last handed over. */
function host(): HTMLElement {
  const el = documentHeaderHost("primary");
  if (!el) {
    throw new Error("no Document Header host is attached");
  }
  return el;
}

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

/**
 * Stand up the shell and play the stage's part.
 *
 * `withPanelHost: false` is the real state of every canvas mode that draws no document header — the
 * card must simply have nowhere to paint, and saying so must not throw.
 */
function setShell(withPanelHost = true) {
  document.body.innerHTML = `<div id="app">
    <div id="toolbar"></div>
    <div id="activity-bar"></div><div id="left-panel"></div>
    <div class="pane-stage" data-jx-region="pane.primary">
      <div class="content-edit-canvas"><div class="content-edit-column">
        <div class="doc-header-host in-column"></div>
      </div></div>
    </div>
    <div id="right-panel"></div>
    <div id="statusbar"></div>
  </div>`;
  initShellRefs();
  registerPrimaryStage();
  attachDocumentHeaderHost(
    "primary",
    withPanelHost ? document.querySelector<HTMLElement>(".doc-header-host") : null,
  );
}

function setupContentTab(
  frontmatter: Record<string, unknown>,
  opts: { withSchema?: boolean; documentPath?: string; id?: string; isSite?: boolean } = {},
) {
  resetStudioState({
    isSiteProject: opts.isSite ?? false,
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
  const el = host().querySelector(`[data-prop="${prop}"]`);
  if (!el) {
    throw new Error(`row not found: ${prop}`);
  }
  return el as HTMLElement;
}

function summaries(): string[] {
  return [...host().querySelectorAll("summary")].map((s) => s.textContent!.trim());
}

beforeEach(() => {
  setShell();
  installMockPlatform();
  // Two of the card's field sets settle asynchronously — the media listing behind an image field,
  // And the layout document behind the SEO block's middle cascade layer. Both repaint through
  // `renderOnly("frontmatterPanel")`, so the renderer is registered for EVERY test rather than
  // Inside the one that first needed it: a suite where `--test-name-pattern` changes the result is
  // A suite that is asserting test order.
  registerRenderer("frontmatterPanel", () => render());
  invalidateLayoutCache();
  invalidateLayoutHeadCache();
});

afterEach(() => {
  unmount();
  closeAllTabs();
});

async function mountAndFlush() {
  mount();
  render();
  await flush(4);
}

describe("the three deleted gates", () => {
  test("appears for a document that matches NO content collection", async () => {
    setupContentTab({ title: "Hello" }, { withSchema: false });
    await mountAndFlush();
    expect(host().hidden).toBe(false);
    expect((row("title").querySelector("sp-textfield") as any).value).toBe("Hello");
  });

  test("appears in every canvas mode — it is part of the document, not a view of it", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    // The card takes no canvas mode at all; there is no predicate left to fail.
    expect(host().hidden).toBe(false);
    expect(mount.length).toBe(0);
  });

  test("appears for a component-mode document that carries head material", async () => {
    const tab = setupContentTab({}, { withSchema: false });
    tab.doc.mode = "component";
    tab.doc.document.title = "A JSON page";
    await mountAndFlush();
    expect(host().hidden).toBe(false);
    expect((row("title").querySelector("sp-textfield") as any).value).toBe("A JSON page");
  });

  test("hidden only when the document genuinely has no header", async () => {
    setupContentTab({}, { withSchema: false });
    await mountAndFlush();
    expect(host().hidden).toBe(true);
  });

  test("hidden with no active tab; a stage that hosts nothing is a no-op", async () => {
    resetStudioState({ projectConfig: {} });
    closeAllTabs();
    await mountAndFlush();
    expect(host().hidden).toBe(true);
    unmount();

    setShell(false);
    mount();
    expect(documentHeaderHost("primary")).toBeNull();
    render(); // Must not throw with no host bound
  });
});

describe("the stage owns the host", () => {
  test("attaching a new host moves the card onto it and repaints there", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    const first = host();
    expect(first.querySelector(".doc-header")).toBeTruthy();

    const second = document.createElement("div");
    second.className = "doc-header-host pinned";
    document.querySelector(".pane-stage")!.append(second);
    attachDocumentHeaderHost("primary", second);
    await flush(4);

    expect(documentHeaderHost("primary")).toBe(second);
    expect(second.querySelector(".doc-header")).toBeTruthy();
  });

  test("re-attaching the SAME host is inert — the canvas re-renders far more often than it moves", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    const el = host();
    attachDocumentHeaderHost("primary", el);
    await flush(4);
    expect(documentHeaderHost("primary")).toBe(el);
    expect(el.querySelectorAll(".doc-header").length).toBe(1);
  });

  test("the card stamps its own region, so no shell host has to name it", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    expect((host().querySelector(".doc-header") as HTMLElement).dataset.jxRegion).toBe(
      "pane.primary/frontmatter",
    );
  });
});

describe("hasDocumentHeader", () => {
  test("frontmatter, a title or a $head entry each qualify; nothing does not", () => {
    const tab = setupContentTab({}, { withSchema: false });
    expect(hasDocumentHeader(tab)).toBe(false);
    tab.doc.document.$head = [{ attributes: { content: "x", name: "author" }, tagName: "meta" }];
    expect(hasDocumentHeader(tab)).toBe(true);
    delete tab.doc.document.$head;
    tab.doc.content.frontmatter = { draft: true };
    expect(hasDocumentHeader(tab)).toBe(true);
  });

  /*
   * The predicate takes a tab, inspects THAT tab's frontmatter, title and `$head` — and then fell
   * through to a zero-argument `isPageDocument()` for the "a page always has one" rule. So its last
   * line answered about a different document from its first three, and both directions were visible
   * the moment a second pane existed.
   */
  function twoDocuments() {
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    closeAllTabs();
    const page = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "pages/about.json",
      id: "hdr-page",
    });
    const component = openTab({
      document: { children: [], tagName: "x-card" },
      documentPath: "components/Card.json",
      id: "hdr-component",
    });
    return { component, page };
  }

  test("a PAGE keeps its header while a component is focused", () => {
    const { component, page } = twoDocuments();
    activateTab(component.id);
    expect(activeTab.value?.documentPath).toBe("components/Card.json");
    // The page has no frontmatter, no title and no $head — the page rule is the only thing that
    // Can give it a header, and it used to be asked about the OTHER document.
    expect(hasDocumentHeader(page)).toBe(true);
  });

  test("a bare COMPONENT does not gain one because a page is focused", () => {
    const { component, page } = twoDocuments();
    activateTab(page.id);
    expect(hasDocumentHeader(component)).toBe(false);
  });
});

describe("the Layout picker belongs to the card's own document", () => {
  /*
   * `documentHeaderTemplate(tab, paneId)` gated the picker on the same zero-argument read, so the
   * control appeared and vanished in the pane you were editing according to the document in the
   * other one — while the `$layout` it writes is this document's.
   */
  test("a PAGE's card shows the Layout row while a component is focused elsewhere", async () => {
    resetStudioState({ isSiteProject: true, projectConfig: {} });
    installMockPlatform({}, { "layouts/base.json": JSON.stringify({ tagName: "div" }) });
    invalidateLayoutPickerCache();
    closeAllTabs();
    const page = resetWorkspaceWithTab({ children: [], tagName: "div", title: "About" } as never, {
      documentPath: "pages/about.json",
      id: "layout-page",
    });
    openTab({
      document: { children: [], tagName: "x-card", title: "Card" },
      documentPath: "components/Card.json",
      id: "layout-component",
    });
    // The component goes to the SIDE pane and takes the focus with it; the card under test is the
    // Primary's, still drawing the page.
    expect(splitRight()?.id).toBe("secondary");
    expect(paneById("primary")!.activeTabId).toBe(page.id);
    expect(activeTab.value?.documentPath).toBe("components/Card.json");

    await mountAndFlush();
    // The layouts listing settles asynchronously and repaints through `renderOnly`.
    await flush(4);

    console.log(
      `[frontmatter] focus=${activeTab.value?.documentPath} card-for=${page.documentPath} ` +
        `layout rows=${host().querySelectorAll('[data-prop="layout"]').length}`,
    );
    expect(host().querySelectorAll('[data-prop="layout"]').length).toBe(1);
  });
});

/*
 * Every control on the card commits into the document the card is SHOWING.
 *
 * The JSON branch was fixed when the panes landed, and the comment beside it said so. The fix
 * reached that branch only: a markdown page takes the CONTENT branch, where `applyContentMutation`
 * resolved `activeTab.value` one call deeper, and every schema-driven field went through
 * `renderFmField`, which did the same at each of its seven widgets. So on a content document the
 * card in one pane retitled — and re-categorised, and re-dated — whichever document had the
 * keyboard, while going on displaying the values it had not changed.
 */
describe("the CONTENT branch commits into the card's own document too", () => {
  /** The card is drawn for a content tab in the PRIMARY pane; the focus is in the side pane. */
  async function contentCardWithFocusElsewhere() {
    const card = setupContentTab({ category: "news", title: "LEFT" }, { id: "fm-left" }) as any;
    card.doc.mode = "content";
    const other = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "posts/other.json",
      id: "fm-right",
    }) as any;
    other.doc.mode = "content";
    other.doc.content.frontmatter = { category: "news", title: "RIGHT" };
    expect(splitRight()?.id).toBe("secondary");
    expect(paneById("primary")!.activeTabId).toBe(card.id);
    expect(activeTab.value?.id).toBe(other.id);
    await mountAndFlush();
    return { card, other };
  }

  test("the Title field retitles the card's document, not the focused one", async () => {
    const { card, other } = await contentCardWithFocusElsewhere();
    expect(row("title").querySelector("sp-textfield")).not.toBeNull();

    fireChange(row("title").querySelector("sp-textfield")!, "EDITED");
    await flush(2);

    console.log(
      `[frontmatter] focus=${activeTab.value?.id} · left.title=${JSON.stringify(card.doc.content.frontmatter.title)} ` +
        `right.title=${JSON.stringify(other.doc.content.frontmatter.title)}`,
    );
    expect(card.doc.content.frontmatter.title).toBe("EDITED");
    expect(other.doc.content.frontmatter.title).toBe("RIGHT");
  });

  test("Clear title clears the card's document, not the focused one", async () => {
    const { card, other } = await contentCardWithFocusElsewhere();
    const clear = row("title").querySelector<HTMLElement>(".provenance-chip.set-dot");
    expect(clear).not.toBeNull();
    clear!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush(2);

    expect(card.doc.content.frontmatter.title).toBeUndefined();
    expect(other.doc.content.frontmatter.title).toBe("RIGHT");
  });

  test("a schema frontmatter field commits into the card's document, not the focused one", async () => {
    const { card, other } = await contentCardWithFocusElsewhere();
    // `category` is a schema `enum`, drawn by `renderFmField` — one of its seven `activeTab` writes.
    fireChange(row("category").querySelector("sp-picker")!, "guide");
    await flush(2);

    console.log(
      `[frontmatter] schema field · left.category=${JSON.stringify(card.doc.content.frontmatter.category)} ` +
        `right.category=${JSON.stringify(other.doc.content.frontmatter.category)}`,
    );
    expect(card.doc.content.frontmatter.category).toBe("guide");
    expect(other.doc.content.frontmatter.category).toBe("news");
  });
});

describe("one reserved-key policy", () => {
  test("title renders ONCE, as the card's named row, not also as a generic property", async () => {
    setupContentTab({ title: "My Post" });
    await mountAndFlush();
    expect(host().querySelectorAll('[data-prop="title"]').length).toBe(1);
    // The named row has no required-marker suffix: it is the card's own control, not a schema field.
    expect(row("title").querySelector("sp-field-label")?.textContent).toBe("Title");
  });

  test("the policy is head-panel's, imported rather than restated", () => {
    expect([...RESERVED_FM_KEYS]).toEqual(["title"]);
    const tab = setupContentTab({ $paths: ["x"], title: "T" });
    const { fields, hasSchema, requiredFields } = collectFmFields(
      tab,
      { content: { posts: { format: "json", schema: FM_SCHEMA, source: "./posts" } } } as any,
      RESERVED_FM_KEYS,
    );
    expect(hasSchema).toBe(true);
    const names = fields.map((f) => f.field);
    expect(names).not.toContain("title");
    expect(names).not.toContain("$paths");
    expect(requiredFields.has("title")).toBe(true);
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
});

describe("route and disclosures", () => {
  test("a page states its route; a non-page states none", async () => {
    setupContentTab({ title: "Home" }, { documentPath: "pages/index.md", isSite: true });
    await mountAndFlush();
    expect(host().querySelector(".doc-header-route")?.textContent).toBe("/");

    setupContentTab({ title: "Post" }, { documentPath: "posts/hello.json" });
    render();
    await flush(4);
    expect(host().querySelector(".doc-header-route")).toBeNull();
  });

  test("Raw head tags is the card's ONE disclosure now, closed by default", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    // Was ["SEO", "Raw head tags"]. The SEO block grew previews, a resolved-field list and eight
    // Form rows inside a card whose job is the four fields you fill in while writing, so it left.
    expect(summaries()).toEqual(["Raw head tags"]);
    for (const d of host().querySelectorAll("details")) {
      expect((d as HTMLDetailsElement).open).toBe(false);
    }
  });

  test("the card offers the door to Search appearance, and it runs the command", async () => {
    const ran: string[] = [];
    const registry = createCommandRegistry({ getContext: () => emptyContext() });
    registry.register({
      category: "Document",
      id: "document.openSeo",
      level: "document",
      run: () => {
        ran.push("document.openSeo");
      },
      title: "Search Appearance",
    });
    setActiveRegistry(registry);
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    const button = host().querySelector(".doc-header-seo-btn") as HTMLElement;
    expect(button.textContent?.trim()).toBe("Search appearance…");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // The command, not a local open() — so the palette and the Page panel reach the same modal.
    expect(ran).toEqual(["document.openSeo"]);
    setActiveRegistry(null);
  });

  test("with no registry the door renders and clicking it is inert", async () => {
    setActiveRegistry(null);
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    (host().querySelector(".doc-header-seo-btn") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });

  test("Raw head tags lists what no structured control owns, and says so when empty", async () => {
    const tab = setupContentTab({ title: "Hello" });
    await mountAndFlush();
    expect(host().querySelector(".doc-header-empty")).toBeTruthy();

    tab.doc.content.frontmatter = {
      $head: [{ attributes: { content: "me", name: "author" }, tagName: "meta" }],
      title: "Hello",
    };
    render();
    await flush(4);
    const items = [...host().querySelectorAll(".doc-header-raw li code")];
    expect(items.map((i) => i.textContent)).toEqual(['<meta name="author">']);
  });
});

describe("commits and reactivity", () => {
  test("the Title row commits to frontmatter and marks the tab dirty", async () => {
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

  test("external frontmatter change re-renders the card reactively", async () => {
    const tab = setupContentTab({ subtitle: "Before" });
    await mountAndFlush();
    transactDoc(tab, (t: any) => mutateUpdateFrontmatter(t, "subtitle", "After"));
    await flush(4);
    expect((row("subtitle").querySelector("sp-textfield") as any).value).toBe("After");
  });

  test("unmount stops reactive re-rendering and releases the stage's host", async () => {
    const tab = setupContentTab({ subtitle: "Before" });
    await mountAndFlush();
    // Held across the unmount on purpose: the DOM stays where the stage put it, but nothing paints
    // Into it again.
    const painted = host();
    unmount();
    expect(documentHeaderHost("primary")).toBeNull();
    transactDoc(tab, (t: any) => mutateUpdateFrontmatter(t, "subtitle", "After"));
    await flush(4);
    const field = painted.querySelector('[data-prop="subtitle"] sp-textfield') as any;
    expect(field.value).toBe("Before");
  });

  test("image field's Browse button appears once the async media cache resolves", async () => {
    // The Browse button is gated on the async-loaded media cache; when the listing resolves,
    // Media-picker repaints host panels via renderOnly — the Document Header must be included.
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

    await mountAndFlush();
    await flush(6); // Async media listing resolves → renderOnly("frontmatterPanel") repaints
    expect(row("hero").querySelector(".media-picker")).toBeTruthy();
    expect(row("hero").querySelector('sp-action-button[title="Browse media"]')).toBeTruthy();
  });

  /* `"uri-reference"` is the spelling the SPEC uses and the one the content loader keys its asset
     rewrite on, so a schema written against the documentation declared its media field that way —
     and got a plain text box here, while the very same declaration got a media picker in the
     properties panel. One predicate now decides, so a media field is one everywhere. */
  test("a uri-reference field is a media field too, not a text box", async () => {
    invalidateMediaCache();
    installMockPlatform({}, { "public/hero.jpg": "img-bytes" });
    resetStudioState({
      projectConfig: {
        content: {
          posts: {
            format: "json",
            schema: { properties: { hero: { format: "uri-reference", type: "string" } } },
            source: "./posts",
          },
        },
      },
    });
    const tab = resetWorkspaceWithTab(undefined, {
      documentPath: "posts/hello.json",
      id: "fm-uri-ref",
    }) as any;
    tab.doc.mode = "content";
    tab.doc.content.frontmatter = { hero: "/hero.jpg" };

    await mountAndFlush();
    await flush(6);
    expect(row("hero").querySelector(".media-picker")).toBeTruthy();
  });
});

describe("the other commit path and the disclosure state", () => {
  test("a non-content document commits straight onto the document root", async () => {
    const tab = setupContentTab({}, { withSchema: false });
    tab.doc.mode = "component";
    tab.doc.document.title = "Old";
    await mountAndFlush();
    fireChange(row("title").querySelector("sp-textfield")!, "New");
    expect(tab.doc.document.title).toBe("New");
    expect("title" in tab.doc.content.frontmatter).toBe(false);
  });

  test("an empty Title deletes the key rather than storing a blank one", async () => {
    const tab = setupContentTab({ title: "Old" });
    await mountAndFlush();
    fireChange(row("title").querySelector("sp-textfield")!, "   ");
    expect(tab.doc.content.frontmatter.title).toBeUndefined();
  });

  test("the Title clear dot deletes the key", async () => {
    const tab = setupContentTab({ title: "Old" });
    await mountAndFlush();
    row("title")
      .querySelector(".set-dot")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(tab.doc.content.frontmatter.title).toBeUndefined();
  });

  test("a disclosure remembers that it was opened, per tab", async () => {
    setupContentTab({ title: "Hello" }, { id: "fm-a" });
    await mountAndFlush();
    const seo = host().querySelector("details") as HTMLDetailsElement;
    seo.open = true;
    seo.dispatchEvent(new Event("toggle"));
    render();
    await flush(4);
    expect((host().querySelector("details") as HTMLDetailsElement).open).toBe(true);

    (host().querySelector("details") as HTMLDetailsElement).open = false;
    host().querySelector("details")!.dispatchEvent(new Event("toggle"));
    render();
    await flush(4);
    expect((host().querySelector("details") as HTMLDetailsElement).open).toBe(false);
  });

  test("a render after the host has gone is a no-op, not a throw", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    setShell(false); // The stage redrew without a header slot; the host is now null
    render();
    await flush(4);
  });
});
