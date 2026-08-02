/**
 * Single-shot execution: navigate Studio with automation + deep-link params, wait for deterministic
 * readiness, drive UI state through window.__jxAutomation, and capture a PNG.
 */

import { basename, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { Frame, Page } from "puppeteer-core";
import type { ClipSpec, ResolvedShot, ShotAction, WaitCondition } from "./types";

/**
 * A re-render that's visually indistinguishable from the committed PNG keeps the old bytes, so the
 * checked-in screenshots don't churn in git on every run. The diff is the mean per-channel
 * difference of a 32×32 downscale, in [0,1]: same-machine re-runs sit near zero; a real content
 * change (or cross-machine font rasterization) blows well past this. Bump with `--force`.
 */
const DIFF_THRESHOLD = 0.01;

/**
 * What `__jxAutomation.run` hands back. An empty object means the command executed in-page and the
 * runner is done. A `click` means the command has no programmatic seam yet (see the INTERIM banner
 * in packages/studio/src/services/automation.ts) and the runner must press the resolved control
 * with a real mouse — the selector lives in the automation table, never in the manifest.
 */
interface AutomationRunResult {
  click?: { button?: "left" | "right"; selector: string };
}

declare global {
  interface Window {
    __jxAutomation: {
      [method: string]: (...args: unknown[]) => unknown;
      run: (id: string, args?: Record<string, unknown>) => AutomationRunResult;
      waitForCanvasReady: (timeoutMs?: number) => Promise<void>;
    };
  }
}

/** Kill animations/transitions/carets in a frame so captures don't race motion. */
const FREEZE_CSS =
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

/**
 * Install the freeze into the document that is about to be parsed.
 *
 * The freeze used to be injected into every live frame at one moment in the shot — after which
 * `setCanvasMode` rebuilt the canvas iframe DOM, so 58 of 61 shots photographed a frame created
 * AFTER the freeze and therefore unfrozen. Frozen-ness has to be a property of the document, not of
 * a moment in the runner, so this runs as an on-new-document script (which Chromium applies to the
 * page AND to every frame it later creates) and is re-applied to any frame that attaches with a
 * document already in flight.
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

async function hook(page: Page, method: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate((m, a) => window.__jxAutomation[m]!(...a), method, args);
}

// ─── Quiescence: the one predicate that is allowed to fail ──────────────────────

/**
 * Connections that are open BY DESIGN and never complete: the dev server's live-reload EventSource
 * and the collab WebSocket. Counting them as in-flight would mean the page is never quiet, which is
 * how a real predicate turns back into a sleep.
 */
const LONG_LIVED_PATHS = ["/__reload", "/__studio/collab"];
const LONG_LIVED_TYPES = new Set(["eventsource", "websocket"]);

/** How long a single request may stay in flight before the tracker stops counting it. */
const REQUEST_STALL_MS = 20_000;

/**
 * Counts the page's outstanding network requests, across every frame.
 *
 * This exists because of a measured failure: the `hero` shot captured first in a process and
 * captured tenth produced two different pictures at RMSE 0.150, and the difference was that the
 * starter site's webfonts (fetched from a remote host inside the canvas iframe) had not swapped in
 * yet on the cold one. Nothing in the runner was waiting for them — `document.fonts.ready` in the
 * canvas frame resolves "loaded" against an EMPTY font set while the frame is still blank. The
 * honest predicate is "the page has stopped fetching", and it names what it was still fetching when
 * it times out.
 */
function trackRequests(page: Page): { pending: () => string[] } {
  const inFlight = new Map<string, number>();
  const ignorable = (url: string, type: string) =>
    LONG_LIVED_TYPES.has(type) || LONG_LIVED_PATHS.some((p) => url.includes(p));
  page.on("request", (req) => {
    if (!ignorable(req.url(), req.resourceType())) {
      inFlight.set(req.url(), Date.now());
    }
  });
  const settle = (req: { url: () => string }) => inFlight.delete(req.url());
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
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
 * that has stopped moving. Returns the reasons it is NOT ready, so a timeout can say so instead of
 * being answered with another 500 ms.
 *
 * Focus is a condition here, not something the runner simply sets, because a dialog's own focus
 * management is asynchronous and will happily overwrite a blur that ran a frame too early.
 * Measured: `new-project` and `settings-modal` grew and lost a blue `:focus-visible` ring on the
 * modal's close button between two runs of the same tree, purely on whether the runner's blur
 * landed before or after the overlay's autofocus. Waiting for focus to be STABLE (rather than
 * insisting it be nowhere) is correct in both worlds: where nothing claims focus the blur stands
 * and no ring is photographed, and where a focus trap claims it the ring is photographed every
 * single time.
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
  /* Images are covered by the network condition and deliberately NOT by an `img.complete` sweep.
     Measured, both naive predicates are wrong: "no broken image" never clears (the design canvas
     renders unresolved bindings as literal srcs like `{$map/item/image}`, and several starters ship
     a 404 favicon), and "no incomplete image" never clears either (`loading="lazy"` images below the
     fold stay incomplete forever). Both blocked 8 of 61 shots for the full 30s timeout.

     What remains uncovered is `installCanvasImageRetry`'s 150/300/450ms re-fire ladder: in the gaps
     BETWEEN those timers the network is quiet and nothing is in flight, so a capture can land on an
     alt-text placeholder that the next retry would have filled. Only the app knows a retry is
     pending, which is precisely why §13.4 puts "images decoded" inside the canvas's own `idle`
     message rather than in the runner. Left for that; a sleep here would be the wrong shape and
     would be the first step back toward 73 seconds of them. */
  const w = window as unknown as { __jxShotFocus?: Element | null };
  const active = document.activeElement;
  if (!("__jxShotFocus" in w) || w.__jxShotFocus !== active) {
    w.__jxShotFocus = active;
    blocked.push(`focus moved to <${active?.tagName.toLowerCase() ?? "none"}>`);
  }
  return blocked;
}

