/**
 * The Library's observer must not retain a card the reader has scrolled past.
 *
 * `library-preview.ts` opens by saying what it fixed: the predecessor kept every rendered document
 * in an unbounded `Map`, so "a long browse leaked every document it had ever shown". The LRU bounds
 * the CACHE — but the visibility gate had its own unbounded set, and nothing released it. A slot
 * was observed when it entered the window and dropped only by the intersect callback's own
 * `unobserve`, so a card scrolled past before it ever intersected stayed observed for the life of
 * the pane. The browser walks every observation target on every scroll frame, so scrolling got
 * slower the longer you scrolled, and the retained set was bounded only by how far the reader
 * went.
 *
 * **The perf test cannot see this, by construction.** `library-perf.test.ts` deletes the global
 * `IntersectionObserver` to take the documented degraded path, where nothing is ever observed. So
 * this file installs a RECORDING observer instead: it counts `observe`/`unobserve`, holds the live
 * observation set, and can be fired on demand. Both are worth having — that file measures how much
 * the window renders, this one measures what the window forgets to let go of.
 *
 * The two scenarios are the two ways a reader scrolls: steadily, with the observer reporting each
 * step, and a flick fast enough that it never reports at all. The second is the worse one, because
 * the only release path in the old code was the report.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { resetNotifications } from "../src/services/notify";
import type { DirEntry } from "../src/types";

void mock.module("../src/files/files.js", () => ({
  createFileIn: () => Promise.resolve(null),
  loadDirectory: () => Promise.resolve(),
  openFileInTab: () => Promise.resolve(),
}));

// ─── A recording IntersectionObserver ────────────────────────────────────────

type Records = { isIntersecting: boolean; target: Element }[];

/** Every observation any instance is currently holding — what the browser would walk per frame. */
const live = new Set<Element>();
const stats = { observes: 0, unobserves: 0 };
const instances = new Set<Recording>();

class Recording {
  private readonly targets = new Set<Element>();
  private readonly callback: (records: Records) => void;

  constructor(callback: (records: Records) => void) {
    this.callback = callback;
    instances.add(this);
  }

  observe(target: Element) {
    stats.observes += 1;
    this.targets.add(target);
    live.add(target);
  }

  unobserve(target: Element) {
    stats.unobserves += 1;
    this.targets.delete(target);
    live.delete(target);
  }

  disconnect() {
    for (const target of this.targets) {
      live.delete(target);
    }
    this.targets.clear();
    instances.delete(this);
  }

  /** Report every target still in the document as intersecting — a steady scroll's callback. */
  report() {
    const snapshot = [...this.targets].filter((target) => target.isConnected);
    if (snapshot.length > 0) {
      this.callback(snapshot.map((target) => ({ isIntersecting: true, target })));
    }
  }
}

globalThis.IntersectionObserver = Recording as unknown as typeof IntersectionObserver;

function fireObservers() {
  for (const instance of instances) {
    instance.report();
  }
}

/** The observations the reader can no longer see — every one of these is pure leak. */
function detachedObservations(): number {
  return [...live].filter((element) => !element.isConnected).length;
}

const {
  detachLibraryPane,
  invalidateLibrary,
  renderLibraryMode,
  setLibraryCategory,
  setLibraryLayout,
  setLibrarySearch,
} = await import("../src/browse/library-pane");
const { openTab, closeAllTabs } = await import("../src/workspace/workspace");

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

/** The plan's acceptance case. */
const PAGE_COUNT = 300;
/** A 1200×800 pane, less the toolbar — the same box the perf measurement uses. */
const VIEWPORT = { height: 700, width: 1180 };
/** 1180 / 200 = 5 columns; 700 / 194 = 4 rows, +1 partial, +3 overscan either side. */
const WINDOW_CARDS = 55;
/**
 * Wall-clock room, not a wall-clock assertion.
 *
 * Each of these repaints a 300-page project dozens of times, and nothing here measures how long
 * that took — the assertions are all counts. Bun's 5s default is a budget for a unit test, and on a
 * loaded runner a sweep exceeds it, which would fail the file for the one reason it does not test.
 */
const SWEEP_BUDGET_MS = 30_000;

let host: HTMLElement;

function install() {
  const pages: DirEntry[] = Array.from({ length: PAGE_COUNT }, (_value, index) => ({
    name: `page-${String(index).padStart(3, "0")}.json`,
    path: `pages/page-${String(index).padStart(3, "0")}.json`,
    type: "file" as const,
  }));
  installMockPlatform({
    listDirectory: (path: string) => Promise.resolve(path === "pages" ? pages : []),
    readFile: () => Promise.resolve('{"tagName":"div","children":[]}'),
  });
  resetStudioState({ projectConfig: null, projectDirs: ["pages"], projectRoot: "" });
}

