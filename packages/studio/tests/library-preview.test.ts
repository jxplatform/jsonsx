/**
 * Tests for src/browse/library-preview.ts — the LRU and the visibility gate.
 *
 * The predecessor's preview map was unbounded and eager, so a 300-page project built 300 live
 * runtime subtrees on one paint and never released one. Both halves of that are asserted here: the
 * cap holds, and an evicted subtree leaves the DOM.
 */
import { installMockPlatform, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setFormats } from "../src/format/format-host";
import type { StudioFormat } from "../src/format/format-host";

/** Swapped per test — the module export itself is frozen once mocked. */
let componentPreview: () => Promise<HTMLElement> = () => {
  const el = document.createElement("div");
  el.className = "component-preview";
  return Promise.resolve(el);
};

void mock.module("../src/panels/component-preview.js", () => ({
  renderComponentPreview: () => componentPreview(),
}));

const {
  PREVIEW_CACHE_LIMIT,
  createPreviewCache,
  createPreviewObserver,
  previewFor,
  renderDocPreview,
} = await import("../src/browse/library-preview");
const { componentRegistry } = await import("../src/files/components");

function element(id: string) {
  const el = document.createElement("div");
  el.dataset.id = id;
  return el;
}

beforeEach(() => {
  installMockPlatform({}, { "pages/index.json": '{"tagName":"section","children":[]}' });
  resetStudioState({ projectConfig: null, projectDirs: [] });
  componentRegistry.length = 0;
  componentPreview = () => {
    const el = document.createElement("div");
    el.className = "component-preview";
    return Promise.resolve(el);
  };
});

describe("createPreviewCache", () => {
  test("evicts the least-recently-used entry once it is over the limit", () => {
    const cache = createPreviewCache(2);
    cache.set("a", element("a"));
    cache.set("b", element("b"));
    cache.set("c", element("c"));
    expect(cache.size()).toBe(2);
    expect(cache.keys()).toEqual(["b", "c"]);
    expect(cache.has("a")).toBe(false);
  });

  test("a read is a use — the oldest key moves", () => {
    const cache = createPreviewCache(2);
    cache.set("a", element("a"));
    cache.set("b", element("b"));
    cache.get("a");
    cache.set("c", element("c"));
    expect(cache.keys()).toEqual(["a", "c"]);
  });

  test("an evicted subtree leaves the DOM, or the cap would not bound anything", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const cache = createPreviewCache(1);
    const first = element("a");
    host.append(first);
    cache.set("a", first);
    cache.set("b", element("b"));
    expect(first.isConnected).toBe(false);
    host.remove();
  });

  test("re-setting a key replaces rather than duplicating", () => {
    const cache = createPreviewCache(4);
    cache.set("a", element("a1"));
    cache.set("a", element("a2"));
    expect(cache.size()).toBe(1);
    expect(cache.get("a")?.dataset.id).toBe("a2");
  });

  test("clear detaches everything it was holding", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const cache = createPreviewCache();
    const el = element("a");
    host.append(el);
    cache.set("a", el);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(el.isConnected).toBe(false);
    host.remove();
  });

  test("a miss is undefined, not a thrown key error", () => {
    expect(createPreviewCache().get("nope")).toBeUndefined();
  });

  test("the default limit is the committed cap", () => {
    expect(PREVIEW_CACHE_LIMIT).toBe(150);
    const cache = createPreviewCache();
    for (let i = 0; i < PREVIEW_CACHE_LIMIT + 10; i++) {
      cache.set(`k${i}`, element(`k${i}`));
    }
    expect(cache.size()).toBe(PREVIEW_CACHE_LIMIT);
  });
});

const MARKDOWN: StudioFormat = {
  capabilities: {
    parse: { identifier: "parse", timing: ["server"] },
    serialize: { identifier: "serialize", timing: ["server"] },
  },
  documentKinds: ["content", "page"],
  exportTarget: false,
  extensions: [".md"],
  mediaType: "text/markdown",
  name: "Markdown",
  remote: false,
  studio: {},
};

describe("renderDocPreview", () => {
  test("a formatted document goes through the format's parser, not JSON.parse", async () => {
    setFormats([MARKDOWN]);
    const actions: string[] = [];
    installMockPlatform(
      {
        formatAction: (payload: Record<string, unknown>) => {
          actions.push(String(payload.action));
          return Promise.resolve({ children: [], tagName: "article" });
        },
      },
      { "content/post.md": "# Hi" },
    );
    try {
      const rendered = await renderDocPreview("content/post.md");
      // The Markdown body is never valid JSON, so reaching a render at all proves the parser ran.
      expect(actions).toContain("parse");
      expect(rendered).not.toBeNull();
    } finally {
      setFormats([]);
    }
  });

  test("renders a JSON document to a detached element", async () => {
    const rendered = await renderDocPreview("pages/index.json");
    expect(rendered).not.toBeNull();
    expect(rendered!.tagName.toLowerCase()).toBe("section");
  });

  test("a file that cannot be parsed is null, not a Problem", async () => {
    installMockPlatform({}, { "pages/broken.json": "{ not json" });
    expect(await renderDocPreview("pages/broken.json")).toBeNull();
  });

  test("a file that cannot be read is null too", async () => {
    installMockPlatform({ readFile: () => Promise.reject(new Error("gone")) });
    expect(await renderDocPreview("pages/index.json")).toBeNull();
  });
});

