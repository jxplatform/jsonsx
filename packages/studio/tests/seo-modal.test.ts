/**
 * Search appearance — the modal (plan §9.2, §14).
 *
 * It was a `<details>` inside the Document Header card. Everything asserted here was asserted there
 * and still must hold: two previews of the MERGED head, the resolved-field list with its counters
 * and provenance chips, the named warnings, and the editable rows below them. What is new is the
 * SURFACE — that it opens from two places and the palette, over the document it was opened on, and
 * that closing it leaves nothing behind.
 *
 * The merge itself is asserted in `head-panel.test.ts`; these are about what the modal SHOWS, and
 * about the one property the plan states as a prohibition — nothing here renders a score.
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
import { initLayers } from "../src/ui/layers";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { invalidateLayoutHeadCache } from "../src/panels/head-panel";
import { invalidateLayoutCache } from "../src/site-context";
import { createCommandRegistry } from "../src/commands/registry";
import { emptyContext, makeContext } from "../src/commands/context";
import { setActiveRegistry } from "../src/commands/active-registry";

const { closeSeoModal, openSeoModal, renderSeoModal, seoCommands } =
  await import("../src/panels/seo-modal");

/**
 * Is it up?
 *
 * The DOM, not an exported predicate. `seoModalOpen()` existed for exactly these assertions and for
 * a pressed state on the two buttons — which cannot exist, because both buttons are behind the
 * modal while it is open. `tests/reachability.test.ts` calls that shape out by name, and it is
 * right: what the reader wants to know is whether the modal is on screen.
 */
function seoModalOpen(): boolean {
  return document.querySelector(".seo-modal") !== null;
}

// Panel scheduler coalesces via requestAnimationFrame; make it synchronous-ish.
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (
  cb: FrameRequestCallback,
) => setTimeout(() => cb(0), 0) as unknown as number;

/** The modal's own element. It paints into a layer slot on `document.body`, not into a panel. */
function host(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".seo-modal");
  if (!el) {
    throw new Error("the Search appearance modal is not open");
  }
  return el;
}

function setShell() {
  // The overlay layers are part of the shell here, not an afterthought: `openModal` appends into
  // `#layer-modal`, and `setShell` replaces `document.body.innerHTML` before every test.
  document.body.innerHTML = `<div id="app">
    <div id="toolbar"></div>
    <div id="activity-bar"></div><div id="left-panel"></div>
    <div class="pane-stage" data-jx-region="pane.primary"></div>
    <div id="right-panel"></div>
    <div id="statusbar"></div>
  </div>
  <div id="layer-popover"></div><div id="layer-modal"></div>
  <div id="layer-dialog"></div><div id="layer-toast"></div>`;
  initShellRefs();
  initLayers();
  registerPrimaryStage();
}

const FM_SCHEMA = {
  properties: { title: { type: "string" } },
  required: ["title"],
};

