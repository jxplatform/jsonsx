import { describe, expect, test } from "bun:test";
import type { DiscoveredAsset } from "../src/asset-collect.ts";
import {
  applyFamilyAliases,
  chooseOriginal,
  familyKey,
  planImageFamilies,
} from "../src/image-family.ts";

const UPLOADS = "https://example.com/wp-content/uploads/2024/05";

function img(url: string, source: DiscoveredAsset["source"] = "img-srcset"): DiscoveredAsset {
  return { source, url };
}

describe("familyKey", () => {
  test("groups a WordPress derivative ladder onto one key", () => {
    const keys = new Set(
      [
        `${UPLOADS}/photo.jpg`,
        `${UPLOADS}/photo-300x200.jpg`,
        `${UPLOADS}/photo-768x512.jpg`,
        `${UPLOADS}/photo-1536x1025.jpg`,
        `${UPLOADS}/photo-scaled.jpg`,
      ].map((url) => familyKey(url)),
    );

    expect(keys.size).toBe(1);
  });

  test("strips the dimensions before -scaled, the order WordPress writes them", () => {
    expect(familyKey(`${UPLOADS}/photo-scaled-768x512.jpg`)).toBe(
      familyKey(`${UPLOADS}/photo.jpg`),
    );
  });

  test("keeps different directories apart", () => {
    // The same basename under a different month is a different upload, not a bigger copy.
    expect(familyKey(`${UPLOADS}/photo.jpg`)).not.toBe(
      familyKey("https://example.com/wp-content/uploads/2023/01/photo.jpg"),
    );
  });

  test("keeps different origins apart", () => {
    expect(familyKey(`${UPLOADS}/photo.jpg`)).not.toBe(
      familyKey(`${UPLOADS.replace("example.com", "other.test")}/photo.jpg`),
    );
  });

  test("ignores a cache-busting query", () => {
    expect(familyKey(`${UPLOADS}/photo.jpg?v=9`)).toBe(familyKey(`${UPLOADS}/photo.jpg`));
  });

  test("does not treat a version-looking stem as a dimension marker", () => {
    // `-2x` is not `-WxH`; nothing should be stripped.
    expect(familyKey(`${UPLOADS}/logo-2x.png`)).not.toBe(familyKey(`${UPLOADS}/logo.png`));
  });

  test("an unparseable URL is its own family rather than merged", () => {
    expect(familyKey("::::")).toBe("::::");
  });
});

describe("chooseOriginal", () => {
  test("prefers the undecorated upload", () => {
    expect(
      chooseOriginal([
        `${UPLOADS}/photo-1536x1025.jpg`,
        `${UPLOADS}/photo.jpg`,
        `${UPLOADS}/photo-300x200.jpg`,
      ]),
    ).toBe(`${UPLOADS}/photo.jpg`);
  });

  test("falls back to the largest real candidate when there is no undecorated member", () => {
    /* 120 of 451 families on the reference corpus look like this - WordPress serves only the
       working copy once an upload passes its threshold. Synthesising `photo.jpg` and fetching it
       would 404, and a failed download leaves the REMOTE url in the emitted markup. */
    expect(
      chooseOriginal([
        `${UPLOADS}/photo-300x200.jpg`,
        `${UPLOADS}/photo-1536x1025.jpg`,
        `${UPLOADS}/photo-768x512.jpg`,
      ]),
    ).toBe(`${UPLOADS}/photo-1536x1025.jpg`);
  });

  test("prefers -scaled to an explicit crop", () => {
    expect(chooseOriginal([`${UPLOADS}/photo-2048x1366.jpg`, `${UPLOADS}/photo-scaled.jpg`])).toBe(
      `${UPLOADS}/photo-scaled.jpg`,
    );
  });

  test("is deterministic when two candidates tie", () => {
    const tied = [`${UPLOADS}/b-300x200.jpg`, `${UPLOADS}/a-300x200.jpg`];
    expect(chooseOriginal(tied)).toBe(chooseOriginal(tied.toReversed()));
  });
});

