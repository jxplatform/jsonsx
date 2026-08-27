/**
 * Publishing the unsaved document, so a live preview shows the canvas rather than the disk.
 *
 * Three properties are the feature: a dirty document publishes and a clean one does not; a document
 * in a BACKGROUND tab publishes too, because the layout a page uses lives in another tab and that
 * is half the point; and whatever reason a document has for no longer being unsaved, the retraction
 * follows from the same diff rather than from a hook somewhere else that could be forgotten.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { closeAllTabs, openTab } from "../src/workspace/workspace";
import { transactDoc } from "../src/tabs/transact";
import {
  armPreviewOverlay,
  disarmPreviewOverlay,
  flushPreviewOverlay,
  notePreviewOverlayEdit,
} from "../src/preview/preview-overlay";
import type { Tab } from "../src/tabs/tab";

/** Every overlay call the platform saw, in order. */
let published: [string, string][];
let cleared: (string | undefined)[];

function installOverlayPlatform() {
  published = [];
  cleared = [];
  return installMockPlatform({
    clearPreviewOverlay: (path?: string) => {
      cleared.push(path);
      return Promise.resolve();
    },
    setPreviewOverlay: (path: string, contents: string) => {
      published.push([path, contents]);
      return Promise.resolve();
    },
  });
}

/** A tab holding a document at `path`. */
function tabAt(path: string, children: unknown[] = ["Hello"]): Tab {
  return openTab({
    document: { children, tagName: "main" },
    documentPath: path,
    id: path,
  })!;
}

/** Mark a tab dirty the way a real structural edit does — through `transactDoc`. */
function edit(tab: Tab, text: string) {
  transactDoc(tab, (target) => {
    (target.doc.document as unknown as { children: unknown[] }).children = [text];
  });
}

beforeEach(() => {
  resetStudioState();
  installOverlayPlatform();
});

afterEach(() => {
  disarmPreviewOverlay();
  closeAllTabs();
});

describe("arming", () => {
  test("nothing is published before a preview exists to publish to", async () => {
    const tab = tabAt("pages/index.json");
    edit(tab, "Edited");
    await flush();
    await flushPreviewOverlay();
    expect(published).toEqual([]);
  });

  test("arming is idempotent — every Open in Browser calls it", async () => {
    armPreviewOverlay();
    armPreviewOverlay();
    const tab = tabAt("pages/index.json");
    edit(tab, "Edited");
    await flushPreviewOverlay();
    expect(published.filter(([path]) => path === "pages/index.json")).toHaveLength(1);
  });
});

describe("what publishes", () => {
  beforeEach(() => {
    armPreviewOverlay();
  });

  test("a dirty document publishes the bytes a save would write", async () => {
    const tab = tabAt("pages/index.json");
    edit(tab, "Unsaved");
    await flushPreviewOverlay();
    expect(published.at(-1)![0]).toBe("pages/index.json");
    expect(published.at(-1)![1]).toContain("Unsaved");
  });

  test("a clean document publishes nothing — its bytes are on disk by definition", async () => {
    tabAt("pages/index.json");
    await flushPreviewOverlay();
    expect(published).toEqual([]);
  });

  test("a dirty document in a BACKGROUND tab publishes", async () => {
    /* The previewed page is not the only document that matters: the layout it wraps in and the
       component it uses live in other tabs, and an unsaved edit to either changes the page. */
    const page = tabAt("pages/index.json");
    const layout = tabAt("layouts/base.json");
    edit(page, "Page");
    edit(layout, "Layout");
    await flushPreviewOverlay();
    expect(published.map(([path]) => path).toSorted()).toEqual([
      "layouts/base.json",
      "pages/index.json",
    ]);
  });

  test("a document with no path has no key a composer could read it by", async () => {
    const tab = openTab({ document: { children: [], tagName: "main" }, id: "scratch" })!;
    edit(tab, "Scratch");
    await flushPreviewOverlay();
    expect(published).toEqual([]);
  });

  test("a leading ./ is stripped, because that is the key a backend reads", async () => {
    const tab = tabAt("./pages/index.json");
    edit(tab, "Edited");
    await flushPreviewOverlay();
    expect(published.at(-1)![0]).toBe("pages/index.json");
  });

  test("identical bytes are not republished", async () => {
    const tab = tabAt("pages/index.json");
    edit(tab, "Same");
    await flushPreviewOverlay();
    const first = published.length;
    /* An edit that lands on the same bytes — typing a character and deleting it — is not a change
       anyone can see, and republishing would cost the reader a reload for nothing. */
    edit(tab, "Same");
    await flushPreviewOverlay();
    expect(published).toHaveLength(first);
  });

  test("a real change after an identical one does publish", async () => {
    const tab = tabAt("pages/index.json");
    edit(tab, "One");
    await flushPreviewOverlay();
    edit(tab, "One");
    await flushPreviewOverlay();
    edit(tab, "Two");
    await flushPreviewOverlay();
    expect(published.at(-1)![1]).toContain("Two");
  });
});

describe("what retracts", () => {
  beforeEach(() => {
    armPreviewOverlay();
  });

  test("a document that stops being dirty is retracted", async () => {
    const tab = tabAt("pages/index.json");
    edit(tab, "Unsaved");
    await flushPreviewOverlay();
    expect(cleared).toEqual([]);
    tab.doc.dirty = false;
    await flushPreviewOverlay();
    expect(cleared).toEqual(["pages/index.json"]);
  });

  test("a closed tab is retracted, with no close hook anywhere", async () => {
    /* The publish is a diff against what was last published, so every reason a document has for no
       longer being unsaved — saved, closed, discarded, undone back to its file — resolves here. */
    const tab = tabAt("pages/index.json");
    edit(tab, "Unsaved");
    await flushPreviewOverlay();
    closeAllTabs();
    await flushPreviewOverlay();
    expect(cleared).toEqual(["pages/index.json"]);
  });

  test("a retraction happens once, not on every pass", async () => {
    const tab = tabAt("pages/index.json");
    edit(tab, "Unsaved");
    await flushPreviewOverlay();
    tab.doc.dirty = false;
    await flushPreviewOverlay();
    await flushPreviewOverlay();
    expect(cleared).toEqual(["pages/index.json"]);
  });
});

