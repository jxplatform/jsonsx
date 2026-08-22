/**
 * The reference count inside every delete and rename confirmation.
 *
 * This is the point of the whole usage query: before this, deleting a component used on seven pages
 * and deleting an unused one produced the identical dialog. The assertions below are about what the
 * dialog SAYS — that a delete and a rename say different things about the same number, and that a
 * host which cannot count says nothing at all rather than implying zero.
 *
 * The **media** section is about which index the dialog asks. A media file's authored reference
 * usually resolves to a path that is not the file — `/hero.jpg` for `public/hero.jpg`, the asset
 * mount for an asset inside a collection — so the generic index returns a confident zero for uses
 * that are really there. Those cases are asserted through `confirmFileDelete` itself, and the query
 * log is asserted too: a dialog that happened to say the right number while asking only one
 * question would be right by accident.
 */

import { resetStudioState, mountOverlayLayers } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "lit-html";
import { registerPlatform } from "../src/platform";
import { confirmFileDelete, renamePromptMessage } from "../src/files/file-ops";
import { initLayers } from "../src/ui/layers";
import { invalidateUsages } from "../src/services/references";
import type { ReferenceHit, ReferencesResult, StudioPlatform } from "../src/types";

// The overlay layers are part of index.html and bound ONCE by initLayers(); re-creating the nodes
// Per test would leave the module holding detached ones.
mountOverlayLayers(document.body);
initLayers();

function usageResult(files: number, refs: number): ReferencesResult {
  return {
    errors: [],
    files: Array.from({ length: files }, (_, i) => ({
      count: 1,
      path: `pages/p${i}.json`,
      refs: [{ count: 1, ref: "<my-card>", refType: "tagName" }],
    })),
    filesReferencing: files,
    path: "components/card.json",
    refsTotal: refs,
    tagName: "my-card",
  };
}

function install(findReferences: StudioPlatform["findReferences"] | null): void {
  registerPlatform(
    (findReferences === null ? {} : { findReferences }) as unknown as StudioPlatform,
  );
}

/** The text of the dialog currently mounted in the overlay layers. */
function dialogText(): string {
  return document.querySelector("#layer-dialog")?.textContent ?? "";
}

/** Click the dialog's confirm or cancel button, whichever is asked for. */
function settle(kind: "confirm" | "cancel"): void {
  const dialog = document.querySelector("sp-dialog-wrapper");
  dialog?.dispatchEvent(new Event(kind));
}

