/**
 * The capture lock and `docs:images:check` (UX-REDESIGN-PLAN §13.5), plus the PNG reader the lane's
 * report is built on.
 *
 * These live under `packages/studio/tests` for the same reason `shot-contract-check.test.ts` does:
 * the CI matrix runs `bun test` per workspace, so a test at the repo root runs nowhere. The rules
 * are pure functions fed hand-built inputs — a test asserting "the repo has 65 images" would go red
 * on every PR that adds a docs page — with exactly three assertions made against the live tree,
 * each of which is a claim about the REPO rather than about a number:
 *
 * 1. Every committed PNG is one some manifest shot can produce (the lock is authored against a real
 *    mapping, not a hoped-for one).
 * 2. A real Chromium capture decodes — the decoder is tested against the thing it exists to read, not
 *    only against bytes this file wrote.
 * 3. `hashShotDefinition` is stable over the committed manifest, because a hash that moved between
 *    runs would fail `docs:images:check` on a clean tree and teach everyone to ignore it.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  DEFAULT_LOCK,
  LOCK_VERSION,
  buildReport,
  captureOrigin,
  captureRuntime,
  checkImageLock,
  chromiumMajor,
  collectDocImageRefs,
  describeChange,
  describeImage,
  detectFontFamilies,
  detectOs,
  emptyLock,
  fontsetId,
  fromRoot,
  hashShotDefinition,
  imageTargets,
  lockedImagePaths,
  main,
  manifestImageNames,
  parseArgs,
  quarantineRefFindings,
  quarantinedShots,
  readImagesOnDisk,
  readLock,
  readShots,
  reportRows,
  serializeLock,
  sha256Hex,
  shortHash,
  shotDefinitionHashes,
  shotImageNames,
  shotsByDocsPage,
  withoutCode,
  writeLock,
} from "../../../scripts/check-image-lock";
import type { CaptureLock, CaptureRuntime, LockImage } from "../../../scripts/check-image-lock";
import { changedPixelRatio, decodePng, readPngSize } from "../../../scripts/lib/png";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `jx-${prefix}-`));
}

// ─── A PNG writer, so the decoder is tested against every filter it implements ────────────────

const COLOR_TYPE: Readonly<Record<number, number>> = { 1: 0, 2: 4, 3: 2, 4: 6 };

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (const [index, code] of [...type].entries()) {
    out[4 + index] = code.codePointAt(0)!;
  }
  out.set(data, 8);
  // CRC left zero: the decoder does not validate it, and inventing a CRC here would be testing
  // Node's zlib rather than the reader.
  return out;
}

function paethOf(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

interface EncodeOptions {
  width: number;
  height: number;
  channels: number;
  /** Raw channel samples, `width * height * channels` long. */
  samples: number[];
  filter?: number;
  bitDepth?: number;
  interlace?: number;
  colorType?: number;
}

/** Minimal PNG writer: one filter type for every row, so each unfilter branch gets exercised. */
function encodePng(options: EncodeOptions): Uint8Array {
  const { channels, height, samples, width } = options;
  const filter = options.filter ?? 0;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const value = samples[y * stride + x]!;
      const left = x >= channels ? samples[y * stride + x - channels]! : 0;
      const up = y > 0 ? samples[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? samples[(y - 1) * stride + x - channels]! : 0;
      let encoded = value;
      if (filter === 1) {
        encoded = value - left;
      } else if (filter === 2) {
        encoded = value - up;
      } else if (filter === 3) {
        encoded = value - Math.floor((left + up) / 2);
      } else if (filter === 4) {
        encoded = value - paethOf(left, up, upLeft);
      }
      raw[y * (stride + 1) + 1 + x] = ((encoded % 256) + 256) % 256;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = options.bitDepth ?? 8;
  ihdr[9] = options.colorType ?? COLOR_TYPE[channels]!;
  ihdr[12] = options.interlace ?? 0;
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    // A chunk the reader must skip rather than choke on.
    chunk("tEXt", Uint8Array.from([65])),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    png.set(part, cursor);
    cursor += part.length;
  }
  return png;
}

/** A 2×2 RGBA image whose 16 samples are all distinct, so a filter bug cannot cancel out. */
function sample(filter: number, tweak = 0): Uint8Array {
  const samples = Array.from({ length: 16 }, (_unused, index) => (index * 17 + tweak) % 256);
  return encodePng({ channels: 4, filter, height: 2, samples, width: 2 });
}

