/**
 * Diff-gap tests for three surfaces the existing suites leave unexercised.
 *
 * - **`src/browse/library-pane.ts`** — the context menu's outside-click dismissal (the sibling test
 *   dismisses with `pointerdown`, and the layer listens for `mousedown`); a drop whose destination
 *   prompt is cancelled; the EMPTY state's own Retry, which is a different button from the
 *   incomplete-scan banner's and sits below it in the DOM; and the click that opens a card.
 * - **`src/platforms/devserver.ts`** — `buildSite`, including the sentence it falls back to when the
 *   backend named no error at all.
 * - **`src/platforms/cloud.ts`** — `cfConnect`'s poll RE-ARMING itself: the popup is still open and
 *   the broker has nothing yet, which is the one branch every existing poll test settles before
 *   reaching; and, over a timer table with distinct ids, that the handle it re-armed is the one
 *   `cleanup` clears — so the settled promise leaves nothing behind to poll the broker again.
 */
import {
  answerPromptDialog,
  dragEvent,
  flush,
  installMockPlatform,
  resetStudioState,
  surfaceOf,
  testFile,
  topDialog,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { resetNotifications } from "../src/services/notify";
import { resetActivities } from "../src/panels/activity-panel";
import { createDevServerPlatform } from "../src/platforms/devserver";
import { createCloudPlatform } from "../src/platforms/cloud";
import type { DirEntry } from "../src/types";

// ─── Seams ───────────────────────────────────────────────────────────────────

const opened: string[] = [];
const uploads: { dir: string | undefined; count: number }[] = [];

// Only two seams are replaced — opening a tab and writing bytes. Everything else in these two
// Modules (extension tables, `isImage`, the media-kind probe) is real, because the layouts and the
// Category model read it and a hand-written stand-in would be a second source of truth.
const realFiles = await import("../src/files/files");
const realUpload = await import("../src/files/media-upload");

void mock.module("../src/files/files.js", () => ({
  ...realFiles,
  openFileInTab: (path: string) => {
    opened.push(path);
    return Promise.resolve();
  },
}));
void mock.module("../src/files/media-upload.js", () => ({
  ...realUpload,
  uploadAssets: (files: File[], opts: { dir?: string }) => {
    uploads.push({ count: files.length, dir: opts.dir });
    return Promise.resolve(files.map((f) => ({ path: `${opts.dir ?? "?"}/${f.name}` })));
  },
}));

const {
  detachLibraryPane,
  invalidateLibrary,
  renderLibraryMode,
  setLibraryCategory,
  setLibraryLayout,
  setLibrarySearch,
} = await import("../src/browse/library-pane");
const { closeAllTabs, openTab } = await import("../src/workspace/workspace");

// ─── Environment ─────────────────────────────────────────────────────────────

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

/* Same reason as library-pane.test.ts: happy-dom's IntersectionObserver never fires, so its absence
   takes `createPreviewObserver`'s documented degraded path instead of stalling every preview. */
// @ts-expect-error -- removing the global is the point
globalThis.IntersectionObserver = undefined;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function file(name: string, path: string): DirEntry {
  return { name, path, type: "file" };
}

const TREE: Record<string, DirEntry[]> = {
  content: [file("2024-01-02-hello.md", "content/2024-01-02-hello.md")],
  layouts: [file("main.json", "layouts/main.json")],
  pages: [file("index.json", "pages/index.json"), file("about.json", "pages/about.json")],
  public: [file("logo.png", "public/logo.png")],
};

let host: HTMLElement;

function setup(listDirectory: (path: string) => Promise<DirEntry[]>, dirs = Object.keys(TREE)) {
  installMockPlatform({ listDirectory });
  resetStudioState({ projectConfig: null, projectDirs: dirs, projectRoot: "" });
}

async function mount(): Promise<HTMLElement> {
  detachLibraryPane("primary");
  host?.remove();
  closeAllTabs();
  const tab = openTab({
    capabilities: { modes: ["manage"] },
    document: { children: [], tagName: "div" },
    documentPath: null,
    id: "grid://library",
  });
  host = document.createElement("div");
  document.body.append(host);
  renderLibraryMode(surfaceOf(host), tab);
  await flush();
  await flush();
  return host;
}

function popovers(): number {
  return document.querySelectorAll("#layer-dialog sp-popover").length;
}

// ─── Library pane ────────────────────────────────────────────────────────────

describe("the Library pane", () => {
  beforeEach(() => {
    opened.length = 0;
    uploads.length = 0;
    resetNotifications();
    resetActivities();
    detachLibraryPane("primary");
    invalidateLibrary();
    setLibraryCategory("all");
    setLibraryLayout("cards");
    setLibrarySearch("");
    setup((path) => Promise.resolve(TREE[path] ?? []));
  });

  afterEach(() => {
    detachLibraryPane("primary");
    host?.remove();
  });

  test("a click on a card opens THAT card's path, not the first one drawn", async () => {
    await mount();
    const card = host.querySelector('.library-card[data-path="public/logo.png"]') as HTMLElement;
    expect(card).not.toBeNull();
    card.click();
    await flush();
    expect(opened).toEqual(["public/logo.png"]);
  });

  test("the EMPTY state carries its own Retry, and pressing it re-scans", async () => {
    let broken = true;
    setup((path) =>
      broken ? Promise.reject(new Error("HTTP 500")) : Promise.resolve(TREE[path] ?? []),
    );
    await mount();
    // Nothing was read, so the list is empty AND incomplete: the banner is drawn above the body and
    // The empty state inside it. They are two buttons, and this is the second one.
    const empty = host.querySelector(".library-empty") as HTMLElement;
    expect(empty.textContent).toContain("the scan did not finish");
    const retry = empty.querySelector("sp-button") as HTMLElement;
    expect(host.querySelectorAll("sp-button").length).toBeGreaterThan(1);

    broken = false;
    retry.click();
    await flush();
    await flush();
    expect(host.querySelectorAll(".library-card").length).toBe(5);
    expect(host.querySelector(".library-empty")).toBeNull();
  });

  test("a drop into All whose destination prompt is cancelled uploads nothing", async () => {
    setLibraryCategory("all");
    await mount();
    const body = host.querySelector(".library-body") as HTMLElement;
    dragEvent(body, "drop", [testFile("shot.png")]);
    await flush();
    // The drop really did reach the upload flow — it is waiting on the destination.
    expect(topDialog()).not.toBeNull();
    await answerPromptDialog(null);
    await flush();
    expect(uploads).toEqual([]);
  });

  test("…and the same drop, answered, uploads into the folder the author named", async () => {
    setLibraryCategory("all");
    await mount();
    const body = host.querySelector(".library-body") as HTMLElement;
    dragEvent(body, "drop", [testFile("shot.png")]);
    await flush();
    await answerPromptDialog("assets/media/");
    await flush();
    expect(uploads).toEqual([{ count: 1, dir: "assets/media" }]);
  });

  test("an outside mousedown dismisses the context menu, and the next right-click reopens one", async () => {
    await mount();
    const card = host.querySelector(".library-card") as HTMLElement;
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    expect(popovers()).toBe(1);

    // The layer's dismissal listener is a capturing `mousedown` on the document — not `pointerdown`.
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(popovers()).toBe(0);

    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    expect(popovers()).toBe(1);
    const open = [...document.querySelectorAll("#layer-dialog sp-menu-item")].find(
      (n) => (n.textContent ?? "").trim() === "Open",
    ) as HTMLElement;
    open.click();
    await flush();
    expect(opened.length).toBe(1);
  });
});

// ─── Dev-server adapter: buildSite ───────────────────────────────────────────

describe("the dev-server adapter's buildSite", () => {
  const realFetch = globalThis.fetch;
  let calls: { method: string; path: string }[] = [];

  function serve(body: unknown, status = 200): void {
    calls = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        path: new URL(String(input), "http://localhost").pathname,
      });
      return Promise.resolve(Response.json(body, { status }));
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POSTs /__studio/build and hands back the build result", async () => {
    serve({ errors: [], files: 3, routes: 2, url: "http://localhost:4321" });
    const p = createDevServerPlatform();
    expect(await p.buildSite()).toEqual({
      errors: [],
      files: 3,
      routes: 2,
      url: "http://localhost:4321",
    });
    expect(calls).toEqual([{ method: "POST", path: "/__studio/build" }]);
  });

  test("a failed build throws the backend's own reason", async () => {
    serve({ error: "pages/index.json: unknown $ref" }, 500);
    const p = createDevServerPlatform();
    expect(p.buildSite()).rejects.toThrow("pages/index.json: unknown $ref");
  });

  test("a failure that named no reason still says the build failed", async () => {
    serve({}, 500);
    const p = createDevServerPlatform();
    expect(p.buildSite()).rejects.toThrow("The site could not be built.");
  });
});

