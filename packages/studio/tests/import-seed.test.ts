/** Src/services/import-seed.ts — the New Project Import form's hand-off to the assistant. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  clearPendingImportBrief,
  pendingImportBrief,
  runImportHandoff,
  setImportHandoff,
  setPendingImportBrief,
} from "../src/services/import-seed";
import type { ImportBrief } from "../src/services/import-seed";

const BRIEF: ImportBrief = {
  aiComponents: true,
  depth: 1,
  directory: "/home/dev/Sites/example",
  maxPages: 20,
  model: "o3",
  name: "Example",
  prompt: "Modernise the typography",
  url: "https://example.com/",
};

afterEach(() => {
  clearPendingImportBrief();
});

describe("import-seed", () => {
  test("starts empty", () => {
    expect(pendingImportBrief()).toBeNull();
  });

  test("holds the brief the form gathered", () => {
    setPendingImportBrief(BRIEF);
    expect(pendingImportBrief()).toEqual(BRIEF);
  });

  test("reading does NOT consume it", () => {
    /* Two readers at different moments: the panel, to compose the turn, and `import_site`, for the
       destination — minutes later, after the model has decided to call it. A consume-on-read (which
       is what `agent-seed.ts` does, for a case with one reader) would leave the tool inventing a
       path the user never chose. */
    setPendingImportBrief(BRIEF);
    expect(pendingImportBrief()).toEqual(BRIEF);
    expect(pendingImportBrief()).toEqual(BRIEF);
    expect(pendingImportBrief()).toEqual(BRIEF);
  });

  test("a second brief replaces the first", () => {
    setPendingImportBrief(BRIEF);
    setPendingImportBrief({ ...BRIEF, url: "https://other.example/" });
    expect(pendingImportBrief()?.url).toBe("https://other.example/");
  });

  test("clearing forgets it", () => {
    setPendingImportBrief(BRIEF);
    clearPendingImportBrief();
    expect(pendingImportBrief()).toBeNull();
  });
});

describe("import-seed — the hand-off slot", () => {
  test("does nothing with no assistant registered", async () => {
    /* A reduced host — a test fixture, an embedder without the assistant — would otherwise crash on
       a button the wizard should simply not have offered. */
    await expect(runImportHandoff(BRIEF)).resolves.toBeUndefined();
  });

  test("delegates to the registered hand-off and awaits it", async () => {
    const order: string[] = [];
    const handoff = mock(async (brief: ImportBrief) => {
      order.push(`start:${brief.url}`);
      await Promise.resolve();
      order.push("end");
    });
    setImportHandoff(handoff);

    await runImportHandoff(BRIEF);

    expect(handoff).toHaveBeenCalledWith(BRIEF);
    // Awaited, so the caller can rely on the turn having been opened.
    expect(order).toEqual(["start:https://example.com/", "end"]);
  });
});