describe("png", () => {
  test("readPngSize reads IHDR without inflating", () => {
    expect(readPngSize(sample(0))).toEqual({ height: 2, width: 2 });
  });

  test("readPngSize rejects short input, a wrong signature and a non-IHDR first chunk", () => {
    expect(readPngSize(new Uint8Array(10))).toBeNull();
    const wrongSignature = sample(0);
    wrongSignature[1] = 0;
    expect(readPngSize(wrongSignature)).toBeNull();
    const wrongFirstChunk = sample(0);
    wrongFirstChunk[12] = 0x62;
    expect(readPngSize(wrongFirstChunk)).toBeNull();
  });

  test.each([0, 1, 2, 3, 4])("decodes filter type %i to the same pixels", (filter) => {
    const decoded = decodePng(sample(filter));
    expect(decoded).not.toBeNull();
    expect([...decoded!.pixels]).toEqual(
      Array.from({ length: 16 }, (_unused, index) => (index * 17) % 256),
    );
  });

  test("widens grayscale, gray+alpha and RGB to RGBA", () => {
    const gray = decodePng(encodePng({ channels: 1, height: 1, samples: [9], width: 1 }));
    expect([...gray!.pixels]).toEqual([9, 9, 9, 255]);
    const grayAlpha = decodePng(encodePng({ channels: 2, height: 1, samples: [9, 3], width: 1 }));
    expect([...grayAlpha!.pixels]).toEqual([9, 9, 9, 3]);
    const rgb = decodePng(encodePng({ channels: 3, height: 1, samples: [1, 2, 3], width: 1 }));
    expect([...rgb!.pixels]).toEqual([1, 2, 3, 255]);
  });

  test("returns null for what Chromium never emits, and never throws", () => {
    const bad = sample(0);
    bad[0] = 0;
    expect(decodePng(bad)).toBeNull();
    const base = { channels: 4, height: 2, samples: Array.from({ length: 16 }, () => 1), width: 2 };
    expect(decodePng(encodePng({ ...base, bitDepth: 16 }))).toBeNull();
    expect(decodePng(encodePng({ ...base, interlace: 1 }))).toBeNull();
    expect(decodePng(encodePng({ ...base, colorType: 3 }))).toBeNull();
    expect(decodePng(encodePng({ ...base, height: 0 }))).toBeNull();
  });

  test("returns null for a truncated chunk, a missing IHDR and undersized pixel data", () => {
    expect(decodePng(sample(0).slice(0, 30))).toBeNull();
    const headerless = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(decodePng(headerless)).toBeNull();
    // IHDR claims 4×4 but the IDAT holds one 2×2 image's worth of scanlines.
    const ones = Array.from({ length: 16 }, () => 1);
    const short = encodePng({ channels: 4, height: 2, samples: ones, width: 2 });
    const view = new DataView(short.buffer);
    view.setUint32(16, 4);
    view.setUint32(20, 4);
    expect(decodePng(short)).toBeNull();
    // A well-formed chunk list whose IDAT is not deflate data.
    const corrupt = new Uint8Array(short);
    corrupt.set([9, 9, 9, 9], 8 + 12 + 13 + 8 + 13);
    expect(decodePng(corrupt)).toBeNull();
  });

  test("changedPixelRatio counts pixels, honours tolerance and refuses a resize", () => {
    const a = decodePng(sample(0))!;
    expect(changedPixelRatio(a, a)).toBe(0);
    const b = decodePng(sample(0, 1))!;
    expect(changedPixelRatio(a, b)).toBe(1);
    // Every channel moved by 1 except the last, which wrapped 255 → 0: a tolerance of 4 forgives
    // Three of the four pixels and correctly refuses to forgive that one.
    expect(changedPixelRatio(a, b, 4)).toBe(0.25);
    expect(changedPixelRatio(a, b, 255)).toBe(0);
    const one = decodePng(encodePng({ channels: 4, height: 1, samples: [1, 1, 1, 1], width: 1 }))!;
    expect(changedPixelRatio(a, one)).toBeNull();
  });

  test("decodes a real Chromium capture", () => {
    const bytes = new Uint8Array(readFileSync(join(REPO_ROOT, "docs/images/tab-strip.png")));
    const size = readPngSize(bytes)!;
    const decoded = decodePng(bytes)!;
    expect(decoded).not.toBeNull();
    expect(decoded.width).toBe(size.width);
    expect(decoded.pixels.length).toBe(size.width * size.height * 4);
  });
});

