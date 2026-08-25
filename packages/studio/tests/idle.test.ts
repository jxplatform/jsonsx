/**
 * `probe.idle()` — "settled" as a predicate that can FAIL.
 *
 * The property under test is not "it eventually resolves" (a sleep does that). It is that a timeout
 * NAMES what it was waiting on: 115 manifest sleeps were 115 places a slow subsystem was answered
 * with `+500 ms` and the wrong state was accepted.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  NotIdleError,
  QUIET_FRAMES,
  defaultIdleSources,
  idleBlockers,
  probeIdle,
} from "../src/services/idle";
import { registerRenderer, render } from "../src/store";
import { createPanelScheduler } from "../src/panels/panel-scheduler";
import { beginActivity, resetActivities } from "../src/panels/activity-panel";
import { registerPlatform } from "../src/platform";
import type { IdleSource } from "../src/services/idle";
import type { StudioPlatform } from "../src/types";

/** A frame scheduler that runs synchronously, so a test never waits on a compositor. */
function syncRaf(): (callback: () => void) => void {
  return (callback) => {
    queueMicrotask(callback);
  };
}

function source(name: string, blockers: () => string[]): IdleSource {
  return { blockers, name };
}

beforeEach(() => {
  delete (globalThis as { __jxPlatform?: StudioPlatform }).__jxPlatform;
});

describe("probeIdle", () => {
  test("resolves only after the required consecutive quiet frames", async () => {
    let frames = 0;
    const noisyForOneFrame = source("test", () =>
      frames === 0 ? ((frames += 1), ["test: busy"]) : [],
    );
    let ticks = 0;
    await probeIdle({
      raf: (callback) => {
        ticks += 1;
        queueMicrotask(callback);
      },
      sources: [noisyForOneFrame],
    });
    // Frame 1 noisy, frames 2 and 3 quiet — the second quiet frame is what resolves it.
    expect(ticks).toBe(3);
    expect(QUIET_FRAMES).toBe(2);
  });

  test("a single quiet frame is not enough", async () => {
    // Quiet, noisy, then quiet forever: a one-frame check would have resolved on the first frame
    // And photographed the state the second frame was still changing.
    const pattern = ["", "flap: busy", "", ""];
    let index = 0;
    const flapping = source("flap", () => {
      const value = pattern[index] ?? "";
      index += 1;
      return value ? [value] : [];
    });
    let ticks = 0;
    await probeIdle({
      raf: (callback) => {
        ticks += 1;
        queueMicrotask(callback);
      },
      sources: [flapping],
    });
    expect(ticks).toBe(4);
  });

  test("rejects naming every outstanding item", async () => {
    const promise = probeIdle({
      raf: syncRaf(),
      sources: [
        source("canvas", () => ["canvas[pane.primary]: gen 7 unacked"]),
        source("platform", () => ["platform: 1 in-flight (gitStatus)"]),
      ],
      timeoutMs: 0,
    });
    const failure = (await promise.catch((error: unknown) => error)) as NotIdleError;
    expect(failure).toBeInstanceOf(NotIdleError);
    expect(failure.blockedBy).toEqual([
      "canvas[pane.primary]: gen 7 unacked",
      "platform: 1 in-flight (gitStatus)",
    ]);
    expect(failure.message).toContain("canvas[pane.primary]: gen 7 unacked");
    expect(failure.message).toContain("platform: 1 in-flight (gitStatus)");
  });

  test("a timeout landing on a momentarily quiet frame still names the last blocker", async () => {
    // Otherwise the report reads "not idle, blocked by nothing", which helps nobody.
    let calls = 0;
    const settlesTooLate = source("canvas", () =>
      calls === 0 ? ((calls += 1), ["canvas: fonts loading"]) : [],
    );
    let clock = 0;
    const promise = probeIdle({
      frames: 3,
      now: () => (clock += 5),
      raf: syncRaf(),
      sources: [settlesTooLate],
      timeoutMs: 6,
    });
    const failure = (await promise.catch((error: unknown) => error)) as NotIdleError;
    expect(failure.blockedBy).toEqual(["canvas: fonts loading"]);
  });

  test("a timeout with no blocker at all says so rather than inventing one", async () => {
    let clock = 0;
    const promise = probeIdle({
      frames: 99,
      now: () => (clock += 100),
      raf: syncRaf(),
      sources: [],
      timeoutMs: 1,
    });
    const failure = (await promise.catch((error: unknown) => error)) as NotIdleError;
    expect(failure.blockedBy).toEqual([]);
    expect(failure.message).toContain("consecutive quiet frames");
  });

  test("the default timeout and the real requestAnimationFrame drive the loop", async () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(10_000);
    // No `raf`, no `now`, no `timeoutMs`: the production path, against a quiet source.
    await probeIdle({ sources: [source("quiet", () => [])] });
  });
});

describe("defaultIdleSources", () => {
  test("names the seven subsystems and is quiet in a bare page", () => {
    expect(defaultIdleSources().map((s) => s.name)).toEqual([
      "render",
      "panels",
      "canvas",
      "platform",
      "overlay",
      "activity",
      // Tabulator owns frames nothing else was counting: a grid command resolves when the panel
      // Mounts, several frames before the table is drawn.
      "grid",
    ]);
    expect(idleBlockers()).toEqual([]);
  });

  test("a running activity blocks idle, and a finished one does not", () => {
    // An activity spans many PAL calls, so the `platform` source goes quiet in the gaps between
    // Them while the operation is plainly still running — which is exactly when a screenshot
    // Photographs a half-done install.
    resetActivities();
    const handle = beginActivity({ title: "Installing dependencies" });
    expect(idleBlockers()).toContain("activity: Installing dependencies — running");

    handle.done();
    expect(idleBlockers()).toEqual([]);
    resetActivities();
  });

  test("a renderer that never settles keeps the render source blocked", async () => {
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerRenderer("idle-test", (() => pending) as () => void);
    try {
      render();
      expect(idleBlockers()).toContain("render: 1 renderer(s) mid-paint");
      release();
      await pending;
      expect(idleBlockers()).toEqual([]);
    } finally {
      registerRenderer("idle-test", () => {});
    }
  });

  test("a panel with a frame queued blocks, and unbinding releases it", () => {
    const root = document.createElement("div");
    root.id = "right-panel";
    const scheduler = createPanelScheduler({ render: () => {}, root });
    scheduler.schedule();
    expect(idleBlockers()).toEqual(["panels: #right-panel has a frame queued"]);
    scheduler.unbind();
    expect(idleBlockers()).toEqual([]);
  });

  test("an unsettled platform call blocks, named by its method", async () => {
    let finish: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => {
      finish = resolve;
    });
    registerPlatform({ gitStatus: () => slow } as unknown as StudioPlatform);
    const { getPlatform } = await import("../src/platform");
    void (getPlatform() as unknown as { gitStatus: () => Promise<string> }).gitStatus();
    expect(idleBlockers()).toEqual(["platform: 1 in-flight (gitStatus)"]);
    finish("done");
    await slow;
    expect(idleBlockers()).toEqual([]);
  });
});
