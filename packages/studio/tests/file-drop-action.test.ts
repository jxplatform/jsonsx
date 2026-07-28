/**
 * Tests for src/editor/file-drop-action.ts — the parent-realm half of dropping OS files on a
 * canvas.
 *
 * The pure decision functions (`resolveFileDropTarget`, `elementForAsset`, `nthDropPath`) need no
 * mocks. `applyFileDrop` gets the upload and the mutation pipeline mocked so the test can assert
 * exactly which mutation ran with which arguments — the point of the module is choosing between
 * them, not the mutations themselves (which transact.test.ts already covers).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DropPreview, FileDropHit } from "../src/canvas/iframe-protocol";
import type { UploadedAsset } from "../src/files/media-upload";
import type { Tab } from "../src/tabs/tab";

type AnyRec = Record<string, any>;

// UploadAssets returns whatever the test queued, so applyFileDrop's branching is driven directly.
let uploadResult: UploadedAsset[] = [];
const uploadCalls: AnyRec[][] = [];
void mock.module("../src/files/media-upload", () => ({
  uploadAssets: (files: AnyRec[]) => {
    uploadCalls.push(files);
    return Promise.resolve(uploadResult);
  },
}));

// The registry the component-prop branch consults. Mutated in place, never reassigned — mock.module
// Snapshots the exported value, so a fresh array would not be seen by the module under test.
const registry: AnyRec[] = [];
const setRegistry = (...entries: AnyRec[]) => {
  registry.length = 0;
  registry.push(...entries);
};
void mock.module("../src/files/components", () => ({ componentRegistry: registry }));

const dropCalls: AnyRec[] = [];
void mock.module("../src/panels/dnd", () => ({
  applyDropInstruction: (tab: AnyRec, instruction: AnyRec, srcData: AnyRec, targetPath: AnyRec) => {
    dropCalls.push({ instruction, srcData, tab, targetPath });
  },
}));

const attrCalls: AnyRec[] = [];
const propCalls: AnyRec[] = [];
void mock.module("../src/tabs/transact", () => ({
  transactDoc: (tab: AnyRec, fn: (t: AnyRec) => void) => fn({ tab }),
  mutateUpdateAttribute: (t: AnyRec, path: AnyRec, attr: string, value: string) => {
    attrCalls.push({ attr, path, t, value });
  },
  mutateUpdateProp: (t: AnyRec, path: AnyRec, prop: string, value: string) => {
    propCalls.push({ path, prop, t, value });
  },
}));

const { applyFileDrop, elementForAsset, nthDropPath, resolveFileDropTarget } =
  await import("../src/editor/file-drop-action");

const asset = (over: Partial<UploadedAsset> = {}): UploadedAsset => ({
  kind: "image",
  name: "hero.png",
  path: "public/hero.png",
  ref: "/hero.png",
  ...over,
});

const hitFor = (tagName: string, path: (string | number)[] = ["children", 1]): FileDropHit => ({
  path,
  rect: { height: 10, width: 10, x: 0, y: 0 },
  tagName,
});

const preview = (over: Partial<DropPreview> = {}): DropPreview => ({
  edge: "top",
  instruction: "reorder-above",
  referenceRect: { height: 10, width: 10, x: 0, y: 0 },
  targetPath: ["children", 2],
  ...over,
});

const tab = { doc: { document: { children: [], tagName: "div" } } } as unknown as Tab;

beforeEach(() => {
  uploadResult = [];
  uploadCalls.length = 0;
  dropCalls.length = 0;
  attrCalls.length = 0;
  propCalls.length = 0;
  registry.length = 0;
});

// ─── resolveFileDropTarget ───────────────────────────────────────────────────

describe("resolveFileDropTarget", () => {
  test("an <img> or <source> replaces its src; a <video> takes a poster frame", () => {
    expect(resolveFileDropTarget(hitFor("img"), "image")).toEqual({
      attr: "src",
      mode: "replace-attr",
      path: ["children", 1],
    });
    expect(resolveFileDropTarget(hitFor("source"), "image")).toMatchObject({ attr: "src" });
    expect(resolveFileDropTarget(hitFor("video"), "image")).toMatchObject({ attr: "poster" });
  });

  test("no hit, or a non-image asset, always inserts", () => {
    expect(resolveFileDropTarget(null, "image")).toEqual({ mode: "insert" });
    // Dropping a movie on an <img> is an insert — there is nothing to replace it WITH.
    expect(resolveFileDropTarget(hitFor("img"), "video")).toEqual({ mode: "insert" });
    expect(resolveFileDropTarget(hitFor("img"), "file")).toEqual({ mode: "insert" });
  });

  test("an ordinary element inserts", () => {
    expect(resolveFileDropTarget(hitFor("div"), "image")).toEqual({ mode: "insert" });
  });

  test("a component with exactly one image prop replaces that prop", () => {
    setRegistry({
      props: [{ format: "image", name: "cover" }, { name: "title" }],
      tagName: "my-card",
    });
    expect(resolveFileDropTarget(hitFor("my-card"), "image")).toEqual({
      mode: "replace-prop",
      path: ["children", 1],
      prop: "cover",
    });
  });

  test("an ambiguous or prop-less component falls through to insert rather than guessing", () => {
    setRegistry(
      {
        props: [
          { format: "image", name: "cover" },
          { format: "image", name: "thumb" },
        ],
        tagName: "my-card",
      },
      { props: [], tagName: "my-plain" },
    );
    expect(resolveFileDropTarget(hitFor("my-card"), "image")).toEqual({ mode: "insert" });
    expect(resolveFileDropTarget(hitFor("my-plain"), "image")).toEqual({ mode: "insert" });
    // Unknown custom element — not in the registry at all.
    expect(resolveFileDropTarget(hitFor("my-unknown"), "image")).toEqual({ mode: "insert" });
  });
});

// ─── elementForAsset ─────────────────────────────────────────────────────────

describe("elementForAsset", () => {
  test("an image becomes a plain <img> with an empty alt", () => {
    expect(elementForAsset(asset())).toEqual({
      attributes: { alt: "", src: "/hero.png" },
      tagName: "img",
    });
  });

  test("playable media gets native controls", () => {
    expect(elementForAsset(asset({ kind: "video", ref: "/a.mp4" }))).toEqual({
      attributes: { controls: "", src: "/a.mp4" },
      tagName: "video",
    });
    expect(elementForAsset(asset({ kind: "audio", ref: "/a.mp3" }))).toEqual({
      attributes: { controls: "", src: "/a.mp3" },
      tagName: "audio",
    });
  });

  test("anything else becomes a download link labelled with the filename", () => {
    expect(elementForAsset(asset({ kind: "file", name: "spec.pdf", ref: "/spec.pdf" }))).toEqual({
      attributes: { href: "/spec.pdf" },
      tagName: "a",
      textContent: "spec.pdf",
    });
  });
});

// ─── nthDropPath ─────────────────────────────────────────────────────────────

describe("nthDropPath", () => {
  test("the first file lands on the preview's own path", () => {
    expect(nthDropPath(preview(), 0)).toEqual(["children", 2]);
  });

  test("later files advance the trailing child index so the batch keeps its order", () => {
    expect(nthDropPath(preview(), 1)).toEqual(["children", 3]);
    expect(nthDropPath(preview({ instruction: "reorder-below" }), 2)).toEqual(["children", 4]);
  });

  test("a non-numeric tail (make-child on a container) is left alone", () => {
    const p = preview({ instruction: "make-child", targetPath: ["children", 2, "children"] });
    expect(nthDropPath(p, 3)).toEqual(["children", 2, "children"]);
  });
});

// ─── applyFileDrop ───────────────────────────────────────────────────────────

describe("applyFileDrop", () => {
  const files = [new File(["x"], "hero.png")];

  test("no tab or no files is a no-op", async () => {
    await applyFileDrop(null, files, null, null);
    await applyFileDrop(tab, [], null, null);
    expect(uploadCalls).toEqual([]);
  });

  test("an upload that produced nothing mutates nothing", async () => {
    uploadResult = [];
    await applyFileDrop(tab, files, hitFor("img"), null);
    expect(attrCalls).toEqual([]);
    expect(dropCalls).toEqual([]);
  });

  test("dropping an image on an <img> sets its src in place", async () => {
    uploadResult = [asset()];
    await applyFileDrop(tab, files, hitFor("img"), preview());

    expect(attrCalls).toEqual([
      { attr: "src", path: ["children", 1], t: { tab }, value: "/hero.png" },
    ]);
    // A replace never also inserts.
    expect(dropCalls).toEqual([]);
  });

  test("dropping an image on a single-image component sets that prop", async () => {
    setRegistry({ props: [{ format: "image", name: "cover" }], tagName: "my-card" });
    uploadResult = [asset()];

    await applyFileDrop(tab, files, hitFor("my-card"), preview());

    expect(propCalls).toEqual([
      { path: ["children", 1], prop: "cover", t: { tab }, value: "/hero.png" },
    ]);
    expect(dropCalls).toEqual([]);
  });

  test("a replace consumes only the first file", async () => {
    uploadResult = [asset(), asset({ name: "b.png", ref: "/b.png" })];
    await applyFileDrop(tab, files, hitFor("img"), preview());
    expect(attrCalls).toHaveLength(1);
  });

  test("dropping elsewhere inserts at the previewed position", async () => {
    uploadResult = [asset()];
    await applyFileDrop(tab, files, hitFor("div"), preview());

    expect(dropCalls).toEqual([
      {
        instruction: { type: "reorder-above" },
        srcData: { fragment: elementForAsset(asset()), type: "block" },
        tab,
        targetPath: ["children", 2],
      },
    ]);
  });

  test("a multi-file insert keeps drop order by advancing the index", async () => {
    uploadResult = [
      asset({ name: "a.png", ref: "/a.png" }),
      asset({ name: "b.png", ref: "/b.png" }),
    ];

    await applyFileDrop(tab, files, null, preview());

    expect(dropCalls.map((c) => c.targetPath)).toEqual([
      ["children", 2],
      ["children", 3],
    ]);
  });

  test("a drop with no resolved position appends to the document root", async () => {
    uploadResult = [asset()];
    await applyFileDrop(tab, files, null, null);

    expect(dropCalls).toEqual([
      {
        instruction: { type: "make-child" },
        srcData: { fragment: elementForAsset(asset()), type: "block" },
        tab,
        targetPath: [],
      },
    ]);
  });
});
