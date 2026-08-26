/**
 * Conformance: our `.gitignore` matcher against the one that ships with git.
 *
 * `gitignore(5)` is a page of prose with a dozen interacting rules, and the ones that bite are the
 * ones nobody writes down — that `**` is only a wildcard segment when it IS a whole segment, that a
 * `]` in the first position of a class is a member, that a trailing space survives a backslash, and
 * above all that an excluded directory cannot be re-included from inside it. Unit tests assert what
 * the author of the matcher BELIEVED those rules to be, which is exactly the thing in question.
 *
 * So this suite asks git. Each case is materialised in a throwaway repository and put to `git
 * check-ignore`, whose answer is the expectation — nothing here hard-codes a `true` or a `false`.
 * Two of these cases were failures when they were first run: `node_modules/pkg/index.js` read as
 * NOT ignored under a bare `node_modules` pattern (the parent rule was missing), and `[]x].txt`
 * compiled to a JavaScript class that matches nothing (a bare `[]` is empty, not a class holding
 * `]`). Neither was reachable from the sidebar; both were real disagreements with git.
 *
 * The paths are probed WITHOUT a trailing slash even for directories, because that is the question
 * the sidebar asks — "is this entry ignored" — and `git check-ignore` reads a trailing slash as
 * "look inside", which is a different question with a different answer.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isIgnored, parseGitignore } from "../src/files/gitignore";
import type { IgnoreLayer } from "../src/files/gitignore";

/** One entry to judge: its path, and whether it is a directory. */
type Probe = [path: string, isDir: boolean];

/**
 * Build a throwaway repository from `ignores` (directory → that directory's `.gitignore` text) and
 * `probes`, then return git's verdict on each probe beside our own.
 */
function against(ignores: Record<string, string>, probes: Probe[]) {
  const root = mkdtempSync(join(tmpdir(), "jx-gitignore-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    for (const [base, text] of Object.entries(ignores)) {
      const target = join(root, base, ".gitignore");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    // Git judges a path it can see, so every probe has to exist on disk.
    for (const [path, isDir] of probes) {
      const abs = join(root, path);
      if (isDir) {
        mkdirSync(abs, { recursive: true });
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, "");
      }
    }

    // Shallow-to-deep, the order `loadedLayersFor` hands to `isIgnored`.
    const layers: IgnoreLayer[] = Object.entries(ignores)
      .map(([base, text]) => ({ base, rules: parseGitignore(text) }))
      .toSorted((a, b) => a.base.split("/").length - b.base.split("/").length);

    return probes.map(([path, isDir]) => {
      const git = Bun.spawnSync(["git", "check-ignore", "-q", path], { cwd: root });
      return {
        git: git.exitCode === 0,
        ours: isIgnored(layers, path, isDir),
        path,
      };
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

/** Assert every probe, reporting the whole table so one failure names all of them. */
function expectAgreement(ignores: Record<string, string>, probes: Probe[]): void {
  const rows = against(ignores, probes);
  expect(rows.map((r) => `${r.path}=${r.ours}`)).toEqual(rows.map((r) => `${r.path}=${r.git}`));
}

describe("agreement with git check-ignore", () => {
  test("one root .gitignore, across every syntactic form the page describes", () => {
    expectAgreement(
      {
        "": [
          "# a comment",
          "node_modules",
          "dist/",
          "*.log",
          "!keep.log",
          "/rootonly.txt",
          "docs/**/*.tmp",
          "**/cache",
          "a/**/b",
          "temp?",
          "[Tt]humbs.db",
          String.raw`[]x].txt`,
          String.raw`[!]y]z.md`,
          String.raw`\#literal`,
          "trailing   ",
          String.raw`space\ kept`,
          "sub/*.bak",
          "!sub/important.bak",
        ].join("\n"),
      },
      [
        ["node_modules", true],
        /* The rule the sidebar never exercises and every other caller would: a pattern naming the
           parent, not the file, still ignores the file. */
        ["node_modules/pkg/index.js", false],
        ["src/node_modules", true],
        ["dist", true],
        ["dist/app.js", false],
        // `dist/` is directory-only, so a FILE of that name survives.
        ["other/dist", false],
        ["app.log", false],
        ["keep.log", false],
        ["logs/app.log", false],
        ["rootonly.txt", false],
        ["src/rootonly.txt", false],
        ["docs/b.tmp", false],
        ["docs/a/b/c.tmp", false],
        ["cache", true],
        ["x/y/cache", true],
        ["a/b", false],
        ["a/x/y/b", false],
        ["temp1", false],
        ["tempAB", false],
        ["Thumbs.db", false],
        ["Xhumbs.db", false],
        ["].txt", false],
        ["x.txt", false],
        ["q.txt", false],
        ["]z.md", false],
        ["yz.md", false],
        ["qz.md", false],
        ["#literal", false],
        ["trailing", false],
        ["space kept", false],
        ["sub/one.bak", false],
        ["sub/important.bak", false],
        ["other/one.bak", false],
        ["src/index.ts", false],
      ],
    );
  });

  test("nested .gitignore files, where a deeper one overrides the one above it", () => {
    expectAgreement(
      {
        "": ["*.log", "secret/", "build", "!build/public", "docs/drafts"].join("\n"),
        docs: ["!drafts", "*.bak"].join("\n"),
        src: ["!*.log", "generated/"].join("\n"),
        "src/vendor": ["*", "!allowed.js"].join("\n"),
      },
      [
        ["app.log", false],
        // The deeper `!*.log` wins over the root's `*.log`, at any depth below it.
        ["src/app.log", false],
        ["src/deep/app.log", false],
        ["secret", true],
        ["secret/key.txt", false],
        ["build", true],
        // `!build/public` cannot re-include anything: its parent is already excluded.
        ["build/public", true],
        ["build/public/index.html", false],
        ["src/generated", true],
        ["src/generated/out.ts", false],
        ["other/generated", true],
        // A `.gitignore` does not ignore its own directory, whatever it says about `*`.
        ["src/vendor", true],
        ["src/vendor/lib.js", false],
        ["src/vendor/allowed.js", false],
        ["docs/drafts", true],
        ["docs/drafts/notes.md", false],
        ["docs/final.bak", false],
        ["docs/final.md", false],
        ["src/index.ts", false],
        ["README.md", false],
      ],
    );
  });
});