describe("previewFor", () => {
  test("caches, so a second ask does no work", async () => {
    const cache = createPreviewCache();
    const first = await previewFor("pages/index.json", cache);
    const second = await previewFor("pages/index.json", cache);
    expect(first).toBe(second!);
    expect(cache.size()).toBe(1);
  });

  test("a registered component previews through the component renderer", async () => {
    componentRegistry.push({
      path: "components/button.json",
      source: "npm",
      tagName: "x-btn",
    } as (typeof componentRegistry)[number]);
    const rendered = await previewFor("components/button.json", createPreviewCache());
    expect(rendered?.className).toBe("component-preview");
  });

  test("an unrenderable file caches nothing, so a later fix is picked up", async () => {
    installMockPlatform({}, { "pages/broken.json": "{ not json" });
    const cache = createPreviewCache();
    expect(await previewFor("pages/broken.json", cache)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  test("a renderer that throws is absorbed rather than breaking the paint", async () => {
    componentRegistry.push({
      path: "components/bad.json",
      source: "npm",
      tagName: "x-bad",
    } as (typeof componentRegistry)[number]);
    componentPreview = () => {
      throw new Error("boom");
    };
    expect(await previewFor("components/bad.json", createPreviewCache())).toBeUndefined();
  });
});

describe("createPreviewObserver", () => {
  const original = globalThis.IntersectionObserver;

  afterEach(() => {
    globalThis.IntersectionObserver = original;
  });

  test("with no IntersectionObserver, every observed card is reported at once", () => {
    // @ts-expect-error -- deliberately removing the global to exercise the degraded path
    globalThis.IntersectionObserver = undefined;
    const seen: Element[] = [];
    const observer = createPreviewObserver((el) => seen.push(el));
    const el = element("a");
    observer.observe(el);
    // Nothing was ever watched on this path, so the sweep has nothing to find.
    expect(observer.releaseDetached()).toBe(0);
    observer.destroy();
    expect(seen).toEqual([el]);
  });

  test("reports a card once, on entry, and stops watching it", () => {
    const observed: Element[] = [];
    const unobserved: Element[] = [];
    let fire: (records: { isIntersecting: boolean; target: Element }[]) => void = () => {};
    let disconnected = false;
    function FakeIntersectionObserver(
      this: Record<string, unknown>,
      cb: (records: { isIntersecting: boolean; target: Element }[]) => void,
    ) {
      fire = cb;
      this.disconnect = () => {
        disconnected = true;
      };
      this.observe = (target: Element) => observed.push(target);
      this.unobserve = (target: Element) => unobserved.push(target);
    }
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;

    const seen: Element[] = [];
    const observer = createPreviewObserver((el) => seen.push(el));
    const visible = element("in");
    const offscreen = element("out");
    observer.observe(visible);
    observer.observe(offscreen);
    fire([
      { isIntersecting: true, target: visible },
      { isIntersecting: false, target: offscreen },
    ]);
    expect(seen).toEqual([visible]);
    expect(unobserved).toEqual([visible]);
    // Both cards are detached fixtures, so a sweep would take everything still watched. It takes
    // Exactly one: the reported card was already released, and the other was NOT.
    expect(observer.releaseDetached()).toBe(1);
    expect(unobserved).toEqual([visible, offscreen]);
    observer.destroy();
    expect(disconnected).toBe(true);
    expect(observed.length).toBe(2);
  });

  test("observing the same card twice watches it once — a repaint per scroll frame is not two", () => {
    const observed: Element[] = [];
    function FakeIntersectionObserver(this: Record<string, unknown>) {
      this.disconnect = () => {};
      this.observe = (target: Element) => observed.push(target);
      this.unobserve = () => {};
    }
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;

    const observer = createPreviewObserver(() => {});
    const card = element("a");
    observer.observe(card);
    observer.observe(card);
    observer.observe(card);
    expect(observed).toEqual([card]);
  });

  /**
   * The leak this API exists for.
   *
   * A card scrolled past before it ever intersected is never reported, so the intersect callback —
   * the only release path there used to be — never runs for it. Left alone the browser walks it on
   * every scroll frame forever, and the retained set grows with how far the reader went.
   */
  test("releaseDetached drops exactly the cards that left the document, and keeps the rest", () => {
    const unobserved: Element[] = [];
    function FakeIntersectionObserver(this: Record<string, unknown>) {
      this.disconnect = () => {};
      this.observe = () => {};
      this.unobserve = (target: Element) => unobserved.push(target);
    }
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;

    const host = document.createElement("div");
    document.body.append(host);
    const observer = createPreviewObserver(() => {});
    const onscreen = element("in-window");
    const scrolledPast = element("gone");
    host.append(onscreen, scrolledPast);
    observer.observe(onscreen);
    observer.observe(scrolledPast);

    // What a repaint does to a card the window has moved off.
    scrolledPast.remove();

    expect(observer.releaseDetached()).toBe(1);
    expect(unobserved).toEqual([scrolledPast]);
    // Idempotent: the pane calls it after every commit, and most commits detach nothing.
    expect(observer.releaseDetached()).toBe(0);
    expect(unobserved).toEqual([scrolledPast]);

    // The card still in the window was kept — proven by taking it out and sweeping again.
    onscreen.remove();
    expect(observer.releaseDetached()).toBe(1);
    expect(unobserved).toEqual([scrolledPast, onscreen]);

    observer.destroy();
    host.remove();
  });
});