function setupContentTab(
  frontmatter: Record<string, unknown>,
  opts: { documentPath?: string; id?: string } = {},
) {
  resetStudioState({
    isSiteProject: false,
    projectConfig: { content: { posts: { format: "json", schema: FM_SCHEMA, source: "./posts" } } },
  });
  const tab = resetWorkspaceWithTab(undefined, {
    documentPath: opts.documentPath ?? "posts/hello.json",
    id: opts.id ?? "seo-fm-tab",
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

/** Open it over whatever tab the test just set up — what both buttons and the command all do. */
async function mountAndFlush() {
  openSeoModal(activeTab.value!);
  await flush(4);
}

/** Re-paint, standing in for the commit path's own `renderSeoModal`. */
function render(): void {
  renderSeoModal();
}

beforeEach(() => {
  setShell();
  installMockPlatform();
  // The layout layer of the merged head arrives asynchronously and repaints through this name.
  // Registered for EVERY test rather than inside the one that first needed it: a suite where
  // `--test-name-pattern` changes the result is a suite that is asserting test order.
  registerRenderer("seoModal", renderSeoModal);
  invalidateLayoutCache();
  invalidateLayoutHeadCache();
});

afterEach(() => {
  closeSeoModal();
  closeAllTabs();
  setActiveRegistry(null);
});

describe("the surface itself", () => {
  test("it opens over the tab it was given, and names that document in its header", async () => {
    setupContentTab({ title: "Hello" }, { documentPath: "posts/hello.json" });
    expect(seoModalOpen()).toBe(false);
    await mountAndFlush();
    expect(seoModalOpen()).toBe(true);
    expect(host().querySelector(".settings-modal-title")?.textContent).toBe("Search appearance");
    // A modal covers the tab strip, so it has to say which document it is about itself.
    expect(host().querySelector(".seo-modal-doc")?.textContent).toBe("posts/hello.json");
  });

  test("opening it twice is one modal, re-pointed at the current document", async () => {
    setupContentTab({ title: "First" }, { documentPath: "posts/first.json", id: "seo-a" });
    await mountAndFlush();
    const second = setupContentTab(
      { title: "Second" },
      {
        documentPath: "posts/second.json",
        id: "seo-b",
      },
    );
    openSeoModal(second);
    await flush(4);
    expect(document.querySelectorAll(".seo-modal").length).toBe(1);
    expect(host().querySelector(".seo-modal-doc")?.textContent).toBe("posts/second.json");
  });

  test("closing it removes it, and closing twice is not a throw", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    closeSeoModal();
    expect(document.querySelector(".seo-modal")).toBeNull();
    expect(seoModalOpen()).toBe(false);
    closeSeoModal();
  });

  test("a repaint with nothing open is a no-op, not a throw", () => {
    renderSeoModal();
    expect(seoModalOpen()).toBe(false);
  });

  test("the form is grouped by the preview card each half feeds", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    // Open Graph has its OWN Title, Description and Image: ungrouped, "Description" named two
    // Different fields eight rows apart.
    expect(
      [...host().querySelectorAll(".seo-modal-group-title")].map((h) => h.textContent),
    ).toEqual(["Search result", "Social card"]);
  });
});

describe("document.openSeo", () => {
  test("it is a document-level record the palette can reach, and the assistant can call", () => {
    const [command] = seoCommands();
    expect(command!.id).toBe("document.openSeo");
    expect(command!.level).toBe("document");
    expect(command!.menus).toContain("palette");
    expect(command!.aiTool?.name).toBe("open_seo");
  });

  test("it needs an open document, and opens the modal over the active one", async () => {
    const [command] = seoCommands();
    const registry = createCommandRegistry({
      getContext: () => makeContext({ document: { open: true } }),
    });
    registry.register(command!);
    // Gated, and the gate is the reason: with no document there is no head to preview.
    expect(command!.when!(emptyContext())).toBe(false);

    setupContentTab({ title: "Hello" }, { documentPath: "posts/hello.json" });
    await registry.run("document.openSeo");
    await flush(4);
    expect(seoModalOpen()).toBe(true);
    expect(host().querySelector(".seo-modal-doc")?.textContent).toBe("posts/hello.json");
  });
});

describe("the favicon row", () => {
  test("committing a path writes a link entry; the clear dot removes it", async () => {
    const tab = setupContentTab({ title: "Hello" });
    await mountAndFlush();
    const field = row("icon").querySelector("sp-textfield")!;
    (field as any).value = "/favicon.png";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    // The media field commits on a debounce.
    await new Promise((resolve) => {
      setTimeout(resolve, 450);
    });
    await flush(4);
    expect(tab.doc.content.frontmatter.$head).toEqual([
      { attributes: { href: "/favicon.png", rel: "icon" }, tagName: "link" },
    ]);

    render();
    await flush(4);
    row("icon")
      .querySelector(".set-dot")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(tab.doc.content.frontmatter.$head).toBeUndefined();
  });
});

function seoRow(key: string): HTMLElement {
  const el = host().querySelector(`[data-seo-field="${key}"]`);
  if (!el) {
    throw new Error(`no SEO field row: ${key}`);
  }
  return el as HTMLElement;
}

function seoWarningIds(): string[] {
  return [...host().querySelectorAll("[data-seo-warning]")].map(
    (el) => (el as HTMLElement).dataset.seoWarning!,
  );
}

/** A site page whose layout and project config both contribute head material. */
function setupSeoPage(
  frontmatter: Record<string, unknown>,
  config: Record<string, unknown> = {},
): void {
  installMockPlatform(
    {},
    {
      "layouts/base.json": JSON.stringify({
        $head: [
          { attributes: { content: "the layout's summary", name: "description" }, tagName: "meta" },
        ],
        tagName: "div",
      }),
    },
  );
  resetStudioState({
    isSiteProject: true,
    projectConfig: {
      defaults: { layout: "./layouts/base.json" },
      name: "Acme",
      url: "https://acme.test",
      ...config,
    },
  });
  const tab = resetWorkspaceWithTab(undefined, {
    documentPath: "pages/about.json",
    id: "seo-tab",
  }) as any;
  tab.doc.mode = "content";
  tab.doc.content.frontmatter = frontmatter;
}

describe("the modal previews the merged head", () => {
  test("the search-result card prints the canonical breadcrumb, the title and the description", async () => {
    setupSeoPage({ title: "About Us" });
    await mountAndFlush();
    await flush(4);
    const serp = host().querySelector(".seo-card--serp")!;
    expect(serp.querySelector(".seo-serp-url")?.textContent).toBe("acme.test › about");
    expect(serp.querySelector(".seo-serp-title")?.textContent).toBe("About Us");
    expect(serp.querySelector(".seo-serp-desc")?.textContent?.trim()).toBe("the layout's summary");
  });

  test("the social card shows the og:image, and says so plainly when there is none", async () => {
    setupSeoPage({ title: "About Us" });
    await mountAndFlush();
    await flush(4);
    const social = host().querySelector(".seo-card--social")!;
    expect(social.querySelector(".seo-social-domain")?.textContent).toBe("acme.test");
    expect(social.querySelector(".seo-social-media .seo-unset")?.textContent).toBe("No image");
    expect(social.querySelector(".seo-social-title .seo-unset")?.textContent).toBe(
      "No social title",
    );

    setupSeoPage({
      $head: [{ attributes: { content: "/card.png", property: "og:image" }, tagName: "meta" }],
      title: "About Us",
    });
    // A fresh tab, so RE-OPEN rather than re-render: the modal draws the document it was opened
    // Over, and repainting would faithfully redraw the previous one.
    await mountAndFlush();
    const img = host().querySelector(".seo-social-media img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/card.png");
  });

  test("a document with no route and no site URL previews without inventing one", async () => {
    setupContentTab({ title: "Post" }, { documentPath: "posts/hello.json" });
    await mountAndFlush();
    expect(host().querySelector(".seo-serp-url")?.textContent).toBe("/");
    expect(host().querySelector(".seo-social-domain .seo-unset")?.textContent).toBe("No site URL");
    expect(seoWarningIds()).toContain("site-url-missing");
  });
});

describe("the resolved-field list marks where each value came from", () => {
  test("a page-authored value is a set dot; a layout value names the layout it came from", async () => {
    setupSeoPage({ title: "About Us" });
    await mountAndFlush();
    await flush(4);

    const title = seoRow("title").querySelector(".provenance-chip")!;
    expect(title.classList.contains("provenance-chip--set")).toBe(true);
    expect(title.tagName).toBe("SPAN"); // Read-only: the chip has nowhere to go.

    const description = seoRow("description").querySelector(".provenance-chip")!;
    expect(description.classList.contains("provenance-chip--inherited")).toBe(true);
    expect(description.textContent?.trim()).toBe("from Base");
  });

  test("an unset field shows no chip at all — absence IS the ghost", async () => {
    setupSeoPage({ title: "About Us" });
    await mountAndFlush();
    await flush(4);
    expect(seoRow("og:type").querySelector(".provenance-chip")).toBeNull();
    expect(seoRow("og:type").querySelector(".seo-unset")?.textContent).toBe("No social type");
  });

  test("a title inherited from the project name jumps to the setting that defines it", async () => {
    const ran: { id: string; args: unknown }[] = [];
    const registry = createCommandRegistry({ getContext: () => emptyContext() });
    registry.register({
      id: "settings.open",
      title: "Open Settings",
      category: "Project",
      level: "application",
      args: { properties: { section: { type: "string" } }, required: [], type: "object" },
      run: (_c, args: unknown) => {
        ran.push({ args, id: "settings.open" });
      },
    });
    setActiveRegistry(registry);

    setupSeoPage({ subtitle: "no title here" });
    await mountAndFlush();
    await flush(4);
    const chip = seoRow("title").querySelector(".provenance-chip") as HTMLButtonElement;
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.textContent?.trim()).toBe("from Site name");
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ran).toEqual([{ args: { section: "overview" }, id: "settings.open" }]);
    setActiveRegistry(null);
  });

  test("a value from the site's own $head jumps to Site head instead", async () => {
    const ran: unknown[] = [];
    const registry = createCommandRegistry({ getContext: () => emptyContext() });
    registry.register({
      id: "settings.open",
      title: "Open Settings",
      category: "Project",
      level: "application",
      args: { properties: { section: { type: "string" } }, required: [], type: "object" },
      run: (_c, args: unknown) => {
        ran.push(args);
      },
    });
    setActiveRegistry(registry);

    setupSeoPage(
      { title: "About Us" },
      {
        $head: [{ attributes: { content: "/site.png", property: "og:image" }, tagName: "meta" }],
      },
    );
    await mountAndFlush();
    await flush(4);
    const chip = seoRow("og:image").querySelector(".provenance-chip") as HTMLButtonElement;
    expect(chip.textContent?.trim()).toBe("from Site head");
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ran).toEqual([{ section: "head" }]);
    setActiveRegistry(null);
  });

  test("with no registry the chip still renders and clicking it is inert", async () => {
    setActiveRegistry(null);
    setupSeoPage({ subtitle: "no title here" });
    await mountAndFlush();
    await flush(4);
    const chip = seoRow("title").querySelector(".provenance-chip") as HTMLButtonElement;
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(chip.textContent?.trim()).toBe("from Site name");
  });
});

