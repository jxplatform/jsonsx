/**
 * The Document Header card — the three deleted gates (collection, canvas mode, document mode), the
 * ONE reserved-key policy (`title` has a named row and never doubles as a generic property), the
 * Route line, the SEO and Raw-head disclosures, the commit paths, and reactive re-render.
 */
import { flush, installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { frontmatterPanelEl, initShellRefs, registerRenderer } from "../src/store";
import { invalidateMediaCache } from "../src/ui/media-picker";
import { closeAllTabs } from "../src/workspace/workspace";
import { mutateUpdateFrontmatter, transactDoc } from "../src/tabs/transact";
import { collectFmFields } from "../src/panels/frontmatter-fields";
import { RESERVED_FM_KEYS } from "../src/panels/head-panel";

const { hasDocumentHeader, mount, render, unmount } =
  await import("../src/panels/frontmatter-panel");

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
  const el = frontmatterPanelEl.querySelector(`[data-prop="${prop}"]`);
  if (!el) {
    throw new Error(`row not found: ${prop}`);
  }
  return el as HTMLElement;
}

function summaries(): string[] {
  return [...frontmatterPanelEl.querySelectorAll("summary")].map((s) => s.textContent!.trim());
}

beforeEach(() => {
  setShell();
  installMockPlatform();
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
    expect(frontmatterPanelEl.hidden).toBe(false);
    expect((row("title").querySelector("sp-textfield") as any).value).toBe("Hello");
  });

  test("appears in every canvas mode — it is part of the document, not a view of it", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    // The card takes no canvas mode at all; there is no predicate left to fail.
    expect(frontmatterPanelEl.hidden).toBe(false);
    expect(mount.length).toBe(0);
  });

  test("appears for a component-mode document that carries head material", async () => {
    const tab = setupContentTab({}, { withSchema: false });
    tab.doc.mode = "component";
    tab.doc.document.title = "A JSON page";
    await mountAndFlush();
    expect(frontmatterPanelEl.hidden).toBe(false);
    expect((row("title").querySelector("sp-textfield") as any).value).toBe("A JSON page");
  });

  test("hidden only when the document genuinely has no header", async () => {
    setupContentTab({}, { withSchema: false });
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
    mount();
    render(); // Must not throw with no host bound
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
});

describe("one reserved-key policy", () => {
  test("title renders ONCE, as the card's named row, not also as a generic property", async () => {
    setupContentTab({ title: "My Post" });
    await mountAndFlush();
    expect(frontmatterPanelEl.querySelectorAll('[data-prop="title"]').length).toBe(1);
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
    expect(frontmatterPanelEl.querySelector(".doc-header-route")?.textContent).toBe("/");

    setupContentTab({ title: "Post" }, { documentPath: "posts/hello.json" });
    render();
    await flush(4);
    expect(frontmatterPanelEl.querySelector(".doc-header-route")).toBeNull();
  });

  test("SEO and Raw head tags are both disclosed, closed by default", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    expect(summaries()).toEqual(["SEO", "Raw head tags"]);
    for (const d of frontmatterPanelEl.querySelectorAll("details")) {
      expect((d as HTMLDetailsElement).open).toBe(false);
    }
  });

  test("the SEO block edits $head meta through the frontmatter round-trip", async () => {
    const tab = setupContentTab({ title: "Hello" });
    await mountAndFlush();
    fireChange(row("description").querySelector("sp-textfield")!, "A summary");
    const head = tab.doc.content.frontmatter.$head as any[];
    expect(head).toEqual([
      { attributes: { content: "A summary", name: "description" }, tagName: "meta" },
    ]);
  });

  test("Raw head tags lists what no structured control owns, and says so when empty", async () => {
    const tab = setupContentTab({ title: "Hello" });
    await mountAndFlush();
    expect(frontmatterPanelEl.querySelector(".doc-header-empty")).toBeTruthy();

    tab.doc.content.frontmatter = {
      $head: [{ attributes: { content: "me", name: "author" }, tagName: "meta" }],
      title: "Hello",
    };
    render();
    await flush(4);
    const items = [...frontmatterPanelEl.querySelectorAll(".doc-header-raw li code")];
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

  test("unmount stops reactive re-rendering", async () => {
    const tab = setupContentTab({ subtitle: "Before" });
    await mountAndFlush();
    unmount();
    transactDoc(tab, (t: any) => mutateUpdateFrontmatter(t, "subtitle", "After"));
    await flush(4);
    expect((row("subtitle").querySelector("sp-textfield") as any).value).toBe("Before");
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
    registerRenderer("frontmatterPanel", () => render());

    await mountAndFlush();
    await flush(6); // Async media listing resolves → renderOnly("frontmatterPanel") repaints
    expect(row("hero").querySelector(".media-picker")).toBeTruthy();
    expect(row("hero").querySelector('sp-action-button[title="Browse media"]')).toBeTruthy();
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
    const seo = frontmatterPanelEl.querySelector("details") as HTMLDetailsElement;
    seo.open = true;
    seo.dispatchEvent(new Event("toggle"));
    render();
    await flush(4);
    expect((frontmatterPanelEl.querySelector("details") as HTMLDetailsElement).open).toBe(true);

    (frontmatterPanelEl.querySelector("details") as HTMLDetailsElement).open = false;
    frontmatterPanelEl.querySelector("details")!.dispatchEvent(new Event("toggle"));
    render();
    await flush(4);
    expect((frontmatterPanelEl.querySelector("details") as HTMLDetailsElement).open).toBe(false);
  });

  test("a render after the host has gone is a no-op, not a throw", async () => {
    setupContentTab({ title: "Hello" });
    await mountAndFlush();
    setShell(false); // Re-inits the store refs; the host is now null
    render();
    await flush(4);
  });
});

describe("the SEO block's favicon row", () => {
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
