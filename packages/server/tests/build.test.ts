import { describe, expect, test } from "bun:test";
import { buildAll, rebuild } from "../src/build";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "_fixtures_build");
const OUTDIR = join(FIXTURES, "dist");

function setup() {
  mkdirSync(FIXTURES, { recursive: true });
  mkdirSync(OUTDIR, { recursive: true });
}

function cleanup() {
  rmSync(FIXTURES, { force: true, recursive: true });
}

// ─── buildAll ──────────────────────────────────────────────────────────────

describe("buildAll", () => {
  test("builds entrypoints to output directory", async () => {
    setup();
    try {
      const entryFile = join(FIXTURES, "entry.js");
      Bun.write(entryFile, "export const x = 42;");

      await buildAll([{ entrypoints: [entryFile], label: "test", outdir: OUTDIR }]);
      const files = new Bun.Glob("*.js").scanSync({ cwd: OUTDIR });
      const fileList = [...files];
      expect(fileList.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("handles multiple build entries", async () => {
    setup();
    try {
      const entry1 = join(FIXTURES, "a.js");
      const entry2 = join(FIXTURES, "b.js");
      const out1 = join(FIXTURES, "dist1");
      const out2 = join(FIXTURES, "dist2");
      mkdirSync(out1, { recursive: true });
      mkdirSync(out2, { recursive: true });

      Bun.write(entry1, "export const a = 1;");
      Bun.write(entry2, "export const b = 2;");

      await buildAll([
        { entrypoints: [entry1], label: "a", outdir: out1 },
        { entrypoints: [entry2], label: "b", outdir: out2 },
      ]);

      expect([...new Bun.Glob("*.js").scanSync({ cwd: out1 })].length).toBeGreaterThan(0);
      expect([...new Bun.Glob("*.js").scanSync({ cwd: out2 })].length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

// ─── rebuild ───────────────────────────────────────────────────────────────

describe("rebuild", () => {
  test("skips entries without match", async () => {
    const result = await rebuild([{ entrypoints: ["x.js"], outdir: "/tmp" }], "changed.js");
    expect(result.rebuilt).toEqual([]);
    expect(result.success).toBe(true);
  });

  test("skips entries where match does not match filename", async () => {
    const builds = [{ entrypoints: ["x.js"], match: /\.css$/, outdir: "/tmp" }];
    const result = await rebuild(builds, "file.js");
    expect(result.rebuilt).toEqual([]);
    expect(result.success).toBe(true);
  });

  test("rebuilds when match function returns true", async () => {
    setup();
    try {
      const entryFile = join(FIXTURES, "entry.js");
      Bun.write(entryFile, "export const y = 99;");

      const builds = [
        {
          entrypoints: [entryFile],
          label: "matched",
          match: () => true,
          outdir: OUTDIR,
        },
      ];
      const result = await rebuild(builds, "something.js");
      expect(result.rebuilt).toContain("matched");
      expect(result.success).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("rebuilds when regex matches the changed file", async () => {
    setup();
    try {
      const entryFile = join(FIXTURES, "main.js");
      Bun.write(entryFile, "export const z = 0;");

      const builds = [
        {
          entrypoints: [entryFile],
          label: "js-rebuild",
          match: /\.js$/,
          outdir: OUTDIR,
        },
      ];
      const result = await rebuild(builds, "src/util.js");
      expect(result.rebuilt).toContain("js-rebuild");
      expect(result.success).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("uses outdir as label when label not provided", async () => {
    setup();
    try {
      const entryFile = join(FIXTURES, "entry.js");
      Bun.write(entryFile, "export const w = 1;");

      const builds = [{ entrypoints: [entryFile], match: () => true, outdir: OUTDIR }];
      const result = await rebuild(builds, "x.js");
      expect(result.rebuilt).toContain(OUTDIR);
    } finally {
      cleanup();
    }
  });

  test("reports failure and empty rebuilt when Bun.build returns a failed result", async () => {
    // Bun.build throws for parse errors in this runtime, so stub it to return
    // A failed BuildResult, which exercises lines 61-62 of rebuild().
    const originalBuild = Bun.build;
    // @ts-expect-error — intentional stub
    Bun.build = async () => ({ logs: ["stub: build failed"], success: false });
    try {
      const builds = [
        {
          entrypoints: ["x.js"],
          label: "failing-build",
          match: /\.js$/,
          outdir: "/tmp/stub-out",
        },
      ];
      const result = await rebuild(builds, "x.js");
      expect(result.success).toBe(false);
      expect(result.rebuilt).toEqual([]);
    } finally {
      Bun.build = originalBuild;
    }
  });
});
