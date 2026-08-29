/**
 * The reference count inside every delete and rename confirmation.
 *
 * This is the point of the whole usage query: before this, deleting a component used on seven pages
 * and deleting an unused one produced the identical dialog. The assertions below are about what the
 * dialog SAYS — that a delete and a rename say different things about the same number, and that a
 * host which cannot count says nothing at all rather than implying zero.
 *
 * The **media** section is about a number the dialog once got wrong. A media file's authored
 * reference usually resolves to a path that is not the file — `/hero.jpg` for `public/hero.jpg`,
 * the asset mount for an asset inside a collection — and a query that could not see those returned
 * a confident zero for uses that are really there. Studio used to compensate by asking about every
 * authored spelling and unioning the answers; the ENGINE resolves those lanes now
 * (`site-architecture.md` §9.3), so the dialog asks once, about the file.
 *
 * The query log is still asserted, and now for the opposite reason. It used to prove the dialog
 * asked enough questions; it proves it asks exactly ONE, because a second question here would be a
 * second implementation of a rule the engine owns — and the client copy is the one that cannot fix
 * the rewrite. Which lanes the engine finds is asserted where the resolution lives:
 * `packages/server/tests/refactor-find-refs.test.ts` and `refactor-parity.test.ts`.
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
 * This is the layout §9.3 exists for: the collection is published at `/content/blog`, so an asset
 * the author stores beside their entries is addressed `./images/hero.png` from inside the
 * collection and `/content/blog/images/hero.png` from anywhere else. One file, two authored
 * spellings, and a delete has to know about both — which is now the engine's job, so the fake below
 * answers the way the real one does: everything that resolves to the file, under the file's own
 * path.
 */
const BLOG_IN_POSTS = { content: { blog: { source: "./posts/" } } };

/** Every path the dialog asked the index about, in order, for one confirmation. */
let asked: string[] = [];

/**
 * A fake index that answers per QUERIED path, the way the real sweep does.
 *
 * The sweep resolves each authored reference through every lane and compares the result to the file
 * it was asked about, so one query about a file returns every spelling that reaches it. The fake
 * mirrors that: the key is the path the caller asks about, and the value is every reference the
 * engine would have matched to it, however it was written.
 *
 * @param hits — queried path → the files whose refs resolve to it, each with the string the author
 *   actually wrote.
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
      // One query, both spellings: `./images/hero.png` in `posts/hello.md` resolves relative to the
      // Entry, and `/content/blog/images/hero.png` in a page resolves through the collection's
      // Asset mount. The engine matches both to this file, so both come back under it.
      "posts/images/hero.png": [
        { file: "posts/hello.md", ref: "./images/hero.png" },
        { file: "pages/index.json", ref: "/content/blog/images/hero.png" },
      ],
    });
    const pending = confirmFileDelete({ name: "hero.png", path: "posts/images/hero.png" });
    await tick();

    // Exactly one question, and it names the FILE. Studio re-deriving the mount here would be a
    // Second copy of lane resolution, and the copy that cannot repair the rewrite.
    expect(asked).toEqual(["posts/images/hero.png"]);
    expect(dialogText()).toContain("2 references in 2 files will break");

    settle("cancel");
    await pending;
  });

  test("counts a public asset written by its served path, which shares no segment with the file", async () => {
    installIndex({
      // `<img src="/hero.jpg">` — `public/` is served from the site root, so a reference to
      // `public/hero.jpg` is written with no segment in common with it. The engine's public lane
      // Is what closes that gap, and it answers under the file the caller asked about.
      "public/hero.jpg": [
        { file: "pages/index.json", ref: "/hero.jpg" },
        { file: "layouts/main.json", ref: "/hero.jpg" },
      ],
    });
    const pending = confirmFileDelete({ name: "hero.jpg", path: "public/hero.jpg" });
    await tick();

    expect(asked).toEqual(["public/hero.jpg"]);
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

  test("a media count that failed is unknown, never a zero and never a partial", async () => {
    asked = [];
    install(async (query) => {
      asked.push(query.path ?? "");
      throw new Error("sweep timed out");
    });
    const pending = confirmFileDelete({ name: "hero.jpg", path: "public/hero.jpg" });
    await tick();

    const text = dialogText();
    expect(text).toContain("could not be counted");
    expect(text).toContain("sweep timed out");
    /* Neither a number nor the reassurance. "Nothing else refers to it" is the sentence a delete
       must never invent, and it reads identically whether the sweep found nothing or fell over. */
    expect(text).not.toContain("references in");
    expect(text).not.toContain("Nothing else in this project");

    settle("cancel");
    await pending;
  });

  test("a rename of media promises to repair every spelling the delete would have broken", async () => {
    /* The two dialogs must agree, and this is the pair that used to be able to disagree: the count
       and the rewrite are one engine now, so a promise made here is one `applyRename` can keep. */
    installIndex({
      "posts/images/hero.png": [
        { file: "posts/hello.md", ref: "./images/hero.png" },
        { file: "pages/index.json", ref: "/content/blog/images/hero.png" },
      ],
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
