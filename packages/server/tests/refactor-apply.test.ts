import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProjectFormatRegistry } from "@jxsuite/compiler/format-host";
import { applyRename, deriveTag } from "../src/refactor/index";
import type { AssetMount } from "@jxsuite/schema/asset-paths";
import type { ProjectConfig } from "@jxsuite/schema/types";

let root = "";
const tmpRoots: string[] = [];

function write(rel: string, content: string): void {
  const fp = join(root, rel);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, content);
}

const read = (rel: string) => readFileSync(join(root, rel), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jx-refactor-"));
  tmpRoots.push(root);
});

afterAll(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("deriveTag", () => {
  test.each([
    ["/p/my-counter.json", "my-counter"],
    ["/p/my-counter.class.json", "my-counter"],
    ["/p/widget.md", "widget"],
  ])("%s -> %s", (input, out) => {
    expect(deriveTag(input)).toBe(out);
  });
});

describe("applyRename", () => {
  test("component rename rewrites path refs, auto-renames the tag, and reports errors", async () => {
    write(
      "pages/index.json",
      JSON.stringify({
        $layout: "layouts/base.json",
        children: [{ $ref: "../components/counter.json" }],
      }),
    );
    write("pages/about.json", JSON.stringify({ children: [{ tagName: "my-counter" }] }));
    write(
      "components/counter.json",
      JSON.stringify({ children: [{ tagName: "span" }], tagName: "my-counter" }),
    );
    write("broken.json", "{ not valid json ");

    renameSync(join(root, "components/counter.json"), join(root, "components/my-button.json"));
    const registry = await buildProjectFormatRegistry(root);
    const report = await applyRename({
      absFrom: join(root, "components/counter.json"),
      absTo: join(root, "components/my-button.json"),
      registry,
      root,
    });

    // Path reference updated.
    expect(JSON.parse(read("pages/index.json")).children[0]).toEqual({
      $ref: "../components/my-button.json",
    });
    expect(JSON.parse(read("pages/index.json")).$layout).toBe("layouts/base.json");
    // Tag renamed in the instance and in the component's own definition.
    expect(JSON.parse(read("pages/about.json")).children[0].tagName).toBe("my-button");
    expect(JSON.parse(read("components/my-button.json")).tagName).toBe("my-button");

    expect(report.references.refsUpdated).toBe(1);
    expect(report.tag).toMatchObject({ from: "my-counter", refsUpdated: 2, to: "my-button" });
    expect(report.errors.map((e) => e.path)).toContain("broken.json");
    expect(report.isDir).toBe(false);
  });

  test("page rename updates references without a tag pass", async () => {
    write("pages/home.json", JSON.stringify({ children: [{ $ref: "./detail.json" }] }));
    write("pages/detail.json", JSON.stringify({ children: [] }));

    renameSync(join(root, "pages/detail.json"), join(root, "pages/info.json"));
    const registry = await buildProjectFormatRegistry(root);
    const report = await applyRename({
      absFrom: join(root, "pages/detail.json"),
      absTo: join(root, "pages/info.json"),
      registry,
      root,
    });

    expect(JSON.parse(read("pages/home.json")).children[0]).toEqual({ $ref: "./info.json" });
    expect(report.references.refsUpdated).toBe(1);
    expect(report.tag).toBeUndefined();
  });

  test("rewrites asset references inside content-format files via the registry", async () => {
    // Use a tests/-local root so the throwaway format implementation (.js) is excluded from coverage.
    root = join(import.meta.dir, "_refactor_content_fix");
    rmSync(root, { force: true, recursive: true });
    tmpRoots.push(root);
    write(
      "toy-ext/jx-extension.json",
      JSON.stringify({ classes: { Toy: "./Toy.class.json" }, name: "toy-ext" }),
    );
    write(
      "toy-ext/Toy.class.json",
      JSON.stringify({
        $defs: {
          methods: {
            parse: {
              $prototype: "Function",
              identifier: "parse",
              parameters: [{ identifier: "source", type: { type: "string" } }],
              role: "parse",
              scope: "static",
              timing: ["compiler", "server", "client"],
            },
            serialize: {
              $prototype: "Function",
              identifier: "serialize",
              parameters: [{ identifier: "doc", type: { type: "object" } }],
              role: "serialize",
              scope: "static",
              timing: ["compiler", "server", "client"],
            },
          },
        },
        $implementation: "./toy-impl.js",
        $prototype: "Class",
        extends: "Object",
        format: { documentKinds: ["content"], extensions: [".toy"] },
        title: "Toy",
      }),
    );
    write(
      "toy-ext/toy-impl.js",
      [
        "export class Toy {",
        "  static parse(source) { return { children: [{ src: source.trim(), tagName: 'img' }] }; }",
        "  static serialize(doc) { return doc.children[0].src; }",
        "}",
        "",
      ].join("\n"),
    );
    write("img/old.png", "binary");
    write("content/banner.toy", "../img/old.png");

    const config = { extensions: ["./toy-ext"] } as ProjectConfig;
    renameSync(join(root, "img/old.png"), join(root, "img/new.png"));
    const registry = await buildProjectFormatRegistry(root, config);
    const report = await applyRename({
      absFrom: join(root, "img/old.png"),
      absTo: join(root, "img/new.png"),
      registry,
      root,
    });

    expect(read("content/banner.toy")).toBe("../img/new.png");
    expect(report.references.files.some((f) => f.path === "content/banner.toy")).toBe(true);
  });

  test("a missing rename target is reported as a plain file rename", async () => {
    const registry = await buildProjectFormatRegistry(root);
    const report = await applyRename({
      absFrom: join(root, "ghost-old.json"),
      absTo: join(root, "ghost-new.json"),
      registry,
      root,
    });
    expect(report.isDir).toBe(false);
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  test("skips the tag rename when the new name is not a valid custom-element name", async () => {
    write("my-counter.json", JSON.stringify({ children: [], tagName: "my-counter" }));
    write("pages/index.json", JSON.stringify({ children: [{ tagName: "my-counter" }] }));

    renameSync(join(root, "my-counter.json"), join(root, "button.json"));
    const registry = await buildProjectFormatRegistry(root);
    const report = await applyRename({
      absFrom: join(root, "my-counter.json"),
      absTo: join(root, "button.json"),
      registry,
      root,
    });

    expect(report.tagSkipped).toContain("not a valid custom-element name");
    expect(report.tag).toBeUndefined();
    // The instance keeps its original tag — no rename happened.
    expect(JSON.parse(read("pages/index.json")).children[0].tagName).toBe("my-counter");
  });

  test("reports files whose format can parse but not serialize", async () => {
    const parseOnlyRegistry = {
      byExtension: (_ext: string, capability: string) =>
        capability === "parse"
          ? { call: (_op: string, raw: unknown) => Promise.resolve(JSON.parse(String(raw))) }
          : null,
      documentExtensions: () => [".toy"],
    } as unknown as Parameters<typeof applyRename>[0]["registry"];

    write("old.json", "{}");
    write("content/card.toy", JSON.stringify({ $ref: "../old.json" }));
    renameSync(join(root, "old.json"), join(root, "new.json"));

    const report = await applyRename({
      absFrom: join(root, "old.json"),
      absTo: join(root, "new.json"),
      registry: parseOnlyRegistry,
      root,
    });

    const failure = report.errors.find((e) => e.path === "content/card.toy");
    expect(failure?.error).toContain("No serializer");
    // The unserializable file is left untouched on disk.
    expect(read("content/card.toy")).toBe(JSON.stringify({ $ref: "../old.json" }));
  });
});

/** Perform the filesystem move `applyRename` requires of its caller, then rewrite the project. */
async function move(from: string, to: string, mounts?: readonly AssetMount[]) {
  mkdirSync(join(root, to, ".."), { recursive: true });
  renameSync(join(root, from), join(root, to));
  const registry = await buildProjectFormatRegistry(root);
  return applyRename({
    absFrom: join(root, from),
    absTo: join(root, to),
    registry,
    root,
    ...(mounts ? { mounts } : {}),
  });
}

/** The bytes `loadDoc`'s JSON serializer writes for `doc` (two-space, no trailing newline). */
const serialized = (doc: unknown) => JSON.stringify(doc, null, 2);

/*
 * Issue 239, on the write side and asserted on the bytes.
 *
 * A rooted reference is a SITE URL, not a project path: `public/` publishes at the site root, so
 * `/images/hero.jpg` names `public/images/hero.jpg` and resolving it against the project root alone
 * matched nothing. These assert the rewritten TEXT rather than `refsUpdated`, because the count and
 * the rewrite shared the resolver and were therefore wrong in the same direction — a report
 * agreeing with itself is the one thing that failure mode guarantees.
 */
describe("applyRename — rooted references through the asset lanes", () => {
  test("a rename inside public/ re-emits the URL a build publishes", async () => {
    write("public/images/hero.jpg", "binary");
    write(
      "pages/index.json",
      JSON.stringify({ children: [{ src: "/images/hero.jpg", tagName: "img" }] }),
    );

    const report = await move("public/images/hero.jpg", "public/images/hero-2.jpg");

    /* The single most important byte in this file is the absent `public/`. `/public/images/...`
       is a URL the dev server answers and a deployed site 404s, so it is not a cosmetic
       difference — it is the rename silently breaking the page it promised to fix. */
    expect(read("pages/index.json")).toBe(
      serialized({ children: [{ src: "/images/hero-2.jpg", tagName: "img" }] }),
    );
    expect(report.references.refsUpdated).toBe(1);
  });

  test("a file leaving public/ falls back to the root lane", async () => {
    write("public/hero.jpg", "binary");
    write("pages/index.json", JSON.stringify({ children: [{ src: "/hero.jpg", tagName: "img" }] }));

    const report = await move("public/hero.jpg", "images/hero.jpg");

    /* Nothing publishes `<root>/images/hero.jpg` on a built site, so this reference is now
       build-broken — but it was build-broken the moment the file left `public/`, and the root lane
       at least keeps the preview working. The alternative is a URL pointing at a file that moved. */
    expect(read("pages/index.json")).toBe(
      serialized({ children: [{ src: "/images/hero.jpg", tagName: "img" }] }),
    );
    expect(report.references.refsUpdated).toBe(1);
  });

  test("a file entering public/ keeps the URL it already had", async () => {
    write("images/hero.jpg", "binary");
    const before = JSON.stringify({ children: [{ src: "/images/hero.jpg", tagName: "img" }] });
    write("pages/index.json", before);

    const report = await move("images/hero.jpg", "public/images/hero.jpg");

    /* Read through the root lane, re-emitted through the public lane, same URL — so the correct
       rewrite is none, and the file is never opened for writing. Byte identity says so exactly:
       the document is still the compact JSON `write` produced, not the two-space reserialization
       any rewrite would leave behind. */
    expect(read("pages/index.json")).toBe(before);
    expect(report.references.refsUpdated).toBe(0);
  });

  test("a cache-busting query survives the lane round trip", async () => {
    write("public/images/hero.jpg", "binary");
    write(
      "pages/index.json",
      JSON.stringify({ children: [{ src: "/images/hero.jpg?v=2", tagName: "img" }] }),
    );

    await move("public/images/hero.jpg", "public/images/hero-2.jpg");

    expect(read("pages/index.json")).toBe(
      serialized({ children: [{ src: "/images/hero-2.jpg?v=2", tagName: "img" }] }),
    );
  });
});

/*
 * The shape fallback, written back.
 *
 * `walkDocRefs` knows a handful of keys by name and offers everything else to the visitor when the
 * VALUE is shaped like a file. That is what reaches a schema-typed component prop and
 * `project.json`'s own defaults — neither of which any key list contained — and `PROSE_KEYS` is the
 * one place the fallback has to decline.
 */
describe("applyRename — references matched by shape rather than by key name", () => {
  test("a schema-typed component prop ($props.bg) is rewritten", async () => {
    write("public/images/hero.jpg", "binary");
    write(
      "pages/index.json",
      JSON.stringify({ children: [{ $props: { bg: "/images/hero.jpg" }, tagName: "my-hero" }] }),
    );

    const report = await move("public/images/hero.jpg", "public/images/hero-2.jpg");

    expect(read("pages/index.json")).toBe(
      serialized({ children: [{ $props: { bg: "/images/hero-2.jpg" }, tagName: "my-hero" }] }),
    );
    // `path`, not `attr`: the report names the shape fallback as the mechanism that found it.
    expect(report.references.files[0]!.changes).toEqual([
      { from: "/images/hero.jpg", refType: "path", to: "/images/hero-2.jpg" },
    ]);
  });

  test("a list-valued prop is rewritten in place, leaving its siblings alone", async () => {
    /* The array branch of the fallback. Walking the list as a plain object would visit nothing —
       a string leaf returns immediately — so each element is offered by index and written back by
       index. The siblings prove the rewrite is surgical rather than a whole-array replacement,
       and that element ORDER survives, which a set-based rewrite would not guarantee. */
    write("public/images/a.jpg", "binary");
    write(
      "pages/gallery.json",
      JSON.stringify({
        children: [
          {
            $props: { shots: ["/images/z.jpg", "/images/a.jpg", "/images/b.jpg"] },
            tagName: "pv-gallery",
          },
        ],
      }),
    );

    const report = await move("public/images/a.jpg", "public/images/a-2.jpg");

    expect(read("pages/gallery.json")).toBe(
      serialized({
        children: [
          {
            $props: { shots: ["/images/z.jpg", "/images/a-2.jpg", "/images/b.jpg"] },
            tagName: "pv-gallery",
          },
        ],
      }),
    );
    expect(report.references.refsUpdated).toBe(1);
    expect(report.references.files[0]!.changes).toEqual([
      { from: "/images/a.jpg", refType: "path", to: "/images/a-2.jpg" },
    ]);
  });

  test("project.json's defaults.layout follows the layout it names", async () => {
    write("project.json", JSON.stringify({ defaults: { layout: "layouts/base.json" }, name: "d" }));
    write("layouts/base.json", JSON.stringify({ children: [], tagName: "div" }));

    const report = await move("layouts/base.json", "layouts/main.json");

    expect(read("project.json")).toBe(
      serialized({ defaults: { layout: "layouts/main.json" }, name: "d" }),
    );
    expect(report.references.refsUpdated).toBe(1);
  });

  test("a file path written as prose is left byte-for-byte alone", async () => {
    write("public/images/hero.jpg", "binary");
    const before = JSON.stringify({
      children: [{ tagName: "code", textContent: "/images/hero.jpg" }],
    });
    write("pages/index.json", before);

    const report = await move("public/images/hero.jpg", "public/images/hero-2.jpg");

    /* This value resolves exactly like the `src` in the lane tests above — the only thing standing
       between it and a rewrite is `textContent` being a PROSE_KEY. Byte identity rather than a
       count, because a page whose body text was edited by a rename has been vandalised even if the
       report says nothing happened. */
    expect(read("pages/index.json")).toBe(before);
    expect(report.references.files).toEqual([]);
  });
});

/*
 * Asset mounts (extensions.md §8.5): an extension may serve a directory at a URL prefix of its own,
 * so "which file does this URL name?" cannot be answered from the project root alone.
 */
describe("applyRename — rooted references through an asset mount", () => {
  test("a reference into a mount follows a file moving inside it", async () => {
    write("content/x.png", "binary");
    write(
      "pages/index.json",
      JSON.stringify({ children: [{ src: "/content/x.png", tagName: "img" }] }),
    );

    const report = await move("content/x.png", "content/y.png", [
      { dir: "content", urlPrefix: "/content" },
    ]);

    expect(read("pages/index.json")).toBe(
      serialized({ children: [{ src: "/content/y.png", tagName: "img" }] }),
    );
    expect(report.references.refsUpdated).toBe(1);
  });

  test("a mount whose prefix is not its directory is reachable only through the mount lane", async () => {
    /* The test above passes with or without the mount list — `/content/x.png` is also `content/x.png`
       to the root lane, so it proves the reference is rewritten but not WHICH lane rewrote it. Here
       the URL prefix and the directory differ, so the mount lane is the only one that resolves it,
       and the same rename is run both ways to say so. */
    write("assets/media/x.png", "binary");
    const before = JSON.stringify({ children: [{ src: "/m/x.png", tagName: "img" }] });
    write("pages/index.json", before);

    renameSync(join(root, "assets/media/x.png"), join(root, "assets/media/y.png"));
    const registry = await buildProjectFormatRegistry(root);
    const opts = {
      absFrom: join(root, "assets/media/x.png"),
      absTo: join(root, "assets/media/y.png"),
      registry,
      root,
    };

    // With no mounts, `/m/x.png` names `m/x.png` and `public/m/x.png`, and neither of those moved.
    const blind = await applyRename(opts);
    expect(read("pages/index.json")).toBe(before);
    expect(blind.references.refsUpdated).toBe(0);

    const report = await applyRename({
      ...opts,
      mounts: [{ dir: "assets/media", urlPrefix: "/m" }],
    });
    expect(read("pages/index.json")).toBe(
      serialized({ children: [{ src: "/m/y.png", tagName: "img" }] }),
    );
    expect(report.references.refsUpdated).toBe(1);
  });
});
