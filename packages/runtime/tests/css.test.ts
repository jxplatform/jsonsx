/**
 * `@jxsuite/runtime/css` exists to be importable where the DOM runtime is not.
 *
 * Its behaviour is covered by `runtime.test.ts`, which reaches all six exports through the root
 * re-export. What is asserted here is the property that made it a subpath in the first place, and
 * which no behavioural test can see: that importing it costs nothing. A single `import` added to
 * `css.ts` — a type from `./types.ts`, a helper from `./runtime.ts` — would put the renderer and
 * `@vue/reactivity` back inside every Worker that composes a stylesheet, and every test here would
 * still pass.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import * as css from "../src/css.ts";

const SOURCE = readFileSync(join(import.meta.dirname, "../src/css.ts"), "utf8");

/** The source with comments removed — `localStorage` and the DOM are named in prose throughout. */
const CODE = SOURCE.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");

describe("the module has no dependencies at all", () => {
  test("it imports nothing, from anywhere", () => {
    const imports = [
      ...CODE.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g),
    ].map((m) => m[1]);
    expect({
      imports,
      why: "this subpath exists so a Worker can compose a stylesheet without the DOM runtime",
    }).toEqual({
      imports: [],
      why: "this subpath exists so a Worker can compose a stylesheet without the DOM runtime",
    });
  });

  test("it names no DOM or platform global", () => {
    // Pure string and regex math. A `document` here would throw in workerd rather than degrade.
    for (const global of ["document.", "window.", "navigator.", "localStorage", "process."]) {
      expect({ global, present: CODE.includes(global) }).toEqual({ global, present: false });
    }
  });
});

describe("the subpath carries what @jxsuite/site/site-style needs", () => {
  test("all nine exports are present", () => {
    // A move that dropped one would surface as a build failure three packages away.
    expect(Object.keys(css).toSorted()).toEqual([
      "COLOR_SCHEME_ATTR",
      "COLOR_SCHEME_STORAGE_KEY",
      "camelToKebab",
      "isDeclarationAtRule",
      "pureSchemeOf",
      "resolveAtQuery",
      "resolveNestedSelector",
      "schemeSelectors",
      "transposeCanvasPopoverSelector",
    ]);
  });

  test("the root export still answers for every one of them", async () => {
    /* Moving these must not be a breaking change: the compiler and the studio both import
       camelToKebab from "@jxsuite/runtime", and canvas-media imports pureSchemeOf. */
    const root = (await import("../src/runtime.ts")) as Record<string, unknown>;
    for (const name of Object.keys(css)) {
      expect({ name, same: root[name] === (css as Record<string, unknown>)[name] }).toEqual({
        name,
        same: true,
      });
    }
  });
});
