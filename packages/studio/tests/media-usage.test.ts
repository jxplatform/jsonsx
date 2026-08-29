/**
 * "What breaks if I delete this image?" — one question, one query, one answer.
 *
 * This file used to lock down a client-side UNION: `findReferences` resolved a rooted reference
 * against the project root alone, so a query keyed on `public/hero.jpg` matched no `/hero.jpg` and
 * a delete dialog called a seven-page image unused. Studio's answer was to ask about every authored
 * spelling and merge the results.
 *
 * The engine resolves those lanes itself now (`site-architecture.md` §9.3), on the write side as
 * well as the read side, so the union is gone and so are the assertions about merging, per-lane
 * failure and per-lane error dedup. What survives is everything the union was NOT doing: a media
 * path is normalized before it becomes a query, an empty path FAILS rather than reporting zero, and
 * a query that could not be answered says **unknown** — never "nothing uses this".
 *
 * That the lanes are all found is asserted where the behaviour now lives:
 * `packages/server/tests/refactor-find-refs.test.ts` and `refactor-parity.test.ts`.
 */

import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { resetStudioState } from "./harness";
import { registerPlatform } from "../src/platform";
import { invalidateUsages, usageWarning } from "../src/services/references";
import {
  loadMediaUsages,
  mediaUsageHeadline,
  peekMediaUsages,
  retryMediaUsages,
} from "../src/files/media-usage";
import type { ReferenceFile, ReferencesResult, StudioPlatform } from "../src/types";

function hit(path: string, ref: string, count = 1, refType = "attr"): ReferenceFile {
  return { count, path, refs: [{ count, ref, refType }] };
}

function result(path: string, files: ReferenceFile[]): ReferencesResult {
  return {
    errors: [],
    files,
    filesReferencing: files.length,
    path,
    refsTotal: files.reduce((sum, file) => sum + file.count, 0),
    tagName: null,
  };
}

/**
 * A host whose reference index answers per queried path. `null` for `findReferences` is a host
 * without the capability at all.
 */
function install(answers: Record<string, ReferencesResult | Error> | null): { asked: string[] } {
  const asked: string[] = [];
  const platform = (answers === null
    ? {}
    : {
        findReferences: async (target: { path?: string }) => {
          asked.push(target.path ?? "");
          const answer = answers[target.path ?? ""];
          if (answer instanceof Error) {
            throw answer;
          }
          return answer ?? result(target.path ?? "", []);
        },
      }) as unknown as StudioPlatform;
  registerPlatform(platform);
  return { asked };
}

beforeEach(() => {
  invalidateUsages();
  resetStudioState();
});

describe("loadMediaUsages", () => {
  test("asks the engine about the file, once, and passes its answer through", async () => {
    const { asked } = install({
      "public/hero.jpg": result("public/hero.jpg", [
        hit("pages/index.json", "/hero.jpg"),
        hit("pages/about.json", "/hero.jpg"),
      ]),
    });
    const state = await loadMediaUsages("public/hero.jpg");

    /* One entry, and it is the FILE path. The engine resolves `/hero.jpg` through its public lane;
       Studio asking a second time under the served name would be a second implementation of that. */
    expect(asked).toEqual(["public/hero.jpg"]);
    expect(state.status).toBe("ready");
    expect(state.status === "ready" && state.result.refsTotal).toBe(2);
    // The sentence a delete confirmation shows is the shared one, not a second vocabulary.
    expect(usageWarning(state, "delete")).toContain("2 references in 2 files");
  });

  test("two spellings of one file are one query, not two cache entries", async () => {
    const { asked } = install({
      "public/hero.jpg": result("public/hero.jpg", [hit("pages/index.json", "/hero.jpg")]),
    });
    await loadMediaUsages("./public/hero.jpg");
    await loadMediaUsages("public/hero.jpg");
    expect(asked).toEqual(["public/hero.jpg"]);
  });

  test("a failed query is unknown, never a zero", async () => {
    install({ "public/hero.jpg": new Error("index unavailable") });
    const state = await loadMediaUsages("public/hero.jpg");
    expect(state.status).toBe("failed");
    expect(mediaUsageHeadline(state)).toBe("Usage unknown");
    expect(usageWarning(state, "delete")).toContain("could not be counted");
  });

  test("a host with no reference index is unsupported, not empty", async () => {
    install(null);
    const state = await loadMediaUsages("public/hero.jpg");
    expect(state.status).toBe("unsupported");
    expect(mediaUsageHeadline(state)).toBeNull();
    expect(usageWarning(state, "delete")).toBeNull();
  });

  test("an empty path fails rather than reporting nothing uses it", async () => {
    const { asked } = install({});
    expect(await loadMediaUsages("")).toEqual({
      message: "no media file to look for",
      status: "failed",
    });
    expect(await loadMediaUsages("./")).toEqual({
      message: "no media file to look for",
      status: "failed",
    });
    expect(asked).toEqual([]);
  });

  test("unreadable documents ride along in the result", async () => {
    const broken = { error: "bad json", path: "pages/broken.json" };
    install({
      "public/hero.jpg": { ...result("public/hero.jpg", []), errors: [broken] },
    });
    const state = await loadMediaUsages("public/hero.jpg");
    expect(state.status === "ready" && state.result.errors).toEqual([broken]);
    expect(usageWarning(state, "delete")).toBe("Nothing else in this project refers to it.");
  });
});