/** Everything blocking a truthful capture right now, named. Empty means "photograph it". */
async function quiescenceBlockers(page: Page, net: { pending: () => string[] }): Promise<string[]> {
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

/**
 * Block until the page is quiet for two consecutive animation frames, or REJECT naming what is
 * still outstanding. Rejecting is the whole point: a sleep cannot fail, so a slow subsystem gets
 * answered with a bigger number and the wrong capture is accepted.
 */
async function waitForQuiescence(
  page: Page,
  net: { pending: () => string[] },
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
    await runWait(page, { frames: 1, type: "settle" });
  }
  throw new Error(`page never went quiet (${timeoutMs}ms). Blocked by:\n  ${last.join("\n  ")}`);
}

/**
 * Put the pointer and the keyboard focus somewhere the shot DECLARED, which today means nowhere.
 *
 * `:hover` and `:focus-visible` visibly change dense panels, and neither was controlled: the
 * pointer stayed wherever the last click action left it and focus stayed in whatever the last
 * interaction touched, so a panel that re-rendered under a stationary cursor could pick up a hover
 * ring the shot never asked for.
 */
async function resetPointerAndFocus(page: Page): Promise<void> {
  // Off-canvas: no element is under the cursor, so nothing matches :hover.
  await page.mouse.move(-1, -1);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      active.blur();
    }
  });
}

async function runWait(page: Page, wait: WaitCondition): Promise<void> {
  switch (wait.type) {
    case "canvasReady": {
      await page.evaluate(
        (timeoutMs) => window.__jxAutomation.waitForCanvasReady(timeoutMs),
        wait.timeoutMs ?? 30_000,
      );
      return;
    }
    case "fonts": {
      for (const frame of page.frames()) {
        try {
          await frame.evaluate(() => document.fonts.ready.then(() => null));
        } catch {
          // Detached/opaque frame — skip.
        }
      }
      return;
    }
    case "selector": {
      await page.waitForSelector(wait.selector, { timeout: wait.timeoutMs ?? 15_000 });
      return;
    }
    case "settle": {
      await page.evaluate(
        (frames) =>
          new Promise<void>((done) => {
            const step = (n: number) => {
              if (n <= 0) {
                done();
                return;
              }
              requestAnimationFrame(() => step(n - 1));
            };
            step(frames);
          }),
        wait.frames,
      );
      return;
    }
    case "timeout": {
      await Bun.sleep(wait.ms);
      return;
    }
    default: {
      throw new Error(`unknown wait ${JSON.stringify(wait)}`);
    }
  }
}

async function runWaits(page: Page, waits: WaitCondition[]): Promise<void> {
  for (const wait of waits) {
    await runWait(page, wait);
  }
}

/** The canvas preview iframe — Studio's only child frame. */
function canvasFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) {
    throw new Error("canvas iframe not found");
  }
  return frame;
}

