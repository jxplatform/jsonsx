/// <reference lib="dom" />
/**
 * Idle.ts — "settled" is a predicate, and it can fail.
 *
 * One question — _has Studio finished reacting?_ — asked of the five subsystems that can still be
 * mid-flight, over two consecutive animation frames (spec studio.md §13.5, plan §13.4).
 *
 * **The rejection is the point.** The thing this replaces is 115 `wait: {ms}` steps totalling 73
 * seconds, and a sleep cannot fail: a subsystem that was slow that day got answered with `+500 ms`
 * and the wrong state was photographed, committed and accepted. {@link NotIdleError} carries a
 * `blockedBy` array naming every outstanding item — `["canvas[page-1]: gen 7 unacked", "platform: 1
 * in-flight (gitStatus)"]` — so the slow subsystem identifies itself.
 *
 * Nothing here polls a subsystem it does not own. Each source is a function the owning module
 * already had to write for its own reasons:
 *
 * 1. `store.rendersInFlight()` — renderers mid-paint.
 * 2. `panel-scheduler.pendingSchedulers()` — panels with a frame queued or a render withheld.
 * 3. `iframe-host.canvasIdleBlockers()` — per host: unacked generations and patches, plus the frame's
 *    own cross-realm report of fonts, running animations and pending image retries.
 * 4. `platform.platformInFlight()` — unsettled PAL calls, counted at the one seam every adapter and
 *    all thirty-odd `git*`/fs/fetch methods pass through.
 * 5. `layers.overlayIdleBlockers()` — overlays still in transition. Only the SETTLING window counts: a
 *    resting toast is not a blocker, which is what lets `toastsAreHeld()` hold one open for a
 *    capture without `probeIdle()` waiting forever alongside it (plan §13.7's named exception).
 *
 * The consumers are the `packages/studio:verify` skill, the screenshot runner and P4.2's Activity
 * tracker (this is a read-only projection of the same in-flight set that dock renders).
 */

import { rendersInFlight } from "../store";
import { pendingSchedulers } from "../panels/panel-scheduler";
import { canvasIdleBlockers } from "../canvas/iframe-host";
import { platformInFlight } from "../platform";
import { overlayIdleBlockers } from "../ui/layers";

/** One subsystem that can be outstanding, and its account of why. */
export interface IdleSource {
  /** Stable name — `render`, `panels`, `canvas`, `platform`, `overlay`. */
  readonly name: string;
  /** Empty when quiet; otherwise one human-readable line per outstanding item. */
  blockers: () => readonly string[];
}

/** Consecutive quiet animation frames required before Studio counts as settled. */
export const QUIET_FRAMES = 2;

/** How long {@link probeIdle} waits before rejecting with what is still outstanding. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

/** Thrown when Studio did not settle in time — `blockedBy` is the answer, not the message. */
export class NotIdleError extends Error {
  readonly blockedBy: readonly string[];

  constructor(blockedBy: readonly string[], timeoutMs: number) {
    super(
      blockedBy.length === 0
        ? `Studio did not report ${QUIET_FRAMES} consecutive quiet frames within ${timeoutMs}ms`
        : `Studio was not idle after ${timeoutMs}ms — blocked by ${blockedBy.join("; ")}`,
    );
    this.name = "NotIdleError";
    this.blockedBy = blockedBy;
  }
}

/**
 * The five live sources.
 *
 * Built per call rather than held in a module constant so a test can substitute one without
 * unpicking the others, and so a second window's hosts are never read through the first window's
 * closure.
 */
export function defaultIdleSources(): IdleSource[] {
  return [
    {
      blockers: () => {
        const count = rendersInFlight();
        return count > 0 ? [`render: ${count} renderer(s) mid-paint`] : [];
      },
      name: "render",
    },
    {
      blockers: () => pendingSchedulers().map((panel) => `panels: ${panel}`),
      name: "panels",
    },
    { blockers: canvasIdleBlockers, name: "canvas" },
    {
      blockers: () => {
        const calls = platformInFlight();
        if (calls.length === 0) {
          return [];
        }
        return [`platform: ${calls.length} in-flight (${[...new Set(calls)].join(", ")})`];
      },
      name: "platform",
    },
    { blockers: overlayIdleBlockers, name: "overlay" },
  ];
}

/** Everything outstanding right now, across every source. Empty means this instant is quiet. */
export function idleBlockers(sources: readonly IdleSource[] = defaultIdleSources()): string[] {
  const blockers: string[] = [];
  for (const source of sources) {
    blockers.push(...source.blockers());
  }
  return blockers;
}

export interface IdleOptions {
  timeoutMs?: number;
  /** Consecutive quiet frames required. Defaults to {@link QUIET_FRAMES}. */
  frames?: number;
  /** Substitute the quiescence sources — what a test states, and what a second window would pass. */
  sources?: readonly IdleSource[];
  /** Frame scheduler, injectable so the loop is testable without a real compositor. */
  raf?: (callback: () => void) => void;
  /** Clock, injectable for the same reason. */
  now?: () => number;
}

/**
 * Resolve once every source has been quiet for `frames` consecutive animation frames.
 *
 * Rejects with {@link NotIdleError} on timeout. A single quiet frame is not enough: a render commits
 * its DOM in one frame and its layout/animation consequences in the next, which is exactly the
 * window a one-frame check photographs.
 */
export function probeIdle(options: IdleOptions = {}): Promise<void> {
  const {
    frames = QUIET_FRAMES,
    now = () => Date.now(),
    raf = (callback: () => void) => {
      requestAnimationFrame(() => callback());
    },
    sources = defaultIdleSources(),
    timeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  } = options;

  return new Promise<void>((resolve, reject) => {
    const deadline = now() + timeoutMs;
    let quiet = 0;
    let settled = false;
    // The last non-empty account, so a timeout that lands on a momentarily-quiet frame still names
    // What kept it from reaching `frames` — "not idle, blocked by nothing" helps nobody.
    let lastBlockers: readonly string[] = [];

    const tick = () => {
      if (settled) {
        return;
      }
      const blockers = idleBlockers(sources);
      if (blockers.length > 0) {
        lastBlockers = blockers;
        quiet = 0;
      } else {
        quiet += 1;
        if (quiet >= frames) {
          settled = true;
          resolve();
          return;
        }
      }
      if (now() >= deadline) {
        settled = true;
        reject(new NotIdleError(blockers.length > 0 ? blockers : lastBlockers, timeoutMs));
        return;
      }
      raf(tick);
    };
    raf(tick);
  });
}
