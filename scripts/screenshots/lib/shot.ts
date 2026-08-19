/**
 * One shot, executed against the contract (UX-REDESIGN-PLAN §13.2–§13.4).
 *
 * Boot the app into a stated world, drive it through named capabilities, assert, photograph region
 * ids. Nothing in this file names a CSS selector, and nothing in it sleeps.
 *
 * **Two nets, and they are not redundant.** `probe.idle()` is the APP's own account of whether it
 * has finished reacting — renders, panel schedulers, canvas generations, in-flight PAL calls — and
 * it rejects with `blockedBy`, which the runner prints as the shot's failure. Around it sits the
 * runner's own quiescence: outstanding network requests per frame, running Web Animations, fonts,
 * and a focus ring that has stopped moving. The app cannot see the network the canvas iframe is
 * doing (that is what made `hero` drift 15%) and the runner cannot see a queued lit render, so both
 * exist and both are cheap.
 *
 * **What was deleted here, and why it is not coming back.** `waitForCanvasReady`, `runWait`,
 * `hook(page, "setX")`, `canvasFrame()`'s "Studio's only child frame" (a coin flip the moment P8
 * adds a second host) and the `Math.abs(scale - 1) < 0.001` branch that guessed whether a fit
 * transform was in play. `probe.pointAt()` answers in TOP-DOCUMENT coordinates, per host, because
 * the app composes its own transforms and the runner never should have been re-deriving them.
 */

import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { Frame, Page } from "puppeteer-core";
import {
  isCommandStep,
  isInputStep,
  isRegionExpectation,
  isSeedStep,
  VIEWPORT_TARGET,
} from "./types";
import type {
  Capture,
  Expectation,
  InputStep,
  ResolvedOpen,
  ResolvedShot,
  ShotStep,
  ThenSegment,
} from "./types";

/**
 * A re-render that's visually indistinguishable from the committed PNG keeps the old bytes, so the
 * checked-in screenshots don't churn in git on every run. Per §13.4 this is for REVIEW PRESENTATION
 * and is no longer load-bearing for identity — the capture lock's `sha256` is.
 */
const DIFF_THRESHOLD = 0.0001;

/**
 * How far one channel may move before a pixel counts as different.
 *
 * The predecessor compared 32x32 THUMBNAILS of both images and averaged the absolute channel
 * difference. At that size a 3840x2400 capture's entire status bar is a fraction of one pixel row,
 * so the metric could not see text at all: the rail losing two buttons and the status bar being
 * rewritten together scored 0.07 %, the stale bytes were kept, and the lock then certified a
 * picture of an app that no longer existed as current. A screenshot pipeline that reports
 * "unchanged" for a changed app is worse than no pipeline, because it converts a stale picture into
 * an attested one.
 *
 * The metric is now a COUNT of pixels that moved more than this tolerance, at native resolution.
 * Anti-aliasing and font-hinting jitter move edge pixels a little and few of them; a control that
 * appeared, moved or changed its words moves many pixels a lot. `DIFF_THRESHOLD` is the fraction of
 * the frame that may do so and still count as noise.
 *
 * That fraction is deliberately TINY — 0.0001 is ~920 px of a 3840x2400 frame. The surfaces this
 * pipeline exists to keep honest are thin: the whole 24px status bar is 2 % of the frame and its
 * glyphs cover a tenth of that, so a bar that went from empty to three fields scores about 0.1 %. A
 * threshold generous enough to absorb "noise" at that scale is generous enough to absorb the status
 * bar, which is how a stale picture got attested twice. Churn is the cheaper failure: a re-captured
 * image that did not need re-capturing costs a diff, and a kept image that did costs a
 * documentation page that lies.
 */
const CHANNEL_TOLERANCE = 16;

/** A measured box in top-document CSS pixels. */
interface Rect {
  height: number;
  width: number;
  x: number;
  y: number;
}

/** The point `probe.pointAt` answers with — a node's on-screen box, transforms already composed. */
interface CanvasPoint extends Rect {
  left: number;
  top: number;
}

/**
 * `window.__jxAutomation`, as `services/automation.ts` declares it.
 *
 * Three members. There is no fourth, and every method the old surface carried — `setStatus`,
 * `setActivity`, `select`, `waitForCanvasReady`, sixteen `press` shims holding XPath — is gone from
 * both sides at once.
 */
interface AutomationHook {
  run: (id: string, args?: Record<string, unknown>) => Promise<void>;
  seed: (id: string, args?: Record<string, unknown>) => Promise<void>;
  probe: {
    idle: (options?: { frames?: number; timeoutMs?: number }) => Promise<void>;
    state: () => unknown;
    commands: () => { id: string; title: string; enabled: boolean }[];
    seeds: () => { id: string; boundary: string }[];
    pointAt: (target: { path: (string | number)[] }) => Promise<CanvasPoint | null>;
    revealPath: (path: (string | number)[]) => Promise<CanvasPoint | null>;
  };
}

