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

async function freezeFrame(frame: Frame): Promise<void> {
  try {
    await frame.evaluate((css) => {
      const style = document.createElement("style");
      style.dataset.jxScreenshotFreeze = "1";
      style.textContent = css;
      document.head.append(style);
    }, FREEZE_CSS);
  } catch {
    // Frame may have detached or be about:blank — freezing is best-effort per frame.
  }
}

async function hook(page: Page, method: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate((m, a) => window.__jxAutomation[m]!(...a), method, args);
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
      const el = await frame.waitForSelector(action.selector, { timeout: 15_000 });
      // Puppeteer-core ≥20 names the option `count` (a `clickCount` key is silently ignored).
      await el!.click({
        count: action.clickCount ?? 1,
        ...(action.button ? { button: action.button } : {}),
      });
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

async function captureRegions(page: Page, shot: ResolvedShot, ctx: ShotContext): Promise<string[]> {
  const written: string[] = [];
  for (const region of shot.regions ?? []) {
    // Re-settle so any scroll from the previous region's scrollIntoView is stable before measuring.
    await runWait(page, { frames: 1, type: "settle" });
    const clip = await resolveRegionClip(page, region);
    const outPath = join(ctx.outDir, `${region.name}.png`);
    // CaptureBeyondViewport: false — see captureVariant (region clips are clamped to the viewport).
    const buffer = Buffer.from(await page.screenshot({ captureBeyondViewport: false, clip }));
    await writeIfChanged(page, outPath, buffer, ctx, shot.name);
    written.push(outPath);
  }
  return written;
}

export async function executeShot(
  page: Page,
  shot: ResolvedShot,
  ctx: ShotContext,
): Promise<string[]> {
  const written: string[] = [];
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

  // Shots share one browser, and Studio persists panel widths/collapse state to localStorage —
  // A shot that collapses a panel would otherwise leak that layout into every later shot (order-
  // Dependent captures). Clear storage before the app boots so every shot starts from defaults.
  await page.evaluateOnNewDocument(() => localStorage.clear());
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
  for (const frame of page.frames()) {
    await freezeFrame(frame);
  }

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

  const main = await captureVariant(page, shot, ctx, `${shot.name}.png`);
  if (main) {
    written.push(main);
  }

  written.push(...(await captureRegions(page, shot, ctx)));

  for (const variant of shot.variants ?? []) {
    if (variant.theme) {
      await hook(page, "setTheme", variant.theme);
    }
    for (const action of variant.actions ?? []) {
      await runAction(page, action);
    }
    await runWaits(page, variant.waitFor ?? shot.waitFor);
    const v = await captureVariant(page, shot, ctx, `${shot.name}${variant.suffix}.png`);
    if (v) {
      written.push(v);
    }
  }

  return written;
}
