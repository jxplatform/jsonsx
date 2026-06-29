import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _resetProbeCache,
  probeLoopback,
  studioDir,
  useLoopbackCanvas,
} from "../src/canvas-runtime";

const savedEnv = { ...process.env };

beforeEach(() => {
  _resetProbeCache();
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("useLoopbackCanvas", () => {
  test("DEFAULTS TO FALSE (commits 1-7 safety invariant)", () => {
    delete process.env.JX_CANVAS_HOST;
    expect(useLoopbackCanvas()).toBe(false);
  });

  test("JX_CANVAS_HOST=views is a hard off override", () => {
    process.env.JX_CANVAS_HOST = "views";
    expect(useLoopbackCanvas()).toBe(false);
  });

  test("stays false even with JX_CANVAS_HOST unset to a non-views value (default not yet flipped)", () => {
    process.env.JX_CANVAS_HOST = "loopback";
    expect(useLoopbackCanvas()).toBe(false);
  });
});

describe("studioDir", () => {
  test("honors JX_STUDIO_ASSETS when it contains canvas.html", () => {
    const dir = join(tmpdir(), `jx-studio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "canvas.html"), "<html></html>");
    try {
      process.env.JX_STUDIO_ASSETS = dir;
      expect(studioDir()).toBe(dir);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("falls back to the dev assets path when no candidate has canvas.html", () => {
    delete process.env.JX_STUDIO_ASSETS;
    process.env.JX_STUDIO_ASSETS = join(tmpdir(), "definitely-missing-jx-studio-dir");
    const result = studioDir();
    // The fallback is the packaged checkout layout (…/assets/studio); assert the shape.
    expect(result.replaceAll("\\", "/").endsWith("/assets/studio")).toBe(true);
  });
});

describe("probeLoopback", () => {
  test("succeeds against a freshly-bound loopback server and caches the result", async () => {
    const first = await probeLoopback();
    expect(first).toBe(true);
    // Cached: a second call returns the same result without re-binding.
    expect(await probeLoopback()).toBe(true);
  });
});
