import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { studioDir } from "../src/canvas-runtime";

const savedEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...savedEnv };
});

afterEach(() => {
  process.env = { ...savedEnv };
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
