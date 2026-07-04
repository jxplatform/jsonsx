/**
 * Single-shot execution: navigate Studio with automation + deep-link params, wait for deterministic
 * readiness, drive UI state through window.__jxAutomation, and capture a PNG.
 */

import { join, resolve } from "node:path";
import type { Frame, Page } from "puppeteer-core";
import type { ClipSpec, ResolvedShot, ShotAction, WaitCondition } from "./types";

declare global {
  interface Window {
    __jxAutomation: {
      [method: string]: (...args: unknown[]) => unknown;
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

async function runAction(page: Page, action: ShotAction): Promise<void> {
  switch (action.do) {
    case "click": {
      await page.click(action.selector);
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
}

async function captureVariant(
  page: Page,
  shot: ResolvedShot,
  ctx: ShotContext,
  fileName: string,
): Promise<string> {
  const clip = await resolveClip(page, shot.clip);
  const outPath = join(ctx.outDir, fileName);
  await page.screenshot({
    ...(clip ? { clip } : { fullPage: true }),
    path: outPath as `${string}.png`,
  });
  return outPath;
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

  const projectAbs = resolve(ctx.repoRoot, shot.project);
  const params = new URLSearchParams({
    automation: "1",
    file: shot.file,
    project: projectAbs,
  });
  const url = `${ctx.serverUrl}${ctx.studioPath}?${params}`;
  ctx.log(`[shot:${shot.name}] ${url}`);

  await page.goto(url, { timeout: 120_000, waitUntil: "networkidle2" });
  await page.waitForFunction(() => Boolean(window.__jxAutomation), { timeout: 30_000 });

  // Baseline readiness before driving state; the shot's own waitFor runs after actions (it may
  // Reference UI the actions create, e.g. the Monaco function editor).
  await runWaits(page, [
    { timeoutMs: 60_000, type: "canvasReady" },
    { type: "fonts" },
    { frames: 2, type: "settle" },
  ]);
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

  written.push(await captureVariant(page, shot, ctx, `${shot.name}.png`));

  for (const variant of shot.variants ?? []) {
    if (variant.theme) {
      await hook(page, "setTheme", variant.theme);
    }
    for (const action of variant.actions ?? []) {
      await runAction(page, action);
    }
    await runWaits(page, shot.waitFor);
    written.push(await captureVariant(page, shot, ctx, `${shot.name}${variant.suffix}.png`));
  }

  return written;
}