/** Let the usage query settle and the dialog mount (macrotask turns, as the harness does). */
async function tick(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** Render a prompt message template into a detached node and read its text. */
function textOf(template: unknown): string {
  const host = document.createElement("div");
  render(template as never, host);
  return host.textContent ?? "";
}

beforeEach(() => {
  invalidateUsages();
  document.querySelector("#layer-dialog")!.innerHTML = "";
});

describe("delete confirmation", () => {
  test("states what breaks and what survives", async () => {
    install(async () => usageResult(3, 4));
    const pending = confirmFileDelete({ name: "card.json", path: "components/card.json" });
    // The count is resolved BEFORE the dialog mounts, so the sentence is never backfilled.
    await tick();

    const text = dialogText();
    expect(text).toContain("Delete");
    expect(text).toContain("4 references in 3 files will break");
    expect(text).toContain("Those files stay on disk");

    settle("confirm");
    expect(await pending).toBe(true);
  });

  test("an unused file is confirmed as unused", async () => {
    install(async () => usageResult(0, 0));
    const pending = confirmFileDelete({ name: "orphan.json", path: "components/orphan.json" });
    await tick();
    expect(dialogText()).toContain("Nothing else in this project refers to it.");
    settle("cancel");
    expect(await pending).toBe(false);
  });

  test("a host that cannot count adds no sentence at all", async () => {
    install(null);
    const pending = confirmFileDelete({ name: "card.json", path: "components/card.json" });
    await tick();
    const text = dialogText();
    expect(text).toContain("This cannot be undone.");
    // No count, and — crucially — no claim that nothing refers to it.
    expect(text).not.toContain("references");
    expect(text).not.toContain("Nothing else in this project");
    settle("cancel");
    await pending;
  });

  test("a failed count is stated, not swallowed into zero", async () => {
    install(() => Promise.reject(new Error("backend down")));
    const pending = confirmFileDelete({ name: "card.json", path: "components/card.json" });
    await tick();
    const text = dialogText();
    expect(text).toContain("could not be counted");
    expect(text).toContain("backend down");
    settle("cancel");
    await pending;
  });
});

describe("rename prompt", () => {
  test("says the references will be repaired, not broken", async () => {
    install(async () => usageResult(3, 4));
    const message = await renamePromptMessage("components/card.json");
    const text = textOf(message);
    expect(text).toContain("4 references in 3 files will be updated automatically");
    expect(text).not.toContain("break");
  });

  test("an unused file needs no updating", async () => {
    install(async () => usageResult(0, 0));
    expect(textOf(await renamePromptMessage("components/orphan.json"))).toContain(
      "nothing needs updating",
    );
  });

  test("a host that cannot count supplies no message", async () => {
    install(null);
    expect(await renamePromptMessage("components/card.json")).toBeUndefined();
  });
});

// ─── Media, which is asked about under every name it is written by ───────────

/**
 * A project whose blog collection lives in `posts/` — a `source` that differs from the mount
 * prefix.
 *
 * This is the layout §9.3 exists for, and the one the generic index gets wrong: the collection is
 * published at `/content/blog`, so an asset the author stores beside their entries is addressed
 * `./images/hero.png` from inside the collection (resolving to `posts/images/hero.png`) and
 * `/content/blog/images/hero.png` from anywhere else (resolving to a path that is not a file at
 * all). One file, two resolved names, and a delete has to know about both.
 */
const BLOG_IN_POSTS = { content: { blog: { source: "./posts/" } } };

/** Every path the dialog asked the index about, in order, for one confirmation. */
let asked: string[] = [];

/**
 * A fake index that answers per RESOLVED path, the way the real sweep does.
 *
 * @param hits — resolved path the sweep compares against → the files whose refs produced it, each
 *   with the string the author actually wrote.
 */
function installIndex(hits: Record<string, { file: string; ref: string }[]>): void {
  asked = [];
  install(async (query) => {
    const path = query.path ?? "";
    asked.push(path);
    const found = hits[path] ?? [];
    const files = found.map((hit) => ({
      count: 1,
      path: hit.file,
      refs: [{ count: 1, ref: hit.ref, refType: "path" } as ReferenceHit],
    }));
    return {
      errors: [],
      files,
      filesReferencing: files.length,
      path,
      refsTotal: files.length,
      tagName: null,
    } satisfies ReferencesResult;
  });
}

describe("deleting media", () => {
  beforeEach(() => {
    resetStudioState({ projectConfig: BLOG_IN_POSTS });
  });

  test("counts the content-relative reference AND the asset-mount one — the file's own name is not the only name it has", async () => {
    installIndex({
      // What `./images/hero.png` in `posts/hello.md` resolves to — relative to the entry.
      "posts/images/hero.png": [{ file: "posts/hello.md", ref: "./images/hero.png" }],
      // What `/content/blog/images/hero.png` in a page resolves to — the collection's asset mount,
      // Which is not a path on disk, and is invisible to a query keyed on the file.
      "content/blog/images/hero.png": [
        { file: "pages/index.json", ref: "/content/blog/images/hero.png" },
      ],
    });
    const pending = confirmFileDelete({ name: "hero.png", path: "posts/images/hero.png" });
    await tick();

    // Both lanes were asked. Asking only the file is what returned 1 and made the delete look safe.
    expect(asked.toSorted()).toEqual(["content/blog/images/hero.png", "posts/images/hero.png"]);
    expect(dialogText()).toContain("2 references in 2 files will break");

    settle("cancel");
    await pending;
  });

  test("counts a public asset by its served path, which shares no segment with the file", async () => {
    installIndex({
      // `<img src="/hero.jpg">` — `public/` is served from the site root, so this is what a
      // Reference to `public/hero.jpg` resolves to. The file's own path matches nothing.
      "hero.jpg": [
        { file: "pages/index.json", ref: "/hero.jpg" },
        { file: "layouts/main.json", ref: "/hero.jpg" },
      ],
    });
    const pending = confirmFileDelete({ name: "hero.jpg", path: "public/hero.jpg" });
    await tick();

    expect(asked.toSorted()).toEqual(["hero.jpg", "public/hero.jpg"]);
    expect(dialogText()).toContain("2 references in 2 files will break");

    settle("cancel");
    await pending;
  });

  test("a media file nothing refers to is still confirmed as unused", async () => {
    installIndex({});
    const pending = confirmFileDelete({ name: "unused.png", path: "public/unused.png" });
    await tick();
    expect(dialogText()).toContain("Nothing else in this project refers to it.");
    settle("cancel");
    await pending;
  });

  test("one failed lane makes the whole answer unknown, never a total of the lanes that worked", async () => {
    asked = [];
    install(async (query) => {
      const path = query.path ?? "";
      asked.push(path);
      if (path === "hero.jpg") {
        throw new Error("sweep timed out");
      }
      return {
        errors: [],
        files: [
          { count: 1, path: "pages/index.json", refs: [{ count: 1, ref: "x", refType: "path" }] },
        ],
        filesReferencing: 1,
        path,
        refsTotal: 1,
        tagName: null,
      } satisfies ReferencesResult;
    });
    const pending = confirmFileDelete({ name: "hero.jpg", path: "public/hero.jpg" });
    await tick();

    const text = dialogText();
    expect(text).toContain("could not be counted");
    expect(text).toContain("sweep timed out");
    // The lane that DID answer found one reference; reporting it would read like a complete count.
    expect(text).not.toContain("1 reference in 1 file");

    settle("cancel");
    await pending;
  });

  test("a rename of media says the same union will be repaired", async () => {
    installIndex({
      "content/blog/images/hero.png": [
        { file: "pages/index.json", ref: "/content/blog/images/hero.png" },
      ],
      "posts/images/hero.png": [{ file: "posts/hello.md", ref: "./images/hero.png" }],
    });
    const text = textOf(await renamePromptMessage("posts/images/hero.png"));
    expect(text).toContain("2 references in 2 files will be updated automatically");
  });

  test("a non-media file is asked about ONCE, by its own path", async () => {
    installIndex({ "components/card.json": [{ file: "pages/index.json", ref: "card.json" }] });
    const pending = confirmFileDelete({ name: "card.json", path: "components/card.json" });
    await tick();
    expect(asked).toEqual(["components/card.json"]);
    settle("cancel");
    await pending;
  });
});
