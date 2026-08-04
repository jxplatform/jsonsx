/**
 * The usage query: `findReferences` over a real project tree.
 *
 * The interesting assertions are the NEGATIVE ones. A same-named file in another directory is not a
 * usage, a bare npm specifier is not a usage, and a component's own definition file is not a usage
 * of itself — each is a way the count could be inflated into a delete confirmation that lies.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProjectFormatRegistry } from "@jxsuite/compiler/format-host";
import { findReferences, invalidateReferenceCache } from "../src/refactor/index";
import { countTagUses, walkDocRefs } from "../src/refactor/refs";
import type { FormatRegistry } from "@jxsuite/schema/format-registry";

let root = "";
const tmpRoots: string[] = [];

function write(rel: string, content: unknown): void {
  const fp = join(root, rel);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, typeof content === "string" ? content : JSON.stringify(content));
}

async function registry(): Promise<FormatRegistry> {
  return buildProjectFormatRegistry(root);
}

/** The standard fixture: one component, referenced as a file and as a tag from several places. */
function seedProject(): void {
  write("components/card.json", { children: [{ tagName: "span" }], tagName: "my-card" });
  write("pages/index.json", {
    $layout: "layouts/base.json",
    children: [{ $ref: "../components/card.json" }, { tagName: "my-card" }],
  });
  write("pages/about.json", { children: [{ tagName: "my-card" }, { tagName: "my-card" }] });
  write("layouts/base.json", { $elements: ["../components/card.json"], children: [] });
  // A same-named file in a different directory — resolve-and-compare must not match it.
  write("vendor/card.json", { children: [{ $ref: "./card.json" }] });
  write("pages/unrelated.json", { children: [{ $ref: "npm-package/thing.json" }] });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jx-findrefs-"));
  tmpRoots.push(root);
  invalidateReferenceCache();
});