describe("the two realms a document can keep its head material in", () => {
  test("a JSON document commits straight onto the document root, not into frontmatter", async () => {
    // The markdown path (`applyContentMutation`) is what every other case here exercises. A
    // Component or a JSON page has no frontmatter at all: it goes through `transact`, and the modal
    // Has to pick the right one from the tab it was opened over rather than from the focused pane.
    setupContentTab({ title: "Hello" });
    const tab = activeTab.value as any;
    tab.doc.mode = "component";
    tab.doc.document.title = "Root Title";
    await mountAndFlush();
    fireChange(row("description").querySelector("sp-textfield")!, "Written onto the root");
    expect(tab.doc.document.$head).toEqual([
      { attributes: { content: "Written onto the root", name: "description" }, tagName: "meta" },
    ]);
    expect("$head" in tab.doc.content.frontmatter).toBe(false);
  });

  test("a page with neither a title nor a site name is told the BUILD supplies one", async () => {
    // The last rung of the title cascade. Nothing in the project declares it, so the preview shows
    // What the build will actually emit — and names the build as the donor rather than showing a
    // Blank and letting the author think the page has no title at all.
    setupSeoPage({ subtitle: "no title anywhere" }, { name: "" });
    await mountAndFlush();
    await flush(4);
    expect(seoRow("title").textContent).toContain("Jx Site");
    const chip = seoRow("title").querySelector(".provenance-chip")!;
    expect(chip.classList.contains("provenance-chip--inherited")).toBe(true);
    expect(chip.textContent?.trim()).toBe("from the build");
    // Inherited from the build is not a setting you can open: the chip has nowhere to go.
    expect(chip.tagName).toBe("SPAN");
  });
});

