/**
 * The allowlist that decides what a site origin will hand a reader.
 *
 * These tests are the security half of this package: a previewed page runs the project's own
 * JavaScript, so every path that resolves here is effectively readable by whatever that page
 * loaded. The cases below are the ones whose failure would matter — traversal, dotfiles, the
 * project's own secrets — plus the trailing slash, whose absence once 404'd every page on a site.
 */
import { describe, expect, test } from "bun:test";
import {
  NEVER_SERVABLE,
  SERVABLE_ROOTS,
  candidatePaths,
  contentTypeFor,
  normalizeRequestPath,
} from "../src/paths.ts";

describe("normalizeRequestPath", () => {
  test("strips the leading slash and returns a project-relative path", () => {
    expect(normalizeRequestPath("/components/card.json")).toBe("components/card.json");
  });

  test("the site root normalises to the empty path", () => {
    expect(normalizeRequestPath("/")).toBe("");
    expect(normalizeRequestPath("")).toBe("");
    expect(normalizeRequestPath("///")).toBe("");
  });

  test("a TRAILING slash is a writing convention, not a malformed path", () => {
    // `build.trailingSlash` defaults to "always", so this is the ordinary form of a page URL —
    // The one Open in Browser hands over. Rejecting it 404'd every page on the site.
    expect(normalizeRequestPath("/blog/hello/")).toBe("blog/hello");
    expect(normalizeRequestPath("/blog/hello//")).toBe("blog/hello");
  });

  test("percent-encoding is decoded", () => {
    expect(normalizeRequestPath("/blog/caf%C3%A9")).toBe("blog/café");
  });

  test("a malformed percent-escape is refused rather than guessed at", () => {
    expect(normalizeRequestPath("/%E0%A4%A")).toBeNull();
  });

  test.each([
    ["traversal", "/../secrets"],
    ["interior traversal", "/pages/../../etc/passwd"],
    ["a bare dot segment", "/pages/./index.json"],
    ["a dotfile", "/.dev.vars"],
    ["a dotfile deeper in", "/pages/.hidden/x.json"],
    ["a backslash", String.raw`/pages\..\secrets`],
    ["a NUL byte", "/pages/x%00.json"],
    ["an interior empty segment", "/pages//index.json"],
  ])("refuses %s", (_label, pathname) => {
    expect(normalizeRequestPath(pathname)).toBeNull();
  });

  test("an ENCODED traversal is refused after one decode, not resolved", () => {
    expect(normalizeRequestPath("/%2e%2e/secrets")).toBeNull();
  });
});

describe("candidatePaths", () => {
  test("public/ is tried first — it is where the build copies from", () => {
    expect(candidatePaths("favicon.svg")).toEqual(["public/favicon.svg"]);
  });

  test("a servable root is also tried at its own project path", () => {
    expect(candidatePaths("components/card.json")).toEqual([
      "public/components/card.json",
      "components/card.json",
    ]);
  });

  test("a path outside every servable root is only reachable through public/", () => {
    expect(candidatePaths("node_modules/left-pad/index.js")).toEqual([
      "public/node_modules/left-pad/index.js",
    ]);
  });

  test("the site root asks for no file at all", () => {
    expect(candidatePaths("")).toEqual([]);
  });

  test.each([...NEVER_SERVABLE])("%s is never servable, by any lane", (path) => {
    expect(candidatePaths(path)).toEqual([]);
  });

  test("every servable root produces a two-candidate list", () => {
    for (const root of SERVABLE_ROOTS) {
      expect(candidatePaths(`${root}x.txt`)).toHaveLength(2);
    }
  });
});

describe("contentTypeFor", () => {
  test.each([
    ["page.html", "text/html; charset=utf-8"],
    ["card.json", "application/json; charset=utf-8"],
    ["main.css", "text/css; charset=utf-8"],
    ["demo.js", "text/javascript; charset=utf-8"],
    ["logo.SVG", "image/svg+xml"],
    ["font.woff2", "font/woff2"],
    ["post.md", "text/markdown; charset=utf-8"],
  ])("%s → %s", (path, expected) => {
    expect(contentTypeFor(path)).toBe(expected);
  });

  test("an unknown extension is a download, not a guess", () => {
    expect(contentTypeFor("archive.tar.zst")).toBe("application/octet-stream");
  });

  test("a file with no extension at all is a download", () => {
    expect(contentTypeFor("LICENSE")).toBe("application/octet-stream");
  });
});