async function runAction(page: Page, action: ShotAction): Promise<void> {
  switch (action.do) {
    case "run": {
      const result = (await page.evaluate(
        (id, args) => window.__jxAutomation.run(id, args),
        action.id,
        action.args ?? {},
      )) as AutomationRunResult;
      if (result?.click) {
        await page.click(
          result.click.selector,
          result.click.button ? { button: result.click.button } : {},
        );
      }
      return;
    }
    case "click": {
      await page.click(action.selector, action.button ? { button: action.button } : {});
      return;
    }
    case "hover": {
      await page.hover(action.selector);
      return;
    }
    case "type": {
      await page.click(action.selector);
      await page.keyboard.type(action.text, { delay: 10 });
      return;
    }
    case "canvasClick": {
      const frame = canvasFrame(page);
      // Design and Stylebook open fitted, so the canvas sits under a CSS scale transform.
      // Puppeteer's ElementHandle.click() derives its point from the frame's own box model and does
      // Not compose that transform, so under a fit it either lands on the wrong node or reports the
      // Element as "not clickable". Map the content-space rect through the iframe's on-screen box
      // Ourselves — getBoundingClientRect() on the iframe in the TOP document already carries scale.
      const handle = await frame.waitForSelector(action.selector, { timeout: 15_000 });
      const clickOpts = {
        count: action.clickCount ?? 1,
        ...(action.button ? { button: action.button } : {}),
      };
      // ClientWidth is the UNSCALED content width; box.width is the scaled on-screen width.
      const scale = await page.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>("#canvas-wrap iframe");
        if (!iframe || iframe.clientWidth <= 0) {
          return 1;
        }
        return iframe.getBoundingClientRect().width / iframe.clientWidth;
      });
      if (Math.abs(scale - 1) < 0.001) {
        // Unscaled (edit mode sizes the frame to full content height and scrolls the wrapper).
        // ElementHandle.click() scrolls the target into view first, which the manual path below
        // Cannot do — so it stays the default wherever there is no transform to compose.
        await handle!.click(clickOpts);
        return;
      }
      const point = await handle!.evaluate((el: Element) => {
        const r = el.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      });
      const mapped = await page.evaluate(
        (cx: number, cy: number) => {
          const iframe = document.querySelector<HTMLIFrameElement>("#canvas-wrap iframe")!;
          const box = iframe.getBoundingClientRect();
          const s = box.width / iframe.clientWidth;
          return { x: box.x + cx * s, y: box.y + cy * s };
        },
        point.cx,
        point.cy,
      );
      await page.mouse.click(mapped.x, mapped.y, clickOpts);
      return;
    }
    case "canvasType": {
      await page.keyboard.type(action.text, { delay: 15 });
      return;
    }
    case "canvasKey": {
      await page.keyboard.press(action.key as Parameters<Page["keyboard"]["press"]>[0]);
      return;
    }
    case "openQuickSearch": {
      await hook(page, "openQuickSearch");
      return;
    }
    case "showWelcome": {
      await hook(page, "showWelcome", action.projects ? { projects: action.projects } : undefined);
      return;
    }
    case "openSettings": {
      await hook(page, "openSettings", action.section);
      return;
    }
    case "editDef": {
      await hook(page, "editDef", action.defName);
      return;
    }
    case "editFunction": {
      await hook(page, "editFunction", action.path, action.eventKey);
      return;
    }
    case "openBrowse": {
      await hook(page, "openBrowse");
      return;
    }
    case "openDataGrid": {
      await hook(page, "openDataGrid", {
        table: action.table,
        ...(action.connection ? { connection: action.connection } : {}),
      });
      return;
    }
    case "openNewProject": {
      await hook(page, "openNewProject");
      return;
    }
    case "seedAssistant": {
      await hook(page, "seedAssistant", { messages: action.messages });
      return;
    }
    case "seedCollab": {
      await hook(page, "seedCollab", { peers: action.peers });
      return;
    }
    case "seedPublish": {
      await hook(page, "seedPublish", { deployment: action.deployment });
      return;
    }
    case "dispatchDragOver": {
      await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) {
          throw new Error(`dispatchDragOver: no element matches ${selector}`);
        }
        el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true }));
      }, action.selector);
      return;
    }
    case "select": {
      await hook(page, "select", action.path);
      return;
    }
    case "setActivity":
    case "setCanvasMode":
    case "setRightTab":
    case "setStatus":
    case "setTheme": {
      await hook(page, action.do, action.value);
      return;
    }
    case "setZoom": {
      await hook(page, "setZoom", action.value);
      return;
    }
    case "wait": {
      await Bun.sleep(action.ms);
      return;
    }
    default: {
      throw new Error(`unknown action ${JSON.stringify(action)}`);
    }
  }
}

