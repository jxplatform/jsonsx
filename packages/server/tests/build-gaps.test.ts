import { describe, expect, test } from "bun:test";
import { buildAll } from "../src/build";

describe("buildAll — failure logging", () => {
  test("logs errors and continues when a build fails", async () => {
    const originalBuild = Bun.build;
    const originalError = console.error;
    const logged: unknown[] = [];
    // @ts-expect-error — intentional stub returning a failed BuildResult
    Bun.build = async () => ({ logs: ["stub: buildAll failed"], success: false });
    console.error = (...args: unknown[]) => {
      logged.push(...args);
    };
    try {
      await buildAll([{ entrypoints: ["x.js"], label: "fails", outdir: "/tmp/none" }]);
      expect(logged).toContain("stub: buildAll failed");
    } finally {
      Bun.build = originalBuild;
      console.error = originalError;
    }
  });
});
