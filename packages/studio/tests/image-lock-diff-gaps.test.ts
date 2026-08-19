/**
 * The corners of `scripts/check-image-lock.ts` that `image-lock.test.ts` does not walk into:
 *
 * - `detectFontFamilies` when `fc-list` is absent, and when it is present but exits non-zero — both
 *   of which produce an `unknown` fontset rather than a fabricated one.
 * - `describeRuntime(undefined)`: a lock entry with no runtime block at all, which must be named as
 *   `no runtime` rather than crashing the check that exists to catch it.
 * - `describeChange` when both PNGs decode but a pixel ratio is meaningless (a resize), which must
 *   fall back to byte sizes rather than to a number nobody can act on.
 * - The CLI's note and warning printers, which are the only way a quarantine or an uncaptured shot
 *   reaches a human on a run that still exits 0.
 *
 * Same shape as `image-lock.test.ts`: pure functions fed hand-built inputs, plus a temp-directory
 * fake repo for the CLI. Real committed PNGs stand in for the encoder there, so the decode path is
 * exercised against bytes Chromium actually produced.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCK_VERSION,
  checkImageLock,
  describeChange,
  formatBytes,
  describeImage,
  detectFontFamilies,
  main,
  serializeLock,
  shotDefinitionHashes,
} from "../../../scripts/check-image-lock";
import type { CaptureLock, CaptureRuntime, LockImage } from "../../../scripts/check-image-lock";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const RUNTIME: CaptureRuntime = { chromium: "141", fontset: "fc:abc123", os: "ubuntu-24.04" };

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `jx-${prefix}-`));
}

function entry(overrides: Partial<LockImage> = {}): LockImage {
  return {
    bytes: 100,
    capturedAt: "2026-01-15T09:30:00Z",
    capturedBy: "screenshots@local",
    definition: "d".repeat(64),
    height: 4,
    runtime: RUNTIME,
    sha256: "a".repeat(64),
    shot: "hero",
    width: 8,
    ...overrides,
  };
}

function lockOf(images: Record<string, LockImage>): CaptureLock {
  return { images, lock: LOCK_VERSION, manifest: "scripts/screenshots/manifest.json" };
}

// ─── detectFontFamilies ───────────────────────────────────────────────────────

/** A stand-in `fc-list` on `PATH`, so the real fontconfig on this host is never the subject. */
function stubFcList(body: string): string {
  const dir = scratch("fc");
  const path = join(dir, "fc-list");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return dir;
}

describe("detectFontFamilies", () => {
  const realPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = realPath;
  });

  test("reads the families fc-list prints", () => {
    process.env.PATH = stubFcList("#!/bin/sh\nprintf 'Stub Sans\\nStub Serif\\n'\n");
    expect(detectFontFamilies()).toEqual(["Stub Sans", "Stub Serif", ""]);
  });

  test("is empty when fc-list is not on PATH, so the fontset reads as unknown", () => {
    process.env.PATH = "";
    expect(detectFontFamilies()).toEqual([]);
  });

  test("is empty when fc-list fails, rather than recording whatever it managed to print", () => {
    process.env.PATH = stubFcList("#!/bin/sh\nprintf 'Half A Family\\n'\nexit 1\n");
    expect(detectFontFamilies()).toEqual([]);
  });
});

// ─── A lock entry with no runtime block ───────────────────────────────────────

describe("checkImageLock runtime reporting", () => {
  const manifest = { shots: [{ name: "hero" }] };
  const definition = shotDefinitionHashes(manifest).get("hero")!;

  test("names an entry with no runtime at all, and one with a hole in its triple", () => {
    const noRuntime = {
      bytes: 100,
      capturedAt: "2026-01-15T09:30:00Z",
      capturedBy: "screenshots@local",
      definition,
      height: 4,
      sha256: "a".repeat(64),
      shot: "hero",
      width: 8,
    } as unknown as LockImage;
    const holedRuntime = entry({
      definition,
      runtime: { chromium: "141", fontset: "fc:abc123", os: "" },
      sha256: "b".repeat(64),
    });
    const lock = lockOf({
      "docs/images/hero-a.png": noRuntime,
      "docs/images/hero-b.png": holedRuntime,
    });
    const result = checkImageLock({
      disk: [
        { bytes: 100, path: "docs/images/hero-a.png", sha256: "a".repeat(64) },
        { bytes: 100, path: "docs/images/hero-b.png", sha256: "b".repeat(64) },
      ],
      lock,
      manifest,
    });
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toContain(
      "entry docs/images/hero-a.png records an incomplete runtime triple (no runtime)",
    );
    expect(result.violations[1]).toContain(
      "entry docs/images/hero-b.png records an incomplete runtime triple " +
        "(chromium 141 · fc:abc123 · )",
    );
  });
});

