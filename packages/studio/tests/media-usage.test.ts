/**
 * "What breaks if I delete this image?" — asked in the shape an author wrote, not the shape the
 * file is stored in.
 *
 * The regression this file locks down: `findReferences` resolves `/hero.jpg` to `hero.jpg`, so a
 * query keyed on `public/hero.jpg` matches nothing and the delete dialog calls a seven-page image
 * unused. Every assertion below is about that gap, or about the other way to lie — assembling a
 * total out of lanes when one of them failed.
 */

import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { resetStudioState } from "./harness";
import { registerPlatform } from "../src/platform";
import { invalidateUsages, usageWarning } from "../src/services/references";
import {
  loadMediaUsages,
  mediaUsageHeadline,
  mediaUsageQueries,
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

describe("mediaUsageQueries", () => {
  test("a public image is asked about under both its names", () => {
    expect(mediaUsageQueries("public/hero.jpg")).toEqual([
      { path: "public/hero.jpg" },
      { path: "hero.jpg" },
    ]);
  });

  test("an empty path has nothing to ask", () => {
    expect(mediaUsageQueries("")).toEqual([]);
  });
});

describe("loadMediaUsages", () => {
  test("finds the references a file-keyed query cannot see", async () => {
    const { asked } = install({
      "hero.jpg": result("hero.jpg", [
        hit("pages/index.json", "/hero.jpg"),
        hit("pages/about.json", "/hero.jpg"),
      ]),
    });
    const state = await loadMediaUsages("public/hero.jpg");
    expect(asked).toEqual(["public/hero.jpg", "hero.jpg"]);
    expect(state.status).toBe("ready");
    expect(state.status === "ready" && state.result.refsTotal).toBe(2);
    // The sentence a delete confirmation shows is the shared one, not a second vocabulary.
    expect(usageWarning(state, "delete")).toContain("2 references in 2 files");
  });

  test("unions the lanes and reports the file that was asked about", async () => {
    install({
      "hero.jpg": result("hero.jpg", [hit("pages/index.json", "/hero.jpg")]),
      "public/hero.jpg": result("public/hero.jpg", [hit("layouts/base.json", "./public/hero.jpg")]),
    });
    const state = await loadMediaUsages("public/hero.jpg");
    expect(state.status === "ready" && state.result.path).toBe("public/hero.jpg");
    expect(state.status === "ready" && state.result.files.map((f) => f.path)).toEqual([
      "layouts/base.json",
      "pages/index.json",
    ]);
    expect(state.status === "ready" && state.result.filesReferencing).toBe(2);
  });

  test("one file named under two lanes is one row with both refs", async () => {
    install({
      "hero.jpg": result("hero.jpg", [hit("pages/index.json", "/hero.jpg", 2)]),
      "public/hero.jpg": result("public/hero.jpg", [
        hit("pages/index.json", "./public/hero.jpg", 1, "$src"),
      ]),
    });
    const state = await loadMediaUsages("public/hero.jpg");
    expect(state.status === "ready" && state.result.files).toHaveLength(1);
    expect(state.status === "ready" && state.result.files[0]?.count).toBe(3);
    expect(state.status === "ready" && state.result.files[0]?.refs).toHaveLength(2);
    expect(state.status === "ready" && state.result.refsTotal).toBe(3);
  });

  test("the same ref counted twice in one lane sums rather than duplicating", async () => {
    const twice = result("hero.jpg", [hit("pages/index.json", "/hero.jpg", 2)]);
    install({ "hero.jpg": twice, "public/hero.jpg": twice });
    const state = await loadMediaUsages("public/hero.jpg");
    expect(state.status === "ready" && state.result.files[0]?.refs).toHaveLength(1);
    expect(state.status === "ready" && state.result.files[0]?.refs[0]?.count).toBe(4);
  });

  test("unreadable documents are reported once, not once per lane", async () => {
    const broken = { error: "bad json", path: "pages/broken.json" };
    install({
      "hero.jpg": { ...result("hero.jpg", []), errors: [broken] },
      "public/hero.jpg": { ...result("public/hero.jpg", []), errors: [broken] },
    });
    const state = await loadMediaUsages("public/hero.jpg");
    expect(state.status === "ready" && state.result.errors).toEqual([broken]);
    expect(usageWarning(state, "delete")).toBe("Nothing else in this project refers to it.");
  });

  test("a lane that failed makes the whole answer unknown, never a partial total", async () => {
    install({
      "hero.jpg": new Error("index unavailable"),
      "public/hero.jpg": result("public/hero.jpg", [hit("pages/index.json", "./public/hero.jpg")]),
    });
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
    install({});
    const state = await loadMediaUsages("");
    expect(state).toEqual({ message: "no media file to look for", status: "failed" });
  });
});

describe("peekMediaUsages", () => {
  test("is null until every lane has an answer", async () => {
    install({ "hero.jpg": result("hero.jpg", [hit("pages/index.json", "/hero.jpg")]) });
    expect(peekMediaUsages("public/hero.jpg")).toBeNull();
    await loadMediaUsages("public/hero.jpg");
    const state = peekMediaUsages("public/hero.jpg");
    expect(state?.status).toBe("ready");
    expect(state?.status === "ready" && state.result.refsTotal).toBe(1);
  });

  test("reports pending while a lane is in flight", async () => {
    install({ "hero.jpg": result("hero.jpg", []) });
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
  test("asks every lane again after a failure", async () => {
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
    expect(state.status === "ready" && state.result.refsTotal).toBe(2);
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
      "hero.jpg": result("hero.jpg", [
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
