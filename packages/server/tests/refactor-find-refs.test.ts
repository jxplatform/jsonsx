/**
 * The usage query: `findReferences` over a real project tree.
 *
 * The interesting assertions are the NEGATIVE ones. A same-named file in another directory is not a
 * usage, a bare npm specifier is not a usage, and a component's own definition file is not a usage
 * of itself — each is a way the count could be inflated into a delete confirmation that lies.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildProjectExtensionRegistry,
  buildProjectFormatRegistry,
} from "@jxsuite/compiler/format-host";
import { findReferences, invalidateReferenceCache } from "../src/refactor/index";
import { countTagUses, walkDocRefs } from "../src/refactor/refs";
import { looksLikeFileRef } from "../src/refactor/paths";
import type { FormatRegistry } from "@jxsuite/schema/format-registry";
import type { ProjectConfig } from "@jxsuite/schema/types";

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

/**
 * The registry the dev-server route actually builds (`getFormatRegistry` in studio-api.ts): the
 * project's own declared extensions, so `.md` and `.csv` are documents the sweep can see.
 *
 * {@link registry} above passes no project config, and a project with no extensions reports ZERO
 * document extensions — a JSON-only `documentGlob`, in which no markdown page is ever opened. That
 * is half of why issue 239 survived this file; use this for anything non-JSON.
 */
