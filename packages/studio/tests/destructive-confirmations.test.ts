/**
 * The reference count inside every delete and rename confirmation.
 *
 * This is the point of the whole usage query: before this, deleting a component used on seven pages
 * and deleting an unused one produced the identical dialog. The assertions below are about what the
 * dialog SAYS — that a delete and a rename say different things about the same number, and that a
 * host which cannot count says nothing at all rather than implying zero.
 */

import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "lit-html";
import { registerPlatform } from "../src/platform";
import { confirmFileDelete, renamePromptMessage } from "../src/files/file-ops";
import { initLayers } from "../src/ui/layers";
import { invalidateUsages } from "../src/services/references";
import type { ReferencesResult, StudioPlatform } from "../src/types";

// The overlay layers are part of index.html and bound ONCE by initLayers(); re-creating the nodes
// Per test would leave the module holding detached ones.
document.body.innerHTML = `
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
  <div id="layer-toast"></div>
`;
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