async function resolveClip(
  page: Page,
  clip: ClipSpec,
): Promise<{ height: number; width: number; x: number; y: number } | undefined> {
  if (clip === "fullPage") {
    return undefined;
  }
  if ("selector" in clip) {
    const rect = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (!el) {
        return null;
      }
      const r = el.getBoundingClientRect();
      return { height: r.height, width: r.width, x: r.x, y: r.y };
    }, clip.selector);
    if (!rect || rect.width === 0 || rect.height === 0) {
      throw new Error(`clip selector "${clip.selector}" matched nothing visible`);
    }
    return rect;
  }
  return clip;
}

export interface ShotContext {
  log: (line: string) => void;
  outDir: string;
  repoRoot: string;
  serverUrl: string;
  studioPath: string;
  /** Overwrite every shot regardless of the visual-diff check (for a wholesale re-baseline). */
  force: boolean;
}

/**
 * Normalized visual difference in [0,1] between two PNG buffers. Both are decoded and downscaled to
 * a 32×32 thumbnail in the (already-running) browser — no native image deps, since Sharp is
 * unavailable on some hosts — and compared as mean per-channel absolute difference. Downscaling
 * averages away sub-pixel anti-aliasing jitter, so the metric tracks perceived change.
 */
async function visualDiff(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async (aB64, bB64) => {
      const N = 32;
      const thumb = async (b64: string): Promise<Uint8ClampedArray> => {
        const img = new Image();
        await new Promise<void>((res, rej) => {
          img.addEventListener("load", () => res());
          img.addEventListener("error", () => rej(new Error("decode failed")));
          img.src = `data:image/png;base64,${b64}`;
        });
        const canvas = document.createElement("canvas");
        canvas.width = N;
        canvas.height = N;
        const c2d = canvas.getContext("2d");
        if (!c2d) {
          throw new Error("no 2d context");
        }
        c2d.drawImage(img, 0, 0, N, N);
        return c2d.getImageData(0, 0, N, N).data;
      };
      const [pa, pb] = await Promise.all([thumb(aB64), thumb(bB64)]);
      let sum = 0;
      for (let i = 0; i < pa.length; i += 1) {
        sum += Math.abs((pa[i] ?? 0) - (pb[i] ?? 0));
      }
      return sum / (pa.length * 255);
    },
    a.toString("base64"),
    b.toString("base64"),
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

async function captureVariant(
  page: Page,
  shot: ResolvedShot,
  ctx: ShotContext,
  fileName: string,
): Promise<string | null> {
  if (shot.clip === "none") {
    return null; // Region-only shot: skip the full-view capture.
  }
  const clip = await resolveClip(page, shot.clip);
  const outPath = join(ctx.outDir, fileName);
  // With a clip puppeteer defaults captureBeyondViewport to TRUE, which resizes the render surface
  // To the full page — a relayout that natively resets Studio's canvas scroller to 0 mid-capture.
  // Clips here always sit inside the viewport, so capture strictly within it.
  const buffer = Buffer.from(
    await page.screenshot(clip ? { captureBeyondViewport: false, clip } : { fullPage: true }),
  );
  await writeIfChanged(page, outPath, buffer, ctx, shot.name);
  return outPath;
}

/**
 * Measure a region element's on-screen box, expand it by `padding`, and clamp it to the page so
 * puppeteer's clip never falls outside the rendered area. Scrolls the element into view first so a
 * control nested in a scrollable panel still lands in frame.
 */
async function resolveRegionClip(
  page: Page,
  region: { padding?: number; selector: string },
): Promise<{ height: number; width: number; x: number; y: number }> {
  await page.waitForSelector(region.selector, { timeout: 15_000 });
  const viewport = page.viewport() ?? { height: 0, width: 0 };
  const rect = await page.evaluate(
    (selector, pad, vw, vh) => {
      const el = document.querySelector(selector);
      if (!el) {
        return null;
      }
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.x - pad);
      const y = Math.max(0, r.y - pad);
      return {
        height: Math.min(vh - y, r.height + pad + (r.y - y)),
        width: Math.min(vw - x, r.width + pad + (r.x - x)),
        x,
        y,
      };
    },
    region.selector,
    region.padding ?? 0,
    viewport.width,
    viewport.height,
  );
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`region selector "${region.selector}" matched nothing visible`);
  }
  return rect;
}

