import { describe, expect, test } from "bun:test";
import { HIGH_PRIORITY, imgLoadingAttrs } from "../src/site/img-loading.ts";

describe("imgLoadingAttrs", () => {
  test("adds both attributes to an image that declares neither", () => {
    expect(imgLoadingAttrs({}, true)).toEqual({ decoding: "async", loading: "lazy" });
  });

  test("adds nothing when lazy loading is off", () => {
    expect(imgLoadingAttrs({}, false)).toEqual({});
  });

  test("an author-set loading value is never second-guessed", () => {
    expect(imgLoadingAttrs({ loading: "eager" }, true)).toEqual({});
    // Including one that agrees with us — re-adding it would be a no-op, but the rule is simpler.
    expect(imgLoadingAttrs({ loading: "lazy" }, true)).toEqual({});
  });

  /*
   * A high-priority lazy image is a contradiction the browser resolves by ignoring the priority.
   * `fetchpriority="high"` is the only lever an author has over LCP, so it wins outright.
   */
  test("fetchpriority=high suppresses lazy loading", () => {
    expect(imgLoadingAttrs({ fetchpriority: HIGH_PRIORITY }, true)).toEqual({});
    expect(imgLoadingAttrs({ fetchpriority: "HIGH" }, true)).toEqual({});
  });

  test("other fetchpriority values do not", () => {
    expect(imgLoadingAttrs({ fetchpriority: "low" }, true)).toEqual({
      decoding: "async",
      loading: "lazy",
    });
    expect(imgLoadingAttrs({ fetchpriority: "auto" }, true)).toEqual({
      decoding: "async",
      loading: "lazy",
    });
  });

  test("keeps an author's decoding while still adding loading", () => {
    expect(imgLoadingAttrs({ decoding: "sync" }, true)).toEqual({ loading: "lazy" });
  });

  test("empty, null and undefined attribute values count as absent", () => {
    for (const value of ["", null, undefined]) {
      expect(
        imgLoadingAttrs({ decoding: value, fetchpriority: value, loading: value }, true),
      ).toEqual({ decoding: "async", loading: "lazy" });
    }
  });
});
