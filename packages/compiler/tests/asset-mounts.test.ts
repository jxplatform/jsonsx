/**
 * Asset-mounts.test.ts — host side of the extension `assets` capability (extensions.md §8.5).
 *
 * Mount gathering is driven through real FormatEntry instances backed by in-memory implementation
 * classes, so the gating and conflict rules are exercised exactly as a project's registry would
 * drive them — without depending on any particular extension package.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRegistry, FormatEntry } from "@jxsuite/schema/extension-registry";
import type { FormatHostIO } from "@jxsuite/schema/format-registry";
import type { AssetMount } from "@jxsuite/schema/asset-paths";
import type { ProjectConfig } from "@jxsuite/schema/types";
import { collectAssetRefs, copyMountedAssets, loadAssetMounts } from "../src/site/asset-mounts.ts";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "jx-asset-mounts-"));
});

afterEach(() => {
  rmSync(TMP, { force: true, recursive: true });
});

/**
 * A class entry declaring the `assets` capability, optionally owning a project section.
 *
 * @param {string} name
 * @param {(sectionValue: unknown, ctx: { root: string }) => unknown} impl
 * @param {string} [sectionKey]
 */
function makeAssetEntry(
  name: string,
  impl: (sectionValue: unknown, ctx: { root: string }) => unknown,
  sectionKey?: string,
) {
  const io: FormatHostIO = {
    importModule: () => Promise.resolve({ [name]: { assets: impl } }),
    loadJson: () => Promise.reject(new Error("not used")),
    resolvePath: (_base, ref) => ref,
  };
  const classDef = {
    $defs: { methods: { assets: { identifier: "assets", role: "assets" } } },
    $implementation: "./fake.js",
    title: name,
    ...(sectionKey ? { project: { key: sectionKey } } : {}),
  };
  return new FormatEntry(name, "/virtual/fake.class.json", classDef, io);
}

function makeRegistry(...entries: FormatEntry[]): ExtensionRegistry {
  return new ExtensionRegistry([
    {
      classes: entries,
      manifest: { name: "fixture" },
      manifestPath: "/virtual",
      schemas: {},
      specifier: "fixture",
    },
  ]);
}