describe("peekMediaUsages", () => {
  test("is null until the query has an answer, then reports it", async () => {
    install({
      "public/hero.jpg": result("public/hero.jpg", [hit("pages/index.json", "/hero.jpg")]),
    });
    expect(peekMediaUsages("public/hero.jpg")).toBeNull();
    await loadMediaUsages("public/hero.jpg");
    const state = peekMediaUsages("public/hero.jpg");
    expect(state?.status).toBe("ready");
    expect(state?.status === "ready" && state.result.refsTotal).toBe(1);
  });

  test("reports pending while the query is in flight", async () => {
    install({ "public/hero.jpg": result("public/hero.jpg", []) });
    const running = loadMediaUsages("public/hero.jpg");
    expect(peekMediaUsages("public/hero.jpg")?.status).toBe("pending");
    expect(mediaUsageHeadline(peekMediaUsages("public/hero.jpg"))).toBe("Counting references…");
    await running;
  });

  test("has nothing to peek at for an empty path", () => {
    install({});
    expect(peekMediaUsages("")).toBeNull();
  });
});

describe("retryMediaUsages", () => {
  test("asks again after a failure", async () => {
    let fail = true;
    registerPlatform({
      findReferences: async (target: { path?: string }) => {
        if (fail) {
          throw new Error("index unavailable");
        }
        return result(target.path ?? "", [hit("pages/index.json", "/hero.jpg")]);
      },
    } as unknown as StudioPlatform);
    const first = await loadMediaUsages("public/hero.jpg");
    expect(first.status).toBe("failed");
    fail = false;
    const state = await retryMediaUsages("public/hero.jpg");
    expect(state.status).toBe("ready");
    expect(state.status === "ready" && state.result.refsTotal).toBe(1);
  });

  test("an empty path has nothing to retry", async () => {
    install({});
    const state = await retryMediaUsages("");
    expect(state.status).toBe("failed");
  });
});

describe("mediaUsageHeadline", () => {
  test("a cold query is counting, not zero", () => {
    expect(mediaUsageHeadline(null)).toBe("Counting references…");
  });

  test("a real count uses the shared wording", async () => {
    install({
      "public/hero.jpg": result("public/hero.jpg", [
        hit("pages/index.json", "/hero.jpg"),
        hit("layouts/base.json", "/hero.jpg"),
      ]),
    });
    expect(mediaUsageHeadline(await loadMediaUsages("public/hero.jpg"))).toBe(
      "Used on 1 page and 1 other file",
    );
  });

  test("an unused image says so plainly", async () => {
    install({});
    expect(mediaUsageHeadline(await loadMediaUsages("public/hero.jpg"))).toBe("Not used yet");
  });
});
