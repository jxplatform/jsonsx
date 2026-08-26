/**
 * Coverage for src/files/gitignore.ts — the `gitignore(5)` matcher behind the Files sidebar: line
 * parsing, glob compilation, last-match-wins across shallow-to-deep layers, and the per-directory
 * layer cache that lets the tree ask its question synchronously while it draws.
 *
 * The matching cases were chosen against real `git check-ignore` output, so a disagreement here is
 * a disagreement with git rather than with a hand-written expectation.
 */
import { installMockPlatform } from "./harness";
import type { MockPlatformState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  ancestorDirs,
  ensureIgnoreLayers,
  isIgnored,
  isIgnoredEntry,
  loadedLayersFor,
  normalizePath,
  parseGitignore,
  reloadIgnoreCache,
  resetIgnoreCache,
  touchesGitignore,
} from "../src/files/gitignore";
import type { IgnoreLayer, IgnoreRule } from "../src/files/gitignore";

// ─── Local helpers ────────────────────────────────────────────────────────────

/** One compiled `.gitignore`, as {@link isIgnored} wants them: `""` is the project root. */
function layer(base: string, text: string): IgnoreLayer {
  return { base, rules: parseGitignore(text) };
}

/** The single rule `text` compiles to. */
function ruleFor(text: string): IgnoreRule {
  const rules = parseGitignore(text);
  expect(rules).toHaveLength(1);
  return rules[0]!;
}

/** The verdict on `path` under a single root-level `.gitignore` holding `text`. */
function at(text: string, path: string, isDir = false): boolean {
  return isIgnored([layer("", text)], path, isDir);
}

/** The paths `readFile` was asked for, in order. */
function reads(state: MockPlatformState, path?: string): unknown[] {
  return state.calls
    .filter(([name, arg]) => name === "readFile" && (path === undefined || arg === path))
    .map(([, arg]) => arg);
}

beforeEach(() => {
  resetIgnoreCache();
});

// ─── Line parsing ─────────────────────────────────────────────────────────────

describe("parseGitignore", () => {
  test("blank lines and comments compile to nothing", () => {
    expect(parseGitignore("\n\n# a comment\n   \n")).toEqual([]);
  });

  test("a line that names nothing after its markers is dropped", () => {
    // A bare `/` is "the root directory" and a bare `!` re-includes nothing; both leave an empty
    // Pattern, which as a RegExp would match every path rather than none.
    expect(parseGitignore("/\n!\n")).toEqual([]);
  });

  test("CRLF splits like LF, and rules keep file order", () => {
    expect(parseGitignore("*.log\r\n!keep.log\r\n").map((rule) => rule.source)).toEqual([
      "*.log",
      "!keep.log",
    ]);
  });

  test("a rule carries the line as written, so a hidden row can be explained", () => {
    expect(ruleFor("dist/")).toMatchObject({ dirOnly: true, negated: false, source: "dist/" });
    expect(ruleFor("!keep.log")).toMatchObject({ dirOnly: false, negated: true });
  });

  test("trailing spaces go, unless the author escaped one", () => {
    expect(ruleFor("bar   ").re.test("bar")).toBe(true);
    // `foo\ ` names a file whose last character IS a space.
    expect(ruleFor(String.raw`foo\ `).re.test("foo ")).toBe(true);
    expect(ruleFor(String.raw`foo\ `).re.test("foo")).toBe(false);
    // An even run of backslashes escaped each OTHER, not the space, so the space still goes and
    // What survives is a file named `baz\`.
    expect(ruleFor(String.raw`baz\\ `).re.test("baz\\")).toBe(true);
  });

  test(String.raw`\# and \! are literals rather than a comment and a negation`, () => {
    expect(ruleFor(String.raw`\#notes.md`)).toMatchObject({ negated: false });
    expect(ruleFor(String.raw`\#notes.md`).re.test("#notes.md")).toBe(true);
    expect(ruleFor(String.raw`\!urgent.md`)).toMatchObject({ negated: false });
    expect(ruleFor(String.raw`\!urgent.md`).re.test("!urgent.md")).toBe(true);
  });

  test("a trailing backslash escapes nothing and matches itself", () => {
    expect(ruleFor("foo\\").re.test("foo\\")).toBe(true);
  });
});

// ─── Glob compilation ─────────────────────────────────────────────────────────