describe("the seam for edits the effect cannot see", () => {
  test("an in-place mutation publishes when it is noted", async () => {
    /* A content-entry field writes a key in place on an already-dirty tab, so the document's root
       reference — which is all the effect reads — is untouched. Without the note, a field edited
       twice would stop reaching a live preview after the first. */
    armPreviewOverlay();
    const tab = tabAt("pages/index.json");
    edit(tab, "First");
    await flushPreviewOverlay();
    const before = published.length;
    (tab.doc.document as unknown as Record<string, unknown>).title = "In place";
    notePreviewOverlayEdit();
    await flushPreviewOverlay();
    expect(published.length).toBeGreaterThan(before);
    expect(published.at(-1)![1]).toContain("In place");
  });

  test("noting an edit while disarmed does nothing", async () => {
    const tab = tabAt("pages/index.json");
    edit(tab, "Edited");
    notePreviewOverlayEdit();
    await flushPreviewOverlay();
    expect(published).toEqual([]);
  });
});

describe("disarming", () => {
  test("a pending publish is dropped rather than landing after the switch", async () => {
    /* Disarm runs on a project switch, and a timer scheduled by the outgoing project's last
       keystroke would otherwise fire against the incoming one's backend. */
    armPreviewOverlay();
    const tab = tabAt("pages/index.json");
    edit(tab, "Pending");
    disarmPreviewOverlay();
    await Bun.sleep(320);
    expect(published).toEqual([]);
  });

  test("stops publishing and forgets what was published", async () => {
    armPreviewOverlay();
    const tab = tabAt("pages/index.json");
    edit(tab, "One");
    await flushPreviewOverlay();
    disarmPreviewOverlay();
    edit(tab, "Two");
    await flushPreviewOverlay();
    expect(published.at(-1)![1]).toContain("One");
  });

  test("re-arming after a project switch republishes rather than trusting the old map", async () => {
    // The published map is keyed by project-relative path, so one project's `pages/index.json`
    // Must not stand in as the answer for another's.
    armPreviewOverlay();
    const tab = tabAt("pages/index.json");
    edit(tab, "Same bytes");
    await flushPreviewOverlay();
    const before = published.length;
    disarmPreviewOverlay();
    armPreviewOverlay();
    await flushPreviewOverlay();
    expect(published.length).toBeGreaterThan(before);
  });
});

describe("the debounce", () => {
  test("a burst publishes once, on its own, with no flush", async () => {
    /* The flush exists for two specific moments; ordinary editing is carried by the timer, and a
       burst of keystrokes is one thought as far as a reader is concerned. */
    armPreviewOverlay();
    const tab = tabAt("pages/index.json");
    edit(tab, "One");
    edit(tab, "Two");
    edit(tab, "Three");
    expect(published).toEqual([]);
    await Bun.sleep(320);
    expect(published).toHaveLength(1);
    expect(published.at(-1)![1]).toContain("Three");
  });

  test("a flush cancels the pending timer rather than racing it", async () => {
    armPreviewOverlay();
    const tab = tabAt("pages/index.json");
    edit(tab, "Flushed");
    await flushPreviewOverlay();
    expect(published).toHaveLength(1);
    await Bun.sleep(320);
    // The timer the edit scheduled did not fire a second, identical publish behind the flush.
    expect(published).toHaveLength(1);
  });
});

describe("a document that will not serialize", () => {
  test("is skipped, and the documents beside it still publish", async () => {
    /* A half-typed document is not a reason to stop previewing the layout next to it, and the next
       edit that does serialize publishes it. */
    armPreviewOverlay();
    const page = tabAt("pages/index.json");
    const layout = tabAt("layouts/base.json");
    edit(page, "Page");
    edit(layout, "Layout");
    const circular: Record<string, unknown> = { tagName: "main" };
    circular.self = circular;
    (page.doc as unknown as { document: unknown }).document = circular;
    await flushPreviewOverlay();
    expect(published.map(([path]) => path)).toEqual(["layouts/base.json"]);
  });
});

describe("no platform at all", () => {
  test("publishes nothing rather than throwing", async () => {
    armPreviewOverlay();
    const tab = tabAt("pages/index.json");
    edit(tab, "Edited");
    const holder = globalThis as unknown as { __jxPlatform?: unknown };
    const saved = holder.__jxPlatform;
    delete holder.__jxPlatform;
    try {
      // oxlint-disable-next-line typescript/await-thenable -- bun test .resolves is typed `void` but returns a real Promise; the await is required.
      await expect(flushPreviewOverlay()).resolves.toBeUndefined();
      expect(published).toEqual([]);
    } finally {
      holder.__jxPlatform = saved;
    }
  });
});

describe("a backend that cannot hold an overlay", () => {
  test("publishes nothing rather than throwing", async () => {
    installMockPlatform({});
    armPreviewOverlay();
    const tab = tabAt("pages/index.json");
    edit(tab, "Edited");
    // oxlint-disable-next-line typescript/await-thenable -- bun test .resolves is typed `void` but returns a real Promise; the await is required.
    await expect(flushPreviewOverlay()).resolves.toBeUndefined();
  });
});
