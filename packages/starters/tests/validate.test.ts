/**
 * Structural validation of every shipped starter: project.json must satisfy the project-config
 * schema, every component/layout/page .json must be a parseable object, and every content .md must
 * carry YAML frontmatter. (Full image-optimizing compilation is covered by CI screenshots — it
 * requires Sharp, which is unavailable on some dev machines.)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseProjectConfig } from "@jxsuite/schema/parse";
import { listStarters, SITES_DIR } from "../index";

const starters = listStarters();

describe("starter sites validate", () => {
  for (const starter of starters) {
    const dir = join(SITES_DIR, starter.id);

    describe(starter.id, () => {
      test("project.json satisfies the project-config schema", () => {
        const path = join(dir, "project.json");
        expect(() => parseProjectConfig(readFileSync(path, "utf8"), path)).not.toThrow();
      });

      test("every component/layout/page .json is a parseable object", () => {
        const glob = new Bun.Glob("{components,layouts,pages}/**/*.json");
        let count = 0;
        for (const rel of glob.scanSync({ cwd: dir })) {
          count += 1;
          const raw = readFileSync(join(dir, rel), "utf8");
          let parsed: unknown;
          expect(() => {
            parsed = JSON.parse(raw);
          }, `${starter.id}/${rel} is not valid JSON`).not.toThrow();
          expect(typeof parsed, `${starter.id}/${rel} is not an object`).toBe("object");
        }
        expect(count, `${starter.id} has no page/component/layout files`).toBeGreaterThan(0);
      });

      test("every content .md carries frontmatter", () => {
        const glob = new Bun.Glob("content/**/*.md");
        for (const rel of glob.scanSync({ cwd: dir })) {
          const raw = readFileSync(join(dir, rel), "utf8");
          expect(raw.startsWith("---"), `${starter.id}/${rel} has no frontmatter`).toBe(true);
        }
      });
    });
  }
});