declare global {
  interface Window {
    __jxAutomation: AutomationHook;
  }
}

// ─── The open→command mapping ─────────────────────────────────────────────────

/**
 * The three `open` fields the app owns as state rather than as a URL parameter.
 *
 * `project`, `file`, `profile` and `clock` are read at boot from the query string (`page-params`,
 * `services/profile.ts`), so they are genuinely part of the world the app wakes up in. `view`,
 * `fit` and `theme` are per-tab state a user changes, so they are COMMANDS — which means a shot
 * that states one and finds no such command fails loudly, naming the id. That is the intended
 * outcome: §13.4's rule is reject, never clamp.
 *
 * One table, so when a command id lands or moves there is exactly one line to change.
 */
export const OPEN_COMMANDS = {
  fit: { arg: "fit", id: "canvas.setFit" },
  theme: { arg: "color", id: "view.setTheme" },
  view: { arg: "mode", id: "canvas.setMode" },
} as const satisfies Record<string, { arg: string; id: string }>;

/** Dock state is stated, never toggled: one idempotent command per declared dock. */
export const DOCK_COMMAND = "view.setDock";

// ─── The freeze ───────────────────────────────────────────────────────────────

/** Kill animations/transitions/carets in a frame so captures don't race motion. */
const FREEZE_CSS =
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

/**
 * Install the freeze into the document that is about to be parsed.
 *
 * Frozen-ness has to be a property of the document, not of a moment in the runner: the freeze used
 * to be injected into every live frame at one instant, after which a canvas-mode change rebuilt the
 * iframe DOM — so 58 of 61 shots photographed a frame created AFTER the freeze. This runs as an
 * on-new-document script (which Chromium applies to the page and to every frame it later creates)
 * and is re-applied to any frame that attaches with a document already in flight.
 *
 * The style is appended to `documentElement`, not `head`: this executes before the parser has built
 * a `<head>`, and a `<style>` applies wherever it sits in the tree.
 */
function installFreeze(css: string): void {
  const add = () => {
    if (document.querySelector("style[data-jx-screenshot-freeze]")) {
      return;
    }
    const style = document.createElement("style");
    style.dataset.jxScreenshotFreeze = "1";
    style.textContent = css;
    (document.head ?? document.documentElement).append(style);
  };
  add();
  document.addEventListener("DOMContentLoaded", add, { once: true });
}

/**
 * Arm the freeze for `page` and every frame it will ever create, plus any frame that attaches with
 * its document already under way. Must be called BEFORE the first navigation.
 */
async function armFreeze(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(installFreeze, FREEZE_CSS);
  page.on("frameattached", (frame: Frame) => {
    void frame.evaluate(installFreeze, FREEZE_CSS).catch(() => {
      // Detached / about:blank / cross-origin-without-a-document — the on-new-document script
      // Covers the frame's real document either way.
    });
  });
}

// ─── Quiescence: the outer net ────────────────────────────────────────────────

/**
 * Connections that are open BY DESIGN and never complete: the dev server's live-reload EventSource
 * and the collab WebSocket. Counting them as in-flight would mean the page is never quiet, which is
 * how a real predicate turns back into a sleep.
 */
const LONG_LIVED_PATHS = ["/__reload", "/__studio/collab"];
const LONG_LIVED_TYPES = new Set(["eventsource", "websocket"]);

/** How long a single request may stay in flight before the tracker stops counting it. */
const REQUEST_STALL_MS = 20_000;

export interface RequestTracker {
  pending: () => string[];
}

/**
 * Counts the page's outstanding network requests, across every frame.
 *
 * This exists because of a measured failure: the `hero` shot captured first in a process and
 * captured tenth produced two different pictures at RMSE 0.150, and the difference was that the
 * starter site's webfonts (fetched from a remote host inside the canvas iframe) had not swapped in
 * yet on the cold one. `document.fonts.ready` in the canvas frame resolves "loaded" against an
 * EMPTY font set while the frame is still blank, so the honest predicate is "the page has stopped
 * fetching" — and it names what it was still fetching when it times out.
 */
export function trackRequests(page: Page): RequestTracker {
  const inFlight = new Map<string, number>();
  const ignorable = (url: string, type: string) =>
    LONG_LIVED_TYPES.has(type) || LONG_LIVED_PATHS.some((p) => url.includes(p));
  page.on("request", (req) => {
    if (!ignorable(req.url(), req.resourceType())) {
      inFlight.set(req.url(), Date.now());
    }
  });
  const done = (req: { url: () => string }) => inFlight.delete(req.url());
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return {
    pending: () => {
      const now = Date.now();
      for (const [url, started] of inFlight) {
        if (now - started > REQUEST_STALL_MS) {
          inFlight.delete(url);
        }
      }
      return [...inFlight.keys()];
    },
  };
}