afterAll(() => {
  invalidateReferenceCache();
  for (const dir of tmpRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("findReferences", () => {
  test("counts file references and tag instances together, and skips the definition itself", async () => {
    seedProject();
    const result = await findReferences({
      path: "components/card.json",
      registry: await registry(),
      root,
    });

    expect(result.tagName).toBe("my-card");
    expect(result.files.map((f) => f.path)).toEqual([
      "layouts/base.json",
      "pages/about.json",
      "pages/index.json",
    ]);
    // The definition file never appears, so an unused component reports 0 rather than 1.
    expect(result.files.some((f) => f.path === "components/card.json")).toBe(false);
    // A same-named file elsewhere, and a bare npm specifier, are not usages.
    expect(result.files.some((f) => f.path.startsWith("vendor/"))).toBe(false);
    expect(result.files.some((f) => f.path === "pages/unrelated.json")).toBe(false);

    const about = result.files.find((f) => f.path === "pages/about.json")!;
    expect(about.count).toBe(2);
    expect(about.refs).toEqual([{ count: 2, ref: "<my-card>", refType: "tagName" }]);

    const index = result.files.find((f) => f.path === "pages/index.json")!;
    expect(index.count).toBe(2);
    expect(index.refs).toContainEqual({
      count: 1,
      ref: "../components/card.json",
      refType: "$ref",
    });

    expect(result.filesReferencing).toBe(3);
    expect(result.refsTotal).toBe(5);
    expect(result.errors).toEqual([]);
  });

  test("a tag-only query counts instances and ignores file references", async () => {
    seedProject();
    const result = await findReferences({ registry: await registry(), root, tagName: "my-card" });
    expect(result.path).toBeNull();
    expect(result.tagName).toBe("my-card");
    // The definition file DOES carry the tag on its root node, and with no path to exclude it is
    // Reported — a tag-only query is asking about the tag, not about a file.
    expect(result.files.map((f) => f.path)).toEqual([
      "components/card.json",
      "pages/about.json",
      "pages/index.json",
    ]);
    expect(result.refsTotal).toBe(4);
  });

  test("a directory target matches every reference resolving underneath it", async () => {
    seedProject();
    const result = await findReferences({
      path: "components",
      registry: await registry(),
      root,
    });
    expect(result.files.map((f) => f.path)).toEqual(["layouts/base.json", "pages/index.json"]);
    // No tag is derived from a directory, so the instance nodes do not count here.
    expect(result.tagName).toBeNull();
  });

  test("an unused file reports zero, with no files and no errors", async () => {
    seedProject();
    write("components/orphan.json", { children: [], tagName: "my-orphan" });
    const result = await findReferences({
      path: "components/orphan.json",
      registry: await registry(),
      root,
    });
    expect(result.files).toEqual([]);
    expect(result.filesReferencing).toBe(0);
    expect(result.refsTotal).toBe(0);
  });

  test("a query with neither path nor tag answers empty rather than scanning", async () => {
    seedProject();
    const result = await findReferences({ registry: await registry(), root });
    expect(result).toEqual({
      errors: [],
      files: [],
      filesReferencing: 0,
      path: null,
      refsTotal: 0,
      tagName: null,
    });
  });

  test("an unparseable document is reported, not swallowed — the count becomes a floor", async () => {
    seedProject();
    write("pages/broken.json", "{ not valid json ");
    const result = await findReferences({
      path: "components/card.json",
      registry: await registry(),
      root,
    });
    expect(result.errors.map((e) => e.path)).toEqual(["pages/broken.json"]);
    expect(result.filesReferencing).toBe(3);
  });

  test("$layout and url() references resolve against the right base", async () => {
    write("layouts/base.json", { children: [], tagName: "div" });
    write("pages/index.json", { $layout: "layouts/base.json", children: [] });
    write("public/bg.png", "x");
    write("pages/styled.json", {
      children: [],
      style: { background: "url('../public/bg.png')" },
    });

    const reg = await registry();
    const layout = await findReferences({ path: "layouts/base.json", registry: reg, root });
    // A BARE $layout value resolves against the project root, not the page's directory.
    expect(layout.files.map((f) => f.path)).toEqual(["pages/index.json"]);

    const asset = await findReferences({ path: "public/bg.png", registry: reg, root });
    expect(asset.files.map((f) => f.path)).toEqual(["pages/styled.json"]);
    expect(asset.files[0]!.refs[0]!.refType).toBe("url");
  });

  test("node_modules and dist are never scanned", async () => {
    seedProject();
    write("node_modules/pkg/page.json", { children: [{ tagName: "my-card" }] });
    write("dist/page.json", { children: [{ tagName: "my-card" }] });
    const result = await findReferences({ registry: await registry(), root, tagName: "my-card" });
    expect(result.files.some((f) => f.path.includes("node_modules"))).toBe(false);
    expect(result.files.some((f) => f.path.startsWith("dist/"))).toBe(false);
  });
});

describe("the cache", () => {
  test("a repeated query is one sweep, and concurrent askers share it", async () => {
    seedProject();
    const reg = await registry();
    const query = { path: "components/card.json", registry: reg, root };

    const [a, b] = await Promise.all([findReferences(query), findReferences(query)]);
    expect(a).toBe(b);

    const c = await findReferences(query);
    expect(c).toBe(a);

    // The answer is now stale on disk, and stays stale until something says so — which is the
    // Contract: no TTL, invalidation only.
    write("pages/late.json", { children: [{ tagName: "my-card" }] });
    const stale = await findReferences(query);
    expect(stale.filesReferencing).toBe(3);

    invalidateReferenceCache(root);
    const fresh = await findReferences(query);
    expect(fresh.filesReferencing).toBe(4);
  });

  test("invalidation is per-root, and the argument-less form clears everything", async () => {
    seedProject();
    const reg = await registry();
    const query = { path: "components/card.json", registry: reg, root };
    const first = await findReferences(query);

    invalidateReferenceCache("/some/other/project");
    expect(await findReferences(query)).toBe(first);

    invalidateReferenceCache();
    expect(await findReferences(query)).not.toBe(first);
  });

  test("a failed sweep is not remembered as the answer", async () => {
    seedProject();
    const broken = {
      byExtension: () => null,
      documentExtensions: () => {
        throw new Error("registry exploded");
      },
    } as unknown as FormatRegistry;
    const query = { path: "components/card.json", registry: broken, root };
    expect(findReferences(query)).rejects.toThrow("registry exploded");
    // The rejection was dropped from the cache, so a healthy retry is not poisoned by it.
    const healthy = await findReferences({
      path: "components/card.json",
      registry: await registry(),
      root,
    });
    expect(healthy.filesReferencing).toBe(3);
  });
});

describe("the shared walk", () => {
  test("walkDocRefs writes back exactly what the visitor returns", () => {
    const doc = {
      $layout: "layouts/base.json",
      children: [{ $ref: "./a.json", src: "./img.png" }],
      $elements: ["./b.json", { $ref: "./c.json" }],
      imports: { Card: "./Card.js" },
      style: { background: "url(./bg.png)" },
    };
    const seen: [string, string, boolean][] = [];
    walkDocRefs(doc, (value, refType, rootRelativeBare) => {
      seen.push([value, refType, rootRelativeBare]);
      return refType === "$ref" ? "REWRITTEN" : null;
    });

    expect(seen).toContainEqual(["layouts/base.json", "$layout", true]);
    expect(seen).toContainEqual(["./img.png", "attr", false]);
    expect(seen).toContainEqual(["./b.json", "$elements", false]);
    expect(seen).toContainEqual(["./Card.js", "imports", false]);
    expect(seen).toContainEqual(["./bg.png", "url", false]);
    // Only the visitor's non-null returns land in the document.
    expect(doc.children[0]!.$ref).toBe("REWRITTEN");
    expect(doc.children[0]!.src).toBe("./img.png");
    expect(doc.$layout).toBe("layouts/base.json");
  });

  test("countTagUses counts without mutating", () => {
    const doc = { children: [{ tagName: "my-card" }, { tagName: "my-card" }], tagName: "page" };
    expect(countTagUses(doc, "my-card")).toBe(2);
    expect(countTagUses(doc, "nope")).toBe(0);
    expect(doc.children[0]!.tagName).toBe("my-card");
  });
});
