/**
 * Cli-units-schema-ok.test.ts — `jx schema` success footprint
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { runEntry, setWriteProjectSchemas, writeProjectSchemasCalls } from "./_cli-harness.ts";

describe("jx cli — schema success", () => {
  it("writes both entry documents and reports their paths", async () => {
    writeProjectSchemasCalls.length = 0;
    setWriteProjectSchemas((root) =>
      Promise.resolve({
        documentSchemaPath: `${root}/document.schema.json`,
        projectSchemaPath: `${root}/project.schema.json`,
      }),
    );
    const result = await runEntry("cli", ["schema", "/tmp/jx-cli-schema-site"]);
    expect(result.exited).toBe(false);
    expect(writeProjectSchemasCalls).toEqual([resolve("/tmp/jx-cli-schema-site")]);
    expect(result.logs.join("\n")).toContain("Wrote project.schema.json");
    expect(result.logs.join("\n")).toContain("Wrote document.schema.json");
  });
});
