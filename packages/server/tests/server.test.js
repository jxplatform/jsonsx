import { describe, test, expect } from "bun:test";
import { resolveNpmPath } from "../src/server.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const TMP = resolve(import.meta.dir, "_server_fixtures");

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  // Unscoped package with module field and exports
  mkdirSync(join(TMP, "node_modules/lit"), { recursive: true });
  writeFileSync(
    join(TMP, "node_modules/lit/package.json"),
    JSON.stringify({
      name: "lit",
      module: "./lit.js",
      exports: { ".": { import: "./lit.js" }, "./html.js": "./html.js" },
    }),
  );
  writeFileSync(join(TMP, "node_modules/lit/lit.js"), "export const html = () => {};");
  writeFileSync(join(TMP, "node_modules/lit/html.js"), "export const html = () => {};");

  // Scoped package
  mkdirSync(join(TMP, "node_modules/@jxsuite/parser"), { recursive: true });
  writeFileSync(
    join(TMP, "node_modules/@jxsuite/parser/package.json"),
    JSON.stringify({
      name: "@jxsuite/parser",
      exports: { ".": { import: "./index.js" }, "./transpile": "./transpile.js" },
    }),
  );
  writeFileSync(join(TMP, "node_modules/@jxsuite/parser/index.js"), "export default {};");
  writeFileSync(
    join(TMP, "node_modules/@jxsuite/parser/transpile.js"),
    "export function transpile() {}",
  );
}

describe("resolveNpmPath", () => {
  setup();

  test("resolves unscoped package entry point", () => {
    const result = resolveNpmPath(TMP, "/lit");
    expect(result).toBe(join(TMP, "node_modules/lit/lit.js"));
  });

  test("resolves unscoped package subpath via exports", () => {
    const result = resolveNpmPath(TMP, "/lit/html.js");
    expect(result).toBe(join(TMP, "node_modules/lit/html.js"));
  });

  test("resolves scoped package entry point", () => {
    const result = resolveNpmPath(TMP, "/@jxsuite/parser");
    expect(result).toBe(join(TMP, "node_modules/@jxsuite/parser/index.js"));
  });

  test("resolves scoped package subpath via exports", () => {
    const result = resolveNpmPath(TMP, "/@jxsuite/parser/transpile");
    expect(result).toBe(join(TMP, "node_modules/@jxsuite/parser/transpile.js"));
  });

  test("returns null for nonexistent package", () => {
    const result = resolveNpmPath(TMP, "/nonexistent-pkg-xyz");
    expect(result).toBeNull();
  });

  test("returns null for incomplete scoped package path", () => {
    const result = resolveNpmPath(TMP, "/@jxsuite");
    expect(result).toBeNull();
  });

  test("handles node_modules in URL path", () => {
    mkdirSync(join(TMP, "sub/node_modules/@jxsuite/parser"), { recursive: true });
    writeFileSync(
      join(TMP, "sub/node_modules/@jxsuite/parser/package.json"),
      JSON.stringify({
        name: "@jxsuite/parser",
        exports: { ".": { import: "./index.js" } },
      }),
    );
    writeFileSync(join(TMP, "sub/node_modules/@jxsuite/parser/index.js"), "export default {};");

    const result = resolveNpmPath(TMP, "/sub/node_modules/@jxsuite/parser");
    expect(result).toBe(join(TMP, "sub/node_modules/@jxsuite/parser/index.js"));
  });

  test("strips leading directory segments for unscoped package", () => {
    // The loop tries each segment — "pages" doesn't exist in node_modules, "lit" does
    const result = resolveNpmPath(TMP, "/pages/lit");
    expect(result).toBe(join(TMP, "node_modules/lit/lit.js"));
  });

  test("returns null when package.json missing", () => {
    mkdirSync(join(TMP, "node_modules/no-pkg"), { recursive: true });
    // No package.json written — existsSync check fails
    const result = resolveNpmPath(TMP, "/no-pkg");
    expect(result).toBeNull();
  });
});

// Cleanup
process.on("exit", () => {
  try {
    rmSync(TMP, { recursive: true });
  } catch {}
});
