/**
 * Srcset.test.ts — the separator that decides what an importer downloads (issue #231).
 *
 * `.split(",")` shredded any URL that carries commas in its own path. Wix, Cloudinary and imgix all
 * encode image transforms that way, so one image became a dozen unfetchable fragments: 109 failed
 * downloads on one Wix site, and — because a failed download leaves the reference untouched — 46
 * origin URLs left in the emitted page, hotlinking the site that had just been cloned.
 */

import { describe, expect, test } from "bun:test";
import { SRCSET_SEPARATOR, parseSrcset } from "../src/srcset.ts";

describe("parseSrcset", () => {
  test("keeps a transform-CDN URL whole", () => {
    const wix =
      "https://static.wixstatic.com/media/X~mv2.png/v1/fill/w_375,h_127,al_c,q_85,enc_avif,quality_auto/logo.png 1x, " +
      "https://static.wixstatic.com/media/X~mv2.png/v1/fill/w_750,h_254,al_c,q_85,enc_avif,quality_auto/logo.png 2x";

    expect(parseSrcset(wix)).toEqual([
      "https://static.wixstatic.com/media/X~mv2.png/v1/fill/w_375,h_127,al_c,q_85,enc_avif,quality_auto/logo.png",
      "https://static.wixstatic.com/media/X~mv2.png/v1/fill/w_750,h_254,al_c,q_85,enc_avif,quality_auto/logo.png",
    ]);
  });

  test("keeps a Cloudinary transform whole", () => {
    expect(
      parseSrcset(
        "https://res.cloudinary.com/demo/image/upload/w_300,c_scale/sample.jpg 300w, " +
          "https://res.cloudinary.com/demo/image/upload/w_600,c_scale/sample.jpg 600w",
      ),
    ).toEqual([
      "https://res.cloudinary.com/demo/image/upload/w_300,c_scale/sample.jpg",
      "https://res.cloudinary.com/demo/image/upload/w_600,c_scale/sample.jpg",
    ]);
  });

  // The ordinary shape has to come out exactly as it did before — this fix may not cost a split
  // That was already correct.
  test("splits an ordinary srcset unchanged", () => {
    expect(parseSrcset("a.png 400w, b.png 800w, c.png 1200w")).toEqual(["a.png", "b.png", "c.png"]);
  });

  test.each([
    ["root-relative", "/img/a.png 1x, /img/b.png 2x", ["/img/a.png", "/img/b.png"]],
    ["dot-relative", "./a.png 1x, ../b.png 2x", ["./a.png", "../b.png"]],
    [
      "protocol-relative",
      "//cdn.example.com/a.png 1x, //cdn.example.com/b.png 2x",
      ["//cdn.example.com/a.png", "//cdn.example.com/b.png"],
    ],
  ])("splits %s entries", (_name, srcset, expected) => {
    expect(parseSrcset(srcset)).toEqual(expected as string[]);
  });

  // A data URI's own `base64,` comma is the exact case a naive split gets wrong in the other
  // Direction: it is a comma inside a URL, and it must not end the entry.
  test("keeps a data URI whole", () => {
    expect(parseSrcset("data:image/png;base64,iVBORw0KGgo= 1x, b.png 2x")).toEqual([
      "data:image/png;base64,iVBORw0KGgo=",
      "b.png",
    ]);
  });

  test("handles a single entry with no descriptor", () => {
    expect(parseSrcset("hero.jpg")).toEqual(["hero.jpg"]);
  });

  test("drops empty entries from a trailing comma", () => {
    expect(parseSrcset("a.png 1x, ")).toEqual(["a.png"]);
    expect(parseSrcset("")).toEqual([]);
  });
});

describe("SRCSET_SEPARATOR", () => {
  /*
   * A sticky/global `lastIndex` survives between calls, so a shared global regex would return
   * different answers for the same input depending on what ran before it.
   */
  test("carries no global flag", () => {
    expect(SRCSET_SEPARATOR.global).toBe(false);
    expect(SRCSET_SEPARATOR.sticky).toBe(false);
  });
});