/**
 * Per-frame render readiness: no font load in flight, no running Web Animation, and a focus ring
 * that has stopped moving. Returns the reasons it is NOT ready.
 *
 * Focus is a condition here, not something the runner simply sets, because a dialog's own focus
 * management is asynchronous and will happily overwrite a blur that ran a frame too early.
 * Measured: two modal shots grew and lost a blue `:focus-visible` ring between two runs of the same
 * tree, purely on whether the runner's blur landed before or after the overlay's autofocus. Waiting
 * for focus to be STABLE is correct in both worlds — where nothing claims focus the blur stands and
 * no ring is photographed, and where a focus trap claims it the ring is photographed every time.
 */
function frameBlockers(): string[] {
  const blocked: string[] = [];
  const loading = [...document.fonts].filter((f) => f.status === "loading").length;
  if (loading > 0 || document.fonts.status === "loading") {
    blocked.push(`${loading || 1} font face(s) loading`);
  }
  const running = document.getAnimations().filter((a) => a.playState === "running").length;
  if (running > 0) {
    blocked.push(`${running} animation(s) running`);
  }
  /* Images are covered by the network condition and by the canvas's own `idle` report, and
     deliberately NOT by an `img.complete` sweep. Measured, both naive predicates are wrong: "no
     broken image" never clears (the design canvas renders unresolved bindings as literal srcs like
     `{$map/item/image}`, and several starters ship a 404 favicon), and "no incomplete image" never
     clears either (`loading="lazy"` images below the fold stay incomplete forever). Both blocked 8
     of 61 shots for the full timeout. The retry ladder only the app can see is inside
     `probe.idle()`, which is the other half of this predicate. */
  const w = window as unknown as { __jxShotFocus?: Element | null };
  const active = document.activeElement;
  if (!("__jxShotFocus" in w) || w.__jxShotFocus !== active) {
    w.__jxShotFocus = active;
    blocked.push(`focus moved to <${active?.tagName.toLowerCase() ?? "none"}>`);
  }
  return blocked;
}

/** Everything blocking a truthful capture right now, named. Empty means "photograph it". */
async function quiescenceBlockers(page: Page, net: RequestTracker): Promise<string[]> {
  const blocked = net.pending().map((url) => `network: ${url}`);
  for (const frame of page.frames()) {
    try {
      const reasons = await frame.evaluate(frameBlockers);
      const label = frame === page.mainFrame() ? "shell" : "canvas";
      blocked.push(...reasons.map((r) => `${label}: ${r}`));
    } catch {
      // Detached mid-poll — it cannot be blocking a capture it is not in.
    }
  }
  return blocked;
}

/** One animation frame in the top document — the runner's only unit of waiting. */
async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => done());
      }),
  );
}

/**
 * Block until the page is quiet for two consecutive animation frames, or REJECT naming what is
 * still outstanding. Rejecting is the whole point: a sleep cannot fail, so a slow subsystem gets
 * answered with a bigger number and the wrong capture is accepted.
 */
async function waitForQuiescence(
  page: Page,
  net: RequestTracker,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let clean = 0;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = await quiescenceBlockers(page, net);
    if (last.length === 0) {
      clean += 1;
      if (clean >= 2) {
        return;
      }
    } else {
      clean = 0;
    }
    await nextFrame(page);
  }
  throw new Error(`page never went quiet (${timeoutMs}ms). Blocked by:\n  ${last.join("\n  ")}`);
}

/**
 * The app's own account of whether it has settled.
 *
 * `probe.idle()` rejects with `NotIdleError.blockedBy` — `["canvas[pane.primary]: gen 7 unacked",
 * "platform: 1 in-flight (gitStatus)"]`. Those strings ARE the failure report, so they are read off
 * the rejection rather than flattened into a message: 115 sleeps were 115 places that could not
 * fail, and the point of replacing them is that a slow subsystem now identifies itself.
 */
async function probeIdle(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__jxAutomation.probe.idle().then(
      () => [] as string[],
      (error: unknown) => {
        const blocked = (error as { blockedBy?: string[] } | null)?.blockedBy;
        return blocked && blocked.length > 0
          ? blocked
          : [String((error as Error | null)?.message ?? error)];
      },
    ),
  );
}