describe("loadAssetMounts", () => {
  it("collects mounts from every provider and normalizes prefixes", async () => {
    const registry = makeRegistry(
      makeAssetEntry("Content", () => [{ dir: "/repo/docs", urlPrefix: "content/docs/" }]),
      makeAssetEntry("Other", () => [{ dir: "/repo/media", urlPrefix: "/media" }]),
    );

    const { errors, mounts } = await loadAssetMounts(registry, {} as ProjectConfig, TMP);

    expect(errors).toEqual([]);
    expect(mounts).toEqual([
      { dir: "/repo/docs", urlPrefix: "/content/docs" },
      { dir: "/repo/media", urlPrefix: "/media" },
    ]);
  });

  it("passes the section value and skips a section the project never declares", async () => {
    const seen: unknown[] = [];
    const registry = makeRegistry(
      makeAssetEntry(
        "Content",
        (sectionValue) => {
          seen.push(sectionValue);
          return [{ dir: "/repo/docs", urlPrefix: "/content/docs" }];
        },
        "content",
      ),
    );

    const declared = await loadAssetMounts(
      registry,
      { content: { docs: { source: "../../docs" } } } as unknown as ProjectConfig,
      TMP,
    );
    expect(declared.mounts).toHaveLength(1);
    expect(seen).toEqual([{ docs: { source: "../../docs" } }]);

    const absent = await loadAssetMounts(registry, {} as ProjectConfig, TMP);
    const empty = await loadAssetMounts(registry, { content: {} } as ProjectConfig, TMP);
    expect(absent.mounts).toEqual([]);
    expect(empty.mounts).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("reports a prefix claimed for two different directories, keeping the first", async () => {
    const registry = makeRegistry(
      makeAssetEntry("A", () => [{ dir: "/repo/one", urlPrefix: "/content/docs" }]),
      makeAssetEntry("B", () => [{ dir: "/repo/two", urlPrefix: "/content/docs" }]),
    );

    const { errors, mounts } = await loadAssetMounts(registry, {} as ProjectConfig, TMP);

    expect(mounts).toEqual([{ dir: "/repo/one", urlPrefix: "/content/docs" }]);
    expect(errors[0]).toContain("Asset mount conflict");
  });

  it("tolerates a duplicate mount for the same directory", async () => {
    const registry = makeRegistry(
      makeAssetEntry("A", () => [{ dir: "/repo/one", urlPrefix: "/content/docs" }]),
      makeAssetEntry("B", () => [{ dir: "/repo/one", urlPrefix: "/content/docs" }]),
    );

    const { errors, mounts } = await loadAssetMounts(registry, {} as ProjectConfig, TMP);

    expect(mounts).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("collects a throwing provider as an error instead of failing the build", async () => {
    const registry = makeRegistry(
      makeAssetEntry("Broken", () => {
        throw new Error("no source dir");
      }),
    );

    const { errors, mounts } = await loadAssetMounts(registry, {} as ProjectConfig, TMP);

    expect(mounts).toEqual([]);
    expect(errors[0]).toContain("Broken.assets: no source dir");
  });

  it("ignores malformed and absent mount lists", async () => {
    const registry = makeRegistry(
      makeAssetEntry("Null", () => null),
      makeAssetEntry("Partial", () => [{ dir: "" }, { urlPrefix: "/x" }, null]),
    );

    const { errors, mounts } = await loadAssetMounts(registry, {} as ProjectConfig, TMP);

    expect(mounts).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("collectAssetRefs", () => {
  const mounts: AssetMount[] = [{ dir: "/repo/docs", urlPrefix: "/content/docs" }];

  it("accumulates refs across artifacts", () => {
    const refs = new Set<string>();
    collectAssetRefs(`<img src="/content/docs/a.png">`, mounts, refs);
    collectAssetRefs(`.x{background:url(/content/docs/b.png)}`, mounts, refs);
    collectAssetRefs(`<img src="/content/docs/a.png">`, mounts, refs);

    expect([...refs].toSorted()).toEqual(["/content/docs/a.png", "/content/docs/b.png"]);
  });

  it("is a no-op without mounts or text", () => {
    const refs = new Set<string>();
    collectAssetRefs(`<img src="/content/docs/a.png">`, [], refs);
    collectAssetRefs("", mounts, refs);
    expect(refs.size).toBe(0);
  });
});

describe("copyMountedAssets", () => {
  it("copies referenced files to their URL path under outDir", () => {
    mkdirSync(join(TMP, "src/images"), { recursive: true });
    writeFileSync(join(TMP, "src/images/hero.png"), "png-bytes");
    const mounts: AssetMount[] = [{ dir: join(TMP, "src"), urlPrefix: "/content/docs" }];
    const outDir = join(TMP, "dist");
    mkdirSync(outDir);

    const result = copyMountedAssets(["/content/docs/images/hero.png"], mounts, outDir);

    expect(result).toEqual({ copied: 1, missing: [] });
    expect(readFileSync(join(outDir, "content/docs/images/hero.png"), "utf8")).toBe("png-bytes");
  });

  it("decodes encoded names so the copied file matches the request", () => {
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(join(TMP, "src/my shot.png"), "png-bytes");
    const mounts: AssetMount[] = [{ dir: join(TMP, "src"), urlPrefix: "/content/docs" }];
    const outDir = join(TMP, "dist");
    mkdirSync(outDir);

    const result = copyMountedAssets(["/content/docs/my%20shot.png"], mounts, outDir);

    expect(result.copied).toBe(1);
    expect(existsSync(join(outDir, "content/docs/my shot.png"))).toBe(true);
  });

  it("reports unresolvable, missing, and traversing refs without copying them", () => {
    const mounts: AssetMount[] = [{ dir: join(TMP, "src"), urlPrefix: "/content/docs" }];
    const outDir = join(TMP, "dist");
    mkdirSync(outDir);
    mkdirSync(join(TMP, "src"));
    writeFileSync(join(TMP, "secret.txt"), "secret");

    const traversal = "/content/docs/../../secret.txt";
    const result = copyMountedAssets(
      ["/content/docs/gone.png", "/public/hero.png", traversal],
      mounts,
      outDir,
    );

    expect(result.copied).toBe(0);
    expect(result.missing).toEqual(["/content/docs/gone.png", "/public/hero.png", traversal]);
    expect(existsSync(join(outDir, "secret.txt"))).toBe(false);
    expect(readFileSync(join(TMP, "secret.txt"), "utf8")).toBe("secret");
  });
});