async function routeRegistry(): Promise<FormatRegistry> {
  const config = JSON.parse(readFileSync(join(root, "project.json"), "utf8")) as ProjectConfig;
  const extensions = await buildProjectExtensionRegistry(root, config);
  return extensions.formats;
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

/*
 * Everything below is issue 239: the two ways this file's own fixtures could not have caught it.
 *
 * The engine indexed nine named keys, so the commonest media reference in a real project — a
 * schema-typed prop, a frontmatter field, `defaults.layout` — was invisible; and it resolved a
 * rooted `/images/hero.jpg` against the project root alone, so every file under `public/` reported
 * zero. The cases here are one per shape and one per lane, each asserting the exact total, because
 * "greater than zero" is what a count that is wrong in the same direction as the rewrite looks
 * like.
 */

describe("references indexed by shape, not by key name", () => {
  test("a $props value carrying a rooted URL resolves to the file under public/", async () => {
    write("public/images/hero.jpg", "x");
    write("pages/index.json", {
      children: [{ $props: { bg: "/images/hero.jpg" }, tagName: "pv-hero" }],
    });
    const result = await findReferences({
      path: "public/images/hero.jpg",
      registry: await registry(),
      root,
    });
    expect(result.files.map((f) => f.path)).toEqual(["pages/index.json"]);
    expect(result.refsTotal).toBe(1);
    // `path` is the refType for a value matched by shape — no key list ever named `bg`.
    expect(result.files[0]!.refs).toEqual([{ count: 1, ref: "/images/hero.jpg", refType: "path" }]);
  });

  test("a props.image attribute counts, though the key list never named it", async () => {
    write("public/media/card.png", "x");
    write("pages/gallery.json", {
      children: [{ attributes: { "props.image": "/media/card.png" }, tagName: "my-card" }],
    });
    const result = await findReferences({
      path: "public/media/card.png",
      registry: await registry(),
      root,
    });
    expect(result.files.map((f) => f.path)).toEqual(["pages/gallery.json"]);
    expect(result.refsTotal).toBe(1);
    expect(result.files[0]!.refs).toEqual([{ count: 1, ref: "/media/card.png", refType: "path" }]);
  });

  test("a list-valued prop counts each image in it, and only the ones that resolve", async () => {
    /* A gallery prop is an ARRAY of file-shaped strings, which the fallback has to walk element by
       element: recursing into it as a plain object would visit nothing, since a string leaf returns
       immediately. The decoy is the half that matters — an array is not a licence to count
       everything in it, so the same list carries a sibling that names a file which does not exist. */
    write("public/images/a.jpg", "x");
    write("public/images/b.jpg", "x");
    write("pages/gallery.json", {
      children: [
        {
          $props: { shots: ["/images/a.jpg", "/images/b.jpg", "/images/missing.jpg"] },
          tagName: "pv-gallery",
        },
      ],
    });
    const result = await findReferences({
      path: "public/images/a.jpg",
      registry: await registry(),
      root,
    });
    expect(result.files.map((f) => f.path)).toEqual(["pages/gallery.json"]);
    expect(result.files[0]!.refs).toEqual([{ count: 1, ref: "/images/a.jpg", refType: "path" }]);

    const other = await findReferences({
      path: "public/images/b.jpg",
      registry: await registry(),
      root,
    });
    expect(other.refsTotal).toBe(1);
  });

  test("project.json defaults.layout is a reference to the layout it names", async () => {
    write("project.json", { defaults: { layout: "./layouts/base.json" }, name: "p" });
    write("layouts/base.json", { children: [], tagName: "div" });
    const result = await findReferences({
      path: "layouts/base.json",
      registry: await registry(),
      root,
    });
    expect(result.files.map((f) => f.path)).toEqual(["project.json"]);
    expect(result.refsTotal).toBe(1);
    expect(result.files[0]!.refs).toEqual([
      { count: 1, ref: "./layouts/base.json", refType: "path" },
    ]);
  });

  test("a component prop schema default is a reference to the image it seeds", async () => {
    write("public/images/avatar.jpg", "x");
    write("components/author.json", {
      state: { avatar: { default: "/images/avatar.jpg", format: "image", type: "string" } },
      tagName: "bl-author",
    });
    const result = await findReferences({
      path: "public/images/avatar.jpg",
      registry: await registry(),
      root,
    });
    expect(result.files.map((f) => f.path)).toEqual(["components/author.json"]);
    expect(result.refsTotal).toBe(1);
    /* The walk is schema-blind, so `format: "image"` — the schema's own word for what this prop
       holds — decides nothing here. `default` is offered because it is SHAPED like a file, and its
       two siblings are not offered because "string" and "image" carry no extension. */
    expect(result.files[0]!.refs).toEqual([
      { count: 1, ref: "/images/avatar.jpg", refType: "path" },
    ]);
  });

  test("a video poster attribute counts beside the src that was already named", async () => {
    write("public/video/poster.jpg", "x");
    write("public/video/clip.mp4", "x");
    write("pages/watch.json", {
      children: [
        { attributes: { poster: "/video/poster.jpg", src: "/video/clip.mp4" }, tagName: "video" },
      ],
    });
    const reg = await registry();
    const poster = await findReferences({ path: "public/video/poster.jpg", registry: reg, root });
    expect(poster.files.map((f) => f.path)).toEqual(["pages/watch.json"]);
    expect(poster.files[0]!.refs).toEqual([
      { count: 1, ref: "/video/poster.jpg", refType: "path" },
    ]);
    // The two mechanisms on one element: `src` is a named key, `poster` never was.
    const clip = await findReferences({ path: "public/video/clip.mp4", registry: reg, root });
    expect(clip.files[0]!.refs).toEqual([{ count: 1, ref: "/video/clip.mp4", refType: "attr" }]);
  });

  test("a $head meta content naming an image counts", async () => {
    write("public/images/og.png", "x");
    write("pages/index.json", {
      $head: [{ attributes: { content: "/images/og.png", property: "og:image" }, tagName: "meta" }],
      children: [],
    });
    const result = await findReferences({
      path: "public/images/og.png",
      registry: await registry(),
      root,
    });
    expect(result.files.map((f) => f.path)).toEqual(["pages/index.json"]);
    expect(result.refsTotal).toBe(1);
    expect(result.files[0]!.refs).toEqual([{ count: 1, ref: "/images/og.png", refType: "path" }]);
  });

  test("a content entry's frontmatter counts, and the prose below it does not", async () => {
    write("project.json", { extensions: ["@jxsuite/parser"], name: "p" });
    write("public/images/project-1.jpg", "x");
    write(
      "content/projects/one.md",
      "---\ntitle: One\ncover: /images/project-1.jpg\n---\n\nShot at /images/project-1.jpg over two days.\n",
    );
    const result = await findReferences({
      path: "public/images/project-1.jpg",
      registry: await routeRegistry(),
      root,
    });
    // Markdown parses frontmatter to top-level keys and the body to `textContent`, so one document
    // Carries both the reference and the mention — and only the frontmatter is a reference.
    expect(result.files.map((f) => f.path)).toEqual(["content/projects/one.md"]);
    expect(result.refsTotal).toBe(1);
    expect(result.files[0]!.refs).toEqual([
      { count: 1, ref: "/images/project-1.jpg", refType: "path" },
    ]);

    // And the registry the route does NOT use never sweeps the file at all.
    invalidateReferenceCache(root);
    const jsonOnly = await findReferences({
      path: "public/images/project-1.jpg",
      registry: await registry(),
      root,
    });
    expect(jsonOnly.files).toEqual([]);
  });
});

describe("the public/ lane", () => {
  test("a rooted src resolves through public/, which is where the file lives", async () => {
    write("public/bg.png", "x");
    write("pages/index.json", { children: [{ attributes: { src: "/bg.png" }, tagName: "img" }] });
    const result = await findReferences({
      path: "public/bg.png",
      registry: await registry(),
      root,
    });
    expect(result.files.map((f) => f.path)).toEqual(["pages/index.json"]);
    expect(result.refsTotal).toBe(1);
    expect(result.files[0]!.refs).toEqual([{ count: 1, ref: "/bg.png", refType: "attr" }]);
  });

  test("a rooted ref names every lane, and each file that exists reports it", async () => {
    write("bg.png", "x");
    write("public/bg.png", "x");
    write("pages/index.json", { children: [{ attributes: { src: "/bg.png" }, tagName: "img" }] });
    const reg = await registry();

    // `/bg.png` genuinely is ambiguous here — the dev server answers it from the root and a build
    // From public/ — so both are counted. Warning about a reference that turns out to be the other
    // File's is the safe side of a question asked before a delete.
    const rootLane = await findReferences({ path: "bg.png", registry: reg, root });
    expect(rootLane.files.map((f) => f.path)).toEqual(["pages/index.json"]);
    expect(rootLane.refsTotal).toBe(1);

    const publicLane = await findReferences({ path: "public/bg.png", registry: reg, root });
    expect(publicLane.files.map((f) => f.path)).toEqual(["pages/index.json"]);
    expect(publicLane.refsTotal).toBe(1);
  });

  test("an explicitly-passed asset mount resolves a rooted ref through the mount lane", async () => {
    write("content/x.png", "x");
    write("media/logo.svg", "x");
    write("pages/index.json", {
      children: [
        { attributes: { src: "/content/x.png" }, tagName: "img" },
        { attributes: { src: "/brand/logo.svg" }, tagName: "img" },
      ],
    });
    const reg = await registry();
    const mounts = [
      { dir: "content", urlPrefix: "/content" },
      { dir: "media", urlPrefix: "/brand" },
    ];

    const mounted = await findReferences({ mounts, path: "content/x.png", registry: reg, root });
    expect(mounted.files.map((f) => f.path)).toEqual(["pages/index.json"]);
    expect(mounted.refsTotal).toBe(1);

    // `/brand/...` is the case only a mount can answer: no other lane names `media/logo.svg`.
    const branded = await findReferences({ mounts, path: "media/logo.svg", registry: reg, root });
    expect(branded.files.map((f) => f.path)).toEqual(["pages/index.json"]);
    expect(branded.refsTotal).toBe(1);

    // The cache key is (root, path, tag) and carries no mounts, so varying them needs a drop.
    invalidateReferenceCache(root);
    const unmounted = await findReferences({ path: "media/logo.svg", registry: reg, root });
    expect(unmounted.files).toEqual([]);
    expect(unmounted.refsTotal).toBe(0);
  });
});

/**
 * One page whose props are full of file-shaped strings, exactly one of which is a reference.
 *
 * Each test below queries what one of the other spellings WOULD have matched had the shape test let
 * it through — the queried path need not exist, because the engine resolves and compares rather
 * than stats — and then re-asserts the control, since a sweep that read nothing would satisfy every
 * negative on its own.
 */
function seedLookalikes(): void {
  write("public/icon.svg", "x");
  write("public/team photo.jpg", "x");
  write("components/card.json", { children: [], tagName: "my-card" });
  write("pages/index.json", {
    children: [
      {
        $props: {
          caption: "/team photo.jpg",
          cover: "${item.data.cover}",
          icon: "/icon.svg",
          route: "/pricing",
          version: "1.2.3",
        },
        tagName: "pv-badge",
      },
      { tagName: "p", textContent: "../components/card.json" },
      { innerHTML: "../components/card.json", tagName: "code" },
    ],
  });
}

/** The control: the page's one genuine reference, and nothing else on it, is still counted. */
async function expectOneRealRef(reg: FormatRegistry): Promise<void> {
  const icon = await findReferences({ path: "public/icon.svg", registry: reg, root });
  expect(icon.files.map((f) => f.path)).toEqual(["pages/index.json"]);
  expect(icon.refsTotal).toBe(1);
  expect(icon.files[0]!.refs).toEqual([{ count: 1, ref: "/icon.svg", refType: "path" }]);
}

describe("values that look like a file and are not", () => {
  test("a prose key names a file without referencing it", async () => {
    seedLookalikes();
    const reg = await registry();
    const prose = await findReferences({ path: "components/card.json", registry: reg, root });
    // Both spellings resolve exactly onto the component; `textContent` and `innerHTML` are prose,
    // And rewriting a sentence during a rename would be vandalism.
    expect(prose.files).toEqual([]);
    expect(prose.refsTotal).toBe(0);
    await expectOneRealRef(reg);
  });

  test("a value with whitespace is prose, whatever it resolves to", async () => {
    seedLookalikes();
    const reg = await registry();
    // The file really is named `public/team photo.jpg`, so the resolve-and-compare gate would have
    // Matched it. The whitespace test is the only thing between the caption and a false usage.
    const spaced = await findReferences({ path: "public/team photo.jpg", registry: reg, root });
    expect(spaced.files).toEqual([]);
    expect(spaced.refsTotal).toBe(0);
    /* `cover: "${item.data.cover}"` — the spelling every starter's mapped list uses — is refused a
       step earlier, by the `${` test; the exact single-row control below is what says so here, and
       `looksLikeFileRef` is asserted on it directly. */
    await expectOneRealRef(reg);
  });

  test("a version string is not a file, though it is shaped like one", async () => {
    seedLookalikes();
    const reg = await registry();
    // A bare value resolves against the referencing document's directory, so `pages/1.2.3` is the
    // Path this would name. Nothing on disk is consulted — only the letter-in-extension rule.
    const version = await findReferences({ path: "pages/1.2.3", registry: reg, root });
    expect(version.files).toEqual([]);
    expect(version.refsTotal).toBe(0);
    await expectOneRealRef(reg);
  });

  test("a route with no extension is not a file", async () => {
    seedLookalikes();
    const reg = await registry();
    // `/pricing` is a rooted value, so both lanes are candidates: `pricing` and `public/pricing`.
    for (const path of ["pricing", "public/pricing"]) {
      const route = await findReferences({ path, registry: reg, root });
      expect({ path, refsTotal: route.refsTotal }).toEqual({ path, refsTotal: 0 });
    }
    await expectOneRealRef(reg);
  });

  test("a generated schema is not swept, so a project cannot reference its own favicon", async () => {
    write("public/favicon.svg", "x");
    write("pages/index.json", {
      $head: [{ attributes: { href: "/favicon.svg", rel: "icon" }, tagName: "link" }],
      children: [],
    });
    // Both halves of the generated pair carry live `examples` naming the favicon, and neither is a
    // Reference anyone authored.
    write("project.schema.json", { examples: [{ href: "/favicon.svg" }] });
    write("layouts/document.schema.json", { examples: [{ href: "/favicon.svg" }] });

    const result = await findReferences({
      path: "public/favicon.svg",
      registry: await registry(),
      root,
    });
    expect(result.files.map((f) => f.path)).toEqual(["pages/index.json"]);
    expect(result.refsTotal).toBe(1);
  });
});

/*
 * The shape test on its own. Precision is not its job — the resolve-and-compare gate above is —
 * but refusing prose is, and these are the values that decide whether a rename dialog offers to
 * rewrite a sentence, a MIME type or a version number.
 */
const FILE_SHAPED = [
  "/images/hero.jpg",
  "./layouts/base.json",
  "../../docs/nav.json",
  "content/listings.csv",
];

const NOT_FILE_SHAPED = [
  "/pricing",
  "image/png",
  "1.2.3",
  "hello world.json",
  "${state.x}.json",
  "#/state/x",
  "http://a/b.png",
  "npm:pkg/a.json",
  "",
];

describe("looksLikeFileRef", () => {
  test.each(FILE_SHAPED)("%p is file-shaped", (value) => {
    expect(looksLikeFileRef(value)).toBe(true);
  });

  test.each(NOT_FILE_SHAPED)("%p is not file-shaped", (value) => {
    expect(looksLikeFileRef(value)).toBe(false);
  });
});