describe("counters and warnings, and the absence of a score", () => {
  test("counted fields print length over budget; uncounted ones print nothing", async () => {
    setupSeoPage({ title: "About Us" });
    await mountAndFlush();
    await flush(4);
    expect(seoRow("title").querySelector(".seo-field-count")?.textContent).toBe("8/60");
    expect(seoRow("description").querySelector(".seo-field-count")?.textContent).toBe("20/160");
    expect(seoRow("og:image").querySelector(".seo-field-count")).toBeNull();
    expect(host().querySelectorAll(".seo-field-count--over").length).toBe(0);
  });

  test("over budget is marked on the counter and named in the list — never summed", async () => {
    setupSeoPage({ title: "T".repeat(61) });
    await mountAndFlush();
    await flush(4);
    expect(seoRow("title").querySelector(".seo-field-count--over")?.textContent).toBe("61/60");
    expect(seoWarningIds()).toContain("title-long");
    // The prohibition, asserted: no element in the modal carries a total or a grade.
    const text = host().textContent ?? "";
    expect(text).not.toMatch(/\b\d{1,3}\s*\/\s*100\b/);
    expect(text.toLowerCase()).not.toContain("score");
  });

  test("a page that inherits its description is never told it has none", async () => {
    setupSeoPage({ title: "About Us" });
    await mountAndFlush();
    await flush(4);
    expect(seoWarningIds()).not.toContain("description-missing");
    expect(seoRow("description").textContent).toContain("the layout's summary");
  });

  test("each named warning renders once, with the head key it is about", async () => {
    setupSeoPage({ title: "About Us" });
    await mountAndFlush();
    await flush(4);
    expect(seoWarningIds()).toEqual([
      "og-title-missing",
      "og-description-missing",
      "og-image-missing",
    ]);
    const first = host().querySelector(".seo-warning")!;
    expect(first.querySelector(".seo-warning-field")?.textContent).toBe("og:title");
  });

  test("a fully-described page says so rather than printing an empty list", async () => {
    setupSeoPage({
      $head: [
        { attributes: { content: "Card", property: "og:title" }, tagName: "meta" },
        { attributes: { content: "Summary", property: "og:description" }, tagName: "meta" },
        { attributes: { content: "/card.png", property: "og:image" }, tagName: "meta" },
      ],
      title: "About Us",
    });
    await mountAndFlush();
    await flush(4);
    expect(host().querySelector(".seo-warnings")).toBeNull();
    expect(host().querySelector(".doc-header-empty")?.textContent?.trim()).toBe(
      "Nothing to flag — every previewed field resolves to a value.",
    );
  });

  test("the editable fields still sit below the previews, and still commit", async () => {
    setupSeoPage({ title: "About Us" });
    await mountAndFlush();
    await flush(4);
    const seo = host();
    const order = [
      ...seo.querySelectorAll('.seo-previews, .seo-fields, [data-prop="description"]'),
    ].map((el) => (el as HTMLElement).dataset.prop ?? el.className);
    expect(order).toEqual(["seo-previews", "seo-fields", "description"]);
    const descriptionRow = seo.querySelector('[data-prop="description"]')!;
    fireChange(descriptionRow.querySelector("sp-textfield")!, "Written here");
    await flush(4);
    expect(seoRow("description").querySelector(".provenance-chip--set")).toBeTruthy();
    expect(seoRow("description").textContent).toContain("Written here");
  });
});
