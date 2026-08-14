/**
 * Site-build-state-retention.test.ts — array state survives to the client when something reads it
 * at runtime (issue #122).
 *
 * An `Array` map expands its items at build time, after which the build stripped the array from
 * state. But a map expansion is one consumer, not the only one: the same array is routinely also
 * read by a computed at runtime. Stripping it left `state.rows` undefined in the browser, so the
 * computed fell through to its guard — silently, and shape-dependently, since the same computed
 * behaved correctly if the array was also referenced somewhere the compiler treated as a runtime
 * read.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSite } from "../src/site/site-build";

const TMP = resolve(import.meta.dir, "__test-state-retention__");

/** @param {string} path @param {unknown} obj */
function writeJSON(path: string, obj: unknown) {
  mkdirSync(resolve(TMP, ...path.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(resolve(TMP, path), JSON.stringify(obj, null, 2), "utf8");
}

const ROWS = [
  { label: "Alpha", v: "a" },
  { label: "Beta", v: "b" },
];

/** The array is expanded into <option>s AND read by `picked` at runtime. */
const OPTION_MAP = {
  $prototype: "Array",
  items: { $ref: "#/state/rows" },
  map: { tagName: "option", textContent: "${$map.item.label}", value: "${$map.item.v}" },
};

beforeAll(async () => {
  rmSync(TMP, { force: true, recursive: true });

  writeJSON("project.json", {
    build: { outDir: "./dist" },
    defaults: { lang: "en", layout: "./layouts/base.json" },
    name: "probe",
  });
  writeJSON("layouts/base.json", { children: [{ tagName: "slot" }], tagName: "probe-base" });

  writeJSON("pages/index.json", {
    children: [
      { children: [OPTION_MAP], tagName: "select" },
      { attributes: { id: "out" }, tagName: "p", textContent: "${state.picked}" },
    ],
    state: {
      // Read only by the build-time map — nothing survives to read it, so it may be stripped.
      decor: ["x", "y"],
      picked: {
        $prototype: "Function",
        body: "var l = state.rows; return (l && l.length) ? l[0].label : 'NO-ROWS';",
      },
      rows: ROWS,
      sel: { default: "a", type: "string" },
    },
    title: "probe",
  });

  // Its own layout, so its island cannot collide with the index page's `probe-base.js`.
  writeJSON("layouts/decor.json", { children: [{ tagName: "slot" }], tagName: "decor-base" });
  writeJSON("pages/decor.json", {
    children: [
      {
        children: [
          { $prototype: "Array", items: { $ref: "#/state/only" }, map: { tagName: "li" } },
        ],
        tagName: "ul",
      },
    ],
    layout: "./layouts/decor.json",
    state: { only: ["x", "y"] },
    title: "decor",
  });

  await buildSite(TMP);
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

const islandOf = (name: string) => readFileSync(resolve(TMP, "dist", name), "utf8");

describe("buildSite — array state read at runtime", () => {
  test("keeps an array a computed still reads in client state", () => {
    const js = islandOf("probe-base.js");

    // `reactive({...})` is the island's client state; `rows` was absent from it entirely.
    expect(js).toMatch(/rows:\s*\[/);
  });

  test("the computed reading it survives as a binding", () => {
    expect(islandOf("probe-base.js")).toContain("state.rows");
  });

  test("still expands the map at build time", () => {
    // The rescue must not turn the static expansion back into a runtime one.
    const js = islandOf("probe-base.js");

    expect(js).toContain("Alpha");
    expect(js).toContain("Beta");
  });

  test("still strips an array nothing reads at runtime", () => {
    // `decor` is consumed by nothing that survives the build, so keeping it would ship dead data —
    // And would flip the page to dynamic on the strength of data no longer referenced.
    expect(islandOf("probe-base.js")).not.toContain("decor");
  });

  test("a page whose only array was expanded away stays fully static", () => {
    // Nothing reads `only` after the map expands it, so the page keeps zero JS.
    const html = readFileSync(resolve(TMP, "dist", "decor", "index.html"), "utf8");

    expect(html).toContain("<li>");
    expect(html).not.toContain("decor-base.js");
    expect(existsSync(resolve(TMP, "dist", "decor-base.js"))).toBe(false);
  });
});
