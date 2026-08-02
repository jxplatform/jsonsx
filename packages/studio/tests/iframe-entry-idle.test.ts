/**
 * The canvas frame's own quiescence report (`{kind: "idle"}`), plan §13.4 condition 5.
 *
 * The parent realm cannot see inside a cross-origin frame, so before this the only way to ask "has
 * the canvas settled?" was `wait: {ms}`. Three things the frame knows and nobody else does are
 * asserted here: whether its fonts have loaded, whether an animation is running, and whether
 * `installCanvasImageRetry` still has a re-fire pending.
 */
import "./with-dom.js";
import { afterEach, describe, expect, test } from "bun:test";
import { fakeChannelPair } from "../src/canvas/iframe-channel";
import { flush } from "./harness";
import {
  IDLE_QUIET_FRAMES,
  IDLE_WATCH_MAX_MS,
  IMAGE_RETRY_WINDOW_MS,
  startCanvasIframe,
} from "../src/canvas/iframe-entry";
import type { IframeToParent, ParentToIframe } from "../src/canvas/iframe-protocol";

type IdleMsg = Extract<IframeToParent, { kind: "idle" }>;

interface Harness {
  idles: IdleMsg[];
  /** Run the frame the watcher queued, if any. Returns whether one was pending. */
  tick: () => boolean;
  pair: ReturnType<typeof fakeChannelPair<ParentToIframe, IframeToParent>>;
  container: HTMLElement;
  /** Advance the stubbed clock. */
  advance: (ms: number) => void;
}

let teardown: (() => void) | undefined;
let restore: (() => void) | undefined;

afterEach(() => {
  teardown?.();
  teardown = undefined;
  restore?.();
  restore = undefined;
  document.body.innerHTML = "";
});

function boot(options: { animations?: number; fontStatus?: string } = {}): Harness {
  const win = window as unknown as {
    requestAnimationFrame: (cb: () => void) => number;
    cancelAnimationFrame: (h: number) => void;
  };
  const origRaf = win.requestAnimationFrame;
  const origCancel = win.cancelAnimationFrame;
  const origNow = Date.now;
  const origFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  const origGetAnimations = document.getAnimations;

  let queued: (() => void) | null = null;
  win.requestAnimationFrame = (cb: () => void) => {
    queued = cb;
    return 1;
  };
  win.cancelAnimationFrame = () => {
    queued = null;
  };
  let clock = 1_000_000;
  Date.now = () => clock;
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { status: options.fontStatus ?? "loaded" },
  });
  const running = Array.from({ length: options.animations ?? 0 }, () => ({
    playState: "running",
  })) as Animation[];
  document.getAnimations = () => [...running, { playState: "finished" } as Animation];

  restore = () => {
    win.requestAnimationFrame = origRaf;
    win.cancelAnimationFrame = origCancel;
    Date.now = origNow;
    document.getAnimations = origGetAnimations;
    if (origFonts) {
      Object.defineProperty(document, "fonts", origFonts);
    }
  };

  const pair = fakeChannelPair<ParentToIframe, IframeToParent>();
  const idles: IdleMsg[] = [];
  pair.parent.onMessage((m) => {
    if (m.kind === "idle") {
      idles.push(m);
    }
  });
  const container = document.createElement("div");
  document.body.append(container);
  teardown = startCanvasIframe({ channel: pair.iframe, container });

  return {
    advance: (ms) => {
      clock += ms;
    },
    container,
    idles,
    pair,
    tick: () => {
      const cb = queued;
      queued = null;
      cb?.();
      pair.flush();
      return cb !== null;
    },
  };
}