/**
 * Record every scroll offset in the page so a region measurement can be undone.
 *
 * {@link resolveRegionClip} scrolls the region into view, which leaves the page somewhere the NEXT
 * region did not ask for — and 16 shots capture two or more regions, so region #2 was being
 * measured against region #1's scroll position. The refs live on `window` rather than in a data
 * attribute because an attribute would be in the photograph.
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
    const w = window as unknown as { __jxShotScroll?: [Element, number, number][] };
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

async function captureRegions(
  page: Page,
  shot: ResolvedShot,
  ctx: ShotContext,
  net: { pending: () => string[] },
): Promise<string[]> {
  const written: string[] = [];
  for (const region of shot.regions ?? []) {
    // Every region measures from the SAME page state: save it, scroll to measure, capture, put it
    // Back. Otherwise region N's scrollIntoView is region N+1's starting position.
    await saveScrollState(page);
    const clip = await resolveRegionClip(page, region);
    await resetPointerAndFocus(page);
    await waitForQuiescence(page, net);
    const outPath = join(ctx.outDir, `${region.name}.png`);
    // CaptureBeyondViewport: false — see captureVariant (region clips are clamped to the viewport).
    const buffer = Buffer.from(await page.screenshot({ captureBeyondViewport: false, clip }));
    await writeIfChanged(page, outPath, buffer, ctx, shot.name);
    written.push(outPath);
    await restoreScrollState(page);
  }
  return written;
}

export async function executeShot(
  page: Page,
  shot: ResolvedShot,
  ctx: ShotContext,
): Promise<string[]> {
  const written: string[] = [];
  const net = trackRequests(page);
  await page.setViewport({
    deviceScaleFactor: shot.deviceScaleFactor,
    height: shot.viewport.height,
    width: shot.viewport.width,
  });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

  const params = new URLSearchParams({ automation: "1" });
  if (!shot.noProject) {
    params.set("file", shot.file!);
    params.set("project", resolve(ctx.repoRoot, shot.project));
  }
  const url = `${ctx.serverUrl}${ctx.studioPath}?${params}`;
  ctx.log(`[shot:${shot.name}] ${url}`);

  // Studio persists panel widths/collapse state to localStorage. The shot's own browser context is
  // Already fresh, so this is belt-and-braces against a same-context reload rather than the primary
  // Isolation — but it costs one line and it is the difference between "starts from defaults" being
  // A property and being a hope.
  await page.evaluateOnNewDocument(() => localStorage.clear());
  // Frozen-ness must be a property of every document this page will ever load, including the canvas
  // Iframes that setCanvasMode rebuilds AFTER this point. Arm before navigating.
  await armFreeze(page);
  await page.goto(url, { timeout: 120_000, waitUntil: "networkidle2" });
  await page.waitForFunction(() => Boolean(window.__jxAutomation), { timeout: 30_000 });

  // Baseline readiness before driving state; the shot's own waitFor runs after actions (it may
  // Reference UI the actions create, e.g. the Monaco function editor). Without a project there
  // Is no canvas to wait on.
  await runWaits(
    page,
    shot.noProject || shot.noCanvas
      ? [{ type: "fonts" }, { frames: 2, type: "settle" }]
      : [
          { timeoutMs: 60_000, type: "canvasReady" },
          { type: "fonts" },
          { frames: 2, type: "settle" },
        ],
  );

  if (shot.theme !== "dark") {
    await hook(page, "setTheme", shot.theme);
  }
  if (shot.canvasMode) {
    await hook(page, "setCanvasMode", shot.canvasMode);
    await runWait(page, { type: "canvasReady" });
  }
  for (const action of shot.actions ?? []) {
    await runAction(page, action);
  }
  await runWaits(page, shot.waitFor);
  await resetPointerAndFocus(page);
  await waitForQuiescence(page, net);

  const main = await captureVariant(page, shot, ctx, `${shot.name}.png`);
  if (main) {
    written.push(main);
  }

  written.push(...(await captureRegions(page, shot, ctx, net)));

  for (const variant of shot.variants ?? []) {
    if (variant.theme) {
      await hook(page, "setTheme", variant.theme);
    }
    for (const action of variant.actions ?? []) {
      await runAction(page, action);
    }
    await runWaits(page, variant.waitFor ?? shot.waitFor);
    await resetPointerAndFocus(page);
    await waitForQuiescence(page, net);
    const v = await captureVariant(page, shot, ctx, `${shot.name}${variant.suffix}.png`);
    if (v) {
      written.push(v);
    }
  }

  return written;
}