// ─── describeChange over two decodable PNGs of different sizes ────────────────

describe("describeChange", () => {
  const tabStrip = new Uint8Array(readFileSync(join(REPO_ROOT, "docs/images/tab-strip.png")));
  const fieldMode = new Uint8Array(
    readFileSync(join(REPO_ROOT, "docs/images/field-mode-button.png")),
  );

  test("reports pixels when the two captures are comparable", () => {
    expect(
      describeChange({
        after: entry({ bytes: tabStrip.length }),
        afterBytes: tabStrip,
        before: entry({ bytes: tabStrip.length }),
        beforeBytes: tabStrip,
        state: "changed",
      }),
    ).toBe("0.00% of pixels");
  });

  test("falls back to bytes when both decode but the pixels are not comparable", () => {
    // The lock entries agree on 8×4, so the dimension branch is not what answers here: the PNGs
    // Themselves are different sizes, so `changedPixelRatio` refuses and the bytes speak.
    //
    // DERIVED, not snapshotted. These are real committed PNGs and the screenshot lane rewrites them
    // Whenever anything visual changes — this assertion used to read "6 KB → 9 KB" and went red the
    // First time the lane re-captured, naming a function that was working perfectly. What is under
    // Test is the FALLBACK, not today's file sizes.
    const answer = describeChange({
      after: entry({ bytes: fieldMode.length }),
      afterBytes: fieldMode,
      before: entry({ bytes: tabStrip.length }),
      beforeBytes: tabStrip,
      state: "changed",
    });
    expect(answer).toBe(`${formatBytes(tabStrip.length)} → ${formatBytes(fieldMode.length)}`);
    // And it really is the byte branch, not a pixel ratio that happens to format alike.
    expect(answer).not.toContain("%");
  });
});

// ─── The CLI's notes and warnings ─────────────────────────────────────────────

describe("the CLI reports what does not fail the run", () => {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    spies = [
      spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      }),
      spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warns.push(args.join(" "));
      }),
      spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.join(" "));
      }),
    ];
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
    logs.length = 0;
    warns.length = 0;
    errors.length = 0;
  });

  /** A fake repo whose lock is correct, but whose manifest holds a quarantine and a gap. */
  function fixture(): { docs: string; images: string; lockPath: string; manifestPath: string } {
    const root = scratch("cli-notes");
    const docs = join(root, "docs");
    const images = join(docs, "images");
    mkdirSync(images, { recursive: true });
    writeFileSync(join(docs, "page.md"), "![](<./images/hero.png>)\n");
    const png = new Uint8Array(readFileSync(join(REPO_ROOT, "docs/images/tab-strip.png")));
    writeFileSync(join(images, "hero.png"), png);
    const manifest = {
      defaults: { theme: "dark" },
      shots: [
        { docs: ["page"], name: "hero" },
        { name: "never-shot" },
        { name: "parked", status: { reason: "xpath", since: "abc123", state: "quarantined" } },
      ],
    };
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const lockPath = join(root, "capture.lock.json");
    const captured = describeImage(png, {
      capturedAt: "2026-01-15T09:30:00Z",
      capturedBy: "screenshots@local",
      definition: shotDefinitionHashes(manifest).get("hero")!,
      runtime: RUNTIME,
      shot: "hero",
    });
    writeFileSync(lockPath, serializeLock(lockOf({ [`${images}/hero.png`]: captured })));
    return { docs, images, lockPath, manifestPath };
  }

  test("prints the quarantine note and the uncaptured-shot warning, and still exits 0", async () => {
    const f = fixture();
    const code = await main([
      "--manifest",
      f.manifestPath,
      "--lock",
      f.lockPath,
      "--images",
      f.images,
      "--docs",
      f.docs,
    ]);
    expect(code).toBe(0);
    expect(logs).toContain("  quarantined: parked — xpath (since abc123)");
    expect(warns[0]).toBe("image lock: 1 warning(s):");
    expect(warns[1]).toContain('shot "never-shot" has never been captured');
    expect(warns[1]!.startsWith("  ")).toBe(true);
    expect(errors).toEqual([]);
  });
});