/** Both nets, in order: the app's account first, then the page's. `at` names the failing step. */
async function settle(page: Page, net: RequestTracker, at: string): Promise<void> {
  const blocked = await probeIdle(page);
  if (blocked.length > 0) {
    throw new Error(`${at}: Studio never went idle. Blocked by:\n  ${blocked.join("\n  ")}`);
  }
  await waitForQuiescence(page, net);
}

/**
 * Put the pointer and the keyboard focus somewhere the shot did not photograph by accident.
 *
 * `:hover` and `:focus-visible` visibly change dense panels, and neither was controlled: the
 * pointer stayed wherever the last gesture left it and focus stayed in whatever last claimed it, so
 * a panel re-rendering under a stationary cursor picked up a hover ring the shot never asked for.
 */
async function resetPointerAndFocus(page: Page): Promise<void> {
  /*
   * The bottom-right corner, not `(-1, -1)`.
   *
   * Off-canvas coordinates were the obvious way to have nothing under the cursor, and CDP accepted
   * them. **WebDriver BiDi does not**: `input.performActions` refuses a move beyond the viewport,
   * with "move target out of bounds", so every shot failed the moment the pipeline spoke the
   * standard's protocol instead of Chrome's. The corner is inside the viewport and reachable, and
   * it is the one pixel of a full-window screenshot that no panel's interactive content occupies —
   * the same property `(-1, -1)` was chosen for, expressed in coordinates the standard allows.
   */
  const viewport = page.viewport();
  await page.mouse.move(
    viewport ? Math.max(0, viewport.width - 1) : 0,
    viewport ? Math.max(0, viewport.height - 1) : 0,
  );
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      active.blur();
    }
  });
}

// ─── Regions, in the page ─────────────────────────────────────────────────────

/**
 * Resolve a region id and measure it, in one in-page pass.
 *
 * This mirrors `packages/studio/src/ui/regions.ts` — the `data-jx-region` attribute, the `pane →
 * pane.primary` alias, last-match-wins for stacked overlays, and the one derived resolver
 * (`inspector/field:*` reads the `data-prop` that `ui/field-row.ts` has always emitted). It is
 * written out rather than imported because `page.evaluate` ships a function's own source into the
 * browser and cannot carry its imports; the app remains the authority, and an id that only this
 * copy would resolve is a bug in this copy.
 *
 * `scroll` is off for assertions and on for captures: measuring a region must not move the page a
 * later region will be measured against.
 */
function measureRegionInPage(
  id: string,
  padding: number,
  viewportWidth: number,
  viewportHeight: number,
  scroll: boolean,
): { found: boolean; rect: Rect | null } {
  const ATTR = "data-jx-region";
  const canonical =
    id === "pane" ? "pane.primary" : id.startsWith("pane/") ? `pane.primary/${id.slice(5)}` : id;
  let matches = [...document.querySelectorAll<HTMLElement>(`[${ATTR}="${CSS.escape(canonical)}"]`)];
  if (matches.length === 0) {
    const inspector = document.querySelector(`[${ATTR}="inspector"]`);
    // `/browse` FIRST. `(.+)` is greedy, so the bare-field rule below would otherwise claim
    // `image/browse` as a prop of that name and answer nothing — which is exactly what it did.
    const browse = /^inspector\/field:(.+)\/browse$/.exec(canonical);
    const field = browse ? null : /^inspector\/field:(.+)$/.exec(canonical);
    if (inspector && browse) {
      const row = inspector.querySelector<HTMLElement>(`[data-prop="${CSS.escape(browse[1]!)}"]`);
      const button = row?.querySelector<HTMLElement>(".media-picker-browse");
      matches = button ? [button] : [];
    } else if (inspector && field) {
      matches = [
        ...inspector.querySelectorAll<HTMLElement>(`[data-prop="${CSS.escape(field[1]!)}"]`),
      ];
    }
  }
  // Last match wins: the only ids that repeat are overlay slots, and the last one appended is on top.
  const el = matches.at(-1);
  if (!el) {
    return { found: false, rect: null };
  }
  if (scroll) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) {
    return { found: true, rect: null };
  }
  const x = Math.max(0, r.x - padding);
  const y = Math.max(0, r.y - padding);
  return {
    found: true,
    rect: {
      height: Math.min(viewportHeight - y, r.height + padding + (r.y - y)),
      width: Math.min(viewportWidth - x, r.width + padding + (r.x - x)),
      x,
      y,
    },
  };
}

async function measureRegion(
  page: Page,
  id: string,
  padding: number,
  scroll: boolean,
): Promise<{ found: boolean; rect: Rect | null }> {
  const viewport = page.viewport() ?? { height: 0, width: 0 };
  return page.evaluate(measureRegionInPage, id, padding, viewport.width, viewport.height, scroll);
}

