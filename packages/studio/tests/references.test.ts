/**
 * The usage query the inspector, the palette and every destructive dialog share.
 *
 * The assertions worth reading are the ones about NOT knowing: a host without the capability, and a
 * query that failed, must each produce something a confirmation can say out loud — never a zero.
 */

import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { registerPlatform } from "../src/platform";
import {
  invalidateUsages,
  loadUsages,
  peekUsages,
  retryUsages,
  splitUsages,
  usageFiles,
  usageHeadline,
  usagesSupported,
  usageWarning,
} from "../src/services/references";
import type { ReferencesResult, StudioPlatform } from "../src/types";

function result(over: Partial<ReferencesResult> = {}): ReferencesResult {
  return {
    errors: [],
    files: [],
    filesReferencing: 0,
    path: "components/card.json",
    refsTotal: 0,
    tagName: "my-card",
    ...over,
  };
}

const threeFiles = result({
  files: [
    {
      count: 2,
      path: "pages/index.json",
      refs: [{ count: 2, ref: "<my-card>", refType: "tagName" }],
    },
    {
      count: 1,
      path: "pages/about.json",
      refs: [{ count: 1, ref: "<my-card>", refType: "tagName" }],
    },
    { count: 1, path: "layouts/base.json", refs: [{ count: 1, ref: "./x", refType: "$ref" }] },
  ],
  filesReferencing: 3,
  refsTotal: 4,
});

/** Install a platform with (or deliberately without) the usage query. */
function install(findReferences: StudioPlatform["findReferences"] | null) {
  const platform = (findReferences === null ? {} : { findReferences }) as unknown as StudioPlatform;
  registerPlatform(platform);
  return platform;
}

beforeEach(() => {
  invalidateUsages();
});

describe("capability gating", () => {
  test("a host without the member cannot answer, and peek says so rather than nothing", () => {
    install(null);
    expect(usagesSupported()).toBe(false);
    expect(peekUsages({ tagName: "my-card" })).toEqual({ status: "unsupported" });
  });

  test("an unsupported host never produces a consequence sentence", async () => {
    install(null);
    const state = await loadUsages({ tagName: "my-card" });
    expect(state).toEqual({ status: "unsupported" });
    // Null, not "0 references" — the dialog stays silent rather than implying a count.
    expect(usageWarning(state, "delete")).toBeNull();
    expect(usageWarning(state, "rename")).toBeNull();
  });
});

describe("loadUsages", () => {
  test("asks once and serves the cache after", async () => {
    const findReferences = mock(async () => threeFiles);
    install(findReferences);

    const [a, b] = await Promise.all([
      loadUsages({ path: "components/card.json" }),
      loadUsages({ path: "components/card.json" }),
    ]);
    expect(a).toBe(b);
    await loadUsages({ path: "components/card.json" });
    expect(findReferences).toHaveBeenCalledTimes(1);

    invalidateUsages();
    await loadUsages({ path: "components/card.json" });
    expect(findReferences).toHaveBeenCalledTimes(2);
  });

  test("passes only the fields it was given", async () => {
    const findReferences = mock(async () => threeFiles);
    install(findReferences);
    await loadUsages({ path: "components/card.json", tagName: "my-card" });
    expect(findReferences).toHaveBeenCalledWith({
      path: "components/card.json",
      tagName: "my-card",
    });
    await loadUsages({ tagName: "solo" });
    expect(findReferences).toHaveBeenLastCalledWith({ tagName: "solo" });
  });

  test("a target-less query fails rather than sweeping the project", async () => {
    const findReferences = mock(async () => threeFiles);
    install(findReferences);
    const state = await loadUsages({});
    expect(state.status).toBe("failed");
    expect(findReferences).not.toHaveBeenCalled();
  });

  test("a rejection becomes a settled failure, so a repainting panel cannot loop on it", async () => {
    const findReferences = mock(() => Promise.reject(new Error("backend down")));
    install(findReferences);

    const state = await loadUsages({ path: "a.json" });
    expect(state).toEqual({ message: "backend down", status: "failed" });
    // Settled: the next paint reads the failure instead of firing a second request.
    expect(peekUsages({ path: "a.json" })).toEqual(state);
    await loadUsages({ path: "a.json" });
    expect(findReferences).toHaveBeenCalledTimes(1);

    // Retry is the explicit way out.
    await retryUsages({ path: "a.json" });
    expect(findReferences).toHaveBeenCalledTimes(2);
  });

  test("peek reports pending while a request is in flight, and never starts one", async () => {
    let release: (r: ReferencesResult) => void = () => {};
    install(
      mock(
        () =>
          new Promise<ReferencesResult>((r) => {
            release = r;
          }),
      ),
    );

    expect(peekUsages({ path: "slow.json" })).toBeNull();
    const inFlight = loadUsages({ path: "slow.json" });
    expect(peekUsages({ path: "slow.json" })).toEqual({ status: "pending" });
    release(threeFiles);
    await inFlight;
    expect(peekUsages({ path: "slow.json" })).toEqual({ result: threeFiles, status: "ready" });
  });
});

describe("the words", () => {
  test("splits pages from everything else", () => {
    expect(splitUsages(threeFiles)).toEqual({ others: 1, pages: 2 });
    expect(splitUsages(result())).toEqual({ others: 0, pages: 0 });
  });

  test("headline counts pages and other files separately", () => {
    expect(usageHeadline(threeFiles)).toBe("Used on 2 pages and 1 other file");
    expect(usageHeadline(result())).toBe("Not used yet");
    expect(usageHeadline(result({ files: [{ count: 1, path: "pages/a.json", refs: [] }] }))).toBe(
      "Used on 1 page",
    );
    expect(
      usageHeadline(result({ files: [{ count: 1, path: "components/b.json", refs: [] }] })),
    ).toBe("Used on 1 other file");
  });

  test("delete and rename say different things about the same count", () => {
    const ready = { result: threeFiles, status: "ready" } as const;
    expect(usageWarning(ready, "delete")).toBe(
      "4 references in 3 files will break. Those files stay on disk; the references in them stop resolving.",
    );
    expect(usageWarning(ready, "rename")).toBe(
      "4 references in 3 files will be updated automatically. Nothing else changes.",
    );
  });

  test("an unused target reassures both ways", () => {
    const empty = { result: result(), status: "ready" } as const;
    expect(usageWarning(empty, "delete")).toBe("Nothing else in this project refers to it.");
    expect(usageWarning(empty, "rename")).toContain("nothing needs updating");
  });

  test("unreadable documents make the count a stated floor", () => {
    const partial = {
      result: result({
        errors: [{ error: "bad json", path: "pages/broken.json" }],
        files: [{ count: 1, path: "pages/a.json", refs: [] }],
        filesReferencing: 1,
        refsTotal: 1,
      }),
      status: "ready",
    } as const;
    expect(usageWarning(partial, "delete")).toContain("at least");
  });

  test("a failure says why, and says it is not the same as unused", () => {
    const failed = { message: "backend down", status: "failed" } as const;
    const sentence = usageWarning(failed, "delete")!;
    expect(sentence).toContain("backend down");
    expect(sentence).toContain("more than it appears");
    expect(usageWarning({ status: "pending" }, "delete")).toBe("Counting references…");
  });

  test("files sort most-referenced first, then by path", () => {
    expect(usageFiles(threeFiles).map((f) => f.path)).toEqual([
      "pages/index.json",
      "layouts/base.json",
      "pages/about.json",
    ]);
  });
});