describe("planImageFamilies", () => {
  test("keeps one member per family and aliases the rest to it", () => {
    const plan = planImageFamilies([
      img(`${UPLOADS}/photo.jpg`, "img-src"),
      img(`${UPLOADS}/photo-300x200.jpg`),
      img(`${UPLOADS}/photo-768x512.jpg`),
      img(`${UPLOADS}/other-1024x683.jpg`),
    ]);

    expect(plan.keep.map((a) => a.url)).toEqual([
      `${UPLOADS}/photo.jpg`,
      `${UPLOADS}/other-1024x683.jpg`,
    ]);
    expect(plan.alias.get(`${UPLOADS}/photo-300x200.jpg`)).toBe(`${UPLOADS}/photo.jpg`);
    expect(plan.alias.get(`${UPLOADS}/photo-768x512.jpg`)).toBe(`${UPLOADS}/photo.jpg`);
  });

  test("aliases a derivative even when the winner appears later in the list", () => {
    const plan = planImageFamilies([
      img(`${UPLOADS}/photo-300x200.jpg`),
      img(`${UPLOADS}/photo.jpg`),
    ]);

    expect(plan.keep.map((a) => a.url)).toEqual([`${UPLOADS}/photo.jpg`]);
    expect(plan.alias.get(`${UPLOADS}/photo-300x200.jpg`)).toBe(`${UPLOADS}/photo.jpg`);
  });

  test("never drops a CSS background, font or favicon", () => {
    /* A background is authored at one size; merging two on a coincidental name match would swap an
       image the stylesheet asked for. */
    const plan = planImageFamilies([
      img(`${UPLOADS}/bg.jpg`, "css-background"),
      img(`${UPLOADS}/bg-300x200.jpg`, "css-background"),
      img("https://example.com/f.woff2", "font-face"),
      img("https://example.com/icon.png", "favicon"),
    ]);

    expect(plan.keep).toHaveLength(4);
    expect(plan.alias.size).toBe(0);
  });

  test("does not emit a duplicate keep when the winner is discovered twice", () => {
    const plan = planImageFamilies([
      img(`${UPLOADS}/photo.jpg`, "img-src"),
      img(`${UPLOADS}/photo.jpg`),
    ]);

    expect(plan.keep).toHaveLength(1);
  });

  test("collapses a real ladder to a single download", () => {
    const ladder = [24, 48, 96, 100, 150, 300, 600, 768, 1024, 1536, 2048].map((w) =>
      img(`${UPLOADS}/0M7A3362-${w}x${w}.jpg`),
    );
    const plan = planImageFamilies([...ladder, img(`${UPLOADS}/0M7A3362-scaled.jpg`)]);

    expect(plan.keep).toHaveLength(1);
    expect(plan.keep[0]!.url).toBe(`${UPLOADS}/0M7A3362-scaled.jpg`);
    expect(plan.alias.size).toBe(11);
  });
});

describe("names without an extension", () => {
  test("groups a CDN path that carries no file extension", () => {
    // A transform URL often has no extension at all; the stem is then the whole pathname.
    expect(familyKey("https://cdn.test/image/abc123")).toBe(
      familyKey("https://cdn.test/image/abc123"),
    );
    expect(familyKey("https://cdn.test/image/abc123")).not.toBe(
      familyKey("https://cdn.test/image/def456"),
    );
  });

  test("does not mistake a dot in a directory for an extension", () => {
    expect(familyKey("https://cdn.test/v1.2/photo")).toBe(familyKey("https://cdn.test/v1.2/photo"));
  });
});

describe("applyFamilyAliases", () => {
  test("reconnects every dropped derivative to the file that was written", () => {
    const rewriteMap = new Map([[`${UPLOADS}/photo.jpg`, "/assets/images/photo.jpg"]]);
    const alias = new Map([
      [`${UPLOADS}/photo-300x200.jpg`, `${UPLOADS}/photo.jpg`],
      [`${UPLOADS}/photo-768x512.jpg`, `${UPLOADS}/photo.jpg`],
    ]);

    expect(applyFamilyAliases(rewriteMap, alias)).toBe(2);
    expect(rewriteMap.get(`${UPLOADS}/photo-300x200.jpg`)).toBe("/assets/images/photo.jpg");
    expect(rewriteMap.get(`${UPLOADS}/photo-768x512.jpg`)).toBe("/assets/images/photo.jpg");
  });

  test("leaves a reference alone when its family never downloaded", () => {
    /* Inventing a local path for a file that was never written would be worse than leaving the
       reference remote: the built page would 404 instead of merely reaching the origin site. */
    const rewriteMap = new Map<string, string>();
    const alias = new Map([[`${UPLOADS}/photo-300x200.jpg`, `${UPLOADS}/photo.jpg`]]);

    expect(applyFamilyAliases(rewriteMap, alias)).toBe(0);
    expect(rewriteMap.size).toBe(0);
  });
});