// ─── The definition hash ──────────────────────────────────────────────────────

describe("hashShotDefinition", () => {
  const shot = { name: "git-panel", open: { file: "a.json", view: "design" } };

  test("is insensitive to key order and to comment keys", () => {
    const reordered = { open: { view: "design", file: "a.json" }, name: "git-panel" };
    expect(hashShotDefinition(reordered)).toBe(hashShotDefinition(shot));
    expect(hashShotDefinition({ ...shot, "// why": "a note" })).toBe(hashShotDefinition(shot));
    expect(hashShotDefinition({ ...shot, extra: undefined })).toBe(hashShotDefinition(shot));
  });

  test("ignores the non-visual fields, so a docs slug or a quarantine costs no re-capture", () => {
    expect(hashShotDefinition({ ...shot, docs: ["studio/publish"] })).toBe(
      hashShotDefinition(shot),
    );
    expect(hashShotDefinition({ ...shot, status: { state: "quarantined" } })).toBe(
      hashShotDefinition(shot),
    );
  });

  test("moves when an input moves, including an inherited default", () => {
    expect(hashShotDefinition({ ...shot, open: { file: "b.json" } })).not.toBe(
      hashShotDefinition(shot),
    );
    expect(hashShotDefinition(shot, { defaults: { theme: "dark" } })).not.toBe(
      hashShotDefinition(shot, { defaults: { theme: "light" } }),
    );
    expect(hashShotDefinition(shot, { contract: 1 })).not.toBe(
      hashShotDefinition(shot, { contract: 2 }),
    );
  });

  test("is order-sensitive in arrays — two steps swapped is a different picture", () => {
    const a = { name: "s", steps: [{ cmd: "one" }, { cmd: "two" }] };
    const b = { name: "s", steps: [{ cmd: "two" }, { cmd: "one" }] };
    expect(hashShotDefinition(a)).not.toBe(hashShotDefinition(b));
  });

  test("tolerates a non-object shot", () => {
    expect(hashShotDefinition("nonsense")).toMatch(/^[\da-f]{64}$/);
  });

  test("shotDefinitionHashes covers every named shot and skips the unnamed", () => {
    const hashes = shotDefinitionHashes({
      defaults: { theme: "dark" },
      shots: [{ name: "a" }, { name: "b" }, { nameless: true }, "junk"],
    });
    expect([...hashes.keys()]).toEqual(["a", "b"]);
    expect(hashes.get("a")).not.toBe(hashes.get("b"));
  });

  test("is stable over the committed manifest", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts/screenshots/manifest.json"), "utf8"),
    );
    const first = shotDefinitionHashes(manifest);
    const second = shotDefinitionHashes(manifest);
    expect(first.size).toBeGreaterThan(0);
    expect([...first]).toEqual([...second]);
  });
});

// ─── Manifest reading ─────────────────────────────────────────────────────────

describe("manifest reading", () => {
  test("shotImageNames reads both contract shapes", () => {
    expect([
      ...shotImageNames({
        name: "hero",
        regions: [{ name: "hero-crop" }, { selector: "#x" }],
        variants: [{ suffix: "-dark" }],
      }),
    ]).toEqual(["hero", "hero-crop", "hero-dark"]);
    // `then` replaces `variants` in the §13.2 contract. Parsed rather than written as a literal
    // Because `unicorn/no-thenable` (rightly) refuses a `then` key in object-literal SOURCE — a
    // Manifest is JSON, so the rule never applies to the real thing.
    const contract2: Record<string, unknown> = JSON.parse(
      '{"name":"git","capture":[{"image":"git-panel","of":"navigator/panel:git"}],' +
        '"then":[{"suffix":"-open","capture":[{"image":"git-open"}]}]}',
    );
    expect([...shotImageNames(contract2)]).toEqual(["git", "git-panel", "git-open"]);
  });

  test("readShots keeps names, docs and status, and drops the nameless", () => {
    const shots = readShots({
      shots: [
        { name: "a", docs: ["studio/publish", 7] },
        { name: "b", status: { state: "quarantined", reason: "r", since: "abc" } },
        { unnamed: true },
      ],
    });
    expect(shots.map((shot) => shot.name)).toEqual(["a", "b"]);
    expect(shots[0]!.docs).toEqual(["studio/publish"]);
    expect(shots[1]!.status?.state).toBe("quarantined");
    expect(readShots("junk")).toEqual([]);
  });

  test("manifestImageNames, shotsByDocsPage and quarantinedShots", () => {
    const manifest = {
      shots: [
        { name: "a", docs: ["studio/publish"], regions: [{ name: "a-crop" }] },
        { name: "b", docs: ["studio/publish"] },
        { name: "c", status: { state: "quarantined", reason: "r", since: "s" } },
      ],
    };
    expect([...manifestImageNames(manifest)]).toEqual(["a", "a-crop", "b", "c"]);
    expect(shotsByDocsPage(manifest).get("studio/publish")).toEqual(["a", "b"]);
    expect(quarantinedShots(manifest).map((shot) => shot.name)).toEqual(["c"]);
  });

  test("every committed image is one a committed shot can produce", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts/screenshots/manifest.json"), "utf8"),
    );
    const producible = manifestImageNames(manifest);
    const orphans = readImagesOnDisk()
      .map((image) => image.path.replace(/^.*\//, "").replace(/\.\w+$/, ""))
      .filter((name) => !producible.has(name));
    expect(orphans).toEqual([]);
  });
});

