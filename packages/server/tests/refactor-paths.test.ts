import { describe, expect, test } from "bun:test";
import {
  classifyRef,
  isUnder,
  joinPosix,
  normalizeSegments,
  relativeChain,
  remapTarget,
  rewriteRef,
  splitQueryHash,
} from "../src/refactor/paths";
import type { RemapCtx } from "../src/refactor/paths";

describe("splitQueryHash", () => {
  test.each([
    ["./x.json", "./x.json", ""],
    ["sprite.svg#icon", "sprite.svg", "#icon"],
    ["font.woff2?v=2", "font.woff2", "?v=2"],
    ["a.png?x=1#frag", "a.png", "?x=1#frag"],
  ])("%s", (input, core, suffix) => {
    expect(splitQueryHash(input)).toEqual({ core, suffix });
  });
});

describe("classifyRef", () => {
  test.each([
    "#/state/count",
    "#/$defs/x",
    "#",
    "$map/item",
    "$map",
    "parent#name",
    "window#x",
    "document#y",
  ])("state: %s", (value) => {
    expect(classifyRef(value).kind).toBe("state");
  });

  test.each([
    "http://x/y.png",
    "https://x",
    "//host/a.js",
    "data:image/png;base64,AA",
    "mailto:a@b",
  ])("external: %s", (value) => {
    expect(classifyRef(value).kind).toBe("external");
  });

  test.each([
    ["", undefined],
    [123, undefined],
    [null, undefined],
    [{}, undefined],
  ] as const)("none: %p", (value) => {
    expect(classifyRef(value).kind).toBe("none");
  });

  test("relative file", () => {
    expect(classifyRef("./x.json")).toEqual({
      core: "./x.json",
      kind: "path",
      rooted: false,
      suffix: "",
    });
  });

  test("rooted file with query", () => {
    expect(classifyRef("/img/a.png?v=2")).toEqual({
      core: "/img/a.png",
      kind: "path",
      rooted: true,
      suffix: "?v=2",
    });
  });

  test("bare specifier is still a path (gated later by resolution)", () => {
    expect(classifyRef("@scope/pkg/x.js").kind).toBe("path");
  });

  test("a value that is only a query/fragment suffix is none", () => {
    expect(classifyRef("?v=2").kind).toBe("none");
  });
});

describe("normalizeSegments / joinPosix", () => {
  test.each([
    ["/p/pages/../layouts/x.json", "/p/layouts/x.json"],
    ["/p/./a/./b", "/p/a/b"],
    ["/../a", "/a"],
    ["a/../b", "b"],
    ["../a", "../a"],
    ["../../a", "../../a"],
  ])("%s", (input, out) => {
    expect(normalizeSegments(input)).toBe(out);
  });

  test("joinPosix resolves rel and rooted alike", () => {
    expect(joinPosix("/p/pages", "../layouts/x.json")).toBe("/p/layouts/x.json");
    expect(joinPosix("/p", "/img/a.png")).toBe("/p/img/a.png");
  });
});

describe("relativeChain", () => {
  test.each([
    ["/p/pages", "/p/pages/a.json", "a.json"],
    ["/p", "/p/layouts/x.json", "layouts/x.json"],
    ["/p/pages/basics", "/p/layouts/x.json", "../../layouts/x.json"],
    ["/p/a", "/p/b/c.json", "../b/c.json"],
  ])("%s -> %s", (from, to, out) => {
    expect(relativeChain(from, to)).toBe(out);
  });
});

describe("isUnder / remapTarget", () => {
  test("isUnder", () => {
    expect(isUnder("/p/a", "/p/a")).toBe(true);
    expect(isUnder("/p/a/b", "/p/a")).toBe(true);
    expect(isUnder("/p/ab", "/p/a")).toBe(false);
  });

  test("remapTarget: exact file", () => {
    expect(remapTarget("/p/old.json", "/p/old.json", "/p/new.json")).toBe("/p/new.json");
  });
  test("remapTarget: under moved dir", () => {
    expect(remapTarget("/p/dir/a.json", "/p/dir", "/p/widgets")).toBe("/p/widgets/a.json");
  });
  test("remapTarget: unaffected", () => {
    expect(remapTarget("/p/other.json", "/p/old.json", "/p/new.json")).toBe("/p/other.json");
  });
});

const ctx = (over: Partial<RemapCtx>): RemapCtx => ({
  docNewDir: "/p/pages",
  docOldDir: "/p/pages",
  newAbs: "/p/components/button.json",
  oldAbs: "/p/components/counter.json",
  root: "/p",
  ...over,
});

