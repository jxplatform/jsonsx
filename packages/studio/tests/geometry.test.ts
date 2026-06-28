import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { elementAtPoint, elementsAtPoint, rectOf, rectOfRange } from "../src/utils/geometry";

describe("geometry funnel helpers", () => {
  test("rectOf returns the element's bounding rect", () => {
    const el = document.createElement("div");
    const fake = { height: 4, left: 1, top: 2, width: 3 } as DOMRect;
    el.getBoundingClientRect = () => fake;
    expect(rectOf(el)).toBe(fake);
  });

  test("elementAtPoint delegates to the root's elementFromPoint", () => {
    const marker = document.createElement("span");
    const root = { elementFromPoint: () => marker } as unknown as Document;
    expect(elementAtPoint(10, 20, root)).toBe(marker);
  });

  test("elementsAtPoint delegates to the root's elementsFromPoint", () => {
    const marker = document.createElement("span");
    const root = { elementsFromPoint: () => [marker] } as unknown as Document;
    expect(elementsAtPoint(10, 20, root)).toEqual([marker]);
  });

  test("rectOfRange returns a rect with the DOMRect shape", () => {
    // Happy-dom returns a zero rect for ranges, so assert the SHAPE (keys) — not non-zero values.
    const el = document.createElement("p");
    el.textContent = "hello";
    document.body.append(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = rectOfRange(range);
    expect(rect).toHaveProperty("x");
    expect(rect).toHaveProperty("y");
    expect(rect).toHaveProperty("width");
    expect(rect).toHaveProperty("height");
    el.remove();
  });

  test("rectOfRange delegates to the range's getBoundingClientRect", () => {
    const fake = { height: 9, width: 8, x: 6, y: 7 } as DOMRect;
    const range = { getBoundingClientRect: () => fake } as unknown as Range;
    expect(rectOfRange(range)).toBe(fake);
  });
});

describe("geometry funnel invariant (regression guard)", () => {
  test("no raw getBoundingClientRect/elementFromPoint/elementsFromPoint outside the funnel", () => {
    const srcDir = join(import.meta.dir, "..", "src");
    const forbidden = /\.(getBoundingClientRect|elementFromPoint|elementsFromPoint)\(/;
    const offenders: string[] = [];
    for (const rel of new Bun.Glob("**/*.ts").scanSync({ cwd: srcDir, dot: false })) {
      const posix = rel.replaceAll("\\", "/");
      if (posix === "utils/geometry.ts") {
        continue; // The funnel itself is the one allowed home for these DOM reads.
      }
      const lines = readFileSync(join(srcDir, rel), "utf8").split("\n");
      for (const [i, line] of lines.entries()) {
        if (forbidden.test(line)) {
          offenders.push(`${posix}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