// ─── Docs refs ────────────────────────────────────────────────────────────────

describe("docs image references", () => {
  test("withoutCode and imageTargets ignore quoted syntax", () => {
    expect(withoutCode("a `![](<x.png>)` b")).toBe("a  b");
    const source = '![alt](<./images/a.png> "title")\n```\n![](./images/b.png)\n```';
    expect(imageTargets(source)).toEqual(["./images/a.png"]);
    expect(imageTargets('![](./images/c.png "t")')).toEqual(["./images/c.png"]);
  });

  test("collectDocImageRefs keeps only refs that land in the images directory", () => {
    const root = scratch("docs");
    const docs = join(root, "docs");
    const images = join(docs, "images");
    mkdirSync(join(docs, "studio"), { recursive: true });
    mkdirSync(images, { recursive: true });
    writeFileSync(
      join(docs, "studio", "publish.md"),
      [
        "![](<../images/git-panel.png>)",
        "![](/absolute/nope.png)",
        "![](https://example.com/nope.png)",
        "![](./elsewhere.png)",
      ].join("\n\n"),
    );
    const refs = collectDocImageRefs(docs, images);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.name).toBe("git-panel");
    expect(refs[0]!.page.endsWith("docs/studio/publish.md")).toBe(true);
  });
});

// ─── The lock file ────────────────────────────────────────────────────────────

const RUNTIME: CaptureRuntime = { chromium: "141", fontset: "fc:abc123", os: "ubuntu-24.04" };

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