/**
 * Record every scroll offset in the page so a region measurement can be undone.
 *
 * A capture scrolls its region into view, which leaves the page somewhere the NEXT region did not
 * ask for — and sixteen shots capture two or more regions, so region #2 was being measured against
 * region #1's scroll position. The refs live on `window` rather than in a data attribute because an
 * attribute would be in the photograph.
 */
async function saveScrollState(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __jxShotScroll?: [Element, number, number][] };
    w.__jxShotScroll = [...document.querySelectorAll("*")].map(
      (el) => [el, el.scrollTop, el.scrollLeft] as [Element, number, number],
    );
  });
}

/** Put every scroll offset back where {@link saveScrollState} found it. */
async function restoreScrollState(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __jxShotScroll?: [Element, number, number][] | undefined;
    };
    for (const [el, top, left] of w.__jxShotScroll ?? []) {
      if (el.scrollTop !== top) {
        el.scrollTop = top;
      }
      if (el.scrollLeft !== left) {
        el.scrollLeft = left;
      }
    }
    w.__jxShotScroll = undefined;
  });
}

// ─── Driving ──────────────────────────────────────────────────────────────────

/**
 * Run one registry command in the page.
 *
 * `run()` throws on an unknown id, on a `toggle*` id and when the command's own `enablement`
 * refuses — and every one of those failures becomes the shot's failure. §13.4: a step that asks for
 * a state the app refuses should fail, because that step is lying.
 */
async function runCommand(page: Page, id: string, args: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    (commandId, commandArgs) => window.__jxAutomation.run(commandId, commandArgs),
    id,
    args,
  );
}

async function runSeed(page: Page, id: string, args: Record<string, unknown>): Promise<void> {
  await page.evaluate((seedId, seedArgs) => window.__jxAutomation.seed(seedId, seedArgs), id, args);
}

/** The centre of a region's box, for a gesture that needs a real pointer. */
async function regionPoint(page: Page, id: string, at: string): Promise<{ x: number; y: number }> {
  const { found, rect } = await measureRegion(page, id, 0, true);
  if (!found) {
    throw new Error(`${at}: region "${id}" resolves to nothing`);
  }
  if (!rect) {
    throw new Error(`${at}: region "${id}" has an empty box`);
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * The budgeted hatch. Four gestures, each addressed by a region id or a `JxPath`.
 *
 * `caret` is the one that used to be a coordinate: the manifest named a screen point, so the runner
 * grew a `Math.abs(scale - 1) < 0.001` branch guessing whether a fit transform was in play.
 * `probe.pointAt` answers in top-document coordinates with the app's own transforms already
 * composed, per host, so there is nothing left to guess and nothing that P8's second canvas
 * breaks.
 */
async function runInput(page: Page, step: InputStep, at: string): Promise<void> {
  if (step.input === "caret") {
    // REVEAL, then measure. `pointAt` answers where the node is right now, which is off-screen for
    // Anything below the fold — and a click at an off-viewport point silently selects nothing, so
    // The shot fails later and somewhere else. `revealPath` scrolls/pans the node into view and
    // Returns the settled point, which is what makes a caret step survive a layout change: the
    // Document Header card landing in-column moved this very node 203px down the page.
    const point = await page.evaluate(
      (path) => window.__jxAutomation.probe.revealPath(path),
      step.path,
    );
    if (!point) {
      throw new Error(`${at}: no node at path ${JSON.stringify(step.path)}`);
    }
    await page.mouse.click(point.x, point.y, { count: step.clickCount ?? 1 });
  } else if (step.input === "dragOver") {
    const { found } = await measureRegion(page, step.region, 0, true);
    if (!found) {
      throw new Error(`${at}: region "${step.region}" resolves to nothing`);
    }
    const dispatched = await page.evaluate((id: string) => {
      const el = document.querySelector(`[data-jx-region="${CSS.escape(id)}"]`);
      if (!el) {
        return false;
      }
      el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true }));
      return true;
    }, step.region);
    if (!dispatched) {
      throw new Error(`${at}: region "${step.region}" is not a stamped element`);
    }
  } else if (step.input === "hover") {
    const point = await regionPoint(page, step.region, at);
    await page.mouse.move(point.x, point.y);
  } else {
    if (step.region !== undefined) {
      const point = await regionPoint(page, step.region, at);
      await page.mouse.click(point.x, point.y);
    }
    await page.keyboard.type(step.text, { delay: 10 });
  }
}

async function runStep(page: Page, step: ShotStep, at: string): Promise<void> {
  if (isCommandStep(step)) {
    await runCommand(page, step.cmd, step.args ?? {});
    return;
  }
  if (isSeedStep(step)) {
    await runSeed(page, step.seed, step.args ?? {});
    return;
  }
  if (isInputStep(step)) {
    await runInput(page, step, at);
    return;
  }
  throw new Error(`${at}: a step carries exactly one of cmd | seed | input`);
}