/** Mount, give the scroller the box happy-dom never computes, and repaint into the window. */
async function windowedPane(): Promise<HTMLElement> {
  detachLibraryPane();
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
  renderLibraryMode(host, tab);
  await flush();
  await flush();
  const body = host.querySelector(".library-body") as HTMLElement;
  Object.defineProperty(body, "clientHeight", { configurable: true, value: VIEWPORT.height });
  Object.defineProperty(body, "clientWidth", { configurable: true, value: VIEWPORT.width });
  body.dispatchEvent(new Event("scroll"));
  await flush();
  stats.observes = 0;
  stats.unobserves = 0;
  return body;
}

/**
 * One pass down the whole list and back up.
 *
 * The step is a little over one window (11 rows of 194px), so consecutive windows do not overlap
 * and every step detaches the whole previous screenful — the fastest way to accumulate the retained
 * set the old code never gave back, and the fewest repaints to do it in.
 */
async function sweep(body: HTMLElement, opts: { fire: boolean }) {
  const bottom = PAGE_COUNT * 194;
  for (let top = 0; top <= bottom; top += 2400) {
    body.scrollTop = top;
    body.dispatchEvent(new Event("scroll"));
    await flush();
    if (opts.fire) {
      fireObservers();
      await flush();
    }
  }
  for (let top = bottom; top >= 0; top -= 2400) {
    body.scrollTop = top;
    body.dispatchEvent(new Event("scroll"));
    await flush();
    if (opts.fire) {
      fireObservers();
      await flush();
    }
  }
}

beforeEach(() => {
  resetNotifications();
  detachLibraryPane();
  invalidateLibrary();
  setLibraryCategory("all");
  setLibraryLayout("cards");
  setLibrarySearch("");
  live.clear();
  instances.clear();
  stats.observes = 0;
  stats.unobserves = 0;
  install();
});

afterEach(() => {
  detachLibraryPane();
  host?.remove();
  live.clear();
  instances.clear();
});

describe(`${PAGE_COUNT} pages, the observation set`, () => {
  test(
    "a steady scroll down and back leaves nothing observed that the reader cannot see",
    async () => {
      const body = await windowedPane();
      await sweep(body, { fire: true });

      console.error(
        `[library observer] steady sweep, ${PAGE_COUNT} pages, ${VIEWPORT.width}×${VIEWPORT.height}: ` +
          `${stats.observes} observe(), ${stats.unobserves} unobserve(), ` +
          `${live.size} still observed, ${detachedObservations()} of them detached`,
      );

      expect(detachedObservations()).toBe(0);
      expect(live.size).toBeLessThanOrEqual(WINDOW_CARDS);
    },
    SWEEP_BUDGET_MS,
  );

  test(
    "a flick the observer never reports on releases the cards it skipped past",
    async () => {
      const body = await windowedPane();
      await sweep(body, { fire: false });

      console.error(
        `[library observer] fast flick (no reports), ${PAGE_COUNT} pages: ` +
          `${stats.observes} observe(), ${stats.unobserves} unobserve(), ` +
          `${live.size} still observed, ${detachedObservations()} of them detached`,
      );

      // Nothing was ever reported, so the intersect callback released nothing: every release here is
      // The sweep's, which is the whole point — the report path cannot be the only one.
      expect(stats.unobserves).toBeGreaterThan(0);
      expect(detachedObservations()).toBe(0);
      expect(live.size).toBeLessThanOrEqual(WINDOW_CARDS);
    },
    SWEEP_BUDGET_MS,
  );

  test(
    "the retained set plateaus — four sweeps of the same list, not four times the observations",
    async () => {
      const body = await windowedPane();
      const retained: number[] = [];
      for (let pass = 0; pass < 4; pass++) {
        await sweep(body, { fire: false });
        retained.push(live.size);
      }
      console.error(
        `[library observer] four sweeps, still observed after each: ${retained.join(" -> ")} ` +
          `(${stats.unobserves} unobserve() calls)`,
      );
      // Measured on the unfixed code, this same sweep: 805 -> 1310 -> 1815 -> 2320 still observed,
      // With zero unobserve() calls. It never plateaued, because nothing ever released.
      expect(retained[3]).toBeLessThanOrEqual(retained[0]!);
      for (const size of retained) {
        expect(size).toBeLessThanOrEqual(WINDOW_CARDS);
      }
    },
    SWEEP_BUDGET_MS,
  );

  test(
    "tearing the pane down disconnects, so nothing survives the tab",
    async () => {
      const body = await windowedPane();
      await sweep(body, { fire: false });
      expect(live.size).toBeGreaterThan(0);
      detachLibraryPane();
      expect(live.size).toBe(0);
    },
    SWEEP_BUDGET_MS,
  );
});