describe("the lock file", () => {
  test("fromRoot resolves repo-relative and passes absolute through", () => {
    expect(fromRoot("docs")).toBe(join(REPO_ROOT, "docs"));
    expect(fromRoot("/tmp/x")).toBe("/tmp/x");
  });

  test("sha256Hex and shortHash", () => {
    expect(sha256Hex("abc")).toMatch(/^[\da-f]{64}$/);
    expect(shortHash(sha256Hex("abc"))).toHaveLength(8);
  });

  test("serializeLock sorts paths and fixes key order, so a re-capture diffs as values", () => {
    const unsorted = { "docs/images/z.png": entry(), "docs/images/a.png": entry() };
    const text = serializeLock(lockOf(unsorted));
    expect(text.indexOf("a.png")).toBeLessThan(text.indexOf("z.png"));
    expect(text.endsWith("\n")).toBe(true);
    const keys = Object.keys(JSON.parse(text).images["docs/images/a.png"]);
    expect(keys).toEqual([
      "bytes",
      "capturedAt",
      "capturedBy",
      "definition",
      "height",
      "runtime",
      "sha256",
      "shot",
      "width",
    ]);
  });

  test("writeLock / readLock round-trip, and a missing lock reads as null", async () => {
    const dir = scratch("lock");
    const path = join(dir, "capture.lock.json");
    expect(readLock(path)).toBeNull();
    const lock = lockOf({ "docs/images/a.png": entry() });
    await writeLock(lock, path);
    expect(readLock(path)).toEqual(lock);
  });

  test("readLock rejects a file that is not a capture lock", () => {
    const dir = scratch("lock-bad");
    const path = join(dir, "capture.lock.json");
    writeFileSync(path, "[]");
    expect(() => readLock(path)).toThrow(/not a capture lock/);
    writeFileSync(path, '{"images":{},"manifest":7}');
    expect(readLock(path)!.manifest).toBe("scripts/screenshots/manifest.json");
    expect(readLock(path)!.lock).toBe(0);
  });

  test("emptyLock", () => {
    expect(emptyLock("m.json")).toEqual({ images: {}, lock: LOCK_VERSION, manifest: "m.json" });
    expect(emptyLock().manifest).toBe("scripts/screenshots/manifest.json");
  });

  test("describeImage measures the bytes it was handed", () => {
    const bytes = sample(0);
    const image = describeImage(bytes, {
      capturedBy: "screenshots@ci/7",
      definition: "d".repeat(64),
      runtime: RUNTIME,
      shot: "hero",
    });
    expect(image).toMatchObject({ bytes: bytes.length, height: 2, shot: "hero", width: 2 });
    expect(image.sha256).toBe(sha256Hex(bytes));
    expect(image.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("describeImage refuses bytes that are not a PNG", () => {
    expect(() =>
      describeImage(new Uint8Array([1, 2, 3]), {
        capturedBy: "screenshots@local",
        definition: "d",
        runtime: RUNTIME,
        shot: "hero",
      }),
    ).toThrow(/shot "hero" produced bytes that are not a PNG/);
  });

  test("lockedImagePaths", () => {
    const one = lockOf({ "docs/images/a.png": entry() });
    expect([...lockedImagePaths(one)]).toEqual(["docs/images/a.png"]);
    expect([...lockedImagePaths(null)]).toEqual([]);
  });
});

// ─── The runtime triple ───────────────────────────────────────────────────────

describe("the runtime triple", () => {
  test("chromiumMajor", () => {
    expect(chromiumMajor("HeadlessChrome/141.0.7390.54")).toBe("141");
    expect(chromiumMajor("141.0.7390.54")).toBe("141");
    expect(chromiumMajor("who knows")).toBe("unknown");
  });

  test("fontsetId is order- and duplicate-insensitive, and honest when empty", () => {
    expect(fontsetId(["B", "A"])).toBe(fontsetId(["A", "B", "A", " "]));
    expect(fontsetId([])).toBe("unknown");
    expect(fontsetId(["A"])).not.toBe(fontsetId(["B"]));
    expect(fontsetId(["A"])).toMatch(/^fc:[\da-f]{12}$/);
  });

  test("detectOs reads os-release, and falls back when there is none", () => {
    const dir = scratch("os");
    const path = join(dir, "os-release");
    writeFileSync(path, 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n');
    expect(detectOs(path)).toBe("ubuntu-24.04");
    writeFileSync(path, "ID=nixos\n");
    expect(detectOs(path)).toBe("nixos");
    writeFileSync(path, "NAME=nothing\n");
    expect(detectOs(path)).toBe(`${process.platform}-${process.arch}`);
    expect(detectOs(join(dir, "absent"))).toBe(`${process.platform}-${process.arch}`);
  });

  test("captureRuntime and detectFontFamilies produce a complete triple on this host", () => {
    expect(detectFontFamilies()).toBeInstanceOf(Array);
    const runtime = captureRuntime("HeadlessChrome/141.0.0.0");
    expect(runtime.chromium).toBe("141");
    expect(runtime.fontset.length).toBeGreaterThan(0);
    expect(runtime.os.length).toBeGreaterThan(0);
  });

  test("captureOrigin names CI by run id", () => {
    expect(captureOrigin({ GITHUB_RUN_ID: "42" })).toBe("screenshots@ci/42");
    expect(captureOrigin({})).toBe("screenshots@local");
  });
});

// ─── Quarantine ───────────────────────────────────────────────────────────────

describe("quarantine", () => {
  const manifest = {
    shots: [
      { name: "slash-menu-shot", status: { state: "quarantined", reason: "xpath", since: "abc" } },
      { name: "fine" },
    ],
  };

  test("a page that illustrates itself with a quarantined shot is named", () => {
    const findings = quarantineRefFindings(
      manifest,
      [
        { image: "docs/images/slash-menu-shot.png", name: "slash-menu-shot", page: "docs/a.md" },
        { image: "docs/images/fine.png", name: "fine", page: "docs/b.md" },
      ],
      null,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.page).toBe("docs/a.md");
    expect(findings[0]!.message).toContain('quarantined shot "slash-menu-shot" (xpath, since abc)');
  });

  test("images the lock attributes to the shot count too, and a bare status still reports", () => {
    const bare = { shots: [{ name: "s", status: { state: "quarantined" } }] };
    const findings = quarantineRefFindings(
      bare,
      [{ image: "docs/images/crop.png", name: "crop", page: "docs/a.md" }],
      lockOf({ "docs/images/crop.png": entry({ shot: "s" }) }),
    );
    expect(findings[0]!.message).toContain("no reason given");
  });

  test("nothing to say when no page references one", () => {
    expect(quarantineRefFindings(manifest, [], null)).toEqual([]);
  });
});

// ─── checkImageLock ───────────────────────────────────────────────────────────

describe("checkImageLock", () => {
  const manifest = { shots: [{ name: "hero" }] };
  const definition = shotDefinitionHashes(manifest).get("hero")!;
  const disk = [{ bytes: 100, path: "docs/images/hero.png", sha256: "a".repeat(64) }];
  const good = lockOf({ "docs/images/hero.png": entry({ definition }) });

  test("passes when the bytes and the definition both match", () => {
    const result = checkImageLock({ disk, lock: good, manifest });
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result).toMatchObject({ images: 1, shots: 1 });
  });

  test("a missing lock is one violation, not one per image", () => {
    const result = checkImageLock({ disk, lock: null, manifest });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("does not exist");
    expect(checkImageLock({ disk: [], lock: null, manifest: {} }).violations).toEqual([]);
  });

  test("a lock from a future shape is named", () => {
    const result = checkImageLock({ disk, lock: { ...good, lock: 9 }, manifest });
    expect(result.violations[0]).toContain("declares lock 9");
  });

  test("a hand-taken PNG fails", () => {
    const result = checkImageLock({
      disk: [...disk, { bytes: 9, path: "docs/images/pasted.png", sha256: "b".repeat(64) }],
      lock: good,
      manifest,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("docs/images/pasted.png has no entry");
    expect(result.violations[0]).toContain("never hand-taken");
  });

  test("edited bytes fail, naming both hashes", () => {
    const result = checkImageLock({
      disk: [{ bytes: 120, path: "docs/images/hero.png", sha256: "c".repeat(64) }],
      lock: good,
      manifest,
    });
    expect(result.violations[0]).toContain("does not match the lock: cccccccc… on disk");
    expect(result.violations[0]).toContain("aaaaaaaa… locked");
  });

  test("a locked image that is not on disk fails", () => {
    const result = checkImageLock({ disk: [], lock: good, manifest });
    expect(result.violations.some((v) => v.includes("which is not on disk"))).toBe(true);
  });

  test("a shot that changed without a re-capture fails, listing its images", () => {
    const lock = lockOf({
      "docs/images/hero.png": entry({ definition }),
      "docs/images/hero-crop.png": entry({ definition, sha256: "b".repeat(64) }),
    });
    const result = checkImageLock({
      disk: [...disk, { bytes: 100, path: "docs/images/hero-crop.png", sha256: "b".repeat(64) }],
      lock,
      manifest: { shots: [{ name: "hero", open: { view: "preview" } }] },
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("docs/images/hero-crop.png, docs/images/hero.png were");
    expect(result.violations[0]).toContain("re-capture");
  });

  test("a lock entry naming a deleted shot fails", () => {
    const result = checkImageLock({ disk, lock: good, manifest: { shots: [] } });
    expect(result.violations.some((v) => v.includes('names shot "hero", which'))).toBe(true);
  });

  test("a hand-edited entry fails on origin, timestamp, hash and runtime", () => {
    const lock = lockOf({
      "docs/images/hero.png": entry({
        capturedAt: "yesterday",
        capturedBy: "me",
        definition,
        runtime: { chromium: "141", fontset: "", os: "" } as CaptureRuntime,
        sha256: "nope",
      }),
    });
    const result = checkImageLock({
      disk: [{ bytes: 100, path: "docs/images/hero.png", sha256: "nope" }],
      lock,
      manifest,
    });
    const joined = result.violations.join("\n");
    expect(joined).toContain("no valid sha256");
    expect(joined).toContain('capturedBy "me"');
    expect(joined).toContain("not an ISO-8601");
    expect(joined).toContain("incomplete runtime triple");
  });

  test("an uncaptured shot warns, and says so louder when a page already uses it", () => {
    const plain = checkImageLock({ disk: [], lock: emptyLock(), manifest });
    expect(plain.warnings[0]).toContain("has never been captured");
    const used = checkImageLock({
      disk: [],
      lock: emptyLock(),
      manifest,
      refs: [{ image: "docs/images/hero.png", name: "hero", page: "docs/a.md" }],
    });
    expect(used.warnings[0]).toContain("a docs page already references it");
  });

  test("quarantine is reported, its shape is enforced, and it silences the capture warning", () => {
    const result = checkImageLock({
      disk: [],
      lock: emptyLock(),
      manifest: {
        shots: [
          { name: "q", status: { state: "quarantined", reason: "why", since: "abc123" } },
          { name: "half", status: { state: "quarantined", reason: "why" } },
          { name: "wrong", status: { state: "broken" } },
        ],
      },
    });
    expect(result.notes).toContain("quarantined: q — why (since abc123)");
    const joined = result.violations.join("\n");
    expect(joined).toContain("quarantined without a since");
    expect(joined).toContain('declares status.state "broken"');
    expect(result.warnings.map((w) => w.split('"')[1])).toEqual(["wrong"]);
  });

  test("a lock spanning two runtimes says so", () => {
    const lock = lockOf({
      "docs/images/hero.png": entry({ definition }),
      "docs/images/hero-crop.png": entry({
        definition,
        runtime: { chromium: "140", fontset: "fc:zzz", os: "nixos-25.05" },
        sha256: "b".repeat(64),
      }),
    });
    const result = checkImageLock({
      disk: [...disk, { bytes: 100, path: "docs/images/hero-crop.png", sha256: "b".repeat(64) }],
      lock,
      manifest,
    });
    expect(result.notes.some((note) => note.includes("lock spans 2 runtimes"))).toBe(true);
  });
});

// ─── The lane's report ────────────────────────────────────────────────────────

describe("the report", () => {
  const before = lockOf({
    "docs/images/hero.png": entry({ shot: "hero" }),
    "docs/images/gone.png": entry({ shot: "hero", sha256: "e".repeat(64) }),
  });
  const after = lockOf({
    "docs/images/hero.png": entry({ shot: "hero", sha256: "f".repeat(64) }),
    "docs/images/new.png": entry({ shot: "hero", bytes: 2_400_000, sha256: "0".repeat(64) }),
  });

  test("describeChange prefers pixels, then dimensions, then bytes", () => {
    const a = sample(0);
    const b = sample(0, 1);
    expect(
      describeChange({
        after: entry(),
        afterBytes: b,
        before: entry(),
        beforeBytes: a,
        state: "changed",
      }),
    ).toBe("100.00% of pixels");
    expect(describeChange({ after: entry({ width: 4 }), before: entry(), state: "changed" })).toBe(
      "8×4 → 4×4",
    );
    expect(
      describeChange({ after: entry({ bytes: 2_000_000 }), before: entry(), state: "changed" }),
    ).toBe("0 KB → 2.0 MB");
    expect(describeChange({ after: entry(), state: "added" })).toBe("new · 0 KB");
    expect(describeChange({ state: "added" })).toBe("new · ?");
    expect(describeChange({ before: entry(), state: "removed" })).toBe("removed");
    // Undecodable bytes fall back rather than throwing.
    expect(
      describeChange({
        after: entry({ bytes: 1 }),
        afterBytes: new Uint8Array([1]),
        before: entry({ bytes: 2 }),
        beforeBytes: new Uint8Array([2]),
        state: "changed",
      }),
    ).toBe("0 KB → 0 KB");
  });

  test("reportRows skips unchanged images and classifies the rest", () => {
    const rows = reportRows({
      after,
      before,
      refs: [{ image: "docs/images/hero.png", name: "hero", page: "docs/studio/design.md" }],
    });
    expect(rows.map((row) => [row.path, row.state])).toEqual([
      ["docs/images/gone.png", "removed"],
      ["docs/images/hero.png", "changed"],
      ["docs/images/new.png", "added"],
    ]);
    expect(rows[1]!.pages).toEqual(["docs/studio/design.md"]);
    expect(reportRows({ after: before, before, refs: [] })).toEqual([]);
  });

  test("buildReport says nothing changed, and never says a change is a failure", () => {
    const quiet = buildReport({ after: before, before, refs: [] });
    expect(quiet).toContain("No image changed");
    const loud = buildReport({
      after,
      afterSha: "bbb",
      before,
      beforeSha: "aaa",
      refs: [{ image: "docs/images/hero.png", name: "hero", page: "docs/studio/design.md" }],
      repo: "jxsuite/jx",
    });
    expect(loud.startsWith("<!-- jx-screenshots-report -->")).toBe(true);
    expect(loud).toContain("**3 image(s) changed.**");
    expect(loud).toContain("This is **not** a failure");
    expect(loud).toContain("https://github.com/jxsuite/jx/blob/aaa/docs/images/hero.png?raw=true");
    expect(loud).toContain("https://github.com/jxsuite/jx/blob/bbb/docs/images/hero.png?raw=true");
    expect(loud).toContain("docs/studio/design.md");
    expect(loud).toContain("_none_");
  });

  test("without a repo there are no thumbnails, only the facts", () => {
    const report = buildReport({ after, before, refs: [] });
    expect(report).not.toContain("<img");
    expect(report).toContain("| `hero` |");
  });
});

// ─── The CLI ──────────────────────────────────────────────────────────────────

describe("the CLI", () => {
  test("parseArgs takes known flags with values and refuses anything else", () => {
    expect(parseArgs(["--lock", "a.json", "--repo", "o/n"])).toEqual({
      lock: "a.json",
      repo: "o/n",
    });
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--lock"])).toBeNull();
    expect(parseArgs(["--nope", "x"])).toBeNull();
  });

  test("readImagesOnDisk reads images only, and tolerates a missing directory", () => {
    const dir = scratch("images");
    writeFileSync(join(dir, "a.png"), sample(0));
    writeFileSync(join(dir, "notes.txt"), "hello");
    mkdirSync(join(dir, "nested"));
    const images = readImagesOnDisk(dir);
    expect(images.map((image) => image.path)).toEqual([`${dir}/a.png`]);
    const png = sample(0);
    expect(images[0]!.sha256).toBe(sha256Hex(png));
    expect(readImagesOnDisk(join(dir, "absent"))).toEqual([]);
  });

  /** A whole fake repo: a manifest, an images directory, a docs page and a lock. */
  function fixture(options: { definitionOf?: (name: string) => string } = {}) {
    const root = scratch("cli");
    const docs = join(root, "docs");
    const images = join(docs, "images");
    mkdirSync(images, { recursive: true });
    writeFileSync(join(docs, "page.md"), "![](<./images/hero.png>)\n");
    const png = sample(0);
    writeFileSync(join(images, "hero.png"), png);
    const manifest = { defaults: { theme: "dark" }, shots: [{ name: "hero", docs: ["page"] }] };
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const definition =
      options.definitionOf?.("hero") ?? shotDefinitionHashes(manifest).get("hero")!;
    const lockPath = join(root, "capture.lock.json");
    const captured = describeImage(png, {
      capturedAt: "2026-01-15T09:30:00Z",
      capturedBy: "screenshots@local",
      definition,
      runtime: RUNTIME,
      shot: "hero",
    });
    writeFileSync(lockPath, serializeLock(lockOf({ [`${images}/hero.png`]: captured })));
    return { docs, images, lockPath, manifestPath, root };
  }

  test("exits 0 when everything agrees", async () => {
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
  });

  test("exits 1 when a shot definition has moved", async () => {
    const f = fixture({ definitionOf: () => "0".repeat(64) });
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
    expect(code).toBe(1);
  });

  test("exits 2 on an unreadable manifest and on a bad invocation", async () => {
    expect(await main(["--manifest", "/nope/manifest.json"])).toBe(2);
    expect(await main(["--wat"])).toBe(2);
  });

  test("--report writes the markdown the lane comments with", async () => {
    const f = fixture();
    const out = join(f.root, "report.md");
    const code = await main([
      "--manifest",
      f.manifestPath,
      "--lock",
      f.lockPath,
      "--images",
      f.images,
      "--docs",
      f.docs,
      "--report",
      out,
      "--repo",
      "jxsuite/jx",
      "--after-sha",
      "bbb",
    ]);
    expect(code).toBe(0);
    const markdown = readFileSync(out, "utf8");
    expect(markdown).toContain("<!-- jx-screenshots-report -->");
    expect(markdown).toContain("| `hero` |");
  });

  test("--report against the previous lock reports no change", async () => {
    const f = fixture();
    const out = join(f.root, "report.md");
    expect(
      await main([
        "--manifest",
        f.manifestPath,
        "--lock",
        f.lockPath,
        "--images",
        f.images,
        "--docs",
        f.docs,
        "--report",
        out,
        "--before-lock",
        f.lockPath,
        "--before-images",
        f.images,
      ]),
    ).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("No image changed");
  });

  test("the shipped default paths are the ones docs:images:check runs on", () => {
    expect(DEFAULT_LOCK).toBe("scripts/screenshots/capture.lock.json");
  });
});
