/**
 * Composed-schema validation of every shipped starter: each project.json must validate against its
 * committed, generated project.schema.json (written by `jx schema`). In-repo starters may lack
 * their own node_modules — validateProjectFile's host-resolution fallback keeps the relative
 * `./node_modules/...` refs resolvable either way.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { validateProjectFile } from "@jxsuite/schema/validate-project";
import { listStarters, SITES_DIR } from "../index";

const starters = listStarters();

describe("starter project.json files validate against their generated schemas", () => {
  for (const starter of starters) {
    test(starter.id, async () => {
      const result = await validateProjectFile(join(SITES_DIR, starter.id));
      expect(result.errors, `${starter.id} project.json is invalid`).toBeNull();
      expect(result.valid).toBe(true);
    });
  }
});