// ─── Asserting ────────────────────────────────────────────────────────────────

/**
 * Partial deep match of `expected` against a `probe.state()` snapshot.
 *
 * Pure, and in Node rather than in the page, because `CommandContext` is a flat record of plain
 * values (`commands/context.ts` says so in its first paragraph and its shape holds it to it) — so
 * one JSON round trip buys a matcher that is unit-testable without a browser. The answer is a list
 * of mismatches, phrased as the assertion a reader wrote: `document.dirty is false, expected
 * true`.
 */
export function matchState(expected: Record<string, unknown>, actual: unknown): string[] {
  const mismatches: string[] = [];
  const walk = (want: unknown, got: unknown, path: string): void => {
    if (want !== null && typeof want === "object" && !Array.isArray(want)) {
      if (got === null || typeof got !== "object") {
        mismatches.push(`${path || "state"} is ${JSON.stringify(got)}, expected an object`);
        return;
      }
      for (const [key, value] of Object.entries(want as Record<string, unknown>)) {
        walk(value, (got as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      mismatches.push(`${path} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
  };
  walk(expected, actual, "");
  return mismatches;
}

/**
 * The context every `when` predicate reads, as plain JSON.
 *
 * A JSON round trip rather than `structuredClone`: the record is a reactive proxy whose accessors
 * `structuredClone` refuses, and what is wanted here is a SERIALISATION across the CDP wire, not a
 * deep copy inside the page.
 */
async function probeState(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const state = window.__jxAutomation.probe.state();
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    return JSON.parse(JSON.stringify(state)) as unknown;
  });
}

/**
 * Every `expect` entry, or throw naming all of them at once.
 *
 * All of them, not the first: a shot that boots into the wrong state usually fails several
 * assertions, and reporting one per run turns one broken shot into four round trips.
 */
async function assertExpectations(
  page: Page,
  expectations: Expectation[],
  at: string,
): Promise<void> {
  const failures: string[] = [];
  for (const expectation of expectations) {
    if (isRegionExpectation(expectation)) {
      const { found, rect } = await measureRegion(page, expectation.region, 0, false);
      if (!found) {
        failures.push(`region "${expectation.region}" resolves to nothing`);
      } else if (!rect) {
        failures.push(`region "${expectation.region}" has an empty box`);
      }
      continue;
    }
    failures.push(...matchState(expectation.state, await probeState(page)));
  }
  if (failures.length > 0) {
    throw new Error(`${at}: expectation failed —\n  ${failures.join("\n  ")}`);
  }
}

// ─── Capturing ────────────────────────────────────────────────────────────────

export interface ShotContext {
  log: (line: string) => void;
  outDir: string;
  repoRoot: string;
  serverUrl: string;
  studioPath: string;
  /** Overwrite every image regardless of the visual-diff check (for a wholesale re-baseline). */
  force: boolean;
  /**
   * The absolute project root the shot actually opens.
   *
   * Never the repo-relative path the manifest wrote: `lib/server.ts` materialises a copy-on-write
   * overlay, so a shot that types into a starter page cannot reach the committed file. Absent for a
   * shot that opens no project.
   */
  projectRoot?: string;
}

/**
 * Normalized visual difference in [0,1] between two PNG buffers. Both are decoded and downscaled to
 * a 32×32 thumbnail in the (already-running) browser — no native image deps, since Sharp is
 * unavailable on some hosts — and compared as mean per-channel absolute difference.
 */
async function visualDiff(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async (aB64, bB64, tolerance) => {
      const pixels = async (b64: string) => {
        const img = new Image();
        await new Promise<void>((res, rej) => {
          img.addEventListener("load", () => res());
          img.addEventListener("error", () => rej(new Error("decode failed")));
          img.src = `data:image/png;base64,${b64}`;
        });
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const c2d = canvas.getContext("2d", { willReadFrequently: true });
        if (!c2d) {
          throw new Error("no 2d context");
        }
        c2d.drawImage(img, 0, 0);
        return {
          data: c2d.getImageData(0, 0, canvas.width, canvas.height).data,
          height: canvas.height,
          width: canvas.width,
        };
      };
      const [pa, pb] = await Promise.all([pixels(aB64), pixels(bB64)]);
      // A resize is a change, full stop — and comparing two different geometries pixel-by-pixel
      // Would answer nonsense.
      if (pa.width !== pb.width || pa.height !== pb.height) {
        return 1;
      }
      let differing = 0;
      for (let i = 0; i < pa.data.length; i += 4) {
        const dr = Math.abs((pa.data[i] ?? 0) - (pb.data[i] ?? 0));
        const dg = Math.abs((pa.data[i + 1] ?? 0) - (pb.data[i + 1] ?? 0));
        const db = Math.abs((pa.data[i + 2] ?? 0) - (pb.data[i + 2] ?? 0));
        if (Math.max(dr, dg, db) > tolerance) {
          differing += 1;
        }
      }
      return differing / (pa.width * pa.height);
    },
    a.toString("base64"),
    b.toString("base64"),
    CHANNEL_TOLERANCE,
  );
}

/**
 * Write `buffer` to `outPath`, but skip the write when it's visually indistinguishable from the
 * existing PNG (unless `ctx.force`), so committed screenshots don't churn. Logs the outcome.
 */
async function writeIfChanged(
  page: Page,
  outPath: string,
  buffer: Buffer,
  ctx: ShotContext,
  shotName: string,
): Promise<void> {
  const name = basename(outPath);
  if (!ctx.force && existsSync(outPath)) {
    try {
      const diff = await visualDiff(page, buffer, await readFile(outPath));
      const pct = `Δ${(diff * 100).toFixed(2)}%`;
      if (diff <= DIFF_THRESHOLD) {
        ctx.log(`[shot:${shotName}] ${name} unchanged (${pct}) — kept`);
        return;
      }
      await writeFile(outPath, buffer);
      ctx.log(`[shot:${shotName}] ${name} updated (${pct})`);
      return;
    } catch {
      // Any decode/read failure → fall through to an unconditional write.
    }
  }
  await writeFile(outPath, buffer);
  ctx.log(`[shot:${shotName}] ${name} written (${ctx.force ? "forced" : "new"})`);
}

/**
 * One capture: settle, measure, photograph, put the page back.
 *
 * Every capture measures from the SAME page state — save the scroll offsets, scroll to measure,
 * shoot, restore. Otherwise capture N's `scrollIntoView` is capture N+1's starting position.
 */
async function captureImage(
  page: Page,
  capture: Capture,
  shot: ResolvedShot,
  ctx: ShotContext,
  net: RequestTracker,
  at: string,
): Promise<string> {
  const target = capture.of ?? VIEWPORT_TARGET;
  await saveScrollState(page);
  try {
    let clip: Rect | undefined;
    if (target !== VIEWPORT_TARGET) {
      const { found, rect } = await measureRegion(page, target, capture.padding ?? 0, true);
      if (!found) {
        throw new Error(
          `${at}: capture "${capture.image}" names region "${target}", which resolves to nothing`,
        );
      }
      if (!rect) {
        throw new Error(
          `${at}: capture "${capture.image}" names region "${target}", whose box is empty`,
        );
      }
      clip = rect;
    }
    await resetPointerAndFocus(page);
    await settle(page, net, `${at} capture "${capture.image}"`);
    // With a clip puppeteer defaults captureBeyondViewport to TRUE, which resizes the render
    // Surface to the full page — a relayout that natively resets the canvas scroller to 0
    // Mid-capture. Clips here are clamped to the viewport, so capture strictly within it.
    const buffer = Buffer.from(
      await page.screenshot(clip ? { captureBeyondViewport: false, clip } : {}),
    );
    const outPath = join(ctx.outDir, `${capture.image}.png`);
    await writeIfChanged(page, outPath, buffer, ctx, shot.name);
    return outPath;
  } finally {
    await restoreScrollState(page);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

/**
 * The query string the shot boots with.
 *
 * Four fields, and each is genuinely a property of the world the app wakes up in rather than
 * something a user does: which project, which file, which startup profile, and what time it is.
 * `?profile=` replaces the runner's old `evaluateOnNewDocument(localStorage.clear())`, which
 * reached around the app to clear an entire ORIGIN — including keys Studio does not own.
 */
export function bootUrl(ctx: ShotContext, open: ResolvedOpen): string {
  const params = new URLSearchParams({ automation: "1", profile: open.profile });
  if (ctx.projectRoot) {
    params.set("project", ctx.projectRoot);
  }
  if (open.file) {
    params.set("file", open.file);
  }
  if (open.clock) {
    params.set("clock", open.clock);
  }
  return `${ctx.serverUrl}${ctx.studioPath}?${params}`;
}

/**
 * Apply the `open` fields the app owns as state, each through its own idempotent command.
 *
 * Order is declared, not incidental: the view decides which canvas exists, so the fit that canvas
 * should hold is applied after it. Docks last, because a dock change relayouts the pane the fit was
 * computed against.
 */
/**
 * Refuse to photograph a Studio that booted with a dialog already up.
 *
 * `showConfirmDialog` and friends render an `<sp-dialog-wrapper open underlay>`, and an underlay
 * swallows every pointer event across the viewport. So a dialog raised during boot does not just
 * sit in the corner of the frame — it silently redirects every click, caret and hover the shot goes
 * on to dispatch into a scrim, and the shot either fails somewhere far from the cause or, worse,
 * succeeds and photographs a 50%-black canvas.
 *
 * That is not a hypothetical. Studio's "Update @jxsuite packages?" prompt fired on the `?project=`
 * boot path for every starter, and 33 committed images were captured through it — among them
 * `docs/images/hero.png`, which is the jxsuite.com marketing hero. Four shots failed and were
 * chased as shot-authoring bugs; the other 33 shipped, because a scrim is not something an `expect`
 * on a region can notice.
 *
 * No shot legitimately boots with a modal: every dialog shot in the manifest — `new-project`,
 * `seo-modal`, `publish-panel`, `repeat-dialog`, `convert-to-component` — raises its own from a
 * STEP. So this needs no opt-out, and `modal.open` is an existing §13.4 context key rather than
 * anything added for the pipeline.
 */
async function assertNoUninvitedModal(page: Page, shotName: string): Promise<void> {
  const uninvited = await page.evaluate(() => {
    if (!window.__jxAutomation?.probe.state().modal.open) {
      return null;
    }
    return [...document.querySelectorAll("#layer-dialog [open], #layer-modal [open]")].map(
      (el) => el.getAttribute("headline") ?? el.tagName.toLowerCase(),
    );
  });
  if (uninvited) {
    throw new Error(
      `shot "${shotName}": Studio booted with a modal already open — ` +
        `${uninvited.length > 0 ? uninvited.join(", ") : "unnamed dialog"}. Its underlay blocks ` +
        `the whole viewport, so every step below would be dispatched into a scrim and the capture ` +
        `would show one. Nothing in the manifest raised it; something in the app did.`,
    );
  }
}

async function applyOpenState(page: Page, open: ResolvedOpen, net: RequestTracker): Promise<void> {
  for (const key of ["theme", "view", "fit"] as const) {
    const value = open[key];
    if (value === null) {
      continue;
    }
    const command = OPEN_COMMANDS[key];
    await runCommand(page, command.id, { [command.arg]: value });
    await settle(page, net, `open.${key}`);
  }
  for (const [dock, state] of Object.entries(open.docks)) {
    await runCommand(page, DOCK_COMMAND, { dock, ...state });
    await settle(page, net, `open.docks.${dock}`);
  }
}

/** One `then` segment, or the shot's own body — they are the same three phases. */
async function runSegment(
  page: Page,
  segment: ThenSegment,
  shot: ResolvedShot,
  ctx: ShotContext,
  net: RequestTracker,
  label: string,
): Promise<string[]> {
  for (const [index, step] of (segment.steps ?? []).entries()) {
    const at = `${label} step ${index + 1}`;
    await runStep(page, step, at);
    await settle(page, net, at);
  }
  await assertExpectations(page, segment.expect ?? [], label);
  const written: string[] = [];
  for (const capture of segment.capture ?? []) {
    written.push(await captureImage(page, capture, shot, ctx, net, label));
  }
  return written;
}

export async function executeShot(
  page: Page,
  shot: ResolvedShot,
  ctx: ShotContext,
): Promise<string[]> {
  const { open } = shot;
  const net = trackRequests(page);
  await page.setViewport({
    deviceScaleFactor: open.deviceScaleFactor,
    height: open.viewport.height,
    width: open.viewport.width,
  });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

  const url = bootUrl(ctx, open);
  ctx.log(`[shot:${shot.name}] ${url}`);

  // Frozen-ness must be a property of every document this page will ever load, including the canvas
  // Iframes a view change rebuilds after this point. Arm before navigating.
  await armFreeze(page);
  await page.goto(url, { timeout: 120_000, waitUntil: "networkidle2" });
  await page.waitForFunction(() => Boolean(window.__jxAutomation), { timeout: 30_000 });

  await settle(page, net, "boot");
  await assertNoUninvitedModal(page, shot.name);
  await applyOpenState(page, open, net);

  const body: ThenSegment = {
    ...(shot.capture ? { capture: shot.capture } : {}),
    ...(shot.expect ? { expect: shot.expect } : {}),
    ...(shot.steps ? { steps: shot.steps } : {}),
  };
  const written = await runSegment(page, body, shot, ctx, net, `shot "${shot.name}"`);
  for (const [index, segment] of (shot.then ?? []).entries()) {
    written.push(
      ...(await runSegment(page, segment, shot, ctx, net, `shot "${shot.name}" then[${index}]`)),
    );
  }
  return written;
}