describe("glob compilation", () => {
  test("* and ? stop at a separator", () => {
    expect(at("*.log", "debug.log")).toBe(true);
    expect(at("a*c", "abc")).toBe(true);
    expect(at("a*c", "ab/c")).toBe(false);
    expect(at("a?c", "abc")).toBe(true);
    expect(at("a?c", "ac")).toBe(false);
    expect(at("a?c", "a/c")).toBe(false);
  });

  test("a regex metacharacter in a pattern is a literal", () => {
    expect(at("v1.0", "v1.0")).toBe(true);
    expect(at("v1.0", "v1x0")).toBe(false);
  });

  test("**/ between separators crosses zero or more directories", () => {
    expect(at("a/**/b", "a/b")).toBe(true);
    expect(at("a/**/b", "a/x/b")).toBe(true);
    expect(at("a/**/b", "a/x/y/b")).toBe(true);
    // It contains a slash, so it is anchored — `a` has to be the project's own `a`.
    expect(at("a/**/b", "z/a/b")).toBe(false);
  });

  test("a leading **/ is the same as no prefix at all", () => {
    expect(at("**/logs", "logs", true)).toBe(true);
    expect(at("**/logs", "x/y/logs", true)).toBe(true);
  });

  test("a trailing /** is everything inside, and not the directory itself", () => {
    expect(at("logs/**", "logs/a.txt")).toBe(true);
    expect(at("logs/**", "logs/deep/a.txt")).toBe(true);
    expect(at("logs/**", "logs", true)).toBe(false);
  });

  test("a bare ** matches every path", () => {
    expect(at("**", "a/b/c")).toBe(true);
  });

  test("a**b is git's two stars that are not a segment, and behaves as one", () => {
    expect(at("a**b", "axyzb")).toBe(true);
    expect(at("a**b", "ax/yb")).toBe(false);
  });

  test("character classes, including the negated form", () => {
    expect(at("[abc].txt", "a.txt")).toBe(true);
    expect(at("[abc].txt", "d.txt")).toBe(false);
    expect(at("[!abc].txt", "d.txt")).toBe(true);
    expect(at("[!abc].txt", "a.txt")).toBe(false);
    // A backslash inside the class escapes the next character rather than closing it.
    expect(at(String.raw`[a\]b]x`, "]x")).toBe(true);
    expect(at(String.raw`[a\]b]x`, "bx")).toBe(true);
  });

  test("a ] in the first position is a member of the class, not its close", () => {
    /* POSIX's rule and git's, and it takes BOTH halves of the implementation to honour: the scanner
       has to find the real close rather than stopping at the leading `]`, and the emitter has to
       escape that `]`, because JavaScript reads a bare `[]…]` as an empty class matching nothing —
       the exact inversion of the rule. Verified against `git check-ignore`, which ignores `].txt`
       and `x.txt` under `[]x].txt` and neither `]z.md` nor `yz.md` under `[!]y]z.md`. */
    expect(at("[]x]y", "]y", false)).toBe(true);
    expect(at("[]x]y", "xy", false)).toBe(true);
    expect(at("[]x]y", "qy", false)).toBe(false);
    expect(at("[!]y]z", "]z", false)).toBe(false);
    expect(at("[!]y]z", "yz", false)).toBe(false);
    expect(at("[!]y]z", "qz", false)).toBe(true);
  });

  test("an unterminated [ is a literal bracket", () => {
    expect(at("a[bc", "a[bc")).toBe(true);
  });
});

// ─── Anchoring and directory-only patterns ────────────────────────────────────

describe("anchoring", () => {
  test("a slash anywhere but the end anchors to the .gitignore's own directory", () => {
    expect(at("src/tmp", "src/tmp")).toBe(true);
    expect(at("src/tmp", "pkg/src/tmp")).toBe(false);
  });

  test("a leading slash anchors and is not part of the name", () => {
    expect(at("/dist", "dist", true)).toBe(true);
    expect(at("/dist", "pkg/dist", true)).toBe(false);
  });

  test("a slash-less pattern matches its name at any depth", () => {
    expect(at("dist", "dist", true)).toBe(true);
    expect(at("dist", "pkg/deep/dist", true)).toBe(true);
  });

  test("a trailing slash matches a directory and never a file of the same name", () => {
    expect(at("build/", "build", true)).toBe(true);
    expect(at("build/", "build", false)).toBe(false);
    // A file inside it is still gone — because its parent is, not because it was named.
    expect(at("build/", "build/app.js", false)).toBe(true);
  });
});

// ─── Precedence ───────────────────────────────────────────────────────────────