describe("the frame's quiescence report", () => {
  test("posts one settled sample and then stops sampling", () => {
    const h = boot();
    // Frame 1 posts the first (already quiet) sample; frame 2 is the second consecutive quiet one.
    expect(h.tick()).toBe(true);
    expect(h.idles).toEqual([{ animations: 0, fonts: true, gen: -1, images: 0, kind: "idle" }]);
    expect(h.tick()).toBe(true);
    expect(h.idles).toHaveLength(1);
    // Settled: the watcher disarmed rather than burning a frame a second for the tab's lifetime.
    expect(h.tick()).toBe(false);
    expect(IDLE_QUIET_FRAMES).toBe(2);
  });

  test("fonts still loading keeps the frame reporting itself busy", () => {
    // `document.fonts.status` is not trusted ALONE — in a blank canvas frame it says "loaded"
    // Against an empty set — but a frame that admits it is still loading is believed.
    const h = boot({ fontStatus: "loading" });
    h.tick();
    expect(h.idles.at(-1)).toMatchObject({ fonts: false });
    // Never reaches two quiet frames, so it keeps sampling until its own deadline.
    expect(h.tick()).toBe(true);
    expect(h.tick()).toBe(true);
  });

  test("running animations are counted, finished ones are not", () => {
    const h = boot({ animations: 2 });
    h.tick();
    expect(h.idles.at(-1)).toMatchObject({ animations: 2 });
  });

  test("gives up sampling at its deadline rather than looping forever", () => {
    const h = boot({ animations: 1 });
    h.tick();
    expect(h.tick()).toBe(true);
    h.advance(IDLE_WATCH_MAX_MS + 1);
    h.tick();
    // The last posted sample still NAMES the animation, so the parent stays honestly not-idle.
    expect(h.idles.at(-1)).toMatchObject({ animations: 1 });
    expect(h.tick()).toBe(false);
  });

  test("a failed image is a pending RETRY, and a later load clears it", () => {
    const h = boot();
    h.tick();
    h.tick();
    expect(h.tick()).toBe(false); // Settled.

    const img = document.createElement("img");
    h.container.append(img);
    img.dispatchEvent(new Event("error"));
    h.tick();
    expect(h.idles.at(-1)).toMatchObject({ images: 1 });

    img.dispatchEvent(new Event("load"));
    h.tick();
    expect(h.idles.at(-1)).toMatchObject({ images: 0 });
  });

  test("a retry that never resolves settles broken once its window passes", () => {
    // Bounded on purpose: `installCanvasImageRetry` gives up after three attempts, so a genuinely
    // Missing file must stop being a reason to wait — otherwise a 404 favicon wedges every capture.
    const h = boot();
    const img = document.createElement("img");
    h.container.append(img);
    img.dispatchEvent(new Event("error"));
    h.tick();
    expect(h.idles.at(-1)).toMatchObject({ images: 1 });
    h.advance(IMAGE_RETRY_WINDOW_MS + 1);
    h.tick();
    expect(h.idles.at(-1)).toMatchObject({ images: 0 });
  });

  test("a load event for an image that never failed changes nothing", () => {
    const h = boot();
    h.tick();
    h.tick();
    const img = document.createElement("img");
    h.container.append(img);
    img.dispatchEvent(new Event("load"));
    // Nothing re-armed, because nothing was pending.
    expect(h.tick()).toBe(false);
    expect(h.idles).toHaveLength(1);
  });

  test("a non-image error in the frame is not mistaken for a pending retry", () => {
    const h = boot();
    h.tick();
    h.tick();
    h.container.dispatchEvent(new Event("error"));
    expect(h.tick()).toBe(false);
  });

  test("the sample carries the generation the frame's DOM reflects", async () => {
    const h = boot();
    h.pair.parent.post({
      colorScheme: null,
      doc: { children: ["hi"], tagName: "div" },
      docBase: "http://localhost:3000/",
      gen: 5,
      kind: "render",
      mapperCtx: {
        arrayPaths: [],
        canvasMode: "design",
        layoutWrapped: false,
        pageContentOffset: null,
        pageContentPrefix: null,
      },
      mode: "design",
      shadowDoc: { children: ["hi"], tagName: "div" },
      siteStyle: null,
    });
    h.pair.flush();
    await flush();
    h.pair.flush();
    h.tick();
    expect(h.idles.at(-1)).toMatchObject({ gen: 5 });
  });

  test("teardown cancels the pending frame and unhooks the image listeners", () => {
    const h = boot({ fontStatus: "loading" });
    h.tick();
    teardown?.();
    teardown = undefined;
    expect(h.tick()).toBe(false);
    const before = h.idles.length;
    const img = document.createElement("img");
    h.container.append(img);
    img.dispatchEvent(new Event("error"));
    expect(h.tick()).toBe(false);
    expect(h.idles).toHaveLength(before);
  });
});
