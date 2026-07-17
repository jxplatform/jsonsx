/**
 * Cli-units-preview-ok.test.ts — jx preview success footprint (default port)
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { previewCalls, runEntry } from "./_cli-harness.ts";

const TMP = resolve(import.meta.dir, "__test-cli-preview__");

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

describe("jx cli — preview", () => {
  it("starts the preview server on dist/ with the default port", async () => {
    rmSync(TMP, { force: true, recursive: true });
    mkdirSync(join(TMP, "dist"), { recursive: true });
    previewCalls.length = 0;
    const result = await runEntry("cli", ["preview", TMP]);
    expect(result.exited).toBe(false);
    expect(previewCalls).toEqual([{ distDir: join(TMP, "dist"), port: 4173 }]);
    expect(result.logs.join("\n")).toContain("Previewing");
    expect(result.logs.join("\n")).toContain(":4173");
  });
});