describe("isIgnored precedence", () => {
  test("the last matching line in a file wins", () => {
    expect(at("*.log\n!keep.log", "keep.log")).toBe(false);
    expect(at("*.log\n!keep.log", "debug.log")).toBe(true);
    // Order is the whole rule: reversed, the negation is overruled by the line after it.
    expect(at("!keep.log\n*.log", "keep.log")).toBe(true);
  });

  test("a deeper layer overrides a shallower one", () => {
    const layers = [layer("", "*.log"), layer("sub", "!*.log")];
    expect(isIgnored(layers, "sub/debug.log", false)).toBe(false);
    expect(isIgnored(layers, "debug.log", false)).toBe(true);
    expect(isIgnored(layers, "other/debug.log", false)).toBe(true);
  });

  test("a layer judges nothing outside its own directory", () => {
    const layers = [layer("sub", "*.log")];
    expect(isIgnored(layers, "sub/debug.log", false)).toBe(true);
    expect(isIgnored(layers, "other/debug.log", false)).toBe(false);
  });

  test("a negation cannot rescue a file whose parent directory is excluded", () => {
    // The rule that decides `node_modules`. Judged on its own, `node_modules/pkg/index.js` is NOT
    // Named by the pattern `node_modules` — only the walk up its ancestors says otherwise.
    const layers = [layer("", "node_modules/\n!node_modules/keep.js")];
    expect(isIgnored(layers, "node_modules", true)).toBe(true);
    expect(isIgnored(layers, "node_modules/pkg/index.js", false)).toBe(true);
    expect(isIgnored(layers, "node_modules/keep.js", false)).toBe(true);
  });

  test("a negation does rescue when the parent itself survived", () => {
    const layers = [layer("", "dist/*\n!dist/keep.js")];
    expect(isIgnored(layers, "dist", true)).toBe(false);
    expect(isIgnored(layers, "dist/other.js", false)).toBe(true);
    expect(isIgnored(layers, "dist/keep.js", false)).toBe(false);
  });

  test("the project root itself is never ignored, however it is spelled", () => {
    const layers = [layer("", "*")];
    expect(isIgnored(layers, "", false)).toBe(false);
    expect(isIgnored(layers, ".", false)).toBe(false);
  });

  test("a leading slash on the PATH names the same path", () => {
    // The empty first segment is skipped rather than judged: an absolute-looking `/foo` is `foo`,
    // Not a child of some unnamed root.
    expect(isIgnored([layer("", "foo")], "/foo", false)).toBe(true);
  });
});

// ─── Path shapes ──────────────────────────────────────────────────────────────

describe("path normalisation", () => {
  test("normalizePath collapses the spellings of here", () => {
    expect(normalizePath(".")).toBe("");
    expect(normalizePath("./")).toBe("");
    expect(normalizePath("./pages/")).toBe("pages");
    expect(normalizePath("pages///")).toBe("pages");
    expect(normalizePath(String.raw`pages\index.json`)).toBe("pages/index.json");
    expect(normalizePath("pages/index.json")).toBe("pages/index.json");
  });

  test("ancestorDirs runs root-first and includes the directory itself", () => {
    expect(ancestorDirs("a/b/c")).toEqual(["", "a", "a/b", "a/b/c"]);
    expect(ancestorDirs("")).toEqual([""]);
    expect(ancestorDirs(".")).toEqual([""]);
    expect(ancestorDirs("./a/")).toEqual(["", "a"]);
  });
});

// ─── The loaded layer cache ───────────────────────────────────────────────────