// ─── Cloud adapter: the cfConnect poll ───────────────────────────────────────

describe("the cloud adapter's cfConnect poll", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("re-arms itself while the popup is open and the broker has nothing yet", async () => {
    let checks = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/cf/connection")) {
        checks += 1;
        return Promise.resolve(
          Response.json(checks < 3 ? { connected: false } : { accountId: "acct", connected: true }),
        );
      }
      return Promise.resolve(Response.json({}));
    }) as typeof fetch;

    const realOpen = window.open;
    const realTimeout = window.setTimeout;
    const popup = { close: mock(() => {}), closed: false };
    const delays: (number | undefined)[] = [];
    (window as { open: unknown }).open = mock(() => popup);
    (window as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms);
      queueMicrotask(fn);
      return 1;
    }) as unknown as typeof window.setTimeout;

    try {
      const p = createCloudPlatform(null);
      expect(await p.cfConnect?.()).toEqual({ accountId: "acct", connected: true });
      // Two empty polls, each of which had to re-arm the timer, then the one that found it. Without
      // The re-arm the second check never happens and the promise never settles.
      expect(checks).toBe(3);
      expect(delays).toEqual([1500, 1500, 1500]);
      expect(popup.close).toHaveBeenCalled();
    } finally {
      (window as { open: unknown }).open = realOpen;
      (window as { setTimeout: unknown }).setTimeout = realTimeout;
    }
  });

  /**
   * Drain the promise chain. Everything `cfConnect` does between timers is promise work over a
   * stubbed `fetch`, and this test HOLDS the timers rather than firing them, so a handful of
   * microtask turns is the entire clock.
   */
  async function drain(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
  }

  test("the timer it re-armed is the one cleanup clears — nothing polls after the promise settles", async () => {
    let connected = false;
    const fetched: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetched.push(String(input));
      return Promise.resolve({
        json: () =>
          Promise.resolve(
            connected ? { accountId: "acct", connected: true } : { connected: false },
          ),
        ok: true,
      } as unknown as Response);
    }) as typeof fetch;

    const realOpen = window.open;
    const realTimeout = window.setTimeout;
    const realClear = window.clearTimeout;
    const popup = { close: () => {}, closed: false };
    /* A hand-driven timer table, which is the whole point: the sibling test above returns the same
       id (1) for every arm, so the re-armed handle and the stale one are indistinguishable and
       `cleanup`'s `clearTimeout` cannot be wrong. Here every arm gets its own id and `clearTimeout`
       really removes the entry — so a timer the poll re-armed but stopped TRACKING survives in
       `armed`, and firing what survives is a poll running after the author already has an answer. */
    const armed = new Map<number, () => void>();
    const cleared: number[] = [];
    let nextId = 0;
    (window as { open: unknown }).open = () => popup;
    (window as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
      nextId += 1;
      armed.set(nextId, fn);
      return nextId;
    }) as unknown as typeof window.setTimeout;
    (window as { clearTimeout: unknown }).clearTimeout = ((id: number) => {
      cleared.push(id);
      armed.delete(id);
    }) as unknown as typeof window.clearTimeout;

    /** Fire one armed timer, exactly as the platform would: it is consumed, then it runs. */
    async function fire(id: number): Promise<void> {
      const fn = armed.get(id);
      armed.delete(id);
      fn?.();
      await drain();
    }

    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      expect([...armed.keys()]).toEqual([1]);

      await fire(1);
      // The broker has nothing and the popup is open, so that poll armed a SECOND timer.
      expect([...armed.keys()]).toEqual([2]);
      expect(fetched).toEqual(["/api/v1/cf/connection"]);

      // The home shell relays success while timer 2 is still armed.
      connected = true;
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { reason: null, source: "jx-cf", status: "connected" },
          origin: location.origin,
        }),
      );
      expect(await pending).toEqual({ accountId: "acct", connected: true });

      // Cleanup cleared the id the poll RE-ARMED, not the stale first one…
      expect(cleared).toEqual([2]);
      // …so there is nothing left to fire, and firing what is left asks the broker nothing more.
      const settledAt = fetched.length;
      const stragglers = [...armed.keys()];
      for (const id of stragglers) {
        await fire(id);
      }
      expect([armed.size, fetched.length]).toEqual([0, settledAt]);
    } finally {
      (window as { open: unknown }).open = realOpen;
      (window as { setTimeout: unknown }).setTimeout = realTimeout;
      (window as { clearTimeout: unknown }).clearTimeout = realClear;
    }
  });
});