describe("rewriteRef", () => {
  test("doc-relative file rename", () => {
    expect(rewriteRef(classifyRef("../components/counter.json") as never, ctx({}))).toBe(
      "../components/button.json",
    );
  });

  test("non-matching ref untouched", () => {
    expect(rewriteRef(classifyRef("../components/other.json") as never, ctx({}))).toBeNull();
  });

  test("preserves ./ style", () => {
    const c = ctx({ newAbs: "/p/pages/info.json", oldAbs: "/p/pages/about.json" });
    expect(rewriteRef(classifyRef("./about.json") as never, c)).toBe("./info.json");
  });

  test("$layout bare resolves at root (rootRelativeBare)", () => {
    const c = ctx({ newAbs: "/p/layouts/main.json", oldAbs: "/p/layouts/base.json" });
    expect(rewriteRef(classifyRef("layouts/base.json") as never, c, true)).toBe(
      "layouts/main.json",
    );
  });

  test("$layout doc-relative still resolves at docDir", () => {
    const c = ctx({ newAbs: "/p/layouts/main.json", oldAbs: "/p/layouts/base.json" });
    expect(rewriteRef(classifyRef("../layouts/base.json") as never, c, true)).toBe(
      "../layouts/main.json",
    );
  });

  test("rooted asset keeps rooted style and suffix", () => {
    const c = ctx({ newAbs: "/p/img/brand.png", oldAbs: "/p/img/logo.png" });
    expect(rewriteRef(classifyRef("/img/logo.png?v=2") as never, c)).toBe("/img/brand.png?v=2");
  });

  test("directory move — incoming ref from unmoved doc", () => {
    const c = ctx({ newAbs: "/p/widgets", oldAbs: "/p/components" });
    expect(rewriteRef(classifyRef("../components/card.json") as never, c)).toBe(
      "../widgets/card.json",
    );
  });

  test("directory move — outgoing ref from a moved doc to an unmoved target", () => {
    // Moved components/card.json -> sub/widgets/card.json; its ref to ../layouts/x.json deepens.
    const c = ctx({
      docNewDir: "/p/sub/widgets",
      docOldDir: "/p/components",
      newAbs: "/p/sub/widgets",
      oldAbs: "/p/components",
    });
    expect(rewriteRef(classifyRef("../layouts/x.json") as never, c)).toBe("../../layouts/x.json");
  });
});

/*
 * The lane math on its own — no filesystem, no project, no glob.
 *
 * A rooted reference is a SITE URL, so it is READ through every lane a dev server would try
 * (mounts, the project root, `public/`) and the answer is RE-EMITTED through the lanes a deployed
 * build publishes, falling back to the root lane only when no build lane can express it. Which lane
 * matched and which lane answers are different questions; each case below fixes one pair.
 */
describe("rewriteRef — site URLs through the lanes", () => {
  const mounts = [{ dir: "assets/media", urlPrefix: "/m" }];

  test("a rename inside public/ re-emits at the site root, never under /public/", () => {
    const c = ctx({ newAbs: "/p/public/images/hero-2.jpg", oldAbs: "/p/public/images/hero.jpg" });
    expect(rewriteRef(classifyRef("/images/hero.jpg") as never, c)).toBe("/images/hero-2.jpg");
  });

  test("the query suffix survives the lane round trip", () => {
    const c = ctx({ newAbs: "/p/public/images/hero-2.jpg", oldAbs: "/p/public/images/hero.jpg" });
    expect(rewriteRef(classifyRef("/images/hero.jpg?v=2") as never, c)).toBe(
      "/images/hero-2.jpg?v=2",
    );
  });

  test("a file leaving public/ falls back to the root lane", () => {
    // Build-broken either way; the root lane at least keeps the preview loading.
    const c = ctx({ newAbs: "/p/images/hero.jpg", oldAbs: "/p/public/hero.jpg" });
    expect(rewriteRef(classifyRef("/hero.jpg") as never, c)).toBe("/images/hero.jpg");
  });

  test("a file entering public/ changes lane without changing the URL", () => {
    // Read through the root lane, re-emitted through the public lane: same URL, so no rewrite.
    const c = ctx({ newAbs: "/p/public/images/hero.jpg", oldAbs: "/p/images/hero.jpg" });
    expect(rewriteRef(classifyRef("/images/hero.jpg") as never, c)).toBeNull();
  });

  test("a mount is read and re-emitted through its own prefix", () => {
    const c = ctx({ mounts, newAbs: "/p/assets/media/b.png", oldAbs: "/p/assets/media/a.png" });
    expect(rewriteRef(classifyRef("/m/a.png") as never, c)).toBe("/m/b.png");
  });

  test("without the mount list the same URL names nothing that moved", () => {
    // `/m/a.png` is `m/a.png` to the root lane and `public/m/a.png` to the public lane.
    const c = ctx({ newAbs: "/p/assets/media/b.png", oldAbs: "/p/assets/media/a.png" });
    expect(rewriteRef(classifyRef("/m/a.png") as never, c)).toBeNull();
  });

  test("a file moving from public/ into a mount re-emits at the mount prefix", () => {
    const c = ctx({ mounts, newAbs: "/p/assets/media/a.png", oldAbs: "/p/public/a.png" });
    expect(rewriteRef(classifyRef("/a.png") as never, c)).toBe("/m/a.png");
  });

  test("a mount overlapping public/ wins the re-emit", () => {
    /* Read on the public lane (`/media/a.png` → `public/media/a.png`), re-emitted on the mount
       lane, because a mount publishing the destination is the more specific answer. This pins the
       ORDER of the authored lanes: mounts before public/, then root. */
    const c = ctx({
      mounts: [{ dir: "public/media", urlPrefix: "/m" }],
      newAbs: "/p/public/media/b.png",
      oldAbs: "/p/public/media/a.png",
    });
    expect(rewriteRef(classifyRef("/media/a.png") as never, c)).toBe("/m/b.png");
  });

  test("a rooted ref naming a file that did not move is null", () => {
    const c = ctx({ mounts, newAbs: "/p/public/hero-2.jpg", oldAbs: "/p/public/hero.jpg" });
    expect(rewriteRef(classifyRef("/other.jpg") as never, c)).toBeNull();
    expect(rewriteRef(classifyRef("/m/other.png") as never, c)).toBeNull();
  });

  test("a rooted ref that names no project file at all is null", () => {
    // Traversal never resolves on any lane, so there is no candidate to compare against.
    const c = ctx({ mounts, newAbs: "/p/public/hero-2.jpg", oldAbs: "/p/public/hero.jpg" });
    expect(rewriteRef(classifyRef("/../hero.jpg") as never, c)).toBeNull();
  });
});