describe("the loaded layer cache", () => {
  test("ensureIgnoreLayers reads the directory and every ancestor, root spelled bare", async () => {
    const { state } = installMockPlatform({}, { ".gitignore": "*.log", "a/b/.gitignore": "*.tmp" });
    await ensureIgnoreLayers("a/b");

    expect(reads(state)).toEqual([".gitignore", "a/.gitignore", "a/b/.gitignore"]);
  });

  test("a directory with no .gitignore contributes no layer, and is not read twice", async () => {
    const { state } = installMockPlatform({}, { ".gitignore": "*.log" });
    await ensureIgnoreLayers("a");
    await ensureIgnoreLayers("a");

    // "Looked, there is none" is an answer, and caching it is what keeps the cost one round trip
    // Per directory rather than one per listing.
    expect(reads(state, "a/.gitignore")).toHaveLength(1);
    expect(loadedLayersFor("a").map((l) => l.base)).toEqual([""]);
  });

  test("concurrent callers share one read per directory", async () => {
    const { state } = installMockPlatform({}, { ".gitignore": "*.log" });
    await Promise.all([
      ensureIgnoreLayers("a/b"),
      ensureIgnoreLayers("a/b"),
      ensureIgnoreLayers("a"),
    ]);

    // Three directories, three reads — a burst of sibling listings is the normal case, not the
    // Exotic one.
    expect(reads(state)).toEqual([".gitignore", "a/.gitignore", "a/b/.gitignore"]);
  });

  test("loadedLayersFor is shallow-to-deep, and skips the directories that had none", async () => {
    installMockPlatform({}, { ".gitignore": "*.log", "a/b/.gitignore": "*.tmp" });
    await ensureIgnoreLayers("a/b");

    expect(loadedLayersFor("a/b").map((l) => l.base)).toEqual(["", "a/b"]);
  });

  test("a read that fails for any reason is no rules, not a rejection", async () => {
    installMockPlatform({
      readFile: () => {
        throw new Error("adapter is not connected");
      },
    });
    await ensureIgnoreLayers("a");

    // Throwing synchronously is a shape a platform adapter is allowed to have, and showing a file
    // The author meant to hide is the only harmless way to be wrong here.
    expect(loadedLayersFor("a")).toEqual([]);
  });

  test("isIgnoredEntry answers from what is loaded — and false before anything is", async () => {
    installMockPlatform({}, { ".gitignore": "node_modules/\ndist/" });

    // A row that appears and then vanishes one frame later is a worse artefact than one that
    // Stayed, so an unprobed directory hides nothing.
    expect(isIgnoredEntry(".", "node_modules", true)).toBe(false);

    await ensureIgnoreLayers(".");
    expect(isIgnoredEntry(".", "node_modules", true)).toBe(true);
    expect(isIgnoredEntry(".", "dist", true)).toBe(true);
    expect(isIgnoredEntry(".", "dist", false)).toBe(false);
    expect(isIgnoredEntry(".", "src", true)).toBe(false);
  });

  test("resetIgnoreCache forgets everything, negatives included", async () => {
    const { state } = installMockPlatform({}, { ".gitignore": "*.log" });
    await ensureIgnoreLayers("");
    resetIgnoreCache();

    expect(loadedLayersFor("")).toEqual([]);
    await ensureIgnoreLayers("");
    expect(reads(state)).toHaveLength(2);
  });

  test("reloadIgnoreCache picks up edited rules", async () => {
    const { state } = installMockPlatform({}, { ".gitignore": "*.log" });
    await ensureIgnoreLayers("a");
    expect(isIgnoredEntry("a", "a/debug.log", false)).toBe(true);

    state.files.set(".gitignore", "*.tmp");
    await reloadIgnoreCache();

    expect(isIgnoredEntry("a", "a/debug.log", false)).toBe(false);
    expect(isIgnoredEntry("a", "a/scratch.tmp", false)).toBe(true);
  });

  test("reloadIgnoreCache re-reads only what was probed, and finds a NEW .gitignore there", async () => {
    const { state } = installMockPlatform({}, { ".gitignore": "*.log" });
    await ensureIgnoreLayers("a");
    state.files.set("a/.gitignore", "!*.log");
    state.calls.length = 0;
    await reloadIgnoreCache();

    expect(reads(state)).toEqual([".gitignore", "a/.gitignore"]);
    expect(isIgnoredEntry("a", "a/debug.log", false)).toBe(false);
    // Nobody listed `b`, so nothing was read for it — it reads its own rules when someone does.
    expect(loadedLayersFor("b").map((l) => l.base)).toEqual([""]);
  });

  test("a .gitignore deleted between reads leaves no layer behind", async () => {
    const { state } = installMockPlatform({}, { ".gitignore": "*.log", "a/.gitignore": "*.tmp" });
    await ensureIgnoreLayers("a");
    expect(loadedLayersFor("a").map((l) => l.base)).toEqual(["", "a"]);

    state.files.delete("a/.gitignore");
    await reloadIgnoreCache();

    expect(loadedLayersFor("a").map((l) => l.base)).toEqual([""]);
  });
});

// ─── Staleness ────────────────────────────────────────────────────────────────

describe("touchesGitignore", () => {
  test("a .gitignore at any depth, however the path is spelled", () => {
    expect(touchesGitignore([".gitignore"])).toBe(true);
    expect(touchesGitignore(["packages/studio/.gitignore"])).toBe(true);
    expect(touchesGitignore(["./sub/.gitignore"])).toBe(true);
    expect(touchesGitignore([String.raw`sub\.gitignore`])).toBe(true);
    expect(touchesGitignore(["src/index.ts", "sub/.gitignore"])).toBe(true);
  });

  test("a path that merely contains the word is not one", () => {
    expect(touchesGitignore(["docs/gitignore.md"])).toBe(false);
    expect(touchesGitignore([".gitignore.bak"])).toBe(false);
    expect(touchesGitignore(["a/.gitignore/x"])).toBe(false);
    expect(touchesGitignore(["src/index.ts"])).toBe(false);
    expect(touchesGitignore([])).toBe(false);
  });
});
